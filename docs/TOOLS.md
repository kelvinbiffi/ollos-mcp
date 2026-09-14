# Tool reference

Ten tools, one per distinct contract. Names are `ollos_*` in snake_case. Every tool declares an `outputSchema`; `structuredContent` contains exactly the declared keys.

## The two return shapes

**Synchronous tools** (`probe`, `search`, `frames`, `job`, `cancel`) return their result directly.

**Hybrid tools** (`transcribe`, `keyframes`, `read_screen`, `review`, `diarize`) estimate the work first:

```jsonc
// small input → inline
{ "status": "completed", "jobId": "j_…", "cached": false, "result": { … } }

// large input → job handle
{ "status": "queued", "jobId": "j_…", "etaSeconds": 420, "next": "ollos_job" }
```

Poll `ollos_job` every few seconds. When `status` is `completed` it carries the same formatted result and resource links, so no further call is needed. Jobs are on disk: a `jobId` survives a server restart, and a job the process died on reports `interrupted` instead of hanging.

**Errors** come back with `isError: true` and `{ code, message, hint }`. Codes are stable: `SOURCE_NOT_FOUND`, `SOURCE_UNSUPPORTED`, `UNSUPPORTED_TASK_FOR_KIND`, `DOWNLOAD_FAILED`, `DOWNLOAD_TOO_LARGE`, `PRIVATE_ADDRESS_BLOCKED`, `YTDLP_MISSING`, `YTDLP_FAILED`, `FFMPEG_MISSING`, `FFMPEG_FAILED`, `MODEL_MISSING_OFFLINE`, `MODEL_LOAD_FAILED`, `DURATION_EXCEEDED`, `PIPELINE_EMPTY_OUTPUT`, `JOB_NOT_FOUND`, `JOB_NOT_CANCELLABLE`, `INVALID_ARGUMENT`, `CANCELLED`, `INTERNAL`.

## Common parameters

| Parameter | Type | Meaning |
|---|---|---|
| `source` | string | Local path, `http(s)://` URL, video-site URL (needs `yt-dlp` on `PATH` or `OLLOS_YTDLP`; extra allow-listed flags via `OLLOS_YTDLP_ARGS`), `data:` URI, or a Zoom local-recording folder |
| `from`, `to` | string | Window to analyse: `"90"`, `"1:30"`, `"0:01:30.5"` |
| `format` | `"concise"` \| `"detailed"` | Concise (default) keeps the response small and points to resources |

---

### `ollos_probe` — synchronous

What the file really is, by `ffprobe`, never by extension.

**Returns** `kind` (`video` \| `audio` \| `image`), `durationSec`, `container`, `sizeBytes`, `bitrate`, `origin`, `video { codec, width, height, fps }`, `audio { codec, channels, sampleRate }`, `aspect { ratio, decimal, fits[], in16x9 }`, `audioTracks`, `zoomTracks[]` (participant names when the source is a Zoom folder).

### `ollos_transcribe` — hybrid, resource class `asr`

| Parameter | Default | Notes |
|---|---|---|
| `language` | auto (pt/en/es) | ISO code |
| `model` | `accurate` | `accurate` = whisper-large-v3-turbo (1.7× real time), `fast` = whisper-base (5×, misreads technical terms) |
| `vocabulary` | — | Domain terms; the transcript is corrected toward them ("Cloud Code" → "Claude Code") |
| `audioTrack` | 0 | For multi-track files |

**Pipeline** decode 16 kHz → Silero VAD → Whisper on speech windows only (greedy, no conditioning on previous text) → hallucination filters → glossary → artifacts (`transcript.json/.txt/.srt`).

**Result** `language`, `model`, `vad { engine, speechSec, regions }`, `segments[] { id, startSec, endSec, text, confidence, flags[], speaker? }`, `stats { segmentCount, filteredCount, wordCount, vocabularyReplacements, processingSec }`, `cached`. `confidence` is a heuristic (speech coverage, speaking rate, filters), not a model probability.

**Resources** `ollos://jobs/{id}/transcript`, `ollos://jobs/{id}/transcript.srt`.

### `ollos_keyframes` — hybrid, class `vision`

| Parameter | Default | Notes |
|---|---|---|
| `sensitivity` | `normal` | Hamming threshold on the 64-bit dHash: `low` 10, `normal` 6, `high` 3 |
| `maxFrames` | 120 | Least-changed hash frames are dropped first; cuts and anchors are never dropped |
| `frameWidth` | 1280 | Saved frame width (capped at source width) |
| `presenterRegion` | — | `{x,y,w,h}` fractions to ignore when comparing frames (webcam overlay) |
| `anchorsSec[]` | — | Timestamps that must get a frame |

**Candidates** = dHash survivors ∪ hard cuts (`scene > 0.3`, +0.4 s so the new screen has settled) ∪ anchors ∪ one frame per 20 s floor. Merged within 0.75 s; cuts win the exact timestamp.

**Result** `frames[] { index, pts, sources[], hash, distance, file, sheet, tile }`, `sheets[] { index, file, frames[] }`, `stats { sampled, afterHash, cuts, anchors, floorAdded, pruned }`.

**Resources** `ollos://jobs/{id}/sheet/{n}` (JPEG), `ollos://jobs/{id}/frame/{n}`.

### `ollos_read_screen` — hybrid, class `ocr`

