import type { OllosConfig } from '../config.js'
import type { JobEngine } from '../jobs/engine.js'
import { resolveSource } from '../source/resolve.js'
import { estimateTranscribeSeconds, runTranscribe, type TranscribeParams, type TranscribeResult } from './transcribe.js'
import { estimateKeyframesSeconds, runKeyframes, type KeyframesParams, type KeyframesResult } from './keyframes.js'
import { estimateReadScreenSeconds, runReadScreen, type ReadScreenParams, type ReadScreenResult } from './readScreen.js'
import { estimateReviewSeconds, runReview, type ReviewParams, type ReviewResult } from './review.js'
import { estimateDiarizeSeconds, runDiarize, type DiarizeParams, type DiarizeResult } from './diarize.js'

export const JOB_KINDS = ['transcribe', 'keyframes', 'read_screen', 'review', 'diarize'] as const
export type JobKind = (typeof JOB_KINDS)[number]

async function windowDuration(source: string, fromSec: number | undefined, toSec: number | undefined, config: OllosConfig): Promise<number> {
  try {
    const src = await resolveSource(source, config)
    return Math.max(1, Math.min(src.info.durationSec, (toSec ?? src.info.durationSec) - (fromSec ?? 0)))
  } catch {
    return 600
  }
}

/**
 * Wire every pipeline into the engine with its resource class and cost estimate.
 * Estimates drive the inline fast path (small work returns directly) and the ETA shown to the agent.
 */
export function registerPipelines(engine: JobEngine, config: OllosConfig): void {
  engine.register<TranscribeParams, TranscribeResult>({
    kind: 'transcribe',
    resourceClass: 'asr',
    estimateSeconds: async (p) => estimateTranscribeSeconds(await windowDuration(p.source, p.fromSec, p.toSec, config), p.model),
    run: (p, ctx) => runTranscribe(p, ctx, config),
  })
  engine.register<KeyframesParams, KeyframesResult>({
    kind: 'keyframes',
    resourceClass: 'vision',
    estimateSeconds: async (p) => estimateKeyframesSeconds(await windowDuration(p.source, p.fromSec, p.toSec, config), p.maxFrames ?? 120),
    run: (p, ctx) => runKeyframes(p, ctx, config),
  })
  engine.register<ReadScreenParams, ReadScreenResult>({
    kind: 'read_screen',
    resourceClass: 'ocr',
    estimateSeconds: async (p) => estimateReadScreenSeconds(await windowDuration(p.source, p.fromSec, p.toSec, config), p.maxFrames ?? 80),
    run: (p, ctx) => runReadScreen(p, ctx, config),
  })
  engine.register<ReviewParams, ReviewResult>({
    kind: 'review',
    resourceClass: (p) => ((p.checks ?? ['loudness', 'silences', 'aspect', 'secrets']).includes('secrets') ? 'ocr' : 'light'),
    estimateSeconds: async (p) => estimateReviewSeconds(await windowDuration(p.source, p.fromSec, p.toSec, config), p.checks ?? ['loudness', 'silences', 'aspect', 'secrets']),
    run: (p, ctx) => runReview(p, ctx, config),
  })
  engine.register<DiarizeParams, DiarizeResult>({
    kind: 'diarize',
    resourceClass: 'asr', // shares the CPU-heavy lane with Whisper; the two together thrash
    estimateSeconds: async (p) => estimateDiarizeSeconds(await windowDuration(p.source, p.fromSec, p.toSec, config)),
    run: (p, ctx) => runDiarize(p, ctx, config),
  })
}
