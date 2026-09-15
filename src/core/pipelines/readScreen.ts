import fs from 'node:fs'
import path from 'node:path'
import type { OllosConfig } from '../config.js'
import { Cache, hashOf } from '../cache/cache.js'
import { OllosError } from '../errors.js'
import type { JobContext } from '../jobs/types.js'
import { fmtTime } from '../media/ffmpeg.js'
import { resolveSource, type ResolvedSource } from '../source/resolve.js'
import { ocrFrame, type OcrBlock } from '../vision/ocr.js'
import { redactText, scanTextDetailed, SCANNER_VERSION, type Finding } from '../vision/secrets.js'
import { runKeyframes, type KeyframesResult } from './keyframes.js'
import type { Sensitivity } from '../vision/dhash.js'
import type { Box } from '../vision/frames.js'

export interface ReadScreenParams {
  source: string
  languages?: string[]
  detectSecrets?: boolean
  sensitivity?: Sensitivity
  maxFrames?: number
  presenterRegion?: Box
  fromSec?: number
  toSec?: number
  /** Reuse frames from a finished keyframes job instead of extracting again. */
  keyframes?: KeyframesResult
}

export interface ScreenFrame {
  index: number
  pts: number
  text: string
  meanConfidence: number
  blocks: OcrBlock[]
  secrets: Finding[]
}

export interface ReadScreenResult {
  source: { input: string; identity: string; durationSec: number }
  frames: ScreenFrame[]
  /** Frame images and contact sheets used for the OCR pass, so ollos_frames can show them. */
  images?: { frames: Array<{ index: number; pts: number; file: string; sheet: number; tile: number }>; sheets: Array<{ index: number; file: string; frames: number[] }> }
  secrets: Finding[]
  stats: { frames: number; framesWithText: number; totalBlocks: number; ocrSec: number; processingSec: number }
  artifacts: { json: string; txt: string }
  cached: boolean
}

export function estimateReadScreenSeconds(durationSec: number, maxFrames: number): number {
  const frames = Math.min(maxFrames, Math.max(6, durationSec / 6))
  return 10 + durationSec * 0.04 + frames * 3.2
}

