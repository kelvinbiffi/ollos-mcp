/**
 * Three independent signals, because OCR garbles the secret itself more often than the words around it.
 * Measured on a real "API Key Created" modal: the JWT regex missed (OCR read `eyJ` as `eyl`), the entropy detector
 * caught the 136-char token, and the UI context ("API Key", "copy") read at 66% confidence.
 * Findings are always masked. The tool that warns about a leak must not be the leak.
 *
 * Confidence policy (drives review verdicts):
 *   high   — a strong pattern (prefix no ordinary word has): keys, tokens, JWT, private key block
 *   medium — weak pattern with UI context, or high-entropy token with UI context
 *   low    — weak pattern alone, entropy alone, and PII (e-mail, CPF) — informative, never blocking
 */
export const SCANNER_VERSION = 4

export type SecretKind = 'openai_key' | 'anthropic_key' | 'github_token' | 'aws_access_key' | 'google_api_key' | 'slack_token' | 'stripe_key' | 'jwt' | 'bearer_token' | 'private_key_block' | 'env_assignment' | 'private_url' | 'local_url' | 'email' | 'cpf' | 'high_entropy_token'

export type Signal = 'pattern' | 'entropy' | 'context'

export interface Finding {
  kind: SecretKind
  confidence: 'high' | 'medium' | 'low'
  signals: Signal[]
  masked: string
  length: number
  /** Nearby words that made the context signal fire, e.g. "API Key Created". */
  context?: string
  pts?: number
  frameIndex?: number
  tile?: number
}

interface Rule {
  kind: SecretKind
  re: RegExp
  /** Unambiguous on its own (a prefix no ordinary word has). */
  strong: boolean
  /** Personal data, not a credential: always low. */
  pii?: boolean
  /** Specific enough to warrant medium on its own (deployment hosts, local URLs). */
  medium?: boolean
  /** Also try on the whitespace-stripped view (OCR splits URLs and tokens). */
  compact?: boolean
}

