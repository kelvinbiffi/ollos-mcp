import fs from 'node:fs'
import path from 'node:path'
import { resolveBinaries, run } from './ffmpeg.js'
import { probe, type MediaInfo } from './probe.js'
import type { OllosConfig } from '../config.js'
import { Cache } from '../cache/cache.js'
import { OllosError } from '../errors.js'

/**
 * Screen recordings and other captured footage show up in shapes ffmpeg's filters and encoders were
 * never quite tuned for: odd resolutions, fractional frame rates, containers with no colour tags at all.
 * A known case: macOS screen recordings at an uncommon resolution and a fractional frame rate make the
 * mjpeg encoder used for frame extraction fail with "colourspace: parameter space not set" on the last
 * sampled frame, even once every explicit colour flag is set. Rather than have every pipeline that
 * touches individual frames (keyframes, scene cuts, OCR crops) special-case that, every video is
 * normalised once, up front, into a canonical H.264/yuv420p/bt709 MP4 with even dimensions and an
 * integer frame rate, and every downstream ffmpeg call reads that file instead.
 *
 * Cached by the identity of the *source* file, so normalising the same recording twice in one session
 * (read_screen then keyframes on the same clip) only pays the transcode cost once.
 */
export async function normalizeVideo(file: string, info: MediaInfo, identity: string, config: OllosConfig, opts: { signal?: AbortSignal } = {}): Promise<{ path: string; info: MediaInfo }> {
  if (info.kind !== 'video' || !info.video) return { path: file, info }

  const cache = new Cache(config)
  const dir = cache.dir('normalize', identity)
  const out = path.join(dir, 'media.mp4')
  const done = path.join(dir, 'done')
  if (fs.existsSync(out) && fs.existsSync(done)) {
    return { path: out, info: await probe(out, config) }
  }

  const { ffmpeg } = resolveBinaries(config)
  // An integer, sane frame rate rules out the fractional-fps case (43.493 fps in the report that started this);
  // even width/height is what libx264 itself requires; format=yuv420p plus the explicit bt709 triplet rules out
  // every "unspecified" colour tag a capture tool might leave out.
  const fps = Math.min(60, Math.max(1, Math.round(info.video.fps || 30)))
  const vf = `scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=${fps},format=yuv420p`
  // -f mp4 is not optional: the temp file is named media.mp4.part so a crash never leaves a half-written
  // media.mp4 for the cache check above to pick up, and ffmpeg cannot infer a muxer from a ".part" extension.
  const baseArgs = ['-v', 'error', '-nostdin', '-i', file, '-map', '0:v:0', ...(info.audio ? ['-map', '0:a:0'] : []), '-vf', vf, '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4']
  const tmp = `${out}.part`

  try {
    // Audio passed through bit-exact: transcription pipelines depend on it, and copy is free.
    await run(ffmpeg, [...baseArgs, ...(info.audio ? ['-c:a', 'copy'] : ['-an']), '-y', tmp], { signal: opts.signal })
  } catch (e) {
    if (!info.audio || (e instanceof OllosError && e.code === 'CANCELLED')) throw e
    // The source audio codec may not be legal inside an mp4 container (e.g. Opus in a webm capture) — re-encode instead of dropping it.
    await run(ffmpeg, [...baseArgs, '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-y', tmp], { signal: opts.signal })
  }
  fs.renameSync(tmp, out)
  fs.writeFileSync(done, '')
  return { path: out, info: await probe(out, config) }
}
