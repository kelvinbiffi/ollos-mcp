/**
 * ollos-mcp core: import this from a script, an n8n node, a Lambda — no MCP required.
 *
 *   import { createOllos } from 'ollos-mcp'
 *   const ollos = createOllos()
 *   const { job, result } = await ollos.transcribe({ source: 'talk.mp4', language: 'pt' })
 */
import { loadConfig, type OllosConfig } from './config.js'
import { JobEngine } from './jobs/engine.js'
import { registerPipelines } from './pipelines/register.js'
import { probe } from './media/probe.js'
import { resolveSource } from './source/resolve.js'
import type { TranscribeParams, TranscribeResult } from './pipelines/transcribe.js'
import type { KeyframesParams, KeyframesResult } from './pipelines/keyframes.js'
import type { ReadScreenParams, ReadScreenResult } from './pipelines/readScreen.js'
import type { ReviewParams, ReviewResult } from './pipelines/review.js'
import type { DiarizeParams, DiarizeResult } from './pipelines/diarize.js'
import { runSearch, type SearchParams, type SearchResult } from './pipelines/search.js'

export * from './config.js'
export * from './errors.js'
export type { JobRecord, JobStatus, JobProgress, JobEvent } from './jobs/types.js'
export type { MediaInfo, MediaKind, AspectInfo } from './media/probe.js'
export type { TranscribeParams, TranscribeResult, Segment } from './pipelines/transcribe.js'
export type { KeyframesParams, KeyframesResult, KeyFrame, Sheet } from './pipelines/keyframes.js'
export type { ReadScreenParams, ReadScreenResult, ScreenFrame } from './pipelines/readScreen.js'
export type { ReviewParams, ReviewResult, ReviewFinding, Check, Severity } from './pipelines/review.js'
export type { DiarizeParams, DiarizeResult, SpeakerInfo } from './pipelines/diarize.js'
export type { SearchParams, SearchResult } from './pipelines/search.js'
export type { Hit, Doc } from './search/index.js'
export type { Finding, SecretKind } from './vision/secrets.js'
export { scanText, mask, SCANNER_VERSION } from './vision/secrets.js'
export { PLATFORMS } from './media/measure.js'
export { JOB_KINDS, type JobKind } from './pipelines/register.js'
export { modelCatalog, isModelCached } from './models.js'

export class Ollos {
  readonly config: OllosConfig
  readonly engine: JobEngine

  constructor(config?: Partial<OllosConfig>) {
    this.config = loadConfig(config)
    this.engine = new JobEngine(this.config)
    registerPipelines(this.engine, this.config)
  }

  /** Metadata only. Always fast, never a job. */
  async probe(source: string) {
    const src = await resolveSource(source, this.config)
    return { ...src.info, origin: src.origin, identity: src.identity, path: src.path, zoomTracks: src.zoomTracks?.map((t) => t.participant) }
  }

  transcribe(params: TranscribeParams, opts?: { inline?: boolean }) {
    return this.engine.submit<TranscribeParams, TranscribeResult>('transcribe', params, opts)
  }
  keyframes(params: KeyframesParams, opts?: { inline?: boolean }) {
    return this.engine.submit<KeyframesParams, KeyframesResult>('keyframes', params, opts)
  }
  readScreen(params: ReadScreenParams, opts?: { inline?: boolean }) {
    return this.engine.submit<ReadScreenParams, ReadScreenResult>('read_screen', params, opts)
  }
  review(params: ReviewParams, opts?: { inline?: boolean }) {
    return this.engine.submit<ReviewParams, ReviewResult>('review', params, opts)
  }
  /** Experimental: speech over music clusters as its own speaker; see README limits. */
  diarize(params: DiarizeParams, opts?: { inline?: boolean }) {
    return this.engine.submit<DiarizeParams, DiarizeResult>('diarize', params, opts)
  }
  /** Synchronous: hybrid BM25 + embedding search over everything transcribed and read. */
  search(params: SearchParams): Promise<SearchResult> {
    return runSearch(params, this.engine, this.config)
  }

  estimate(kind: string, params: unknown) {
    return this.engine.estimate(kind, params)
  }
  wait<R>(jobId: string) {
    return this.engine.wait<R>(jobId)
  }
  job(jobId: string) {
    return this.engine.get(jobId)
  }
  result<R>(jobId: string) {
    return this.engine.result<R>(jobId)
  }
  cancel(jobId: string) {
    return this.engine.cancel(jobId)
  }
  jobs() {
    return this.engine.list()
  }
  events(jobId: string) {
    return this.engine.store.readEvents(jobId)
  }
}

export function createOllos(config?: Partial<OllosConfig>): Ollos {
  return new Ollos(config)
}

export { probe }
