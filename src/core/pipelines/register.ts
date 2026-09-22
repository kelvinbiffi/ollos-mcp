import type { OllosConfig } from '../config.js'
import type { JobEngine } from '../jobs/engine.js'
import { resolveSource, type ResolvedSource } from '../source/resolve.js'
import { estimateTranscribeSeconds, runTranscribe, type TranscribeParams, type TranscribeResult } from './transcribe.js'
import { estimateKeyframesSeconds, runKeyframes, type KeyframesParams, type KeyframesResult } from './keyframes.js'
import { estimateReadScreenSeconds, runReadScreen, type ReadScreenParams, type ReadScreenResult } from './readScreen.js'
import { estimateReviewSeconds, runReview, type ReviewParams, type ReviewResult } from './review.js'
import { estimateDiarizeSeconds, runDiarize, type DiarizeParams, type DiarizeResult } from './diarize.js'

export const JOB_KINDS = ['transcribe', 'keyframes', 'read_screen', 'review', 'diarize'] as const
export type JobKind = (typeof JOB_KINDS)[number]

/** Seconds of media the job will actually look at. `pre` is the source resolved once by the engine under the job's signal. */
function windowDuration(pre: ResolvedSource | undefined, fromSec: number | undefined, toSec: number | undefined): number {
  const total = pre?.info.durationSec ?? 600
  return Math.max(1, Math.min(total, (toSec ?? total) - (fromSec ?? 0)))
}

const prepare = (config: OllosConfig) => (p: { source: string }, signal: AbortSignal) => resolveSource(p.source, config, { signal })

/**
 * Wire every pipeline into the engine with its resource class and cost estimate.
 * Estimates drive the inline fast path (small work returns directly) and the ETA shown to the agent.
 */
export function registerPipelines(engine: JobEngine, config: OllosConfig): void {
  engine.register<TranscribeParams, TranscribeResult, ResolvedSource>({
    kind: 'transcribe',
    resourceClass: 'asr',
    prepare: prepare(config),
    estimateSeconds: (p, pre) => estimateTranscribeSeconds(windowDuration(pre, p.fromSec, p.toSec), p.model),
    run: (p, ctx, pre) => runTranscribe(p, ctx, config, pre),
  })
  engine.register<KeyframesParams, KeyframesResult, ResolvedSource>({
    kind: 'keyframes',
    resourceClass: 'vision',
    prepare: prepare(config),
    estimateSeconds: (p, pre) => estimateKeyframesSeconds(windowDuration(pre, p.fromSec, p.toSec), p.maxFrames ?? 120),
    run: (p, ctx, pre) => runKeyframes(p, ctx, config, pre),
  })
  engine.register<ReadScreenParams, ReadScreenResult, ResolvedSource>({
    kind: 'read_screen',
    resourceClass: 'ocr',
    prepare: prepare(config),
    estimateSeconds: (p, pre) => estimateReadScreenSeconds(windowDuration(pre, p.fromSec, p.toSec), p.maxFrames ?? 80),
    run: (p, ctx, pre) => runReadScreen(p, ctx, config, pre),
  })
  engine.register<ReviewParams, ReviewResult, ResolvedSource>({
    kind: 'review',
    resourceClass: (p) => ((p.checks ?? ['loudness', 'silences', 'aspect', 'secrets']).includes('secrets') ? 'ocr' : 'light'),
    prepare: prepare(config),
    estimateSeconds: (p, pre) => estimateReviewSeconds(windowDuration(pre, p.fromSec, p.toSec), p.checks ?? ['loudness', 'silences', 'aspect', 'secrets'], config.limits.maxFrames),
    run: (p, ctx, pre) => runReview(p, ctx, config, pre),
  })
  engine.register<DiarizeParams, DiarizeResult, ResolvedSource>({
    kind: 'diarize',
    resourceClass: 'asr', // shares the CPU-heavy lane with Whisper; the two together thrash
    prepare: prepare(config),
    estimateSeconds: (p, pre) => estimateDiarizeSeconds(windowDuration(pre, p.fromSec, p.toSec)),
    run: (p, ctx, pre) => runDiarize(p, ctx, config, pre),
  })
}
