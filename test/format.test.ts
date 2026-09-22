import { describe, expect, it } from 'vitest'
import { estimateTokens, trimStructuredResult } from '../src/mcp/format.js'
import type { ReadScreenResult } from '../src/core/pipelines/readScreen.js'
import type { KeyframesResult } from '../src/core/pipelines/keyframes.js'

/**
 * Regression for issue #2: `ollos_job` shipping the entire pipeline result in `structuredContent`,
 * unbounded, on top of the already-budgeted text content — 62,000 characters on a real `read_screen`
 * job, past a client's own tool-result limit.
 */
describe('trimStructuredResult', () => {
  it('leaves small results untouched', () => {
    const small: ReadScreenResult = {
      source: { input: 'x.mp4', identity: 'id', durationSec: 10 },
      frames: [{ index: 1, pts: 0, text: 'hello', meanConfidence: 0.9, blocks: [], secrets: [] }],
      secrets: [],
      stats: { frames: 1, framesWithText: 1, totalBlocks: 0, ocrSec: 1, processingSec: 1, candidateFrames: 1, framesPruned: 0 },
      artifacts: { json: 'a.json', txt: 'a.txt' },
      cached: false,
    }
    expect(trimStructuredResult('read_screen', 'j_abc', small, 4000)).toBe(small)
  })

  it('strips OCR blocks and caps per-frame text once a read_screen result exceeds the budget', () => {
    const bigBlocks = Array.from({ length: 40 }, (_, i) => ({ text: `line ${i}`, confidence: 0.9, bbox: { x: 0, y: 0, w: 1, h: 1 }, tile: 0 }))
    const result: ReadScreenResult = {
      source: { input: 'x.mp4', identity: 'id', durationSec: 600 },
      frames: Array.from({ length: 80 }, (_, i) => ({ index: i + 1, pts: i * 5, text: 'x'.repeat(500), meanConfidence: 0.9, blocks: bigBlocks, secrets: [] })),
      secrets: [],
      stats: { frames: 80, framesWithText: 80, totalBlocks: 3200, ocrSec: 40, processingSec: 60, candidateFrames: 80, framesPruned: 0 },
      artifacts: { json: 'a.json', txt: 'a.txt' },
      cached: false,
    }
    expect(estimateTokens(JSON.stringify(result))).toBeGreaterThan(4000)
    const trimmed = trimStructuredResult('read_screen', 'j_abc', result, 4000) as ReadScreenResult & { trimmedForResponse: string }
    expect(estimateTokens(JSON.stringify(trimmed))).toBeLessThan(estimateTokens(JSON.stringify(result)))
    expect(trimmed.frames.every((f) => (f as unknown as { blocks?: unknown }).blocks === undefined)).toBe(true)
    expect(trimmed.frames.length).toBe(80)
    expect(trimmed.trimmedForResponse).toContain('j_abc')
    expect(trimmed.secrets).toEqual(result.secrets)
  })

  it('drops perceptual hashes from keyframes once the result exceeds the budget', () => {
    const result: KeyframesResult = {
      source: { input: 'x.mp4', identity: 'id', durationSec: 600, width: 1920, height: 1080 },
      params: { sensitivity: 'normal', threshold: 6, maxFrames: 120, frameWidth: 1280, floorSec: 20 },
      frames: Array.from({ length: 120 }, (_, i) => ({ index: i + 1, pts: i * 5, sources: ['hash'], hash: 'ab'.repeat(200), distance: 0, file: `f${i}.jpg`, sheet: 1, tile: i })),
      sheets: [],
      stats: { sampled: 600, afterHash: 120, cuts: 0, anchors: 0, floorAdded: 0, pruned: 0, processingSec: 5 },
      cached: false,
    }
    expect(estimateTokens(JSON.stringify(result))).toBeGreaterThan(4000)
    const trimmed = trimStructuredResult('keyframes', 'j_def', result, 4000) as KeyframesResult
    expect(trimmed.frames.every((f) => !('hash' in f))).toBe(true)
    expect(trimmed.frames[0]!.index).toBe(1)
  })

  it('keeps the most recent segments of a long transcript and reports how many were dropped', () => {
    const segments = Array.from({ length: 500 }, (_, i) => ({ startSec: i * 4, endSec: i * 4 + 4, text: 'word '.repeat(30), confidence: 0.9 }))
    const result = {
      source: { input: 'x.mp3', identity: 'id', durationSec: 2000 },
      language: 'en',
      model: 'whisper-large-v3-turbo',
      vad: { engine: 'silero' as const, speechSec: 1800, regions: 50 },
      segments,
      stats: { segmentCount: 500, filteredCount: 0, wordCount: 15000, vocabularyReplacements: 0, processingSec: 60 },
      artifacts: { json: 'a.json', txt: 'a.txt', srt: 'a.srt' },
      cached: false,
    }
    const trimmed = trimStructuredResult('transcribe', 'j_ghi', result, 4000) as typeof result & { trimmedForResponse?: string }
    expect(trimmed.segments.length).toBeLessThan(segments.length)
    expect(trimmed.trimmedForResponse).toMatch(/segment\(s\) omitted/)
  })
})
