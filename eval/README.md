# Evaluation

Numbers in the README come from here. The harness runs ollos against public videos and compares:

| Capability | Metric | Reference |
|---|---|---|
| Transcription | **WER / CER** after identical normalisation of both sides | YouTube captions of the video (professional where available, auto-generated otherwise) |
| Diarization | speaker count vs. the known count | fixture metadata |
| Keyframes | frames kept per minute, hash vs. cuts | none (descriptive) |

Results: [`RESULTS.md`](RESULTS.md) (Markdown) and `results.json`.

## Why YouTube captions as ground truth

They are the only reference that exists for arbitrary public videos. Professional captions (IBM, Confluent, Anthropic mark theirs `CC`) are close to a human transcript. Auto-generated captions are themselves an ASR output, so on those fixtures **WER is an agreement rate between two recognisers**, not an absolute error — read it as an upper bound.

## Fixtures

`fixtures.json` holds public metadata only (URL, language, kind, expected speakers). The media and the reference texts are **not** in the repo:

- `fixtures.local.json` (gitignored) maps fixture id → local media path.
- `references/<id>.txt` (gitignored) holds the reference transcript.

To reproduce on your machine:

```bash
# 1. media — through ollos' own resolver (needs yt-dlp; writes eval/fixtures.local.json)
OLLOS_YTDLP=~/.ollos/bin/yt-dlp npm run eval:fetch
#    behind a TLS-intercepting proxy add:  OLLOS_YTDLP_ARGS="--no-check-certificates"

# 2. reference captions — pt or en as listed in fixtures.json
yt-dlp --write-sub --write-auto-sub --sub-lang pt --skip-download -o "~/.ollos/eval/%(id)s" <url>
#    then strip the VTT to plain text into eval/references/<id>.txt
#    (any caption source works: the Scrape Creators / YouTube transcript endpoints return the same text)

# 3. run
npm run eval            # → eval/RESULTS.md and eval/results.json
#    EVAL_NOTES="..." adds a run-conditions line to RESULTS.md (machine load, model versions)
npm run eval -- <id>    # one fixture
```

Add a fixture by appending to `fixtures.json`. Good fixtures are short (≤ 10 min), have known speaker counts, and represent a kind not yet covered.

## What the current results say

See `RESULTS.md`. Interpretation notes:

- **Screencast WER is dominated by product names and UI vocabulary** ("n8n", node names). `vocabulary` in the fixture lowers it; the fixture records whether one was used.
- **Diarization** is judged on speaker count only for now. A proper DER needs turn-level annotations; contributions of annotated meetings (even 5 minutes) are the most valuable thing you can add here.
- **Where the extra speakers come from.** On the two fixtures that over-count, the extra cluster is the speech that has music under it (the IBM outro, the podcast jingles). `scripts/probe-speaker-embeddings.mts` measures it: one voice scores 0.58–0.86 cosine with itself across positions and lengths, and 0.06–0.16 once music is mixed in. Lowering the merge threshold from 0.35 to 0.20 changes nothing, so the fix is upstream (music-aware turn filtering), not in the clustering.
- **Speed** is wall-clock on whatever else the machine is doing; the header line records the run conditions (`EVAL_NOTES`). Isolated ASR benchmarks are in `docs/DESIGN.md` §3.
- **Keyframes** have no reference; the table shows how much a video compresses and whether the hash or the cuts did the work (screencasts: hash; talking heads: cuts + floor).
