import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let cachedRoot: string | undefined

/** Package root, found by walking up from this file until package.json. Works from src/ (tsx) and dist/ (built). */
export function packageRoot(): string {
  if (cachedRoot) return cachedRoot
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      cachedRoot = dir
      return dir
    }
    dir = path.dirname(dir)
  }
  throw new Error('ollos: could not locate package root')
}

export function assetPath(...parts: string[]): string {
  return path.join(packageRoot(), 'assets', ...parts)
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Atomic file write: write to a temp sibling then rename. Rename on the same volume is atomic, so readers never see a half-written file. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

export function readJSON<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

export function writeJSONAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2))
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}
