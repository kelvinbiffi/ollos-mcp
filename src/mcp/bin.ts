#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

// stdout is the protocol channel; everything human goes to stderr.
const log = (...a: unknown[]) => console.error('[ollos-mcp]', ...a)

/**
 * Guard the protocol channel. Native/WASM libraries (Tesseract prints "Image too small to scale!!") and worker
 * threads write to stdout without asking; one stray line corrupts JSON-RPC framing and kills the session.
 * Only JSON-RPC messages may pass; anything else is diverted to stderr.
 */
function guardStdout(): void {
  const realWrite = process.stdout.write.bind(process.stdout)
  const looksLikeJsonRpc = (chunk: unknown): boolean => {
    const s = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8', 0, 64) : ''
    const t = s.trimStart()
    return t.startsWith('{"') || t.startsWith('{ "') || t.startsWith('[{')
  }
  ;(process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown, ...rest: unknown[]) => {
    if (looksLikeJsonRpc(chunk)) return realWrite(chunk as never, ...(rest as never[]))
    process.stderr.write(typeof chunk === 'string' || Buffer.isBuffer(chunk) ? chunk : String(chunk))
    const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined
    cb?.()
    return true
  }) as typeof process.stdout.write
  console.log = (...a: unknown[]) => console.error(...a)
  console.info = console.log
}

async function main() {
  guardStdout()
  const server = createServer()
  const transport = new StdioServerTransport()
  const shutdown = async (why: string) => {
    log(`shutting down (${why})`)
    try {
      await server.close()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.stdin.on('close', () => void shutdown('stdin closed'))
  await server.connect(transport)
  log('ready on stdio')
}

main().catch((e) => {
  log('fatal', e)
  process.exit(1)
})
