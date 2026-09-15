/**
 * A video-site URL as the source, through the library. Run with:
 *   OLLOS_YTDLP=~/.ollos/bin/yt-dlp npx tsx examples/library-url.ts
 *
 * yt-dlp must be on PATH or in OLLOS_YTDLP. Behind a TLS-intercepting proxy: OLLOS_YTDLP_ARGS="--no-check-certificates".
 */
import { createOllos, type TranscribeResult, type KeyframesResult } from '../src/core/index.js'

const url = process.argv[2] ?? 'https://www.youtube.com/watch?v=eur8dUO9mvE'
const ollos = createOllos()

// 1. what is it? Fast, and it downloads the file once into ~/.ollos/cache/download/<sha1>/
const info = await ollos.probe(url)
console.log(`${info.kind} · ${Math.round(info.durationSec)} s · ${info.video?.width}×${info.video?.height} · origin ${info.origin}`)

// 2. transcribe the first 30 seconds. The window uses fromSec/toSec in seconds; the MCP tools accept "0:30" too.
//    Small windows run inline; anything longer comes back as a job you await.
const { job, result, etaSeconds } = await ollos.transcribe({ source: url, language: 'en', model: 'fast', fromSec: 0, toSec: 30 })
const transcript = result ?? (await ollos.wait<TranscribeResult>(job.id)).result
if (!transcript) throw new Error(`transcribe ${job.id} ended as ${ollos.job(job.id)?.status}`)
console.log(`transcribed ${transcript.segments.length} segments in job ${job.id} (eta was ${etaSeconds ?? '?'} s, cached ${transcript.cached})`)
for (const s of transcript.segments.slice(0, 3)) console.log(`  [${s.startSec.toFixed(1)}] ${s.text}`)

// 3. keyframes of the first minute: the source is resolved once per job, so the cached download is reused
const kf = await ollos.keyframes({ source: url, fromSec: 0, toSec: 60, maxFrames: 12 })
const frames = kf.result ?? (await ollos.wait<KeyframesResult>(kf.job.id)).result
console.log(`keyframes: ${frames?.frames.length} frames on ${frames?.sheets.length} sheet(s) → ${frames?.sheets[0]?.file}`)
