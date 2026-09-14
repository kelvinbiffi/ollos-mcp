/**
 * Fetch fixture media through ollos' own source resolver (exercises the yt-dlp path) and write eval/fixtures.local.json.
 *
 *   OLLOS_YTDLP=~/.ollos/bin/yt-dlp npx tsx eval/fetch.ts [fixtureId]
 *
 * Media lands in $OLLOS_HOME/cache/download/<hash>/media.mp4 and is never committed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/core/config.js'
import { resolveSource } from '../src/core/source/resolve.js'

interface Fixture {
  id: string
  url: string
  durationSec: number
}

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(fs.readFileSync(path.join(here, 'fixtures.json'), 'utf8')) as Fixture[]
const localPath = path.join(here, 'fixtures.local.json')
const local: Record<string, string> = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {}
const only = process.argv[2]
const config = loadConfig()

for (const f of fixtures) {
  if (only && f.id !== only) continue
  if (local[f.id] && fs.existsSync(local[f.id]!)) {
    console.log(`[${f.id}] already here: ${local[f.id]}`)
    continue
  }
  const t0 = Date.now()
  process.stdout.write(`[${f.id}] fetching ${f.url} … `)
  try {
    const src = await resolveSource(f.url, config)
    local[f.id] = src.path
    const drift = Math.abs(src.info.durationSec - f.durationSec)
    console.log(`ok in ${((Date.now() - t0) / 1000).toFixed(0)} s → ${src.path} (${src.info.kind}, ${Math.round(src.info.durationSec)} s${drift > 3 ? `, expected ${f.durationSec} s!` : ''})`)
  } catch (e) {
    const err = e as { code?: string; message: string; hint?: string; details?: { stderrTail?: string } }
    console.log(`FAILED ${err.code ?? ''} ${err.message}${err.hint ? `\n  hint: ${err.hint}` : ''}${err.details?.stderrTail ? `\n  yt-dlp said: ${err.details.stderrTail.trim().split('\n').slice(-4).join('\n               ')}` : ''}`)
  }
  fs.writeFileSync(localPath, JSON.stringify(local, null, 2))
}
console.log(`\nwrote ${localPath} with ${Object.keys(local).length} entr${Object.keys(local).length === 1 ? 'y' : 'ies'}`)
