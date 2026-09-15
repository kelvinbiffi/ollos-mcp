import { resolveBinaries, run } from './ffmpeg.js'
import { PLATFORMS } from './measure.js'
import { OllosError } from '../errors.js'
import type { OllosConfig } from '../config.js'

export type MediaKind = 'video' | 'audio' | 'image'

export interface AspectInfo {
  ratio: string
  decimal: number
  /** Platforms whose main format this aspect fits without bars. */
  fits: string[]
  /** What a 16:9 player would do with it. */
  in16x9: 'fits' | 'pillarbox' | 'letterbox'
}

export interface MediaInfo {
  kind: MediaKind
  container: string
  durationSec: number
  sizeBytes: number
  bitrate?: number
  video?: { codec: string; width: number; height: number; fps: number; pixFmt?: string; frames?: number }
  audio?: { codec: string; channels: number; sampleRate: number; bitrate?: number }
  aspect?: AspectInfo
  audioTracks: number
}

const KNOWN_RATIOS: Array<[string, number]> = [
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
  ['4:3', 4 / 3],
  ['1:1', 1],
  ['4:5', 4 / 5],
  ['21:9', 21 / 9],
  ['7:4', 7 / 4],
]

/** Platform ids whose preset accepts this ratio — the same ids `ollos_review.platform` takes, so an agent can chain probe → review without a mapping table. */
function platformsFitting(ratio: string): string[] {
  return Object.values(PLATFORMS).filter((p) => p.aspects.includes(ratio)).map((p) => p.id)
}

export function describeAspect(width: number, height: number): AspectInfo {
  const decimal = width / height
  let best: [string, number] = KNOWN_RATIOS[0]!
  for (const r of KNOWN_RATIOS) if (Math.abs(r[1] - decimal) < Math.abs(best[1] - decimal)) best = r
  const exact = Math.abs(best[1] - decimal) < 0.005
  const ratio = exact ? best[0] : `${width}:${height}`
  const in16x9: AspectInfo['in16x9'] = Math.abs(decimal - 16 / 9) < 0.005 ? 'fits' : decimal < 16 / 9 ? 'pillarbox' : 'letterbox'
  return { ratio, decimal: Number(decimal.toFixed(4)), fits: exact ? platformsFitting(ratio) : [], in16x9 }
}

interface FfprobeOutput {
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string }
  streams?: Array<{
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    r_frame_rate?: string
    avg_frame_rate?: string
    pix_fmt?: string
    nb_frames?: string
    channels?: number
    sample_rate?: string
    bit_rate?: string
    duration?: string
    disposition?: { attached_pic?: number }
  }>
}

function fps(s: string | undefined): number {
  if (!s) return 0
  const [a, b] = s.split('/').map(Number)
  if (!a || !b) return a && Number.isFinite(a) ? a : 0
  return Number((a / b).toFixed(3))
}

/** Read what the file actually is. Never trust the extension: a .mp4 with no video stream is audio. */
export async function probe(file: string, config: OllosConfig): Promise<MediaInfo> {
  const { ffprobe, ffmpeg } = resolveBinaries(config)
  if (!ffprobe) {
    throw new OllosError('FFMPEG_MISSING', 'ffprobe was not found', {
      hint: `ffmpeg is at ${ffmpeg} but ffprobe is missing. Install the full ffmpeg package (it ships ffprobe) or set OLLOS_FFPROBE.`,
    })
  }
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])
  const data = JSON.parse(stdout.toString('utf8')) as FfprobeOutput
  const streams = data.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition?.attached_pic === 1))
  const a = streams.find((s) => s.codec_type === 'audio')
  const audioTracks = streams.filter((s) => s.codec_type === 'audio').length
  const container = data.format?.format_name ?? 'unknown'
  const durationSec = Number(data.format?.duration ?? v?.duration ?? a?.duration ?? 0) || 0

  let kind: MediaKind
  if (v && (durationSec === 0 || /image2|png_pipe|mjpeg|webp|gif/.test(container)) && !a) kind = 'image'
  else if (v) kind = 'video'
  else if (a) kind = 'audio'
  else throw new OllosError('SOURCE_UNSUPPORTED', 'no audio, video or image stream found', { details: { container } })

  const info: MediaInfo = {
    kind,
    container,
    durationSec,
    sizeBytes: Number(data.format?.size ?? 0) || 0,
    bitrate: data.format?.bit_rate ? Number(data.format.bit_rate) : undefined,
    audioTracks,
  }
  if (v && v.width && v.height) {
    info.video = { codec: v.codec_name ?? 'unknown', width: v.width, height: v.height, fps: fps(v.avg_frame_rate ?? v.r_frame_rate), pixFmt: v.pix_fmt, frames: v.nb_frames ? Number(v.nb_frames) : undefined }
    info.aspect = describeAspect(v.width, v.height)
  }
  if (a) info.audio = { codec: a.codec_name ?? 'unknown', channels: a.channels ?? 0, sampleRate: Number(a.sample_rate ?? 0), bitrate: a.bit_rate ? Number(a.bit_rate) : undefined }
  return info
}
