// Talks real MCP over stdio to the server, like Claude Code would. Usage: npx tsx scripts/smoke-mcp.ts <file>
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const file = process.argv[2]
if (!file) throw new Error('usage: smoke-mcp <file>')

const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp/bin.ts'], stderr: 'pipe' })
const client = new Client({ name: 'smoke', version: '0.0.0' })
transport.stderr?.on('data', (d: Buffer) => process.stderr.write('  [server] ' + d.toString()))
await client.connect(transport)
const info = client.getServerVersion()
console.log(`connected to ${info?.name} ${info?.version}`)

const tools = await client.listTools()
console.log(`tools (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(', '))
const bad = tools.tools.filter((t) => !t.description || t.description.length < 200)
if (bad.length) console.log('  descriptions too short:', bad.map((t) => t.name))

const templates = await client.listResourceTemplates()
console.log(`resource templates (${templates.resourceTemplates.length}):`, templates.resourceTemplates.map((t) => t.uriTemplate).join(' '))

let t0 = Date.now()
const probe = await client.callTool({ name: 'ollos_probe', arguments: { source: file } })
console.log(`\nollos_probe (${Date.now() - t0}ms):`, (probe.content as Array<{ type: string; text?: string }>)[0]?.text)
console.log('  structured kind:', (probe.structuredContent as { kind?: string })?.kind)

t0 = Date.now()
const review = await client.callTool({ name: 'ollos_review', arguments: { source: file, checks: ['aspect', 'loudness'], from: '0', to: '60' } })
const sc = review.structuredContent as { status: string; jobId?: string; etaSeconds?: number }
console.log(`\nollos_review aspect+loudness on 60s (${Date.now() - t0}ms): status=${sc.status}${sc.etaSeconds ? ` eta=${sc.etaSeconds}s` : ''}`)
if (sc.status !== 'completed' && sc.jobId) {
  // poll like an agent would
  while (true) {
    await new Promise((r) => setTimeout(r, 1500))
    const j = await client.callTool({ name: 'ollos_job', arguments: { jobId: sc.jobId } })
    const js = j.structuredContent as { status: string }
    if (js.status === 'completed' || js.status === 'failed') {
      console.log((j.content as Array<{ text?: string }>)[0]?.text)
      break
    }
  }
} else console.log((review.content as Array<{ text?: string }>)[0]?.text)

// read_screen inside the MCP process: exercises Tesseract (which prints to stdout) while the protocol must survive
t0 = Date.now()
const rs = await client.callTool({ name: 'ollos_read_screen', arguments: { source: file, from: '2:48', to: '2:56', maxFrames: 3 } })
let rsc = rs.structuredContent as { status: string; jobId?: string }
console.log(`\nollos_read_screen 2:48–2:56 (${Date.now() - t0}ms): status=${rsc.status}${rsc.jobId ? ' job=' + rsc.jobId : ''}`)
while (rsc.status !== 'completed' && rsc.status !== 'failed' && rsc.jobId) {
  await new Promise((r) => setTimeout(r, 2000))
  const j = await client.callTool({ name: 'ollos_job', arguments: { jobId: rsc.jobId } })
  rsc = j.structuredContent as { status: string; jobId?: string }
  if (rsc.status === 'completed' || rsc.status === 'failed') console.log((j.content as Array<{ text?: string }>)[0]?.text?.split('\n').slice(0, 9).join('\n'))
}
console.log(`  read_screen total ${((Date.now() - t0) / 1000).toFixed(1)}s — protocol still alive`)

const missing = await client.callTool({ name: 'ollos_job', arguments: { jobId: 'j_nope' } })
console.log(`\nollos_job on unknown id → isError=${missing.isError}:`, (missing.content as Array<{ text?: string }>)[0]?.text?.split('\n')[0])

const jobs = await client.readResource({ uri: 'ollos://jobs' })
console.log(`\nresource ollos://jobs → ${JSON.parse((jobs.contents[0] as { text: string }).text).length} job(s)`)

await client.close()
console.log('\nMCP smoke OK')
