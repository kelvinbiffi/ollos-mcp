import fs from 'node:fs'
import path from 'node:path'
import type { OllosConfig } from '../config.js'
import { Cache, hashOf } from '../cache/cache.js'
import { decodePcm16k, ASR_SAMPLE_RATE, type Window } from '../media/decode.js'
import { fmtTime } from '../media/ffmpeg.js'
import { assertKindSupports, resolveSource, type ResolvedSource } from '../source/resolve.js'
import { detectSpeech, type SpeechRegion } from '../audio/vad.js'
import { transcribeWindow, asrModelId, type AsrModelChoice } from '../audio/asr.js'
import { filterSegment, type HallucinationFlag } from '../audio/hallucination.js'
import { applyVocabulary } from '../audio/vocabulary.js'
import { OllosError } from '../errors.js'
import type { JobContext } from '../jobs/types.js'

export interface TranscribeParams {
  source: string
  language?: string
  model?: AsrModelChoice
  vocabulary?: string[]
  fromSec?: number
  toSec?: number
  /** Which audio track of a multi-track file (Zoom per-participant). */
  audioTrack?: number
}

export interface Segment {
  id: number
  startSec: number
  endSec: number
  text: string
  /** Heuristic 0–1: speech ratio under the segment, speaking rate plausibility, and whether filters fired. Not a model log-prob. */
  confidence: number
  flags: HallucinationFlag[]
  speaker?: string
}

export interface TranscribeResult {
  source: { input: string; identity: string; durationSec: number }
  language: string
  model: string
  vad: { engine: 'silero' | 'energy'; speechSec: number; regions: number }
  segments: Segment[]
  stats: { segmentCount: number; filteredCount: number; wordCount: number; vocabularyReplacements: number; processingSec: number }
  artifacts: { json: string; txt: string; srt: string }
  cached: boolean
}

const WINDOW_SEC = 28
const MERGE_GAP_SEC = 0.6

/** Group VAD regions into ≤ WINDOW_SEC windows, merging tiny gaps, splitting long runs. */
export function planWindows(regions: SpeechRegion[]): SpeechRegion[] {
  const merged: SpeechRegion[] = []
  for (const r of regions) {
    const last = merged[merged.length - 1]
    if (last && r.startSec - last.endSec <= MERGE_GAP_SEC && r.endSec - last.startSec <= WINDOW_SEC) last.endSec = r.endSec
    else merged.push({ ...r })
  }
  const windows: SpeechRegion[] = []
  for (const r of merged) {
    let s = r.startSec
    while (r.endSec - s > WINDOW_SEC) {
      windows.push({ startSec: s, endSec: s + WINDOW_SEC })
      s += WINDOW_SEC - 2 // 2 s overlap so no word falls in a crack
    }
    windows.push({ startSec: s, endSec: r.endSec })
  }
  return windows
}

