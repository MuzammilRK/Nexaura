import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalSerialize,
  enforceAllowListAndLastGate,
  redactText,
  scanTextForSecrets,
  sha256Hex,
} from './redactor';
import { processCollectorEvent } from './pipeline';

test('redactText removes passwords, API keys, base64 secrets, and split-line secrets', () => {
  const b64 = Buffer.from('password=SuperSecret99!', 'utf8').toString('base64');
  const splitKey = 'AIzaSyD4k9' + '\n' + 'LmPqRsTuVwXyZ1234567890';
  const raw = `Auth failed for user password=MyDbPass123! token=${b64} key=${splitKey} host=10.24.8.12`;

  const res = redactText(raw);
  assert.ok(!res.sanitized.includes('MyDbPass123!'));
  assert.ok(!res.sanitized.includes(b64));
  assert.ok(!res.sanitized.includes('10.24.8.12'));
  assert.ok(res.removedSecrets.length >= 2);
});

test('allow-list drops unknown odd fields and counts them', () => {
  const candidate: Record<string, unknown> = {
    payloadId: '019a0000-1111-7222-8333-444455556666',
    tenantId: 'tenant-in-bank-01',
    pseudoSourceId: 'ps_1234567890abcdef',
    eventTimeUtc: '2026-11-20T14:28:00.000Z',
    sourceTz: 'Asia/Kolkata',
    category: 'compute',
    metric: 'cpu_pct',
    value: 74.2,
    severity: 'medium',
    healthState: 'Fair',
    contextSummary: 'CPU load elevated on worker pool',
    schemaVersion: '1.0',
    oddSecretField: 'sk-live-secret9988776655',
    internalUserEmail: 'alice@bank.example',
  };

  const result = enforceAllowListAndLastGate(candidate, []);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.droppedFields, ['oddSecretField', 'internalUserEmail']);
  assert.ok(result.allowedPayload);
  assert.ok(!result.serializedBytes.includes('oddSecretField'));
  assert.ok(!result.serializedBytes.includes('alice@bank.example'));
  assert.equal(result.egressSha256, sha256Hex(canonicalSerialize(result.allowedPayload)));
});

test('last-gate scanner blocks payload if unredacted secret survives into allow-listed field', () => {
  const result = processCollectorEvent(
    {
      rawId: 'raw-1',
      deviceUid: 'IN-KA-BLR-D02-B07-F03-W014-X',
      tenantId: 'tenant-in-bank-01',
      region: 'IN',
      eventTimeUtc: '2026-11-20T14:28:00.000Z',
      sourceTz: 'Asia/Kolkata',
      category: 'security',
      metric: 'auth_fail',
      value: 5,
      severity: 'high',
      rawMessage: 'Login failed with sk-prod-1234567890abcdef',
    },
    {
      uid: 'IN-KA-BLR-D02-B07-F03-W014-X',
      cpuPct: 45,
      memoryPct: 50,
      diskPct: 40,
      bandwidthMbps: 120,
      latencyMs: 22,
      packetLossPct: 0.1,
      failedLogins: 5,
      online: true,
      lastHeartbeatUtc: '2026-11-20T14:27:55.000Z',
      healthState: 'Fair',
      healthScore: 80,
    },
    Date.parse('2026-11-20T14:28:00.000Z'),
    true // bypass pre-redaction to verify last gate catches it
  );

  assert.equal(result.record.status, 'blocked');
  assert.ok(result.record.blockedReason?.includes('BLOCKED AT LAST GATE'));
  assert.equal(result.payload, null);
  assert.ok(scanTextForSecrets(result.record.serializedBytes, 'test').length > 0);
});