export async function runReadScreen(params: ReadScreenParams, ctx: JobContext, config: OllosConfig, pre?: ResolvedSource): Promise<ReadScreenResult> {
  const t0 = Date.now()
  const langs = params.languages ?? ['por', 'eng']
  const detect = params.detectSecrets ?? true

  let kf = params.keyframes
  if (!kf) {
    const src = pre ?? (await resolveSource(params.source, config, { signal: ctx.signal }))
    if (src.info.kind === 'image') {
      // single image: OCR it directly
      const jpeg = fs.readFileSync(src.path)
      ctx.progress('ocr', 0.2, 'reading image')
      const r = await ocrFrame(jpeg, config, { langs, signal: ctx.signal })
      const scan = detect ? scanTextDetailed(r.text, { frameIndex: 1 }) : { findings: [], raws: [] }
      const secrets = scan.findings
      // the value never leaves this pipeline: text and blocks are scrubbed with the same masks the findings carry
      const text = redactText(r.text, scan.raws)
      const frame: ScreenFrame = { index: 1, pts: 0, text, meanConfidence: r.meanConfidence, blocks: r.blocks.map((b) => ({ ...b, text: redactText(b.text, scan.raws) })), secrets }
      const artifacts = { json: path.join(ctx.artifactsDir, 'ocr.json'), txt: path.join(ctx.artifactsDir, 'ocr.txt') }
      const result: ReadScreenResult = { source: { input: src.input, identity: src.identity, durationSec: 0 }, frames: [frame], secrets, stats: { frames: 1, framesWithText: r.text ? 1 : 0, totalBlocks: r.blocks.length, ocrSec: r.ms / 1000, processingSec: (Date.now() - t0) / 1000 }, artifacts, cached: false }
      fs.writeFileSync(artifacts.json, JSON.stringify(result, null, 2))
      fs.writeFileSync(artifacts.txt, text)
      return result
    }
    ctx.progress('keyframes', 0.02, 'selecting frames to read')
    // native width: OCR of small UI text degrades fast below the source resolution (8 px text is already the limit)
    kf = await runKeyframes({ source: params.source, sensitivity: params.sensitivity ?? 'normal', maxFrames: params.maxFrames ?? 80, frameWidth: 3840, presenterRegion: params.presenterRegion, fromSec: params.fromSec, toSec: params.toSec }, { ...ctx, progress: (s, f, m) => ctx.progress('keyframes:' + s, 0.02 + f * 0.28, m) }, config, src)
  }

  const cache = new Cache(config)
  const key = hashOf(kf.source.identity, kf.frames.map((f) => f.pts), langs, detect, SCANNER_VERSION)
  const hit = cache.getJSON<ReadScreenResult>('ocr', key)
  if (hit) {
    ctx.event({ stage: 'cache', event: 'info', message: 'ocr served from cache' })
    return { ...hit, cached: true }
  }

  const frames: ScreenFrame[] = []
  const tOcr = Date.now()
  for (let i = 0; i < kf.frames.length; i++) {
    if (ctx.signal.aborted) throw new OllosError('CANCELLED', 'cancelled')
    const f = kf.frames[i]!
    const jpeg = fs.readFileSync(f.file)
    const r = await ocrFrame(jpeg, config, { langs, signal: ctx.signal })
    const scan = detect ? scanTextDetailed(r.text, { pts: f.pts, frameIndex: f.index }) : { findings: [], raws: [] }
    const secrets = scan.findings
    frames.push({ index: f.index, pts: f.pts, text: redactText(r.text, scan.raws), meanConfidence: r.meanConfidence, blocks: r.blocks.map((b) => ({ ...b, text: redactText(b.text, scan.raws) })), secrets })
    ctx.progress('ocr', 0.3 + 0.65 * ((i + 1) / kf.frames.length), `reading frame ${i + 1}/${kf.frames.length} at ${fmtTime(f.pts)}${secrets.length ? ` — ${secrets.length} finding(s)` : ''}`)
  }
  const ocrSec = (Date.now() - tOcr) / 1000
  ctx.event({ stage: 'ocr', event: 'end', durationMs: Date.now() - tOcr, data: { frames: frames.length } })

  // dedupe across frames: same masked value → keep the earliest, note how many frames
  const seen = new Map<string, Finding & { frames: number }>()
  for (const fr of frames) for (const s of fr.secrets) {
    const k = s.kind + ':' + s.masked + ':' + s.length
    const prev = seen.get(k)
    if (prev) prev.frames++
    else seen.set(k, { ...s, frames: 1 })
  }
  const secrets = [...seen.values()]

  const artifacts = { json: path.join(ctx.artifactsDir, 'ocr.json'), txt: path.join(ctx.artifactsDir, 'ocr.txt') }
  const result: ReadScreenResult = {
    source: { input: kf.source.input, identity: kf.source.identity, durationSec: kf.source.durationSec },
    frames,
    images: { frames: kf.frames.map((f) => ({ index: f.index, pts: f.pts, file: f.file, sheet: f.sheet, tile: f.tile })), sheets: kf.sheets },
    secrets,
    stats: { frames: frames.length, framesWithText: frames.filter((f) => f.text.trim()).length, totalBlocks: frames.reduce((a, f) => a + f.blocks.length, 0), ocrSec: Number(ocrSec.toFixed(1)), processingSec: Number(((Date.now() - t0) / 1000).toFixed(1)) },
    artifacts,
    cached: false,
  }
  fs.writeFileSync(artifacts.json, JSON.stringify(result, null, 2))
  fs.writeFileSync(artifacts.txt, frames.map((f) => `=== #${f.index} ${fmtTime(f.pts)} (conf ${f.meanConfidence}%)\n${f.text}`).join('\n\n'))
  cache.setJSON('ocr', key, result)
  return result
}
