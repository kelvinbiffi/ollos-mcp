# Sources: local files, URLs, video sites, Zoom folders

Every ollos tool takes one `source`. These forms are accepted, and each one below was run as written.

| Form | Example | Notes |
|---|---|---|
| Local file | `C:\videos\talk.mp4`, `/home/me/talk.mp4` | The common case. The real type comes from `ffprobe`, never from the extension. |
| `file://` URL | `file:///C:/videos/talk.mp4` | Decoded with Node's `fileURLToPath` (Windows drive letters included). |
| Zoom local-recording folder | `C:\Users\me\Documents\Zoom\2026-09-14 10.00.00 Weekly` | Needs the `Audio Record/` subfolder Zoom writes with "Record a separate audio file for each participant". `ollos_diarize` then uses one track per person, named. |
| Direct media URL | `https://cdn.example.com/talk.mp4` | Downloaded once into `~/.ollos/cache/download/<sha1>/`, capped by `OLLOS_MAX_DOWNLOAD_MB` (2048). |
| Video-site URL | `https://www.youtube.com/watch?v=eur8dUO9mvE` | YouTube, Instagram, TikTok, Vimeo, X, Facebook, Twitch, Loom, Grain through `yt-dlp`. Best effort: platforms change often. |
| `data:` URI | `data:audio/wav;base64,UklGR…` | Written to the cache and probed like a file. |

## Video-site URLs need yt-dlp

ollos does not bundle it. Put `yt-dlp` on your `PATH` or point `OLLOS_YTDLP` at the binary:

```bash
# Windows (PowerShell): standalone exe, no Python needed
$env:OLLOS_YTDLP = "$HOME\.ollos\bin\yt-dlp.exe"

# macOS / Linux
brew install yt-dlp      # or: pipx install yt-dlp
```

Behind a corporate proxy that re-signs TLS, yt-dlp fails with `CERTIFICATE_VERIFY_FAILED`. Pass allow-listed flags
through `OLLOS_YTDLP_ARGS`:

```bash
OLLOS_YTDLP_ARGS="--no-check-certificates"            # TLS-intercepting proxy
OLLOS_YTDLP_ARGS="--js-runtimes node"                  # full YouTube format list (needs a recent Node on PATH)
OLLOS_YTDLP_ARGS="--cookies-from-browser chrome"       # login-gated content
```

Only download-tuning flags pass (`--format`, `--proxy`, `--extractor-args`, `--user-agent`, `--referer`,
`--sleep-requests`, `--limit-rate`, `--js-runtimes`, `--remote-components`, `--cookies-from-browser`,
`--no-check-certificates`, `--force-ipv4/6`, `--legacy-server-connect`). Anything that runs code or writes elsewhere
is dropped.

## What is refused

- URLs that resolve to loopback, private, link-local, CGNAT, ULA, multicast, documentation ranges or their IPv6
  transition forms (NAT64, 6to4, Teredo, v4-mapped), on the first request and on every redirect hop. Error
  `PRIVATE_ADDRESS_BLOCKED`; opt out with `OLLOS_ALLOW_PRIVATE=1`.
- Downloads larger than `OLLOS_MAX_DOWNLOAD_MB` (`DOWNLOAD_TOO_LARGE`), checked on `content-length` and again mid-stream.
- Media longer than `OLLOS_MAX_DURATION_SEC` (default 4 h) from any origin (`DURATION_EXCEEDED`). Use `from`/`to`.
- Non-http(s) redirect targets, more than `maxRedirects` (5) hops.

## CLI, as run on 2026-09-15

```bash
$ OLLOS_YTDLP=~/.ollos/bin/yt-dlp.exe OLLOS_YTDLP_ARGS="--no-check-certificates" \
  ollos probe "https://www.youtube.com/watch?v=eur8dUO9mvE"
video · 3:45.8 · mov,mp4,m4a,3gp,3g2,mj2
video 1920×1080 vp9 29.97fps · aspect 16:9 (fits in 16:9)
audio opus 2ch 48000Hz · 1 track(s)

$ ollos transcribe "https://www.youtube.com/watch?v=eur8dUO9mvE" --lang en --model fast --from 0 --to 30
Transcript of watch?v=eur8dUO9mvE — 3:45.8, language en, model whisper-base
8 segments · 86 words · speech 0:27.8 (silero VAD) · 0 hallucinated segment(s) removed
Full text: ollos://jobs/j_55f58c8126af/transcript · SRT: ollos://jobs/j_55f58c8126af/transcript.srt
<untrusted-content source="media">
[0:00.2] If you're building AI agents, you've probably heard about MCP, or Model Context Vertical.
[0:05.0] MCP is a new, open-source standard to connect your agents to data sources such as databases or APIs.
…
</untrusted-content>
```

The second call for the same URL does not download again: the file is cached by URL, and the transcript by
content hash and parameters.

## MCP, as run through the stdio server

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "ollos_probe", "arguments": { "source": "https://www.youtube.com/watch?v=eur8dUO9mvE" } } }
```

```json
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "ollos_transcribe",
              "arguments": { "source": "https://www.youtube.com/watch?v=eur8dUO9mvE", "language": "en", "model": "fast", "from": 0, "to": 30 } } }
```

`from` and `to` accept seconds as a number (`30`) or a string (`"0:30"`, `"1:30"`, `"0:01:30.5"`). The download
happens inside the job, under its cancellation signal: `ollos_cancel` stops a yt-dlp download mid-way.

Set the environment for the server in the client config (Claude Code shown; the shape is the same elsewhere):

```json
{
  "mcpServers": {
    "ollos": {
      "command": "npx",
      "args": ["-y", "ollos-mcp"],
      "env": { "OLLOS_YTDLP": "C:\\Users\\me\\.ollos\\bin\\yt-dlp.exe", "OLLOS_YTDLP_ARGS": "--no-check-certificates" }
    }
  }
}
```

## Library

See [`library-url.ts`](library-url.ts).
