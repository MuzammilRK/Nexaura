import { z } from 'zod';

export type RegionCode = 'IN' | 'EU' | 'US';

export type HealthState = 'Excellent' | 'Good' | 'Fair' | 'Poor';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type IndustryType =
  | 'bank'
  | 'mnc'
  | 'supermarket'
  | 'hospital'
  | 'university'
  | 'datacenter';

export type UserRole = 'device_operator' | 'tenant_admin' | 'super_admin';

export const TelemetryCategorySchema = z.enum([
  'compute',
  'memory',
  'storage',
  'network',
  'security',
  'application',
  'heartbeat',
]);

export type TelemetryCategory = z.infer<typeof TelemetryCategorySchema>;

export const HealthStateSchema = z.enum(['Excellent', 'Good', 'Fair', 'Poor']);
export const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);

export const AllowListedPayloadSchema = z.object({
  payloadId: z.string().min(12),
  tenantId: z.string().min(2),
  pseudoSourceId: z.string().min(8),
  eventTimeUtc: z.string().datetime(),
  sourceTz: z.string().min(2),
  category: TelemetryCategorySchema,
  metric: z.string().min(1).max(64),
  value: z.number().finite(),
  severity: SeveritySchema,
  healthState: HealthStateSchema,
  contextSummary: z.string().max(240),
  schemaVersion: z.literal('1.0'),
});

export type AllowListedPayload = z.infer<typeof AllowListedPayloadSchema>;

export interface RawTelemetryEvent {
  rawId: string;
  deviceUid: string;
  tenantId: string;
  region: RegionCode;
  eventTimeUtc: string;
  sourceTz: string;
  category: TelemetryCategory;
  metric: string;
  value: number;
  severity: Severity;
  rawMessage: string;
  extraFields?: Record<string, string | number | boolean>;
  injectedAtMs?: number;
}

export interface SecretMatch {
  field: string;
  pattern: string;
  snippetPreview: string;
  reason: string;
}

export interface EgressProofRecord {
  payloadId: string;
  deviceUid: string;
  tenantId: string;
  region: RegionCode;
  createdAtUtc: string;
  status: 'delivered' | 'spooled' | 'blocked';
  blockedReason?: string;
  rawSnapshotRedactedPreview: string;
  serializedBytes: string;
  egressSha256: string;
  saasStoredSha256?: string;
  hashVerified?: boolean;
  droppedFields: string[];
  removedSecrets: SecretMatch[];
  clockSkewFlagged: boolean;
  serverFallbackUtc?: string;
  latencyMetrics?: {
    injectedAtMs: number;
    collectedAtMs: number;
    deliveredAtMs?: number;
    collectionMs: number;
    endToEndMs?: number;
  };
}

export interface SpoolEntry {
  payload: AllowListedPayload;
  egressSha256: string;
  enqueuedAtMs: number;
  attempts: number;
  nextRetryAtMs: number;
  droppedLowSeverityCount?: number;
}

export interface HealthThresholds {
  cpuFair: number;
  cpuPoor: number;
  memoryFair: number;
  memoryPoor: number;
  latencyFairMs: number;
  latencyPoorMs: number;
  packetLossFairPct: number;
  packetLossPoorPct: number;
  failedLoginsFair: number;
  failedLoginsPoor: number;
  staleSeconds: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  cpuFair: 72,
  cpuPoor: 90,
  memoryFair: 78,
  memoryPoor: 92,
  latencyFairMs: 85,
  latencyPoorMs: 180,
  packetLossFairPct: 1.5,
  packetLossPoorPct: 4.5,
  failedLoginsFair: 4,
  failedLoginsPoor: 10,
  staleSeconds: 60,
};

export interface HealthSubScores {
  availability: { score: number; weight: number };
  resource: { score: number; weight: number };
  network: { score: number; weight: number };
  security: { score: number; weight: number };
}

export interface HealthEvaluation {
  state: HealthState;
  overallScore: number;
  subScores: HealthSubScores;
  reason: string;
  sinceUtc: string;
  isStale: boolean;
  staleAgeSeconds: number;
}

export interface SignalContribution {
  metric: string;
  observed: number;
  baseline: number;
  zScore: number;
  weight: number;
  note: string;
}

export interface PredictionBand {
  metric: string;
  horizonLabel: string;
  currentValue: number;
  predictedEtaMinutes: number | null;
  lowerBoundMinutes: number | null;
  upperBoundMinutes: number | null;
  confidence: number;
  summary: string;
}

