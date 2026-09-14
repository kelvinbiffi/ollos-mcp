import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import type { OllosConfig } from '../config.js'
import { OllosError } from '../errors.js'
import { configureModelRuntime } from '../models.js'
import { ASR_SAMPLE_RATE } from '../media/decode.js'

export type AsrModelChoice = 'accurate' | 'fast'

export interface AsrChunk {
  text: string
  startSec: number
  endSec: number
}

export interface AsrOptions {
  language?: string // 'pt', 'en', … or undefined for auto
  model?: AsrModelChoice
  signal?: AbortSignal
}

const loaded = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>()

export function asrModelId(choice: AsrModelChoice | undefined, config: OllosConfig): string {
  return choice === 'fast' ? config.models.asrFast : config.models.asrAccurate
}

/**
 * One pipeline instance per model, shared across jobs. Two instances on one CPU measured slower than one,
 * so the engine's ASR semaphore is 1 and sharing the instance is the right shape.
 */
export function loadAsr(choice: AsrModelChoice | undefined, config: OllosConfig, onProgress?: (msg: string) => void): Promise<AutomaticSpeechRecognitionPipeline> {
  configureModelRuntime(config)
  const id = asrModelId(choice, config)
  let p = loaded.get(id)
  if (!p) {
    const accurate = id === config.models.asrAccurate
    p = pipeline('automatic-speech-recognition', id, {
      // fp32 encoder (2.43 GB on disk, memory-mapped by ONNX Runtime) + q4 decoder: ~4.3 GB peak RSS while transcribing.
      dtype: accurate ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : undefined,
      progress_callback: (ev: { status?: string; file?: string; progress?: number }) => {
        if (ev.status === 'progress' && ev.file) onProgress?.(`downloading ${ev.file} ${Math.round(ev.progress ?? 0)}%`)
      },
    } as never).catch((e: unknown) => {
      loaded.delete(id)
      const msg = e instanceof Error ? e.message : String(e)
      if (config.offline || /ENOTFOUND|fetch failed|ECONN/i.test(msg)) {
        throw new OllosError('MODEL_MISSING_OFFLINE', `model ${id} is not available locally and could not be downloaded`, { hint: 'Run "ollos warmup" once while online.', cause: e })
      }
      throw new OllosError('MODEL_LOAD_FAILED', `could not load ${id}: ${msg}`, { cause: e })
    }) as Promise<AutomaticSpeechRecognitionPipeline>
    loaded.set(id, p)
  }
  return p
}

/**
 * Transcribe one PCM window (≤ ~30 s recommended). Timestamps come back relative to the window;
 * the caller offsets them. Greedy decoding and no conditioning on previous text: both cut hallucination loops.
 */
export async function transcribeWindow(pcm: Float32Array, opts: AsrOptions, config: OllosConfig): Promise<AsrChunk[]> {
  const asr = await loadAsr(opts.model, config)
  if (opts.signal?.aborted) throw new OllosError('CANCELLED', 'cancelled')
  const durationSec = pcm.length / ASR_SAMPLE_RATE
  const out = (await asr(pcm, {
    language: opts.language,
    task: 'transcribe',
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    num_beams: 1,
    do_sample: false,
    condition_on_prev_tokens: false,
    no_repeat_ngram_size: 0,
  } as never)) as { text: string; chunks?: Array<{ text: string; timestamp: [number, number | null] }> }

  const chunks = out.chunks?.length ? out.chunks : [{ text: out.text, timestamp: [0, durationSec] as [number, number | null] }]
  return chunks
    .map((c) => ({ text: c.text.trim(), startSec: Math.max(0, c.timestamp[0] ?? 0), endSec: Math.min(durationSec, c.timestamp[1] ?? durationSec) }))
    .filter((c) => c.text.length > 0)
}
