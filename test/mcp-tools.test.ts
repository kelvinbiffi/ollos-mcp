import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Ollos } from '../src/core/index.js'
import { createServer } from '../src/mcp/server.js'
import { resolveBinaries, run } from '../src/core/media/ffmpeg.js'

/**
 * The MCP layer (tool schemas, annotations, wiring) had zero test coverage: every existing test calls the
 * pipeline functions directly, never a tool by name through the protocol. That let two real gaps ship
 * unnoticed — tool annotations missing three of the four required hints, and structuredContent with no
 * size budget (issue #2) — and it is what an external MCP directory audit flags first. This connects a
 * real client to the real server over an in-memory transport, the way any MCP host actually would.
 */
const dir = path.resolve('.ollos-test-mcp')
const clip = path.join(dir, 'clip.mp4')

const EXPECTED_TOOLS = ['ollos_probe', 'ollos_transcribe', 'ollos_keyframes', 'ollos_read_screen', 'ollos_review', 'ollos_diarize', 'ollos_search', 'ollos_frames', 'ollos_job', 'ollos_cancel'] as const

let client: Client
let cleanupClient: () => Promise<void>

beforeAll(async () => {
  fs.mkdirSync(dir, { recursive: true })
  const ollos = new Ollos({ home: path.join(dir, 'home') })
  const { ffmpeg } = resolveBinaries(ollos.config)
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=2,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip])

  const server = createServer(ollos)
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  cleanupClient = () => client.close()
})
afterAll(async () => {
  await cleanupClient()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('MCP tool registration', () => {
  it('exposes exactly the 10 documented tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([...EXPECTED_TOOLS].sort())
  })

  it.each(EXPECTED_TOOLS)('%s declares all four annotation hints as booleans', async (name) => {
    const { tools } = await client.listTools()
    const tool = tools.find((t) => t.name === name)
    expect(tool, `${name} missing from listTools`).toBeDefined()
    const a = tool!.annotations ?? {}
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
      expect(typeof a[hint], `${name}.${hint}`).toBe('boolean')
    }
  })
})

describe('MCP tool calls', () => {
  it('ollos_probe reads a real file through the protocol', async () => {
    const res = await client.callTool({ name: 'ollos_probe', arguments: { source: clip } })
    expect(res.isError).not.toBe(true)
    expect((res.structuredContent as { kind?: string })?.kind).toBe('video')
  })

  it('ollos_job on an unknown id returns a structured error, not a protocol crash', async () => {
    const res = await client.callTool({ name: 'ollos_job', arguments: { jobId: 'j_does_not_exist' } })
    expect(res.isError).toBe(true)
    expect((res.structuredContent as { error?: { code?: string } })?.error?.code).toBe('JOB_NOT_FOUND')
  })

  it('ollos_cancel on an unknown id returns a structured error', async () => {
    const res = await client.callTool({ name: 'ollos_cancel', arguments: { jobId: 'j_does_not_exist' } })
    expect(res.isError).toBe(true)
  })

  it('ollos_frames on an unknown id returns a structured error', async () => {
    const res = await client.callTool({ name: 'ollos_frames', arguments: { jobId: 'j_does_not_exist' } })
    expect(res.isError).toBe(true)
  })

  it('ollos_search rejects a query below the 2-character minimum before running', async () => {
    // Not a real search: any query that reaches the handler loads the 465 MB embedding model, too heavy to
    // pay for in every CI job across three OSes. This still calls the tool by name through the real
    // protocol and exercises real input validation, just on the cheap side of the handler boundary.
    const res = await client.callTool({ name: 'ollos_search', arguments: { query: 'x' } })
    expect(res.isError).toBe(true)
    expect((res.content as Array<{ text?: string }>)[0]?.text).toMatch(/at least 2 character/)
  })
})