export interface Incident {
  incidentId: string;
  tenantId: string;
  region: RegionCode;
  title: string;
  severity: Severity;
  status: 'open' | 'acknowledged' | 'remediated';
  openedAtUtc: string;
  updatedAtUtc: string;
  affectedPseudoIds: string[];
  affectedEdges: string[];
  correlatedAlertCount: number;
  rootCause: {
    summary: string;
    confidence: number;
    contributingSignals: SignalContribution[];
    reasoningPath: string[];
  };
  recommendation: {
    title: string;
    actionType:
      | 'throttle_process'
      | 'reroute_switch'
      | 'lock_account'
      | 'clear_cache_spool'
      | 'scale_pool'
      | 'rotate_cert'
      | 'restart_dns_resolver'
      | 'restore_heartbeat'
      | 'rate_limit_egress';
    narrative: string;
    llmEnhanced: boolean;
    llmModel?: string;
    rollbackPlan: string;
  };
  prediction?: PredictionBand;
}

export type RemediationStage =
  | 'proposed'
  | 'policy_checked'
  | 'approved'
  | 'executed_simulated'
  | 'rolled_back'
  | 'rejected';

export interface RemediationRecord {
  remediationId: string;
  incidentId: string;
  tenantId: string;
  region: RegionCode;
  actionTitle: string;
  actionType: string;
  proposedBy: string;
  approvedBy?: string;
  stage: RemediationStage;
  policyChecks: { rule: string; passed: boolean }[];
  rollbackPlan: string;
  auditLog: { timestampUtc: string; actor: string; event: string }[];
}

export interface DeviceProfile {
  uid: string;
  pseudoSourceId: string;
  tenantId: string;
  region: RegionCode;
  countryCode: string;
  countryName: string;
  stateCode: string;
  stateName: string;
  cityCode: string;
  cityName: string;
  districtCode: string;
  districtName: string;
  buildingCode: string;
  buildingName: string;
  industry: IndustryType;
  floorNumber: number;
  floorSwitchId: string;
  buildingCoreId: string;
  collectorId: string;
  hostname: string;
  username: string;
  accentHex: string;
  wallpaperStyle: 'cobalt-grid' | 'emerald-prism' | 'amber-circuit' | 'indigo-wave' | 'teal-slate' | 'cyan-horizon';
  cpuSpec: string;
  ramGb: number;
  osVersion: string;
  installedApps: string[];
  taskbarApps: string[];
  lat: number;
  lon: number;
}

export interface LiveDeviceMetrics {
  uid: string;
  cpuPct: number;
  memoryPct: number;
  diskPct: number;
  bandwidthMbps: number;
  latencyMs: number;
  packetLossPct: number;
  failedLogins: number;
  online: boolean;
  lastHeartbeatUtc: string;
  healthState: HealthState;
  healthScore: number;
}

export interface WindowsLogEntry {
  id: string;
  deviceUid: string;
  channel: 'Security' | 'System' | 'Application';
  eventId: number;
  level: 'Information' | 'Warning' | 'Error' | 'Critical';
  source: string;
  timestampUtc: string;
  message: string;
  containsSecret?: boolean;
}

export interface EncryptedFileTransfer {
  transferId: string;
  fromUid: string;
  toUid: string;
  fromTenantId: string;
  toTenantId: string;
  fileName: string;
  sizeClass: 'XS (<10KB)' | 'S (10-100KB)' | 'M (100KB-1MB)' | 'L (>1MB)';
  ciphertextSha256: string;
  ciphertextPreview: string;
  crossTenantPolicyApproved: boolean;
  createdAtUtc: string;
  status: 'relayed_encrypted' | 'blocked_policy';
}

export type ScenarioType =
  | 'cpu_spike'
  | 'memory_leak'
  | 'latency_rise'
  | 'failed_login_burst'
  | 'secret_in_log'
  | 'saas_outage_toggle'
  | 'duplicate_replay'
  | 'out_of_order_delivery'
  | 'correlated_incident'
  | 'clock_skew'
  | 'disk_io_saturation'
  | 'dns_failure_burst'
  | 'cert_expiry_warning'
  | 'heartbeat_flap'
  | 'bandwidth_saturation'
  | 'privilege_escalation';

export interface ScenarioRequest {
  type: ScenarioType;
  deviceUid: string;
  region?: RegionCode;
  tenantIds?: string[];
}

export type LogCategory =
  | 'metadata'
  | 'tenant_data'
  | 'login_logout'
  | 'authentication'
  | 'alerts'
  | 'user_activity'
  | 'transfer';

export interface StructuredLogEntry {
  id: string;
  category: LogCategory;
  tier: 'tier1' | 'tier2' | 'both';
  region: RegionCode;
  tenantId: string;
  deviceUid?: string;
  pseudoSourceId?: string;
  actor: string;
  action: string;
  severity: Severity;
  timestampUtc: string;
  summary: string;
  details?: Record<string, string | number | boolean>;
}

export interface SessionInfo {
  token: string;
  username: string;
  role: UserRole;
  tenantId: string;
  region: RegionCode;
  deviceUid?: string;
  expiresAtUtc: string;
}
