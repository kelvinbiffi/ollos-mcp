# Evaluation results

Generated 2026-09-14 07:42 UTC by `npx tsx eval/run.ts` on win32 x64, Node v20.11.0. Reference transcripts are YouTube captions (see eval/README.md), so WER includes caption errors as well as ollos errors.

> **Run conditions:** Intel i9-12900HX laptop (16 cores / 24 threads), high-performance power plan, while an unrelated browser was using roughly a third of the CPU. Isolated benchmarks of the same ASR model run at 1.7× real time; treat the speed column as a loaded-machine figure.

## Transcription

| fixture | kind | lang | duration | WER | CER | ref words | S / D / I | filtered | speed |
|---|---|---|---|---|---|---|---|---|---|
| bolder-dev-interview | interview | pt | 328 s | 26.3% | 17.0% | 929 | 83 / 37 / 124 | 1 | 0.18× RT |
| karinelago-n8n-assistant | screencast | pt | 635 s | 8.9% | 6.1% | 2025 | 63 / 26 / 91 | 0 | 0.35× RT |
| ibm-what-is-mcp | talk | en | 226 s | 1.4% | 0.5% | 579 | 8 / 0 / 0 | 0 | 0.29× RT |

## Speakers

| fixture | expected | found | method | time |
|---|---|---|---|---|
| bolder-dev-interview | 2 | 3 ❌ | embeddings | 116.3 s |
| karinelago-n8n-assistant | 1 | 1 ✅ | embeddings | 63.5 s |
| ibm-what-is-mcp | 1 | 2 ❌ | embeddings | 0.2 s |

## Keyframes

| fixture | sampled @1 fps | kept by hash | hard cuts | final frames | sheets | time |
|---|---|---|---|---|---|---|
| bolder-dev-interview | 327 | 51 | 6 | 54 | 6 | 239.2 s |
| karinelago-n8n-assistant | 635 | 321 | 31 | 120 | 14 | 126.2 s |
| ibm-what-is-mcp | 226 | 49 | 1 | 51 | 6 | 50.2 s |

## Fixtures

- **bolder-dev-interview** — [Entrevista para programador (dev) na Europa — Cortes do Bolder Podcast](https://www.youtube.com/watch?v=qCN7at36cS4) · interview, pt, 328 s, 2 speaker(s) · Host + guest, Brazilian Portuguese, two clear voices, background music jingles. Reference = YouTube auto-captions (pt), so WER is an agreement rate between two recognisers.
- **karinelago-n8n-assistant** — [O novo assistente do n8n monta automações em segundos — Karine Lago](https://www.youtube.com/watch?v=t-S5G_h_BK4) · screencast, pt, 635 s, 1 speaker(s) · Single presenter over a screen recording with chapters; UI vocabulary dominates. Reference = YouTube auto-captions (pt).
- **ibm-what-is-mcp** — [What is MCP? Integrate AI Agents with Databases & APIs — IBM Technology](https://www.youtube.com/watch?v=eur8dUO9mvE) · talk, en, 226 s, 1 speaker(s) · Single speaker, lightboard talk, professional English captions (CC) — the closest thing to a human reference in this set.
