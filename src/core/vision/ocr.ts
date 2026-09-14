import path from 'node:path'
import fs from 'node:fs'
import { createWorker, type Worker } from 'tesseract.js'
import { dirs, type OllosConfig } from '../config.js'
import { OllosError } from '../errors.js'
import { ensureDir } from '../paths.js'
import { cropUpscale, type Box } from './frames.js'

export interface OcrBlock {
  text: string
  confidence: number
  /** Fractions of the full frame. */
  bbox: Box
  tile: number
}

export interface OcrFrameResult {
  text: string
  blocks: OcrBlock[]
  meanConfidence: number
  ms: number
}

/**
 * A small pool of Tesseract workers (WASM). Creating a worker costs ~1 s and loads language data,
 * so we keep them alive across frames and jobs; the engine's `ocr` semaphore bounds parallel use.
 */
class OcrPool {
  private workers: Worker[] = []
  private idle: Worker[] = []
  private waiters: Array<(w: Worker) => void> = []
  private created = 0
  constructor(private readonly size: number, private readonly langs: string[], private readonly config: OllosConfig) {}

  private async create(): Promise<Worker> {
    const cachePath = ensureDir(path.join(dirs.models(this.config), 'tesseract'))
    const have = this.langs.every((l) => fs.existsSync(path.join(cachePath, `${l}.traineddata`)) || fs.existsSync(path.join(cachePath, `${l}.traineddata.gz`)))
    if (this.config.offline && !have) throw new OllosError('MODEL_MISSING_OFFLINE', `Tesseract language data (${this.langs.join(', ')}) is not downloaded and OLLOS_OFFLINE=1`, { hint: 'Run "ollos warmup" while online.' })
    const w = await createWorker(this.langs, 1, { cachePath, logger: () => {} })
    await w.setParameters({ tessedit_pageseg_mode: '6' as never, preserve_interword_spaces: '1' })
    this.workers.push(w)
    return w
  }

  async acquire(): Promise<Worker> {
    const w = this.idle.pop()
    if (w) return w
    if (this.created < this.size) {
      this.created++
      return this.create()
    }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  release(w: Worker): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(w)
    else this.idle.push(w)
  }

  async terminate(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()))
    this.workers = []
    this.idle = []
    this.created = 0
  }
}

const pools = new Map<string, OcrPool>()

export function getOcrPool(config: OllosConfig, langs: string[]): OcrPool {
  const key = langs.join('+')
  let p = pools.get(key)
  if (!p) {
    p = new OcrPool(config.concurrency.ocr, langs, config)
    pools.set(key, p)
  }
  return p
}

export async function terminateOcr(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.terminate()))
  pools.clear()
}

interface TessLine {
  text: string
  confidence: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

function linesOf(data: unknown): TessLine[] {
  const d = data as { blocks?: Array<{ paragraphs?: Array<{ lines?: TessLine[] }> }>; lines?: TessLine[]; text?: string; confidence?: number }
  const out: TessLine[] = []
  if (d.blocks) for (const b of d.blocks) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) out.push(l)
  else if (d.lines) out.push(...d.lines)
  return out
}

/**
 * OCR one frame as a grid of upscaled tiles. Measured: full frame at 1× missed an on-screen URL entirely;
 * a 3× tile read it whole at 90% confidence in 2.8 s.
 */
export async function ocrFrame(jpeg: Buffer, config: OllosConfig, opts: { langs?: string[]; grid?: number; scale?: number; signal?: AbortSignal } = {}): Promise<OcrFrameResult> {
  const t0 = Date.now()
  const langs = opts.langs ?? ['por', 'eng']
  const grid = opts.grid ?? 2
  const scale = opts.scale ?? 3
  const pool = getOcrPool(config, langs)
  const blocks: OcrBlock[] = []
  let tile = 0
  // grid tiles plus one centred tile: modals and dialogs sit in the middle, exactly where a 2×2 grid cuts.
  const boxes: Box[] = []
  for (let r = 0; r < grid; r++) for (let c = 0; c < grid; c++) boxes.push({ x: c / grid, y: r / grid, w: 1 / grid, h: 1 / grid })
  boxes.push({ x: 0.2, y: 0.2, w: 0.6, h: 0.6 })
  for (const box of boxes) {
    {
      if (opts.signal?.aborted) throw new OllosError('CANCELLED', 'cancelled')
      const png = await cropUpscale(jpeg, box, scale)
      const worker = await pool.acquire()
      try {
        const { data } = await worker.recognize(png, {}, { text: true, blocks: true })
        const lines = linesOf(data)
        const tileW = (await import('sharp')).default(png)
        const meta = await tileW.metadata()
        const tw = meta.width ?? 1
        const th = meta.height ?? 1
        if (lines.length === 0 && data.text?.trim()) {
          blocks.push({ text: data.text.trim(), confidence: data.confidence ?? 0, bbox: box, tile })
        }
        for (const l of lines) {
          const text = l.text.replace(/\s+/g, ' ').trim()
          if (!text || l.confidence < 30) continue
          blocks.push({
            text,
            confidence: Math.round(l.confidence),
            bbox: { x: box.x + (l.bbox.x0 / tw) * box.w, y: box.y + (l.bbox.y0 / th) * box.h, w: ((l.bbox.x1 - l.bbox.x0) / tw) * box.w, h: ((l.bbox.y1 - l.bbox.y0) / th) * box.h },
            tile,
          })
        }
      } finally {
        pool.release(worker)
      }
      tile++
    }
  }
  const text = blocks.map((b) => b.text).join('\n')
  const meanConfidence = blocks.length ? Math.round(blocks.reduce((a, b) => a + b.confidence, 0) / blocks.length) : 0
  return { text, blocks, meanConfidence, ms: Date.now() - t0 }
}
