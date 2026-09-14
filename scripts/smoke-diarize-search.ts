// Diarize a window (single speaker → expect one cluster), then search across everything indexed.
// Usage: npx tsx scripts/smoke-diarize-search.ts <file> [from] [to]
import { createOllos, type DiarizeResult } from '../src/core/index.js'
import { formatDiarize, formatSearch } from '../src/mcp/format.js'

const [file, from = '60', to = '180'] = process.argv.slice(2)
if (!file) throw new Error('usage: smoke-diarize-search <file> [from] [to]')
const ollos = createOllos()

const t0 = Date.now()
const { job } = await ollos.diarize({ source: file, fromSec: Number(from), toSec: Number(to) })
console.log(`[diarize] job ${job.id} status=${job.status}`)
let last = ''
while (true) {
  const j = ollos.job(job.id)!
  const line = `${j.status} ${j.progress.stage} ${Math.round(j.progress.fraction * 100)}% ${j.progress.message}`
  if (line !== last) {
    console.log('  ', line)
    last = line
  }
  if (['completed', 'failed', 'cancelled', 'interrupted'].includes(j.status)) break
  await new Promise((r) => setTimeout(r, 1500))
}
const done = await ollos.wait<DiarizeResult>(job.id)
if (done.job.status !== 'completed') {
  console.log('  ERROR', JSON.stringify(done.job.error, null, 2))
  process.exit(1)
}
console.log(`  total ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(formatDiarize(done.result!, job.id, 'concise', 1e9))
console.log(`  stats: ${JSON.stringify(done.result!.stats)} · events: ${ollos.events(job.id).map((e) => `${e.stage}:${e.event}${e.durationMs ? '(' + e.durationMs + 'ms)' : ''}`).join(' ')}`)

for (const q of ['MCP servers', 'configuração do Claude Code', 'webhook']) {
  const t1 = Date.now()
  const r = await ollos.search({ query: q, k: 3 })
  console.log(`\n[search] "${q}" → ${r.hits.length} hits in ${Date.now() - t1}ms (indexed jobs: ${r.indexedJobs})`)
  console.log(formatSearch(r).split('\n').slice(2, 8).join('\n'))
}
