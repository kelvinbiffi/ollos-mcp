import path from 'node:path'
import type { JobRecord } from '../core/jobs/types.js'
import { fmtTime } from '../core/media/ffmpeg.js'
import type { TranscribeResult } from '../core/pipelines/transcribe.js'
import type { KeyframesResult } from '../core/pipelines/keyframes.js'
import type { ReadScreenResult } from '../core/pipelines/readScreen.js'
import type { ReviewResult } from '../core/pipelines/review.js'
import type { DiarizeResult } from '../core/pipelines/diarize.js'
import type { SearchResult } from '../core/pipelines/search.js'

export type Format = 'concise' | 'detailed'

/** Portuguese and English run about 3.5–4 chars per token; we err on the side of counting more. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

export function truncateToBudget(text: string, budgetTokens: number, pointer: string): string {
  if (estimateTokens(text) <= budgetTokens) return text
  const keep = Math.max(200, budgetTokens * 3.5 - 200)
  return text.slice(0, keep) + `\n\n[…truncated to fit the response budget. Full content: ${pointer}]`
}

function capText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '…'
}

/** Keep segments in order until the next one would push `structuredContent` over budget. */
function capSegments<T>(segments: T[], budgetTokens: number): { segments: T[]; omitted: number } {
  let used = 0
  const kept: T[] = []
  for (const s of segments) {
    const t = estimateTokens(JSON.stringify(s))
    if (kept.length > 0 && used + t > budgetTokens) break
    used += t
    kept.push(s)
  }
  return { segments: kept, omitted: segments.length - kept.length }
}

/**
 * The token budget above applies to the text content; `structuredContent.result` had none of its own and
 * always carried the whole pipeline result. On a long `read_screen` job that is tens of thousands of OCR
 * bounding boxes in `frames[].blocks` — one real job hit ~62,000 characters and tripped a client's own
 * tool-result size limit before the client ever got to read it (issue #2). The text content and the job's
 * resource links (ocr.txt, transcript.txt, sheet images…) already carry the full detail, so this drops the
 * heaviest, most redundant field per kind and caps what free text remains, instead of shipping it twice.
 * Small results are returned unchanged — most jobs never come close to the budget.
 */
export function trimStructuredResult(kind: string, jobId: string, result: unknown, budgetTokens: number): unknown {
  if (result === null || typeof result !== 'object') return result
  if (estimateTokens(JSON.stringify(result)) <= budgetTokens) return result

  switch (kind) {
    case 'read_screen': {
      const r = result as ReadScreenResult
      const perFrame = Math.max(60, Math.floor(budgetTokens / Math.max(1, r.frames.length)))
      return {
        ...r,
        frames: r.frames.map((f) => ({ index: f.index, pts: f.pts, text: capText(f.text, perFrame * 3), meanConfidence: f.meanConfidence, secrets: f.secrets })),
        trimmedForResponse: `blocks omitted, text capped per frame — full detail at ${uris.ocr(jobId)}`,
      }
    }
    case 'keyframes': {
      const r = result as KeyframesResult
      return { ...r, frames: r.frames.map(({ hash, ...f }) => f), trimmedForResponse: 'perceptual hashes omitted' }
    }
    case 'transcribe': {
      const r = result as TranscribeResult
      const { segments, omitted } = capSegments(r.segments, budgetTokens)
      return { ...r, segments, trimmedForResponse: omitted > 0 ? `${omitted} of ${r.segments.length} segment(s) omitted — full transcript at ${uris.transcript(jobId)}` : undefined }
    }
    case 'diarize': {
      const r = result as DiarizeResult
      if (!r.segments) return r
      const { segments, omitted } = capSegments(r.segments, budgetTokens)
      return { ...r, segments, trimmedForResponse: omitted > 0 ? `${omitted} of ${r.segments.length} segment(s) omitted — full transcript at ${uris.transcriptSpeakers(jobId)}` : undefined }
    }
    default:
      return result
  }
}

/**
 * Text that came out of the media — speech, on-screen text — is data, never instructions.
 * We say so in the payload itself, so a client that concatenates blindly still carries the warning.
 */
export function untrusted(text: string): string {
  return `<untrusted-content source="media">\n${text}\n</untrusted-content>`
}

export const uris = {
  transcript: (id: string) => `ollos://jobs/${id}/transcript`,
  srt: (id: string) => `ollos://jobs/${id}/transcript.srt`,
  ocr: (id: string) => `ollos://jobs/${id}/ocr`,
  report: (id: string) => `ollos://jobs/${id}/report`,
  sheet: (id: string, n: number) => `ollos://jobs/${id}/sheet/${n}`,
  frame: (id: string, n: number) => `ollos://jobs/${id}/frame/${n}`,
  events: (id: string) => `ollos://jobs/${id}/events`,
  speakers: (id: string) => `ollos://jobs/${id}/speakers`,
  transcriptSpeakers: (id: string) => `ollos://jobs/${id}/transcript.speakers`,
}

