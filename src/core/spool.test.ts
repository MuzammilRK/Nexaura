import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeReconcile,
  enqueueSpool,
  ingestWithDedupe,
  nextRetryBackoffMs,
  sortByEventTimeUtc,
} from './spool';
import type { AllowListedPayload, SpoolEntry } from '../shared/schema';

function makePayload(id: string, severity: AllowListedPayload['severity'], ts: string): AllowListedPayload {
  return {
    payloadId: id,
    tenantId: 'tenant-in-bank-01',
    pseudoSourceId: 'ps_1234567890abcdef',
    eventTimeUtc: ts,
    sourceTz: 'Asia/Kolkata',
    category: 'compute',
    metric: 'cpu_pct',
    value: 55,
    severity,
    healthState: 'Good',
    contextSummary: 'Nominal telemetry',
    schemaVersion: '1.0',
  };
}

test('spool drops only low-severity items when cap reached and preserves critical items', () => {
  let spool: SpoolEntry[] = [];
  const pLow = makePayload('019a-0000-0001', 'low', '2026-11-20T14:00:00.000Z');
  const pCrit = makePayload('019a-0000-0002', 'critical', '2026-11-20T14:00:01.000Z');
  const pHigh = makePayload('019a-0000-0003', 'high', '2026-11-20T14:00:02.000Z');

  spool = enqueueSpool(spool, { payload: pLow, egressSha256: 'a', enqueuedAtMs: 1, attempts: 0, nextRetryAtMs: 1 }, 2).spool;
  spool = enqueueSpool(spool, { payload: pCrit, egressSha256: 'b', enqueuedAtMs: 2, attempts: 0, nextRetryAtMs: 2 }, 2).spool;

  const res = enqueueSpool(spool, { payload: pHigh, egressSha256: 'c', enqueuedAtMs: 3, attempts: 0, nextRetryAtMs: 3 }, 2);
  assert.equal(res.droppedCount, 1);
  assert.equal(res.spool.length, 2);
  assert.ok(res.spool.some((e) => e.payload.payloadId === '019a-0000-0002'));
  assert.ok(res.spool.some((e) => e.payload.payloadId === '019a-0000-0003'));
  assert.ok(!res.spool.some((e) => e.payload.payloadId === '019a-0000-0001'));
});

test('dedupe by payloadId prevents duplicates and reconcile verifies zero lost / zero dupes', () => {
  const p1 = makePayload('019a-0000-1001', 'medium', '2026-11-20T14:00:05.000Z');
  const p2 = makePayload('019a-0000-1002', 'high', '2026-11-20T14:00:02.000Z');

  const first = ingestWithDedupe(new Set(), [p1, p2]);
  assert.equal(first.accepted.length, 2);
  assert.equal(first.duplicateIds.length, 0);

  // Replay p1
  const second = ingestWithDedupe(first.updatedIdSet, [p1]);
  assert.equal(second.accepted.length, 0);
  assert.deepEqual(second.duplicateIds, ['019a-0000-1001']);

  const ordered = sortByEventTimeUtc(first.accepted);
  assert.equal(ordered[0].payloadId, '019a-0000-1002');
  assert.equal(ordered[1].payloadId, '019a-0000-1001');

  const reconcile = computeReconcile(
    ['019a-0000-1001', '019a-0000-1002'],
    Array.from(second.updatedIdSet),
    0
  );
  assert.equal(reconcile.matched, true);
  assert.equal(reconcile.lostCount, 0);
  assert.equal(reconcile.duplicateCount, 0);
});

test('exponential backoff grows with attempts and jitter', () => {
  assert.equal(nextRetryBackoffMs(0, 0), 1000);
  assert.equal(nextRetryBackoffMs(3, 0.2), 9600);
});
