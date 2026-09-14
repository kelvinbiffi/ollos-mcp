# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2026-09-14

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

### Known limitations

- Diarization: speech over background music (jingles, outros) forms its own speaker cluster at any merge threshold; 1 → 2 and 2 → 3 speakers on the two eval fixtures that have music.
- Text below ~8 px in the source video is at the edge of OCR; several frames around each cut are read to compensate.
- Site downloads require `yt-dlp` on `PATH` or `OLLOS_YTDLP`; the standalone binary is not bundled.
- No MCP Tasks extension or progress notifications yet; poll `ollos_job`.

[Unreleased]: https://github.com/kelvinbiffi/ollos-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kelvinbiffi/ollos-mcp/releases/tag/v0.1.0