export function formatTranscribe(r: TranscribeResult, jobId: string, format: Format, budget: number): string {
  const head = [
    `Transcript of ${path.basename(r.source.input)} — ${fmtTime(r.source.durationSec)}, language ${r.language}, model ${r.model.split('/').pop()}${r.cached ? ' (cached)' : ''}`,
    `${r.stats.segmentCount} segments · ${r.stats.wordCount} words · speech ${fmtTime(r.vad.speechSec)} (${r.vad.engine} VAD) · ${r.stats.filteredCount} hallucinated segment(s) removed${r.stats.vocabularyReplacements ? ` · ${r.stats.vocabularyReplacements} glossary fix(es)` : ''}`,
    `Full text: ${uris.transcript(jobId)} · SRT: ${uris.srt(jobId)}`,
  ].join('\n')
  const lines = r.segments.map((s) => `[${fmtTime(s.startSec)}${s.speaker ? ' ' + s.speaker : ''}${s.confidence < 0.6 ? ' ?' : ''}] ${s.text}`)
  if (format === 'concise') {
    let body = ''
    for (const l of lines) {
      if (body.length + l.length > 700) {
        body += `\n… (${lines.length} segments total; read the resource for all of them)`
        break
      }
      body += (body ? '\n' : '') + l
    }
    return head + '\n\n' + untrusted(body)
  }
  return head + '\n\n' + untrusted(truncateToBudget(lines.join('\n'), budget - estimateTokens(head) - 40, uris.transcript(jobId)))
}

export function formatKeyframes(r: KeyframesResult, jobId: string, format: Format): string {
  const head = [
    `Keyframes of ${path.basename(r.source.input)} — ${fmtTime(r.source.durationSec)}, ${r.source.width}×${r.source.height}${r.cached ? ' (cached)' : ''}`,
    `${r.frames.length} frames in ${r.sheets.length} contact sheet(s) · from ${r.stats.sampled} sampled: ${r.stats.afterHash} kept by perceptual hash (sensitivity ${r.params.sensitivity}), ${r.stats.cuts} hard cuts, ${r.stats.anchors} anchors, ${r.stats.floorAdded} floor frames, ${r.stats.pruned} pruned to max ${r.params.maxFrames}`,
    `Sheets: ${r.sheets.map((s) => uris.sheet(jobId, s.index)).join(' ')}`,
    `Use ollos_frames to see a sheet or a single frame as an image.`,
  ]
  if (format === 'detailed') {
    head.push('', 'frame  time      sheet/tile  why')
    for (const f of r.frames) head.push(`#${String(f.index).padStart(3)}  ${fmtTime(f.pts).padStart(8)}  ${f.sheet}/${f.tile}         ${f.sources.join('+')}${f.distance !== undefined ? ` (Δ${f.distance})` : ''}`)
  } else {
    head.push('', `Timeline: ${r.frames.map((f) => fmtTime(f.pts)).join(' ')}`)
  }
  return head.join('\n')
}

export function formatReadScreen(r: ReadScreenResult, jobId: string, format: Format, budget: number): string {
  const head = [
    `On-screen text of ${path.basename(r.source.input)} — ${r.stats.frames} frames read, ${r.stats.framesWithText} with text, ${r.stats.totalBlocks} blocks${r.cached ? ' (cached)' : ''}`,
    `Full OCR: ${uris.ocr(jobId)}`,
  ]
  if (r.secrets.length) {
    head.push('', `SECRETS: ${r.secrets.length} finding(s), all values masked:`)
    for (const s of r.secrets) head.push(`  [${s.confidence}] ${s.kind} ${s.masked} (${s.length} chars) at ${fmtTime(s.pts ?? 0)}${s.context ? ` near "${s.context}"` : ''} — signals: ${s.signals.join('+')}`)
  } else head.push('', 'No secrets detected.')
  const body = r.frames
    .filter((f) => f.text.trim())
    .map((f) => `=== #${f.index} ${fmtTime(f.pts)} (conf ${f.meanConfidence}%)\n${format === 'concise' ? f.text.split('\n').slice(0, 3).join(' | ').slice(0, 160) : f.text}`)
    .join('\n')
  return head.join('\n') + '\n\n' + untrusted(truncateToBudget(body, budget - estimateTokens(head.join('\n')) - 40, uris.ocr(jobId)))
}

