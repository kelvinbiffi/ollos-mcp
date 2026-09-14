// Probe: peak process memory and time as models load and run, sampled every 200 ms.
// Usage: npx tsx scripts/probe-memory.mts   (needs eval/fixtures.local.json from `npm run eval:fetch`)
// Measured 2026-09-14 (i9-12900HX, Node 20): turbo ASR peak 4.3 GB RSS; + diarization 4.4 GB; + e5 search 5.1 GB.
// Before PathCache (src/core/models.ts) the same run peaked at ~10 GB with 4.86 GB of live ArrayBuffers.
import fs from 'node:fs'
import { createOllos, type TranscribeResult, type DiarizeResult } from '../src/core/index.js'
const local = JSON.parse(fs.readFileSync('eval/fixtures.local.json', 'utf8'))
const src = local['ibm-what-is-mcp']
const ollos = createOllos()
const mb = (n: number) => Math.round(n / 1048576)
let peakRss = 0, peakAb = 0
setInterval(() => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakAb = Math.max(peakAb, m.arrayBuffers) }, 200).unref()
const snap = (label: string) => { const m = process.memoryUsage(); console.log(`${label.padEnd(34)} rss ${mb(m.rss)} MB · arrayBuffers ${mb(m.arrayBuffers)} · peak rss ${mb(peakRss)} · peak arrayBuffers ${mb(peakAb)}`) }
snap('baseline')
let t = Date.now()
{ const { job } = await ollos.transcribe({ source: src, language: 'en', fromSec: 150, toSec: 180 }); const r = await ollos.wait<TranscribeResult>(job.id); console.log('asr cached?', r.result?.cached, '| first segment:', r.result?.segments[0]?.text.slice(0, 90)) }
snap(`after ASR turbo 150-180 (${Math.round((Date.now() - t) / 1000)} s)`)
for (let i = 1; i <= 3; i++) { await new Promise((res) => setTimeout(res, 2000)); snap(`idle ${i * 2} s`) }
t = Date.now()
{ const { job } = await ollos.diarize({ source: src, fromSec: 0, toSec: 60 }); const r = await ollos.wait<DiarizeResult>(job.id); console.log('diarize cached?', r.result?.cached, 'speakers', r.result?.speakers.length) }
snap(`after diarize 0-60 (${Math.round((Date.now() - t) / 1000)} s)`)
t = Date.now()
{ const r = await ollos.search({ query: 'model context protocol', scope: 'all', k: 3 } as never); console.log('search hits', (r as { hits?: unknown[] }).hits?.length) }
snap(`after search (e5 load) (${Math.round((Date.now() - t) / 1000)} s)`)
process.exit(0)
