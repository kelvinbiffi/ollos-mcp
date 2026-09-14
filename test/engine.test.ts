import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/core/config.js'
import { JobEngine } from '../src/core/jobs/engine.js'

const home = path.resolve('.ollos-test-engine')

function fresh() {
  fs.rmSync(home, { recursive: true, force: true })
  const config = loadConfig({ home, limits: { inlineThresholdSec: 1 } as never })
  return { config, engine: new JobEngine(config) }
}

describe('job engine', () => {
  beforeEach(() => fs.rmSync(home, { recursive: true, force: true }))
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it('runs small work inline and returns the result directly', async () => {
    const { engine } = fresh()
    engine.register<{ n: number }, number>({ kind: 'double', resourceClass: 'light', estimateSeconds: () => 0.1, run: async (p) => p.n * 2 })
    const { job, result } = await engine.submit<{ n: number }, number>('double', { n: 21 })
    expect(job.status).toBe('completed')
    expect(result).toBe(42)
    expect(fs.existsSync(path.join(home, 'jobs', job.id, 'result.json'))).toBe(true)
  })

  it('queues large work, reports progress, and can be awaited', async () => {
    const { engine } = fresh()
    engine.register<Record<string, never>, string>({
      kind: 'slow',
      resourceClass: 'light',
      estimateSeconds: () => 100,
      run: async (_p, ctx) => {
        ctx.progress('half', 0.5, 'halfway')
        await new Promise((r) => setTimeout(r, 60))
        return 'ok'
      },
    })
    const { job, result } = await engine.submit<Record<string, never>, string>('slow', {})
    expect(job.status).toBe('queued')
    expect(result).toBeUndefined()
    const done = await engine.wait<string>(job.id)
    expect(done.job.status).toBe('completed')
    expect(done.result).toBe('ok')
    expect(engine.store.readEvents(job.id).map((e) => e.event)).toContain('end')
  })

  it('records failures with the error code and hint', async () => {
    const { engine } = fresh()
    engine.register({ kind: 'boom', resourceClass: 'light', estimateSeconds: () => 0.1, run: async () => { throw new Error('nope') } })
    const { job } = await engine.submit('boom', {})
    expect(job.status).toBe('failed')
    expect(job.error?.message).toBe('nope')
  })

  it('cancels a running job through its AbortSignal', async () => {
    const { engine } = fresh()
    engine.register<Record<string, never>, string>({
      kind: 'forever',
      resourceClass: 'light',
      estimateSeconds: () => 100,
      run: (_p, ctx) => new Promise((_res, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted')))),
    })
    const { job } = await engine.submit('forever', {})
    await new Promise((r) => setTimeout(r, 30))
    engine.cancel(job.id)
    const done = await engine.wait(job.id)
    expect(done.job.status).toBe('cancelled')
  })

  it('serialises jobs of the same resource class (asr = 1)', async () => {
    const { engine } = fresh()
    let concurrent = 0
    let peak = 0
    engine.register<Record<string, never>, null>({
      kind: 'asr-ish',
      resourceClass: 'asr',
      estimateSeconds: () => 100,
      run: async () => {
        concurrent++
        peak = Math.max(peak, concurrent)
        await new Promise((r) => setTimeout(r, 40))
        concurrent--
        return null
      },
    })
    const jobs = await Promise.all([engine.submit('asr-ish', {}), engine.submit('asr-ish', {}), engine.submit('asr-ish', {})])
    await Promise.all(jobs.map((j) => engine.wait(j.job.id)))
    expect(peak).toBe(1)
  })

  it('marks orphaned running jobs as interrupted on startup', async () => {
    const { config, engine } = fresh()
    const store = engine.store
    const id = 'j_orphan'
    store.save({ schemaVersion: 1, id, kind: 'x', params: {}, status: 'running', progress: { stage: 'asr', fraction: 0.4, message: '' }, createdAt: new Date(Date.now() - 120_000).toISOString(), updatedAt: '', heartbeatAt: new Date(Date.now() - 120_000).toISOString() })
    const engine2 = new JobEngine(config)
    const j = engine2.get(id)!
    expect(j.status).toBe('interrupted')
    expect(j.error?.code).toBe('INTERRUPTED')
  })
})
