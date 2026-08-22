import net from "node:net";
import dns from "node:dns/promises";

// Deliberately conservative deny-list: over-blocking a borderline address is a far
// better failure mode than under-blocking one that reaches internal infrastructure.
const BLOCKED_IPV4_RANGES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // includes the cloud metadata address 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isIpv4Blocked(ip) {
  const ipInt = ipv4ToInt(ip);
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => {
    const baseInt = ipv4ToInt(base);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
  });
}

function isIpv6Blocked(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true; // loopback / unspecified
  if (/^fe[89ab]/.test(normalized)) return true; // link-local fe80::/10 (conservatively fe80-febf)
  if (/^fe[cdef]/.test(normalized)) return true; // deprecated site-local, same conservative bucket
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local fc00::/7
  if (normalized.startsWith("::ffff:")) {
    const embedded = normalized.slice(7);
    if (net.isIP(embedded) === 4) return isIpv4Blocked(embedded);
  }
  return false;
}

export function isBlockedIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isIpv4Blocked(ip);
  if (version === 6) return isIpv6Blocked(ip);
  return true; // not a valid IP literal at all — block defensively
}

// Resolves a hostname and rejects it if ANY resolved address is blocked. Callers
// must call this again on every redirect hop (redirect-to-internal is the classic
// SSRF bypass) — this function only covers a single hostname per call.
export async function resolveAndCheckHost(hostname) {
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("DNS_RESOLUTION_FAILED");
  }
  if (addresses.length === 0) {
    throw new Error("DNS_RESOLUTION_FAILED");
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new Error("BLOCKED_IP");
    }
  }
  return addresses.map((a) => a.address);
}
