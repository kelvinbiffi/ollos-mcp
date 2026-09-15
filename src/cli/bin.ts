#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createOllos, type JobRecord } from '../core/index.js'
import { dirs } from '../core/config.js'
import { resolveBinaries, fmtTime, parseTime } from '../core/media/ffmpeg.js'
import { configureModelRuntime, isModelCached, modelCatalog, ensureFile } from '../core/models.js'
import { loadAsr } from '../core/audio/asr.js'
import { loadSegmentationModel, loadSpeakerModel } from '../core/audio/diarize.js'
import { embed } from '../core/search/index.js'
import { isOllosError } from '../core/errors.js'
import { formatDiarize, formatKeyframes, formatReadScreen, formatReview, formatSearch, formatTranscribe } from '../mcp/format.js'
import type { TranscribeResult, KeyframesResult, ReadScreenResult, ReviewResult, DiarizeResult } from '../core/index.js'

const HELP = `ollos — eyes and ears for your terminal (local, offline)

usage: ollos <command> [options]

  probe <source>                      what the file really is
  transcribe <source> [--lang pt] [--model accurate|fast] [--vocab "a,b"] [--from t] [--to t]
  keyframes <source> [--sensitivity normal] [--max-frames 120] [--from t] [--to t]
  read-screen <source> [--no-secrets] [--from t] [--to t]
  review <source> [--platform youtube] [--checks loudness,silences,aspect,secrets] [--from t] [--to t]
  diarize <source> [--transcript <jobId>] [--max-speakers n] [--threshold 0.35] [--from t] [--to t]
  search "<query>" [--k 8] [--job <jobId>]
  jobs                                list jobs
  job <id>                            job status and result
  events <id>                         job timeline
  cancel <id>
  warmup [--all]                      download models now (default ASR + VAD; --all adds fast ASR, speakers, search, OCR data)
  doctor                              check ffmpeg, models, memory, home
  gc [--older-than 30d]               delete old jobs, cache entries and search indexes (models stay)

  --json     print the raw result as JSON
  --home     override OLLOS_HOME
  --detailed full output instead of concise`

