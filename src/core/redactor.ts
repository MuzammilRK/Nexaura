import { AllowListedPayloadSchema, type AllowListedPayload, type SecretMatch } from '../shared/schema';

// Pure FIPS 180-4 SHA-256 in TypeScript (browser & Node identical)
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => x.toString(16).padStart(8, '0'))
    .join('');
}

export const ALLOW_LIST_KEYS: ReadonlyArray<keyof AllowListedPayload> = [
  'payloadId',
  'tenantId',
  'pseudoSourceId',
  'eventTimeUtc',
  'sourceTz',
  'category',
  'metric',
  'value',
  'severity',
  'healthState',
  'contextSummary',
  'schemaVersion',
];

export function canonicalSerialize(payload: AllowListedPayload): string {
  const ordered: Record<string, string | number> = {};
  for (const key of ALLOW_LIST_KEYS) {
    ordered[key] = payload[key];
  }
  return JSON.stringify(ordered);
}

export function shannonEntropy(token: string): number {
  if (token.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of token) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / token.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

interface SecretRule {
  name: string;
  regex: RegExp;
  reason: string;
}

const SECRET_RULES: SecretRule[] = [
  {
    name: 'google_api_key',
    regex: /AIza[0-9A-Za-z_-]{20,}/g,
    reason: 'Google API key pattern detected',
  },
  {
    name: 'bearer_or_sk_token',
    regex: /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    reason: 'Provider secret token detected',
  },
  {
    name: 'jwt_token',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    reason: 'JWT credential detected',
  },
  {
    name: 'password_kv',
    regex: /(?:password|passwd|pwd|secret|api_key|apikey|token|access_token|private_key)\s*[:=]\s*["']?([^\s"',;}{]{4,})["']?/gi,
    reason: 'Inline credential assignment detected',
  },
  {
    name: 'auth_header',
    regex: /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
    reason: 'Authorization header detected',
  },
  {
    name: 'pem_private_key',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    reason: 'PEM private key material detected',
  },
  {
    name: 'db_connection_string',
    regex: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s]+:[^@\s]+@[^\s]+/gi,
    reason: 'Database URI with embedded password detected',
  },
];

function decodeBase64Safe(candidate: string): string | null {
  try {
    if (typeof atob === 'function') {
      return atob(candidate);
    }
    return Buffer.from(candidate, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function maskSnippet(raw: string): string {
  if (raw.length <= 6) return '***';
  return `${raw.slice(0, 3)}***${raw.slice(-2)}`;
}

export function scanTextForSecrets(text: string, fieldName: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  // Also scan with line breaks collapsed to catch secrets split across lines / stack traces
  const variants = [text, text.replace(/\r?\n\s*/g, '')];

  for (const variant of variants) {
    for (const rule of SECRET_RULES) {
      rule.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.regex.exec(variant)) !== null) {
        const hit = m[0];
        if (!matches.some((x) => x.pattern === rule.name && x.field === fieldName)) {
          matches.push({
            field: fieldName,
            pattern: rule.name,
            snippetPreview: maskSnippet(hit),
            reason: rule.reason,
          });
        }
      }
    }
  }

  // Base64-encoded secret detection
  const b64Regex = /\b[A-Za-z0-9+/]{16,}={0,2}\b/g;
  let b64Match: RegExpExecArray | null;
  while ((b64Match = b64Regex.exec(text)) !== null) {
    const decoded = decodeBase64Safe(b64Match[0]);
    if (decoded && /[\x20-\x7e]{8,}/.test(decoded)) {
      for (const rule of SECRET_RULES) {
        rule.regex.lastIndex = 0;
        if (rule.regex.test(decoded)) {
          matches.push({
            field: fieldName,
            pattern: `base64_${rule.name}`,
            snippetPreview: maskSnippet(b64Match[0]),
            reason: `Base64-encoded secret (${rule.reason})`,
          });
          break;
        }
      }
    }
  }

  // High-entropy token check (tokens >= 20 chars without spaces or standard UID dashes)
  const tokenRegex = /\b[A-Za-z0-9_+/=-]{20,}\b/g;
  let tok: RegExpExecArray | null;
  while ((tok = tokenRegex.exec(text)) !== null) {
    const candidate = tok[0];
    // Skip known safe pseudoSourceId or UUIDv7 formats
    if (/^ps_[0-9a-f]{16}$/i.test(candidate)) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) continue;
    if (shannonEntropy(candidate) >= 3.85) {
      if (!matches.some((x) => x.field === fieldName && x.snippetPreview === maskSnippet(candidate))) {
        matches.push({
          field: fieldName,
          pattern: 'high_entropy_token',
          snippetPreview: maskSnippet(candidate),
          reason: `High-entropy string (${shannonEntropy(candidate).toFixed(2)} bits/char)`,
        });
      }
    }
  }

  return matches;
}

