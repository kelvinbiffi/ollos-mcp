import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PathCache } from '../src/core/models.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollos-pathcache-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('PathCache (transformers.js model cache)', () => {
  const cache = new PathCache(dir)

  it('misses return undefined', async () => {
    expect(await cache.match('org/model/onnx/missing.onnx')).toBeUndefined()
  })

  it('serves ONNX weights as a path string so ONNX Runtime maps the file instead of Node buffering it', async () => {
    for (const name of ['onnx/encoder_model.onnx', 'onnx/encoder_model.onnx_data', 'onnx/decoder_model_merged_q4.onnx', 'onnx/model.onnx_data_1']) {
      const file = path.join(dir, 'org/model', name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, Buffer.alloc(16, 1))
      const hit = await cache.match(`org/model/${name}`)
      expect(typeof hit, name).toBe('string')
      expect(path.resolve(hit as string)).toBe(path.resolve(file))
    }
  })

  it('maps the remote-URL keys transformers.js uses for custom caches onto the FileCache layout', async () => {
    const hit = await cache.match('https://huggingface.co/org/model/resolve/main/onnx/encoder_model.onnx')
    expect(typeof hit).toBe('string')
    expect(path.resolve(hit as string)).toBe(path.resolve(path.join(dir, 'org/model/onnx/encoder_model.onnx')))
    expect(await cache.match('https://huggingface.co/org/model/resolve/main/onnx/nope.onnx')).toBeUndefined()
  })

  it('serves small JSON and text files as a Response with a body, because getModelJSON decodes a buffer', async () => {
    const file = path.join(dir, 'org/model/tokenizer_config.json')
    fs.writeFileSync(file, JSON.stringify({ model_type: 'whisper' }))
    const hit = await cache.match('org/model/tokenizer_config.json')
    expect(hit).toBeInstanceOf(Response)
    const res = hit as Response
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ model_type: 'whisper' })
  })

  it('put streams a download to disk atomically and reports progress', async () => {
    const payload = Buffer.alloc(300_000, 7)
    const chunks = [payload.subarray(0, 100_000), payload.subarray(100_000, 200_000), payload.subarray(200_000)]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new Uint8Array(c))
        controller.close()
      },
    })
    const response = new Response(body, { status: 200, headers: { 'content-length': String(payload.length) } })
    const progress: number[] = []
    await cache.put('org/model/onnx/model.onnx', response, (p) => progress.push(p.progress))
    const file = path.join(dir, 'org/model/onnx/model.onnx')
    expect(fs.readFileSync(file).equals(payload)).toBe(true)
    expect(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.tmp.'))).toBe(false)
    expect(progress.at(-1)).toBe(100)
    expect(await cache.match('org/model/onnx/model.onnx')).toBe(file)
  })
})
