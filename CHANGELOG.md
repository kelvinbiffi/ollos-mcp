# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- `ollos_read_screen` (and every other pipeline that extracts frames) failing on some screen recordings with `colourspace: parameter space not set`, always on the last sampled frame. Every video is now normalised once, up front, into a canonical H.264/yuv420p/bt709 MP4 with even dimensions and an integer frame rate before any frame is touched, so an unusual source resolution or a fractional frame rate — the frequent shape of a screen capture — no longer reaches the mjpeg encoder at all. Cached by source identity, so re-analysing the same file does not re-transcode it.
- **#1** `ollos_keyframes`/`ollos_read_screen` reporting hard-cut timestamps relative to the `from`/`to` window instead of the source: `-ss` sits before `-i`, so ffmpeg's own `pts_time` was already relative to the seek point, and the pipeline added the window offset a second time on every candidate except cuts.
- **#3** The secrets check missing content that sat unchanging on screen for a while (a credential left visible in an editor): change-detected keyframe selection contributes at most one candidate for a static screen, and the frame cap's prune step dropped that candidate on the same terms as a genuinely redundant one. The secrets check now samples at a fixed 4 s cadence regardless of visual change and protects that guarantee through pruning (`preserveFloor`); its report states the coverage achieved, and says so plainly when a very long recording could not be read in full.

### Changed

- **#2** `structuredContent.result` on `ollos_job` and the hybrid tools no longer ships the full pipeline result unconditionally — one real `read_screen` job returned ~62,000 characters and tripped a client's own tool-result limit. Results past the response token budget are trimmed per kind (OCR bounding boxes dropped and per-frame text capped for `read_screen`, perceptual hashes dropped for `keyframes`, oldest transcript segments dropped for `transcribe`/`diarize`) with a `trimmedForResponse` note pointing at the resource that still has everything.

## [0.1.0] — 2026-09-15

First release. Everything below was measured on real media before being made the default; see `docs/DESIGN.md` §3.

### Added

- **MCP server** (`ollos-mcp`) over stdio with 10 tools — `ollos_probe`, `ollos_transcribe`, `ollos_keyframes`, `ollos_read_screen`, `ollos_review`, `ollos_diarize`, `ollos_search`, `ollos_frames`, `ollos_job`, `ollos_cancel` — and 9 resource templates under `ollos://jobs/{jobId}/…`.
- **CLI** (`ollos`) with the same capabilities plus `jobs`, `events`, `warmup`, `doctor`, `gc`.
- **Library** entry point (`createOllos()`) with no MCP dependency.
- **Job engine** on disk: atomic writes, 5-second heartbeat, orphan recovery on startup, per-resource-class concurrency (ASR fixed at 1), cancellation via `AbortSignal`, inline fast path for work under ~8 s.
- **Transcription**: Silero VAD gating, `whisper-large-v3-turbo` (q4) by default, hallucination filters (blocklist, repetition loop, no-speech, speaking rate), glossary correction, heuristic per-segment confidence, JSON/TXT/SRT artifacts.
- **Keyframes**: 1 fps perceptual hash (dHash, Hamming ≥ 6) ∪ hard cuts ∪ transcript anchors ∪ 20-second floor; 3×3 timestamped contact sheets; optional presenter-region mask. Cut frames are clamped before the end of the stream and an undecodable instant is skipped with an event instead of failing the job (found by the eval: a cut in the last 0.4 s of a fixture seeked past EOF).
- **On-screen text**: tiled OCR (2×2 grid plus a centre tile, 3× upscale) with a three-signal masked secret scanner (patterns incl. OCR-tolerant JWT, entropy on contiguous tokens only, UI context words).
- **Pre-publish review**: loudness vs platform target, true peak, silence gaps, aspect ratio vs platform, on-screen secrets; verdict `ok / warn / block`; Markdown report.
- **Speaker diarization** (experimental): pyannote segmentation → WeSpeaker embeddings (turns ≥ 1.5 s) → average-linkage clustering at cosine 0.35 with tiny-cluster absorption; voice clip per speaker; exact labelling from Zoom per-participant tracks.
- **Search**: BM25 + `multilingual-e5-small` embeddings fused by reciprocal rank over transcripts and OCR, per-job on-disk index, deduplicated hits.
- Source resolver: local path, Zoom recording folder, direct URL (SSRF-guarded, size-capped), video-site URL via `yt-dlp` (`OLLOS_YTDLP` path, `OLLOS_YTDLP_ARGS` allow-listed flags such as `--no-check-certificates` behind TLS-intercepting proxies), `data:` URI.
- Content-addressed cache for transcripts, keyframes, OCR and downloads.
- Stdout guard in the MCP entry point so native libraries cannot corrupt JSON-RPC.
- **Model cache** (`PathCache`): ONNX weights are handed to ONNX Runtime as paths instead of going through transformers.js' `FileResponse`, whose unconsumed stream held the 2.43 GB encoder weights twice in JavaScript buffers. Peak memory for the default ASR model dropped from ~10 GB to ~4.3 GB; the model catalogue and docs now state the real sizes (2.75 GB accurate, 280 MB fast, 465 MB embeddings).
- `OLLOS_DEBUG_MEM=1` stamps every job event with process memory; a requirements and performance table in the README.
- **Evaluation harness** (`eval/`): WER/CER against caption references, speaker-count check, keyframe statistics over public fixtures; results published in `eval/RESULTS.md`.
- 56 tests; smoke scripts against real media; design document (English, with the original Portuguese draft); agent skill; MCP Registry manifest; CI on Linux/Windows/macOS × Node 20/22; release workflow with npm provenance.

