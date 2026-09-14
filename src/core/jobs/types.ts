import type { ResourceClass } from '../config.js'

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled'

export interface JobProgress {
  stage: string
  fraction: number
  message: string
}

export interface JobError {
  code: string
  message: string
  hint?: string
  details?: Record<string, unknown>
}

export interface JobRecord<P = unknown> {
  schemaVersion: 1
  id: string
  kind: string
  params: P
  status: JobStatus
  progress: JobProgress
  createdAt: string
  startedAt?: string
  finishedAt?: string
  updatedAt: string
  heartbeatAt?: string
  resultFile?: string
  error?: JobError
  /** Job that produced inputs this one reuses (e.g. diarize reusing a transcript). */
  parentJobId?: string
  cached?: boolean
}

export interface JobEvent {
  ts: string
  stage: string
  event: 'start' | 'end' | 'progress' | 'info' | 'error'
  durationMs?: number
  message?: string
  data?: Record<string, unknown>
}

export interface JobContext {
  jobId: string
  signal: AbortSignal
  /** Directory for this job's artifacts (transcript.json, sheets/, …). */
  artifactsDir: string
  progress: (stage: string, fraction: number, message?: string) => void
  event: (e: Omit<JobEvent, 'ts'>) => void
}

export interface JobDefinition<P, R> {
  kind: string
  resourceClass: ResourceClass | ((params: P) => ResourceClass)
  /** Rough seconds of work, used for the inline fast path and ETA. */
  estimateSeconds: (params: P) => Promise<number> | number
  run: (params: P, ctx: JobContext) => Promise<R>
}
