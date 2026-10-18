// ================================================================
// FILE: src/tools/web/ssrfGuard.js
// PURPOSE: Server-Side Request Forgery (SSRF) protection for the web tools.
//
// The crawler fetches *attacker-influenced* URLs (the model picks them, and
// they can come from search results / page links). Without a guard, a
// crafted URL could make QTPi reach internal services:
//
//     http://127.0.0.1:9200/            (Elasticsearch)
//     http://169.254.169.254/latest/    (cloud metadata)
//     http://10.0.0.5/admin             (intranet)
//
// This module blocks those before any network I/O:
//   - only http: / https: schemes are allowed
//   - loopback / private / link-local / CGNAT / multicast / reserved
//     IPv4 and IPv6 literals are rejected
//   - single-label hostnames (e.g. "intranet") and reserved TLDs
//     (.local, .internal, .home.arpa, localhost) are rejected
//   - hostnames are resolved and EVERY resolved address is checked,
//     so a public name that maps to a private IP is still blocked
//
// It is best-effort: `fetch()` performs its own DNS lookup after ours,
// which leaves a small TOCTOU (DNS-rebinding) window. Fully closing it
// would require a custom undici dispatcher; this guard stops the
// overwhelming majority of attacks (literal IPs + obvious names).
// ================================================================

import dns from 'dns';
import net from 'net';

// ─────────────────────────────────────────────────────────────
// Reserved / internal IPv4 ranges as [baseAddress, prefixLength].
// ─────────────────────────────────────────────────────────────
const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8],          // "this network"
  ['10.0.0.0', 8],         // private
  ['100.64.0.0', 10],      // carrier-grade NAT
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local (incl. 169.254.169.254 metadata)
  ['172.16.0.0', 12],      // private
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.0.2.0', 24],       // TEST-NET-1
  ['192.88.99.0', 24],     // 6to4 relay anycast
  ['192.168.0.0', 16],     // private
  ['198.18.0.0', 15],      // benchmarking
  ['198.51.100.0', 24],    // TEST-NET-2
  ['203.0.113.0', 24],     // TEST-NET-3
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reserved (incl. 255.255.255.255)
];

// Reserved / internal IPv6 ranges as [baseBigInt, prefixLength].
const IPV6_LOCALHOST = parseIPv6('::1');
const IPV6_UNSPECIFIED = parseIPv6('::');
const IPV6_V4MAPPED_PREFIX = 0xffffn;            // high 96 bits of ::ffff:0:0/96
const IPV6_NAT64_PREFIX = 0x0064ff9b0000000000000000n; // 64:ff9b::/96

const BLOCKED_IPV6_RANGES = [
  [parseIPv6('fc00::'), 7],   // unique local addresses
  [parseIPv6('fe80::'), 10],  // link-local
  [parseIPv6('ff00::'), 8],   // multicast
];

// Hostnames that must never be fetched, as exact matches or suffixes.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
]);

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.lan',
  '.intranet',
];

// How long a DNS answer is trusted before we look it up again (ms).
const DNS_CACHE_TTL_MS = 30 * 1000;
const dnsCache = new Map(); // hostname -> { addresses, expiresAt }


// ─────────────────────────────────────────────────────────────
// Outcome codes returned by the checks below.
// ─────────────────────────────────────────────────────────────
export const SSRF_CODES = {
  OK: 'OK',
  BAD_SCHEME: 'BAD_SCHEME',
  BLOCKED_HOST: 'BLOCKED_HOST',
  PRIVATE_IP: 'PRIVATE_IP',
  DNS_FAILED: 'DNS_FAILED',
};


// ─────────────────────────────────────────────────────────────
// ipv4ToBigInt(ip)
// "10.0.0.1" -> 0x0A000001n. Returns null for malformed input.
// ─────────────────────────────────────────────────────────────
export function ipv4ToBigInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;

  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}


