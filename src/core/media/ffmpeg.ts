import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { OllosError } from '../errors.js'
import type { OllosConfig } from '../config.js'

const require = createRequire(import.meta.url)

function fromPath(bin: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, bin + ext)
      if (fs.existsSync(p)) return p
    }
  }
  return undefined
}

function fromStaticPackage(name: 'ffmpeg-static' | 'ffprobe-static'): string | undefined {
  try {
    const mod = require(name)
    const p: unknown = name === 'ffprobe-static' ? (mod?.path ?? mod?.default?.path) : (mod?.default ?? mod)
    return typeof p === 'string' && fs.existsSync(p) ? p : undefined
  } catch {
    return undefined
  }
}

let resolved: { ffmpeg: string; ffprobe: string | undefined } | undefined

/**
 * Binary resolution order: explicit env/config → system PATH → bundled static package.
 * System first, because a user with ffmpeg installed expects their version; static is the "just works" fallback.
 */
export function resolveBinaries(config: OllosConfig): { ffmpeg: string; ffprobe: string | undefined } {
  if (resolved) return resolved
  const ffmpeg = config.ffmpegPath ?? fromPath('ffmpeg') ?? fromStaticPackage('ffmpeg-static')
  if (!ffmpeg) {
    throw new OllosError('FFMPEG_MISSING', 'ffmpeg was not found', {
      hint: 'Install ffmpeg (winget install ffmpeg / brew install ffmpeg / apt install ffmpeg) or reinstall ollos-mcp so ffmpeg-static can download its binary. You can also set OLLOS_FFMPEG=/path/to/ffmpeg.',
    })
  }
  const ffprobe = config.ffprobePath ?? fromPath('ffprobe') ?? fromStaticPackage('ffprobe-static')
  resolved = { ffmpeg, ffprobe }
  return resolved
}

export interface RunResult {
  stdout: Buffer
  stderr: string
  code: number
}

export interface RunOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Called with every stderr chunk (ffmpeg prints progress there). */
  onStderr?: (chunk: string) => void
}

/** Run a binary, collect stdout as a Buffer, and fail loudly with the stderr tail when the exit code is non-zero. */
export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    let timer: NodeJS.Timeout | undefined

    const finish = (fn: () => void) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => {
      child.kill('SIGKILL')
      finish(() => reject(new OllosError('CANCELLED', `${path.basename(bin)} was cancelled`)))
    }
    if (opts.signal) {
      if (opts.signal.aborted) return onAbort()
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(() => reject(new OllosError('FFMPEG_FAILED', `${path.basename(bin)} timed out after ${opts.timeoutMs} ms`)))
      }, opts.timeoutMs)
    }

    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString('utf8')
      err += s
      if (err.length > 64_000) err = err.slice(-32_000)
      opts.onStderr?.(s)
    })
    child.on('error', (e) => finish(() => reject(new OllosError('FFMPEG_FAILED', `could not start ${path.basename(bin)}: ${e.message}`, { cause: e }))))
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          return reject(
            new OllosError('FFMPEG_FAILED', `${path.basename(bin)} exited with code ${code}`, {
              details: { args, stderrTail: err.slice(-2_000) },
              hint: 'The stderr tail is in details. Most often the file is not a media file, is truncated, or the codec is unsupported.',
            }),
          )
        }
        resolve({ stdout: Buffer.concat(out), stderr: err, code: 0 })
      })
    })
  })
}

/** Parse "00:01:30.5", "1:30", "90", "90.25" into seconds. */
export function parseTime(t: string | number | undefined): number | undefined {
  if (t === undefined || t === null || t === '') return undefined
  if (typeof t === 'number') return t
  const parts = t.trim().split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) throw new OllosError('INVALID_ARGUMENT', `invalid time "${t}"`, { hint: 'Use seconds ("90"), mm:ss ("1:30") or hh:mm:ss.ms ("0:01:30.5").' })
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = r.toFixed(1).padStart(4, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
