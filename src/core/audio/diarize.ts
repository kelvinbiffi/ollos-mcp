import { AutoFeatureExtractor, AutoModel, AutoModelForAudioFrameClassification, AutoProcessor } from '@huggingface/transformers'
import type { OllosConfig } from '../config.js'
import { OllosError } from '../errors.js'
import { ASR_SAMPLE_RATE } from '../media/decode.js'
import { configureModelRuntime } from '../models.js'

export interface Turn {
  startSec: number
  endSec: number
  /** Global speaker label after clustering, e.g. SPEAKER_00. */
  speaker: string
  confidence: number
}

interface LocalSegment {
  id: number
  start: number
  end: number
  confidence: number
}

type ProgressCb = (ev: { status?: string; file?: string; progress?: number }) => void

/** `ollos warmup --all` and the pipelines share these loaders, so what warmup fetches is exactly what diarize will ask for offline. */
function loadOpts(onProgress?: (msg: string) => void): { progress_callback?: ProgressCb } {
  if (!onProgress) return {}
  return { progress_callback: (ev) => ev.status === 'progress' && ev.file && onProgress(`downloading ${ev.file} ${Math.round(ev.progress ?? 0)}%`) }
}

function modelLoadError(id: string, config: OllosConfig, e: unknown): OllosError {
  return new OllosError('MODEL_LOAD_FAILED', `could not load ${id}: ${e instanceof Error ? e.message : String(e)}`, { cause: e, hint: config.offline ? 'Run "ollos warmup --all" while online; plain "ollos warmup" fetches only the ASR and VAD models.' : undefined })
}

export async function loadSegmentationModel(config: OllosConfig, onProgress?: (msg: string) => void) {
  configureModelRuntime(config)
  const id = config.models.segmentation
  const [processor, model] = await Promise.all([AutoProcessor.from_pretrained(id, loadOpts(onProgress) as never), AutoModelForAudioFrameClassification.from_pretrained(id, loadOpts(onProgress) as never)]).catch((e: unknown) => {
    throw modelLoadError(id, config, e)
  })
  return { processor, model }
}

export async function loadSpeakerModel(config: OllosConfig, onProgress?: (msg: string) => void) {
  configureModelRuntime(config)
  const id = config.models.speaker
  const [fe, model] = await Promise.all([AutoFeatureExtractor.from_pretrained(id, loadOpts(onProgress) as never), AutoModel.from_pretrained(id, loadOpts(onProgress) as never)]).catch((e: unknown) => {
    throw modelLoadError(id, config, e)
  })
  return { fe, model }
}

/**
 * Step 1 — segmentation. pyannote-segmentation-3.0 labels speakers *locally* (its ids reset every window),
 * so on a one-person video it happily reports three speakers. Measured: 310× real time in Node.
 */
export async function segmentSpeakers(pcm: Float32Array, config: OllosConfig, signal?: AbortSignal): Promise<LocalSegment[]> {
  const { processor, model } = await loadSegmentationModel(config)
  const out: LocalSegment[] = []
  // process in 60 s slabs to bound memory; local ids are per slab anyway
  const slab = 60 * ASR_SAMPLE_RATE
  for (let off = 0; off < pcm.length; off += slab) {
    if (signal?.aborted) throw new OllosError('CANCELLED', 'cancelled')
    const chunk = pcm.subarray(off, Math.min(pcm.length, off + slab))
    if (chunk.length < ASR_SAMPLE_RATE * 0.5) break
    const inputs = await processor(chunk)
    const { logits } = (await model(inputs)) as { logits: unknown }
    const segs = (processor as unknown as { post_process_speaker_diarization: (l: unknown, n: number) => Array<Array<{ id: number; start: number; end: number; confidence: number }>> }).post_process_speaker_diarization(logits, chunk.length)[0] ?? []
    const base = off / ASR_SAMPLE_RATE
    for (const s of segs) out.push({ id: s.id + Math.floor(off / slab) * 100, start: base + s.start, end: base + s.end, confidence: s.confidence })
  }
  return out
}

/** Merge consecutive same-label pieces and drop slivers; returns speech turns with local labels. */
export function toTurns(segs: LocalSegment[], minSec = 0.6): Array<{ start: number; end: number; local: number; confidence: number }> {
  const sorted = [...segs].sort((a, b) => a.start - b.start)
  const turns: Array<{ start: number; end: number; local: number; confidence: number }> = []
  for (const s of sorted) {
    const last = turns[turns.length - 1]
    if (last && last.local === s.id && s.start - last.end < 0.4) {
      last.end = s.end
      last.confidence = Math.max(last.confidence, s.confidence)
    } else turns.push({ start: s.start, end: s.end, local: s.id, confidence: s.confidence })
  }
  return turns.filter((t) => t.end - t.start >= minSec)
}

