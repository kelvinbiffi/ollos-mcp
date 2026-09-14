import fs from 'node:fs'
import path from 'node:path'
import type { OllosConfig } from '../config.js'
import { Cache, hashOf } from '../cache/cache.js'
import { OllosError } from '../errors.js'
import type { JobContext } from '../jobs/types.js'
import { decodePcm16k } from '../media/decode.js'
import { fmtTime, resolveBinaries, run } from '../media/ffmpeg.js'
import { assertKindSupports, resolveSource } from '../source/resolve.js'
import { detectSpeech } from '../audio/vad.js'
import { clusterSpeakers, segmentSpeakers, speakerEmbeddings, speakerName, toTurns, type Turn } from '../audio/diarize.js'
import type { Segment, TranscribeResult } from './transcribe.js'

export interface DiarizeParams {
  source: string
  /** Cosine similarity above which two turns are the same person. Default 0.40 (experimental; calibrate on your recordings). */
  similarityThreshold?: number
  maxSpeakers?: number
  minSpeakers?: number
  fromSec?: number
  toSec?: number
  /** A finished transcript to label with speakers. */
  transcript?: TranscribeResult
}

export interface SpeakerInfo {
  id: string
  name?: string
  talkTimeSec: number
  turns: number
  voiceClip?: string
}

export interface DiarizeResult {
  source: { input: string; identity: string; durationSec: number }
  method: 'zoom-tracks' | 'embeddings'
  experimental: boolean
  speakers: SpeakerInfo[]
  turns: Turn[]
  /** Transcript segments with `speaker` filled, when a transcript was supplied. */
  segments?: Segment[]
  stats: { localSegments: number; embeddedTurns: number; threshold: number; processingSec: number }
  artifacts: { json: string; txt?: string }
  cached: boolean
}

export function estimateDiarizeSeconds(durationSec: number): number {
  return 12 + durationSec * 0.08
}

function assignSpeakers(segments: Segment[], turns: Turn[]): Segment[] {
  return segments.map((s) => {
    let best: { speaker: string; overlap: number } | undefined
    for (const t of turns) {
      const o = Math.min(s.endSec, t.endSec) - Math.max(s.startSec, t.startSec)
      if (o > 0 && (!best || o > best.overlap)) best = { speaker: t.speaker, overlap: o }
    }
    return { ...s, speaker: best?.speaker }
  })
}

