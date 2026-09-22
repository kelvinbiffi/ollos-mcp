import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/core/config.js'
import { resolveBinaries, run } from '../src/core/media/ffmpeg.js'
import { runKeyframes } from '../src/core/pipelines/keyframes.js'
import type { JobContext } from '../src/core/jobs/types.js'

/**
 * Regression for issue #3: a long unchanging screen (a credential left visible in an editor) contributes at
 * most one dHash candidate; under a global frame cap the prune step removed floor-guaranteed candidates on
 * the same terms as genuinely redundant ones, so the only frame covering that stretch could vanish along
 * with it. `preserveFloor` is the fix: it takes floor candidates out of that first, indiscriminate cull.
 */
const dir = path.resolve('.ollos-test-preserve-floor')
const clip = path.join(dir, 'static.mp4')
const config = loadConfig({ home: path.join(dir, 'home') })

function ctx(jobId: string): JobContext {
  const artifactsDir = path.join(dir, 'artifacts', jobId)
  fs.mkdirSync(artifactsDir, { recursive: true })
  return { jobId, signal: new AbortController().signal, artifactsDir, progress: () => {}, event: () => {} }
}

beforeAll(async () => {
  fs.mkdirSync(dir, { recursive: true })
  const { ffmpeg } = resolveBinaries(config)
  // 40 s of a single unchanging frame: no hard cuts, no dHash-driven candidates beyond the very first sample.
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=40,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip])
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function maxGap(pts: number[]): number {
  const sorted = [...pts].sort((a, b) => a - b)
  let gap = 0
  for (let i = 1; i < sorted.length; i++) gap = Math.max(gap, sorted[i]! - sorted[i - 1]!)
  return gap
}

describe('preserveFloor on a long static screen', () => {
  it('without it, an aggressive frame cap can leave a long unread stretch', async () => {
    const r = await runKeyframes({ source: clip, maxFrames: 3, floorSec: 4, sensitivity: 'normal' }, ctx('j_no_preserve'), config)
    // every candidate here is equally "redundant" (solid colour throughout), so without protection the prune
    // step's distance sort keeps whichever end of the timeline the tie-break happens to favour: frames end up
    // at 0 s, 32 s and 36 s — a 32 s stretch (most of the clip) with nothing read at all. That stretch is
    // exactly where issue #3's credential sat, on screen but never sampled.
    expect(maxGap(r.frames.map((f) => f.pts))).toBeGreaterThan(28)
  })

  it('with it, the same cap keeps the gaps between frames close to even', async () => {
    const r = await runKeyframes({ source: clip, maxFrames: 3, floorSec: 4, preserveFloor: true, sensitivity: 'normal' }, ctx('j_preserve'), config)
    // floor candidates land every 4 s; picking 3 out of 9 evenly should leave no gap much bigger than 3× that.
    expect(maxGap(r.frames.map((f) => f.pts))).toBeLessThan(16)
  })
})