// ─────────────────────────────────────────────────────────────
// parseIPv6(ip)
// Expands any valid IPv6 literal (including "::" compression and an
// embedded IPv4 tail) into a 128-bit BigInt. Returns null if invalid.
// ─────────────────────────────────────────────────────────────
export function parseIPv6(input) {
  if (!input) return null;

  let str = String(input).trim().toLowerCase();

  // Drop a zone id ("%eth0") — not part of the address.
  const pct = str.indexOf('%');
  if (pct !== -1) str = str.slice(0, pct);

  // Pull out an embedded IPv4 tail (e.g. ::ffff:1.2.3.4) and mask it
  // as two zero groups; we patch the low 32 bits back in at the end.
  let v4 = null;
  if (str.includes('.')) {
    const lastColon = str.lastIndexOf(':');
    if (lastColon === -1) return null;
    v4 = str.slice(lastColon + 1);
    str = `${str.slice(0, lastColon + 1)}0:0`;
  }

  const doubleIdx = str.indexOf('::');
  let headStr;
  let tailStr;
  if (doubleIdx !== -1) {
    // Only one "::" compression is legal.
    if (str.indexOf('::', doubleIdx + 2) !== -1) return null;
    headStr = str.slice(0, doubleIdx);
    tailStr = str.slice(doubleIdx + 2);
  } else {
    headStr = str;
    tailStr = '';
  }

  const isHexGroup = (g) => /^[0-9a-f]{1,4}$/.test(g);
  const headGroups = headStr === '' ? [] : headStr.split(':');
  const tailGroups = tailStr === '' ? [] : tailStr.split(':');

  for (const g of headGroups) if (!isHexGroup(g)) return null;
  for (const g of tailGroups) if (!isHexGroup(g)) return null;

  const total = headGroups.length + tailGroups.length;
  if (doubleIdx === -1) {
    if (total !== 8) return null;
  } else if (total > 7) {
    return null;
  }

  const zeros = doubleIdx === -1 ? 0 : 8 - total;
  const groups = [...headGroups, ...Array(zeros).fill('0'), ...tailGroups];
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const g of groups) {
    value = (value << 16n) | BigInt(parseInt(g || '0', 16));
  }

  // Patch the embedded IPv4 into the low 32 bits.
  if (v4 !== null) {
    const v4Value = ipv4ToBigInt(v4);
    if (v4Value === null) return null;
    value = (value & ~0xffffffffn) | v4Value;
  }

  return value;
}


// ─────────────────────────────────────────────────────────────
// isPrivateIPv4(ip) / isPrivateIPv6(ip)
// True when the address falls in any reserved / internal range.
// ─────────────────────────────────────────────────────────────
function isInV4Range(value, base, prefix) {
  const baseValue = ipv4ToBigInt(base);
  if (baseValue === null) return false;
  const shift = BigInt(32 - prefix);
  return (value >> shift) === (baseValue >> shift);
}

export function isPrivateIPv4(ip) {
  const value = ipv4ToBigInt(ip);
  if (value === null) return false;
  return BLOCKED_IPV4_RANGES.some(([base, prefix]) => isInV4Range(value, base, prefix));
}

export function isPrivateIPv6(ip) {
  const value = parseIPv6(ip);
  if (value === null) return false;

  // ::1 (loopback) and :: (unspecified)
  if (value === IPV6_LOCALHOST || value === IPV6_UNSPECIFIED) return true;

  // IPv4-mapped (::ffff:1.2.3.4) → judge by the embedded IPv4.
  if ((value >> 32n) === IPV6_V4MAPPED_PREFIX) {
    const embedded = value & 0xffffffffn;
    const dotted = [
      Number((embedded >> 24n) & 0xffn),
      Number((embedded >> 16n) & 0xffn),
      Number((embedded >> 8n) & 0xffn),
      Number(embedded & 0xffn),
    ].join('.');
    return isPrivateIPv4(dotted);
  }

  // NAT64 (64:ff9b::/96) → judge by the embedded IPv4.
  if ((value >> 32n) === IPV6_NAT64_PREFIX) {
    const embedded = value & 0xffffffffn;
    const dotted = [
      Number((embedded >> 24n) & 0xffn),
      Number((embedded >> 16n) & 0xffn),
      Number((embedded >> 8n) & 0xffn),
      Number(embedded & 0xffn),
    ].join('.');
    return isPrivateIPv4(dotted);
  }

  return BLOCKED_IPV6_RANGES.some(([base, prefix]) => {
    const shift = BigInt(128 - prefix);
    return (value >> shift) === (base >> shift);
  });
}


// ─────────────────────────────────────────────────────────────
// isPrivateIp(ip)
// Dispatches to the right family. Returns false for non-IP input.
// ─────────────────────────────────────────────────────────────
export function isPrivateIp(ip) {
  const kind = net.isIP(String(ip));
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return false;
}


