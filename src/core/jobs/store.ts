import fs from 'node:fs'
import path from 'node:path'
import { dirs, type OllosConfig } from '../config.js'
import { ensureDir, exists, readJSON, writeJSONAtomic } from '../paths.js'
import type { JobEvent, JobRecord } from './types.js'

/**
 * Jobs live on disk, one folder each. The process can die at any point and a `tasks/get` still answers.
 * job.json is always written atomically; events.ndjson is append-only.
 */
export class JobStore {
  readonly root: string
  constructor(config: OllosConfig) {
    this.root = ensureDir(dirs.jobs(config))
  }

  dir(id: string): string {
    return path.join(this.root, id)
  }

  artifactsDir(id: string): string {
    return ensureDir(path.join(this.dir(id), 'artifacts'))
  }

  save(job: JobRecord): void {
    job.updatedAt = new Date().toISOString()
    writeJSONAtomic(path.join(this.dir(job.id), 'job.json'), job)
  }

  load(id: string): JobRecord | undefined {
    const p = path.join(this.dir(id), 'job.json')
    return exists(p) ? readJSON<JobRecord>(p) : undefined
  }

  saveResult(id: string, result: unknown): string {
    const p = path.join(this.dir(id), 'result.json')
    writeJSONAtomic(p, result)
    return p
  }

  loadResult<R>(id: string): R | undefined {
    const p = path.join(this.dir(id), 'result.json')
    return exists(p) ? readJSON<R>(p) : undefined
  }

  appendEvent(id: string, e: JobEvent): void {
    fs.appendFileSync(path.join(ensureDir(this.dir(id)), 'events.ndjson'), JSON.stringify(e) + '\n')
  }

  readEvents(id: string): JobEvent[] {
    const p = path.join(this.dir(id), 'events.ndjson')
    if (!exists(p)) return []
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as JobEvent)
  }

  list(): JobRecord[] {
    if (!exists(this.root)) return []
    return fs
      .readdirSync(this.root)
      .map((id) => this.load(id))
      .filter((j): j is JobRecord => !!j)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  remove(id: string): void {
    fs.rmSync(this.dir(id), { recursive: true, force: true })
  }
}
