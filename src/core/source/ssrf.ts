import dns from 'node:dns/promises'
import net from 'node:net'

/** True for loopback, private, link-local, ULA, multicast, unspecified and CGNAT ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number]
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true
    return false
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase()
    if (v === '::' || v === '::1') return true
    if (v.startsWith('fc') || v.startsWith('fd')) return true // ULA
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true // link-local
    if (v.startsWith('ff')) return true // multicast
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7)) // v4-mapped
    return false
  }
  return true // not an IP at all: refuse
}

/**
 * Resolve every address for a hostname and refuse if any is private.
 * Checking all records closes the trick of a public A record next to a private one.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error(`refusing to fetch from "${hostname}"`)
  }
  const literal = hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(literal)) {
    if (isPrivateAddress(literal)) throw new Error(`refusing to fetch from private address ${literal}`)
    return
  }
  const records = await dns.lookup(hostname, { all: true })
  if (records.length === 0) throw new Error(`could not resolve ${hostname}`)
  for (const r of records) if (isPrivateAddress(r.address)) throw new Error(`"${hostname}" resolves to private address ${r.address}`)
}
