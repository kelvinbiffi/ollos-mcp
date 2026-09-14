// Probe: how consistent are speaker embeddings for one voice across positions, lengths and acoustic conditions?
// Usage: npx tsx scripts/probe-speaker-embeddings.mts  (needs eval/fixtures.local.json from `npm run eval:fetch`)
// Measured 2026-09-14 on the IBM fixture: same voice 0.58–0.86 (2 s cuts included); the same voice over background
// music (44–48 s, 212–226 s outro) 0.06–0.16 against clean speech and 0.67 between the two music regions.
import fs from 'node:fs'
import { loadConfig } from '../src/core/config.js'
import { decodePcm16k } from '../src/core/media/decode.js'
import { speakerEmbeddings, cosine } from '../src/core/audio/diarize.js'
const local = JSON.parse(fs.readFileSync('eval/fixtures.local.json', 'utf8'))
const config = loadConfig()
const pcm = await decodePcm16k(local['ibm-what-is-mcp'], config, {})
// same voice, different places/lengths. A/B/C inside the long SPEAKER_00 turn; D/E are "SPEAKER_01" turns; F/G short 2 s cuts inside the long turn
const wins = { A_10_15: [10, 15], B_20_25: [20, 25], C_70_78: [70, 78], D_44_48: [44.3, 48.8], E_60_64: [60.0, 64.8], F_12_14: [12, 14], G_30_32: [30, 32], H_212_226: [212, 226] } as Record<string, [number, number]>
const names = Object.keys(wins)
const emb = await speakerEmbeddings(pcm, names.map((n) => ({ start: wins[n]![0], end: wins[n]![1] })), config)
console.log('dims', emb[0]!.length, 'first values', Array.from(emb[0]!.slice(0, 4)).map((x) => x.toFixed(3)))
console.log(''.padEnd(10) + names.map((n) => n.padStart(9)).join(''))
for (let i = 0; i < names.length; i++) console.log(names[i]!.padEnd(10) + emb.map((e) => cosine(emb[i]!, e).toFixed(2).padStart(9)).join(''))
