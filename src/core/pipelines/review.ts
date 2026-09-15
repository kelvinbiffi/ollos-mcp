import fs from 'node:fs'
import path from 'node:path'
import type { OllosConfig } from '../config.js'
import type { JobContext } from '../jobs/types.js'
import { fmtTime } from '../media/ffmpeg.js'
import { detectSilences, measureLoudness, PLATFORMS, type Loudness, type Silence } from '../media/measure.js'
import { resolveSource, type ResolvedSource } from '../source/resolve.js'
import type { Finding } from '../vision/secrets.js'
import { runReadScreen } from './readScreen.js'
import type { Box } from '../vision/frames.js'

export type Check = 'loudness' | 'silences' | 'aspect' | 'secrets'

export interface ReviewParams {
  source: string
  checks?: Check[]
  platform?: keyof typeof PLATFORMS
  presenterRegion?: Box
  fromSec?: number
  toSec?: number
}

export type Severity = 'ok' | 'info' | 'warn' | 'block'

export interface ReviewFinding {
  check: Check
  severity: Severity
  title: string
  detail: string
  /** Where in the media, when it applies. */
  atSec?: number
  data?: Record<string, unknown>
}

export interface ReviewResult {
  source: { input: string; identity: string; durationSec: number; kind: string }
  platform: string
  verdict: Severity
  findings: ReviewFinding[]
  measurements: { loudness?: Loudness; silences?: Silence[]; aspect?: { ratio: string; in16x9: string }; secrets?: Finding[] }
  artifacts: { json: string; md: string }
  stats: { processingSec: number }
}

export function estimateReviewSeconds(durationSec: number, checks: Check[]): number {
  let s = 4 + durationSec * 0.06 // loudness + silences are one decode each
  if (checks.includes('secrets')) s += 10 + durationSec * 0.04 + Math.min(80, durationSec / 6) * 3.2
  return s
}

const ORDER: Record<Severity, number> = { ok: 0, info: 1, warn: 2, block: 3 }

