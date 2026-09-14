import { resolveBinaries, run } from './ffmpeg.js'
import type { OllosConfig } from '../config.js'

export const ASR_SAMPLE_RATE = 16_000

export interface Window {
  fromSec?: number
  toSec?: number
}

function windowArgs(w: Window | undefined): string[] {
  const args: string[] = []
  if (w?.fromSec !== undefined) args.push('-ss', String(w.fromSec))
  if (w?.toSec !== undefined) args.push('-to', String(w.toSec))
  return args
}

/**
 * Decode to what every speech model wants: 16 kHz, mono, float32 PCM, straight from ffmpeg's stdout.
 * No temp file, no WAV header to parse. The Float32Array is a view over the received bytes.
 */
export async function decodePcm16k(file: string, config: OllosConfig, opts: Window & { signal?: AbortSignal; audioTrack?: number } = {}): Promise<Float32Array> {
  const { ffmpeg } = resolveBinaries(config)
  const map = opts.audioTrack !== undefined ? ['-map', `0:a:${opts.audioTrack}`] : []
  const { stdout } = await run(
    ffmpeg,
    ['-v', 'error', '-nostdin', ...windowArgs(opts), '-i', file, ...map, '-vn', '-f', 'f32le', '-ac', '1', '-ar', String(ASR_SAMPLE_RATE), '-'],
    { signal: opts.signal },
  )
  // Buffer may not be 4-byte aligned relative to its pool; copy into an owned ArrayBuffer.
  const bytes = stdout.byteLength - (stdout.byteLength % 4)
  const ab = new ArrayBuffer(bytes)
  new Uint8Array(ab).set(stdout.subarray(0, bytes))
  return new Float32Array(ab)
}

export function samplesToSec(n: number): number {
  return n / ASR_SAMPLE_RATE
}

export function secToSamples(s: number): number {
  return Math.round(s * ASR_SAMPLE_RATE)
}
