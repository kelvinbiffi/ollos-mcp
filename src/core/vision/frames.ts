import sharp from 'sharp'
import { resolveBinaries, run, fmtTime } from '../media/ffmpeg.js'
import type { Window } from '../media/decode.js'
import type { OllosConfig } from '../config.js'
import { DHASH_H, DHASH_W } from './dhash.js'

export interface Box {
  /** Fractions of frame width/height, 0–1. */
  x: number
  y: number
  w: number
  h: number
}

function windowArgs(w: Window | undefined): string[] {
  const a: string[] = []
  if (w?.fromSec !== undefined) a.push('-ss', String(w.fromSec))
  if (w?.toSec !== undefined) a.push('-to', String(w.toSec))
  return a
}

function maskFilter(box: Box | undefined): string {
  if (!box) return ''
  return `,drawbox=x=iw*${box.x}:y=ih*${box.y}:w=iw*${box.w}:h=ih*${box.h}:color=black:t=fill`
}

/**
 * One pass over the video producing a 9×8 grayscale thumbnail per sampled frame.
 * At 1 fps an hour of video is 3600 × 72 bytes — trivially cheap to hash and compare.
 */
export async function sampleThumbnails(file: string, config: OllosConfig, opts: Window & { fps?: number; mask?: Box; signal?: AbortSignal } = {}): Promise<{ pts: number[]; thumbs: Uint8Array[] }> {
  const { ffmpeg } = resolveBinaries(config)
  const fps = opts.fps ?? 1
  const { stdout } = await run(
    ffmpeg,
    ['-v', 'error', '-nostdin', ...windowArgs(opts), '-i', file, '-an', '-vf', `fps=${fps}${maskFilter(opts.mask)},scale=${DHASH_W}:${DHASH_H}:flags=area,format=gray`, '-f', 'rawvideo', '-'],
    { signal: opts.signal },
  )
  const size = DHASH_W * DHASH_H
  const n = Math.floor(stdout.length / size)
  const thumbs: Uint8Array[] = []
  const pts: number[] = []
  const from = opts.fromSec ?? 0
  for (let i = 0; i < n; i++) {
    thumbs.push(new Uint8Array(stdout.subarray(i * size, (i + 1) * size)))
    pts.push(from + i / fps)
  }
  return { pts, thumbs }
}

/** Hard cuts: ffmpeg's scene score above `threshold`. Catches window switches and modals with exact timestamps; blind to scrolling. */
export async function detectSceneCuts(file: string, config: OllosConfig, opts: Window & { threshold?: number; mask?: Box; signal?: AbortSignal } = {}): Promise<number[]> {
  const { ffmpeg } = resolveBinaries(config)
  const th = opts.threshold ?? 0.3
  const { stderr } = await run(ffmpeg, ['-v', 'info', '-nostdin', ...windowArgs(opts), '-i', file, '-an', '-vf', `${opts.mask ? maskFilter(opts.mask).slice(1) + ',' : ''}select='gt(scene,${th})',showinfo`, '-fps_mode', 'vfr', '-f', 'null', '-'], { signal: opts.signal })
  const out: number[] = []
  for (const m of stderr.matchAll(/pts_time:\s*([0-9.]+)/g)) out.push(Number(m[1]))
  return out
}

/** One JPEG at an exact timestamp. Seeking before -i is fast (keyframe seek then decode forward). */
export async function extractFrame(file: string, pts: number, config: OllosConfig, opts: { width?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
  const { ffmpeg } = resolveBinaries(config)
  const scale = opts.width ? `scale=${opts.width}:-2:flags=lanczos` : 'null'
  const { stdout } = await run(ffmpeg, ['-v', 'error', '-nostdin', '-ss', pts.toFixed(3), '-i', file, '-an', '-frames:v', '1', '-vf', scale, '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', '-'], { signal: opts.signal })
  return stdout
}

export interface SheetTile {
  jpeg: Buffer
  pts: number
  index: number
}

/**
 * Pack tiles into a grid with the timestamp burned in each corner.
 * 9 frames per image is the ratio the community measured as the sweet spot between detail and token cost.
 */
export async function contactSheet(tiles: SheetTile[], opts: { cols?: number; tileWidth?: number } = {}): Promise<Buffer> {
  const cols = opts.cols ?? 3
  const tileWidth = opts.tileWidth ?? 480
  const resized = await Promise.all(
    tiles.map(async (t) => {
      const img = sharp(t.jpeg).resize({ width: tileWidth, fit: 'inside' })
      const buf = await img.jpeg({ quality: 82 }).toBuffer()
      const meta = await sharp(buf).metadata()
      return { buf, w: meta.width ?? tileWidth, h: meta.height ?? Math.round((tileWidth * 9) / 16), pts: t.pts, index: t.index }
    }),
  )
  const tileH = Math.max(...resized.map((r) => r.h))
  const rows = Math.ceil(resized.length / cols)
  const gap = 4
  const W = cols * tileWidth + (cols + 1) * gap
  const H = rows * tileH + (rows + 1) * gap
  const composites: sharp.OverlayOptions[] = []
  resized.forEach((r, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const left = gap + col * (tileWidth + gap)
    const top = gap + row * (tileH + gap)
    composites.push({ input: r.buf, left, top })
    const label = `#${r.index} ${fmtTime(r.pts)}`
    const svg = `<svg width="${tileWidth}" height="28" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="${label.length * 9 + 14}" height="26" rx="4" fill="black" fill-opacity="0.72"/><text x="7" y="19" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="bold" fill="#ffd400">${label}</text></svg>`
    composites.push({ input: Buffer.from(svg), left, top: top + tileH - 28 })
  })
  return sharp({ create: { width: W, height: H, channels: 3, background: { r: 18, g: 18, b: 18 } } })
    .composite(composites)
    .jpeg({ quality: 84 })
    .toBuffer()
}

/** Crop a region (fractions) and upscale; OCR reads 8 px text only after this. */
export async function cropUpscale(jpeg: Buffer, box: Box, scale: number): Promise<Buffer> {
  const meta = await sharp(jpeg).metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  const left = Math.max(0, Math.floor(box.x * W))
  const top = Math.max(0, Math.floor(box.y * H))
  const width = Math.min(W - left, Math.ceil(box.w * W))
  const height = Math.min(H - top, Math.ceil(box.h * H))
  return sharp(jpeg)
    .extract({ left, top, width, height })
    .resize({ width: Math.round(width * scale), kernel: 'lanczos3' })
    .grayscale()
    .normalise()
    .png()
    .toBuffer()
}
