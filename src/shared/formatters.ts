export function shortEventId(payloadId: string): string {
  if (!payloadId) return '—';
  const clean = payloadId.replace(/[^a-zA-Z0-9]/g, '');
  return `EVT-${clean.slice(-6).toUpperCase()}`;
}

export function shortHash(sha?: string): string {
  if (!sha) return '—';
  if (sha.length <= 14) return sha;
  return `${sha.slice(0, 6)}…${sha.slice(-4)}`;
}

export function shortPseudoId(pseudoId: string): string {
  if (!pseudoId) return '—';
  const raw = pseudoId.replace(/^ps_/, '');
  if (raw.length <= 8) return `Node ${raw}`;
  return `Node ${raw.slice(0, 4)}·${raw.slice(-3)}`;
}

export function shortDeviceUid(uid: string): string {
  if (!uid) return '—';
  const parts = uid.split('-');
  if (parts.length >= 7) {
    return `${parts[2]} · ${parts[4]}-${parts[5]}-${parts[6]}`;
  }
  return uid;
}

export function shortIncidentId(id: string): string {
  if (!id) return '—';
  const tail = id.replace(/[^a-zA-Z0-9]/g, '').slice(-5).toUpperCase();
  return `INC-${tail}`;
}

export function shortTimeUtc(iso: string): string {
  if (!iso || iso.length < 19) return iso || '—';
  return `${iso.slice(11, 19)} UTC`;
}
