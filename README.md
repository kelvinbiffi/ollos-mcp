# ollos-mcp

[![CI](https://github.com/kelvinbiffi/ollos-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/kelvinbiffi/ollos-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ollos-mcp.svg)](https://www.npmjs.com/package/ollos-mcp)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=ollos&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9sbG9zLW1jcCJdfQ==)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=ollos&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22ollos-mcp%22%5D%7D)

**Eyes and ears for AI agents.** Local, offline transcription, keyframes, on-screen text and a pre-publish review of any audio, video or image — as an MCP server, a CLI and a Node library. No Python, no cloud, no API key.

**Docs:** [Tool reference](docs/TOOLS.md) · [Design doc — decisions and measurements](docs/DESIGN.md) · [Evaluation results](eval/RESULTS.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

> 11 minutes of screencast become 14 contact sheets and 3 KB of text. And it tells you if your API key is visible at 2:50.

```bash
npx ollos-mcp            # MCP server on stdio
npx ollos review talk.mp4
```

*Ollos* is Galician for *eyes*.

---

## Why

Agents can't hear or watch. Today you either pay a transcription API, install a Python pipeline, or paste frames by hand. Ollos runs Whisper, speaker segmentation, perceptual-hash keyframing and OCR **in Node, through ONNX Runtime**, on your machine. The file never leaves it.

It was built for one workflow first — reviewing a screen recording before publishing — and grew into the general case: meetings, lessons, podcasts, downloaded videos.

## Install

Node 20+. `npm install` brings its own ffmpeg (`ffmpeg-static`); a system ffmpeg is used if present.

**Claude Code**

```bash
claude mcp add ollos -- npx -y ollos-mcp
```

or in the project's `.mcp.json` (the same JSON works for Claude Desktop's `claude_desktop_config.json`, Cursor's `.cursor/mcp.json` and Windsurf's `mcp_config.json`):

```json
{
  "mcpServers": {
    "ollos": { "command": "npx", "args": ["-y", "ollos-mcp"] }
  }
}
```

**VS Code** — `.vscode/mcp.json` uses `servers` instead of `mcpServers`:

```json
{
  "servers": {
    "ollos": { "type": "stdio", "command": "npx", "args": ["-y", "ollos-mcp"] }
  }
}
```

Claude Desktop reads `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Environment variables (`OLLOS_HOME`, `OLLOS_YTDLP`, …) go in an `env` object next to `args`; use absolute paths, `~` is not expanded.

**CLI**

```bash
npm i -g ollos-mcp
ollos warmup            # download the default ASR model and VAD (2.75 GB)
ollos warmup --all      # every model: fast ASR, speakers, search, OCR data (3.3 GB total)
ollos doctor            # check ffmpeg, models, free memory, cores
```

Models download on first use into `~/.ollos/models`. Set `OLLOS_OFFLINE=1` afterwards to forbid all network access.

## Tools

Ten tools, one per distinct contract. Long work never blocks: it returns a `jobId` you poll.

| Tool | What it does |
|---|---|
| `ollos_probe` | What the file really is: kind, duration, resolution, aspect (and which platforms it fits), codecs, tracks. Detects Zoom recording folders. Instant. |
| `ollos_transcribe` | Whisper transcription with timestamps. Voice-activity gating skips silence; known hallucinations are filtered; `vocabulary` fixes domain terms. |
| `ollos_keyframes` | The frames that carry information, packed into 3×3 timestamped contact sheets. Works on screen recordings where scene detection sees nothing. |
| `ollos_read_screen` | OCR of on-screen text plus a **secret scan**: API keys, JWTs, `.env` lines, private deployment URLs. Always masked. |
| `ollos_review` | Verdict before publishing: loudness vs platform, silences to cut, aspect ratio, secrets on screen. |
| `ollos_frames` | Look at a sheet or a single frame as an image. |
| `ollos_diarize` | Who spoke when: pyannote segmentation + WeSpeaker embeddings + clustering, with an 8-second voice clip per speaker so you can name them by ear. Uses Zoom per-participant tracks directly when present. *Experimental — see limits.* |
| `ollos_search` | Hybrid BM25 + multilingual-embedding search over everything transcribed and read, fused by reciprocal rank. Returns passages with timestamps, never whole transcripts. |
| `ollos_job` · `ollos_cancel` | Poll and stop jobs. Jobs live on disk and survive a server restart. |

Every parameter is documented in [docs/TOOLS.md](docs/TOOLS.md) (one anchor per tool, e.g. [`ollos_transcribe`](docs/TOOLS.md#ollos_transcribe--hybrid-resource-class-asr)); the tool descriptions the agent sees carry the same information.

### Sources

`source` accepts a local path, a `file://` URL, a Zoom local-recording folder (one audio track per participant), a direct `https://` media URL, a video-site URL (YouTube, Instagram, TikTok, Vimeo, X, Loom… through `yt-dlp`) and a `data:` URI. URLs are downloaded once into the cache; the download runs inside the job and can be cancelled. Refused: private, loopback and link-local addresses on any redirect hop (`OLLOS_ALLOW_PRIVATE=1` to allow), downloads over `OLLOS_MAX_DOWNLOAD_MB`, media over `OLLOS_MAX_DURATION_SEC` from any origin.

```bash
ollos transcribe "https://www.youtube.com/watch?v=eur8dUO9mvE" --lang en --from 0 --to 30
```

Tested commands, yt-dlp setup and proxy notes: [examples/url-sources.md](examples/url-sources.md).

Results are **concise by default** and point to MCP resources (`ollos://jobs/<id>/transcript`, `/ocr`, `/report`, `/sheet/<n>`) for the full artifacts, so a 2-hour meeting doesn't flood the context window. Pass `format: "detailed"` when you want it all.

## CLI

```bash
ollos probe recording.mp4
ollos transcribe meeting.mp4 --lang pt --vocab "Claude Code,n8n,webhook"
ollos keyframes lesson.mp4 --sensitivity normal --max-frames 120
ollos read-screen demo.mp4
ollos review episode.mp4 --platform youtube     # exit 3 = block, 1 = warn or failure, 2 = usage error, 0 = ok
ollos jobs · ollos job <id> · ollos events <id> · ollos cancel <id>
```

Add `--json` for machine output.

## Library

```ts
import { createOllos, type TranscribeResult } from 'ollos-mcp'

const ollos = createOllos()
const { job, result } = await ollos.transcribe({ source: 'talk.mp4', language: 'pt', vocabulary: ['MCP'] })
const transcript = result ?? (await ollos.wait<TranscribeResult>(job.id)).result // inline when small, a job otherwise
console.log(transcript?.segments[0])
```

More: [examples/library.ts](examples/library.ts) (every capability) and [examples/library-url.ts](examples/library-url.ts) (a YouTube URL as the source).

`ollos-mcp/core` has no MCP dependency: use it from n8n, a script, a Lambda.

## How it works, and what was measured

Numbers below were measured on an 11:37 screencast (1890×1080, webcam overlay) on a 16-core laptop. They are why the design is what it is.

**Transcription.** Silero VAD marks speech; Whisper only sees speech (fewer hallucinations, 20–40% less work on meetings). `whisper-large-v3-turbo` at 1.7× real time got "MCP servers", "n8n", "VS Code" right where `whisper-base` (5.4×) got all three wrong. The one phonetic miss left ("Cloud Code") is fixed by `vocabulary`. Two Whisper sessions in parallel measured **slower** than one (0.6–1.0×), so ASR concurrency is 1 and speed comes from VAD and from running vision in parallel instead.

**Anti-hallucination.** Whisper doesn't go quiet on silence — it invents "Obrigado." and "Subtitles by the Amara.org community". Four filters, from production experience shared by the Vexa project: exact blocklist per language, repetition-loop collapse, no-speech gate, impossible speaking rate.

**Keyframes.** ffmpeg scene detection at 0.3 kept **4 frames in 11 minutes** of screencast; `mpdecimate` removed **0%** (the cursor and streaming text change every pixel). A 64-bit perceptual hash (dHash) at Hamming ≥ 6 kept 20% — one frame every 5–8 s — and that is the default. Hard cuts, transcript anchors and a 20-second floor fill the gaps.

**OCR.** Tesseract on a full 1890-px frame missed an on-screen URL entirely; on a 3× upscaled tile it read it whole at 90% confidence in 2.8 s. So OCR runs per tile, and URL-like text is re-joined when OCR splits it ("up. railway .app").

**Secrets.** Three signals, because OCR garbles the secret more often than the words around it. On a real "API Key Created" modal the plain JWT regex missed (OCR read `eyJ` as `eyl`), the entropy detector caught the 157-char token, and the UI context read at 66%. With an OCR-tolerant JWT pattern, native-resolution frames and a centre tile, the end-to-end run now reports it as `high · jwt · near "API Key"` → `block`. The first version also produced 58 false positives by running the entropy test on whitespace-stripped text; that is a regression test now. Values are always masked; the tool that warns about a leak must not be the leak.

**Speakers.** Segmentation alone labelled three speakers on a one-person video (its ids are local to each 10-second window). Embedding every turn ≥ 1.5 s, average-linkage clustering at cosine 0.35, and absorbing tiny clusters brought it to one. The evaluation then showed the real failure mode: the same voice scores 0.58–0.86 against itself across positions and lengths, but 0.06–0.16 once background music is under it, so a jingle or an outro becomes its own "speaker" at any threshold. The tool stays experimental and says so in its output.

**Jobs.** Client timeouts are short (Messages API ~60 s). Every long tool returns a job handle; state lives in `~/.ollos/jobs/<id>/job.json`, written atomically, with a 5-second heartbeat. On restart, orphaned jobs become `interrupted` instead of hanging forever. Small work (< 8 s estimated) runs inline and returns directly.

## Evaluation

`npm run eval` runs ollos against public videos and writes [eval/RESULTS.md](eval/RESULTS.md). Reference transcripts are YouTube captions, so on auto-captioned fixtures WER is an agreement rate between two recognisers, not an absolute error.

| Fixture | Kind | Reference | WER | CER | Speakers (expected → found) |
|---|---|---|---|---|---|
| IBM Technology, *What is MCP?* (en, 3:46) | lightboard talk | professional captions | **1.4%** | 0.5% | 1 → 2 (outro music) |
| Karine Lago, n8n assistant (pt, 10:35) | screencast | auto-captions | 8.9% | 6.1% | 1 → 1 |
| Bolder Podcast, dev interview (pt, 5:28) | interview | auto-captions | 26.3% | 17.0% | 2 → 3 (jingles) |

On the interview, half the "errors" are insertions: Whisper keeps the repetitions and fillers the auto-captions drop, and several reference words are caption mistakes ("Clash Orto" for Glassdoor, which ollos got right). Keyframes reduced the 10-minute screencast to 120 frames on 14 sheets and the talk to 51 frames on 6 sheets. Speed on that run was 0.2–0.35× real time on a loaded machine; the same model measures 1.7× in isolation. How to reproduce, and what each number means, is in [eval/README.md](eval/README.md).

## Requirements and performance

Measured on the eval fixtures with the process memory sampled every 200 ms (`scripts/probe-memory.mts`). Machine: Intel i9-12900HX (16 cores), Windows 11, Node 20, while other processes used about 18% of the CPU.

| What | Disk (models) | Peak process memory | Speed |
|---|---|---|---|
| `ollos_probe`, `ollos_keyframes`, `ollos_review` without OCR | none | ~200 MB | keyframes: 2 min of video in ~15 s |
| Transcription, `model: "fast"` (whisper-base) | 280 MB | **~1.9 GB** | 60 s of audio in ~15 s after load (~4× real time) |
| Transcription, default (whisper-large-v3-turbo, fp32 encoder + q4 decoder) | 2.75 GB | **~4.3 GB** | 60 s of audio in ~46 s (~1.3× real time; 1.7× on an idle machine) |
| + `ollos_diarize` (pyannote + WeSpeaker) | +32 MB | +0.1 GB | 60 s in ~5 s once loaded |
| + `ollos_search` (multilingual-e5-small) | +465 MB | +0.8 GB | index build ~4 s per transcript |
| `ollos_read_screen` / review with OCR (2 Tesseract workers) | 8 MB | +0.3 GB | roughly 1–3 s per frame at native resolution, depending on CPU |
| Everything loaded at once | 3.3 GB | **~5.1 GB** | |

Minimums that follow from this: **8 GB of RAM** for the default model (4 GB is enough for `model: "fast"`), **4 GB of free disk** for all models, any x64 or arm64 CPU (no GPU is used). Transcription speed scales with CPU cores and is the only stage that is compute-bound; a 4-core laptop should expect roughly 0.4× real time on the default model, so a one-hour meeting takes over two hours, or about 40 minutes with `model: "fast"`.

Models stay loaded for the life of the server process; nothing is unloaded on idle yet. The peak above used to be ~10 GB: transformers.js' file cache streamed the 2.4 GB encoder weights into JavaScript buffers that nothing read, on top of ONNX Runtime's own memory-mapped copy. ollos now hands model paths to ONNX Runtime directly (see `PathCache` in `src/core/models.ts`). Set `OLLOS_DEBUG_MEM=1` to stamp every job event with process memory and read them with `ollos events <id>`.

### Memory limits

**There is no memory cap setting today, and models are never unloaded while the server process lives.** Once `ollos_transcribe` has run with the default model, the process keeps ~4.3 GB until it exits; add search and it keeps ~5.1 GB. This is a deliberate trade for speed (a cold load of the default model costs 50–60 s) and the honest state of 0.1.0.

What you can control now:

| Lever | Effect |
|---|---|
| `model: "fast"` per call | ~1.9 GB instead of ~4.3 GB; 3× faster; misreads technical terms |
| `from` / `to` on any tool | bounds the audio decoded and the frames extracted; memory for PCM and frames scales with the window, not the file |
| `OLLOS_MAX_DURATION_SEC` (default 4 h) | refuses media longer than this with a hint to use a window |
| `OLLOS_CONCURRENCY_VISION` / `_OCR` (default 2) | fewer parallel ffmpeg/Tesseract workers; ASR is always 1 |
| `OLLOS_MAX_DOWNLOAD_MB` (default 2048) | caps a fetched source file |
| Restart the server | the only way to release model memory today |
| `ollos doctor` | shows free RAM and cores against the measured needs before you start |
| `OLLOS_DEBUG_MEM=1` | stamps every job event with `rss`, `heap` and `arrayBuffers` (MB); read with `ollos events <id>` |

Node's own `--max-old-space-size` does **not** help: the weights live in ONNX Runtime's native memory, outside the V8 heap.

Planned, in order of value (see Roadmap):

1. **Idle unloading** — release a model after N minutes without a job (`OLLOS_MODEL_IDLE_MIN`), accepting the 50–60 s reload on the next call. Cheap to build; the pipelines already load lazily.
2. **A memory guard** — `OLLOS_MAX_MEMORY_MB`: before loading a model, compare its measured peak with the cap and the free RAM; refuse with a clear error, or downgrade to `model: "fast"` when `OLLOS_MEMORY_FALLBACK=fast`. The catalogue in `src/core/models.ts` already carries the sizes this needs.

## Privacy & security

- Nothing is uploaded. Network is used only to download models once and to fetch a source URL you pass.
- URL fetching refuses private, loopback, link-local and IPv6-transition addresses (SSRF), on the first request and on every redirect hop, unless `OLLOS_ALLOW_PRIVATE=1`.
- Transcripts and on-screen text are returned inside `<untrusted-content>` — they are data, not instructions. The bundled skill says the same to the agent.
- Secret findings are masked in results, logs and events, and the OCR text returned next to them is redacted with the same masks — the tool that warns about a leak is not the leak.
- Recording other people requires their consent where you live.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OLLOS_HOME` | `~/.ollos` | jobs, cache, models |
| `OLLOS_OFFLINE` | `0` | `1` forbids network; models must be warmed up |
| `OLLOS_ALLOW_PRIVATE` | `0` | allow fetching from private networks |
| `OLLOS_MAX_DOWNLOAD_MB` | `2048` | download cap |
| `OLLOS_MAX_DURATION_SEC` | `14400` | media longer than this is refused (use `from`/`to`) |
| `OLLOS_CONCURRENCY_VISION` / `_OCR` / `_DOWNLOAD` | `2` | parallel jobs per class (ASR is fixed at 1) |
| `OLLOS_MAX_FRAMES` | `500` | hard cap on frames per keyframes job |
| `OLLOS_RESPONSE_TOKENS` | `20000` | response budget before truncation with a pointer to the resource |
| `OLLOS_INLINE_THRESHOLD_SEC` | `8` | estimated work under this runs inline; `0` never inlines |
| `OLLOS_FFMPEG` / `OLLOS_FFPROBE` / `OLLOS_YTDLP` | auto | explicit binary paths |
| `OLLOS_YTDLP_ARGS` | — | extra yt-dlp flags for every site download, allow-listed (e.g. `--no-check-certificates --js-runtimes node`) |
| `OLLOS_DEBUG_MEM` | `0` | `1` stamps every job event with process memory (rss, heap, arrayBuffers in MB) |

Site downloads (YouTube, Instagram, TikTok…) need `yt-dlp` on your PATH (or `OLLOS_YTDLP`) and are best-effort: platforms change often. Behind a corporate proxy that re-signs TLS, set `OLLOS_YTDLP_ARGS="--no-check-certificates"`. Local files always work.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `FFMPEG_MISSING` | No ffmpeg found and `ffmpeg-static` failed to install for your platform. Install ffmpeg or set `OLLOS_FFMPEG` / `OLLOS_FFPROBE`. |
| `YTDLP_MISSING` | Video-site URLs need `yt-dlp` on `PATH` or `OLLOS_YTDLP`. Local files and direct URLs work without it. |
| `YTDLP_FAILED` with `CERTIFICATE_VERIFY_FAILED` | A corporate proxy re-signs TLS. `OLLOS_YTDLP_ARGS="--no-check-certificates"`. Other failures: `yt-dlp -U`, or download the file and pass the path. |
| `MODEL_MISSING_OFFLINE` | `OLLOS_OFFLINE=1` but a model was never downloaded. Run `ollos warmup --all` once online. |
| `PRIVATE_ADDRESS_BLOCKED` | The URL (or a redirect it returned) points at a private or loopback address. Intentional? `OLLOS_ALLOW_PRIVATE=1`. |
| `DURATION_EXCEEDED` | Media longer than `OLLOS_MAX_DURATION_SEC` (4 h). Pass `from`/`to` or raise the limit. |
| `Could not load the "sharp" module using the win32-x64 runtime` (or another platform) at startup | The `npx` cache holds an install without the platform binary of `sharp` (seen once on Windows: macOS and Linux binaries present, `win32-x64` missing). Clear it and retry, or install globally: `npm i -g ollos-mcp` and point the client at the `ollos-mcp` command. |
| Client reports a JSON parse error or the server "exits immediately" | Something wrote to stdout. The server guards stdout, so this points at a broken install: run `node dist/mcp/bin.js` and send an `initialize` line by hand (the CI does exactly this); `npm run smoke:mcp` reproduces it. |
| Transcription is slow or the machine swaps | The default model needs ~4.3 GB of RAM and all cores. `model: "fast"` (~1.9 GB) or a `from`/`to` window. `ollos doctor` shows free memory and cores. |
| A job stays `running` after the server was killed | It is reported `interrupted` on the next poll once its heartbeat is 30 s old; submit it again, cached stages are reused. |

## Known limits

- First run downloads 2.75 GB (accurate ASR) and needs ~4.3 GB of RAM while transcribing. `model: "fast"` uses a 280 MB model in ~1.9 GB of RAM and misreads technical terms. No memory cap yet; models are not unloaded on idle.
- Segment `confidence` is a heuristic (speech coverage, speaking rate, filters), not a model probability.
- Text around 8 px in the source video is at the edge of what OCR reads: detection of a secret that small depends on the exact frame, so ollos reads several frames around each hard cut. Below that, the UI-context signal still flags the situation ("API Key Created" is read reliably).
- `ollos_diarize` is experimental. Speech with background music (intros, jingles, outros) embeds far from the same voice on clean speech and comes out as an extra speaker regardless of the merge threshold (measured in `eval/`). Heavy crosstalk is unsolved. With Zoom per-participant tracks the result is exact.
- Site downloads depend on `yt-dlp` being installed; the standalone binary is not bundled yet. See [examples/url-sources.md](examples/url-sources.md).
- Progress notifications and the MCP Tasks extension are not used yet; polling `ollos_job` is the contract for every client today.

## Roadmap

- Memory: idle unloading of models (`OLLOS_MODEL_IDLE_MIN`) and a memory guard (`OLLOS_MAX_MEMORY_MB` with optional fallback to `model: "fast"`); see *Memory limits*
- MCP Tasks extension mode when clients ship it (the job engine is protocol-agnostic already), plus `notifications/progress`
- `ollos_diarize`: music-aware turn filtering (embed only turns the VAD marks as clean speech, or run a speech/music classifier first), a published DER from turn-level annotations, speaker naming persisted across recordings
- Bundled standalone `yt-dlp` so site downloads need no Python either
- Evaluation: DER with turn-level annotations, secret precision/recall on planted frames, retrieval metrics (hit rate, MRR, NDCG) for `ollos_search`

## Credits

Built on [transformers.js](https://github.com/huggingface/transformers.js) and the [onnx-community](https://huggingface.co/onnx-community) model ports, [tesseract.js](https://github.com/naptha/tesseract.js), [sharp](https://sharp.pixelplumbing.com/) and ffmpeg. Hallucination blocklists seeded from [Vexa](https://github.com/Vexa-ai/vexa) (Apache-2.0). Scene-aware keyframing was pioneered for agents by [claude-real-video](https://github.com/HUANGCHIHHUNGLeo/claude-real-video); ollos takes a different angle (review, speakers, Node) and owes it the contact-sheet idea.

## License

Apache-2.0 — © 2026 Kelvin Biffi
