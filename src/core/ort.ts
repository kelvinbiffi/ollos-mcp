import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * ONNX Runtime must be loaded exactly once per process. Two copies of the native binding (ours and
 * transformers.js's) measured as an API-version mismatch followed by a segfault. So we never depend on
 * onnxruntime-node ourselves: we resolve the copy transformers.js resolves, from its own directory.
 */
export interface OrtTensor {
  readonly data: Float32Array | BigInt64Array | Int32Array | Uint8Array
  readonly dims: readonly number[]
  readonly type: string
}
export interface OrtTensorCtor {
  new (type: 'float32', data: Float32Array, dims: number[]): OrtTensor
  new (type: 'int64', data: BigInt64Array, dims: number[]): OrtTensor
}
export interface OrtSession {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>
  release(): Promise<void>
}
export interface OrtModule {
  InferenceSession: { create(path: string, options?: { intraOpNumThreads?: number; logSeverityLevel?: number }): Promise<OrtSession> }
  Tensor: OrtTensorCtor
}

let cached: OrtModule | undefined

export function loadOrt(): OrtModule {
  if (cached) return cached
  const entry = fileURLToPath(import.meta.resolve('@huggingface/transformers'))
  const req = createRequire(entry)
  cached = req('onnxruntime-node') as OrtModule
  return cached
}
