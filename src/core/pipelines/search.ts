import type { OllosConfig } from '../config.js'
import type { JobEngine } from '../jobs/engine.js'
import { docsFromScreen, docsFromTranscript, SearchIndex, type Hit } from '../search/index.js'
import type { TranscribeResult } from './transcribe.js'
import type { ReadScreenResult } from './readScreen.js'
import type { DiarizeResult } from './diarize.js'

export interface SearchParams {
  query: string
  scope?: 'job' | 'all'
  jobId?: string
  k?: number
  kind?: 'speech' | 'screen' | 'both'
}

export interface SearchResult {
  query: string
  scope: 'job' | 'all'
  indexedJobs: number
  hits: Hit[]
  ms: number
}

/**
 * Index every completed transcribe / read_screen / diarize job that isn't indexed yet, then search.
 * Indexing is lazy and idempotent, so pipelines stay decoupled from search.
 */
export async function runSearch(params: SearchParams, engine: JobEngine, config: OllosConfig): Promise<SearchResult> {
  const t0 = Date.now()
  const index = new SearchIndex(config)
  const scope = params.scope ?? (params.jobId ? 'job' : 'all')
  const jobs = engine.store.list().filter((j) => j.status === 'completed' && (scope === 'all' || j.id === params.jobId))
  for (const j of jobs) {
    if (index.has(j.id)) continue
    const source = String((j.params as { source?: string }).source ?? '')
    if (j.kind === 'transcribe') {
      const r = engine.store.loadResult<TranscribeResult>(j.id)
      if (r) await index.build(j.id, docsFromTranscript(j.id, source, r.segments))
    } else if (j.kind === 'diarize') {
      const r = engine.store.loadResult<DiarizeResult>(j.id)
      if (r?.segments) await index.build(j.id, docsFromTranscript(j.id, source, r.segments))
    } else if (j.kind === 'read_screen') {
      const r = engine.store.loadResult<ReadScreenResult>(j.id)
      if (r) await index.build(j.id, docsFromScreen(j.id, source, r.frames))
    }
  }
  const jobIds = scope === 'job' && params.jobId ? [params.jobId] : undefined
  const hits = await index.search(params.query, { jobIds, k: params.k ?? 8, kind: params.kind ?? 'both' })
  return { query: params.query, scope, indexedJobs: (jobIds ?? index.listJobs()).length, hits, ms: Date.now() - t0 }
}
