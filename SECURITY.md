# Security

## What ollos does with your data

- Media is processed **locally**. Nothing is uploaded. There is no telemetry.
- Network is used for two things only: downloading models from Hugging Face on first use (disable with `OLLOS_OFFLINE=1` after `ollos warmup --all`), and fetching a source URL **you** pass.
- Jobs, caches and models live in `$OLLOS_HOME` (default `~/.ollos`). `ollos gc` deletes old jobs, cache entries and search indexes.

## Threat model and mitigations

| Threat | Mitigation |
|---|---|
| **SSRF** via a source URL pointing at an internal service | URL fetching resolves every address of the host and refuses loopback, private, link-local, ULA, CGNAT, multicast, documentation ranges and the IPv6 transition forms that embed an IPv4 (v4-mapped, NAT64, 6to4, Teredo) — `src/core/source/ssrf.ts`. Redirects are followed manually and each hop is checked again (`maxRedirects` 5, http(s) only). Known gap: DNS rebinding between the guard's lookup and the fetch. Opt out with `OLLOS_ALLOW_PRIVATE=1`. |
| **Oversized downloads** | `content-length` and a streaming byte cap (`OLLOS_MAX_DOWNLOAD_MB`, default 2 GB); the duration limit (`OLLOS_MAX_DURATION_SEC`) applies to every origin; partial downloads are never adopted as cache. |
| **Prompt injection through media** | Transcripts and on-screen text are returned inside `<untrusted-content source="media">` and the bundled skill instructs agents to describe, never obey, instructions found in media. |
| **Secret leakage by the scanner itself** | Findings carry a masked value (`abcd…xyz`) and the length, and the OCR text returned next to them (`frames[].text`, `blocks[].text`, the `ocr` resource, the search index) is redacted with the same masks before it leaves the pipeline (`redactText`). The raw value exists only inside the scan. |
| **Stray output corrupting the MCP channel** | `src/mcp/bin.ts` intercepts `process.stdout.write`; only JSON-RPC lines pass, everything else is diverted to stderr. |
| **Arbitrary yt-dlp flags** | Only allow-listed download-tuning flags reach yt-dlp (`OLLOS_YTDLP_ARGS`); nothing that runs code or writes elsewhere. yt-dlp works in a private temp directory. |
| **Path traversal in resources** | Every job id from a resource URI or tool argument is validated against `^j_[0-9a-f]{12}$` before it touches a path; read paths never create directories. |

## What ollos does *not* protect against

- Media that is itself malicious to decoders. ffmpeg is run as a separate process with no shell; keep it updated (the bundled `ffmpeg-static` pins a version, a system ffmpeg is preferred when present).
- A compromised model file. Models come from the `onnx-community` and `Xenova` organisations on Hugging Face over HTTPS; checksums are not verified yet.
- Consent. Recording and transcribing other people is regulated where you live. ollos does not check that you were allowed to record.

## Reporting

Open a private security advisory: https://github.com/kelvinbiffi/ollos-mcp/security/advisories/new (Security → Advisories → Report a vulnerability). Please include a minimal reproduction. You will get an acknowledgement within a few days.
