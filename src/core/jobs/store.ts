import fs from 'node:fs'
import path from 'node:path'
import { dirs, type OllosConfig } from '../config.js'
import { OllosError } from '../errors.js'
import { ensureDir, exists, readJSON, writeJSONAtomic } from '../paths.js'
import type { JobEvent, JobRecord } from './types.js'

/** Job ids are `j_` + 12 hex chars, minted by the engine. Anything else never reaches the filesystem. */
export const JOB_ID = /^j_[0-9a-f]{12}$/

/**
 * Ids arrive from MCP clients inside resource URIs and tool arguments. The SDK's URI-template matcher passes `..`
 * and backslashes through undecoded, and path.join would happily collapse `j_..\\..\\x` into a path outside
 * $OLLOS_HOME. Validating the shape closes that whole class: a job id is a filename, never a path.
 */
export function assertJobId(id: string): string {
  if (typeof id !== 'string' || !JOB_ID.test(id)) {
    throw new OllosError('JOB_NOT_FOUND', `no job ${String(id).slice(0, 40)}`, { hint: 'jobIds look like j_a1b2c3d4e5f6 and come from a previous ollos tool call.' })
  }
  return id
}

/**
 * Jobs live on disk, one folder each. The process can die at any point and `ollos_job` still answers.
 * job.json is always written atomically; events.ndjson is append-only. Read paths never create directories.
 */
export class JobStore {
  readonly root: string
  constructor(config: OllosConfig) {
    this.root = ensureDir(dirs.jobs(config))
  }

  dir(id: string): string {
    return path.join(this.root, assertJobId(id))
  }

  /** Where a job's files live. Does not create it: resources read from here with client-supplied ids. */
  artifactsDir(id: string): string {
    return path.join(this.dir(id), 'artifacts')
  }

  /** Same path, created. Only the engine calls this, for the job it is about to run. */
  ensureArtifactsDir(id: string): string {
    return ensureDir(this.artifactsDir(id))
  }

  save(job: JobRecord): void {
    job.updatedAt = new Date().toISOString()
    writeJSONAtomic(path.join(this.dir(job.id), 'job.json'), job)
  }

  /** Malformed ids are simply unknown jobs on read paths; only writes and artifact paths throw. */
  load(id: string): JobRecord | undefined {
    if (!JOB_ID.test(id)) return undefined
    const p = path.join(this.dir(id), 'job.json')
    return exists(p) ? readJSON<JobRecord>(p) : undefined
  }

  saveResult(id: string, result: unknown): string {
    const p = path.join(this.dir(id), 'result.json')
    writeJSONAtomic(p, result)
    return p
  }

  loadResult<R>(id: string): R | undefined {
    if (!JOB_ID.test(id)) return undefined
    const p = path.join(this.dir(id), 'result.json')
    return exists(p) ? readJSON<R>(p) : undefined
  }

  appendEvent(id: string, e: JobEvent): void {
    fs.appendFileSync(path.join(ensureDir(this.dir(id)), 'events.ndjson'), JSON.stringify(e) + '\n')
  }

  readEvents(id: string): JobEvent[] {
    if (!JOB_ID.test(id)) return []
    const p = path.join(this.dir(id), 'events.ndjson')
    if (!exists(p)) return []
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as JobEvent)
  }

  list(): JobRecord[] {
    if (!exists(this.root)) return []
    return fs
      .readdirSync(this.root)
      .filter((id) => JOB_ID.test(id))
      .map((id) => this.load(id))
      .filter((j): j is JobRecord => !!j)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  remove(id: string): void {
    fs.rmSync(this.dir(id), { recursive: true, force: true })
  }
}