function toSrt(segments: Segment[]): string {
  const ts = (s: number) => {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = Math.floor(s % 60)
    const ms = Math.round((s - Math.floor(s)) * 1000)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`
  }
  return segments.map((s, i) => `${i + 1}\n${ts(s.startSec)} --> ${ts(s.endSec)}\n${s.speaker ? `[${s.speaker}] ` : ''}${s.text}\n`).join('\n')
}

export function estimateTranscribeSeconds(durationSec: number, model: AsrModelChoice | undefined): number {
  const rt = model === 'fast' ? 0.2 : 0.6
  return 8 + durationSec * rt
}

export async function runTranscribe(params: TranscribeParams, ctx: JobContext, config: OllosConfig, pre?: ResolvedSource): Promise<TranscribeResult> {
  const t0 = Date.now()
  ctx.progress('resolve', 0.01, 'resolving source')
  const src = pre ?? (await resolveSource(params.source, config, { signal: ctx.signal }))
  assertKindSupports(src.info, 'transcribe')

  const modelId = asrModelId(params.model, config)
  const cache = new Cache(config)
  const key = hashOf(src.identity, modelId, params.language ?? 'auto', params.vocabulary ?? [], params.fromSec ?? 0, params.toSec ?? 0, params.audioTrack ?? 0)
  const hit = cache.getJSON<TranscribeResult>('transcript', key)
  if (hit && fs.existsSync(hit.artifacts.json)) {
    ctx.event({ stage: 'cache', event: 'info', message: 'transcript served from cache' })
    return { ...hit, cached: true }
  }

  const window: Window = { fromSec: params.fromSec, toSec: params.toSec }
  ctx.progress('decode', 0.03, 'decoding audio')
  const pcm = await decodePcm16k(src.path, config, { ...window, signal: ctx.signal, audioTrack: params.audioTrack })
  if (pcm.length < ASR_SAMPLE_RATE * 0.5) throw new OllosError('PIPELINE_EMPTY_OUTPUT', 'decoded audio is shorter than half a second', { hint: 'Check from/to, or whether the file really has an audio stream.' })
  const offset = params.fromSec ?? 0
  const totalSec = pcm.length / ASR_SAMPLE_RATE

  ctx.progress('vad', 0.06, 'detecting speech')
  const tv = Date.now()
  const vad = await detectSpeech(pcm, config)
  ctx.event({ stage: 'vad', event: 'end', durationMs: Date.now() - tv, data: { engine: vad.engine, speechSec: Number(vad.speechSec.toFixed(1)), totalSec: Number(totalSec.toFixed(1)) } })
  const windows = planWindows(vad.regions)
  if (windows.length === 0) throw new OllosError('PIPELINE_EMPTY_OUTPUT', 'no speech detected in the selected audio', { details: { vadEngine: vad.engine }, hint: 'The audio may be music-only or silent. Lower the VAD threshold or check the track.' })

  ctx.progress('asr', 0.08, `loading ${modelId}`)
  const segments: Segment[] = []
  let filtered = 0
  let language = params.language ?? 'auto'
  const ta = Date.now()
  for (let i = 0; i < windows.length; i++) {
    if (ctx.signal.aborted) throw new OllosError('CANCELLED', 'cancelled')
    const w = windows[i]!
    const slice = pcm.subarray(Math.floor(w.startSec * ASR_SAMPLE_RATE), Math.floor(w.endSec * ASR_SAMPLE_RATE))
    const chunks = await transcribeWindow(slice, { language: params.language, model: params.model, signal: ctx.signal }, config)
    for (const c of chunks) {
      const startSec = offset + w.startSec + c.startSec
      const endSec = offset + w.startSec + c.endSec
      const dur = Math.max(0.1, endSec - startSec)
      const speech = speechRatio(vad.regions, w.startSec + c.startSec, w.startSec + c.endSec)
      const verdict = filterSegment(c.text, { durationSec: dur, speechRatio: speech })
      if (!verdict.keep) {
        filtered++
        ctx.event({ stage: 'filter', event: 'info', message: `dropped: ${verdict.flags.join(',')}`, data: { text: c.text.slice(0, 80), startSec } })
        continue
      }
      const words = verdict.text.split(/\s+/).length
      const rate = words / dur
      const ratePlaus = rate >= 0.8 && rate <= 5 ? 1 : rate < 0.8 ? 0.75 : 0.5
      const confidence = Number((0.55 * Math.min(1, speech / 0.6) + 0.3 * ratePlaus + 0.15 * (verdict.flags.length ? 0.4 : 1)).toFixed(2))
      segments.push({ id: segments.length + 1, startSec: Number(startSec.toFixed(2)), endSec: Number(endSec.toFixed(2)), text: verdict.text, confidence, flags: verdict.flags })
    }
    const done = (i + 1) / windows.length
    ctx.progress('asr', 0.08 + 0.85 * done, `transcribing ${fmtTime(offset + w.endSec)} of ${fmtTime(offset + totalSec)}`)
  }
  ctx.event({ stage: 'asr', event: 'end', durationMs: Date.now() - ta, data: { windows: windows.length, model: modelId } })
  if (segments.length === 0) throw new OllosError('PIPELINE_EMPTY_OUTPUT', 'speech was detected but every segment was filtered as a hallucination', { hint: 'Very short or noisy audio. Try model "accurate", or inspect events for what was dropped.' })

  let replacements = 0
  if (params.vocabulary?.length) {
    for (const s of segments) {
      const r = applyVocabulary(s.text, params.vocabulary)
      s.text = r.text
      replacements += r.stats.replacements
    }
  }
  if (language === 'auto') language = guessLanguage(segments.map((s) => s.text).join(' '))

  ctx.progress('write', 0.97, 'writing artifacts')
  const base = path.join(ctx.artifactsDir, 'transcript')
  const artifacts = { json: base + '.json', txt: base + '.txt', srt: base + '.srt' }
  const wordCount = segments.reduce((a, s) => a + s.text.split(/\s+/).length, 0)
  const result: TranscribeResult = {
    source: { input: src.input, identity: src.identity, durationSec: src.info.durationSec },
    language,
    model: modelId,
    vad: { engine: vad.engine, speechSec: Number(vad.speechSec.toFixed(1)), regions: vad.regions.length },
    segments,
    stats: { segmentCount: segments.length, filteredCount: filtered, wordCount, vocabularyReplacements: replacements, processingSec: Number(((Date.now() - t0) / 1000).toFixed(1)) },
    artifacts,
    cached: false,
  }
  fs.writeFileSync(artifacts.json, JSON.stringify(result, null, 2))
  fs.writeFileSync(artifacts.txt, segments.map((s) => `[${fmtTime(s.startSec)}] ${s.speaker ? s.speaker + ': ' : ''}${s.text}`).join('\n'))
  fs.writeFileSync(artifacts.srt, toSrt(segments))
  cache.setJSON('transcript', key, result)
  return result
}

function speechRatio(regions: SpeechRegion[], s: number, e: number): number {
  const len = Math.max(0.01, e - s)
  let covered = 0
  for (const r of regions) {
    const a = Math.max(s, r.startSec)
    const b = Math.min(e, r.endSec)
    if (b > a) covered += b - a
  }
  return Math.min(1, covered / len)
}

/** Cheap stopword vote when language was auto. Only pt/en/es for now; anything else stays "auto". */
function guessLanguage(text: string): string {
  const t = ` ${text.toLowerCase()} `
  const score = (words: string[]) => words.reduce((a, w) => a + (t.split(` ${w} `).length - 1), 0)
  const pt = score(['que', 'não', 'você', 'para', 'com', 'uma', 'isso', 'então', 'aqui', 'tem'])
  const en = score(['the', 'and', 'you', 'that', 'this', 'with', 'for', 'have', 'what', 'here'])
  const es = score(['que', 'para', 'con', 'una', 'esto', 'pero', 'aquí', 'tiene', 'entonces', 'también'])
  const best = Math.max(pt, en, es)
  if (best < 3) return 'auto'
  return best === pt ? 'pt' : best === en ? 'en' : 'es'
}
