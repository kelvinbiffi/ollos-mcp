// Smoke test for keyframes + review on a real video window. Usage: npx tsx scripts/smoke-vision.ts <file> [from] [to]
import { createOllos } from '../src/core/index.js'
import type { KeyframesResult, ReviewResult } from '../src/core/index.js'

const [file, from = '0', to = '240'] = process.argv.slice(2)
if (!file) throw new Error('usage: smoke-vision <file> [from] [to]')
const ollos = createOllos()

async function follow<R>(label: string, submit: Promise<{ job: { id: string; status: string } }>): Promise<R> {
  const t0 = Date.now()
  const { job } = await submit
  console.log(`\n[${label}] job ${job.id} status=${job.status} (returned in ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  let last = ''
  while (true) {
    const j = ollos.job(job.id)!
    const line = `${j.status} ${j.progress.stage} ${(j.progress.fraction * 100).toFixed(0)}% ${j.progress.message}`
    if (line !== last) {
      console.log('  ', line)
      last = line
    }
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(j.status)) break
    await new Promise((r) => setTimeout(r, 1500))
  }
  const done = await ollos.wait<R>(job.id)
  if (done.job.status !== 'completed') {
    console.log('  ERROR', JSON.stringify(done.job.error, null, 2))
    process.exit(1)
  }
  console.log(`  total ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return done.result!
}

console.log('probe:', JSON.stringify(await ollos.probe(file)).slice(0, 300))

const kf = await follow<KeyframesResult>('keyframes', ollos.keyframes({ source: file, fromSec: Number(from), toSec: Number(to), presenterRegion: { x: 0, y: 0.55, w: 0.25, h: 0.45 } }))
console.log(`  frames=${kf.frames.length} sheets=${kf.sheets.length} | sampled=${kf.stats.sampled} afterHash=${kf.stats.afterHash} cuts=${kf.stats.cuts} floor=${kf.stats.floorAdded} pruned=${kf.stats.pruned} | cached=${kf.cached}`)
console.log('  sources:', Object.entries(kf.frames.flatMap((f) => f.sources).reduce<Record<string, number>>((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {})).map(([k, v]) => `${k}=${v}`).join(' '))
console.log('  first sheet:', kf.sheets[0]?.file)

const rv = await follow<ReviewResult>('review', ollos.review({ source: file, fromSec: Number(from), toSec: Number(to), platform: 'youtube', presenterRegion: { x: 0, y: 0.55, w: 0.25, h: 0.45 } }))
console.log(`  verdict=${rv.verdict} platform=${rv.platform}`)
for (const f of rv.findings) console.log(`   [${f.severity}] ${f.title}${f.atSec !== undefined ? ` @${f.atSec.toFixed(1)}s` : ''}\n        ${f.detail.slice(0, 220)}`)
console.log('  report:', rv.artifacts.md)