/**
 * Step 2 — one embedding per turn. WeSpeaker ResNet34, 256 dimensions, L2-normalised.
 * Measured: three 5-second embeddings in 2.7 s. Same-speaker similarity measured 0.47–0.53 on a noisy screencast —
 * lower than the 0.6–0.8 typical on clean speech — which is why the merge threshold is a parameter, default 0.35.
 * Measured on the eval fixtures: the same voice scores 0.51–0.86 with itself across positions and lengths (the 0.51 is a
 * 2 s cut against a 5 s window), but 0.06–0.16 when background music is under it — jingles and outros form their own
 * cluster. See scripts/probe-speaker-embeddings.mts and docs/DESIGN.md §3.4.
 */
export async function speakerEmbeddings(pcm: Float32Array, turns: Array<{ start: number; end: number }>, config: OllosConfig, signal?: AbortSignal, onProgress?: (i: number, n: number) => void): Promise<Float32Array[]> {
  const { fe, model } = await loadSpeakerModel(config)
  const out: Float32Array[] = []
  for (let i = 0; i < turns.length; i++) {
    if (signal?.aborted) throw new OllosError('CANCELLED', 'cancelled')
    const t = turns[i]!
    // cap at 8 s from the turn's middle: enough voice, bounded cost
    const len = Math.min(8, t.end - t.start)
    const mid = (t.start + t.end) / 2
    const a = Math.max(0, Math.floor((mid - len / 2) * ASR_SAMPLE_RATE))
    const b = Math.min(pcm.length, a + Math.floor(len * ASR_SAMPLE_RATE))
    const slice = pcm.subarray(a, b)
    const inputs = await fe(slice)
    const res = (await model(inputs)) as Record<string, { data: Float32Array }>
    const vec = (res.embeddings ?? res.last_hidden_state ?? Object.values(res)[0]!).data
    const v = new Float32Array(vec)
    let n = 0
    for (const x of v) n += x * x
    n = Math.sqrt(n) || 1
    for (let k = 0; k < v.length; k++) v[k] = v[k]! / n
    out.push(v)
    onProgress?.(i + 1, turns.length)
  }
  return out
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

/**
 * Step 3 — agglomerative clustering, average linkage on cosine similarity.
 * Merge the two closest clusters while their similarity ≥ threshold, and keep merging regardless of similarity while
 * more than maxSpeakers clusters remain; never merge below minSpeakers.
 */
export function clusterSpeakers(embeddings: Float32Array[], opts: { threshold?: number; maxSpeakers?: number; minSpeakers?: number; weights?: number[] } = {}): number[] {
  const threshold = opts.threshold ?? 0.35
  const n = embeddings.length
  if (n === 0) return []
  const weights = opts.weights ?? embeddings.map(() => 1)
  const clusters: number[][] = embeddings.map((_, i) => [i])
  const sim = (A: number[], B: number[]) => {
    let s = 0
    for (const i of A) for (const j of B) s += cosine(embeddings[i]!, embeddings[j]!)
    return s / (A.length * B.length)
  }
  const maxSpeakers = opts.maxSpeakers ?? 8
  const minSpeakers = opts.minSpeakers ?? 1
  while (clusters.length > minSpeakers) {
    let best = -1
    let bi = -1
    let bj = -1
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
      const s = sim(clusters[i]!, clusters[j]!)
      if (s > best) {
        best = s
        bi = i
        bj = j
      }
    }
    if (best < threshold && clusters.length <= maxSpeakers) break
    clusters[bi]!.push(...clusters[bj]!)
    clusters.splice(bj, 1)
  }
  // absorb tiny clusters (< 5% of speaking time and ≤ 2 turns) into their nearest neighbour:
  // a one-second turn is not evidence of a new person, it is a noisy embedding
  const total = weights.reduce((a, b) => a + b, 0)
  let changed = true
  while (changed && clusters.length > minSpeakers) {
    changed = false
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i]!
      const talk = c.reduce((a, k) => a + weights[k]!, 0)
      if (c.length <= 2 && talk < total * 0.05 && clusters.length > 1) {
        let bj = -1
        let best = -Infinity
        for (let j = 0; j < clusters.length; j++) if (j !== i) {
          const s = sim(c, clusters[j]!)
          if (s > best) {
            best = s
            bj = j
          }
        }
        clusters[bj]!.push(...c)
        clusters.splice(i, 1)
        changed = true
        break
      }
    }
  }
  // label clusters by first appearance so SPEAKER_00 is whoever talks first
  const order = clusters.map((c, idx) => ({ idx, first: Math.min(...c) })).sort((a, b) => a.first - b.first)
  const labelOf = new Map(order.map((o, rank) => [o.idx, rank]))
  const labels = new Array<number>(n)
  clusters.forEach((c, idx) => c.forEach((i) => (labels[i] = labelOf.get(idx)!)))
  return labels
}

export function speakerName(i: number): string {
  return `SPEAKER_${String(i).padStart(2, '0')}`
}
