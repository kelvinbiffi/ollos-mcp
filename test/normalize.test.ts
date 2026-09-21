import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/core/config.js'
import { resolveBinaries, run } from '../src/core/media/ffmpeg.js'
import { resolveSource } from '../src/core/source/resolve.js'
import { extractFrame } from '../src/core/vision/frames.js'

/**
 * Regression test for the bug report of 2026-09-16: ollos_read_screen failing on a macOS screen
 * recording with "colourspace: parameter space not set", always at the last extracted frame.
 * The report's own fixture was an odd, non-16:9 resolution (3454x1884) at a fractional frame rate
 * (43.493 fps) — reproduced here with lavfi so the repo still ships no binary fixtures. `resolveSource`
 * now normalises every video before handing its path back, so every pipeline that extracts a frame
 * (mjpeg, exactly what `read_screen`'s keyframe step uses) reads an even-dimension, integer-fps file.
 */
const dir = path.resolve('.ollos-test-normalize')
const clip = path.join(dir, 'odd.mov')
const config = loadConfig({ home: path.join(dir, 'home') })

beforeAll(async () => {
  fs.mkdirSync(dir, { recursive: true })
  const { ffmpeg } = resolveBinaries(config)
  await run(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=346x192:rate=43.493:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    clip,
  ])
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('video normalisation on an odd-resolution, fractional-fps clip', () => {
  it('resolves to even dimensions and an integer frame rate', async () => {
    const src = await resolveSource(clip, config)
    expect(src.info.video!.width % 2).toBe(0)
    expect(src.info.video!.height % 2).toBe(0)
    expect(Number.isInteger(src.info.video!.fps)).toBe(true)
    expect(src.path).not.toBe(clip)
    expect(fs.existsSync(src.path)).toBe(true)
  })

  it('extracts the last frame through the mjpeg path without a colourspace error', async () => {
    const src = await resolveSource(clip, config)
    const last = src.info.durationSec - 0.05
    const jpeg = await extractFrame(src.path, last, config, { width: 320 })
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })

  it('caches the normalised file: a second resolve of the same source reuses it', async () => {
    const first = await resolveSource(clip, config)
    const statBefore = fs.statSync(first.path)
    const second = await resolveSource(clip, config)
    expect(second.path).toBe(first.path)
    expect(fs.statSync(second.path).mtimeMs).toBe(statBefore.mtimeMs)
  })
})
