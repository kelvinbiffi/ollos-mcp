import type { OllosConfig } from '../config.js'
import { ASR_SAMPLE_RATE } from '../media/decode.js'
import { ensureFile, modelCatalog } from '../models.js'
import { loadOrt, type OrtTensor } from '../ort.js'

export interface SpeechRegion {
  startSec: number
  endSec: number
}

export interface VadResult {
  regions: SpeechRegion[]
  speechSec: number
  totalSec: number
  engine: 'silero' | 'energy'
  /** Set when Silero could not run and the energy gate was used. */
  fallbackReason?: string
}

const WINDOW = 512 // Silero v5 at 16 kHz

/**
 * Silero VAD through the single shared ONNX Runtime. Whisper never sees audio Silero says has no speech —
 * that alone removes most hallucinations and 20–40% of a meeting's runtime.
 * Falls back to an energy detector if the model cannot load, so transcription never depends on it.
 */
export async function detectSpeech(pcm: Float32Array, config: OllosConfig, opts: { threshold?: number; minSpeechMs?: number; minSilenceMs?: number; padMs?: number } = {}): Promise<VadResult> {
  const threshold = opts.threshold ?? 0.5
  const minSpeech = (opts.minSpeechMs ?? 250) / 1000
  const minSilence = (opts.minSilenceMs ?? 350) / 1000
  const pad = (opts.padMs ?? 150) / 1000
  const totalSec = pcm.length / ASR_SAMPLE_RATE

  let probs: Float32Array
  let engine: VadResult['engine'] = 'silero'
  let fallbackReason: string | undefined
  try {
    probs = await sileroProbabilities(pcm, config)
  } catch (e) {
    engine = 'energy'
    fallbackReason = e instanceof Error ? e.message : String(e)
    probs = energyProbabilities(pcm)
  }

  const frameSec = WINDOW / ASR_SAMPLE_RATE
  const raw: SpeechRegion[] = []
  let inSpeech = false
  let start = 0
  let silentSince = -1
  for (let i = 0; i < probs.length; i++) {
    const t = i * frameSec
    const p = probs[i]!
    if (!inSpeech) {
      if (p >= threshold) {
        inSpeech = true
        start = t
        silentSince = -1
      }
    } else if (p < threshold * 0.7) {
      if (silentSince < 0) silentSince = t
      if (t - silentSince >= minSilence) {
        raw.push({ startSec: start, endSec: silentSince })
        inSpeech = false
        silentSince = -1
      }
    } else {
      silentSince = -1
    }
  }
  if (inSpeech) raw.push({ startSec: start, endSec: totalSec })

  const regions: SpeechRegion[] = []
  for (const r of raw) {
    if (r.endSec - r.startSec < minSpeech) continue
    const s = Math.max(0, r.startSec - pad)
    const e = Math.min(totalSec, r.endSec + pad)
    const last = regions[regions.length - 1]
    if (last && s <= last.endSec) last.endSec = e
    else regions.push({ startSec: s, endSec: e })
  }
  const speechSec = regions.reduce((a, r) => a + (r.endSec - r.startSec), 0)
  return { regions, speechSec, totalSec, engine, fallbackReason }
}

async function sileroProbabilities(pcm: Float32Array, config: OllosConfig): Promise<Float32Array> {
  const ort = loadOrt()
  const spec = modelCatalog(config).find((m) => m.role === 'vad')!
  const file = await ensureFile(spec.file!.url, spec.file!.dest, config)
  const session = await ort.InferenceSession.create(file, { intraOpNumThreads: 1, logSeverityLevel: 3 })
  try {
    const n = Math.floor(pcm.length / WINDOW)
    const out = new Float32Array(n)
    const inputName = session.inputNames.find((x) => x === 'input') ?? session.inputNames[0]!
    const stateName = session.inputNames.find((x) => /state/i.test(x)) ?? 'state'
    const srName = session.inputNames.find((x) => /^sr$/i.test(x)) ?? 'sr'
    const outName = session.outputNames.find((x) => x === 'output') ?? session.outputNames[0]!
    const stateOut = session.outputNames.find((x) => /state/i.test(x)) ?? session.outputNames[1]!
    let state: OrtTensor = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128])
    const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(ASR_SAMPLE_RATE)]), [1])
    for (let i = 0; i < n; i++) {
      const chunk = new Float32Array(pcm.buffer, pcm.byteOffset + i * WINDOW * 4, WINDOW)
      const res = await session.run({ [inputName]: new ort.Tensor('float32', chunk, [1, WINDOW]), [stateName]: state, [srName]: sr })
      out[i] = (res[outName]!.data as Float32Array)[0]!
      state = res[stateOut]!
    }
    return out
  } finally {
    await session.release()
  }
}

/** Adaptive RMS gate. Not as good as Silero, but has no dependencies and always works. */
function energyProbabilities(pcm: Float32Array): Float32Array {
  const n = Math.floor(pcm.length / WINDOW)
  const rms = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = i * WINDOW; j < (i + 1) * WINDOW; j++) s += pcm[j]! * pcm[j]!
    rms[i] = Math.sqrt(s / WINDOW)
  }
  const sorted = Float32Array.from(rms).sort()
  const noise = sorted[Math.floor(sorted.length * 0.2)] ?? 0
  const loud = sorted[Math.floor(sorted.length * 0.9)] ?? 1
  const span = Math.max(1e-6, loud - noise)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.max(0, (rms[i]! - noise) / span))
  return out
}