export async function runReview(params: ReviewParams, ctx: JobContext, config: OllosConfig, pre?: ResolvedSource): Promise<ReviewResult> {
  const t0 = Date.now()
  const checks = params.checks ?? ['loudness', 'silences', 'aspect', 'secrets']
  const platform = PLATFORMS[params.platform ?? 'youtube'] ?? PLATFORMS.youtube!
  ctx.progress('resolve', 0.01, 'resolving source')
  const src = pre ?? (await resolveSource(params.source, config, { signal: ctx.signal }))
  const window = { fromSec: params.fromSec, toSec: params.toSec }
  const findings: ReviewFinding[] = []
  const measurements: ReviewResult['measurements'] = {}
  let done = 0
  const step = () => ctx.progress('checks', 0.05 + 0.9 * (++done / checks.length), `${done}/${checks.length} checks`)

  if (checks.includes('aspect')) {
    if (src.info.aspect && src.info.video) {
      const a = src.info.aspect
      measurements.aspect = { ratio: a.ratio, in16x9: a.in16x9 }
      const fits = platform.aspects.length === 0 || platform.aspects.includes(a.ratio)
      findings.push(
        fits
          ? { check: 'aspect', severity: 'ok', title: `Aspect ${a.ratio} fits ${platform.label}`, detail: `${src.info.video.width}×${src.info.video.height}` }
          : { check: 'aspect', severity: 'warn', title: `Aspect ${a.ratio} does not match ${platform.label} (${platform.aspects.join(' or ')})`, detail: `${src.info.video.width}×${src.info.video.height}. A 16:9 player will ${a.in16x9} it with black bars. Crop or pad before uploading.`, data: { width: src.info.video.width, height: src.info.video.height, in16x9: a.in16x9 } },
      )
    } else findings.push({ check: 'aspect', severity: 'info', title: 'No video stream, aspect check skipped', detail: `kind: ${src.info.kind}` })
    step()
  }

  if (checks.includes('loudness')) {
    if (src.info.audio) {
      const l = await measureLoudness(src.path, config, { ...window, signal: ctx.signal })
      measurements.loudness = l
      const delta = l.integratedLufs - platform.targetLufs
      // Within ±2 dB the platform's own normalisation is inaudible; anything further is a warning, never a block:
      // only a high-confidence secret on screen blocks, because loudness is fixable after upload and a leaked key is not.
      const sev: Severity = Math.abs(delta) <= 2 ? 'ok' : 'warn'
      findings.push({
        check: 'loudness',
        severity: sev,
        title: sev === 'ok' ? `Loudness ${l.integratedLufs.toFixed(1)} LUFS is on target` : `Loudness ${l.integratedLufs.toFixed(1)} LUFS is ${Math.abs(delta).toFixed(1)} dB ${delta < 0 ? 'below' : 'above'} ${platform.label}'s ${platform.targetLufs} LUFS`,
        detail: delta < -2 ? `${platform.label} will raise it ~${Math.abs(delta).toFixed(0)} dB and raise the noise floor with it. Normalise to ${platform.targetLufs} LUFS before upload (ffmpeg loudnorm). True peak ${l.truePeakDbtp.toFixed(1)} dBTP, range ${l.loudnessRange.toFixed(1)} LU.` : `True peak ${l.truePeakDbtp.toFixed(1)} dBTP, loudness range ${l.loudnessRange.toFixed(1)} LU.`,
        data: { ...l, target: platform.targetLufs, deltaDb: Number(delta.toFixed(1)) },
      })
      if (l.truePeakDbtp > platform.maxTruePeak) findings.push({ check: 'loudness', severity: 'warn', title: `True peak ${l.truePeakDbtp.toFixed(1)} dBTP above ${platform.maxTruePeak} dBTP`, detail: 'Risk of clipping after platform transcoding. Apply a limiter.' })
    } else findings.push({ check: 'loudness', severity: 'info', title: 'No audio stream, loudness check skipped', detail: '' })
    step()
  }

  if (checks.includes('silences')) {
    if (src.info.audio) {
      const s = await detectSilences(src.path, config, { ...window, noiseDb: -35, minDurationSec: 2, signal: ctx.signal })
      measurements.silences = s
      const total = s.reduce((a, x) => a + x.durationSec, 0)
      const longest = s.reduce((a, x) => (x.durationSec > (a?.durationSec ?? 0) ? x : a), undefined as Silence | undefined)
      if (s.length === 0) findings.push({ check: 'silences', severity: 'ok', title: 'No silence gaps of 2 s or more', detail: '' })
      else
        findings.push({
          check: 'silences',
          severity: longest && longest.durationSec >= 5 ? 'warn' : 'info',
          title: `${s.length} silence gap${s.length > 1 ? 's' : ''} ≥ 2 s, ${total.toFixed(0)} s total`,
          detail: `Longest ${longest!.durationSec.toFixed(1)} s at ${fmtTime(longest!.startSec)}. Cutting each to ~0.5 s saves about ${Math.max(0, total - s.length * 0.5).toFixed(0)} s.`,
          atSec: longest?.startSec,
          data: { gaps: s.map((x) => ({ at: fmtTime(x.startSec), start: x.startSec, end: x.endSec, duration: Number(x.durationSec.toFixed(1)) })) },
        })
    } else findings.push({ check: 'silences', severity: 'info', title: 'No audio stream, silence check skipped', detail: '' })
    step()
  }

  if (checks.includes('secrets')) {
    if (src.info.kind === 'video' || src.info.kind === 'image') {
      const rs = await runReadScreen({ source: params.source, detectSecrets: true, maxFrames: 80, presenterRegion: params.presenterRegion, fromSec: params.fromSec, toSec: params.toSec }, { ...ctx, progress: (s, f, m) => ctx.progress('secrets:' + s, 0.05 + 0.9 * ((done + f) / checks.length), m) }, config)
      measurements.secrets = rs.secrets
      const high = rs.secrets.filter((f) => f.confidence === 'high')
      const medium = rs.secrets.filter((f) => f.confidence === 'medium')
      const low = rs.secrets.filter((f) => f.confidence === 'low')
      const list = (fs: Finding[], n = 8) => fs.slice(0, n).map((f) => `${f.kind} ${f.masked} at ${fmtTime(f.pts ?? 0)}${f.context ? ` (near "${f.context}")` : ''}`).join('; ') + (fs.length > n ? `; +${fs.length - n} more in the report` : '')
      if (high.length) findings.push({ check: 'secrets', severity: 'block', title: `${high.length} probable secret${high.length > 1 ? 's' : ''} visible on screen`, detail: list(high) + ' — revoke the credential even if you cut the frame; anyone who paused the video may have it.', atSec: high[0]!.pts, data: { findings: high } })
      if (medium.length) findings.push({ check: 'secrets', severity: 'warn', title: `${medium.length} possible secret${medium.length > 1 ? 's' : ''} on screen`, detail: list(medium), atSec: medium[0]!.pts, data: { findings: medium } })
      if (low.length) findings.push({ check: 'secrets', severity: 'info', title: `${low.length} low-confidence token(s) / personal data on screen`, detail: list(low, 5), data: { findings: low } })
      if (!rs.secrets.length) findings.push({ check: 'secrets', severity: 'ok', title: `No secrets found in ${rs.stats.frames} frames`, detail: '' })
    } else findings.push({ check: 'secrets', severity: 'info', title: 'Audio only, on-screen check skipped', detail: '' })
    step()
  }

  const verdict = findings.reduce<Severity>((v, f) => (ORDER[f.severity] > ORDER[v] ? f.severity : v), 'ok')
  const artifacts = { json: path.join(ctx.artifactsDir, 'report.json'), md: path.join(ctx.artifactsDir, 'report.md') }
  const result: ReviewResult = {
    source: { input: src.input, identity: src.identity, durationSec: src.info.durationSec, kind: src.info.kind },
    platform: platform.id,
    verdict,
    findings: findings.sort((a, b) => ORDER[b.severity] - ORDER[a.severity]),
    measurements,
    artifacts,
    stats: { processingSec: Number(((Date.now() - t0) / 1000).toFixed(1)) },
  }
  fs.writeFileSync(artifacts.json, JSON.stringify(result, null, 2))
  fs.writeFileSync(artifacts.md, toMarkdown(result))
  return result
}

function toMarkdown(r: ReviewResult): string {
  const icon: Record<Severity, string> = { ok: '✅', info: 'ℹ️', warn: '⚠️', block: '⛔' }
  const lines = [`# Pre-publish review — ${path.basename(r.source.input)}`, '', `**Verdict:** ${icon[r.verdict]} ${r.verdict.toUpperCase()} · platform ${r.platform} · ${fmtTime(r.source.durationSec)}`, '']
  for (const f of r.findings) lines.push(`- ${icon[f.severity]} **${f.title}**${f.atSec !== undefined ? ` _(at ${fmtTime(f.atSec)})_` : ''}${f.detail ? `\n  ${f.detail}` : ''}`)
  return lines.join('\n') + '\n'
}
