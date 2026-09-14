/**
 * Every failure Ollos raises carries a stable code, a human message and a next step.
 * Agents branch on `code`; people read `message` and `hint`.
 */
export type OllosErrorCode =
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_UNSUPPORTED'
  | 'UNSUPPORTED_TASK_FOR_KIND'
  | 'DOWNLOAD_FAILED'
  | 'DOWNLOAD_TOO_LARGE'
  | 'PRIVATE_ADDRESS_BLOCKED'
  | 'YTDLP_MISSING'
  | 'YTDLP_FAILED'
  | 'FFMPEG_MISSING'
  | 'FFMPEG_FAILED'
  | 'MODEL_MISSING_OFFLINE'
  | 'MODEL_LOAD_FAILED'
  | 'DURATION_EXCEEDED'
  | 'PIPELINE_EMPTY_OUTPUT'
  | 'JOB_NOT_FOUND'
  | 'JOB_NOT_CANCELLABLE'
  | 'INVALID_ARGUMENT'
  | 'CANCELLED'
  | 'INTERNAL'

export class OllosError extends Error {
  readonly code: OllosErrorCode
  readonly hint?: string
  readonly details?: Record<string, unknown>

  constructor(code: OllosErrorCode, message: string, opts: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'OllosError'
    this.code = code
    this.hint = opts.hint
    this.details = opts.details
  }

  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint, details: this.details }
  }
}

export function isOllosError(e: unknown): e is OllosError {
  return e instanceof OllosError
}

/** Wrap anything into an OllosError without losing the original. */
export function asOllosError(e: unknown, fallback: OllosErrorCode = 'INTERNAL'): OllosError {
  if (isOllosError(e)) return e
  if (e instanceof Error) {
    if (e.name === 'AbortError') return new OllosError('CANCELLED', 'Operation was cancelled', { cause: e })
    return new OllosError(fallback, e.message, { cause: e })
  }
  return new OllosError(fallback, String(e))
}