export function redactText(text: string): { sanitized: string; removedSecrets: SecretMatch[] } {
  const removedSecrets = scanTextForSecrets(text, 'rawMessage');
  let sanitized = text;

  // Collapse multi-line tokens if a secret rule spans lines
  for (const rule of SECRET_RULES) {
    sanitized = sanitized.replace(rule.regex, '[REDACTED_SECRET]');
  }

  // Redact any base64 block that decoded to a secret
  sanitized = sanitized.replace(/\b[A-Za-z0-9+/]{16,}={0,2}\b/g, (token) => {
    const decoded = decodeBase64Safe(token);
    if (decoded && /[\x20-\x7e]{8,}/.test(decoded)) {
      for (const rule of SECRET_RULES) {
        rule.regex.lastIndex = 0;
        if (rule.regex.test(decoded)) {
          return '[REDACTED_B64_SECRET]';
        }
      }
    }
    return token;
  });

  // Redact remaining high-entropy tokens
  sanitized = sanitized.replace(/\b[A-Za-z0-9_+/=-]{20,}\b/g, (candidate) => {
    if (/^ps_[0-9a-f]{16}$/i.test(candidate)) return candidate;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) return candidate;
    if (shannonEntropy(candidate) >= 3.85) {
      return '[REDACTED_HIGH_ENTROPY]';
    }
    return candidate;
  });

  // Strip any UIDs or IPv4 addresses to stay privacy-strict
  sanitized = sanitized.replace(/\b[A-Z]{2}-[A-Z]{2}-[A-Z]{3}-D\d{2}-B\d{2}-F\d{2}-W\d{3}-[A-Z0-9]\b/g, '[PSEUDO_UID]');
  sanitized = sanitized.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]');

  return { sanitized: sanitized.slice(0, 236), removedSecrets };
}

export interface AllowListAndGateResult {
  allowedPayload: AllowListedPayload | null;
  serializedBytes: string;
  egressSha256: string;
  droppedFields: string[];
  removedSecrets: SecretMatch[];
  blocked: boolean;
  blockedReason?: string;
}

export function enforceAllowListAndLastGate(
  candidateObject: Record<string, unknown>,
  rawSecretsFromMessage: SecretMatch[],
  bypassPreRedactionForGateTest = false
): AllowListAndGateResult {
  const droppedFields: string[] = [];
  const allSecrets: SecretMatch[] = [...rawSecretsFromMessage];

  for (const [k, v] of Object.entries(candidateObject)) {
    if (!ALLOW_LIST_KEYS.includes(k as keyof AllowListedPayload)) {
      droppedFields.push(k);
      if (typeof v === 'string') {
        const extraSecrets = scanTextForSecrets(v, `dropped:${k}`);
        allSecrets.push(...extraSecrets);
      }
    }
  }

  const picked: Record<string, unknown> = {};
  for (const key of ALLOW_LIST_KEYS) {
    picked[key] = candidateObject[key];
  }

  const parsed = AllowListedPayloadSchema.safeParse(picked);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return {
      allowedPayload: null,
      serializedBytes: '',
      egressSha256: '',
      droppedFields,
      removedSecrets: allSecrets,
      blocked: true,
      blockedReason: `Schema allow-list validation failed: ${reason}`,
    };
  }

  const serializedBytes = canonicalSerialize(parsed.data);
  const egressSha256 = sha256Hex(serializedBytes);

  // Last-Gate Secret Scanner on the exact outbound bytes
  const gateFindings = scanTextForSecrets(serializedBytes, 'last_gate_egress_bytes');
  if (gateFindings.length > 0 || bypassPreRedactionForGateTest) {
    allSecrets.push(...gateFindings);
    const gateReason =
      gateFindings[0]?.reason ?? 'Last-gate policy scanner triggered on outbound payload';
    return {
      allowedPayload: null,
      serializedBytes,
      egressSha256,
      droppedFields,
      removedSecrets: allSecrets,
      blocked: true,
      blockedReason: `BLOCKED AT LAST GATE: ${gateReason}`,
    };
  }

  return {
    allowedPayload: parsed.data,
    serializedBytes,
    egressSha256,
    droppedFields,
    removedSecrets: allSecrets,
    blocked: false,
  };
}