/** Concise keeps at most 8 findings per severity (the report has all of them); detailed prints every finding with its detail. */
export function formatReview(r: ReviewResult, jobId: string, format: Format = 'concise'): string {
  const icon = { ok: '✅', info: 'ℹ️', warn: '⚠️', block: '⛔' } as const
  const lines = [`Pre-publish review of ${path.basename(r.source.input)} — verdict ${icon[r.verdict]} ${r.verdict.toUpperCase()} for ${r.platform} · ${fmtTime(r.source.durationSec)}`, `Report: ${uris.report(jobId)}`, '']
  const perSeverity = new Map<string, number>()
  let hidden = 0
  for (const f of r.findings) {
    const n = (perSeverity.get(f.severity) ?? 0) + 1
    perSeverity.set(f.severity, n)
    if (format === 'concise' && n > 8) {
      hidden++
      continue
    }
    lines.push(`${icon[f.severity]} ${f.title}${f.atSec !== undefined ? ` (at ${fmtTime(f.atSec)})` : ''}${f.detail ? `\n   ${f.detail}` : ''}`)
  }
  if (hidden) lines.push(`… ${hidden} more finding(s) in the report (or pass format: "detailed")`)
  return lines.join('\n')
}

export function formatDiarize(r: DiarizeResult, jobId: string, format: Format, budget: number): string {
  const head = [
    `Speakers in ${path.basename(r.source.input)} — ${fmtTime(r.source.durationSec)} · method ${r.method}${r.experimental ? ' (experimental: threshold ' + r.stats.threshold + ', calibrate on your recordings)' : ''}${r.cached ? ' (cached)' : ''}`,
    `${r.speakers.length} speaker(s), ${r.turns.length} turns · speakers.json: ${uris.speakers(jobId)}`,
    ...r.speakers.map((s) => `  ${s.id}${s.name ? ` (${s.name})` : ''}: ${fmtTime(s.talkTimeSec)} over ${s.turns} turn(s)${s.voiceClip ? ` · voice clip ${path.basename(s.voiceClip)}` : ''}`),
  ]
  if (r.segments) {
    head.push('', `Transcript with speakers: ${uris.transcriptSpeakers(jobId)}`)
    const lines = r.segments.map((s) => `[${fmtTime(s.startSec)} ${s.speaker ?? '?'}] ${s.text}`)
    const body = format === 'concise' ? lines.slice(0, 12).join('\n') + (lines.length > 12 ? `\n… (${lines.length} segments)` : '') : lines.join('\n')
    return head.join('\n') + '\n\n' + untrusted(truncateToBudget(body, budget - estimateTokens(head.join('\n')) - 40, uris.transcriptSpeakers(jobId)))
  }
  if (format === 'detailed') {
    head.push('', 'turns:')
    for (const t of r.turns.slice(0, 400)) head.push(`  ${fmtTime(t.startSec)}–${fmtTime(t.endSec)} ${t.speaker}`)
  }
  return head.join('\n')
}

export function formatSearch(r: SearchResult): string {
  const head = `Search "${r.query}" over ${r.indexedJobs} indexed job(s) · ${r.hits.length} hit(s) in ${r.ms} ms`
  if (!r.hits.length) return head + '\nNo matches. Try other words, or check that the media was transcribed / read first.'
  const lines = r.hits.map((h, i) => `${i + 1}. [${h.kind} ${fmtTime(h.startSec)}${h.speaker ? ' ' + h.speaker : ''}] ${h.text.slice(0, 220)}${h.text.length > 220 ? '…' : ''}\n   job ${h.jobId} · ${path.basename(h.source)} · score ${h.score}${h.bm25Rank ? ` · bm25 #${h.bm25Rank}` : ''}${h.vectorRank ? ` · vector #${h.vectorRank}` : ''}`)
  return head + '\n\n' + untrusted(lines.join('\n'))
}

export function formatJob(job: JobRecord): string {
  const eta = job.status === 'running' && job.progress.fraction > 0.02 && job.startedAt ? Math.round(((Date.now() - Date.parse(job.startedAt)) / job.progress.fraction) * (1 - job.progress.fraction) / 1000) : undefined
  const lines = [`Job ${job.id} (${job.kind}) — ${job.status}`, `${job.progress.stage}: ${job.progress.message} (${Math.round(job.progress.fraction * 100)}%)${eta !== undefined ? ` · ~${eta}s left` : ''}`]
  if (job.error) lines.push(`Error ${job.error.code}: ${job.error.message}${job.error.hint ? `\nHint: ${job.error.hint}` : ''}`)
  return lines.join('\n')
}
