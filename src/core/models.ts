import fs from 'node:fs'
import path from 'node:path'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { env } from '@huggingface/transformers'
import crypto from 'node:crypto'
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
  // Same on-disk layout as transformers.js' own FileCache, so models downloaded before this change are found.
  env.useCustomCache = true
  env.customCache = new PathCache(dir) as never
  // Keep the ONNX Runtime thread default: forcing logical-thread count measured 2.5x slower on a 16C/24T CPU.
  configured = true
}

const MODEL_BINARY = /\.onnx(_data(_\d+)?)?$/i

/**
 * Model file cache that hands ONNX weights to ONNX Runtime as a *path*.
 *
 * transformers.js' built-in FileCache answers every cache hit with a FileResponse whose constructor opens a
 * `fs.createReadStream` of the whole file and pipes it into a web ReadableStream that, for `.onnx` files in Node,
 * nobody ever reads. The stream still flows to the end, so the entire file sits in JavaScript ArrayBuffers until
 * the garbage collector gets to it. Measured with whisper-large-v3-turbo: 4.86 GB of ArrayBuffers (2× the 2.43 GB
 * encoder weights) appearing over ~5 s after the model loaded, on top of ONNX Runtime's own copy — peak RSS ~10 GB
 * instead of ~5 GB. Returning a plain string makes transformers.js pass the path straight to ONNX Runtime, which
 * memory-maps it. Small files (config, tokenizer, preprocessor JSON) are still served as a `Response` because
 * `getModelJSON` decodes a buffer, not a path. Misses are downloaded to a temp file and renamed, like FileCache.
 */
export class PathCache {
  constructor(private readonly dir: string) {}

  /**
   * transformers.js keys a custom cache by the *remote URL* (`https://huggingface.co/<org>/<model>/resolve/<rev>/<file>`),
   * its own FileCache by `<org>/<model>/<file>`. Map both to the FileCache layout so nothing is downloaded twice.
   */
  private resolve(request: string): string {
    const m = /^https?:\/\/[^/]+\/(.+?)\/resolve\/[^/]+\/(.+)$/.exec(request)
    const rel = m ? `${m[1]}/${m[2]}` : request
    return path.join(this.dir, ...rel.split('/').filter((seg) => seg && seg !== '.' && seg !== '..'))
  }

  async match(request: string): Promise<string | Response | undefined> {
    const file = this.resolve(request)
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      return undefined
    }
    if (!stat.isFile()) return undefined
    if (MODEL_BINARY.test(file)) return file
    return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-length': String(stat.size), 'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream' } })
  }

  async put(request: string, response: Response, progress?: (data: { progress: number; loaded: number; total: number }) => void): Promise<void> {
    const file = this.resolve(request)
    ensureDir(path.dirname(file))
    const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
    const total = Number(response.headers.get('content-length') ?? 0)
    let loaded = 0
    if (!response.body) throw new OllosError('MODEL_LOAD_FAILED', `empty response while downloading ${request}`)
    const reader = Readable.fromWeb(response.body as never)
    reader.on('data', (c: Buffer) => {
      loaded += c.length
      progress?.({ progress: total ? (loaded / total) * 100 : 0, loaded, total })
    })
    try {
      await streamPipeline(reader, fs.createWriteStream(tmp))
      fs.renameSync(tmp, file)
    } finally {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })
    }
  }
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
    { id: m.asrAccurate, role: 'asr', approxMb: 2750 },
    { id: m.asrFast, role: 'asr', approxMb: 280 },
    { id: m.vad, role: 'vad', approxMb: 2, file: { url: `https://huggingface.co/${m.vad}/resolve/main/onnx/model.onnx`, dest: path.join(dirs.models(config), 'silero-vad.onnx') } },
    { id: m.segmentation, role: 'segmentation', approxMb: 6 },
    { id: m.speaker, role: 'speaker', approxMb: 26 },
    { id: m.textEmbedding, role: 'embedding', approxMb: 465 },
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
