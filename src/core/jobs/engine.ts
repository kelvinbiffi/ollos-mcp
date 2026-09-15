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
  /** Present only when the job ran inline (estimated under the inline threshold); a cache hit on large input still returns a job handle. */
  result?: R
  /** Estimated seconds of work, computed once at submission from the prepared source. */
  etaSeconds?: number
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

  register<P, R, Pre = unknown>(def: JobDefinition<P, R, Pre>): void {
    this.defs.set(def.kind, def as unknown as JobDefinition<unknown, unknown>)
  }

  /**
   * Mark orphans left by a dead process. Without this, an agent would poll a dead job forever.
   * Only jobs whose owner has stopped writing for `staleAfterMs` are touched: a second engine on the same
   * $OLLOS_HOME (the CLI's `ollos jobs`, a second IDE window) must not flip jobs a live server is about to run.
   */
  private recover(): void {
    for (const job of this.store.list()) this.refreshIfStale(job)
  }

  /**
   * A job this process does not own, still `running` or `queued` on disk, is alive only while its owner keeps writing.
   * Called on every read, so a server that crashed and was respawned within the stale window is caught on the next poll
   * instead of reporting a frozen percentage forever.
   */
  private refreshIfStale(job: JobRecord): JobRecord {
    if (this.controllers.has(job.id) || this.running.has(job.id)) return job
    if (job.status !== 'running' && job.status !== 'queued') return job
    const last = Date.parse(job.heartbeatAt ?? job.updatedAt ?? job.createdAt)
    if (Date.now() - last <= this.config.staleAfterMs) return job
    const wasRunning = job.status === 'running'
    job.status = 'interrupted'
    job.error = wasRunning ? { code: 'INTERRUPTED', message: 'the server process stopped while this job was running', hint: 'Submit the job again; cached stages will be reused.' } : { code: 'INTERRUPTED', message: 'the server process stopped before this job started', hint: 'Submit the job again.' }
    job.finishedAt = new Date().toISOString()
    this.store.save(job)
    return job
  }

  list(): JobRecord[] {
    return this.store.list().map((j) => this.refreshIfStale(j))
  }

  async submit<P, R>(kind: string, params: P, opts: { inline?: boolean; parentJobId?: string } = {}): Promise<SubmitResult<R>> {
    const def = this.defs.get(kind) as JobDefinition<P, R> | undefined
    if (!def) throw new OllosError('INVALID_ARGUMENT', `unknown job kind "${kind}"`)
    const id = 'j_' + crypto.randomBytes(6).toString('hex')
    const now = new Date().toISOString()
    const job: JobRecord<P> = { schemaVersion: 1, id, kind, params, status: 'queued', progress: { stage: 'resolve', fraction: 0, message: 'resolving source' }, createdAt: now, updatedAt: now, heartbeatAt: now, parentJobId: opts.parentJobId }
    this.store.save(job)

    // The controller exists before any work so a URL download during prepare() is cancellable by id,
    // and the source is resolved exactly once: prepare → estimate → run all share `pre`.
    const ctrl = new AbortController()
    this.controllers.set(id, ctrl)
    let pre: unknown
    let estimate: number
    try {
      pre = def.prepare ? await def.prepare(params, ctrl.signal) : undefined
      estimate = Number(await def.estimateSeconds(params, pre))
    } catch (e) {
      // a typo'd path or a refused URL is the caller's answer now, not a job that fails on the next poll
      this.controllers.delete(id)
      const err = ctrl.signal.aborted ? new OllosError('CANCELLED', 'cancelled by request', { cause: e }) : asOllosError(e)
      const failed = this.store.load(id)!
      failed.status = err.code === 'CANCELLED' ? 'cancelled' : 'failed'
      failed.error = err.toJSON()
      failed.finishedAt = new Date().toISOString()
      this.store.save(failed)
      this.store.appendEvent(id, { ts: new Date().toISOString(), stage: 'resolve', event: 'error', message: err.message, data: { code: err.code } })
      return { job: failed }
    }
    const queued = this.store.load(id)!
    queued.progress = { stage: 'queued', fraction: 0, message: 'waiting for a slot' }
    this.store.save(queued)

    const promise = this.execute(def, job, ctrl, pre)
    this.running.set(id, promise)
    promise.finally(() => this.running.delete(id)).catch(() => {})

    if (opts.inline ?? estimate <= this.config.limits.inlineThresholdSec) {
      await promise.catch(() => {})
      const done = this.store.load(id)!
      return { job: done, result: done.status === 'completed' ? this.store.loadResult<R>(id) : undefined, etaSeconds: estimate }
    }
    return { job: this.store.load(id)!, etaSeconds: estimate }
  }

  /** Await a job you already submitted (CLI uses this). */
  async wait<R>(id: string): Promise<{ job: JobRecord; result?: R }> {
    const p = this.running.get(id)
    if (p) await p.catch(() => {})
    const job = this.store.load(id)
    if (!job) throw new OllosError('JOB_NOT_FOUND', `no job ${id}`)
    const fresh = this.refreshIfStale(job)
    return { job: fresh, result: fresh.status === 'completed' ? this.store.loadResult<R>(id) : undefined }
  }

  get(id: string): JobRecord | undefined {
    const job = this.store.load(id)
    return job && this.refreshIfStale(job)
  }

  result<R>(id: string): R | undefined {
    return this.store.loadResult<R>(id)
  }

  /**
   * Stop a job. Returns the record after the change: `cancelled` for a queued or running job of this process,
   * `interrupted` for a stale orphan of a dead process, and the unchanged final record for a job that had already
   * finished — a finished job is not an error to the caller, it is just nothing to do.
   */
  cancel(id: string): JobRecord {
    const job = this.store.load(id)
    if (!job) throw new OllosError('JOB_NOT_FOUND', `no job ${id}`)
    const ctrl = this.controllers.get(id)
    if (ctrl) {
      ctrl.abort()
      // execute()'s catch writes the same status once the pipeline unwinds; writing it now means the caller
      // never sees "running" on the record that comes back from a cancel
      const fresh = this.store.load(id)!
      if (fresh.status === 'running' || fresh.status === 'queued') {
        fresh.status = 'cancelled'
        fresh.finishedAt = new Date().toISOString()
        fresh.error = { code: 'CANCELLED', message: 'cancelled by request' }
        this.store.save(fresh)
      }
      return fresh
    }
    if (job.status === 'queued' || job.status === 'running') {
      const stale = this.refreshIfStale(job)
      if (stale.status !== job.status) return stale
      if (job.status === 'queued') {
        job.status = 'cancelled'
        job.finishedAt = new Date().toISOString()
        job.error = { code: 'CANCELLED', message: 'cancelled by request' }
        this.store.save(job)
        return job
      }
      throw new OllosError('JOB_NOT_CANCELLABLE', `job ${id} is running in another ollos process`, { hint: 'Cancel it from the process that started it, or wait for its heartbeat to go stale.' })
    }
    return job
  }

  /** Estimate without submitting. Resolves the source (a URL is downloaded) — prefer the etaSeconds a submission returns. */
  async estimate(kind: string, params: unknown, signal?: AbortSignal): Promise<number> {
    const def = this.defs.get(kind)
    if (!def) throw new OllosError('INVALID_ARGUMENT', `unknown job kind "${kind}"`)
    const pre = def.prepare ? await def.prepare(params, signal ?? new AbortController().signal) : undefined
    return def.estimateSeconds(params, pre)
  }

  private async execute<P, R>(def: JobDefinition<P, R>, job: JobRecord<P>, ctrl: AbortController, pre: unknown): Promise<void> {
    const cls = typeof def.resourceClass === 'function' ? def.resourceClass(job.params) : def.resourceClass
    const release = await this.sems.get(cls)!.acquire()
    let heartbeat: NodeJS.Timeout | undefined
    const t0 = Date.now()

    const current = this.store.load(job.id)!
    if (current.status !== 'queued') {
      // cancelled while waiting for a slot
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
      // A throw inside a timer is an uncaughtException that takes the whole server down. Verified: a renameSync over a
      // job.json another process had open threw EPERM. The heartbeat is best effort; a missed beat is reported, not fatal.
      let lastHeartbeatWarning = 0
      heartbeat = setInterval(() => {
        try {
          const j = this.store.load(job.id)
          if (j && j.status === 'running') {
            j.heartbeatAt = new Date().toISOString()
            this.store.save(j)
          }
        } catch (e) {
          if (Date.now() - lastHeartbeatWarning > 60_000) {
            lastHeartbeatWarning = Date.now()
            try {
              this.store.appendEvent(job.id, { ts: new Date().toISOString(), stage: 'heartbeat', event: 'info', message: `heartbeat write failed: ${(e as Error).message}` })
            } catch {
              /* the disk is the problem; nothing else to do */
            }
          }
        }
      }, this.config.heartbeatMs)

      const ctx: JobContext = {
        jobId: job.id,
        signal: ctrl.signal,
        artifactsDir: this.store.ensureArtifactsDir(job.id),
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
      const result = await def.run(job.params, ctx, pre)
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