### Security (pre-release review)

- Raw OCR text is redacted with the same masks as the secret findings before it is returned, written to `ocr.json`/`ocr.txt`, cached or indexed for `ollos_search`. The scanner's compact view no longer glues lines together.
- Job ids from resource URIs and tool arguments are validated against `^j_[0-9a-f]{12}$` before touching the filesystem; read paths never create directories (the SDK's URI matcher passed `..` and backslashes through).
- SSRF guard: redirects are followed manually with the public-host check on every hop, bounded by `maxRedirects`; IPv6 transition addresses (v4-mapped, NAT64, 6to4, Teredo) are unwrapped and checked; documentation, benchmarking and `.home.arpa` ranges refused.
- `OLLOS_MAX_DURATION_SEC` applies to every source kind, not only local files.

### Fixed

- The heartbeat timer could throw (`EPERM` on a rename over an open `job.json` on Windows) and kill the whole server; it is now best effort, and atomic renames retry.
- The OCR worker pool counted failed worker creations as created; after two failures every later OCR job waited forever. Failures roll back, waiters are told, and a cancelled job leaves the queue.
- The source (a URL download, a probe) was resolved before the job existed and again when it ran; it is now resolved once, under the job's signal, with the job already visible as `queued`. A missing file or a refused URL fails the submission immediately with the real error instead of a 600-second estimate.
- `recover()` no longer flips fresh `queued` jobs of a live sibling process to `interrupted`; stale orphans are caught lazily on every read, so a respawned server never reports a frozen `running` forever.
- `cancel()` returns the record after the change; a finished job is reported with `cancelled: false` instead of an error. `ollos_cancel` and `ollos cancel` say so.
- Partial downloads (`.part`, yt-dlp intermediates) were adopted as cached results after a kill; yt-dlp now works in a private temp directory and only the merged file is moved into the cache.
- `file:///C:/x` became `C:\C:\x` on Windows.
- `ollos_frames` counted content blocks instead of images, returning half the requested sheets; it now declares an `outputSchema`.
- Cache hits returned artifact paths of the earlier job, so every `ollos://jobs/<new id>/…` link on a cached answer was dead; artifacts are hard-linked (copied where links are refused) into the new job for transcribe, keyframes, read_screen and diarize.
- Keyframes: when cuts and anchors alone exceed `maxFrames` they are thinned by temporal spread (anchors first) instead of truncating the tail; a cut in the last 0.4 s seeked past EOF and failed the job.
- `ollos_diarize` validates `transcriptJobId` (exists, completed, kind `transcribe`) before doing minutes of work.
- `warmup --all` fetches every model (fast ASR, pyannote, WeSpeaker, e5, Tesseract), so `OLLOS_OFFLINE=1` works for every capability; `gc` also removes cache and index entries.
- `ollos_probe` `aspect.fits` uses the same platform ids `ollos_review.platform` accepts.
- Set-but-invalid environment values (`OLLOS_MAX_DOWNLOAD_MB=0`) now fail with `INVALID_ARGUMENT` instead of silently using the default.

### Changed

- `from`/`to` accept seconds as a number or a `m:ss` string on every tool; one validated `parseTime` for MCP, CLI and pipelines.
- Every tool parameter has a description; `ollos_review` gained `format`; `ollos_transcribe` gained `vadThreshold`; descriptions state measured speeds in the project's "N× real time" convention and the real embedding model size (465 MB).
- `INTERRUPTED` is a stable error code.
- `SubmitResult.etaSeconds` carries the estimate; the MCP layer no longer resolves the source a second time for the ETA.

### Added by the pre-release review

- `CLAUDE.md` for agents working in the repo; `mcpName` in `package.json` (required by the MCP Registry); `server.json` on the 2025-12-11 schema; `.mcp.json` at the repo root for local development; `.editorconfig`.
- README: install snippets per client (Claude Code, Claude Desktop, Cursor, VS Code, Windsurf), one-click badges, a Sources section, a Troubleshooting table, the missing configuration variables; `examples/url-sources.md` and `examples/library-url.ts` with tested URL commands.
- `test/security.test.ts` (job ids, IPv6 transition ranges, redaction, OCR pool) and engine tests for stale/fresh orphans, cancel semantics and `prepare()` failures — 96 tests.

### Known limitations

- Diarization: speech over background music (jingles, outros) forms its own speaker cluster at any merge threshold; 1 → 2 and 2 → 3 speakers on the two eval fixtures that have music.
- Text below ~8 px in the source video is at the edge of OCR; several frames around each cut are read to compensate.
- Site downloads require `yt-dlp` on `PATH` or `OLLOS_YTDLP`; the standalone binary is not bundled.
- No MCP Tasks extension or progress notifications yet; poll `ollos_job`.
- No memory cap and no idle unloading: the default ASR model keeps ~4.3 GB resident until the server exits (README, *Memory limits*).

[Unreleased]: https://github.com/kelvinbiffi/ollos-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kelvinbiffi/ollos-mcp/releases/tag/v0.1.0
