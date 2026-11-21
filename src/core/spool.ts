import type { AllowListedPayload, Severity, SpoolEntry } from '../shared/schema';

export interface EnqueueResult {
  spool: SpoolEntry[];
  droppedCount: number;
  accepted: boolean;
}

const SEVERITY_PRIORITY: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function nextRetryBackoffMs(attempts: number, jitterRatio = 0.2): number {
  const baseMs = 1000 * Math.pow(2, Math.min(attempts, 6));
  const clampedJitter = Math.max(0, Math.min(0.35, jitterRatio));
  return Math.round(baseMs * (1 + clampedJitter));
}

export function enqueueSpool(
  currentSpool: SpoolEntry[],
  entry: SpoolEntry,
  maxCap = 200
): EnqueueResult {
  // Prevent duplicate payloadId in the local spool
  if (currentSpool.some((e) => e.payload.payloadId === entry.payload.payloadId)) {
    return { spool: currentSpool, droppedCount: 0, accepted: false };
  }

  if (currentSpool.length < maxCap) {
    return {
      spool: [...currentSpool, entry],
      droppedCount: 0,
      accepted: true,
    };
  }

  // Size cap hit: drop lowest-severity oldest item first (preferring 'low')
  const lowIndex = currentSpool.findIndex((e) => e.payload.severity === 'low');
  if (lowIndex !== -1) {
    const next = [...currentSpool.slice(0, lowIndex), ...currentSpool.slice(lowIndex + 1), entry];
    return { spool: next, droppedCount: 1, accepted: true };
  }

  // If incoming itself is low severity and spool has no low-severity items, drop incoming
  if (SEVERITY_PRIORITY[entry.payload.severity] <= SEVERITY_PRIORITY.low) {
    return { spool: currentSpool, droppedCount: 1, accepted: false };
  }

  // Otherwise evict oldest medium if incoming is high/critical
  const medIndex = currentSpool.findIndex((e) => e.payload.severity === 'medium');
  if (medIndex !== -1 && SEVERITY_PRIORITY[entry.payload.severity] > SEVERITY_PRIORITY.medium) {
    const next = [...currentSpool.slice(0, medIndex), ...currentSpool.slice(medIndex + 1), entry];
    return { spool: next, droppedCount: 1, accepted: true };
  }

  return { spool: currentSpool, droppedCount: 1, accepted: false };
}

export interface DedupeResult {
  accepted: AllowListedPayload[];
  duplicateIds: string[];
  updatedIdSet: Set<string>;
}

export function ingestWithDedupe(
  existingIds: ReadonlySet<string>,
  incoming: AllowListedPayload[]
): DedupeResult {
  const updatedIdSet = new Set(existingIds);
  const accepted: AllowListedPayload[] = [];
  const duplicateIds: string[] = [];

  for (const item of incoming) {
    if (updatedIdSet.has(item.payloadId)) {
      duplicateIds.push(item.payloadId);
    } else {
      updatedIdSet.add(item.payloadId);
      accepted.push(item);
    }
  }

  return { accepted, duplicateIds, updatedIdSet };
}

export function sortByEventTimeUtc<T extends { eventTimeUtc: string }>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const ta = Date.parse(a.eventTimeUtc);
    const tb = Date.parse(b.eventTimeUtc);
    return ta - tb;
  });
}

export interface ReconcileReport {
  sentCount: number;
  receivedCount: number;
  missingIds: string[];
  lostCount: number;
  duplicateCount: number;
  matched: boolean;
}

export function computeReconcile(
  sentIds: string[],
  receivedIds: string[],
  duplicateCount: number
): ReconcileReport {
  const uniqueSent = Array.from(new Set(sentIds));
  const receivedSet = new Set(receivedIds);
  const missingIds = uniqueSent.filter((id) => !receivedSet.has(id));

  return {
    sentCount: uniqueSent.length,
    receivedCount: receivedSet.size,
    missingIds,
    lostCount: missingIds.length,
    duplicateCount,
    matched: missingIds.length === 0 && duplicateCount === 0,
  };
}
