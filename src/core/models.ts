import fs from 'node:fs'
import path from 'node:path'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { env } from '@huggingface/transformers'
import { dirs, type OllosConfig } from './config.js'
import { OllosError } from './errors.js'
import { ensureDir } from './paths.js'

let configured = false

/** Point transformers.js at $OLLOS_HOME/models and honour offline mode. Idempotent. */
export function configureModelRuntime(config: OllosConfig): void {
  if (configured) return
  const dir = ensureDir(dirs.models(config))
  env.cacheDir = dir
  env.allowRemoteModels = !config.offline
  env.allowLocalModels = true
  // Keep the ONNX Runtime thread default: forcing logical-thread count measured 2.5x slower on a 16C/24T CPU.
  configured = true
}

export interface ModelSpec {
  id: string
  role: 'asr' | 'vad' | 'segmentation' | 'speaker' | 'embedding'
  approxMb: number
  /** For raw ONNX files fetched outside transformers.js. */
  file?: { url: string; dest: string }
}

export function modelCatalog(config: OllosConfig): ModelSpec[] {
  const m = config.models
  return [
    { id: m.asrAccurate, role: 'asr', approxMb: 800 },
    { id: m.asrFast, role: 'asr', approxMb: 150 },
    { id: m.vad, role: 'vad', approxMb: 2, file: { url: `https://huggingface.co/${m.vad}/resolve/main/onnx/model.onnx`, dest: path.join(dirs.models(config), 'silero-vad.onnx') } },
    { id: m.segmentation, role: 'segmentation', approxMb: 6 },
    { id: m.speaker, role: 'speaker', approxMb: 26 },
    { id: m.textEmbedding, role: 'embedding', approxMb: 120 },
  ]
}

/** Download a single file with resume-free simplicity, atomically. Respects offline mode. */
export async function ensureFile(url: string, dest: string, config: OllosConfig, onProgress?: (received: number, total: number) => void): Promise<string> {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest
  if (config.offline) throw new OllosError('MODEL_MISSING_OFFLINE', `model file ${path.basename(dest)} is not downloaded and OLLOS_OFFLINE=1`, { hint: 'Run "ollos warmup" while online, then go offline.' })
  ensureDir(path.dirname(dest))
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new OllosError('MODEL_LOAD_FAILED', `HTTP ${res.status} downloading ${url}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  const tmp = dest + '.part'
  const reader = Readable.fromWeb(res.body as never)
  reader.on('data', (c: Buffer) => {
    received += c.length
    onProgress?.(received, total)
  })
  await streamPipeline(reader, fs.createWriteStream(tmp))
  fs.renameSync(tmp, dest)
  return dest
}

/** Is a transformers.js model already in the cache dir? Best-effort check on the hub layout. */
export function isModelCached(modelId: string, config: OllosConfig): boolean {
  const dir = path.join(dirs.models(config), modelId)
  if (!fs.existsSync(dir)) return false
  const walk = (d: string): boolean => fs.readdirSync(d, { withFileTypes: true }).some((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.onnx')))
  return walk(dir)
}
