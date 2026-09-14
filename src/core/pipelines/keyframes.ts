import fs from 'node:fs'
import path from 'node:path'
import type { OllosConfig } from '../config.js'
import { Cache, hashOf } from '../cache/cache.js'
import { OllosError } from '../errors.js'
import type { JobContext } from '../jobs/types.js'
import { fmtTime } from '../media/ffmpeg.js'
import { assertKindSupports, resolveSource, type ResolvedSource } from '../source/resolve.js'
import { dedupByHash, dhash, dhashToHex, SENSITIVITY_THRESHOLD, type Sensitivity } from '../vision/dhash.js'
import { contactSheet, detectSceneCuts, extractFrame, sampleThumbnails, type Box } from '../vision/frames.js'

export interface KeyframesParams {
  source: string
  sensitivity?: Sensitivity
  maxFrames?: number
  frameWidth?: number
  /** Region to ignore when comparing frames (a presenter webcam), fractions of the frame. */
  presenterRegion?: Box
  /** Extra timestamps that must get a frame (e.g. the start of each transcript segment). */
  anchorsSec?: number[]
  /** Guarantee at least one frame every N seconds (0 disables). */
  floorSec?: number
  sheetCols?: number
  fromSec?: number
  toSec?: number
}

export type CandidateSource = 'hash' | 'cut' | 'anchor' | 'floor'

export interface KeyFrame {
  index: number
  pts: number
  sources: CandidateSource[]
  hash?: string
  distance?: number
  file: string
  sheet: number
  tile: number
}

export interface Sheet {
  index: number
  file: string
  frames: number[]
}

export interface KeyframesResult {
  source: { input: string; identity: string; durationSec: number; width: number; height: number }
  params: { sensitivity: Sensitivity; threshold: number; maxFrames: number; frameWidth: number; floorSec: number }
  frames: KeyFrame[]
  sheets: Sheet[]
  stats: { sampled: number; afterHash: number; cuts: number; anchors: number; floorAdded: number; pruned: number; processingSec: number }
  cached: boolean
}

interface Candidate {
  pts: number
  sources: Set<CandidateSource>
  hash?: string
  distance?: number
}

export function estimateKeyframesSeconds(durationSec: number, maxFrames: number): number {
  return 6 + durationSec * 0.04 + Math.min(maxFrames, durationSec / 5) * 0.3
}

/** Merge candidates closer than `tol` seconds, keeping every source tag. Cuts win on exact time (they mark the instant a modal appears). */
function mergeCandidates(all: Candidate[], tol = 0.75): Candidate[] {
  all.sort((a, b) => a.pts - b.pts)
  const out: Candidate[] = []
  for (const c of all) {
    const last = out[out.length - 1]
    if (last && c.pts - last.pts <= tol) {
      for (const s of c.sources) last.sources.add(s)
      if (c.sources.has('cut') && !last.sources.has('cut')) last.pts = c.pts
      if (c.hash && !last.hash) {
        last.hash = c.hash
        last.distance = c.distance
      }
      if (c.distance !== undefined && last.distance !== undefined) last.distance = Math.max(last.distance, c.distance)
    } else out.push({ pts: c.pts, sources: new Set(c.sources), hash: c.hash, distance: c.distance })
  }
  return out
}