async function follow<R>(ollos: ReturnType<typeof createOllos>, p: Promise<{ job: JobRecord; result?: R }>, quiet: boolean): Promise<{ job: JobRecord; result?: R }> {
  const { job, result } = await p
  if (job.status === 'completed' && result) return { job, result }
  let last = ''
  while (true) {
    const j = ollos.job(job.id)!
    const line = `${j.progress.stage} ${Math.round(j.progress.fraction * 100)}% ${j.progress.message}`
    if (!quiet && line !== last) {
      process.stderr.write(`\r\x1b[2K  ${line}`)
      last = line
    }
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(j.status)) break
    await new Promise((r) => setTimeout(r, 700))
  }
  if (!quiet) process.stderr.write('\n')
  return ollos.wait<R>(job.id)
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      detailed: { type: 'boolean', default: false },
      home: { type: 'string' },
      lang: { type: 'string' },
      model: { type: 'string' },
      vocab: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      sensitivity: { type: 'string' },
      'max-frames': { type: 'string' },
      'no-secrets': { type: 'boolean', default: false },
      platform: { type: 'string' },
      checks: { type: 'string' },
      all: { type: 'boolean', default: false },
      'older-than': { type: 'string' },
      transcript: { type: 'string' },
      'max-speakers': { type: 'string' },
      threshold: { type: 'string' },
      k: { type: 'string' },
      job: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [cmd, arg] = positionals
  if (!cmd || values.help) {
    console.log(HELP)
    return
  }
  if (values.home) process.env.OLLOS_HOME = values.home
  const ollos = createOllos()
  const fmt = values.detailed ? 'detailed' : 'concise'
  const out = (text: string, raw: unknown) => console.log(values.json ? JSON.stringify(raw, null, 2) : text)
  const need = (what: string) => {
    if (!arg) {
      console.error(`missing ${what}`)
      process.exit(2)
    }
    return arg
  }
  const win = { fromSec: parseTime(values.from), toSec: parseTime(values.to) }

  switch (cmd) {
    case 'probe': {
      const info = await ollos.probe(need('source'))
      out(`${info.kind} · ${fmtTime(info.durationSec)} · ${info.container}\n${info.video ? `video ${info.video.width}×${info.video.height} ${info.video.codec} ${info.video.fps}fps · aspect ${info.aspect?.ratio} (${info.aspect?.in16x9} in 16:9)\n` : ''}${info.audio ? `audio ${info.audio.codec} ${info.audio.channels}ch ${info.audio.sampleRate}Hz · ${info.audioTracks} track(s)` : 'no audio'}${info.zoomTracks ? `\nZoom tracks: ${info.zoomTracks.join(', ')}` : ''}`, info)
      return
    }
    case 'transcribe': {
      const { job, result } = await follow<TranscribeResult>(ollos, ollos.transcribe({ source: need('source'), language: values.lang, model: values.model as never, vocabulary: values.vocab?.split(',').map((s) => s.trim()).filter(Boolean), ...win }), values.json)
      if (!result) return fail(job)
      out(formatTranscribe(result, job.id, fmt, 1e9), result)
      return
    }
    case 'keyframes': {
      const { job, result } = await follow<KeyframesResult>(ollos, ollos.keyframes({ source: need('source'), sensitivity: values.sensitivity as never, maxFrames: values['max-frames'] ? Number(values['max-frames']) : undefined, ...win }), values.json)
      if (!result) return fail(job)
      out(formatKeyframes(result, job.id, fmt) + `\n\nfiles: ${path.dirname(result.sheets[0]?.file ?? '')}`, result)
      return
    }
    case 'read-screen': {
      const { job, result } = await follow<ReadScreenResult>(ollos, ollos.readScreen({ source: need('source'), detectSecrets: !values['no-secrets'], ...win }), values.json)
      if (!result) return fail(job)
      out(formatReadScreen(result, job.id, fmt, 1e9), result)
      return
    }
    case 'review': {
      const { job, result } = await follow<ReviewResult>(ollos, ollos.review({ source: need('source'), platform: values.platform as never, checks: values.checks?.split(',').map((s) => s.trim()) as never, ...win }), values.json)
      if (!result) return fail(job)
      out(formatReview(result, job.id) + `\n\nreport: ${result.artifacts.md}`, result)
      process.exitCode = result.verdict === 'block' ? 3 : result.verdict === 'warn' ? 1 : 0
      return
    }
    case 'diarize': {
      const transcript = values.transcript ? ollos.result<TranscribeResult>(values.transcript) : undefined
      const { job, result } = await follow<DiarizeResult>(ollos, ollos.diarize({ source: need('source'), transcript, maxSpeakers: values['max-speakers'] ? Number(values['max-speakers']) : undefined, similarityThreshold: values.threshold ? Number(values.threshold) : undefined, ...win }), values.json)
      if (!result) return fail(job)
      out(formatDiarize(result, job.id, fmt, 1e9), result)
      return
    }
    case 'search': {
      const r = await ollos.search({ query: need('query'), k: values.k ? Number(values.k) : undefined, jobId: values.job, scope: values.job ? 'job' : 'all' })
      out(formatSearch(r), r)
      return
    }
    case 'jobs': {
      const jobs = ollos.jobs()
      out(jobs.map((j) => `${j.id}  ${j.kind.padEnd(12)} ${j.status.padEnd(11)} ${Math.round(j.progress.fraction * 100).toString().padStart(3)}%  ${j.createdAt}  ${typeof j.params === 'object' && j.params && 'source' in (j.params as object) ? path.basename(String((j.params as { source: string }).source)) : ''}`).join('\n') || '(no jobs)', jobs)
      return
    }
    case 'job': {
      const j = ollos.job(need('job id'))
      if (!j) return fail(undefined, `no job ${arg}`)
      const r = j.status === 'completed' ? ollos.result<unknown>(j.id) : undefined
      out(`${j.id} ${j.kind} ${j.status} — ${j.progress.stage} ${Math.round(j.progress.fraction * 100)}% ${j.progress.message}${j.error ? `\n${j.error.code}: ${j.error.message}${j.error.hint ? '\n' + j.error.hint : ''}` : ''}${r ? `\nresult: ${j.resultFile}` : ''}`, { job: j, result: r })
      return
    }
    case 'events': {
      const ev = ollos.events(need('job id'))
      out(ev.map((e) => `${e.ts}  ${e.stage.padEnd(10)} ${e.event.padEnd(8)} ${e.durationMs !== undefined ? (e.durationMs + 'ms').padStart(9) : ''.padStart(9)}  ${e.message ?? ''} ${e.data ? JSON.stringify(e.data) : ''}${e.mem ? ` mem rss=${e.mem.rss}MB heap=${e.mem.heap}MB arrayBuffers=${e.mem.arrayBuffers}MB` : ''}`).join('\n'), ev)
      return
    }
    case 'cancel': {
      const j = ollos.cancel(need('job id'))
      out(j.status === 'cancelled' ? `${j.id} is now cancelled` : `${j.id} had already finished (${j.status}); nothing to cancel`, j)
      return
    }
    case 'warmup': {
      configureModelRuntime(ollos.config)
      const log = (m: string) => process.stderr.write(`\r\x1b[2K  ${m}`)
      console.error('downloading models into', dirs.models(ollos.config))
      const vad = modelCatalog(ollos.config).find((m) => m.role === 'vad')!
      await ensureFile(vad.file!.url, vad.file!.dest, ollos.config, (r, t) => log(`silero-vad ${Math.round((r / Math.max(1, t)) * 100)}%`))
      console.error('\n  ✓ silero-vad')
      await loadAsr('accurate', ollos.config, log)
      console.error('\n  ✓ whisper-large-v3-turbo')
      if (values.all) {
        // everything the other tools will ask for, so OLLOS_OFFLINE=1 afterwards works for every capability
        await loadAsr('fast', ollos.config, log)
        console.error('\n  ✓ whisper-base')
        await loadSegmentationModel(ollos.config, log)
        console.error('\n  ✓ pyannote-segmentation-3.0')
        await loadSpeakerModel(ollos.config, log)
        console.error('\n  ✓ wespeaker-voxceleb-resnet34-LM')
        await embed(['warmup'], 'query', ollos.config)
        console.error('  ✓ multilingual-e5-small')
        const { getOcrPool, terminateOcr } = await import('../core/vision/ocr.js')
        const pool = getOcrPool(ollos.config, ['por', 'eng'])
        pool.release(await pool.acquire())
        await terminateOcr()
        console.error('  ✓ tesseract por+eng')
      }
      console.error('done')
      return
    }
    case 'doctor': {
      const lines: string[] = []
      lines.push(`home      ${ollos.config.home} ${fs.existsSync(ollos.config.home) ? '' : '(will be created)'}`)
      try {
        const b = resolveBinaries(ollos.config)
        lines.push(`ffmpeg    ${b.ffmpeg}`)
        lines.push(`ffprobe   ${b.ffprobe ?? 'MISSING — probe will fail'}`)
      } catch (e) {
        lines.push(`ffmpeg    MISSING — ${(e as Error).message}`)
      }
      for (const m of modelCatalog(ollos.config)) {
        const ok = m.file ? fs.existsSync(m.file.dest) : isModelCached(m.id, ollos.config)
        lines.push(`${m.role.padEnd(12)} ${ok ? '✓' : '·'} ${m.id} (~${m.approxMb} MB)`)
      }
      // Measured peaks (scripts/probe-memory.mts): default ASR ~4.3 GB RSS, fast ~1.9 GB, everything loaded ~5.1 GB.
      const gb = (n: number) => (n / 1024 ** 3).toFixed(1)
      const free = os.freemem()
      const verdict = free >= 5.5 * 1024 ** 3 ? 'ok for the default model' : free >= 2.5 * 1024 ** 3 ? 'tight for the default model (~4.3 GB peak) — consider model: "fast" (~1.9 GB)' : 'not enough free memory even for model: "fast" (~1.9 GB)'
      lines.push(`memory    ${gb(free)} GB free of ${gb(os.totalmem())} GB — ${verdict}`)
      lines.push(`cpu       ${os.cpus().length} logical cores — transcription speed scales with cores (16 cores ≈ 1.7× real time on the default model)`)
      lines.push(`offline   ${ollos.config.offline}`)
      lines.push(`jobs      ${ollos.jobs().length}`)
      lines.push(`node      ${process.version} ${process.platform} ${process.arch}`)
      console.log(lines.join('\n'))
      return
    }
    case 'gc': {
      const days = Number((values['older-than'] ?? '30d').replace(/d$/, '')) || 30
      const cutoff = Date.now() - days * 86400_000
      let n = 0
      for (const j of ollos.jobs()) if (Date.parse(j.createdAt) < cutoff && j.status !== 'running') {
        ollos.engine.store.remove(j.id)
        n++
      }
      // cache/<namespace>/<key>/ and index/<jobId>/ are content-addressed and rebuildable; models are not touched
      let entries = 0
      for (const root of [path.join(ollos.config.home, 'cache'), path.join(ollos.config.home, 'index')]) {
        if (!fs.existsSync(root)) continue
        const level = root.endsWith('index') ? [root] : fs.readdirSync(root).map((ns) => path.join(root, ns)).filter((p) => fs.statSync(p).isDirectory())
        for (const parent of level) for (const entry of fs.readdirSync(parent)) {
          const p = path.join(parent, entry)
          try {
            if (fs.statSync(p).mtimeMs < cutoff) {
              fs.rmSync(p, { recursive: true, force: true })
              entries++
            }
          } catch {
            /* vanished under us */
          }
        }
      }
      console.log(`removed ${n} job(s) and ${entries} cache/index entr${entries === 1 ? 'y' : 'ies'} older than ${days} days`)
      return
    }
    default:
      console.error(`unknown command "${cmd}"\n`)
      console.log(HELP)
      process.exit(2)
  }
}

function fail(job?: JobRecord, msg?: string): never {
  const e = job?.error
  console.error(msg ?? (e ? `${e.code}: ${e.message}${e.hint ? `\n${e.hint}` : ''}` : `job ${job?.id} ended as ${job?.status}`))
  process.exit(1)
}

main().catch((e) => {
  if (isOllosError(e)) console.error(`${e.code}: ${e.message}${e.hint ? `\n${e.hint}` : ''}`)
  else console.error(e)
  process.exit(1)
})
