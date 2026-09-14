import os from 'node:os'
import path from 'node:path'

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
  ffmpegPath?: string
  ffprobePath?: string
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (!v) return fallback
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
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
      vision: envInt('OLLOS_CONCURRENCY_VISION', 2),
      ocr: envInt('OLLOS_CONCURRENCY_OCR', 2),
      download: envInt('OLLOS_CONCURRENCY_DOWNLOAD', 2),
      light: 4,
    },
    limits: {
      maxDownloadBytes: envInt('OLLOS_MAX_DOWNLOAD_MB', 2048) * 1024 * 1024,
      maxDurationSec: envInt('OLLOS_MAX_DURATION_SEC', 4 * 3600),
      maxFrames: envInt('OLLOS_MAX_FRAMES', 500),
      maxRedirects: 5,
      responseTokenBudget: envInt('OLLOS_RESPONSE_TOKENS', 20_000),
      inlineThresholdSec: envInt('OLLOS_INLINE_THRESHOLD_SEC', 8),
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
