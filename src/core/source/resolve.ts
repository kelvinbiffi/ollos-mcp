import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { Readable } from 'node:stream'
import { OllosError } from '../errors.js'
import type { OllosConfig } from '../config.js'
import { probe, type MediaInfo } from '../media/probe.js'
import { assertPublicHost } from './ssrf.js'
import { Cache, fileIdentity } from '../cache/cache.js'
import { run } from '../media/ffmpeg.js'

export type SourceOrigin = 'local' | 'folder' | 'url' | 'site' | 'data'

export interface ZoomTrack {
  participant: string
  file: string
}

export interface ResolvedSource {
  /** Local file to feed to ffmpeg. For a Zoom folder, the mixed recording. */
  path: string
  origin: SourceOrigin
  input: string
  identity: string
  info: MediaInfo
  /** Per-participant audio files when the source is a Zoom local recording with separate tracks. */
  zoomTracks?: ZoomTrack[]
}

const SITE_HOSTS = /(^|\.)(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|vimeo\.com|twitter\.com|x\.com|facebook\.com|twitch\.tv|loom\.com|grain\.com)$/i
const MEDIA_EXT = /\.(mp4|mkv|mov|webm|m4v|avi|mp3|m4a|wav|flac|ogg|opus|aac|png|jpg|jpeg|webp|gif)$/i

function ytDlpBinary(config: OllosConfig): string | undefined {
  if (config.ytDlpPath && fs.existsSync(config.ytDlpPath)) return config.ytDlpPath
  const exts = process.platform === 'win32' ? ['.exe', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) for (const ext of exts) {
    const p = path.join(dir, 'yt-dlp' + ext)
    if (fs.existsSync(p)) return p
  }
  return undefined
}

/** Zoom local recordings with "Record a separate audio file for each participant" produce an `Audio Record/` folder, one file per person, named after them. */
function detectZoomFolder(dir: string): { mixed: string; tracks: ZoomTrack[] } | undefined {
  const entries = fs.readdirSync(dir)
  const audioRecord = entries.find((e) => /^audio record$/i.test(e))
  if (!audioRecord) return undefined
  const trackDir = path.join(dir, audioRecord)
  const tracks: ZoomTrack[] = fs
    .readdirSync(trackDir)
    .filter((f) => /\.(m4a|mp3|wav)$/i.test(f))
    .map((f) => ({ participant: f.replace(/^audio/i, '').replace(/\d+\.(m4a|mp3|wav)$/i, '').replace(/[_-]+/g, ' ').trim() || path.parse(f).name, file: path.join(trackDir, f) }))
  const mixed = entries.filter((e) => /\.(mp4|m4a)$/i.test(e)).map((e) => path.join(dir, e)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
  if (!mixed || tracks.length === 0) return undefined
  return { mixed, tracks }
}

async function downloadDirect(url: URL, config: OllosConfig, cache: Cache, signal?: AbortSignal): Promise<string> {
  if (!config.allowPrivateAddresses) {
    try {
      await assertPublicHost(url.hostname)
    } catch (e) {
      throw new OllosError('PRIVATE_ADDRESS_BLOCKED', (e as Error).message, { hint: 'Set OLLOS_ALLOW_PRIVATE=1 if you really mean to fetch from a private network.' })
    }
  }
  const key = crypto.createHash('sha1').update(url.toString()).digest('hex').slice(0, 24)
  const dir = cache.dir('download', key)
  const existing = fs.readdirSync(dir).find((f) => isFinishedDownload(f))
  if (existing) return path.join(dir, existing)

  const res = await fetchFollowingRedirects(url, config, signal)
  if (!res.ok || !res.body) throw new OllosError('DOWNLOAD_FAILED', `HTTP ${res.status} from ${url.hostname}`)
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > config.limits.maxDownloadBytes) throw new OllosError('DOWNLOAD_TOO_LARGE', `file is ${Math.round(declared / 1e6)} MB, limit is ${Math.round(config.limits.maxDownloadBytes / 1e6)} MB`, { hint: 'Raise OLLOS_MAX_DOWNLOAD_MB or download the file yourself and pass the local path.' })
  const ct = res.headers.get('content-type') ?? ''
  const ext = ct.includes('mp4') ? '.mp4' : ct.includes('webm') ? '.webm' : ct.includes('mpeg') ? '.mp3' : ct.includes('wav') ? '.wav' : ct.includes('png') ? '.png' : ct.includes('jpeg') ? '.jpg' : path.extname(url.pathname) || '.bin'
  const tmp = path.join(dir, `media${ext}.part`)
  let received = 0
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length
      if (received > config.limits.maxDownloadBytes) return cb(new OllosError('DOWNLOAD_TOO_LARGE', 'download exceeded the size limit mid-stream'))
      cb(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(res.body as never), limiter, fs.createWriteStream(tmp))
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e instanceof OllosError ? e : new OllosError('DOWNLOAD_FAILED', (e as Error).message, { cause: e })
  }
  const final = tmp.replace(/\.part$/, '')
  fs.renameSync(tmp, final)
  return final
}