export async function runKeyframes(params: KeyframesParams, ctx: JobContext, config: OllosConfig, pre?: ResolvedSource): Promise<KeyframesResult> {
  const t0 = Date.now()
  ctx.progress('resolve', 0.01, 'resolving source')
  const src = pre ?? (await resolveSource(params.source, config, { signal: ctx.signal }))
  assertKindSupports(src.info, 'keyframes')
  const video = src.info.video!

  const sensitivity = params.sensitivity ?? 'normal'
  const threshold = SENSITIVITY_THRESHOLD[sensitivity]
  const maxFrames = Math.min(params.maxFrames ?? 120, config.limits.maxFrames)
  const frameWidth = params.frameWidth ?? 1280
  const floorSec = params.floorSec ?? 20
  const window = { fromSec: params.fromSec, toSec: params.toSec }
  const from = params.fromSec ?? 0
  const to = params.toSec ?? src.info.durationSec

  const cache = new Cache(config)
  const key = hashOf(src.identity, sensitivity, maxFrames, frameWidth, params.presenterRegion ?? null, floorSec, params.sheetCols ?? 3, from, to, (params.anchorsSec ?? []).map((a) => Math.round(a * 2) / 2))
  const hit = cache.getJSON<KeyframesResult>('keyframes', key)
  if (hit && hit.frames.every((f) => fs.existsSync(f.file))) {
    ctx.event({ stage: 'cache', event: 'info', message: 'keyframes served from cache' })
    return { ...hit, cached: true }
  }

  ctx.progress('sample', 0.05, 'sampling 1 fps thumbnails')
  const ts = Date.now()
  const { pts, thumbs } = await sampleThumbnails(src.path, config, { ...window, fps: 1, mask: params.presenterRegion, signal: ctx.signal })
  if (thumbs.length === 0) throw new OllosError('PIPELINE_EMPTY_OUTPUT', 'no frames could be sampled', { hint: 'Check that the file has a decodable video stream and the from/to window is inside it.' })
  const hashed = thumbs.map((t, i) => ({ index: i, pts: pts[i]!, hash: dhash(t) }))
  const kept = dedupByHash(hashed, threshold)
  ctx.event({ stage: 'hash', event: 'end', durationMs: Date.now() - ts, data: { sampled: hashed.length, kept: kept.length, threshold } })

  ctx.progress('cuts', 0.25, 'detecting hard cuts')
  const tc = Date.now()
  const cuts = await detectSceneCuts(src.path, config, { ...window, threshold: 0.3, mask: params.presenterRegion, signal: ctx.signal })
  ctx.event({ stage: 'cuts', event: 'end', durationMs: Date.now() - tc, data: { cuts: cuts.length } })

  const candidates: Candidate[] = [
    ...kept.map((k) => ({ pts: k.pts, sources: new Set<CandidateSource>(['hash']), hash: dhashToHex(k.hash), distance: k.distance })),
    ...cuts.map((c) => ({ pts: c + 0.4, sources: new Set<CandidateSource>(['cut']) })), // 0.4 s after the cut, once the new screen has settled
    ...(params.anchorsSec ?? []).filter((a) => a >= from && a <= to).map((a) => ({ pts: a, sources: new Set<CandidateSource>(['anchor']) })),
  ]
  let merged = mergeCandidates(candidates)

  let floorAdded = 0
  if (floorSec > 0) {
    const withFloor = [...merged]
    let lastPts = from
    for (const c of merged) {
      while (c.pts - lastPts > floorSec) {
        lastPts += floorSec
        withFloor.push({ pts: lastPts, sources: new Set(['floor']) })
        floorAdded++
      }
      lastPts = c.pts
    }
    while (to - lastPts > floorSec) {
      lastPts += floorSec
      withFloor.push({ pts: lastPts, sources: new Set(['floor']) })
      floorAdded++
    }
    merged = mergeCandidates(withFloor)
  }

  let pruned = 0
  if (merged.length > maxFrames) {
    // drop hash-only candidates with the smallest change first; never drop cuts or anchors
    const droppable = merged.filter((c) => c.sources.size === 1 && (c.sources.has('hash') || c.sources.has('floor'))).sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
    const toDrop = new Set(droppable.slice(0, merged.length - maxFrames))
    pruned = toDrop.size
    merged = merged.filter((c) => !toDrop.has(c))
    if (merged.length > maxFrames) {
      pruned += merged.length - maxFrames
      merged = merged.slice(0, maxFrames)
    }
  }

  const framesDir = path.join(ctx.artifactsDir, 'frames')
  const sheetsDir = path.join(ctx.artifactsDir, 'sheets')
  fs.mkdirSync(framesDir, { recursive: true })
  fs.mkdirSync(sheetsDir, { recursive: true })

  const frames: KeyFrame[] = []
  const buffers: Buffer[] = []
  const te = Date.now()
  for (let i = 0; i < merged.length; i++) {
    if (ctx.signal.aborted) throw new OllosError('CANCELLED', 'cancelled')
    const c = merged[i]!
    const jpeg = await extractFrame(src.path, c.pts, config, { width: Math.min(frameWidth, video.width), signal: ctx.signal })
    const file = path.join(framesDir, `${String(i + 1).padStart(3, '0')}.jpg`)
    fs.writeFileSync(file, jpeg)
    buffers.push(jpeg)
    frames.push({ index: i + 1, pts: Number(c.pts.toFixed(2)), sources: [...c.sources], hash: c.hash, distance: c.distance, file, sheet: 0, tile: 0 })
    ctx.progress('extract', 0.3 + 0.5 * ((i + 1) / merged.length), `frame ${i + 1}/${merged.length} at ${fmtTime(c.pts)}`)
  }
  ctx.event({ stage: 'extract', event: 'end', durationMs: Date.now() - te, data: { frames: frames.length } })

  const cols = params.sheetCols ?? 3
  const per = cols * cols
  const sheets: Sheet[] = []
  const tsh = Date.now()
  for (let s = 0; s * per < frames.length; s++) {
    const group = frames.slice(s * per, (s + 1) * per)
    const sheet = await contactSheet(group.map((f, i) => ({ jpeg: buffers[s * per + i]!, pts: f.pts, index: f.index })), { cols })
    const file = path.join(sheetsDir, `${String(s + 1).padStart(2, '0')}.jpg`)
    fs.writeFileSync(file, sheet)
    group.forEach((f, i) => {
      f.sheet = s + 1
      f.tile = i + 1
    })
    sheets.push({ index: s + 1, file, frames: group.map((f) => f.index) })
    ctx.progress('sheets', 0.8 + 0.18 * ((s + 1) * per) / frames.length, `sheet ${s + 1}`)
  }
  ctx.event({ stage: 'sheets', event: 'end', durationMs: Date.now() - tsh, data: { sheets: sheets.length } })

  const result: KeyframesResult = {
    source: { input: src.input, identity: src.identity, durationSec: src.info.durationSec, width: video.width, height: video.height },
    params: { sensitivity, threshold, maxFrames, frameWidth, floorSec },
    frames,
    sheets,
    stats: { sampled: hashed.length, afterHash: kept.length, cuts: cuts.length, anchors: params.anchorsSec?.length ?? 0, floorAdded, pruned, processingSec: Number(((Date.now() - t0) / 1000).toFixed(1)) },
    cached: false,
  }
  fs.writeFileSync(path.join(ctx.artifactsDir, 'frames.json'), JSON.stringify(result, null, 2))
  cache.setJSON('keyframes', key, result)
  return result
}
