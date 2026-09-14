/**
 * Using ollos as a library — no MCP involved.
 * Run: npx tsx examples/library.ts path/to/meeting.mp4
 */
import { createOllos, type TranscribeResult, type ReviewResult } from 'ollos-mcp'

const file = process.argv[2]
if (!file) throw new Error('pass a media file')

const ollos = createOllos({ concurrency: { asr: 1, vision: 2, ocr: 2, download: 2, light: 4 } })

// 1. What is it?
const info = await ollos.probe(file)
console.log(`${info.kind}, ${Math.round(info.durationSec)} s, ${info.video ? `${info.video.width}×${info.video.height}` : 'audio only'}`)

// 2. Transcribe with a glossary. Small inputs return inline; large ones return a job to await.
const t = await ollos.transcribe({ source: file, language: 'pt', vocabulary: ['Claude Code', 'n8n', 'webhook'] })
const transcript = t.result ?? (await ollos.wait<TranscribeResult>(t.job.id)).result!
console.log(`${transcript.segments.length} segments, ${transcript.stats.wordCount} words, ${transcript.stats.filteredCount} hallucinations removed`)
for (const s of transcript.segments.slice(0, 3)) console.log(`  [${s.startSec.toFixed(1)}s] ${s.text}`)

// 3. Review before publishing (skip the slow OCR check here).
const r = await ollos.review({ source: file, platform: 'youtube', checks: ['loudness', 'silences', 'aspect'] })
const review = r.result ?? (await ollos.wait<ReviewResult>(r.job.id)).result!
console.log(`verdict: ${review.verdict}`)
for (const f of review.findings) console.log(`  [${f.severity}] ${f.title}`)

// 4. Ask a question across everything transcribed so far.
const hits = await ollos.search({ query: 'próximos passos', k: 3 })
for (const h of hits.hits) console.log(`  ${h.startSec.toFixed(1)}s ${h.text.slice(0, 80)}`)
