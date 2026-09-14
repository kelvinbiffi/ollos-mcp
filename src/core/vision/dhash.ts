/**
 * Difference hash on a 9×8 grayscale thumbnail: 64 bits, each "is this pixel brighter than its right neighbour".
 * Robust to cursor blink, small text changes and compression noise — exactly what pixel-diff dedup is not.
 * Measured on an 11-minute screencast: mpdecimate kept 100% of frames, dHash at Hamming ≥ 6 kept 20%.
 */
export type DHash = Uint8Array // 8 bytes

export const DHASH_W = 9
export const DHASH_H = 8

export function dhash(gray9x8: Uint8Array | Buffer): DHash {
  const out = new Uint8Array(8)
  for (let y = 0; y < DHASH_H; y++) {
    let byte = 0
    for (let x = 0; x < 8; x++) {
      const left = gray9x8[y * DHASH_W + x]!
      const right = gray9x8[y * DHASH_W + x + 1]!
      byte = (byte << 1) | (left > right ? 1 : 0)
    }
    out[y] = byte
  }
  return out
}

const POPCOUNT = new Uint8Array(256)
for (let i = 0; i < 256; i++) {
  let c = 0
  let v = i
  while (v) {
    c += v & 1
    v >>= 1
  }
  POPCOUNT[i] = c
}

export function hamming(a: DHash, b: DHash): number {
  let d = 0
  for (let i = 0; i < 8; i++) d += POPCOUNT[a[i]! ^ b[i]!]!
  return d
}

export function dhashToHex(h: DHash): string {
  return Buffer.from(h).toString('hex')
}

export type Sensitivity = 'low' | 'normal' | 'high'

/** Hamming thresholds per sensitivity, from the measured curve (10 → 14%, 6 → 20%, 3 → 33% kept). */
export const SENSITIVITY_THRESHOLD: Record<Sensitivity, number> = { low: 10, normal: 6, high: 3 }

export interface HashedFrame {
  index: number
  pts: number
  hash: DHash
}

/** Keep a frame when it differs from the last kept one by at least `threshold` bits. Returns kept frames with their distance. */
export function dedupByHash(frames: HashedFrame[], threshold: number): Array<HashedFrame & { distance: number }> {
  const kept: Array<HashedFrame & { distance: number }> = []
  let last: DHash | undefined
  for (const f of frames) {
    const d = last ? hamming(f.hash, last) : 64
    if (!last || d >= threshold) {
      kept.push({ ...f, distance: d })
      last = f.hash
    }
  }
  return kept
}