export async function runDiarize(params: DiarizeParams, ctx: JobContext, config: OllosConfig): Promise<DiarizeResult> {
  const t0 = Date.now()
  ctx.progress('resolve', 0.01, 'resolving source')
  const src = await resolveSource(params.source, config, { signal: ctx.signal })
  assertKindSupports(src.info, 'diarize')
  const threshold = params.similarityThreshold ?? 0.35
  const window = { fromSec: params.fromSec, toSec: params.toSec }
  const offset = params.fromSec ?? 0

  const cache = new Cache(config)
  const key = hashOf(src.identity, threshold, params.maxSpeakers ?? 8, params.minSpeakers ?? 1, offset, params.toSec ?? 0)
  const hit = cache.getJSON<DiarizeResult>('diarize', key)
  if (hit && !params.transcript) {
    ctx.event({ stage: 'cache', event: 'info', message: 'diarization served from cache' })
    return { ...hit, cached: true }
  }

  let turns: Turn[] = []
  let method: DiarizeResult['method'] = 'embeddings'
  let localCount = 0
  let embedded = 0

  if (src.zoomTracks && src.zoomTracks.length > 1) {
    // Zoom local recording with one file per participant: each track's speech is that person, exactly.
    method = 'zoom-tracks'
    for (let i = 0; i < src.zoomTracks.length; i++) {
      const tr = src.zoomTracks[i]!
      ctx.progress('tracks', 0.05 + 0.8 * (i / src.zoomTracks.length), `speech in ${tr.participant}`)
      const pcm = await decodePcm16k(tr.file, config, { ...window, signal: ctx.signal })
      const vad = await detectSpeech(pcm, config)
      for (const r of vad.regions) turns.push({ startSec: offset + r.startSec, endSec: offset + r.endSec, speaker: tr.participant, confidence: 0.99 })
    }
    turns.sort((a, b) => a.startSec - b.startSec)
  } else {
    ctx.progress('decode', 0.03, 'decoding audio')
    const pcm = await decodePcm16k(src.path, config, { ...window, signal: ctx.signal })
    ctx.progress('segment', 0.08, 'segmenting speakers')
    const ts = Date.now()
    const local = await segmentSpeakers(pcm, config, ctx.signal)
    localCount = local.length
    const localTurns = toTurns(local)
    ctx.event({ stage: 'segment', event: 'end', durationMs: Date.now() - ts, data: { segments: local.length, turns: localTurns.length } })
    if (localTurns.length === 0) throw new OllosError('PIPELINE_EMPTY_OUTPUT', 'no speech turns found', { hint: 'Music-only or silent audio, or the window is empty.' })

    // only turns long enough to carry a stable voiceprint get embedded and vote in clustering;
    // shorter ones are assigned afterwards to the nearest cluster centroid
    const MIN_EMBED_SEC = 1.5
    const longIdx = localTurns.map((t, i) => (t.end - t.start >= MIN_EMBED_SEC ? i : -1)).filter((i) => i >= 0)
    const shortIdx = localTurns.map((_, i) => i).filter((i) => !longIdx.includes(i))
    const embedIdx = longIdx.length >= 2 ? longIdx : localTurns.map((_, i) => i)
    ctx.progress('embed', 0.2, 'embedding voices')
    const te = Date.now()
    const emb = await speakerEmbeddings(pcm, embedIdx.map((i) => localTurns[i]!), config, ctx.signal, (i, n) => ctx.progress('embed', 0.2 + 0.6 * (i / n), `voice ${i}/${n}`))
    embedded = emb.length
    ctx.event({ stage: 'embed', event: 'end', durationMs: Date.now() - te, data: { turns: emb.length, skippedShort: localTurns.length - emb.length } })

    ctx.progress('cluster', 0.85, 'clustering speakers')
    const weights = embedIdx.map((i) => localTurns[i]!.end - localTurns[i]!.start)
    const labels = clusterSpeakers(emb, { threshold, maxSpeakers: params.maxSpeakers, minSpeakers: params.minSpeakers, weights })
    const labelOf = new Map<number, number>()
    embedIdx.forEach((i, k) => labelOf.set(i, labels[k]!))
    // short turns: nearest labelled turn in time (a 0.8 s "tá?" belongs to whoever was just speaking)
    for (const i of shortIdx) {
      if (labelOf.has(i)) continue
      let best = -1
      let dist = Infinity
      for (const j of embedIdx) {
        const d = Math.abs(localTurns[j]!.start - localTurns[i]!.start)
        if (d < dist) {
          dist = d
          best = j
        }
      }
      labelOf.set(i, best >= 0 ? labelOf.get(best)! : 0)
    }
    turns = localTurns.map((t, i) => ({ startSec: offset + t.start, endSec: offset + t.end, speaker: speakerName(labelOf.get(i) ?? 0), confidence: t.confidence }))
    // merge adjacent turns of the same speaker
    const merged: Turn[] = []
    for (const t of turns) {
      const last = merged[merged.length - 1]
      if (last && last.speaker === t.speaker && t.startSec - last.endSec < 0.6) last.endSec = t.endSec
      else merged.push({ ...t })
    }
    turns = merged
  }

  // speakers summary + voice clips (longest turn each, ≤ 8 s) so a human can name SPEAKER_00 by ear
  const bySpeaker = new Map<string, { talk: number; turns: number; longest: Turn }>()
  for (const t of turns) {
    const cur = bySpeaker.get(t.speaker)
    const len = t.endSec - t.startSec
    if (!cur) bySpeaker.set(t.speaker, { talk: len, turns: 1, longest: t })
    else {
      cur.talk += len
      cur.turns++
      if (len > cur.longest.endSec - cur.longest.startSec) cur.longest = t
    }
  }
  const voicesDir = path.join(ctx.artifactsDir, 'voices')
  fs.mkdirSync(voicesDir, { recursive: true })
  const { ffmpeg } = resolveBinaries(config)
  const speakers: SpeakerInfo[] = []
  for (const [id, s] of [...bySpeaker.entries()].sort((a, b) => b[1].talk - a[1].talk)) {
    const clip = path.join(voicesDir, `${id.replace(/[^\w.-]+/g, '_')}.m4a`)
    const start = s.longest.startSec
    const dur = Math.min(8, s.longest.endSec - s.longest.startSec)
    try {
      await run(ffmpeg, ['-v', 'error', '-nostdin', '-ss', start.toFixed(2), '-t', dur.toFixed(2), '-i', src.path, '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', clip, '-y'], { signal: ctx.signal })
    } catch {
      /* clip is a convenience; never fail the job for it */
    }
    speakers.push({ id, talkTimeSec: Number(s.talk.toFixed(1)), turns: s.turns, voiceClip: fs.existsSync(clip) ? clip : undefined })
  }

  const segments = params.transcript ? assignSpeakers(params.transcript.segments, turns) : undefined
  const artifacts: DiarizeResult['artifacts'] = { json: path.join(ctx.artifactsDir, 'speakers.json') }
  if (segments) {
    artifacts.txt = path.join(ctx.artifactsDir, 'transcript.speakers.txt')
    fs.writeFileSync(artifacts.txt, segments.map((s) => `[${fmtTime(s.startSec)}] ${s.speaker ?? '?'}: ${s.text}`).join('\n'))
  }
  const result: DiarizeResult = {
    source: { input: src.input, identity: src.identity, durationSec: src.info.durationSec },
    method,
    experimental: method === 'embeddings',
    speakers,
    turns: turns.map((t) => ({ ...t, startSec: Number(t.startSec.toFixed(2)), endSec: Number(t.endSec.toFixed(2)) })),
    segments,
    stats: { localSegments: localCount, embeddedTurns: embedded, threshold, processingSec: Number(((Date.now() - t0) / 1000).toFixed(1)) },
    artifacts,
    cached: false,
  }
  fs.writeFileSync(artifacts.json, JSON.stringify(result, null, 2))
  if (!params.transcript) cache.setJSON('diarize', key, result)
  return result
}