/** `media.mp4` yes; `media.mp4.part`, yt-dlp's `media.f137.mp4` (video-only, pre-merge) and `.ytdl` state files no. */
function isFinishedDownload(name: string): boolean {
  return /^media\.[a-z0-9]+$/i.test(name)
}

/**
 * fetch() with `redirect: 'follow'` would happily follow a public host to http://169.254.169.254/… — the SSRF guard
 * checked only the hostname the user typed. Follow redirects by hand, re-assert every hop, and bound the count.
 * DNS is still resolved separately by the guard and by undici (a rebinding window remains); the guard narrows it,
 * it does not close it — documented in SECURITY.md.
 */
async function fetchFollowingRedirects(start: URL, config: OllosConfig, signal?: AbortSignal): Promise<Response> {
  let url = start
  for (let hop = 0; ; hop++) {
    if (hop > 0 && !config.allowPrivateAddresses) {
      try {
        await assertPublicHost(url.hostname)
      } catch (e) {
        throw new OllosError('PRIVATE_ADDRESS_BLOCKED', `redirect to ${url.hostname} refused: ${(e as Error).message}`, { hint: 'Set OLLOS_ALLOW_PRIVATE=1 if you really mean to fetch from a private network.' })
      }
    }
    let res: Response
    try {
      res = await fetch(url, { redirect: 'manual', signal })
    } catch (e) {
      throw new OllosError('DOWNLOAD_FAILED', `could not fetch ${url.hostname}: ${(e as Error).message}`, { cause: e })
    }
    const location = res.headers.get('location')
    if (res.status < 300 || res.status >= 400 || !location) return res
    await res.body?.cancel().catch(() => {})
    if (hop >= config.limits.maxRedirects) throw new OllosError('DOWNLOAD_FAILED', `more than ${config.limits.maxRedirects} redirects from ${start.hostname}`)
    const next = new URL(location, url)
    if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new OllosError('DOWNLOAD_FAILED', `redirect to unsupported scheme ${next.protocol}`)
    url = next
  }
}

