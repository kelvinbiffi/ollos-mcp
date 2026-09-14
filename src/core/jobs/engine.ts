import crypto from 'node:crypto'
import type { OllosConfig, ResourceClass } from '../config.js'
import { asOllosError, OllosError } from '../errors.js'
import { JobStore } from './store.js'
import type { JobContext, JobDefinition, JobRecord } from './types.js'

/** OLLOS_DEBUG_MEM=1 stamps every job event with process memory (MB), so `ollos events <id>` shows which stage holds what. */
const DEBUG_MEM = process.env.OLLOS_DEBUG_MEM === '1'
function memSnapshot(): { rss: number; heap: number; arrayBuffers: number } {
  const m = process.memoryUsage()
  const mb = (n: number) => Math.round(n / 1048576)
  return { rss: mb(m.rss), heap: mb(m.heapUsed), arrayBuffers: mb(m.arrayBuffers) }
}

class Semaphore {
  private queue: Array<() => void> = []
  private active = 0
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++
      return () => this.release()
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
    return () => this.release()
  }
  private release() {
    this.active--
    this.queue.shift()?.()
  }
}

export interface SubmitResult<R> {
  job: JobRecord
  /** Present when the job ran inline (small enough) or was served from a previous identical run. */
  result?: R
}

/**
 * The task engine. Protocol-agnostic: the MCP layer maps it to Tasks or to job tools, the CLI just awaits it.
 * - one semaphore per resource class (ASR = 1, by measurement)
 * - heartbeat every 5 s; on startup anything "running" with a stale heartbeat becomes "interrupted"
 * - small work runs inline and returns the result directly
 */
export class JobEngine {
  readonly store: JobStore
  private readonly defs = new Map<string, JobDefinition<unknown, unknown>>()
  private readonly sems = new Map<ResourceClass, Semaphore>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly running = new Map<string, Promise<unknown>>()

  constructor(private readonly config: OllosConfig) {
    this.store = new JobStore(config)
    for (const [cls, n] of Object.entries(config.concurrency) as Array<[ResourceClass, number]>) this.sems.set(cls, new Semaphore(n))
    this.recover()
  }

  register<P, R>(def: JobDefinition<P, R>): void {
    this.defs.set(def.kind, def as JobDefinition<unknown, unknown>)
  }

  /** Mark orphans left by a previous process. Without this, an agent would poll a dead job forever. */
  private recover(): void {
    const now = Date.now()
    for (const job of this.store.list()) {
      if (job.status === 'running') {
        const hb = job.heartbeatAt ? Date.parse(job.heartbeatAt) : 0
        if (now - hb > this.config.staleAfterMs) {
          job.status = 'interrupted'
          job.error = { code: 'INTERRUPTED', message: 'the server process stopped while this job was running', hint: 'Submit the job again; cached stages will be reused.' }
          job.finishedAt = new Date().toISOString()
          this.store.save(job)
        }
      } else if (job.status === 'queued') {
        job.status = 'interrupted'
        job.error = { code: 'INTERRUPTED', message: 'the server process stopped before this job started' }
        this.store.save(job)
      }
    }
  }

  async submit<P, R>(kind: string, params: P, opts: { inline?: boolean; parentJobId?: string } = {}): Promise<SubmitResult<R>> {
    const def = this.defs.get(kind) as JobDefinition<P, R> | undefined
    if (!def) throw new OllosError('INVALID_ARGUMENT', `unknown job kind "${kind}"`)
    const id = 'j_' + crypto.randomBytes(6).toString('hex')
    const now = new Date().toISOString()
    const job: JobRecord<P> = { schemaVersion: 1, id, kind, params, status: 'queued', progress: { stage: 'queued', fraction: 0, message: 'waiting for a slot' }, createdAt: now, updatedAt: now, parentJobId: opts.parentJobId }
    this.store.save(job)

    const estimate = await def.estimateSeconds(params)
    const promise = this.execute(def, job)
    this.running.set(id, promise)
    promise.finally(() => this.running.delete(id)).catch(() => {})

    if (opts.inline ?? estimate <= this.config.limits.inlineThresholdSec) {
      await promise.catch(() => {})
      const done = this.store.load(id)!
      return { job: done, result: done.status === 'completed' ? this.store.loadResult<R>(id) : undefined }
    }
    return { job: this.store.load(id)! }
  }

