import { describe, expect, it } from 'vitest'
import { dhash, hamming, dedupByHash, SENSITIVITY_THRESHOLD } from '../src/core/vision/dhash.js'
import { collapseRepetition, filterSegment } from '../src/core/audio/hallucination.js'
import { applyVocabulary } from '../src/core/audio/vocabulary.js'
import { scanText, mask } from '../src/core/vision/secrets.js'
import { describeAspect } from '../src/core/media/probe.js'
import { isPrivateAddress } from '../src/core/source/ssrf.js'
import { planWindows } from '../src/core/pipelines/transcribe.js'
import { parseTime, fmtTime } from '../src/core/media/ffmpeg.js'

describe('dHash', () => {
  const gradient = new Uint8Array(72).map((_, i) => (i % 9) * 28) // brighter to the right → all bits 0
  const inverse = new Uint8Array(72).map((_, i) => 255 - (i % 9) * 28)
  it('identical thumbnails have distance 0', () => expect(hamming(dhash(gradient), dhash(gradient))).toBe(0))
  it('inverted gradient is maximally different', () => expect(hamming(dhash(gradient), dhash(inverse))).toBe(64))
  it('dedup keeps the first frame and drops near-duplicates', () => {
    const frames = [gradient, gradient, gradient, inverse, inverse].map((t, i) => ({ index: i, pts: i, hash: dhash(t) }))
    const kept = dedupByHash(frames, SENSITIVITY_THRESHOLD.normal)
    expect(kept.map((k) => k.index)).toEqual([0, 3])
    expect(kept[1]!.distance).toBe(64)
  })
})

describe('hallucination filters', () => {
  it('drops blocklisted phrases regardless of punctuation and case', () => {
    expect(filterSegment('Obrigado.', { durationSec: 2, speechRatio: 0.9 }).keep).toBe(false)
    expect(filterSegment('Thanks for watching!', { durationSec: 2, speechRatio: 0.9 }).flags).toContain('blocklist')
  })
  it('keeps ordinary speech', () => {
    const v = filterSegment('então aqui tem a configuração de cada um deles', { durationSec: 3, speechRatio: 0.9 })
    expect(v.keep).toBe(true)
    expect(v.flags).toEqual([])
  })
  it('collapses a repetition loop to one copy and flags it', () => {
    const loop = 'eu vou abrir aqui eu vou abrir aqui eu vou abrir aqui eu vou abrir aqui depois'
    const r = collapseRepetition(loop)
    expect(r.collapsed).toBe(true)
    expect(r.text).toBe('eu vou abrir aqui depois')
    expect(filterSegment(loop, { durationSec: 4, speechRatio: 0.9 }).flags).toContain('repetition_loop')
  })
  it('drops text under no speech', () => expect(filterSegment('qualquer coisa dita', { durationSec: 3, speechRatio: 0.05 }).keep).toBe(false))
})

describe('vocabulary correction', () => {
  it('fixes the phonetic confusion toward a supplied term', () => {
    const r = applyVocabulary('dentro do Cloud Code, pelo VS Code', ['Claude Code'])
    expect(r.text).toBe('dentro do Claude Code, pelo VS Code')
    expect(r.stats.replacements).toBe(1)
  })
  it('does not rewrite unrelated words', () => {
    const r = applyVocabulary('o clima estava bom', ['Claude'])
    expect(r.text).toBe('o clima estava bom')
    expect(r.stats.replacements).toBe(0)
  })
  it('is a no-op without a vocabulary', () => expect(applyVocabulary('x', undefined).text).toBe('x'))
})

