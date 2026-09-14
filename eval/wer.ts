/**
 * Word and character error rates against a reference transcript.
 * Both sides are normalised the same way (lowercase, no punctuation, no accents, collapsed whitespace),
 * so the number measures recognition, not formatting. WER = (S + D + I) / N over words.
 */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // [Música], (risos)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function editDistance<T>(a: T[], b: T[]): { distance: number; subs: number; dels: number; ins: number } {
  const m = a.length
  const n = b.length
  // dp with backtracking counts
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) d[i]![0] = i
  for (let j = 0; j <= n; j++) d[0]![j] = j
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
    }
  // backtrack
  let i = m
  let j = n
  let subs = 0
  let dels = 0
  let ins = 0
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      if (a[i - 1] !== b[j - 1]) subs++
      i--
      j--
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      dels++
      i--
    } else {
      ins++
      j--
    }
  }
  return { distance: d[m]![n]!, subs, dels, ins }
}

export interface ErrorRates {
  wer: number
  cer: number
  referenceWords: number
  hypothesisWords: number
  substitutions: number
  deletions: number
  insertions: number
}

/** reference = ground truth, hypothesis = what ollos produced. */
export function errorRates(reference: string, hypothesis: string): ErrorRates {
  const ref = normalizeText(reference)
  const hyp = normalizeText(hypothesis)
  const rw = ref.split(' ').filter(Boolean)
  const hw = hyp.split(' ').filter(Boolean)
  const w = editDistance(rw, hw)
  const c = editDistance([...ref.replace(/ /g, '')], [...hyp.replace(/ /g, '')])
  return {
    wer: rw.length ? Number((w.distance / rw.length).toFixed(4)) : 0,
    cer: ref.length ? Number((c.distance / ref.replace(/ /g, '').length).toFixed(4)) : 0,
    referenceWords: rw.length,
    hypothesisWords: hw.length,
    substitutions: w.subs,
    deletions: w.dels,
    insertions: w.ins,
  }
}
