import fs from 'node:fs'
import path from 'node:path'
import { assetPath } from '../paths.js'

let phrases: Set<string> | undefined

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every assets/blocklists/*.txt, one phrase per line, `#` comments. Hand-curated files and harvested ones are unioned. */
export function loadBlocklist(): Set<string> {
  if (phrases) return phrases
  phrases = new Set()
  const dir = assetPath('blocklists')
  if (!fs.existsSync(dir)) return phrases
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.txt')) continue
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      phrases.add(normalize(t))
    }
  }
  return phrases
}

export type HallucinationFlag = 'blocklist' | 'repetition_loop' | 'no_speech' | 'too_fast' | 'empty'

export interface FilterVerdict {
  keep: boolean
  text: string
  flags: HallucinationFlag[]
}

/**
 * Whisper's decoder is a language model: on silence it produces the most probable text, not nothing.
 * Four checks, all cheap: known phrase, repetition loop, no speech under it, impossible speaking rate.
 */
export function filterSegment(text: string, opts: { durationSec: number; speechRatio: number }): FilterVerdict {
  const flags: HallucinationFlag[] = []
  let out = text.trim()
  if (!out) return { keep: false, text: '', flags: ['empty'] }

  if (loadBlocklist().has(normalize(out))) flags.push('blocklist')

  const loop = collapseRepetition(out)
  if (loop.collapsed) {
    out = loop.text
    flags.push('repetition_loop')
  }

  if (opts.speechRatio < 0.15 && opts.durationSec >= 1) flags.push('no_speech')

  const words = out.split(/\s+/).filter(Boolean).length
  const rate = words / Math.max(0.5, opts.durationSec)
  if (rate > 8 && words >= 8) flags.push('too_fast') // >8 words/s is not human speech

  const keep = !flags.includes('blocklist') && !flags.includes('no_speech') && !flags.includes('empty')
  return { keep, text: out, flags }
}

/** Same 3–6 word phrase repeated 3+ times in a row → keep one copy. */
export function collapseRepetition(text: string): { text: string; collapsed: boolean } {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < 9) return { text, collapsed: false }
  for (let n = 3; n <= 6; n++) {
    for (let i = 0; i + n * 3 <= words.length; i++) {
      const unit = words.slice(i, i + n).map((w) => normalize(w)).join(' ')
      let reps = 1
      while (i + (reps + 1) * n <= words.length && words.slice(i + reps * n, i + (reps + 1) * n).map((w) => normalize(w)).join(' ') === unit) reps++
      if (reps >= 3) {
        const kept = [...words.slice(0, i + n), ...words.slice(i + reps * n)]
        return { text: kept.join(' '), collapsed: true }
      }
    }
  }
  return { text, collapsed: false }
}