  /** Await a job you already submitted (CLI uses this). */
  async wait<R>(id: string): Promise<{ job: JobRecord; result?: R }> {
    const p = this.running.get(id)
    if (p) await p.catch(() => {})
    const job = this.store.load(id)
    if (!job) throw new OllosError('JOB_NOT_FOUND', `no job ${id}`)
    return { job, result: job.status === 'completed' ? this.store.loadResult<R>(id) : undefined }
  }

  get(id: string): JobRecord | undefined {
    return this.store.load(id)
  }

  result<R>(id: string): R | undefined {
    return this.store.loadResult<R>(id)
  }

  cancel(id: string): JobRecord {
    const job = this.store.load(id)
    if (!job) throw new OllosError('JOB_NOT_FOUND', `no job ${id}`)
    const ctrl = this.controllers.get(id)
    if (!ctrl) {
      if (job.status === 'queued') {
        job.status = 'cancelled'
        job.finishedAt = new Date().toISOString()
        this.store.save(job)
        return job
      }
      throw new OllosError('JOB_NOT_CANCELLABLE', `job ${id} is already ${job.status}`)
    }
    ctrl.abort()
    return this.store.load(id)!
  }

  estimate(kind: string, params: unknown): Promise<number> | number {
    const def = this.defs.get(kind)
    if (!def) throw new OllosError('INVALID_ARGUMENT', `unknown job kind "${kind}"`)
    return def.estimateSeconds(params)
  }

  private async execute<P, R>(def: JobDefinition<P, R>, job: JobRecord<P>): Promise<void> {
    const cls = typeof def.resourceClass === 'function' ? def.resourceClass(job.params) : def.resourceClass
    const release = await this.sems.get(cls)!.acquire()
    const ctrl = new AbortController()
    this.controllers.set(job.id, ctrl)
    let heartbeat: NodeJS.Timeout | undefined
    const t0 = Date.now()

    const current = this.store.load(job.id)!
    if (current.status === 'cancelled') {
      release()
      this.controllers.delete(job.id)
      return
    }

    try {
      current.status = 'running'
      current.startedAt = new Date().toISOString()
      current.heartbeatAt = current.startedAt
      current.progress = { stage: 'starting', fraction: 0, message: 'starting' }
      this.store.save(current)
      heartbeat = setInterval(() => {
        const j = this.store.load(job.id)
        if (j && j.status === 'running') {
          j.heartbeatAt = new Date().toISOString()
          this.store.save(j)
        }
      }, this.config.heartbeatMs)

      const ctx: JobContext = {
        jobId: job.id,
        signal: ctrl.signal,
        artifactsDir: this.store.artifactsDir(job.id),
        progress: (stage, fraction, message) => {
          const j = this.store.load(job.id)
          if (!j || j.status !== 'running') return
          j.progress = { stage, fraction: Math.min(1, Math.max(0, fraction)), message: message ?? stage }
          j.heartbeatAt = new Date().toISOString()
          this.store.save(j)
        },
        event: (e) => this.store.appendEvent(job.id, { ts: new Date().toISOString(), ...e, ...(DEBUG_MEM ? { mem: memSnapshot() } : {}) }),
      }
      ctx.event({ stage: 'job', event: 'start', data: { kind: job.kind, resourceClass: cls } })
      const result = await def.run(job.params, ctx)
      if (ctrl.signal.aborted) throw new OllosError('CANCELLED', 'cancelled')
      const done = this.store.load(job.id)!
      done.resultFile = this.store.saveResult(job.id, result)
      done.status = 'completed'
      done.progress = { stage: 'done', fraction: 1, message: 'completed' }
      done.finishedAt = new Date().toISOString()
      this.store.save(done)
      ctx.event({ stage: 'job', event: 'end', durationMs: Date.now() - t0 })
    } catch (e) {
      // Whatever the pipeline threw while aborting (ffmpeg killed, fetch aborted, a plain Error), an aborted signal means cancelled.
      const err = ctrl.signal.aborted ? new OllosError('CANCELLED', 'cancelled by request', { cause: e }) : asOllosError(e)
      const failed = this.store.load(job.id)!
      failed.status = err.code === 'CANCELLED' ? 'cancelled' : 'failed'
      failed.error = err.toJSON()
      failed.finishedAt = new Date().toISOString()
      this.store.save(failed)
      this.store.appendEvent(job.id, { ts: new Date().toISOString(), stage: 'job', event: 'error', durationMs: Date.now() - t0, message: err.message, data: { code: err.code } })
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      this.controllers.delete(job.id)
      release()
    }
  }
}