describe('secret scanner', () => {
  it('masks values and never returns them whole', () => {
    const f = scanText('key: sk-abcdefghijklmnopqrstuvwxyz1234567890')
    expect(f.length).toBeGreaterThan(0)
    expect(f[0]!.masked).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(mask('sk-abcdefghijklmnopqrstuvwxyz1234567890')).toBe('sk-a…890')
  })
  it('flags strong patterns as high even without context', () => {
    expect(scanText('AKIAIOSFODNN7EXAMPLE')[0]!.confidence).toBe('high')
    expect(scanText('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c')[0]!.kind).toBe('jwt')
  })
  it('reads a private deployment URL even when OCR split it with spaces', () => {
    const f = scanText('URL: https://primary-production-eae8.up. railway .app/webhook/openai-blog')
    expect(f.some((x) => x.kind === 'private_url')).toBe(true)
  })
  it('uses UI context to raise an entropy-only finding', () => {
    const token = 'FKMDYxAQ9pL2mN8vB4cZ7rT1wY6uH3sJ0kGdE5fV2nM8qW1zX4cV7bN0mK3jH6gF9dS2aP5oI8uY1tR4eW7q'
    const withCtx = scanText(`API Key Created\n${token}\nMake sure to copy your API key now`)
    const bare = scanText(token)
    expect(withCtx.find((x) => x.kind === 'high_entropy_token')?.confidence).toBe('medium')
    expect(bare.find((x) => x.kind === 'high_entropy_token')?.confidence).toBe('low')
    expect(withCtx[0]!.signals).toContain('context')
  })
  it('ignores ordinary prose', () => expect(scanText('Então aqui tem a configuração para usar ele dentro do Claude Code.')).toEqual([]))

  // Regression: real false positives from the first review of an 11-minute screencast (58 of them).
  it.each([
    'Ifyouneedaccess to the workspace, keep building and ship every day',
    'updated 5 months ago · last commit 3 days ago · v2.6.1 · 745 stars',
    'Critical update available Please update to version 1.121.0 or higher More info',
    'mode: production · filter: latest · rename to test · 30 nodes · 086 items',
    'README Contributing MIT license Security Deploy on Railway 2,755 n8n nodes',
  ])('does not flag OCR-glued prose: %s', (s) => expect(scanText(s).filter((f) => f.confidence !== 'low')).toEqual([]))

  it('reads a JWT even when OCR mangles the eyJ header into eyl', () => {
    const f = scanText('MCP\neylhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c\nMake sure to copy your API key now')
    expect(f[0]).toMatchObject({ kind: 'jwt', confidence: 'high' })
  })
  it('keeps e-mail and CPF as low-confidence personal data, never blocking', () => {
    expect(scanText('contato: kelvin@example.com — secret').every((f) => f.confidence === 'low')).toBe(true)
    expect(scanText('CPF 123.456.789-09')[0]!.confidence).toBe('low')
  })
})

describe('aspect', () => {
  it('names 16:9 and marks fit', () => expect(describeAspect(1920, 1080)).toMatchObject({ ratio: '16:9', in16x9: 'fits' }))
  it('flags 1890×1080 as pillarboxed 7:4', () => expect(describeAspect(1890, 1080)).toMatchObject({ ratio: '7:4', in16x9: 'pillarbox', fits: [] }))
  it('recognises vertical video', () => expect(describeAspect(1080, 1920).fits).toContain('tiktok'))
})

describe('ssrf', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '100.64.0.1'])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true))
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '172.32.0.1'])('allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false))
})

describe('transcription windows', () => {
  it('merges tiny gaps and splits long runs with overlap', () => {
    const w = planWindows([
      { startSec: 0, endSec: 10 },
      { startSec: 10.3, endSec: 20 },
      { startSec: 40, endSec: 100 },
    ])
    expect(w[0]).toEqual({ startSec: 0, endSec: 20 })
    expect(w.length).toBeGreaterThan(2)
    for (const x of w) expect(x.endSec - x.startSec).toBeLessThanOrEqual(28)
    expect(w[1]!.startSec).toBe(40)
  })
})

describe('time helpers', () => {
  it('parses seconds, mm:ss and hh:mm:ss.ms', () => {
    expect(parseTime('90')).toBe(90)
    expect(parseTime('1:30')).toBe(90)
    expect(parseTime('0:01:30.5')).toBe(90.5)
  })
  it('formats', () => {
    expect(fmtTime(90.5)).toBe('1:30.5')
    expect(fmtTime(3661)).toBe('1:01:01.0')
  })
})
