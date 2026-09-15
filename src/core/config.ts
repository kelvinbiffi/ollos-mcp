import os from 'node:os'
import path from 'node:path'
import { OllosError } from './errors.js'

/** Resource classes control how many jobs of a kind may run at once. ASR is 1 by measurement: two Whisper sessions on the same CPU run slower than one. */
export type ResourceClass = 'asr' | 'vision' | 'ocr' | 'download' | 'light'

export interface OllosConfig {
  home: string
  offline: boolean
  allowPrivateAddresses: boolean
  concurrency: Record<ResourceClass, number>
  limits: {
    maxDownloadBytes: number
    maxDurationSec: number
    maxFrames: number
    maxRedirects: number
    responseTokenBudget: number
    inlineThresholdSec: number
  }
  models: {
    asrAccurate: string
    asrFast: string
    vad: string
    segmentation: string
    speaker: string
    textEmbedding: string
  }
  heartbeatMs: number
  staleAfterMs: number
  ytDlpPath?: string
  /** Extra yt-dlp flags applied to every site download, e.g. `--no-check-certificates --js-runtimes node` behind a TLS-intercepting proxy. Filtered through the same allow-list as per-call `ytDlpArgs`. */
  ytDlpArgs: string[]
  ffmpegPath?: string
  ffprobePath?: string
}

/**
 * Integer from the environment, or the fallback when unset. A set-but-invalid value is a configuration error and
 * must not silently become the default: `OLLOS_MAX_DOWNLOAD_MB=0` used to mean 2048, which nobody who wrote 0 wanted.
 * `min` says whether 0 is meaningful for this knob (0 for the inline threshold means "never inline"; 0 workers is not a pool).
 */
function envInt(name: string, fallback: number, min: number): number {
  const v = process.env[name]
  if (v === undefined || v.trim() === '') return fallback
  const n = Number(v)
  if (!Number.isInteger(n) || n < min) {
    throw new OllosError('INVALID_ARGUMENT', `${name}="${v}" is not an integer >= ${min}`, { hint: `Unset ${name} to use the default (${fallback}) or give it a whole number of at least ${min}.` })
  }
  return n
}

function envBool(name: string): boolean {
  const v = process.env[name]
  return v === '1' || v === 'true' || v === 'yes'
}

export function loadConfig(overrides: Partial<OllosConfig> = {}): OllosConfig {
  const home = process.env.OLLOS_HOME ?? path.join(os.homedir(), '.ollos')
  const base: OllosConfig = {
    home,
    offline: envBool('OLLOS_OFFLINE'),
    allowPrivateAddresses: envBool('OLLOS_ALLOW_PRIVATE'),
    concurrency: {
      asr: 1,
      vision: envInt('OLLOS_CONCURRENCY_VISION', 2, 1),
      ocr: envInt('OLLOS_CONCURRENCY_OCR', 2, 1),
      download: envInt('OLLOS_CONCURRENCY_DOWNLOAD', 2, 1),
      light: 4,
    },
    limits: {
      maxDownloadBytes: envInt('OLLOS_MAX_DOWNLOAD_MB', 2048, 1) * 1024 * 1024,
      maxDurationSec: envInt('OLLOS_MAX_DURATION_SEC', 4 * 3600, 1),
      maxFrames: envInt('OLLOS_MAX_FRAMES', 500, 1),
      maxRedirects: 5,
      responseTokenBudget: envInt('OLLOS_RESPONSE_TOKENS', 20_000, 1),
      inlineThresholdSec: envInt('OLLOS_INLINE_THRESHOLD_SEC', 8, 0),
    },
    models: {
      asrAccurate: 'onnx-community/whisper-large-v3-turbo',
      asrFast: 'Xenova/whisper-base',
      vad: 'onnx-community/silero-vad',
      segmentation: 'onnx-community/pyannote-segmentation-3.0',
      speaker: 'onnx-community/wespeaker-voxceleb-resnet34-LM',
      textEmbedding: 'Xenova/multilingual-e5-small',
    },
    heartbeatMs: 5_000,
    staleAfterMs: 30_000,
    ytDlpPath: process.env.OLLOS_YTDLP,
    ytDlpArgs: (process.env.OLLOS_YTDLP_ARGS ?? '').split(/\s+/).filter(Boolean),
    ffmpegPath: process.env.OLLOS_FFMPEG,
    ffprobePath: process.env.OLLOS_FFPROBE,
  }
  return { ...base, ...overrides, limits: { ...base.limits, ...overrides.limits }, concurrency: { ...base.concurrency, ...overrides.concurrency }, models: { ...base.models, ...overrides.models } }
}

export const dirs = {
  jobs: (c: OllosConfig) => path.join(c.home, 'jobs'),
  cache: (c: OllosConfig) => path.join(c.home, 'cache'),
  models: (c: OllosConfig) => path.join(c.home, 'models'),
  index: (c: OllosConfig) => path.join(c.home, 'index'),
}
