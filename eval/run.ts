/**
 * Evaluation runner. Measures ollos against public reference material and writes eval/RESULTS.md.
 *
 *   npx tsx eval/run.ts                # all fixtures
 *   npx tsx eval/run.ts ibm-what-is-mcp  # one fixture by id
 *
 * Inputs
 *   eval/fixtures.json        public metadata: YouTube URL, language, expected speakers, kind
 *   eval/fixtures.local.json  (gitignored) { "<id>": "/path/to/media.mp4" } — where the media is on this machine
 *   eval/references/<id>.txt  (gitignored) reference transcript (YouTube captions or a human transcript)
 *
 * The media and the references are not redistributed; see eval/README.md for how to obtain them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOllos, type TranscribeResult, type DiarizeResult, type KeyframesResult } from '../src/core/index.js'
import { errorRates, type ErrorRates } from './wer.js'

interface Fixture {
  id: string
  title: string
  url: string
  language: 'pt' | 'en' | 'es'
  kind: 'interview' | 'screencast' | 'talk' | 'meeting'
  expectedSpeakers: number
  durationSec: number
  vocabulary?: string[]
  notes?: string
}

interface Row {
  id: string
  kind: string
  durationSec: number
  asr?: ErrorRates & { seconds: number; realtime: number; filtered: number; vadEngine: string }
  diarize?: { expected: number; found: number; seconds: number; method: string }
  keyframes?: { frames: number; sheets: number; sampled: number; afterHash: number; cuts: number; seconds: number }
  error?: string
}

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(fs.readFileSync(path.join(here, 'fixtures.json'), 'utf8')) as Fixture[]
const localPath = path.join(here, 'fixtures.local.json')
const local = fs.existsSync(localPath) ? (JSON.parse(fs.readFileSync(localPath, 'utf8')) as Record<string, string>) : {}
const only = process.argv[2]

const ollos = createOllos()
const resultsPath = path.join(here, 'results.json')
/** A single-fixture rerun (`eval/run.ts <id>`) replaces that fixture's row and keeps the others, so RESULTS.md always covers the whole set. */
const previous: Row[] = only && fs.existsSync(resultsPath) ? ((JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as { rows?: Row[] }).rows ?? []) : []
const rows: Row[] = []

