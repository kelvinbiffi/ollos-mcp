import fs from 'node:fs'
import path from 'node:path'
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { dirs, type OllosConfig } from '../config.js'
import { OllosError } from '../errors.js'
import { configureModelRuntime } from '../models.js'
import { ensureDir, exists, readJSON, writeJSONAtomic } from '../paths.js'

/**
 * Hybrid search over what ollos heard and read: BM25 for exact names, acronyms and numbers ("n8n", "401"),
 * multilingual embeddings for meaning, fused by reciprocal rank. One index per job, on disk.
 * This is retrieval with its own metrics (hit rate, recall@k, MRR, NDCG); a retrieval eval under eval/ is planned, not written yet.
 */
export interface Doc {
  id: string
  jobId: string
  kind: 'speech' | 'screen'
  text: string
  startSec: number
  endSec: number
  speaker?: string
  source: string
}

export interface Hit extends Doc {
  score: number
  bm25Rank?: number
  vectorRank?: number
}

const STOP = new Set(['a', 'o', 'e', 'de', 'da', 'do', 'que', 'em', 'um', 'uma', 'para', 'com', 'não', 'se', 'na', 'no', 'por', 'os', 'as', 'dos', 'das', 'ele', 'ela', 'eu', 'você', 'isso', 'aqui', 'então', 'the', 'and', 'of', 'to', 'in', 'is', 'it', 'you', 'that', 'this', 'for', 'on', 'with', 'as', 'are', 'be', 'at', 'or'])

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
}

class BM25 {
  private df = new Map<string, number>()
  private tf: Array<Map<string, number>> = []
  private len: number[] = []
  private avg = 0
  constructor(docs: string[], private readonly k1 = 1.4, private readonly b = 0.75) {
    for (const d of docs) {
      const toks = tokenize(d)
      const m = new Map<string, number>()
      for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1)
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      this.tf.push(m)
      this.len.push(toks.length)
    }
    this.avg = this.len.reduce((a, b) => a + b, 0) / Math.max(1, this.len.length)
  }
  score(query: string): number[] {
    const q = tokenize(query)
    const N = this.tf.length
    return this.tf.map((m, i) => {
      let s = 0
      for (const t of q) {
        const f = m.get(t) ?? 0
        if (!f) continue
        const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5))
        s += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.len[i]!) / this.avg)))
      }
      return s
    })
  }
}