async function downloadSite(url: URL, config: OllosConfig, cache: Cache, opts: { cookiesFile?: string; ytDlpArgs?: string[]; signal?: AbortSignal }): Promise<string> {
  const bin = ytDlpBinary(config)
  if (!bin) {
    throw new OllosError('YTDLP_MISSING', `downloading from ${url.hostname} needs yt-dlp, which was not found`, {
      hint: 'Install yt-dlp (winget install yt-dlp / brew install yt-dlp / pipx install yt-dlp) or set OLLOS_YTDLP=/path/to/yt-dlp. Or download the video yourself and pass the local file. Site downloads are best-effort: platforms change often.',
    })
  }
  const key = crypto.createHash('sha1').update(url.toString()).digest('hex').slice(0, 24)
  const dir = cache.dir('download', key)
  const existing = fs.readdirSync(dir).find((f) => isFinishedDownload(f))
  if (existing) return path.join(dir, existing)
  // yt-dlp leaves .part/.ytdl/.fNNN intermediates when killed; they must never be mistaken for the download.
  // It works in a private temp dir and only the merged file moves into the cache slot, atomically.
  const work = fs.mkdtempSync(path.join(dir, '.ytdlp-'))
  // Allow-list: flags that tune the download. Never `--exec`, `--config-location`, `--paths` or anything that runs code or writes elsewhere.
  const withValue = new Set(['--cookies-from-browser', '--proxy', '--format', '-f', '--extractor-args', '--user-agent', '--referer', '--sleep-requests', '--limit-rate', '--js-runtimes', '--remote-components'])
  const flags = new Set(['--no-check-certificates', '--force-ipv4', '--force-ipv6', '--legacy-server-connect'])
  const filterArgs = (list: string[]) => list.filter((a, i, arr) => withValue.has(a) || flags.has(a) || (i > 0 && withValue.has(arr[i - 1]!)))
  const extra = [...filterArgs(config.ytDlpArgs), ...filterArgs(opts.ytDlpArgs ?? [])]
  const args = ['--no-playlist', '--no-progress', '--no-warnings', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4', '-o', path.join(work, 'media.%(ext)s'), ...(opts.cookiesFile ? ['--cookies', opts.cookiesFile] : []), ...extra, url.toString()]
  try {
    await run(bin, args, { signal: opts.signal, timeoutMs: 30 * 60_000 })
    const got = fs.readdirSync(work).find((f) => isFinishedDownload(f))
    if (!got) throw new OllosError('YTDLP_FAILED', 'yt-dlp finished but produced no file')
    const final = path.join(dir, got)
    fs.renameSync(path.join(work, got), final)
    return final
  } catch (e) {
    if (e instanceof OllosError && e.code !== 'FFMPEG_FAILED') throw e
    const tail = (e as OllosError).details?.stderrTail as string | undefined
    throw new OllosError('YTDLP_FAILED', `yt-dlp could not download from ${url.hostname}`, {
      details: { stderrTail: tail },
      hint: 'yt-dlp breaks whenever a platform changes. Try updating it (yt-dlp -U), setting OLLOS_YTDLP_ARGS (e.g. "--no-check-certificates" behind a TLS-intercepting proxy, "--js-runtimes node" for full YouTube format lists, "--cookies-from-browser chrome" for login-gated content), or download the file yourself and pass the local path.',
    })
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

export interface ResolveOptions {
  cookiesFile?: string
  ytDlpArgs?: string[]
  signal?: AbortSignal
}

/**
 * Turn whatever the caller gave us into a local file we know the true type of.
 * Accepts a path, a folder (Zoom layout), a direct media URL, a video-site URL, or a data: URI.
 */
export async function resolveSource(input: string, config: OllosConfig, opts: ResolveOptions = {}): Promise<ResolvedSource> {
  const cache = new Cache(config)
  // file:///C:/x must become C:\\x, not C:\\C:\\x: let Node decode the URL
  const trimmed = /^file:\/\//i.test(input.trim()) ? fileURLToPath(input.trim()) : input.trim()
  const src = await resolveAny(trimmed, config, cache, opts)
  // the same limit for every origin: a 6-hour livestream URL is not more welcome than a 6-hour local file
  if (src.info.durationSec > config.limits.maxDurationSec) {
    throw new OllosError('DURATION_EXCEEDED', `media is ${Math.round(src.info.durationSec / 60)} min, limit is ${Math.round(config.limits.maxDurationSec / 60)} min`, { hint: 'Use from/to to analyse a window, or raise OLLOS_MAX_DURATION_SEC.' })
  }
  return src
}

async function resolveAny(trimmed: string, config: OllosConfig, cache: Cache, opts: ResolveOptions): Promise<ResolvedSource> {

  if (trimmed.startsWith('data:')) {
    const m = trimmed.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
    if (!m) throw new OllosError('SOURCE_UNSUPPORTED', 'malformed data: URI')
    const buf = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8')
    const key = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 24)
    const file = path.join(cache.dir('data', key), 'media.bin')
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf)
    const info = await probe(file, config)
    return { path: file, origin: 'data', input: '(data URI)', identity: fileIdentity(file), info }
  }

  let url: URL | undefined
  try {
    if (/^https?:\/\//i.test(trimmed)) url = new URL(trimmed)
  } catch {
    /* not a URL */
  }
  if (url) {
    const isSite = SITE_HOSTS.test(url.hostname) && !MEDIA_EXT.test(url.pathname)
    const file = isSite ? await downloadSite(url, config, cache, opts) : await downloadDirect(url, config, cache, opts.signal)
    const info = await probe(file, config)
    return { path: file, origin: isSite ? 'site' : 'url', input: trimmed, identity: fileIdentity(file), info }
  }

  const abs = path.resolve(trimmed)
  if (!fs.existsSync(abs)) {
    throw new OllosError('SOURCE_NOT_FOUND', `no file or folder at ${abs}`, { hint: 'Pass an absolute path, an http(s) URL, or a data: URI.' })
  }
  const st = fs.statSync(abs)
  if (st.isDirectory()) {
    const zoom = detectZoomFolder(abs)
    if (!zoom) throw new OllosError('SOURCE_UNSUPPORTED', `${abs} is a folder but not a Zoom local recording`, { hint: 'Folders are only accepted when they contain a Zoom "Audio Record" subfolder with one file per participant. Otherwise pass the media file itself.' })
    const info = await probe(zoom.mixed, config)
    return { path: zoom.mixed, origin: 'folder', input: abs, identity: fileIdentity(zoom.mixed), info, zoomTracks: zoom.tracks }
  }
  const info = await probe(abs, config)
  return { path: abs, origin: 'local', input: abs, identity: fileIdentity(abs), info }
}

/** Fail before any work starts when the task cannot apply to what the file actually is. */
export function assertKindSupports(info: MediaInfo, task: string): void {
  const needsAudio = new Set(['transcribe', 'diarize', 'loudness', 'silences'])
  const needsVideo = new Set(['keyframes', 'aspect'])
  if (needsAudio.has(task) && !info.audio) throw new OllosError('UNSUPPORTED_TASK_FOR_KIND', `${task} needs an audio stream and this ${info.kind} has none`)
  if (needsVideo.has(task) && info.kind !== 'video') throw new OllosError('UNSUPPORTED_TASK_FOR_KIND', `${task} needs video and this is ${info.kind}`)
}
