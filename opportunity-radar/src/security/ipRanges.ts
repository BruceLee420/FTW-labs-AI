/**
 * IP parsing and private/reserved range checks used by the SSRF guard.
 * Strict parsing on purpose: "127.1", "0x7f000001" and "2130706433" are
 * rejected outright (they are classic filter-bypass spellings), so anything
 * that is not a canonical dotted-quad or a well-formed IPv6 address counts
 * as blocked.
 */

export interface ParsedIp {
  version: 4 | 6;
  bytes: number[];
}

const V4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function parseIp(input: string): ParsedIp | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  const v4 = V4_RE.exec(s);
  if (v4) return { version: 4, bytes: [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])] };
  if (!s.includes(":")) return null;
  return parseIpv6(s);
}

function parseIpv6(s: string): ParsedIp | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  // Embedded IPv4 tail (::ffff:1.2.3.4).
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = V4_RE.exec(maybeV4);
    if (!v4) return null;
    tail = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  if (parts.length === 1 && head.length !== 8) return null;
  const groups = [...head, ...(parts.length === 2 ? Array(Math.max(0, 8 - head.length - rest.length)).fill("0") : []), ...rest];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return { version: 6, bytes };
}

function inCidr(bytes: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if (((bytes[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

const V4_BLOCKED: [number[], number][] = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

function isBlockedV4(b: number[]): boolean {
  return V4_BLOCKED.some(([p, bits]) => inCidr(b, p, bits));
}

export function isBlockedAddress(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return true;
  if (parsed.version === 4) return isBlockedV4(parsed.bytes);
  const b = parsed.bytes;
  const allZero = b.every((x) => x === 0);
  if (allZero) return true; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
  // ::ffff:0:0/96 mapped and 64:ff9b::/96 translated — check the embedded IPv4.
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return isBlockedV4(b.slice(12));
  if (inCidr(b, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) return isBlockedV4(b.slice(12));
  if (inCidr(b, [0xfc], 7)) return true; // fc00::/7 unique local
  if (inCidr(b, [0xfe, 0x80], 10)) return true; // fe80::/10 link local
  if (inCidr(b, [0xfe, 0xc0], 10)) return true; // fec0::/10 site local (deprecated)
  if (inCidr(b, [0xff], 8)) return true; // multicast
  if (inCidr(b, [0x20, 0x01, 0x0d, 0xb8], 32)) return true; // documentation
  if (inCidr(b, [0x01, 0x00, 0, 0, 0, 0, 0, 0], 64)) return true; // discard
  return false;
}
