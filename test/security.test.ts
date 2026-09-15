import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/core/config.js'
import { JobStore, assertJobId } from '../src/core/jobs/store.js'
import { isPrivateAddress } from '../src/core/source/ssrf.js'
import { redactText, scanText, scanTextDetailed } from '../src/core/vision/secrets.js'
import { OcrPool } from '../src/core/vision/ocr.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ollos-sec-'))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

describe('job ids never become paths', () => {
  const store = new JobStore(loadConfig({ home }))
  it.each(['..', 'j_..', 'j_..\\..\\x', '../../etc', 'j_0123456789ab/../x', 'ollos://jobs/x', 'j_0123456789AB', 'j_0123456789abc', ''])('rejects %j', (id) => {
    expect(() => assertJobId(id)).toThrow(/no job/)
    expect(() => store.dir(id)).toThrow(/no job/)
    expect(() => store.artifactsDir(id)).toThrow(/no job/)
    expect(store.load(id)).toBeUndefined()
    expect(store.loadResult(id)).toBeUndefined()
    expect(store.readEvents(id)).toEqual([])
  })
  it('accepts a minted id and does not create directories on read paths', () => {
    expect(assertJobId('j_0123456789ab')).toBe('j_0123456789ab')
    store.artifactsDir('j_0123456789ab')
    store.load('j_0123456789ab')
    expect(fs.existsSync(path.join(home, 'jobs', 'j_0123456789ab'))).toBe(false)
    expect(fs.existsSync(store.ensureArtifactsDir('j_0123456789ab'))).toBe(true)
  })
})

describe('SSRF guard covers IPv6 transition addresses', () => {
  it.each([
    ['64:ff9b::7f00:1', true], // NAT64 → 127.0.0.1
    ['64:ff9b::a9fe:a9fe', true], // NAT64 → 169.254.169.254
    ['64:ff9b::808:808', false], // NAT64 → 8.8.8.8
    ['64:ff9b:1::1', true], // local-use NAT64
    ['2002:c0a8:101::', true], // 6to4 → 192.168.1.1
    ['2002:808:808::', false], // 6to4 → 8.8.8.8
    ['2001:0:c0a8:101::', true], // Teredo server 192.168.1.1
    ['2001:db8::1', true], // documentation
    ['::ffff:10.0.0.1', true],
    ['0:0:0:0:0:ffff:a00:1', true], // same address, other spelling
    ['fe80::1', true],
    ['fd00::1', true],
    ['2606:4700:4700::1111', false],
    ['198.51.100.7', true], // TEST-NET-2
    ['100.64.0.1', true], // CGNAT
    ['1.1.1.1', false],
    ['not-an-ip', true],
  ])('%s → private %s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected)
  })
})

describe('OCR text is redacted with the same masks as the findings', () => {
  const key = 'sk-proj-Ab3dEf7hIj9kLmN2pQr5tUvW8xYz1aBcDeFgHiJkLmNoPqRsTuVwXyZ01234'
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  const text = `API Key Created\nMake sure to copy it now:\n${key}\nAuthorization: Bearer ${jwt}\nunrelated prose stays`
  it('scanText finds them and the raw values are not in the findings', () => {
    const findings = scanText(text)
    expect(findings.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(findings)).not.toContain(key)
    expect(JSON.stringify(findings)).not.toContain(jwt)
  })
  it('redactText removes every raw value, keeps the prose, and uses the masked form', () => {
    const scan = scanTextDetailed(text)
    const redacted = redactText(text, scan.raws)
    expect(redacted).not.toContain(key)
    expect(redacted).not.toContain(jwt)
    expect(redacted).toContain('unrelated prose stays')
    expect(redacted).toContain('API Key Created')
    // nested findings (a bearer token contains a JWT) collapse into the outer mask; the key stands alone
    expect(redacted).toContain('sk-p…234')
    expect(redacted).toMatch(/Bear…w5c|eyJh…w5c/)
  })
  it('redacts a value OCR split with spaces', () => {
    const spaced = key.slice(0, 20) + ' ' + key.slice(20, 40) + '  ' + key.slice(40)
    const scan = scanTextDetailed(`key: ${spaced}`)
    expect(scan.raws.some((r) => r.replace(/\s+/g, '') === key)).toBe(true)
    const redacted = redactText(`key: ${spaced}`, scan.raws)
    expect(redacted.replace(/\s+/g, '')).not.toContain(key)
  })
})

describe('OCR pool does not poison itself when a worker fails to start', () => {
  const config = loadConfig({ home })
  it('two failed creations, then a working one, then waiters are served', async () => {
    let calls = 0
    const fake = { terminate: async () => {} } as never
    const pool = new OcrPool(2, ['eng'], config, async () => {
      calls++
      if (calls <= 2) throw new Error(`boom ${calls}`)
      return fake
    })
    await expect(pool.acquire()).rejects.toThrow('boom 1')
    await expect(pool.acquire()).rejects.toThrow('boom 2')
    const w = await pool.acquire() // created counter was rolled back: a third attempt is allowed
    expect(w).toBe(fake)
    const second = await pool.acquire() // pool size 2 → a second worker is created
    expect(second).toBe(fake)
    const third = pool.acquire() // now full: must wait
    pool.release(w)
    expect(await third).toBe(fake)
  })
  it('a waiter leaves when its job is cancelled', async () => {
    const fake = { terminate: async () => {} } as never
    const pool = new OcrPool(1, ['eng'], config, async () => fake)
    const held = await pool.acquire()
    const ctrl = new AbortController()
    const waiting = pool.acquire(ctrl.signal)
    ctrl.abort()
    await expect(waiting).rejects.toThrow(/cancelled/)
    pool.release(held)
    expect(await pool.acquire()).toBe(fake)
  })
})
