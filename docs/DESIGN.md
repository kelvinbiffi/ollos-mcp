# ollos-mcp — Design Document

| | |
|---|---|
| **Status** | Implemented (0.1.0). Kept current: every number below was measured, and the "Alternatives" and "Risks" sections are updated when a decision changes. |
| **Author** | Kelvin Biffi |
| **Repository** | [github.com/kelvinbiffi/ollos-mcp](https://github.com/kelvinbiffi/ollos-mcp) · npm `ollos-mcp` |
| **Format** | Google-style design doc: context, goals and non-goals, measurements, design, APIs, alternatives considered, cross-cutting concerns, risks. |
| **Also in** | [Portuguese](DESIGN.pt-BR.md) (original working document, September 13 2026) |

> *Ollos* is Galician for *eyes*. The agent gets to see and hear.

---

## 1. Context and scope

Coding agents (Claude Code, Cursor, Codex) cannot ingest audio or video. Anyone who needs an agent to work with a recorded meeting, a lesson, a downloaded YouTube or Instagram video, or a screen recording, today does one of three things: pays a transcription API, installs a Python pipeline, or pastes frames by hand.

ollos-mcp is an MCP server written in **plain Node** that gives an agent local, offline, free ears and eyes: transcription with who-spoke-when, keyframes that fit inside a context window, on-screen text, and a pre-publish review that warns before you upload a video with your API key visible — something that actually happened on the author's machine, at 2:50 of the test video, while this project was being built.

**In scope for this version:** local files, direct URLs, video-site links (YouTube, Instagram, TikTok…), Zoom local-recording folders; audio, video and images; output to any MCP client, a CLI, and direct library use.

**Who uses it:** the author first (reviewing his own videos, transcribing mentoring calls), then technical content creators and teams that record meetings.

---

## 2. Goals and non-goals

### Goals

1. **`npm install` and it works.** No Python, no compiler toolchain, no Redis, no API key. Windows, macOS, Linux.
2. **Never block the client.** Every long operation becomes a job; no tool takes more than seconds to answer.
3. **Never blow the context window.** Ten minutes of video become a handful of images and a few KB of text, with the rest available on demand.
4. **Fail loudly.** No silent partial results. Every output has a schema, every error a stable code and a next step.
5. **Be measurable.** Every capability has a metric, a fixture and a published number.
6. **Local by default.** The file never leaves the machine unless the user asks for a URL to be fetched.

### Non-goals

- Not a video editor. It points at cuts; it does not cut.
- It does not summarise, judge content or write. That is the calling agent's job.
- Not a replacement for channel analytics (vidIQ, YouTube Studio).
- No real-time / live processing. Finished files only.
- Not a competitor to `claude-real-video` on "let the AI watch a video" — see §4.

---

## 3. What was measured

Everything below ran on the author's machine (Intel i9-12900HX, 16 cores / 24 threads, 68 GB RAM, Node 20.11, Windows 11) against a real 11:37 screencast (1890×1080, HEVC, with a webcam overlay) and, later, the public fixtures in `eval/`. These numbers are the basis for the decisions in §5.

### 3.1 Installation

| | |
|---|---|
| `@huggingface/transformers` 4.2.0 | **8 s, 49 packages, zero native compilation** |
| `onnxruntime-node` | prebuilt binary per platform, no `node-gyp` |
| `tesseract.js` 6.0.1 | WASM; language data downloaded on first use |

### 3.2 Transcription (Whisper via ONNX)

| Model | Speed | First load | "MCP servers" | "n8n" | "VS Code" | "Claude Code" |
|---|---|---|---|---|---|---|
| `whisper-base` | 5.4× real time | 9 s | "NPC servers" ✗ | "n820" ✗ | "Vesco Code" ✗ | "Cloud Code" ✗ |
| `large-v3-turbo` q4 | **1.7× real time** | 55 s | ✓ | ✓ | ✓ | "Cloud Code" ✗ |

The one remaining error is phonetically identical in Portuguese and is fixed by the glossary (§5.5).

### 3.3 Transcription does not parallelise

| Configuration | 2 × 45 s of audio |
|---|---|
| 1 session, ONNX Runtime default threads, sequential | **31.6 s** |
| 2 sessions, default threads, in parallel | 50.0 s (0.59×) |
| 2 sessions × 8 threads, in parallel (same-run control) | 31.0 s (1.02×) |
| 1 session forced to 24 threads | 79.4 s |

ONNX Runtime already saturates the physical cores on its own. Two sessions contend and lose; forcing the logical thread count is 2.5× slower. **ASR concurrency is 1.** Speed on long recordings comes from skipping silence (VAD) and from running *different stages* in parallel (audio ‖ vision ‖ OCR), not from two Whispers.

### 3.4 Diarization

| Stage | ONNX model | Measured |
|---|---|---|
| Segmentation | `pyannote-segmentation-3.0` | load 3.0 s · **310× real time** · 46 segments in 60 s |
| Speaker embedding | `wespeaker-voxceleb-resnet34-LM` | load 3.7 s · 256 dims · three 5-second embeddings in 2.7 s |

Segmentation alone labelled **three** speakers on a **one**-person video: its ids are local to each 10-second window. Embedding + clustering is mandatory, not optional. Same-speaker cosine similarity measured **0.47–0.53** on noisy screencast audio — lower than the 0.6–0.8 typical of clean speech — so the merge threshold is exposed as a parameter. First pipeline run: 8 speakers on one person. After embedding only turns ≥ 1.5 s, clustering at 0.35 and absorbing tiny clusters: **1 speaker**.

The evaluation (§10.5) then found the failure mode that the threshold cannot fix. On the IBM lightboard talk, one voice against itself:

| Windows compared | Cosine |
|---|---|
| 5 s windows at 10 s, 20 s, 70 s of clean speech | 0.75–0.83 |
| 2 s cut vs 5 s window, same voice | 0.51–0.86 |
| clean speech vs the same voice over background music (44–48 s, 212–226 s outro) | **0.06–0.16** |
| the two music regions against each other | 0.67 |

Sweeping the threshold from 0.35 down to 0.20 produced identical clusters. Music under the voice moves the embedding further than a different speaker would; a jingle becomes a "speaker". The fix belongs upstream of clustering (music-aware turn filtering), and the tool is marked experimental with this stated.

### 3.5 Keyframes on a screen recording

ffmpeg scene detection, the heart of the existing tools, **is nearly blind on screencasts**:

| `scene` threshold | Frames in 697 s | Mean interval |
|---|---|---|
| 0.05 | 135 | 5 s |
| 0.10 | 65 | 11 s |
| 0.20 | 17 | 41 s |
| **0.30** | **4** | **174 s** |
| 0.40 | 0 | — |

Scrolling, typing and streaming text do not "change scene". The four frames at 0.3 were two window switches and the API-key modal — hard cuts are caught, evolving content is not.

`mpdecimate` (pixel-difference dedup) removed **0 of 697** frames at 1 fps. Excluding the webcam region: 14 %. Masking it: 9 %. Pixels never stop changing in a screencast.

**A perceptual hash does the job:**

| dHash 8×8, Hamming ≥ | Frames kept | Dedup |
|---|---|---|
| 3 | 230 | 67 % |
| **6** | **140** | **80 %** |
| 10 | 98 | 86 % |
| 14 | 85 | 88 % |

One frame every 5–8 s, real coverage, ~11–16 contact sheets for 11 minutes. This is the basis of §5.6.

### 3.6 OCR and secret detection

| Input | Time | Confidence | On-screen URL |
|---|---|---|---|
| Full frame, 1× | 7.0 s | 60 % | not found |
| Full frame, 2.5× | 16.3 s | 82 % | found, **split by spaces** ("up. railway .app") |
| Region crop, 3× | **2.8 s** | **90 %** | **intact** |
| Right half, 2× | 10.9 s | 87 % | intact |

8–10 px text in the source is unreadable at 1×; in upscaled tiles it is. Hence: OCR per tile, never the whole frame, and a normalisation pass that re-joins URL-like and token-like sequences.

On the "API Key Created" modal: title recognised, instruction text recognised, and a **157-character high-entropy string** detected. The plain JWT regex **missed** — OCR read `eyJ` as `eyl`. With an OCR-tolerant JWT pattern, native-resolution frames and a centred OCR tile, the end-to-end run reports `high · jwt · near "API Key"`. The first scanner version also produced 58 false positives by running the entropy test on whitespace-stripped text; that is now a regression test.

### 3.7 Memory

Sampled every 200 ms in-process (`scripts/probe-memory.mts`), on the IBM fixture, after the fixes below:

| Step | Peak RSS | Live ArrayBuffers |
|---|---|---|
| Node + ollos, nothing loaded | 0.2 GB | ~0 |
| `whisper-base` transcribing 60 s | 1.9 GB | |
| `whisper-large-v3-turbo` transcribing 60 s | **4.3 GB** | 0.09 GB |
| + diarization models | 4.4 GB | 0.10 GB |
| + `multilingual-e5-small` for search | **5.1 GB** | |
| keyframes alone (ffmpeg + sharp, no models) | 0.2 GB | |

Before the fix the same run peaked at **~10 GB**, and the eval's first probe showed RSS climbing by 4.8 GB *after* a transcription had finished. Tracing async file operations with `async_hooks` found 42,000 `fs.createReadStream` reads in 4 s: transformers.js' `FileResponse` opens a stream of every cached file in its constructor and pipes it into a web `ReadableStream`; for `.onnx` files in Node only the *path* is used, so nothing reads the stream, and the whole 2.43 GB encoder weights file (twice — two lookups) sat in JavaScript buffers until garbage collection. `PathCache` (§5.11) answers those lookups with a string path, which transformers.js forwards to ONNX Runtime unchanged. A 2× reduction in the minimum machine, found by measuring rather than by reading the docs.

### 3.8 Client

The author's Claude Code was 2.1.141. The v2 runtime (MCP SDK 2.0, protocol 2026-07-28, Tasks extension) requires ≥ 2.1.232. This decides §5.3.3.

---

## 4. What the community had already paid to learn

### 4.1 The direct competitor

**`claude-real-video`** (crv): 2,134 stars, 188 forks, Python, MIT, created 30 June 2026, pushed two days before this doc was written. Zero open issues — the author closes fast. A paid analytics add-on. Publishes to the **MCP Registry** (`server.json` + `mcp-publisher` via GitHub OIDC) and ships a **SKILL.md** that teaches the agent how to use it.

**Its MCP has 5 tools** (`watch_video`, `get_frames`, `search_memory`, `list_watched`, `get_transcript`) and **zero** occurrences of `timeout`, `asyncio`, `background`, `job` or `progress` in the code: **every call blocks**. On a long video it hits the documented timeout wall (§4.3). That is our engineering advantage and the reason §5.3 exists.

`search_memory` searches spoken words and on-screen text across everything watched — retrieval. They validated the demand; we do it with metrics (§10.5).

**Its closed issues, grouped:**

| Pattern | Issues | Lesson |
|---|---|---|
| **Silent failure** | #15 (0 frames instead of an error), #19 (`--to` silently drops timestamps), #20, #22 (a broken import swallows `frames.json`) | Goal 4: fail loudly. Every stage validates its output or throws |
| Environment | #14 (ffmpeg 9 removed `-vsync`, everything broke), #26 (a 146 MB `.venv` committed) | `ffmpeg-static` pins a version; `.gitignore` from the first commit |
| Analysis window | #16 (`--from/--to`), #17 (frame resolution) | `from`/`to` and `frameWidth` in v1 |
| Sources | #18 (Grain meeting links), #12 (yt-dlp passthrough) | Extensible resolver; `ytDlpArgs` allow-list |
| Vision | #2 (squash/stretch missed), #5 (text anchors), #7 (per-frame timestamps) | Adaptive selection, transcript anchors, timestamps preserved through dedup |
| Export | #10 (LosslessCut format) | Cut suggestions in the review; EDL export on the roadmap |

### 4.2 What production teaches about Whisper

A 353-upvote r/LocalLLaMA post by people running a meeting bot in production (Vexa, Apache-2.0, 2,778 stars): Whisper **does not go quiet on silence — it invents text**, confidently and coherently ("Thank you.", "Subtitles by the Amara.org community", repetition loops). The *Careless Whisper* paper (FAccT 2024) measured 38 % violent or harmful content among hallucinations.

Their five layers, all adopted in §5.5:

1. **Silero VAD as gatekeeper** — Whisper never sees non-speech audio
2. **No conditioning on previous text** — one hallucination does not seed the next window
3. **Exact blocklist per language** — they maintain `pt.txt`, hand-verified
4. **Loop detection** — the same 3–6-word phrase three or more times → collapse and advance
5. **Greedy decoding** — fails fast on silence instead of searching for a plausible completion

Plus a technique worth gold: the **harvester** — feed silence and white noise through the model, forcing each language; whatever comes out is a hallucination by construction. Generates the blocklist per model, reproducibly.

### 4.3 What the MCP community teaches

**Timeouts are short and documented**: Messages API with MCP ~60 s, Claude Desktop 300 s, Claude Code configurable (`MCP_TOOL_TIMEOUT`). An MCP server restart kills the agent session. A server returning 200 with a garbage payload burns the agent silently.

**Tool bloat is complaint number one**: five servers = 50–80 definitions re-read every turn. The paper *MCP Tool Descriptions Are Smelly* (856 tools, 103 servers) found **97.1 % of descriptions have at least one defect**: unclear purpose (56 %), unstated limitations, opaque parameters, no example.

**Official guidance** (Anthropic, *Writing effective tools for AI agents*): "more tools don't always lead to better outcomes"; consolidate workflows instead of exposing operations; namespace by service; return only high-signal data; offer `concise | detailed`; **Claude Code truncates tool results at 25,000 tokens**. And (*Manage tool context*): tool search only pays off **above ~20 tools**. The official `filesystem` reference server has **13**.

**MCP spec 2026-07-28** (*Client Best Practices*): progressive discovery when definitions exceed 1–5 % of context; `outputSchema` matters because it enables typed programmatic calling; changing the tools array mid-conversation invalidates the prompt cache — **keep the surface stable**.

### 4.4 The meeting use case

A 27-upvote r/ObsidianMD workflow (`scriba`): Zoom → Whisper large-v3 + pyannote → Markdown by speaker. Three ideas worth copying: a **10-second voice clip per speaker** embedded in the output (renaming `SPEAKER_00 → Ana` takes seconds — you listen and you know), **honest uncertainty marking** (crosstalk, mumbling) instead of guessing, and a **sidecar with per-word confidence** ("if you run AI over it, it knows which lines to trust"). One pain: pyannote requires a Hugging Face token. The `onnx-community` ONNX ports **do not** — our advantage.

**Zoom records one audio file per participant** ("Record a separate audio file for each participant") — but **only for local recordings**, not cloud. When present, diarization is free and exact. **Google Meet records a single mixed track.** The resolver recognises the Zoom folder (§5.7).

Privacy is a real position: threads with 61 and 9 upvotes from people uncomfortable with recording and transcription without consent. "Nothing leaves your machine" is a selling point, not a footnote.

### 4.5 Downloading from links is unstable ground

yt-dlp breaks often (YouTube age restrictions "for the tenth time", TikTok, Instagram requiring login). The `youtube-dl-exec` wrapper downloads, on Linux/macOS, the generic 3 MB `yt-dlp` — a **Python zipapp that requires Python installed**. Standalone binaries exist (`yt-dlp_linux` 40 MB, `yt-dlp_macos` 37 MB, `.exe` 18 MB). To keep the "no Python" promise, those are the ones to bundle.

---

## 5. Design

### 5.1 Overview

```
                    ┌──────────────────────────────────────────────┐
  Claude Code ──┐   │  ollos-mcp                                   │
  Cursor ───────┼──►│  mcp/   stdio · tools · resources            │
  Claude Desktop┘   │  cli/   ollos <cmd>                          │
                    │  ─────────────────────────────────────────── │
  n8n / script ────►│  core/                                       │
  (imports directly)│   source   path · URL · yt-dlp · Zoom folder │
                    │   jobs     disk queue · heartbeat · classes  │
                    │   audio    VAD · ASR · anti-hallucination ·  │
                    │            diarization                       │
                    │   vision   dHash · cuts · sheets · OCR ·     │
                    │            secrets                           │
                    │   review   loudness · silences · aspect      │
                    │   search   local embeddings · BM25 · index   │
                    │   cache    content-addressed                 │
                    └──────────────┬───────────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
        ffmpeg-static       onnxruntime-node      tesseract.js
        (decode, measure,   (Whisper, pyannote,   (OCR, WASM)
         extract frames)     WeSpeaker, e5)
```

Everything runs inside the server process on the user's machine. Network is used only to download models once and to fetch a source URL the user passed.

### 5.2 Package and layers

**One publication, three entry points**, with one boundary rule:

```
ollos-mcp/
  src/core/     ← never imports from mcp/ or cli/
  src/mcp/      ← adapts core to tools / resources
  src/cli/      ← adapts core to the terminal
  skills/       ← SKILL.md for agents
  server.json   ← MCP Registry manifest
```

Why not a monorepo with three packages: three version numbers, three changelogs and three READMEs to solve a problem that does not exist yet. The internal boundary delivers 90 % of the benefit — anyone can import `ollos-mcp` from a script, an n8n node, a Lambda. If the core ever grows its own audience, splitting is cheap because the boundary already exists.

### 5.3 The task engine

#### 5.3.1 Derived requirements

- Transcribing 11 min takes ~7 min; a 2-hour meeting over an hour. Every tool that does this **must** return immediately.
- A server restart cannot lose work → state on disk.
- ASR does not parallelise (§3.3) → concurrency per **resource class**, not global.
- "`npm install` and it works" → no Redis, no external database.

#### 5.3.2 State on disk

```
$OLLOS_HOME/                       (default ~/.ollos)
  jobs/<jobId>/
    job.json          state, params, progress, heartbeat, schema version
    result.json       written once, at completion
    events.ndjson     one line per event (§10.3)
    artifacts/        transcript.json · sheets/*.jpg · ocr.json · report.md · voices/
  cache/              §5.10
  models/             ONNX model cache (transformers.js cache dir)
  index/              §5.8
```

**Atomic writes**: `job.json.tmp` → `rename`. On the same volume rename is atomic; a half-written `job.json` never exists.

**State machine**:

```
queued ──► running ──► completed
   │          ├──────► failed        (structured cause)
   │          └──────► interrupted   (heartbeat > 30 s stale)
   └─────────────────► cancelled
```

The worker touches `job.json` every 5 s. On startup the server sweeps `jobs/` and marks every `running` job with a stale heartbeat as `interrupted` — the agent gets an honest state instead of waiting forever. Cancellation aborts through an `AbortSignal`; whatever the pipeline throws while aborting (ffmpeg killed, a plain `Error`), an aborted signal means `cancelled`, not `failed` — a test caught the first version getting this wrong.

**Concurrency by class**:

| Class | Default | Why |
|---|---|---|
| `asr` | 1 | §3.3; diarization shares it |
| `vision` | 2 | ffmpeg + dHash are light and I/O-bound |
| `ocr` | 2 | WASM, one Tesseract worker per slot |
| `download` | 2 | network |

#### 5.3.3 Protocol representation: two modes

The official **MCP Tasks** extension (`io.modelcontextprotocol/tasks`, spec 2026-07-28) does exactly this: `tools/call` returns `{ resultType: "task", taskId, status, ttlMs, pollIntervalMs }` and the client calls `tasks/get` and `tasks/cancel`. The server **may only** return a task to a client that declared the capability, and only after the task is durable.

What the SDKs ship today (measured in the tarballs): `@modelcontextprotocol/sdk` 1.30 has the **experimental 2025-11 shape** (`tasks/result`, `tasks/list`, no `resultType`); `core`/`server` 2.0.0 have `CreateTaskResult` and `resultType` but not `tasks/update` or the extension id. The author's client is on the v1 runtime.

**Decision**: the engine of §5.3.2 is **protocol-agnostic**. Adapters sit on top:

1. **Tools mode** — always available, and the only one implemented in 0.1.0: the tool returns `{ status: "queued", jobId, etaSeconds, next: "ollos_job" }`, and `ollos_job` / `ollos_cancel` play the role of `tasks/get` / `tasks/cancel`.
2. **Tasks mode** — planned: when the client declares the capability, `tools/call` returns `CreateTaskResult`. The job id is the same in both modes.

#### 5.3.4 The fast path

`ollos_probe` is always synchronous. For the rest, the server **estimates** the cost from the duration and the stages requested; under 8 s predicted it runs inline and returns the final result directly. A `review` of `loudness` + `aspect` on a 2-minute video is not a job. The agent handles both returns through the same `status` field.

### 5.4 Tool surface — why ten, not five or fifteen

The right question is not "how many" but **"what is the splitting criterion"**. Three sources converge: Anthropic says consolidate **workflows** but name and describe each tool as you would to a new colleague, with limitations and examples; the 856-tool paper's most common defect is **opaque parameters** — exactly where a "single tool with fifteen flags" dies (the competitor's issues #19/#20 are precisely this); the official `filesystem` server has 13, and tool search pays off at ~20.

**Criterion: one tool per distinct contract.** Distinct contract = different input, different output, or different latency class. Variation within a contract is a parameter.

| Tool | Sync | Contract |
|---|---|---|
| `ollos_probe` | yes | media → metadata |
| `ollos_transcribe` | hybrid | media → timestamped text with confidence |
| `ollos_diarize` | hybrid | media (+ transcript) → speaker turns, voice clip per speaker |
| `ollos_keyframes` | hybrid | video → contact sheets + frame index |
| `ollos_read_screen` | hybrid | video/image → on-screen text per frame **and secret findings** |
| `ollos_review` | hybrid | video → pre-publish verdict with per-check findings |
| `ollos_search` | yes | question → passages with time and source |
| `ollos_frames` | yes | job + indices → images |
| `ollos_job` | yes | jobId → state, progress, result |
| `ollos_cancel` | yes | jobId → cancel |

**Parameters, not tools:** `loudness`, `silences`, `aspect` are `checks` of `ollos_review` (same input, same output shape, same latency). `secrets` is a facet of `ollos_read_screen`'s output — detecting a secret *is* reading the screen with a lens; a separate tool would duplicate the OCR. `from`/`to` and `format` are parameters everywhere.

**Not a parameter:** `diarize` as a flag of `transcribe`. Latency differs 180× (ASR at 1.7× real time; segmentation at 310×), failure differs, output differs.

Namespace `ollos_` in snake_case, following the official `filesystem` server. Descriptions follow the paper's rubric: purpose, when to use, limitations, each parameter, an example — **at least three or four sentences**. Every tool declares `outputSchema` and returns `structuredContent` with **exactly** the declared keys (the SDK validates strictly; `ollos_probe` failed the first protocol smoke by emitting an undeclared `bitrate`).

**The surface never changes at runtime.** No conditional tools by client capability — that invalidates the client's prompt cache every time (§4.3).

### 5.5 Audio pipeline

```
source ─► ffmpeg (16 kHz mono f32) ─► Silero VAD ─► speech-only windows (≤ 28 s, 2 s overlap)
       ─► whisper-large-v3-turbo (q4, greedy) ─► anti-hallucination filters ─► glossary
       ─► [diarize] segmentation ─► embedding per turn ─► clustering ─► alignment
       ─► transcript.json + .txt + .srt
```

**VAD first.** Silero (`onnx-community/silero-vad`) runs on the single shared ONNX Runtime instance — two copies of the native binding measured as an API-version mismatch followed by a segfault, so `src/core/ort.ts` resolves the copy transformers.js resolves. If Silero cannot load, an energy gate takes over and the result says so.

**Whisper turbo by default** (§3.2). `base` is available as `model: "fast"`. Production-derived parameters: no conditioning on previous text, greedy decoding, 30-second chunks with 5-second stride, timestamps on.

**Glossary.** `vocabulary: string[]` corrects the transcript **toward** the supplied terms when a transcribed n-gram is within a tight edit distance (1 edit for ≤ 5 characters, ≤ 34 % otherwise). It cannot invent words; it fixes "Cloud Code" and leaves "o clima" alone. Both are unit tests.

**Anti-hallucination, four filters** per segment: exact blocklist after punctuation normalisation (seeded from Vexa's `pt.txt` and `en.txt`, Apache-2.0, credited); a 3–6-word phrase repeated three or more times collapsed to one; speech coverage under the segment below 15 % → dropped; more than 8 words per second → flagged.

**Confidence** is a heuristic: 55 % speech coverage, 30 % speaking-rate plausibility, 15 % whether any filter fired. The schema says so. transformers.js' pipeline does not expose token log-probs; pretending otherwise would be worse than a documented heuristic.

**Diarization in three stages** (§3.4): segmentation produces local turns; each turn ≥ 1.5 s becomes a 256-dimensional WeSpeaker embedding (up to 8 s from the turn's middle); average-linkage clustering on cosine similarity merges turns while similarity ≥ 0.35; clusters with ≤ 2 turns and < 5 % of talk time are absorbed into their nearest neighbour; shorter turns attach to the nearest labelled turn in time. Output: `SPEAKER_00`, `SPEAKER_01`… with an **8-second voice clip** each so a person can rename them by ear.

**Zoom shortcut**: a local recording folder with `Audio Record/` yields one speaker per file, named — the three stages are skipped and the result is exact.

### 5.6 Vision pipeline

```
video ─► 1 fps, grey 9×8 ─► dHash ─► dedup at Hamming ≥ 6
      ─► ∪ hard cuts (scene > 0.3, +0.4 s) ─► ∪ anchors ─► floor: ≥ 1 frame / 20 s ─► cap maxFrames
      ─► JPEG frames ─► 3×3 timestamped contact sheets
      ─► [OCR] 2×2 tiles + centre tile, 3× ─► normalisation ─► three-signal secret scan
```

**Frame selection** unions four candidate sources and prunes: dHash captures evolving content on screencasts; hard cuts mark the exact instant of a window switch or a modal (the modal appeared at 169.67 s, not 169 s — the cut frame is taken 0.4 s later so the new screen has settled); transcript anchors solve the lecture whose slide barely changes; a 20-second floor is the safety net for static video. Pruning to `maxFrames` drops the least-changed hash frames first and never drops a cut or an anchor. Every frame keeps its exact `pts` through dedup.

**Presenter mask** (`presenterRegion`): zeroes the webcam region before hashing. Measured 6–9 % more dedup; a parameter, not a default, because automatic detection of the region is future work.

**Contact sheets** are 3×3 by default with the timestamp burned into each tile. `ollos_frames` returns sheets by index, or a single frame for a close-up.

**OCR** runs Tesseract per tile at 3× (§3.6) on frames extracted at **native width** — the first end-to-end run downscaled frames to 1600 px and lost the API key entirely. The 2×2 grid gets a fifth, centred tile because modals sit exactly where a grid cuts. URL-like and token-like sequences are re-joined when OCR splits them.

**Secret scanner, three signals**:

| Signal | Catches | Measured |
|---|---|---|
| **Pattern** | known prefixes (`sk-`, `sk-ant-`, `ghp_`, `AKIA`, `AIza`, `xox`, `sk_live_`), JWT with OCR-tolerant header (`ey[JlI1]`), `Bearer`, private-key blocks, `.env` assignments, private deployment URLs, local URLs, e-mail, CPF | the Railway URL, intact; the JWT once the header tolerance was added |
| **Entropy** | alphanumeric tokens ≥ 32 chars, ≥ 2 digits, Shannon ≥ 3.7 bits, ≥ 25 % class transitions, **contiguous in the original text** | the 157-char key when the pattern missed |
| **UI context** | words within ±90 chars: "API Key", "Created", "copy", "token", "secret", "password", ".env", "won't be able to see" | "API Key Created" + "Make sure to copy", read at 66 % while the key itself came out mangled |

Confidence policy: `high` only for strong patterns; `medium` for deployment/local URLs, weak patterns with context, or entropy with context; `low` for the rest and for personal data. Only `high` blocks a review. Running entropy on whitespace-stripped text glued prose into fake tokens and produced 58 false positives on the first real run — the exact strings are now regression tests. **The secret never leaves the tool whole**: findings carry `abcd…xyz` and the length.

### 5.7 Source resolver

Accepts four forms and normalises to a local file whose real type `ffprobe` decides (never the extension):

| Input | Handling |
|---|---|
| Local path | validated |
| Folder | if it has Zoom's `Audio Record/` layout → multi-track source; otherwise a clear error |
| `https://` direct | downloaded to the cache respecting `content-length`; 2 GB cap enforced mid-stream |
| Video-site URL | `yt-dlp` from `OLLOS_YTDLP` or `PATH`; `cookiesFile`; `ytDlpArgs` through an allow-list; **best effort**, with the yt-dlp message and a hint in the error |
| `data:` / base64 | written to the cache |

A task incompatible with the detected kind (`transcribe` on an image) fails before any work starts.

**SSRF**: private ranges (10/8, 172.16/12, 192.168/16, 127/8, link-local, CGNAT, ULA, multicast) refused by default after resolving every address of the host; `OLLOS_ALLOW_PRIVATE=1` to opt out. An MCP server runs with the user's credentials; external input is hostile until proven otherwise.

### 5.8 Search (local retrieval)

`ollos_search` answers "what was said about X" and "when did Y appear on screen" without pouring the transcript into the agent.

- **Index per job** in `index/<jobId>/`: each speech segment and each OCR block becomes a document `{ text, start, end, kind, speaker? }`
- **Local embeddings**: `Xenova/multilingual-e5-small` (`query:` / `passage:` prefixes, mean-pooled, normalised). Multilingual because a Portuguese meeting quotes English terms.
- **Hybrid**: BM25 (names, acronyms, numbers — "n8n", "401") + cosine, fused by reciprocal rank (k = 60). Identical passages from the same media are shown once.
- `scope: "job" | "all"` — `all` is the competitor's `search_memory`: everything ollos has seen, searchable.

Indexes are built lazily at the first search over each completed job, so pipelines stay decoupled from search. Retrieval has its own metrics — hit rate, recall@k, MRR, NDCG — and they belong in `eval/`.

### 5.9 Context budget

Hard rule: **no tool dumps a whole artifact into the response.**

- Every output has `format: "concise" | "detailed"`; concise is the default.
- `transcribe` concise: language, duration, counts, the first ~700 characters, and the **resource URI** for the full text.
- `keyframes` concise: counts and the sheets as `resource_link`s; the agent asks for an image with `ollos_frames`.
- `review` concise: findings with verdicts, at most eight per severity, the rest in the report.
- Cap per response: 20,000 estimated tokens (below Claude Code's 25,000), with **announced** truncation and a pointer to the resource.

Text that came out of the media is returned inside `<untrusted-content source="media">`. It is data, not instructions.

### 5.10 Content-addressed cache

Key = identity of what went in **plus** every parameter that changes the output:

```
transcript: <mediaId>:<model>:<lang>:<vocabulary>:<from>:<to>:<track>
keyframes:  <mediaId>:<sensitivity>:<maxFrames>:<frameWidth>:<presenterRegion>:<floor>:<anchors>
ocr:        <mediaId>:<frame pts…>:<languages>:<detectSecrets>:<SCANNER_VERSION>
```

Local media identity: full SHA-256 up to 64 MB, `size + mtime + path` above. In an agent loop the model re-asks about the same media; without the cache every question costs seven minutes. `SCANNER_VERSION` is part of the OCR key so that improving the scanner invalidates stale findings.

### 5.11 Models

| Role | Model | Approx. size |
|---|---|---|
| ASR default | `onnx-community/whisper-large-v3-turbo` (fp32 encoder 2.43 GB, q4 decoder 0.32 GB) | 2.75 GB |
| ASR fast | `Xenova/whisper-base` | 280 MB |
| VAD | `onnx-community/silero-vad` | ~2 MB |
| Segmentation | `onnx-community/pyannote-segmentation-3.0` | ~6 MB |
| Speaker | `onnx-community/wespeaker-voxceleb-resnet34-LM` | ~26 MB |
| Text embedding | `Xenova/multilingual-e5-small` | 465 MB |
| OCR | Tesseract `por` + `eng` | ~15 MB |

None requires a token. Downloads are lazy per capability with progress; `ollos warmup [--all]` fetches ahead; `OLLOS_OFFLINE=1` forbids network and fails clearly if a model is missing.

Model files are served to transformers.js through ollos' own `PathCache` (same on-disk layout as the library's `FileCache`, so nothing is downloaded twice): ONNX weights are returned as a path string, which the library hands to ONNX Runtime to memory-map; JSON and tokenizer files are returned as an in-memory `Response`. This exists because the library's cache streams every hit into memory whether or not anyone reads it (§3.7).

---

## 6. APIs

See [TOOLS.md](TOOLS.md) for the full reference. The shapes in one screen:

```ts
type Started = { status: 'queued'; jobId: string; etaSeconds: number; next: 'ollos_job' }
type Done<T> = { status: 'completed'; jobId: string; cached: boolean; result: T }

ollos_probe({ source })                                   → MediaInfo
ollos_transcribe({ source, language?, model?, vocabulary?, audioTrack?, from?, to?, format? })
                                                          → Started | Done<TranscribeResult>
ollos_keyframes({ source, sensitivity?, maxFrames?, frameWidth?, presenterRegion?, anchorsSec?, from?, to? })
                                                          → Started | Done<KeyframesResult>
ollos_read_screen({ source, languages?, detectSecrets?, sensitivity?, maxFrames?, presenterRegion?, from?, to? })
                                                          → Started | Done<ReadScreenResult>
ollos_review({ source, checks?, platform?, presenterRegion?, from?, to? })
                                                          → Started | Done<ReviewResult>
ollos_diarize({ source, transcriptJobId?, similarityThreshold?, maxSpeakers?, minSpeakers?, from?, to? })
                                                          → Started | Done<DiarizeResult>
ollos_search({ query, scope?, jobId?, k?, kind? })        → SearchResult
ollos_frames({ jobId, sheets?, frames?, maxImages? })     → images
ollos_job({ jobId, format? })                             → status / progress / result
ollos_cancel({ jobId })                                   → status
```

Errors: `isError: true` with `{ code, message, hint }` — stable code, natural-language message, next step.

---

## 7. Data storage

Everything under `$OLLOS_HOME` (§5.3.2). No database. `job.json` and `result.json` carry `schemaVersion`; migrations are pure functions per version. `events.ndjson` is append-only. `ollos gc --older-than 30d` removes jobs and cache; models stay. Nothing is sent anywhere — there is no telemetry.

---

## 8. Degree of constraint

Almost greenfield: a new package with no legacy. The real constraints come from outside — agents' context windows, MCP clients' timeouts, the still-moving shape of the Tasks extension, and yt-dlp's instability. All treated as design premises, not surprises.

---

## 9. Alternatives considered

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Runtime | Node + ONNX (transformers.js) | Python + faster-whisper | Python is faster at ASR but breaks "npm install and it works" and duplicates the competitor. The Node niche was empty |
| ASR engine | Whisper ONNX (CPU) | whisper.cpp bindings (`nodejs-whisper`, `smart-whisper`) | Native is 2–3× faster but needs cmake / Build Tools or drops Windows. Adoption over speed |
| Cloud | None by default | OpenAI Whisper API, Deepgram | Recurring cost (the project's reason to exist) and the file leaves the machine. Pluggable later as an optional provider |
| Queue | Filesystem | BullMQ + Redis | Redis breaks single-command install; the queue is single-host by definition |
| Task protocol | Own engine + adapters | MCP Tasks only | The author's client does not support it; the final shape is not in the SDKs yet |
| Tools | 10, one per contract | 5 (competitor) or 15+ granular | 5 pushes variation into opaque flags (the paper's top defect); 15 dilutes descriptions and weighs on context |
| Keyframes | dHash ∪ cuts ∪ anchors ∪ floor | Scene detection only | Scene at 0.3 left 4 frames in 11 minutes of screencast |
| Dedup | Perceptual hash | `mpdecimate` | Removed 0 % (§3.5) |
| OCR | Tesseract.js per tile | PaddleOCR / Florence-2 in ONNX | Better quality but ~1 GB more model and no ready `por`. Revisit if the eval demands it |
| Diarization | pyannote + WeSpeaker, ONNX, no token | pyannote Python (HF token) | Install friction and Python |
| Downloads | Standalone yt-dlp binary | `youtube-dl-exec` as-is | On Linux/macOS it fetches the zipapp that needs Python |
| Package | One, with a `core/` boundary | Three-package monorepo | Complexity without a problem to justify it yet |

---

## 10. Cross-cutting concerns

### 10.1 Security

SSRF guard in the resolver; mandatory masking of secrets in every output, log and event; media-derived text wrapped as untrusted content and the skill instructs agents to describe, never obey; no `eval`, nothing executed from media; `ytDlpArgs` through an allow-list; resource URIs resolved only under the job's own artifacts directory; **stdout guarded in the MCP entry point** — Tesseract writes "Image too small to scale!!" to stdout, which would corrupt JSON-RPC framing, so only JSON-RPC lines pass and everything else is diverted to stderr (verified with OCR running inside the server process). Details in [SECURITY.md](../SECURITY.md).

### 10.2 Privacy

Local by default; no telemetry; network only for model download and the requested source. `OLLOS_OFFLINE=1` as proof. The README carries one sentence about consent for recording others — the market cares (§4.4).

### 10.3 Observability

`events.ndjson` per job: `{ ts, stage, event, durationMs?, message?, data }`. The CLI reads it: `ollos jobs`, `ollos events <id>`, `ollos doctor` (versions, models present, ffmpeg, home, job count). No metrics server; a file is enough for single-host and for attaching to a bug report.

### 10.4 Reliability

Fail loud (goal 4): each stage validates its output (frames > 0, audio > 0.5 s, text non-empty when VAD saw speech) or throws `PipelineError` with stage and cause — a direct lesson from the competitor's #15/#19/#22. `ffmpeg-static` pins the ffmpeg version so #14 cannot happen here. Idempotency via the cache. Limits (4 h duration, 2 GB download, 500 frames) are configurable and announced in the error.

### 10.5 Evaluation

What separates "calls the model" from "proves the output is right". The harness in `eval/` runs against public fixtures and writes `eval/RESULTS.md`:

| Capability | Metric | Fixture | Status |
|---|---|---|---|
| Transcription | **WER / CER** after identical normalisation | public videos with YouTube captions (professional where available) | implemented — **1.4 % WER** on professional English captions, 8.9 % on a Portuguese screencast, 26.3 % agreement rate on an auto-captioned interview |
| Diarization | speaker count vs known count | interview with 2 speakers, single-speaker talks | implemented — 1 of 3 exact; the misses are music-under-speech clusters (§3.4); **DER** needs turn-level annotations — the most valuable contribution |
| Keyframes | frames kept per minute; hash vs cuts share | screencast, talking head, lightboard talk | descriptive |
| Secrets | precision / recall by kind | synthetic frames with planted secrets | planned |
| Search | hit rate@5, recall@k, MRR, NDCG@10 | questions with annotated answer passages | planned |

Reference transcripts are YouTube captions, so on auto-captioned fixtures WER is an agreement rate between two recognisers — an upper bound, stated as such. The first full run also caught a real bug: a hard cut in the last 0.4 s of a video produced a frame request past EOF and failed the whole keyframes job. Cut frames are now clamped before the end of the stream and an undecodable instant is skipped with an event (goal 4 still holds: zero frames is an error).

### 10.6 Performance

Concurrency by class; VAD before ASR; OCR only on keyframes; content-addressed cache. Measured: 11-minute screencast → `transcribe` of a 60 s window 140 s cold (model download included), 1 s warm from cache; `keyframes` 0–240 s in 1.6 s cached; full `review` with OCR of 47 frames in 6.7 min; `diarize` of a 2-minute window in 6.7 s warm.

### 10.7 Portability

Node ≥ 20. Windows, macOS, Linux (x64/arm64) via the CI matrix. `ffmpeg-static` and `ffprobe-static` as fallbacks when the system has none; a system ffmpeg is preferred when present.

---

## 11. Distribution

| Channel | How |
|---|---|
| **npm** | `ollos-mcp`, published with provenance from the release workflow; `npx ollos-mcp` |
| **MCP Registry** | `server.json` (`io.github.kelvinbiffi/ollos-mcp`, npm package) + `mcp-publisher login github-oidc` in the release workflow |
| **Skill** | `skills/ollos/SKILL.md`: when to use, how to chain, the untrusted-content rule |
| **CLI** | `ollos probe|transcribe|keyframes|read-screen|review|diarize|search|jobs|job|events|cancel|warmup|doctor|gc` |
| **Library** | `import { createOllos } from 'ollos-mcp'` |

---

## 12. Delivery (as shipped in 0.1.0)

All six planned slices are implemented: ears (probe, transcribe, jobs), eyes (keyframes, frames, sheets), the verdict (review, read_screen, secrets), who spoke (diarize, voice clips, Zoom tracks), memory (search), reach (CLI, skill, registry manifest, CI, docs). Deviations from the plan: diarization shipped as *experimental*; Tasks mode and progress notifications deferred; the standalone yt-dlp is downloaded on demand into `~/.ollos/bin`, not bundled with the package.

---

## 13. Open risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Speech over music becomes its own speaker** (measured: 0.06–0.16 similarity to the same voice on clean speech) | jingles, intros and outros inflate the speaker count | stated in the tool output and README; roadmap: music-aware turn filtering before embedding; Zoom tracks are exact |
| Tasks extension shape still moving in the SDKs | adapter rework | protocol-agnostic engine; tools mode always present |
| yt-dlp breaks frequently | site downloads fail | best-effort, error carries yt-dlp's message, local files always work |
| Text under ~8 px on screen | secret missed | native-width frames, centre tile, several frames around each cut; UI-context signal still flags the situation |
| WASM slow on weak machines | 2-hour meeting takes hours | `model: "fast"`, VAD, honest progress and ETA |
| 2.75 GB download and ~4.3 GB of RAM for the default model | install abandonment, out-of-memory on small machines | explicit `warmup`, progress, `model: "fast"` (280 MB, ~1.9 GB), sizes and a requirements table in the README; roadmap: idle unloading and a memory guard in `doctor` |
| Secret false positives | noise in the review | confidence per finding; `block` only on strong patterns; regression tests from the real run |

---

## 14. Map to the competencies this project demonstrates

| Competency | Where |
|---|---|
| **LLM / ASR evaluation** | §10.5, `eval/` — WER, CER, speaker count, published results |
| **Retrieval and its metrics** | §5.8 — hybrid BM25 + embeddings, RRF; hit rate / MRR / NDCG planned in `eval/` |
| **Agentic tool design** | §5.4 — contract criterion, Anthropic guidance, the description rubric |
| **MCP** | §5.3.3 — tools vs Tasks modes, resources, `outputSchema`, stable surface, stdout discipline |
| **Context windows** | §5.9 — budget, concise/detailed, resources, the 25k cap |
| **AI security** | §10.1 — SSRF, masking, injection via media content, allow-lists |
| **Observability** | §10.3 — per-stage events, `doctor`, timelines |
| **Production AI** | §5.3, §10.4 — durable queue, heartbeat, idempotency, limits, fail loud |
| **Prompt engineering** | §5.5 glossary; the skill as instruction to the agent |
