import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceRemediation,
  buildCorrelatedIncident,
  detectSeasonalAnomaly,
  evaluateHealth,
  forecastExhaustionBand,
} from './aiops';
import { GLOBAL_TOPOLOGY } from '../shared/topology';
import type { AllowListedPayload, LiveDeviceMetrics, RemediationRecord } from '../shared/schema';

test('evaluateHealth marks collector unreachable as Poor when heartbeat > 60s stale', () => {
  const now = Date.parse('2026-11-20T14:30:00.000Z');
  const metrics: LiveDeviceMetrics = {
    uid: 'IN-KA-BLR-D02-B07-F03-W014-X',
    cpuPct: 30,
    memoryPct: 40,
    diskPct: 45,
    bandwidthMbps: 100,
    latencyMs: 18,
    packetLossPct: 0,
    failedLogins: 0,
    online: true,
    lastHeartbeatUtc: '2026-11-20T14:28:30.000Z', // 90s old
    healthState: 'Excellent',
    healthScore: 98,
  };

  const result = evaluateHealth(metrics, now);
  assert.equal(result.isStale, true);
  assert.equal(result.state, 'Poor');
  assert.ok(result.reason.includes('Collector unreachable'));
});

test('detectSeasonalAnomaly distinguishes transient spike from persistent corroborated anomaly', () => {
  const transient = detectSeasonalAnomaly([28, 30, 29, 31, 30, 88], false);
  assert.equal(transient.classification, 'transient_spike');
  assert.equal(transient.isAnomaly, false);

  const persistent = detectSeasonalAnomaly([28, 30, 29, 31, 86, 92], true);
  assert.equal(persistent.classification, 'confirmed_anomaly');
  assert.equal(persistent.isAnomaly, true);
});

test('forecastExhaustionBand computes ETA uncertainty band on upward trend', () => {
  const band = forecastExhaustionBand('memory_pct', [45, 50, 56, 63, 70], 95, 1);
  assert.ok(band.predictedEtaMinutes !== null && band.predictedEtaMinutes > 0);
  assert.ok(band.lowerBoundMinutes !== null && band.upperBoundMinutes !== null);
  assert.ok(band.lowerBoundMinutes <= band.predictedEtaMinutes);
  assert.ok(band.upperBoundMinutes >= band.predictedEtaMinutes);
});

test('correlated incident and two-person remediation approval rule work end-to-end', () => {
  const dev = GLOBAL_TOPOLOGY[0];
  const alerts: AllowListedPayload[] = [
    {
      payloadId: '019a0000-aaaa-7000-8000-000000000001',
      tenantId: dev.tenantId,
      pseudoSourceId: dev.pseudoSourceId,
      eventTimeUtc: '2026-11-20T14:28:00.000Z',
      sourceTz: 'Asia/Kolkata',
      category: 'network',
      metric: 'latency_ms',
      value: 215,
      severity: 'high',
      healthState: 'Poor',
      contextSummary: 'Floor uplink latency spike',
      schemaVersion: '1.0',
    },
    {
      payloadId: '019a0000-aaaa-7000-8000-000000000002',
      tenantId: dev.tenantId,
      pseudoSourceId: dev.pseudoSourceId,
      eventTimeUtc: '2026-11-20T14:28:10.000Z',
      sourceTz: 'Asia/Kolkata',
      category: 'network',
      metric: 'packet_loss_pct',
      value: 5.4,
      severity: 'critical',
      healthState: 'Poor',
      contextSummary: 'Packet drops on uplink',
      schemaVersion: '1.0',
    },
  ];

  const incident = buildCorrelatedIncident(alerts, GLOBAL_TOPOLOGY, new Map());
  assert.ok(incident);
  assert.equal(incident.correlatedAlertCount, 2);
  assert.ok(incident.rootCause.confidence >= 0.75);

  const rem: RemediationRecord = {
    remediationId: 'rem-1',
    incidentId: incident.incidentId,
    tenantId: incident.tenantId,
    region: incident.region,
    actionTitle: incident.recommendation.title,
    actionType: incident.recommendation.actionType,
    proposedBy: 'alice.admin',
    stage: 'policy_checked',
    policyChecks: [{ rule: 'Tenant boundary verified', passed: true }],
    rollbackPlan: incident.recommendation.rollbackPlan,
    auditLog: [],
  };

  // Same user cannot approve
  const sameUser = advanceRemediation(rem, 'alice.admin', 'approve', '2026-11-20T14:28:20.000Z');
  assert.ok(sameUser.error);

  // Different peer approves and executes
  const peerApprove = advanceRemediation(rem, 'bob.secops', 'approve', '2026-11-20T14:28:25.000Z');
  assert.equal(peerApprove.error, undefined);
  assert.equal(peerApprove.updated.stage, 'approved');

  const execRes = advanceRemediation(peerApprove.updated, 'bob.secops', 'execute', '2026-11-20T14:28:30.000Z');
  assert.equal(execRes.updated.stage, 'executed_simulated');
});

test('buildCorrelatedIncident classifies DNS failure and storage saturation distinctly', () => {
  const dev = GLOBAL_TOPOLOGY[0];
  const dnsIncident = buildCorrelatedIncident(
    [
      {
        payloadId: '019a0000-bbbb-7000-8000-000000000001',
        tenantId: dev.tenantId,
        pseudoSourceId: dev.pseudoSourceId,
        eventTimeUtc: '2026-11-20T14:29:00.000Z',
        sourceTz: 'Asia/Kolkata',
        category: 'application',
        metric: 'dns_failure_rate',
        value: 38.5,
        severity: 'critical',
        healthState: 'Poor',
        contextSummary: 'Upstream DNS SERVFAIL burst',
        schemaVersion: '1.0',
      },
    ],
    GLOBAL_TOPOLOGY,
    new Map()
  );
  assert.ok(dnsIncident);
  assert.equal(dnsIncident.recommendation.actionType, 'restart_dns_resolver');
  assert.ok(dnsIncident.title.includes('DNS'));

  const diskIncident = buildCorrelatedIncident(
    [
      {
        payloadId: '019a0000-bbbb-7000-8000-000000000002',
        tenantId: dev.tenantId,
        pseudoSourceId: dev.pseudoSourceId,
        eventTimeUtc: '2026-11-20T14:29:05.000Z',
        sourceTz: 'Asia/Kolkata',
        category: 'storage',
        metric: 'disk_io_wait_pct',
        value: 96.4,
        severity: 'high',
        healthState: 'Poor',
        contextSummary: 'WAL flush queue stalled',
        schemaVersion: '1.0',
      },
    ],
    GLOBAL_TOPOLOGY,
    new Map()
  );
  assert.ok(diskIncident);
  assert.equal(diskIncident.recommendation.actionType, 'clear_cache_spool');
  assert.ok(diskIncident.title.includes('Disk'));
});

