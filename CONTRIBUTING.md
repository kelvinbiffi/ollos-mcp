# Contributing to ollos-mcp

Thanks for looking under the hood. This document explains how the code is organised, how to run it, and what a good change looks like.

## Ground rules

- **Nothing leaves the machine.** No telemetry, no uploads, no network except downloading models once and fetching a source URL the user passed. A change that adds network access needs a very good reason and an opt-out.
- **Fail loud.** Every pipeline stage validates its output or throws an `OllosError` with a stable `code`, a human `message` and a `hint`. Silent partial results are bugs (see `docs/DESIGN.md` §4.1 for why).
- **Secrets stay masked** in results, logs, events and tests.
- **Measure before you tune.** The defaults in this repo (Hamming ≥ 6, ASR concurrency 1, tile OCR at 3×, speaker threshold 0.35) were each measured on real media. If you change one, add the measurement to `docs/DESIGN.md` §3.

## Layout

```
src/core/       the engine — no MCP, no CLI imports allowed here
  config.ts       OLLOS_HOME, limits, model ids, env
  errors.ts       OllosError + codes
  ort.ts          single shared ONNX Runtime (never import onnxruntime-node directly)
  models.ts       model runtime config, catalogue, downloads
  media/          ffmpeg/ffprobe wrappers: probe, decode, measure
  source/         resolve path | URL | site | data: | Zoom folder; SSRF guard
  audio/          VAD, ASR, hallucination filters, glossary, diarization
  vision/         dHash, keyframe helpers, OCR, secret scanner
  search/         BM25 + embeddings, on-disk index
  jobs/           disk-backed job store and engine (heartbeat, classes, cancel)
  pipelines/      one file per job kind; register.ts wires them
  index.ts        public API (createOllos)
src/mcp/        tools, resources, response formatting, stdio entry point
src/cli/        the `ollos` command
assets/         hallucination blocklists (one phrase per line)
skills/         SKILL.md that teaches agents when and how to use the tools
scripts/        smoke tests against real media (not run in CI)
test/           vitest: pure logic, job engine, media integration (ffmpeg-generated clip)
eval/           fixtures manifest, evaluation runner and published results
docs/           design doc (decisions + measurements), tool reference
```

**The one architectural rule:** `src/core` never imports from `src/mcp` or `src/cli`. The core is a library first; the MCP server and the CLI are adapters.

## Running

```bash
npm install                 # ffmpeg-static and sharp download their binaries
npm run typecheck
npm test                    # ~15 s; generates its own media with ffmpeg lavfi
npm run dev:mcp             # MCP server on stdio (tsx)
npx tsx src/cli/bin.ts doctor
```

Smoke tests against a real file (models download on first run: 2.75 GB for the default ASR model):

```bash
npx tsx scripts/smoke-transcribe.ts path/to/video.mp4 30 90
npx tsx scripts/smoke-vision.ts path/to/video.mp4 0 240
npx tsx scripts/smoke-diarize-search.ts path/to/video.mp4 60 180
npx tsx scripts/smoke-mcp.ts path/to/video.mp4      # talks real MCP over stdio
```

## Adding a job kind

1. `src/core/pipelines/<kind>.ts` — `run<Kind>(params, ctx, config)` plus `estimate<Kind>Seconds()`. Report progress through `ctx.progress`, write artifacts into `ctx.artifactsDir`, key the cache on the source identity **and every parameter that changes the output**.
2. Register it in `src/core/pipelines/register.ts` with a resource class (`asr` is 1; two Whisper sessions measured slower than one).
3. Expose it in `src/core/index.ts`.
4. Add the tool in `src/mcp/server.ts`: description of 3–4 sentences covering purpose, when to use, limitations, parameters and an example; `outputSchema` declared; `structuredContent` returning **only** declared keys (the SDK validates strictly).
5. Add a renderer in `src/mcp/format.ts` with `concise` and `detailed` shapes and a resource for the full artifact.
6. CLI command in `src/cli/bin.ts`.
7. Tests: pure logic in `test/pure.test.ts`, anything touching ffmpeg in `test/media.test.ts`.

## Tests

- `test/pure.test.ts` — hashing, filters, glossary, secret scanner (including regression cases from real false positives), aspect, SSRF, windows.
- `test/engine.test.ts` — inline vs queued, progress, failure, cancel, per-class serialisation, orphan recovery.
- `test/media.test.ts` — probe, decode, silences, loudness, scene cuts, thumbnails, contact sheet, VAD on an 8-second clip generated with `lavfi`. No binary fixtures in the repo.
- `test/models.test.ts` — the `PathCache` transformers.js model cache (path strings for ONNX, `Response` for JSON, atomic downloads).
- `test/security.test.ts` — job-id validation, IPv6 transition ranges in the SSRF guard, OCR text redaction, OCR pool failure handling.

Model-dependent behaviour (Whisper, pyannote, WeSpeaker, e5) is covered by `scripts/` and `eval/`, not by unit tests, because it needs gigabytes of models and minutes of CPU.

## Style

TypeScript strict, ESM, no default exports, small files with one responsibility. Comments explain **why** (a measurement, a failure mode), not what. Keep tool descriptions in the voice of explaining to a new colleague.

## Commits

Never add a `Co-Authored-By` or any other co-author trailer. No formatter is configured yet: match the surrounding style (2 spaces, no semicolons, single quotes).

Conventional-ish, imperative, one topic per commit. Do not add co-author trailers.

## Reporting a security issue

See `SECURITY.md`.
