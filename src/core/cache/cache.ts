import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dirs, type OllosConfig } from '../config.js'
import { ensureDir, exists, readJSON, writeJSONAtomic } from '../paths.js'

const FULL_HASH_LIMIT = 64 * 1024 * 1024

/**
 * Identity of a local media file. Cheap by default (size + mtime + path), exact for small files.
 * Two calls about the same file must land on the same key or the cache is useless in agent loops.
 */
export function fileIdentity(file: string): string {
  const st = fs.statSync(file)
  if (st.size <= FULL_HASH_LIMIT) {
    const h = crypto.createHash('sha256')
    h.update(fs.readFileSync(file))
    return 'c_' + h.digest('hex').slice(0, 24)
  }
  const h = crypto.createHash('sha1')
  h.update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}`)
  return 'f_' + h.digest('hex').slice(0, 24)
}

export function hashOf(...parts: unknown[]): string {
  const h = crypto.createHash('sha1')
  h.update(JSON.stringify(parts))
  return h.digest('hex').slice(0, 20)
}

export class Cache {
  readonly root: string
  constructor(private readonly config: OllosConfig) {
    this.root = ensureDir(dirs.cache(config))
  }

  /** Deterministic path for a namespaced key, e.g. cache/transcript/ab12…/result.json */
  pathFor(namespace: string, key: string, filename = 'result.json'): string {
    return path.join(ensureDir(path.join(this.root, namespace, key)), filename)
  }

  getJSON<T>(namespace: string, key: string): T | undefined {
    const p = this.pathFor(namespace, key)
    return exists(p) ? readJSON<T>(p) : undefined
  }

  setJSON(namespace: string, key: string, value: unknown): string {
    const p = this.pathFor(namespace, key)
    writeJSONAtomic(p, value)
    return p
  }

  has(namespace: string, key: string, filename = 'result.json'): boolean {
    return exists(path.join(this.root, namespace, key, filename))
  }

  dir(namespace: string, key: string): string {
    return ensureDir(path.join(this.root, namespace, key))
  }
}
