/**
 * Glossary-guided correction. The caller knows the domain ("n8n", "Claude Code", "webhook");
 * the model hears Portuguese phonetics ("Cloud Code"). We only ever correct *toward* a term the caller supplied,
 * and only when the transcribed n-gram is close enough, so the pass cannot invent words.
 */

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array<number>(n + 1)
  let cur = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[n]!
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '')
}

export interface VocabularyStats {
  replacements: number
  terms: number
}

/** Apply `vocabulary` to `text`. Returns corrected text and how many replacements happened. */
export function applyVocabulary(text: string, vocabulary: string[] | undefined): { text: string; stats: VocabularyStats } {
  if (!vocabulary || vocabulary.length === 0) return { text, stats: { replacements: 0, terms: 0 } }
  const terms = vocabulary.map((t) => t.trim()).filter(Boolean)
  const tokens = text.split(/(\s+)/) // keep whitespace tokens so we can rebuild
  let replacements = 0

  for (const term of terms) {
    const termWords = term.split(/\s+/).length
    const termNorm = norm(term)
    if (termNorm.length < 3) continue
    // slide over word positions (odd indices are whitespace)
    for (let i = 0; i < tokens.length; i += 2) {
      const slice: string[] = []
      let j = i
      while (slice.length < termWords && j < tokens.length) {
        slice.push(tokens[j]!)
        j += 2
      }
      if (slice.length < termWords) break
      const candidate = slice.join(' ')
      const candNorm = norm(candidate)
      if (!candNorm || candNorm === termNorm) continue
      const dist = levenshtein(candNorm, termNorm)
      const ratio = dist / Math.max(candNorm.length, termNorm.length)
      // 1 edit for short terms, up to 34% for longer ones — tight enough not to rewrite ordinary words
      const allowed = termNorm.length <= 5 ? 1 : Math.floor(termNorm.length * 0.34)
      if (dist <= allowed && ratio <= 0.34) {
        const trailing = slice[slice.length - 1]!.match(/[.,;:!?]+$/)?.[0] ?? ''
        tokens.splice(i, (termWords - 1) * 2 + 1, term + trailing)
        replacements++
      }
    }
  }
  return { text: tokens.join(''), stats: { replacements, terms: terms.length } }
}
