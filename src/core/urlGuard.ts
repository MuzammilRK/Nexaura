import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    num = (num << 8) | n;
  }
  return num >>> 0;
}

export function isRestrictedIpAddress(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase();
  if (!ip) return true;

  // Handle IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
  if (ip.startsWith('::ffff:')) {
    return isRestrictedIpAddress(ip.slice(7));
  }

  const v4Int = ipv4ToInt(ip);
  if (v4Int !== null) {
    const first = (v4Int >>> 24) & 0xff;
    const second = (v4Int >>> 16) & 0xff;

    if (first === 0) return true; // 0.0.0.0/8 ("this network")
    if (first === 10) return true; // 10.0.0.0/8 (RFC1918)
    if (first === 100 && second >= 64 && second <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (first === 127) return true; // 127.0.0.0/8 (loopback)
    if (first === 169 && second === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
    if (first === 172 && second >= 16 && second <= 31) return true; // 172.16.0.0/12 (RFC1918)
    if (first === 192 && second === 168) return true; // 192.168.0.0/16 (RFC1918)
    if (first === 192 && second === 0 && ((v4Int >>> 8) & 0xff) === 0) return true; // 192.0.0.0/24
    if (first >= 224) return true; // Multicast & reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true; // Unspecified or loopback
    if (ip.startsWith('fe80:') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) {
      return true; // Link-local fe80::/10
    }
    if (ip.startsWith('fc') || ip.startsWith('fd')) {
      return true; // Unique local fc00::/7
    }
    if (ip.startsWith('ff')) {
      return true; // Multicast
    }
    return false;
  }

  return true;
}

export function validateUrlSyntax(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, reason: 'URL is empty.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Malformed URL. Use full http:// or https:// address.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported protocol "${parsed.protocol}". Only http and https are allowed.` };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) {
    return { ok: false, reason: 'Hostname is required.' };
  }

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: `Blocked internal hostname "${host}".` };
  }

  if (net.isIP(host) && isRestrictedIpAddress(host)) {
    return { ok: false, reason: `Blocked restricted or local IP address "${host}".` };
  }

  return { ok: true, url: parsed };
}

export async function validatePublicHttpUrl(
  rawUrl: string,
  lookupFn: typeof dns.lookup = dns.lookup
): Promise<{ ok: true; url: URL; resolvedIps: string[] } | { ok: false; reason: string }> {
  const syntax = validateUrlSyntax(rawUrl);
  if (!syntax.ok) return syntax;

  const host = syntax.url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    return { ok: true, url: syntax.url, resolvedIps: [host] };
  }

  try {
    const records = await lookupFn(host, { all: true, verbatim: true });
    const ips = records.map((r) => r.address);
    if (ips.length === 0) {
      return { ok: false, reason: `DNS lookup returned no addresses for "${host}".` };
    }
    const blockedIp = ips.find((ip) => isRestrictedIpAddress(ip));
    if (blockedIp) {
      return {
        ok: false,
        reason: `Blocked hostname "${host}" because it resolves to a local or private network address (${blockedIp}).`,
      };
    }
    return { ok: true, url: syntax.url, resolvedIps: ips };
  } catch {
    return { ok: false, reason: `DNS resolution failed for "${host}".` };
  }
}
