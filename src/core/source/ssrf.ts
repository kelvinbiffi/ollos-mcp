import dns from 'node:dns/promises'
import net from 'node:net'

/**
 * Expand an IPv6 literal into its eight 16-bit groups. Handles `::` compression and a dotted-quad tail
 * (`::ffff:10.0.0.1`). Returns undefined for anything that is not a valid IPv6 address.
 * We parse instead of prefix-matching strings because `0:0:0:0:0:ffff:a00:1` and `::ffff:10.0.0.1` are the same
 * address and a string check on one spelling lets the other through.
 */
export function parseIPv6(ip: string): number[] | undefined {
  let s = ip.trim().replace(/^\[|\]$/g, '')
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)
  if (!net.isIPv6(s)) return undefined
  // dotted-quad tail → two hex groups
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number]
    s = s.slice(0, v4.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined
  const groups = [...head, ...new Array<string>(missing).fill('0'), ...tail].map((g) => parseInt(g, 16))
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g) || g < 0 || g > 0xffff)) return undefined
  return groups
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number, number, number]
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && b === 0) return true // 192.0.0.0/24 IETF protocol assignments, 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51) return true // TEST-NET-2 (198.51.100.0/24)
  if (a === 203 && b === 0) return true // TEST-NET-3 (203.0.113.0/24)
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`

/**
 * True for loopback, private, link-local, ULA, multicast, unspecified, documentation and CGNAT ranges.
 * IPv6 addresses that carry an IPv4 address inside them are unwrapped and the IPv4 is checked too:
 * v4-mapped (::ffff:0:0/96), NAT64 (64:ff9b::/96), 6to4 (2002::/16) and Teredo (2001::/32). Without that,
 * `http://[64:ff9b::7f00:1]/` reaches 127.0.0.1 through a NAT64 gateway with the guard none the wiser.
 */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip)
  const g = parseIPv6(ip)
  if (!g) return true // not an IP at all: refuse
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number]
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0)

  if (allZero(0, 7) && (g7 === 0 || g7 === 1)) return true // :: and ::1
  if (allZero(0, 5) && g5 === 0xffff) return isPrivateIPv4(v4Of(g6, g7)) // ::ffff:a.b.c.d v4-mapped
  if (allZero(0, 6)) return true // ::a.b.c.d IPv4-compatible (deprecated): never routable on the public internet
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (g0 === 0x100 && allZero(1, 4)) return true // 100::/64 discard-only
  if (g0 === 0x2001 && g1 === 0xdb8) return true // 2001:db8::/32 documentation
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 1) return true // 64:ff9b:1::/48 local-use NAT64
    if (allZero(2, 6)) return isPrivateIPv4(v4Of(g6, g7)) // 64:ff9b::/96 well-known NAT64 prefix
  }
  if (g0 === 0x2002) return isPrivateIPv4(v4Of(g1, g2)) // 6to4: the IPv4 relay/endpoint is the next 32 bits
  if (g0 === 0x2001 && g1 === 0) {
    // Teredo: server IPv4 in bits 32–63, client IPv4 obfuscated (bitwise NOT) in the last 32 bits
    return isPrivateIPv4(v4Of(g2, g3)) || isPrivateIPv4(v4Of(~g6 & 0xffff, ~g7 & 0xffff))
  }
  return false
}

/**
 * Resolve every address for a hostname and refuse if any is private.
 * Checking all records closes the trick of a public A record next to a private one.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const lower = hostname.toLowerCase().replace(/\.$/, '')
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal') || lower.endsWith('.home.arpa')) {
    throw new Error(`refusing to fetch from "${hostname}"`)
  }
  const literal = lower.replace(/^\[|\]$/g, '')
  if (net.isIP(literal)) {
    if (isPrivateAddress(literal)) throw new Error(`refusing to fetch from private address ${literal}`)
    return
  }
  const records = await dns.lookup(lower, { all: true })
  if (records.length === 0) throw new Error(`could not resolve ${hostname}`)
  for (const r of records) if (isPrivateAddress(r.address)) throw new Error(`"${hostname}" resolves to private address ${r.address}`)
}