// OCR confusions we tolerate in the JWT header: eyJ → eyl / ey1 / eyI
const JWT = /\bey[JlI1][A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g

const RULES: Rule[] = [
  { kind: 'openai_key', re: /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}/g, strong: true, compact: true },
  { kind: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, strong: true, compact: true },
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, strong: true, compact: true },
  { kind: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, strong: true },
  { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{30,}/g, strong: true, compact: true },
  { kind: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, strong: true, compact: true },
  { kind: 'stripe_key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, strong: true, compact: true },
  { kind: 'jwt', re: JWT, strong: true, compact: true },
  { kind: 'private_key_block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, strong: true },
  { kind: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, strong: false },
  { kind: 'env_assignment', re: /\b[A-Z][A-Z0-9_]{2,}(?:KEY|SECRET|TOKEN|PASSWORD|PASS|SENHA|CREDENTIAL|API)[A-Z0-9_]*\s*=\s*["']?\S{8,}/g, strong: false },
  { kind: 'private_url', re: /\bhttps?:\/\/[a-z0-9.-]+\.(?:railway\.app|up\.railway\.app|vercel\.app|onrender\.com|fly\.dev|herokuapp\.com|ngrok(?:-free)?\.(?:app|io|dev)|supabase\.co|amazonaws\.com|azurewebsites\.net|run\.app|workers\.dev|pages\.dev)(?:[/?#][^\s"'<>]*)?/gi, strong: false, medium: true, compact: true },
  { kind: 'local_url', re: /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d{2,5})?(?:[/?#][^\s"'<>]*)?/gi, strong: false, medium: true, compact: true },
  { kind: 'email', re: /\b[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi, strong: false, pii: true },
  { kind: 'cpf', re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, strong: false, pii: true },
]

const CONTEXT = /\b(api ?key|apikey|api key created|secret|token|password|senha|passphrase|bearer|credential|credentials|chave|make sure to copy|copy (?:your|this)|won'?t be able to see|\.env|private key|access key|client secret|webhook secret)\b/i

const ENTROPY_MIN_LEN = 32
const ENTROPY_MIN_BITS = 3.7

function shannon(s: string): number {
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

/** Secrets interleave classes; prose does not. Count transitions letter↔digit and lower↔upper. */
function classTransitions(s: string): number {
  let t = 0
  const cls = (c: string) => (/\d/.test(c) ? 'd' : /[A-Z]/.test(c) ? 'U' : /[a-z]/.test(c) ? 'l' : 'o')
  for (let i = 1; i < s.length; i++) if (cls(s[i]!) !== cls(s[i - 1]!)) t++
  return t
}

/** Looks like a word-ish run OCR glued together ("Ifyouneedaccess") rather than a key. */
function looksLikeProse(tok: string): boolean {
  const letters = tok.replace(/[^A-Za-z]/g, '')
  if (letters.length / tok.length > 0.85 && classTransitions(tok) < tok.length * 0.15) return true
  const vowels = (letters.match(/[aeiouAEIOU]/g) ?? []).length
  return letters.length > 12 && vowels / letters.length > 0.3 && vowels / letters.length < 0.55 && classTransitions(tok) < tok.length * 0.2
}

export function mask(value: string): string {
  const v = value.trim()
  if (v.length <= 8) return v.slice(0, 2) + '…'
  return `${v.slice(0, 4)}…${v.slice(-3)}`
}

function contextAround(text: string, index: number, span = 90): string | undefined {
  const around = text.slice(Math.max(0, index - span), index + span)
  const m = around.match(CONTEXT)
  return m ? m[0] : undefined
}

function confidenceFor(rule: Rule, ctx: string | undefined): Finding['confidence'] {
  if (rule.pii) return 'low'
  if (rule.strong) return 'high'
  if (rule.medium) return 'medium'
  return ctx ? 'medium' : 'low'
}

/**
 * Scan one text (a frame's OCR, a transcript line). Returns masked findings, deduplicated by masked value.
 * Pattern rules marked `compact` also run on a whitespace-stripped view, because OCR splits tokens ("up. railway .app").
 * The entropy pass runs on the original text only: gluing prose together manufactures fake high-entropy tokens.
 */
export function scanText(text: string, meta: Pick<Finding, 'pts' | 'frameIndex' | 'tile'> = {}): Finding[] {
  const out = new Map<string, Finding>()
  const compact = text.replace(/\s+/g, '')
  const anyContext = contextAround(text, 0, text.length)

  for (const rule of RULES) {
    for (const [view, isCompact] of [[text, false], [compact, true]] as Array<[string, boolean]>) {
      if (isCompact && !rule.compact) continue
      rule.re.lastIndex = 0
      for (const m of view.matchAll(rule.re)) {
        const value = m[0]
        const ctx = isCompact ? anyContext : contextAround(text, m.index ?? 0)
        const signals: Signal[] = ['pattern']
        if (ctx) signals.push('context')
        const key = rule.kind + ':' + mask(value) + ':' + value.length
        if (!out.has(key)) out.set(key, { kind: rule.kind, confidence: confidenceFor(rule, ctx), signals, masked: mask(value), length: value.length, context: ctx, ...meta })
      }
    }
  }

  // entropy pass: contiguous opaque tokens in the ORIGINAL text
  for (const m of text.matchAll(/[A-Za-z0-9_\-./+=]{32,}/g)) {
    const tok = m[0].replace(/^[./=+-]+|[./=+-]+$/g, '')
    if (tok.length < ENTROPY_MIN_LEN) continue
    if (/^https?:\/\//i.test(tok) || /^[a-z]+(\.[a-z]+)+$/i.test(tok) || tok.includes('...') || tok.includes('..')) continue
    if (!/\d/.test(tok) || !/[A-Za-z]/.test(tok)) continue
    if ((tok.match(/\d/g) ?? []).length < 2) continue
    if (looksLikeProse(tok)) continue
    if (shannon(tok) < ENTROPY_MIN_BITS) continue
    if (classTransitions(tok) < tok.length * 0.25) continue
    const ctx = contextAround(text, m.index ?? 0)
    const signals: Signal[] = ['entropy']
    if (ctx) signals.push('context')
    const already = [...out.values()].some((f) => f.length === tok.length && f.masked === mask(tok))
    const key = 'high_entropy_token:' + mask(tok) + ':' + tok.length
    if (!already && !out.has(key)) out.set(key, { kind: 'high_entropy_token', confidence: ctx ? 'medium' : 'low', signals, masked: mask(tok), length: tok.length, context: ctx, ...meta })
  }
  return [...out.values()].sort((a, b) => rank(b) - rank(a))
}

function rank(f: Finding): number {
  return (f.confidence === 'high' ? 3 : f.confidence === 'medium' ? 2 : 1) * 10 + f.signals.length
}

/** Highest confidence present. */
export function worst(findings: Finding[]): Finding['confidence'] | 'none' {
  if (findings.some((f) => f.confidence === 'high')) return 'high'
  if (findings.some((f) => f.confidence === 'medium')) return 'medium'
  if (findings.length) return 'low'
  return 'none'
}