for (const f of fixtures) {
  if (only && f.id !== only) continue
  const media = local[f.id]
  const row: Row = { id: f.id, kind: f.kind, durationSec: f.durationSec }
  rows.push(row)
  if (!media || !fs.existsSync(media)) {
    row.error = `media not found — add "${f.id}" to eval/fixtures.local.json`
    console.log(`[${f.id}] skipped: ${row.error}`)
    continue
  }
  console.log(`\n[${f.id}] ${f.title} (${f.kind}, ${f.language}, ${Math.round(f.durationSec)} s)`)

  // ASR + WER
  try {
    const t0 = Date.now()
    const { job } = await ollos.transcribe({ source: media, language: f.language, vocabulary: f.vocabulary })
    const { result } = await ollos.wait<TranscribeResult>(job.id)
    const seconds = (Date.now() - t0) / 1000
    if (!result) throw new Error(`transcribe ${job.id} failed`)
    // A cached transcript says nothing about speed: keep the timing measured when it was actually computed.
    const prev = previous.find((r) => r.id === f.id)?.asr
    const timing = result.cached && prev ? { seconds: prev.seconds, realtime: prev.realtime } : { seconds: Number(seconds.toFixed(1)), realtime: Number((f.durationSec / seconds).toFixed(2)) }
    const refFile = path.join(here, 'references', `${f.id}.txt`)
    if (fs.existsSync(refFile)) {
      const rates = errorRates(fs.readFileSync(refFile, 'utf8'), result.segments.map((s) => s.text).join(' '))
      row.asr = { ...rates, ...timing, filtered: result.stats.filteredCount, vadEngine: result.vad.engine }
      console.log(`  ASR: WER ${(rates.wer * 100).toFixed(1)}% · CER ${(rates.cer * 100).toFixed(1)}% · ${rates.referenceWords} ref words · ${seconds.toFixed(0)} s (${row.asr.realtime}× real time) · ${result.stats.filteredCount} filtered`)
    } else console.log(`  ASR: done in ${seconds.toFixed(0)} s, no reference at ${refFile}`)
  } catch (e) {
    row.error = `asr: ${(e as Error).message}`
    console.log('  ASR failed:', (e as Error).message)
  }

  // Diarization: speaker count vs expected
  try {
    const t0 = Date.now()
    const { job } = await ollos.diarize({ source: media, maxSpeakers: Math.max(4, f.expectedSpeakers + 2) })
    const { result } = await ollos.wait<DiarizeResult>(job.id)
    if (!result) throw new Error(`diarize ${job.id} failed`)
    const prevD = previous.find((r) => r.id === f.id)?.diarize
    row.diarize = { expected: f.expectedSpeakers, found: result.speakers.length, seconds: result.cached && prevD ? prevD.seconds : Number(((Date.now() - t0) / 1000).toFixed(1)), method: result.method }
    console.log(`  Speakers: expected ${f.expectedSpeakers}, found ${result.speakers.length} (${result.speakers.map((s) => `${s.id} ${Math.round(s.talkTimeSec)}s`).join(', ')}) in ${row.diarize.seconds} s`)
  } catch (e) {
    console.log('  Diarize failed:', (e as Error).message)
  }

  // Keyframes: how many frames the video reduces to
  if (f.kind !== 'meeting') {
    try {
      const t0 = Date.now()
      const { job } = await ollos.keyframes({ source: media })
      const { result } = await ollos.wait<KeyframesResult>(job.id)
      if (!result) throw new Error(`keyframes ${job.id} failed`)
      const prevK = previous.find((r) => r.id === f.id)?.keyframes
      row.keyframes = { frames: result.frames.length, sheets: result.sheets.length, sampled: result.stats.sampled, afterHash: result.stats.afterHash, cuts: result.stats.cuts, seconds: result.cached && prevK ? prevK.seconds : Number(((Date.now() - t0) / 1000).toFixed(1)) }
      console.log(`  Keyframes: ${result.frames.length} frames / ${result.sheets.length} sheets from ${result.stats.sampled} sampled (${result.stats.afterHash} by hash, ${result.stats.cuts} cuts) in ${row.keyframes.seconds} s`)
    } catch (e) {
      console.log('  Keyframes failed:', (e as Error).message)
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const merged: Row[] = fixtures.map((f) => rows.find((r) => r.id === f.id) ?? previous.find((r) => r.id === f.id)).filter((r): r is Row => Boolean(r))
const pct = (x?: number) => (x === undefined ? '—' : `${(x * 100).toFixed(1)}%`)
const md: string[] = [
  '# Evaluation results',
  '',
  `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by \`npx tsx eval/run.ts\` on ${process.platform} ${process.arch}, Node ${process.version}. Reference transcripts are YouTube captions (see eval/README.md), so WER includes caption errors as well as ollos errors.`,
  ...(process.env.EVAL_NOTES ? ['', `> **Run conditions:** ${process.env.EVAL_NOTES}`] : []),
  '',
  '## Transcription',
  '',
  '| fixture | kind | lang | duration | WER | CER | ref words | S / D / I | filtered | speed |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...merged.map((r) => {
    const f = fixtures.find((x) => x.id === r.id)!
    const a = r.asr
    return `| ${r.id} | ${r.kind} | ${f.language} | ${Math.round(r.durationSec)} s | ${pct(a?.wer)} | ${pct(a?.cer)} | ${a?.referenceWords ?? '—'} | ${a ? `${a.substitutions} / ${a.deletions} / ${a.insertions}` : '—'} | ${a?.filtered ?? '—'} | ${a ? `${a.realtime}× RT` : r.error ?? '—'} |`
  }),
  '',
  '## Speakers',
  '',
  '| fixture | expected | found | method | time |',
  '|---|---|---|---|---|',
  ...merged.filter((r) => r.diarize).map((r) => `| ${r.id} | ${r.diarize!.expected} | ${r.diarize!.found} ${r.diarize!.found === r.diarize!.expected ? '✅' : '❌'} | ${r.diarize!.method} | ${r.diarize!.seconds} s |`),
  '',
  '## Keyframes',
  '',
  '| fixture | sampled @1 fps | kept by hash | hard cuts | final frames | sheets | time |',
  '|---|---|---|---|---|---|---|',
  ...merged.filter((r) => r.keyframes).map((r) => `| ${r.id} | ${r.keyframes!.sampled} | ${r.keyframes!.afterHash} | ${r.keyframes!.cuts} | ${r.keyframes!.frames} | ${r.keyframes!.sheets} | ${r.keyframes!.seconds} s |`),
  '',
  '## Fixtures',
  '',
  ...fixtures.map((f) => `- **${f.id}** — [${f.title}](${f.url}) · ${f.kind}, ${f.language}, ${Math.round(f.durationSec)} s, ${f.expectedSpeakers} speaker(s)${f.notes ? ` · ${f.notes}` : ''}`),
  '',
]
fs.writeFileSync(path.join(here, 'RESULTS.md'), md.join('\n'))
fs.writeFileSync(resultsPath, JSON.stringify({ generatedAt: new Date().toISOString(), rows: merged }, null, 2))
console.log(`\nwrote eval/RESULTS.md`)
