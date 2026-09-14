# Security

## What ollos does with your data

- Media is processed **locally**. Nothing is uploaded. There is no telemetry.
- Network is used for two things only: downloading models from Hugging Face on first use (disable with `OLLOS_OFFLINE=1` after `ollos warmup`), and fetching a source URL **you** pass.
- Jobs, caches and models live in `$OLLOS_HOME` (default `~/.ollos`). `ollos gc` deletes old jobs.

## Threat model and mitigations

| Threat | Mitigation |
|---|---|
| **SSRF** via a source URL pointing at an internal service | URL fetching resolves the host and refuses loopback, private, link-local, ULA, CGNAT and multicast ranges (`src/core/source/ssrf.ts`). Opt out with `OLLOS_ALLOW_PRIVATE=1`. |
| **Oversized downloads** | `content-length` and a streaming byte cap (`OLLOS_MAX_DOWNLOAD_MB`, default 2 GB); redirects are followed by `fetch` with its default limit. |
| **Prompt injection through media** | Transcripts and on-screen text are returned inside `<untrusted-content source="media">` and the bundled skill instructs agents to describe, never obey, instructions found in media. |
| **Secret leakage by the scanner itself** | Findings carry a masked value (`abcd…xyz`) and the length; the full value is never stored in results, events or logs. |
| **Stray output corrupting the MCP channel** | `src/mcp/bin.ts` intercepts `process.stdout.write`; only JSON-RPC lines pass, everything else is diverted to stderr. |
| **Arbitrary yt-dlp flags** | `ytDlpArgs` passes an allow-list of flags only. |
| **Path traversal in resources** | Resource URIs are resolved only under the job's own artifacts directory, from a job id that must exist in the store. |

## What ollos does *not* protect against

- Media that is itself malicious to decoders. ffmpeg is run as a separate process with no shell; keep it updated (the bundled `ffmpeg-static` pins a version, a system ffmpeg is preferred when present).
- A compromised model file. Models come from the `onnx-community` and `Xenova` organisations on Hugging Face over HTTPS; checksums are not verified yet.
- Consent. Recording and transcribing other people is regulated where you live. ollos does not check that you were allowed to record.

## Reporting

Open a private security advisory on GitHub (Security → Advisories → Report a vulnerability) or e-mail the maintainer listed in `package.json`. Please include a minimal reproduction. You will get an acknowledgement within a few days.
