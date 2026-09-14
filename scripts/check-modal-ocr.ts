// Direct check: native-width frame at the API-key modal, OCR with centre tile, masked secret scan.
import { loadConfig } from '../src/core/config.js'
import { extractFrame } from '../src/core/vision/frames.js'
import { ocrFrame, terminateOcr } from '../src/core/vision/ocr.js'
import { scanText } from '../src/core/vision/secrets.js'
const [file, at = '170.07'] = process.argv.slice(2)
const config = loadConfig()
const jpeg = await extractFrame(file!, Number(at), config, { width: 3840 })
const t0 = Date.now()
const r = await ocrFrame(jpeg, config)
console.log(`ocr ${((Date.now() - t0) / 1000).toFixed(1)}s | ${r.blocks.length} blocks | conf ${r.meanConfidence}% | tiles seen: ${[...new Set(r.blocks.map((b) => b.tile))].join(',')}`)
console.log('title read:', /api ?key ?created/i.test(r.text), '| "copy your API key":', /copy your api key/i.test(r.text))
const f = scanText(r.text, { pts: Number(at), frameIndex: 0 })
for (const x of f) console.log(`  [${x.confidence}] ${x.kind} ${x.masked} (${x.length} chars) signals=${x.signals.join('+')}${x.context ? ` ctx="${x.context}"` : ''}`)
if (!f.length) console.log('  (no findings)')
await terminateOcr()