| Parameter | Default | Notes |
|---|---|---|
| `languages` | `["por","eng"]` | Tesseract codes |
| `detectSecrets` | `true` | |
| `sensitivity`, `maxFrames`, `presenterRegion` | as keyframes; `maxFrames` 80 | Frames are extracted at native width for OCR |

**OCR** runs per tile — a 2×2 grid plus one centred tile, each upscaled 3× — because 8 px UI text is unreadable at 1×, and modals sit exactly where a grid cuts.

**Secret scanner** combines three signals: known patterns (OpenAI/Anthropic/GitHub/AWS/Google/Slack/Stripe keys, JWT with OCR-tolerant header, Bearer, private-key blocks, `.env` assignments, private deployment and local URLs, e-mail, CPF), high-entropy contiguous tokens, and nearby UI words (`API Key`, `Created`, `copy`, `secret`, `token`, `password`…). Confidence: `high` = strong pattern; `medium` = deployment/local URL, weak pattern or entropy with context; `low` = the rest and personal data. **Values are always masked** (`abcd…xyz` + length).

**Result** `frames[] { index, pts, text, meanConfidence, blocks[], secrets[] }`, `secrets[]` (deduplicated across frames), `images { frames, sheets }`, `stats`.

**Resource** `ollos://jobs/{id}/ocr`.

### `ollos_review` — hybrid, class `ocr` (or `light` without `secrets`)

| Parameter | Default |
|---|---|
| `checks[]` | `["loudness","silences","aspect","secrets"]` |
| `platform` | `youtube` (`youtube-shorts`, `instagram`, `tiktok`, `podcast`, `linkedin`) |

**Findings** `{ check, severity, title, detail, atSec?, data }` with severity `ok` \| `info` \| `warn` \| `block`. Verdict = worst finding. `block` is reserved for a high-confidence secret on screen; loudness more than 2 dB off target, true peak above the limit, a silence ≥ 5 s and an aspect that gets bars are `warn`.

**Resource** `ollos://jobs/{id}/report` (Markdown).

### `ollos_diarize` — hybrid, class `asr` — *experimental*

| Parameter | Default | Notes |
|---|---|---|
| `transcriptJobId` | — | Completed `ollos_transcribe` job to label with speakers |
| `similarityThreshold` | 0.35 | Cosine above which two turns are one speaker |
| `maxSpeakers`, `minSpeakers` | 8, 1 | |

**Pipeline** pyannote-segmentation-3.0 (local labels per 10-second window) → merge into turns → WeSpeaker embedding for turns ≥ 1.5 s → average-linkage clustering → tiny clusters (≤ 2 turns and < 5 % of talk time) absorbed → short turns attached to the nearest labelled turn in time. With a Zoom folder the per-participant tracks are used directly and speakers are named.

**Result** `method` (`embeddings` \| `zoom-tracks`), `experimental`, `speakers[] { id, talkTimeSec, turns, voiceClip }`, `turns[] { startSec, endSec, speaker, confidence }`, `segments[]` (transcript with `speaker` filled, when a transcript was given).

**Resources** `ollos://jobs/{id}/speakers`, `ollos://jobs/{id}/transcript.speakers`.

### `ollos_search` — synchronous

| Parameter | Default |
|---|---|
| `query` | required |
| `scope` | `all` (or `job` with `jobId`) |
| `k` | 8 |
| `kind` | `both` (`speech` \| `screen`) |

BM25 over normalised tokens and `multilingual-e5-small` embeddings (`query:`/`passage:` prefixes, mean-pooled), fused by reciprocal rank (k = 60). Indexes are built lazily per completed job and kept in `$OLLOS_HOME/index`. Identical passages from the same media are shown once.

**Result** `hits[] { text, startSec, endSec, kind, speaker?, source, jobId, score, bm25Rank?, vectorRank? }`, `indexedJobs`, `ms`.

### `ollos_frames` — synchronous

`{ jobId, sheets?: number[], frames?: number[], maxImages?: 6 }` → image content blocks from a completed `ollos_keyframes` or `ollos_read_screen` job. Defaults to the first two sheets.

### `ollos_job` — synchronous

`{ jobId, format? }` → `status`, `progress { stage, fraction, message }`, an ETA while running, `error` on failure, and on completion the formatted result plus resource links.

### `ollos_cancel` — synchronous

`{ jobId }` → aborts the running stage (ffmpeg and inference stop within about a second) and marks the job `cancelled`. Finished jobs are reported as `already-finished`.

---

## Resources

| URI | Content |
|---|---|
| `ollos://jobs` | JSON list of all jobs |
| `ollos://jobs/{id}/transcript` | plain text with timestamps |
| `ollos://jobs/{id}/transcript.srt` | SubRip |
| `ollos://jobs/{id}/transcript.speakers` | transcript with speaker labels |
| `ollos://jobs/{id}/speakers` | speakers.json |
| `ollos://jobs/{id}/ocr` | on-screen text per frame |
| `ollos://jobs/{id}/report` | review report (Markdown) |
| `ollos://jobs/{id}/events` | job timeline (ndjson) |
| `ollos://jobs/{id}/sheet/{n}` | contact sheet JPEG |
| `ollos://jobs/{id}/frame/{n}` | single frame JPEG |

## Context budget

Responses are capped at ~20 000 estimated tokens (below Claude Code's 25 000 per tool result). Text that originated in the media is wrapped in `<untrusted-content source="media">` — it is data, not instructions.