// ─────────────────────────────────────────────────────────────
// normalizeHostname(hostname)
// URL.hostname keeps the brackets on IPv6 literals ("[::1]") — strip
// them and lowercase so our checks see the bare address.
// ─────────────────────────────────────────────────────────────
function normalizeHostname(hostname) {
  let host = String(hostname || '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // Trailing dot is a valid FQDN form ("example.com.") — drop it.
  if (host.endsWith('.') && host.length > 1) host = host.slice(0, -1);
  return host;
}


// ─────────────────────────────────────────────────────────────
// checkHostname(host)
// Rejects reserved names and private IP literals.
// Returns { ok: true } or { ok: false, code, reason }.
// ─────────────────────────────────────────────────────────────
export function checkHostname(host) {
  const name = normalizeHostname(host);

  if (!name) {
    return { ok: false, code: SSRF_CODES.BLOCKED_HOST, reason: 'empty hostname' };
  }

  // IP literal?
  const ipKind = net.isIP(name);
  if (ipKind !== 0) {
    if (isPrivateIp(name)) {
      return { ok: false, code: SSRF_CODES.PRIVATE_IP, reason: `private/internal IP address (${name})` };
    }
    return { ok: true };
  }

  if (BLOCKED_HOSTNAMES.has(name)) {
    return { ok: false, code: SSRF_CODES.BLOCKED_HOST, reason: `reserved hostname "${name}"` };
  }

  if (BLOCKED_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return { ok: false, code: SSRF_CODES.BLOCKED_HOST, reason: `reserved hostname suffix (${name})` };
  }

  // Single-label hostnames resolve via local search domains → block.
  if (!name.includes('.')) {
    return { ok: false, code: SSRF_CODES.BLOCKED_HOST, reason: `single-label hostname "${name}"` };
  }

  return { ok: true };
}


// ─────────────────────────────────────────────────────────────
// checkUrlSync(url)
// Synchronous guard: scheme + hostname/IP literal. No DNS.
// Returns { ok, code, reason, url }.
// ─────────────────────────────────────────────────────────────
export function checkUrlSync(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, code: SSRF_CODES.BAD_SCHEME, reason: 'invalid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: SSRF_CODES.BAD_SCHEME,
      reason: `scheme "${parsed.protocol}" is not allowed (only http/https)`,
    };
  }

  const host = checkHostname(parsed.hostname);
  if (!host.ok) return { ...host, url: parsed.toString() };

  return { ok: true, code: SSRF_CODES.OK, url: parsed.toString() };
}


// ─────────────────────────────────────────────────────────────
// defaultLookup(hostname)
// Resolves all A/AAAA records. Injectable so tests can run offline.
// ─────────────────────────────────────────────────────────────
async function defaultLookup(hostname) {
  return dns.promises.lookup(hostname, { all: true });
}


// ─────────────────────────────────────────────────────────────
// resolveHost(hostname, { lookup, ttl })
// Cached DNS resolution. Returns an array of address strings.
// ─────────────────────────────────────────────────────────────
async function resolveHost(hostname, { lookup = defaultLookup, ttl = DNS_CACHE_TTL_MS } = {}) {
  const key = normalizeHostname(hostname);
  const cached = dnsCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.addresses;

  const records = await lookup(key);
  const addresses = (Array.isArray(records) ? records : [records])
    .map((r) => (typeof r === 'string' ? r : r && r.address))
    .filter(Boolean);

  dnsCache.set(key, { addresses, expiresAt: Date.now() + ttl });
  return addresses;
}


// ─────────────────────────────────────────────────────────────
// assertUrlSafe(url, { allowPrivate, lookup, resolve })
// Full async guard: sync checks + DNS resolution of public names.
//
// Returns { ok: true, url } or { ok: false, code, reason }.
// When `allowPrivate` is true the guard is a pass-through (used for
// local testing / explicitly-trusted environments).
// ─────────────────────────────────────────────────────────────
export async function assertUrlSafe(url, { allowPrivate = false, lookup, resolve = true } = {}) {
  if (allowPrivate) {
    return { ok: true, code: SSRF_CODES.OK, url: String(url) };
  }

  const sync = checkUrlSync(url);
  if (!sync.ok) return sync;

  const host = normalizeHostname(new URL(sync.url).hostname);

  // Literal IP already validated synchronously; nothing to resolve.
  if (net.isIP(host) !== 0) {
    return { ok: true, code: SSRF_CODES.OK, url: sync.url };
  }

  if (!resolve) {
    return { ok: true, code: SSRF_CODES.OK, url: sync.url };
  }

  let addresses;
  try {
    addresses = await resolveHost(host, { lookup });
  } catch (error) {
    return {
      ok: false,
      code: SSRF_CODES.DNS_FAILED,
      reason: `could not resolve host "${host}" (${error.message})`,
      url: sync.url,
    };
  }

  if (addresses.length === 0) {
    return {
      ok: false,
      code: SSRF_CODES.DNS_FAILED,
      reason: `host "${host}" did not resolve to any address`,
      url: sync.url,
    };
  }

  // Block if ANY resolved address is internal (defends against
  // round-robin / rebinding that mixes public and private answers).
  for (const address of addresses) {
    if (isPrivateIp(address)) {
      return {
        ok: false,
        code: SSRF_CODES.PRIVATE_IP,
        reason: `"${host}" resolves to internal address ${address}`,
        url: sync.url,
      };
    }
  }

  return { ok: true, code: SSRF_CODES.OK, url: sync.url, addresses };
}


// ─────────────────────────────────────────────────────────────
// Exposed for tests: wipe the DNS memo so lookups re-run.
// ─────────────────────────────────────────────────────────────
export function clearDnsCache() {
  dnsCache.clear();
}
