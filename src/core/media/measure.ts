import { resolveBinaries, run } from './ffmpeg.js'
import type { Window } from './decode.js'
import type { OllosConfig } from '../config.js'

export interface Loudness {
  integratedLufs: number
  truePeakDbtp: number
  loudnessRange: number
  threshold: number
}

export interface Silence {
  startSec: number
  endSec: number
  durationSec: number
}

function windowArgs(w: Window | undefined): string[] {
  const a: string[] = []
  if (w?.fromSec !== undefined) a.push('-ss', String(w.fromSec))
  if (w?.toSec !== undefined) a.push('-to', String(w.toSec))
  return a
}

/** EBU R128 via loudnorm in analysis mode. YouTube normalizes to about -14 LUFS; below that it lifts your audio and the noise floor with it. */
export async function measureLoudness(file: string, config: OllosConfig, opts: Window & { signal?: AbortSignal } = {}): Promise<Loudness> {
  const { ffmpeg } = resolveBinaries(config)
  const { stderr } = await run(ffmpeg, ['-v', 'info', '-nostdin', ...windowArgs(opts), '-i', file, '-vn', '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'], { signal: opts.signal })
  const m = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/)
  if (!m) throw new Error('loudnorm produced no measurement (no audio stream?)')
  const j = JSON.parse(m[0]) as Record<string, string>
  return {
    integratedLufs: Number(j.input_i),
    truePeakDbtp: Number(j.input_tp),
    loudnessRange: Number(j.input_lra),
    threshold: Number(j.input_thresh),
  }
}

/** Gaps below `noiseDb` lasting at least `minDurationSec`. Returned in order; useful as cut suggestions. */
export async function detectSilences(file: string, config: OllosConfig, opts: Window & { noiseDb?: number; minDurationSec?: number; signal?: AbortSignal } = {}): Promise<Silence[]> {
  const { ffmpeg } = resolveBinaries(config)
  const noise = opts.noiseDb ?? -35
  const minDur = opts.minDurationSec ?? 2
  const { stderr } = await run(ffmpeg, ['-v', 'info', '-nostdin', ...windowArgs(opts), '-i', file, '-vn', '-af', `silencedetect=noise=${noise}dB:d=${minDur}`, '-f', 'null', '-'], { signal: opts.signal })
  const out: Silence[] = []
  let start: number | undefined
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start:\s*([0-9.]+)/)
    if (s) start = Number(s[1])
    const e = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/)
    if (e && start !== undefined) {
      out.push({ startSec: start, endSec: Number(e[1]), durationSec: Number(e[2]) })
      start = undefined
    }
  }
  return out
}

export interface PlatformPreset {
  id: string
  label: string
  targetLufs: number
  maxTruePeak: number
  aspects: string[]
}

export const PLATFORMS: Record<string, PlatformPreset> = {
  youtube: { id: 'youtube', label: 'YouTube', targetLufs: -14, maxTruePeak: -1, aspects: ['16:9'] },
  'youtube-shorts': { id: 'youtube-shorts', label: 'YouTube Shorts', targetLufs: -14, maxTruePeak: -1, aspects: ['9:16'] },
  instagram: { id: 'instagram', label: 'Instagram Reels', targetLufs: -14, maxTruePeak: -1, aspects: ['9:16', '4:5', '1:1'] },
  tiktok: { id: 'tiktok', label: 'TikTok', targetLufs: -14, maxTruePeak: -1, aspects: ['9:16'] },
  podcast: { id: 'podcast', label: 'Podcast', targetLufs: -16, maxTruePeak: -1, aspects: [] },
  linkedin: { id: 'linkedin', label: 'LinkedIn', targetLufs: -14, maxTruePeak: -1, aspects: ['16:9', '1:1', '4:5'] },
}