let embedder: Promise<FeatureExtractionPipeline> | undefined
async function getEmbedder(config: OllosConfig): Promise<FeatureExtractionPipeline> {
  configureModelRuntime(config)
  if (!embedder) {
    embedder = pipeline('feature-extraction', config.models.textEmbedding, { dtype: 'fp32' } as never).catch((e: unknown) => {
      embedder = undefined
      throw new OllosError('MODEL_LOAD_FAILED', `could not load ${config.models.textEmbedding}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }) as Promise<FeatureExtractionPipeline>
  }
  return embedder
}

/** e5 models expect "query: " / "passage: " prefixes. Mean-pooled, normalised. */
export async function embed(texts: string[], role: 'query' | 'passage', config: OllosConfig): Promise<Float32Array[]> {
  const model = await getEmbedder(config)
  const out: Float32Array[] = []
  const batch = 16
  for (let i = 0; i < texts.length; i += batch) {
    const chunk = texts.slice(i, i + batch).map((t) => `${role}: ${t}`)
    const res = (await model(chunk, { pooling: 'mean', normalize: true })) as { dims: number[]; data: Float32Array }
    const dim = res.dims[res.dims.length - 1]!
    for (let r = 0; r < chunk.length; r++) out.push(new Float32Array(res.data.buffer, res.data.byteOffset + r * dim * 4, dim).slice())
  }
  return out
}

interface IndexFile {
  schemaVersion: 1
  jobId: string
  dim: number
  docs: Doc[]
}

export class SearchIndex {
  constructor(private readonly config: OllosConfig) {}

  private dir(jobId: string) {
    return ensureDir(path.join(dirs.index(this.config), jobId))
  }

  has(jobId: string): boolean {
    return exists(path.join(dirs.index(this.config), jobId, 'docs.json'))
  }

  async build(jobId: string, docs: Doc[]): Promise<void> {
    if (docs.length === 0) return
    const vecs = await embed(docs.map((d) => d.text), 'passage', this.config)
    const dim = vecs[0]!.length
    const flat = new Float32Array(docs.length * dim)
    vecs.forEach((v, i) => flat.set(v, i * dim))
    const d = this.dir(jobId)
    fs.writeFileSync(path.join(d, 'vectors.bin'), Buffer.from(flat.buffer))
    writeJSONAtomic(path.join(d, 'docs.json'), { schemaVersion: 1, jobId, dim, docs } satisfies IndexFile)
  }

  private load(jobId: string): { docs: Doc[]; vectors: Float32Array; dim: number } | undefined {
    const d = path.join(dirs.index(this.config), jobId)
    if (!exists(path.join(d, 'docs.json'))) return undefined
    const meta = readJSON<IndexFile>(path.join(d, 'docs.json'))
    const buf = fs.readFileSync(path.join(d, 'vectors.bin'))
    const vectors = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    return { docs: meta.docs, vectors, dim: meta.dim }
  }

  listJobs(): string[] {
    const root = dirs.index(this.config)
    return exists(root) ? fs.readdirSync(root).filter((j) => this.has(j)) : []
  }

  async search(query: string, opts: { jobIds?: string[]; k?: number; kind?: 'speech' | 'screen' | 'both' } = {}): Promise<Hit[]> {
    const k = opts.k ?? 8
    const jobIds = opts.jobIds ?? this.listJobs()
    const all: Array<{ doc: Doc; bm: number; vec: number }> = []
    const [q] = await embed([query], 'query', this.config)
    for (const jobId of jobIds) {
      const idx = this.load(jobId)
      if (!idx) continue
      const docs = idx.docs
      const bm = new BM25(docs.map((d) => d.text)).score(query)
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i]!
        if (opts.kind && opts.kind !== 'both' && doc.kind !== opts.kind) continue
        let s = 0
        const off = i * idx.dim
        for (let j = 0; j < idx.dim; j++) s += idx.vectors[off + j]! * q![j]!
        all.push({ doc, bm: bm[i]!, vec: s })
      }
    }
    if (all.length === 0) return []
    // reciprocal rank fusion, k=60
    const byBm = [...all].sort((a, b) => b.bm - a.bm)
    const byVec = [...all].sort((a, b) => b.vec - a.vec)
    const rankBm = new Map(byBm.map((x, i) => [x.doc.id, i + 1]))
    const rankVec = new Map(byVec.map((x, i) => [x.doc.id, i + 1]))
    const fused = all.map((x) => {
      const rb = rankBm.get(x.doc.id)!
      const rv = rankVec.get(x.doc.id)!
      const score = (x.bm > 0 ? 1 / (60 + rb) : 0) + 1 / (60 + rv)
      return { ...x.doc, score: Number(score.toFixed(5)), bm25Rank: x.bm > 0 ? rb : undefined, vectorRank: rv } as Hit
    })
    // the same media transcribed twice yields identical passages; show each once
    const seen = new Set<string>()
    return fused
      .sort((a, b) => b.score - a.score)
      .filter((h) => {
        const key = `${h.source}|${h.startSec.toFixed(1)}|${h.text}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, k)
  }
}

/** Turn a transcript and/or OCR result into indexable documents. */
export function docsFromTranscript(jobId: string, source: string, segments: Array<{ id: number; startSec: number; endSec: number; text: string; speaker?: string }>): Doc[] {
  return segments.map((s) => ({ id: `${jobId}:s${s.id}`, jobId, kind: 'speech' as const, text: s.text, startSec: s.startSec, endSec: s.endSec, speaker: s.speaker, source }))
}

export function docsFromScreen(jobId: string, source: string, frames: Array<{ index: number; pts: number; text: string }>): Doc[] {
  return frames.filter((f) => f.text.trim().length > 3).map((f) => ({ id: `${jobId}:f${f.index}`, jobId, kind: 'screen' as const, text: f.text.replace(/\s+/g, ' ').slice(0, 2000), startSec: f.pts, endSec: f.pts, source }))
}
