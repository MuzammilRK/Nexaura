import {
  DEFAULT_HEALTH_THRESHOLDS,
  type EgressProofRecord,
  type HealthEvaluation,
  type LiveDeviceMetrics,
  type RawTelemetryEvent,
} from '../shared/schema';
import { computePseudoIdSync } from '../shared/topology';
import { evaluateHealth } from './aiops';
import { enforceAllowListAndLastGate, redactText } from './redactor';

let uuidv7Seq = 0;

export function generateUuidV7(nowMs = Date.now()): string {
  uuidv7Seq = (uuidv7Seq + 1) & 0x0fff;
  const timeHex = nowMs.toString(16).padStart(12, '0');
  const verAndSeq = (0x7000 | uuidv7Seq).toString(16).padStart(4, '0');
  const randA = Math.floor(Math.random() * 0x3fff) | 0x8000;
  const randB1 = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  const randB2 = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');

  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-${verAndSeq}-${randA.toString(16).padStart(4, '0')}-${randB1}${randB2}`;
}

export interface PipelineProcessResult {
  record: EgressProofRecord;
  payload: ReturnType<typeof enforceAllowListAndLastGate>['allowedPayload'];
  health: HealthEvaluation;
}

export function processCollectorEvent(
  raw: RawTelemetryEvent,
  metricsSnapshot: LiveDeviceMetrics,
  serverNowMs = Date.now(),
  bypassPreRedactionForLastGateTest = false
): PipelineProcessResult {
  const collectedAtMs = serverNowMs;
  const eventMs = Date.parse(raw.eventTimeUtc);
  // Clock skew guard: event timestamp > 5 seconds ahead of server
  const clockSkewFlagged = Number.isFinite(eventMs) && eventMs - serverNowMs > 5000;
  const normalizedEventUtc = clockSkewFlagged
    ? new Date(serverNowMs).toISOString()
    : raw.eventTimeUtc;

  const health = evaluateHealth(metricsSnapshot, serverNowMs, DEFAULT_HEALTH_THRESHOLDS);

  const redaction = bypassPreRedactionForLastGateTest
    ? { sanitized: raw.rawMessage.slice(0, 236), removedSecrets: [] }
    : redactText(raw.rawMessage);

  const payloadId = generateUuidV7(serverNowMs);
  const pseudoSourceId = computePseudoIdSync(raw.deviceUid, raw.tenantId);

  const candidateObject: Record<string, unknown> = {
    payloadId,
    tenantId: raw.tenantId,
    pseudoSourceId,
    eventTimeUtc: normalizedEventUtc,
    sourceTz: raw.sourceTz,
    category: raw.category,
    metric: raw.metric,
    value: Number(raw.value.toFixed(2)),
    severity: raw.severity,
    healthState: health.state,
    contextSummary: redaction.sanitized,
    schemaVersion: '1.0',
    ...(raw.extraFields ?? {}),
  };

  const gateResult = enforceAllowListAndLastGate(
    candidateObject,
    redaction.removedSecrets,
    false
  );

  const injectedAtMs = raw.injectedAtMs ?? collectedAtMs;

  const record: EgressProofRecord = {
    payloadId,
    deviceUid: raw.deviceUid,
    tenantId: raw.tenantId,
    region: raw.region,
    createdAtUtc: new Date(serverNowMs).toISOString(),
    status: gateResult.blocked ? 'blocked' : 'spooled',
    blockedReason: gateResult.blockedReason,
    rawSnapshotRedactedPreview: redaction.sanitized,
    serializedBytes: gateResult.serializedBytes,
    egressSha256: gateResult.egressSha256,
    droppedFields: gateResult.droppedFields,
    removedSecrets: gateResult.removedSecrets,
    clockSkewFlagged,
    serverFallbackUtc: clockSkewFlagged ? new Date(serverNowMs).toISOString() : undefined,
    latencyMetrics: {
      injectedAtMs,
      collectedAtMs,
      collectionMs: Math.max(1, collectedAtMs - injectedAtMs),
    },
  };

  return {
    record,
    payload: gateResult.allowedPayload,
    health,
  };
}
