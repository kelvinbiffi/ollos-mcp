// Smoke test: real video, real models, through the job engine. Usage: npx tsx scripts/smoke-transcribe.ts <file> [from] [to]
import { loadConfig } from '../src/core/config.js'
import { JobEngine } from '../src/core/jobs/engine.js'
import { runTranscribe, estimateTranscribeSeconds, type TranscribeParams, type TranscribeResult } from '../src/core/pipelines/transcribe.js'

const [file, from = '30', to = '90'] = process.argv.slice(2)
if (!file) throw new Error('usage: smoke-transcribe <file> [from] [to]')
const config = loadConfig()
const engine = new JobEngine(config)
engine.register<TranscribeParams, TranscribeResult>({
  kind: 'transcribe',
  resourceClass: 'asr',
  estimateSeconds: (p) => estimateTranscribeSeconds((p.toSec ?? 0) - (p.fromSec ?? 0), p.model),
  run: (p, ctx) => runTranscribe(p, ctx, config),
})

const params: TranscribeParams = { source: file, language: 'pt', fromSec: Number(from), toSec: Number(to), vocabulary: ['Claude Code', 'n8n', 'MCP', 'webhook', 'VS Code'] }

for (const round of [1, 2]) {
  const t0 = Date.now()
  const { job } = await engine.submit<TranscribeParams, TranscribeResult>('transcribe', params)
  console.log(`\n[round ${round}] job ${job.id} status=${job.status} (returned in ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  let last = ''
  while (true) {
    const j = engine.get(job.id)!
    const line = `${j.status} ${j.progress.stage} ${(j.progress.fraction * 100).toFixed(0)}% ${j.progress.message}`
    if (line !== last) {
      console.log('  ', line)
      last = line
    }
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(j.status)) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  const done = await engine.wait<TranscribeResult>(job.id)
  if (done.job.status !== 'completed') {
    console.log('  ERROR', JSON.stringify(done.job.error, null, 2))
    process.exit(1)
  }
  const r = done.result!
  console.log(`  total ${((Date.now() - t0) / 1000).toFixed(1)}s | cached=${r.cached} | vad=${r.vad.engine} speech=${r.vad.speechSec}s | model=${r.model}`)
  console.log(`  segments=${r.stats.segmentCount} filtered=${r.stats.filteredCount} words=${r.stats.wordCount} vocabFixes=${r.stats.vocabularyReplacements} lang=${r.language}`)
  for (const s of r.segments.slice(0, 6)) console.log(`   [${s.startSec.toFixed(1)}→${s.endSec.toFixed(1)} c=${s.confidence}${s.flags.length ? ' ' + s.flags.join(',') : ''}] ${s.text}`)
  console.log('  artifacts:', r.artifacts.txt)
  console.log('  events:', engine.store.readEvents(job.id).map((e) => `${e.stage}:${e.event}${e.durationMs ? '(' + e.durationMs + 'ms)' : ''}`).join(' '))
}
