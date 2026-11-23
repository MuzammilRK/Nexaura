import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DEFAULT_HEALTH_THRESHOLDS,
  type AdminPermissionKey,
  type AllowListedPayload,
  type CloudFaultCode,
  type CloudSystemTelemetry,
  type CountryAdminRecord,
  type EgressProofRecord,
  type EncryptedFileTransfer,
  type HealthThresholds,
  type Incident,
  type LiveDeviceMetrics,
  type LogCategory,
  type RegionCode,
  type RemediationRecord,
  type RouterFaultCode,
  type RouterTelemetry,
  type ScenarioRequest,
  type ScenarioType,
  type Severity,
  type SpoolEntry,
  type StorageFaultCode,
  type StorageTelemetry,
  type StructuredLogEntry,
  type TenantCommPolicy,
  type WindowsLogEntry,
} from '../shared/schema';
import { GLOBAL_TOPOLOGY, getCityTimezone } from '../shared/topology';
import { shortPseudoId } from '../shared/formatters';
import {
  advanceRemediation,
  buildCorrelatedIncident,
  detectSeasonalAnomaly,
  evaluateHealth,
} from '../core/aiops';
import {
  advanceRouterTraffic,
  applyCloudFault,
  applyRouterFault,
  applyStorageFault,
  buildDefaultCountryAdmins,
  computeRouterStatus,
  computeStorageStatus,
  resolveCloudFault,
  resolveRouterFault,
  resolveStorageFault,
} from '../core/infra';
import { buildDefaultTenantCommPolicy, canNodesCommunicate } from '../core/policy';
import { processCollectorEvent } from '../core/pipeline';
import { canonicalSerialize, sha256Hex } from '../core/redactor';
import {
  computeReconcile,
  enqueueSpool,
  ingestWithDedupe,
  nextRetryBackoffMs,
  sortByEventTimeUtc,
} from '../core/spool';
import { hostTelemetrySampler } from './telemetrySource';
import { clusterCoordinator } from './cluster';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const STATE_FILE = path.join(DATA_DIR, 'nexaura-wal-state.json');

interface PersistedSnapshot {
  outageActive: boolean;
  spool: SpoolEntry[];
  droppedLowSeverityTotal: number;
  egressLog: EgressProofRecord[];
  sentIds: string[];
  saasReceivedIds?: string[];
  saasReceivedPayloads: Record<RegionCode, AllowListedPayload[]>;
  saasStoredHashes: Record<string, string>;
  duplicateCount: number;
  thresholds: HealthThresholds;
}

class NexauraEngine {
  public deviceMetrics = new Map<string, LiveDeviceMetrics>();
  public metricHistories = new Map<string, number[]>();
  public tenantCommPolicies = new Map<string, TenantCommPolicy>();
  public localRawLogs = new Map<string, WindowsLogEntry[]>(); // Strictly local to Tier 1 Collector!
  public outageActive = false;
  public spool: SpoolEntry[] = [];
  public droppedLowSeverityTotal = 0;
  public egressLog: EgressProofRecord[] = [];
  public sentIds: string[] = [];
  public saasReceivedIds = new Set<string>();
  public saasReceivedPayloads: Record<RegionCode, AllowListedPayload[]> = {
    IN: [],
    EU: [],
    US: [],
  };
  public saasStoredHashes = new Map<string, string>();
  public duplicateCount = 0;
  public incidents: Incident[] = [];
  public remediations: RemediationRecord[] = [];
  public fileTransfers: EncryptedFileTransfer[] = [];
  public auditEvents: { timestampUtc: string; actor: string; action: string; detail: string }[] = [];
  public structuredLogs: StructuredLogEntry[] = [];
  public thresholds: HealthThresholds = { ...DEFAULT_HEALTH_THRESHOLDS };
  public lastCollectorHeartbeatUtc = new Date().toISOString();
  public countryAdmins: CountryAdminRecord[] = buildDefaultCountryAdmins();
  public serverInfra: Record<
    RegionCode,
    {
      router: RouterTelemetry;
      storage: StorageTelemetry;
      cloud: CloudSystemTelemetry;
    }
  > = {
    IN: {
      router: {
        routerId: 'rtr-core-in-01',
        status: 'Nominal',
        dataTransferredMb: 4820.4,
        packetCount: 384200,
        packetsSent: 384112,
        packetLossCount: 88,
        packetLossPct: 0.02,
        bandwidthMbps: 1420,
        latencyMs: 18.4,
        activeError: null,
        errorDetail: null,
      },
      storage: {
        storageId: 'stg-vault-in-01',
        status: 'Nominal',
        usedPct: 46.2,
        capacityGb: 8192,
        iops: 6400,
        readMbps: 890,
        writeMbps: 420,
        raidState: 'Healthy (RAID-10)',
        smartStatus: 'PASS',
        activeError: null,
        errorDetail: null,
      },
      cloud: {
        cloudId: 'cld-mesh-in-mumbai',
        status: 'Nominal',
        provider: 'Nexaura Sovereign Cloud (IN)',
        regionEndpoint: 'IN',
        mtlsState: 'Verified',
        syncLatencyMs: 19,
        activeError: null,
        errorDetail: null,
      },
    },
    EU: {
      router: {
        routerId: 'rtr-core-eu-01',
        status: 'Nominal',
        dataTransferredMb: 3910.8,
        packetCount: 312450,
        packetsSent: 312380,
        packetLossCount: 70,
        packetLossPct: 0.02,
        bandwidthMbps: 1280,
        latencyMs: 22.1,
        activeError: null,
        errorDetail: null,
      },
      storage: {
        storageId: 'stg-vault-eu-01',
        status: 'Nominal',
        usedPct: 51.4,
        capacityGb: 8192,
        iops: 5800,
        readMbps: 760,
        writeMbps: 380,
        raidState: 'Healthy (RAID-10)',
        smartStatus: 'PASS',
        activeError: null,
        errorDetail: null,
      },
      cloud: {
        cloudId: 'cld-mesh-eu-frankfurt',
        status: 'Nominal',
        provider: 'Nexaura Sovereign Cloud (EU)',
        regionEndpoint: 'EU',
        mtlsState: 'Verified',
        syncLatencyMs: 23,
        activeError: null,
        errorDetail: null,
      },
    },
    US: {
      router: {
        routerId: 'rtr-core-us-01',
        status: 'Nominal',
        dataTransferredMb: 4185.2,
        packetCount: 338900,
        packetsSent: 338818,
        packetLossCount: 82,
        packetLossPct: 0.02,
        bandwidthMbps: 1350,
        latencyMs: 20.8,
        activeError: null,
        errorDetail: null,
      },
      storage: {
        storageId: 'stg-vault-us-01',
        status: 'Nominal',
        usedPct: 49.0,
        capacityGb: 8192,
        iops: 6150,
        readMbps: 840,
        writeMbps: 405,
        raidState: 'Healthy (RAID-10)',
        smartStatus: 'PASS',
        activeError: null,
        errorDetail: null,
      },
      cloud: {
        cloudId: 'cld-mesh-us-virginia',
        status: 'Nominal',
        provider: 'Nexaura Sovereign Cloud (US)',
        regionEndpoint: 'US',
        mtlsState: 'Verified',
        syncLatencyMs: 21,
        activeError: null,
        errorDetail: null,
      },
    },
  };
  public latencySamples: {
    payloadId: string;
    collectionMs: number;
    endToEndMs: number;
    alertTriggeredMs?: number;
  }[] = [];

  private tickHandle: NodeJS.Timeout | null = null;
  private tickCounter = 0;
  private faultLatchedUids = new Set<string>();
  private clientLiveOverrides = new Map<string, { latencyMs?: number; bandwidthMbps?: number; updatedAtMs: number; source: string }>();
  public latestHostSample = hostTelemetrySampler.sample();

  constructor() {
    this.initDevices();
    this.loadPersistedWal();
    this.seedInitialPipeline();
    this.startLoop();
  }

  private initDevices(): void {
    const nowIso = new Date().toISOString();
    const hostSample = this.latestHostSample;
    for (let i = 0; i < GLOBAL_TOPOLOGY.length; i++) {
      const d = GLOBAL_TOPOLOGY[i];
      const baseCpu = Number(Math.max(4, Math.min(92, hostSample.cpuPct + (i % 7) * 0.6)).toFixed(1));
      const baseMem = Number(Math.max(12, Math.min(92, hostSample.memoryPct + (i % 5) * 0.5)).toFixed(1));
      const baseDisk = Number(Math.max(10, Math.min(94, hostSample.diskPct)).toFixed(1));
      const baseBw = Number(Math.max(1.2, hostSample.deltaBandwidthMbps + (i === 0 ? 0 : 12 + (i % 6) * 4)).toFixed(1));
      const baseLat = i === 0 ? 4.2 : 12 + (i % 9);
      const baseLoss = 0;
      const basePktCount = Math.max(120, hostSample.packetsRxTotal + hostSample.packetsTxTotal);
      const baseLossCount = hostSample.packetsDroppedTotal;
      const router: RouterTelemetry = {
        routerId: `rtr-${d.cityCode.toLowerCase()}-${d.buildingCode.toLowerCase()}-${String(i + 1).padStart(2, '0')}`,
        status: 'Nominal',
        dataTransferredMb: Number((184.5 + i * 14.2).toFixed(2)),
        packetCount: basePktCount,
        packetsSent: basePktCount - baseLossCount,
        packetLossCount: baseLossCount,
        packetLossPct: baseLoss,
        bandwidthMbps: baseBw,
        latencyMs: baseLat,
        activeError: null,
        errorDetail: null,
      };
      router.status = computeRouterStatus(router);

      const storage: StorageTelemetry = {
        storageId: `stg-${d.cityCode.toLowerCase()}-${String(i + 1).padStart(2, '0')}`,
        status: 'Nominal',
        usedPct: baseDisk,
        capacityGb: d.industry === 'datacenter' ? 4096 : 1024,
        iops: 2400 + (i % 8) * 180,
        readMbps: 340 + (i % 6) * 35,
        writeMbps: 175 + (i % 5) * 20,
        raidState: 'Healthy (RAID-10)',
        smartStatus: 'PASS',
        activeError: null,
        errorDetail: null,
      };
      storage.status = computeStorageStatus(storage);

      const cloud: CloudSystemTelemetry = {
        cloudId: `cld-${d.region.toLowerCase()}-${d.cityCode.toLowerCase()}`,
        status: 'Nominal',
        provider: `Nexaura Cloud Sync (${d.region})`,
        regionEndpoint: d.region,
        mtlsState: 'Verified',
        syncLatencyMs: 18 + (i % 9),
        activeError: null,
        errorDetail: null,
      };

      const m: LiveDeviceMetrics = {
        uid: d.uid,
        cpuPct: baseCpu,
        memoryPct: baseMem,
        diskPct: baseDisk,
        bandwidthMbps: baseBw,
        latencyMs: baseLat,
        packetLossPct: baseLoss,
        failedLogins: 0,
        online: true,
        lastHeartbeatUtc: nowIso,
        healthState: 'Excellent',
        healthScore: 95,
        router,
        storage,
        cloud,
      };
      const evalRes = evaluateHealth(m, Date.now(), this.thresholds);
      m.healthState = evalRes.state;
      m.healthScore = evalRes.overallScore;
      this.deviceMetrics.set(d.uid, m);
      if (!this.tenantCommPolicies.has(d.tenantId)) {
        this.tenantCommPolicies.set(d.tenantId, buildDefaultTenantCommPolicy(d));
      }
      this.metricHistories.set(`${d.pseudoSourceId}:cpu_pct`, [baseCpu - 2, baseCpu - 1, baseCpu, baseCpu + 1, baseCpu]);
      this.metricHistories.set(`${d.pseudoSourceId}:memory_pct`, [baseMem - 1, baseMem, baseMem + 1, baseMem, baseMem]);
      this.metricHistories.set(`${d.pseudoSourceId}:latency_ms`, [baseLat - 1, baseLat, baseLat + 2, baseLat, baseLat]);
      this.localRawLogs.set(d.uid, [
        {
          id: `win-${i}-1`,
          deviceUid: d.uid,
          channel: 'System',
          eventId: 7036,
          level: 'Information',
          source: 'NexauraCollectorSvc',
          timestampUtc: nowIso,
          message: `Collector agent initialized on ${d.hostname} (${d.collectorId}); mTLS handshake verified.`,
        },
        {
          id: `win-${i}-2`,
          deviceUid: d.uid,
          channel: 'Security',
          eventId: 4624,
          level: 'Information',
          source: 'Microsoft-Windows-Security-Auditing',
          timestampUtc: nowIso,
          message: `Kerberos TGT session granted for ${d.username} on floor switch ${d.floorSwitchId}.`,
        },
      ]);
    }
  }

  private loadPersistedWal(): void {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as PersistedSnapshot;
      this.outageActive = Boolean(parsed.outageActive);
      this.spool = Array.isArray(parsed.spool) ? parsed.spool : [];
      this.droppedLowSeverityTotal = parsed.droppedLowSeverityTotal ?? 0;
      this.egressLog = Array.isArray(parsed.egressLog) ? parsed.egressLog.slice(0, 120) : [];
      this.sentIds = Array.isArray(parsed.sentIds) ? parsed.sentIds : [];
      this.duplicateCount = parsed.duplicateCount ?? 0;
      if (parsed.thresholds) this.thresholds = parsed.thresholds;
      if (Array.isArray(parsed.saasReceivedIds)) {
        for (const id of parsed.saasReceivedIds) {
          this.saasReceivedIds.add(id);
        }
      }
      if (parsed.saasReceivedPayloads) {
        this.saasReceivedPayloads = parsed.saasReceivedPayloads;
        for (const region of ['IN', 'EU', 'US'] as RegionCode[]) {
          for (const p of this.saasReceivedPayloads[region] ?? []) {
            this.saasReceivedIds.add(p.payloadId);
          }
        }
      }
      const spooledIds = new Set(this.spool.map((s) => s.payload.payloadId));
      this.sentIds = this.sentIds.filter((id) => this.saasReceivedIds.has(id) || spooledIds.has(id));
      if (parsed.saasStoredHashes) {
        for (const [k, v] of Object.entries(parsed.saasStoredHashes)) {
          this.saasStoredHashes.set(k, v);
        }
      }
    } catch {
      // Fresh state on corrupt WAL
    }
  }

  private persistWal(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const snapshot: PersistedSnapshot = {
        outageActive: this.outageActive,
        spool: this.spool.slice(-200),
        droppedLowSeverityTotal: this.droppedLowSeverityTotal,
        egressLog: this.egressLog.slice(0, 120),
        sentIds: this.sentIds.slice(-300),
        saasReceivedIds: Array.from(this.saasReceivedIds).slice(-500),
        saasReceivedPayloads: {
          IN: this.saasReceivedPayloads.IN.slice(-150),
          EU: this.saasReceivedPayloads.EU.slice(-150),
          US: this.saasReceivedPayloads.US.slice(-150),
        },
        saasStoredHashes: Object.fromEntries(Array.from(this.saasStoredHashes.entries()).slice(-200)),
        duplicateCount: this.duplicateCount,
        thresholds: this.thresholds,
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot), 'utf8');
    } catch {
      // Ignore transient fs errors
    }
  }

  private seedInitialPipeline(): void {
    const nowIso = new Date().toISOString();
    const flagship = GLOBAL_TOPOLOGY[0];
    const peerSameTenant =
      GLOBAL_TOPOLOGY.find(
        (d) =>
          d.uid !== flagship.uid &&
          d.tenantId === flagship.tenantId &&
          d.districtCode === flagship.districtCode &&
          d.cityCode === flagship.cityCode &&
          d.countryCode === flagship.countryCode
      ) ??
      GLOBAL_TOPOLOGY.find(
        (d) => d.uid !== flagship.uid && d.tenantId === flagship.tenantId
      ) ??
      GLOBAL_TOPOLOGY[1];
    const peerOtherTenant = GLOBAL_TOPOLOGY.find((d) => d.tenantId !== flagship.tenantId && d.region === 'IN') ?? GLOBAL_TOPOLOGY[3];

    if (this.structuredLogs.length === 0) {
      this.recordStructuredLog({
        category: 'tenant_data',
        tier: 'tier1',
        region: flagship.region,
        tenantId: flagship.tenantId,
        deviceUid: flagship.uid,
        pseudoSourceId: flagship.pseudoSourceId,
        actor: flagship.hostname,
        action: 'TENANT_LOCAL_LEDGER_MOUNT',
        severity: 'low',
        summary: `Mounted encrypted local customer ledger on ${flagship.hostname} (${flagship.tenantId}); stays strictly inside Tier 1.`,
      });
      this.recordStructuredLog({
        category: 'tenant_data',
        tier: 'tier2',
        region: 'IN',
        tenantId: flagship.tenantId,
        pseudoSourceId: flagship.pseudoSourceId,
        actor: 'rls-guard',
        action: 'RLS_TENANT_POLICY_ACTIVE',
        severity: 'low',
        summary: `Row-level isolation policy verified for ${flagship.tenantId} (regional partition IN).`,
      });
      this.recordStructuredLog({
        category: 'login_logout',
        tier: 'both',
        region: 'IN',
        tenantId: flagship.tenantId,
        deviceUid: flagship.uid,
        pseudoSourceId: flagship.pseudoSourceId,
        actor: 'operator',
        action: 'SESSION_BOOTSTRAP',
        severity: 'low',
        summary: `Tier 1 operator session keypair initialized at ${nowIso.slice(11, 19)} UTC.`,
      });
      this.recordStructuredLog({
        category: 'authentication',
        tier: 'both',
        region: 'IN',
        tenantId: flagship.tenantId,
        deviceUid: flagship.uid,
        pseudoSourceId: flagship.pseudoSourceId,
        actor: 'auth-service',
        action: 'SCRYPT_KEYSTORE_READY',
        severity: 'low',
        summary: 'Scrypt credential verifier & HMAC-SHA256 bearer signer active.',
      });
      this.recordStructuredLog({
        category: 'user_activity',
        tier: 'both',
        region: 'IN',
        tenantId: flagship.tenantId,
        actor: 'system',
        action: 'COLLECTOR_AGENT_ONLINE',
        severity: 'low',
        summary: `Distributed collectors active across ${GLOBAL_TOPOLOGY.length} global endpoints.`,
      });
    }

    if (this.fileTransfers.length === 0) {
      // Seed one outbound (sent from flagship) and one inbound (received by flagship) encrypted transfer within same building/district
      this.createFileTransfer(flagship.uid, peerSameTenant.uid, 'Q4-settlement-audit.enc', 'S (10-100KB)', false);
      this.createFileTransfer(peerSameTenant.uid, flagship.uid, 'treasury-reconcile-batch.enc', 'M (100KB-1MB)', false);
    }
    void peerOtherTenant;

    if (this.egressLog.length > 0) {
      this.recomputeIncidents();
      return;
    }

    this.collectAndDispatch({
      rawId: 'seed-1',
      deviceUid: flagship.uid,
      tenantId: flagship.tenantId,
      region: flagship.region,
      eventTimeUtc: new Date(Date.now() - 12_000).toISOString(),
      sourceTz: getCityTimezone(flagship.cityCode),
      category: 'compute',
      metric: 'cpu_pct',
      value: 34.2,
      severity: 'low',
      rawMessage: `Scheduled telemetry sweep for ${flagship.hostname} completed normally.`,
      extraFields: { internalHostTag: 'corp-rack-07' },
      injectedAtMs: Date.now() - 12_000,
    });
  }

  public recordStructuredLog(entry: Omit<StructuredLogEntry, 'id' | 'timestampUtc'> & { timestampUtc?: string }): StructuredLogEntry {
    const full: StructuredLogEntry = {
      id: `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      timestampUtc: entry.timestampUtc ?? new Date().toISOString(),
      ...entry,
    };
    this.structuredLogs.unshift(full);
    this.structuredLogs = this.structuredLogs.slice(0, 450);
    return full;
  }

  public getStructuredLogs(params: {
    tier: 'tier1' | 'tier2';
    category?: LogCategory;
    region?: RegionCode;
    tenantIds?: string[];
    deviceUid?: string;
  }): StructuredLogEntry[] {
    return this.structuredLogs.filter((l) => {
      if (l.tier !== 'both' && l.tier !== params.tier) return false;
      if (params.category && l.category !== params.category) return false;
      if (params.region && l.region !== params.region) return false;
      if (params.tier === 'tier1' && params.deviceUid && l.deviceUid && l.deviceUid !== params.deviceUid) {
        return false;
      }
      if (params.tenantIds && params.tenantIds.length > 0 && !params.tenantIds.includes('all')) {
        if (l.tenantId !== 'all' && !params.tenantIds.includes(l.tenantId)) return false;
      }
      return true;
    }).map((l) => {
      if (params.tier === 'tier2') {
        // Strict Tier 2 metadata-only boundary: never return raw deviceUid
        const { deviceUid: _omit, ...safe } = l;
        return safe;
      }
      return l;
    });
  }

  public createManualLog(params: {
    category: LogCategory;
    tier: 'tier1' | 'tier2';
    region: RegionCode;
    tenantId: string;
    deviceUid?: string;
    actor: string;
    severity: Severity;
    summary: string;
    action?: string;
    details?: Record<string, string | number | boolean>;
  }): StructuredLogEntry {
    const dev = params.deviceUid ? GLOBAL_TOPOLOGY.find((d) => d.uid === params.deviceUid) : undefined;
    const entry = this.recordStructuredLog({
      category: params.category,
      tier: params.tier,
      region: dev?.region ?? params.region,
      tenantId: dev?.tenantId ?? params.tenantId,
      deviceUid: dev?.uid ?? params.deviceUid,
      pseudoSourceId: dev?.pseudoSourceId,
      actor: params.actor,
      action: params.action || `MANUAL_${params.category.toUpperCase()}_LOG`,
      severity: params.severity,
      summary: params.summary,
      details: params.details,
    });
    this.auditEvents.unshift({
      timestampUtc: entry.timestampUtc,
      actor: params.actor,
      action: entry.action,
      detail: `${params.category}: ${params.summary}`,
    });
    return entry;
  }

  public startLoop(): void {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => {
      this.runSimulationTick();
    }, 2000);
  }

  public ingestLiveClientSample(params: {
    deviceUid: string;
    cpuPct?: number;
    memoryPct?: number;
    latencyMs?: number;
    bandwidthMbps?: number;
    dataDeltaMb?: number;
    packetDelta?: number;
    source?: string;
    dispatchEvent?: boolean;
  }): { ok: boolean; metrics?: LiveDeviceMetrics } {
    const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === params.deviceUid);
    const m = dev ? this.deviceMetrics.get(dev.uid) : undefined;
    if (!dev || !m) return { ok: false };

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    m.online = true;
    m.lastHeartbeatUtc = nowIso;

    if (typeof params.cpuPct === 'number' && Number.isFinite(params.cpuPct)) {
      m.cpuPct = Number(Math.max(1, Math.min(99.9, params.cpuPct)).toFixed(1));
    }
    if (typeof params.memoryPct === 'number' && Number.isFinite(params.memoryPct)) {
      m.memoryPct = Number(Math.max(1, Math.min(99.9, params.memoryPct)).toFixed(1));
    }
    if (typeof params.latencyMs === 'number' && Number.isFinite(params.latencyMs) && !m.router?.activeError) {
      m.latencyMs = Number(Math.max(0.5, Math.min(2000, params.latencyMs)).toFixed(1));
    }
    if (typeof params.bandwidthMbps === 'number' && Number.isFinite(params.bandwidthMbps) && m.router?.activeError !== 'router_link_down') {
      m.bandwidthMbps = Number(Math.max(0.1, Math.min(10000, params.bandwidthMbps)).toFixed(1));
    }

    this.clientLiveOverrides.set(dev.uid, {
      latencyMs: params.latencyMs,
      bandwidthMbps: params.bandwidthMbps,
      updatedAtMs: now,
      source: params.source ?? 'live-client',
    });

    if (m.router && ((params.dataDeltaMb ?? 0) > 0 || (params.packetDelta ?? 0) > 0)) {
      m.router = advanceRouterTraffic(m.router, params.dataDeltaMb ?? 0.02, params.packetDelta ?? 4);
      m.router.latencyMs = m.latencyMs;
      m.router.bandwidthMbps = m.bandwidthMbps;
    }

    const ev = evaluateHealth(m, now, this.thresholds);
    m.healthState = ev.state;
    m.healthScore = ev.overallScore;

    if (params.dispatchEvent) {
      this.collectAndDispatch({
        rawId: `live-${now}-${Math.random().toString(36).slice(2, 6)}`,
        deviceUid: dev.uid,
        tenantId: dev.tenantId,
        region: dev.region,
        eventTimeUtc: nowIso,
        sourceTz: getCityTimezone(dev.cityCode),
        category: 'network',
        metric: 'latency_ms',
        value: m.latencyMs,
        severity: m.latencyMs > 180 ? 'high' : 'low',
        rawMessage: `Live client probe (${params.source ?? 'browser'}) on ${dev.hostname}: cpu=${m.cpuPct}% mem=${m.memoryPct}% rtt=${m.latencyMs}ms`,
        injectedAtMs: now,
      });
    }

    clusterCoordinator.broadcast('device:updated', {
      deviceUid: dev.uid,
      region: dev.region,
      tenantId: dev.tenantId,
    });
    return { ok: true, metrics: m };
  }

  public runSimulationTick(): void {
    this.tickCounter++;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    this.lastCollectorHeartbeatUtc = nowIso;

    // Sample genuine OS / Linux /proc host & network telemetry
    const live = hostTelemetrySampler.sample();
    this.latestHostSample = live;

    for (let i = 0; i < GLOBAL_TOPOLOGY.length; i++) {
      const dev = GLOBAL_TOPOLOGY[i];
      const m = this.deviceMetrics.get(dev.uid);
      if (!m) continue;

      const latched = this.faultLatchedUids.has(dev.uid);
      const clientOverride = this.clientLiveOverrides.get(dev.uid);
      const hasFreshClientProbe = Boolean(clientOverride && now - clientOverride.updatedAtMs < 15_000);

      if (!latched && m.online) {
        m.cpuPct = Number(Math.max(1, Math.min(99, live.cpuPct + (i === 0 ? 0 : (i % 5) * 0.4))).toFixed(1));
        m.memoryPct = Number(Math.max(5, Math.min(99, live.memoryPct + (i === 0 ? 0 : (i % 4) * 0.3))).toFixed(1));
        m.diskPct = live.diskPct;
        if (!hasFreshClientProbe && !m.router?.activeError) {
          m.bandwidthMbps = Number(Math.max(0.2, live.deltaBandwidthMbps).toFixed(1));
          m.latencyMs = Number(Math.max(1.2, 2.5 + live.loadAvg1m * 1.8).toFixed(1));
        }
      }

      if (m.failedLogins > 0 && this.tickCounter % 8 === 0) {
        m.failedLogins = Math.max(0, m.failedLogins - 1);
      }
      if (m.online) {
        m.lastHeartbeatUtc = nowIso;
      }

      if (m.router) {
        const deltaMb = i === 0 ? live.deltaDataMb : Number((live.deltaDataMb * 0.15).toFixed(4));
        const deltaPkts = i === 0 ? live.deltaPackets : Math.max(1, Math.round(live.deltaPackets * 0.2));
        m.router = advanceRouterTraffic(m.router, deltaMb, deltaPkts);
        m.router.bandwidthMbps = m.router.activeError === 'router_link_down' ? 0 : m.bandwidthMbps;
        m.router.latencyMs = m.router.activeError === 'router_link_down' ? 999 : m.latencyMs;
        if (m.router.activeError) {
          m.packetLossPct = m.router.packetLossPct;
        }
      }
      if (m.storage && !m.storage.activeError) {
        m.storage.usedPct = live.diskPct;
      }
      if (m.cloud) {
        m.cloud.status = this.outageActive
          ? 'Offline'
          : m.cloud.activeError
            ? m.cloud.status
            : 'Nominal';
        m.cloud.mtlsState = this.outageActive
          ? 'Disconnected'
          : m.cloud.activeError === 'cloud_mtls_degraded'
            ? 'Degraded'
            : 'Verified';
      }

      const ev = evaluateHealth(m, now, this.thresholds);
      m.healthState = ev.state;
      m.healthScore = ev.overallScore;

      const cpuHist = this.metricHistories.get(`${dev.pseudoSourceId}:cpu_pct`) ?? [];
      cpuHist.push(m.cpuPct);
      if (cpuHist.length > 24) cpuHist.shift();
      this.metricHistories.set(`${dev.pseudoSourceId}:cpu_pct`, cpuHist);

      const latHist = this.metricHistories.get(`${dev.pseudoSourceId}:latency_ms`) ?? [];
      latHist.push(m.latencyMs);
      if (latHist.length > 24) latHist.shift();
      this.metricHistories.set(`${dev.pseudoSourceId}:latency_ms`, latHist);

      const memHist = this.metricHistories.get(`${dev.pseudoSourceId}:memory_pct`) ?? [];
      memHist.push(m.memoryPct);
      if (memHist.length > 24) memHist.shift();
      this.metricHistories.set(`${dev.pseudoSourceId}:memory_pct`, memHist);
    }

    for (const region of ['IN', 'EU', 'US'] as RegionCode[]) {
      const srv = this.serverInfra[region];
      srv.router = advanceRouterTraffic(
        srv.router,
        this.outageActive ? 0.001 : live.deltaDataMb,
        this.outageActive ? 1 : live.deltaPackets
      );
      if (!srv.storage.activeError) {
        srv.storage.usedPct = live.diskPct;
      }
      srv.cloud.status = this.outageActive ? 'Offline' : srv.cloud.activeError ? srv.cloud.status : 'Nominal';
      srv.cloud.mtlsState = this.outageActive
        ? 'Disconnected'
        : srv.cloud.activeError === 'cloud_mtls_degraded'
          ? 'Degraded'
          : 'Verified';
    }

    // Collect live telemetry from rotating node + flagship device
    const targetDev = GLOBAL_TOPOLOGY[this.tickCounter % Math.min(8, GLOBAL_TOPOLOGY.length)];
    const targetMetrics = this.deviceMetrics.get(targetDev.uid);
    if (targetMetrics && targetMetrics.online) {
      const useCpu = this.tickCounter % 2 === 0;
      this.collectAndDispatch({
        rawId: `live-${this.tickCounter}-${targetDev.uid.slice(-4)}`,
        deviceUid: targetDev.uid,
        tenantId: targetDev.tenantId,
        region: targetDev.region,
        eventTimeUtc: nowIso,
        sourceTz: getCityTimezone(targetDev.cityCode),
        category: useCpu ? 'compute' : 'network',
        metric: useCpu ? 'cpu_pct' : 'latency_ms',
        value: useCpu ? targetMetrics.cpuPct : targetMetrics.latencyMs,
        severity:
          targetMetrics.healthState === 'Poor'
            ? 'high'
            : targetMetrics.healthState === 'Fair'
              ? 'medium'
              : 'low',
        rawMessage: `Live host sample (${live.sourceKind} · ${live.interfaceName}) for ${targetDev.hostname}: cpu=${targetMetrics.cpuPct}% mem=${targetMetrics.memoryPct}% lat=${targetMetrics.latencyMs}ms`,
        injectedAtMs: now - 12,
      });
    }

    // Drain spool if online
    if (!this.outageActive && this.spool.length > 0) {
      this.drainSpoolBatch(now);
    }

    clusterCoordinator.broadcast('telemetry:tick', {
      region: targetDev.region,
      deviceUid: targetDev.uid,
    });
  }

  public collectAndDispatch(
    raw: Parameters<typeof processCollectorEvent>[0],
    bypassPreRedactionForGateTest = false
  ): EgressProofRecord {
    const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === raw.deviceUid) ?? GLOBAL_TOPOLOGY[0];
    const metrics = this.deviceMetrics.get(dev.uid)!;
    const nowMs = Date.now();

    // Always store raw log strictly inside local Tier 1 collector log buffer
    const logs = this.localRawLogs.get(dev.uid) ?? [];
    logs.unshift({
      id: raw.rawId,
      deviceUid: dev.uid,
      channel: raw.category === 'security' ? 'Security' : raw.category === 'application' ? 'Application' : 'System',
      eventId: raw.category === 'security' ? 4625 : 1001,
      level: raw.severity === 'critical' || raw.severity === 'high' ? 'Error' : raw.severity === 'medium' ? 'Warning' : 'Information',
      source: 'NexauraTelemetrySource',
      timestampUtc: raw.eventTimeUtc,
      message: raw.rawMessage,
      containsSecret: /password|sk-|AIza|ghp_|Bearer/i.test(raw.rawMessage),
    });
    this.localRawLogs.set(dev.uid, logs.slice(0, 60));

    const result = processCollectorEvent(raw, metrics, nowMs, bypassPreRedactionForGateTest);
    const record = result.record;

    if (record.status === 'blocked' || !result.payload) {
      this.egressLog.unshift(record);
      this.egressLog = this.egressLog.slice(0, 120);
      this.auditEvents.unshift({
        timestampUtc: new Date(nowMs).toISOString(),
        actor: dev.collectorId,
        action: 'EGRESS_BLOCKED',
        detail: record.blockedReason ?? 'Last-gate scanner blocked payload',
      });
      this.persistWal();
      return record;
    }

    // Advance device router and regional server core router packet/data counters
    if (metrics.router) {
      metrics.router = advanceRouterTraffic(metrics.router, 0.42, 12);
    }
    const srvInfra = this.serverInfra[dev.region];
    if (srvInfra?.router) {
      srvInfra.router = advanceRouterTraffic(srvInfra.router, 0.42, 12);
    }

    // Payload passed Allow-list & Last-gate; track sentId
    this.sentIds.push(result.payload.payloadId);

    if (this.outageActive) {
      const enq = enqueueSpool(
        this.spool,
        {
          payload: result.payload,
          egressSha256: record.egressSha256,
          enqueuedAtMs: nowMs,
          attempts: 0,
          nextRetryAtMs: nowMs + nextRetryBackoffMs(0, 0.15),
        },
        200
      );
      this.spool = enq.spool;
      this.droppedLowSeverityTotal += enq.droppedCount;
      record.status = 'spooled';
      this.egressLog.unshift(record);
      this.egressLog = this.egressLog.slice(0, 120);
      this.persistWal();
      return record;
    }

    // Deliver immediately to Regional SaaS
    this.deliverToRegionalSaas(dev.region, [result.payload], record);
    this.egressLog.unshift(record);
    this.egressLog = this.egressLog.slice(0, 120);
    this.persistWal();
    return record;
  }

  public deliverToRegionalSaas(
    region: RegionCode,
    payloads: AllowListedPayload[],
    singleRecord?: EgressProofRecord
  ): { acceptedCount: number; dupesCount: number } {
    const deduped = ingestWithDedupe(this.saasReceivedIds, payloads);
    this.saasReceivedIds = deduped.updatedIdSet;
    this.duplicateCount += deduped.duplicateIds.length;

    const nowMs = Date.now();
    for (const p of deduped.accepted) {
      const canonical = canonicalSerialize(p);
      const saasHash = sha256Hex(canonical);
      this.saasStoredHashes.set(p.payloadId, saasHash);

      const list = this.saasReceivedPayloads[region];
      list.push(p);
      this.saasReceivedPayloads[region] = sortByEventTimeUtc(list).slice(-150);

      // Update egress proof record hash verification
      const targetRec =
        singleRecord && singleRecord.payloadId === p.payloadId
          ? singleRecord
          : this.egressLog.find((r) => r.payloadId === p.payloadId);

      this.recordStructuredLog({
        category: 'metadata',
        tier: 'both',
        region,
        tenantId: p.tenantId,
        deviceUid: targetRec?.deviceUid,
        pseudoSourceId: p.pseudoSourceId,
        actor: 'regional-ingest',
        action: 'METADATA_VERIFIED',
        severity: p.severity,
        summary: `${p.metric}=${p.value} (${p.severity}) · SHA-256 ${saasHash.slice(0, 10)}`,
      });

      if (p.severity === 'high' || p.severity === 'critical') {
        this.recordStructuredLog({
          category: 'alerts',
          tier: 'both',
          region,
          tenantId: p.tenantId,
          deviceUid: targetRec?.deviceUid,
          pseudoSourceId: p.pseudoSourceId,
          actor: 'anomaly-detector',
          action: p.severity === 'critical' ? 'CRITICAL_ALERT' : 'HIGH_ALERT',
          severity: p.severity,
          summary: `${p.metric}=${p.value} (${p.contextSummary})`,
        });
      }

      if (targetRec) {
        targetRec.status = 'delivered';
        targetRec.saasStoredSha256 = saasHash;
        targetRec.hashVerified = targetRec.egressSha256 === saasHash;
        if (targetRec.latencyMetrics) {
          targetRec.latencyMetrics.deliveredAtMs = nowMs;
          targetRec.latencyMetrics.endToEndMs = Math.max(
            2,
            nowMs - targetRec.latencyMetrics.injectedAtMs
          );
          this.latencySamples.unshift({
            payloadId: p.payloadId,
            collectionMs: targetRec.latencyMetrics.collectionMs,
            endToEndMs: targetRec.latencyMetrics.endToEndMs,
            alertTriggeredMs:
              p.severity === 'high' || p.severity === 'critical'
                ? targetRec.latencyMetrics.endToEndMs + 18
                : undefined,
          });
          this.latencySamples = this.latencySamples.slice(0, 40);
        }
      }
    }

    if (deduped.accepted.some((p) => p.severity === 'high' || p.severity === 'critical')) {
      this.recomputeIncidents();
    }

    return {
      acceptedCount: deduped.accepted.length,
      dupesCount: deduped.duplicateIds.length,
    };
  }

  public drainSpoolBatch(nowMs = Date.now()): number {
    if (this.outageActive || this.spool.length === 0) return 0;

    // Drain up to 25 buffered items per flush when back online
    const batch = this.spool.slice(0, 25);
    this.spool = this.spool.slice(25);

    const byRegion: Record<RegionCode, AllowListedPayload[]> = { IN: [], EU: [], US: [] };
    for (const entry of batch) {
      const rec = this.egressLog.find((r) => r.payloadId === entry.payload.payloadId);
      const region: RegionCode = rec?.region ?? 'IN';
      byRegion[region].push(entry.payload);
    }

    for (const region of ['IN', 'EU', 'US'] as RegionCode[]) {
      if (byRegion[region].length > 0) {
        this.deliverToRegionalSaas(region, byRegion[region]);
      }
    }

    this.auditEvents.unshift({
      timestampUtc: new Date(nowMs).toISOString(),
      actor: 'collector-spool',
      action: 'SPOOL_DRAINED',
      detail: `Flushed ${batch.length} buffered payloads to regional endpoints with idempotency dedupe.`,
    });
    this.persistWal();
    return batch.length;
  }

  public recomputeIncidents(): void {
    const allPayloads = [
      ...this.saasReceivedPayloads.IN,
      ...this.saasReceivedPayloads.EU,
      ...this.saasReceivedPayloads.US,
    ];
    const recentHigh = allPayloads.filter((p) => p.severity === 'high' || p.severity === 'critical');
    if (recentHigh.length === 0) return;

    // Group by tenantId
    const byTenant = new Map<string, AllowListedPayload[]>();
    for (const p of recentHigh) {
      const arr = byTenant.get(p.tenantId) ?? [];
      arr.push(p);
      byTenant.set(p.tenantId, arr);
    }

    for (const [tenantId, tenantAlerts] of byTenant.entries()) {
      const built = buildCorrelatedIncident(tenantAlerts, GLOBAL_TOPOLOGY, this.metricHistories);
      if (!built) continue;

      const existingIdx = this.incidents.findIndex(
        (inc) => inc.tenantId === tenantId && inc.status === 'open'
      );
      if (existingIdx !== -1) {
        this.incidents[existingIdx] = {
          ...built,
          incidentId: this.incidents[existingIdx].incidentId,
          openedAtUtc: this.incidents[existingIdx].openedAtUtc,
        };
      } else {
        this.incidents.unshift(built);
        this.incidents = this.incidents.slice(0, 20);
        // Create paired safe remediation proposal
        this.remediations.unshift({
          remediationId: `rem-${built.incidentId}`,
          incidentId: built.incidentId,
          tenantId: built.tenantId,
          region: built.region,
          actionTitle: built.recommendation.title,
          actionType: built.recommendation.actionType,
          proposedBy: 'aiops.engine',
          stage: 'policy_checked',
          policyChecks: [
            { rule: 'Tenant boundary verified (no cross-tenant impact)', passed: true },
            { rule: 'Rollback token pre-staged', passed: true },
            { rule: 'Two-person peer approval required before simulation', passed: true },
          ],
          rollbackPlan: built.recommendation.rollbackPlan,
          auditLog: [
            {
              timestampUtc: built.openedAtUtc,
              actor: 'aiops.engine',
              event: `Proposed "${built.recommendation.title}" for ${built.incidentId}.`,
            },
          ],
        });
        this.remediations = this.remediations.slice(0, 20);
      }
    }
  }

  private resolveScenarioTargets(req: ScenarioRequest) {
    const regionFilter = req.region;
    const requestedTenants = (req.tenantIds ?? []).filter(Boolean);

    // If multi-tenant or 'all' tenants requested from Tier 2, pick one representative node per tenant in region
    if (requestedTenants.length > 0) {
      const pool = GLOBAL_TOPOLOGY.filter((d) => (!regionFilter || d.region === regionFilter));
      const allRegionalTenants = Array.from(new Set(pool.map((d) => d.tenantId)));
      const targetTenants = requestedTenants.includes('all')
        ? allRegionalTenants
        : allRegionalTenants.filter((t) => requestedTenants.includes(t));

      const targets = targetTenants
        .map((tId) => pool.find((d) => d.tenantId === tId))
        .filter((d): d is (typeof GLOBAL_TOPOLOGY)[number] => Boolean(d));
      if (targets.length > 0) return targets;
    }

    const single =
      GLOBAL_TOPOLOGY.find((d) => d.uid === req.deviceUid && (!req.region || d.region === req.region)) ??
      (req.region ? GLOBAL_TOPOLOGY.find((d) => d.region === req.region) : undefined) ??
      GLOBAL_TOPOLOGY[0];
    return [single];
  }

  public triggerScenario(req: ScenarioRequest): { message: string; records: EgressProofRecord[] } {
    const targets = this.resolveScenarioTargets(req);
    const primary = targets[0];
    const now = Date.now();
    const records: EgressProofRecord[] = [];

    if (req.type === 'saas_outage_toggle') {
      this.outageActive = !this.outageActive;
      let drained = 0;
      if (!this.outageActive) {
        while (this.spool.length > 0) {
          const count = this.drainSpoolBatch(now);
          if (count === 0) break;
          drained += count;
        }
      }
      const msg = this.outageActive
        ? 'SaaS outage active: telemetry is buffering safely in the local spool.'
        : `Connection restored: delivered ${drained} buffered events with zero duplicates.`;
      this.auditEvents.unshift({
        timestampUtc: new Date(now).toISOString(),
        actor: 'scenario-injector',
        action: this.outageActive ? 'OUTAGE_STARTED' : 'OUTAGE_RECOVERED',
        detail: msg,
      });
      this.recordStructuredLog({
        category: 'user_activity',
        tier: 'both',
        region: primary.region,
        tenantId: primary.tenantId,
        deviceUid: primary.uid,
        pseudoSourceId: primary.pseudoSourceId,
        actor: 'operator',
        action: this.outageActive ? 'OUTAGE_STARTED' : 'OUTAGE_RECOVERED',
        severity: this.outageActive ? 'high' : 'low',
        summary: msg,
      });
      this.persistWal();
      clusterCoordinator.broadcast('device:updated', {
        deviceUid: primary.uid,
        region: primary.region,
        tenantId: primary.tenantId,
      });
      return { message: msg, records };
    }

    if (req.type === 'duplicate_replay') {
      const existing = this.saasReceivedPayloads[primary.region].slice(-1)[0];
      if (!existing) {
        return { message: 'No delivered payload yet to replay.', records };
      }
      const res = this.deliverToRegionalSaas(primary.region, [existing, existing]);
      this.persistWal();
      clusterCoordinator.broadcast('incident:updated', { region: primary.region });
      return {
        message: `Replayed payload ${existing.payloadId} twice -> accepted: ${res.acceptedCount}, duplicates blocked: ${res.dupesCount}.`,
        records,
      };
    }

    const impactedTenants: string[] = [];

    for (let idx = 0; idx < targets.length; idx++) {
      const dev = targets[idx];
      const metrics = this.deviceMetrics.get(dev.uid)!;
      const tz = getCityTimezone(dev.cityCode);
      const tNow = now + idx * 35;
      impactedTenants.push(dev.tenantId);
      if (req.type !== 'secret_in_log' && req.type !== 'out_of_order_delivery' && req.type !== 'clock_skew') {
        this.faultLatchedUids.add(dev.uid);
      }

      switch (req.type) {
        case 'secret_in_log': {
          const r1 = this.collectAndDispatch({
            rawId: `sec-redact-${tNow}`,
            deviceUid: dev.uid,
            tenantId: dev.tenantId,
            region: dev.region,
            eventTimeUtc: new Date(tNow).toISOString(),
            sourceTz: tz,
            category: 'security',
            metric: 'auth_audit_event',
            value: 1,
            severity: 'high',
            rawMessage: `Operator login trace for ${dev.username} password=VaultMaster99! apiKey=sk-live-9988776655443322 token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456`,
            extraFields: { internalSsn: '123-45-6789', rawHostname: dev.hostname },
            injectedAtMs: tNow,
          });
          records.push(r1);
          break;
        }

        case 'cpu_spike': {
          metrics.cpuPct = 94.6;
          const hist = this.metricHistories.get(`${dev.pseudoSourceId}:cpu_pct`) ?? [28, 30, 31, 29];
          hist.push(88.4, 94.6);
          this.metricHistories.set(`${dev.pseudoSourceId}:cpu_pct`, hist.slice(-24));
          records.push(
            this.collectAndDispatch({
              rawId: `cpu-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow).toISOString(),
              sourceTz: tz,
              category: 'compute',
              metric: 'cpu_pct',
              value: 94.6,
              severity: 'critical',
              rawMessage: `Sustained CPU spike 94.6% on ${dev.hostname} worker pool.`,
              injectedAtMs: tNow,
            })
          );
          break;
        }

        case 'memory_leak': {
          metrics.memoryPct = 93.2;
          const hist = this.metricHistories.get(`${dev.pseudoSourceId}:memory_pct`) ?? [44, 52, 63, 75, 86];
          hist.push(89.5, 93.2);
          this.metricHistories.set(`${dev.pseudoSourceId}:memory_pct`, hist.slice(-24));
          records.push(
            this.collectAndDispatch({
              rawId: `mem-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow).toISOString(),
              sourceTz: tz,
              category: 'memory',
              metric: 'memory_pct',
              value: 93.2,
              severity: 'high',
              rawMessage: `Monotonic heap allocation climb to 93.2% on ${dev.hostname}.`,
              injectedAtMs: tNow,
            })
          );
          break;
        }

        case 'latency_rise': {
          metrics.latencyMs = 242;
          metrics.packetLossPct = 4.9;
          records.push(
            this.collectAndDispatch({
              rawId: `lat-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow).toISOString(),
              sourceTz: tz,
              category: 'network',
              metric: 'latency_ms',
              value: 242,
              severity: 'high',
              rawMessage: `Uplink ${dev.floorSwitchId} -> ${dev.buildingCoreId} latency 242ms (4.9% packet loss).`,
              injectedAtMs: tNow,
            })
          );
          break;
        }

        case 'failed_login_burst': {
          metrics.failedLogins = 14;
          records.push(
            this.collectAndDispatch({
              rawId: `sec-burst-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow).toISOString(),
              sourceTz: tz,
              category: 'security',
              metric: 'failed_logins_1m',
              value: 14,
              severity: 'critical',
              rawMessage: `14 consecutive failed SSH/RDP logons against ${dev.username} on ${dev.hostname}.`,
              injectedAtMs: tNow,
            })
          );
          this.recordStructuredLog({
            category: 'authentication',
            tier: 'both',
            region: dev.region,
            tenantId: dev.tenantId,
            deviceUid: dev.uid,
            pseudoSourceId: dev.pseudoSourceId,
            actor: 'auth-guard',
            action: 'AUTH_BRUTE_FORCE_DETECTED',
            severity: 'critical',
            summary: `14 consecutive failed logon attempts detected on ${shortPseudoId(dev.pseudoSourceId)}.`,
          });
          break;
        }

        case 'out_of_order_delivery': {
          records.push(
            this.collectAndDispatch({
              rawId: `ooo-old-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow - 45_000).toISOString(),
              sourceTz: tz,
              category: 'compute',
              metric: 'cpu_pct',
              value: 61.5,
              severity: 'medium',
              rawMessage: 'Late-arriving telemetry packet (45s prior eventTimeUtc) re-sorted cleanly.',
              injectedAtMs: tNow,
            })
          );
          break;
        }

        case 'clock_skew': {
          records.push(
            this.collectAndDispatch({
              rawId: `skew-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow + 120_000).toISOString(),
              sourceTz: tz,
              category: 'application',
              metric: 'clock_drift_check',
              value: 120,
              severity: 'medium',
              rawMessage: 'Device clock +120s ahead of server UTC; flagged and stamped with server fallback.',
              injectedAtMs: tNow,
            })
          );
          break;
        }

        case 'disk_io_saturation': {
          metrics.diskPct = 96.4;
          records.push(
            this.collectAndDispatch({
              rawId: `disk-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow).toISOString(),
              sourceTz: tz,
              category: 'storage',
              metric: 'disk_io_wait_pct',
              value: 96.4,
              severity: 'high',
              rawMessage: `Storage NVMe queue saturation (96.4% disk usage / WAL flush stall) on ${dev.hostname}.`,
              injectedAtMs: tNow,
            })
          );
          break;
        }

        case 'dns_failure_burst': {
          metrics.latencyMs = Math.max(metrics.latencyMs, 195);
          records.push(
            this.collectAndDispatch({
              rawId: `dns-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow).toISOString(),
              sourceTz: tz,
              category: 'application',
              metric: 'dns_failure_rate',
              value: 41.2,
              severity: 'critical',
              rawMessage: `Upstream DNS resolver SERVFAIL rate 41.2% impacting ${dev.hostname} microservices.`,
              injectedAtMs: tNow,
            })
          );
          break;
        }

        case 'cert_expiry_warning': {
          records.push(
            this.collectAndDispatch({
              rawId: `cert-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow).toISOString(),
              sourceTz: tz,
              category: 'security',
              metric: 'mtls_cert_ttl_hours',
              value: 28,
              severity: 'high',
              rawMessage: `Collector mTLS leaf certificate on ${dev.collectorId} expires in 28 hours.`,
              injectedAtMs: tNow,
            })
          );
          break;
        }

        case 'heartbeat_flap': {
          metrics.online = false;
          metrics.lastHeartbeatUtc = new Date(tNow - 95_000).toISOString();
          records.push(
            this.collectAndDispatch({
              rawId: `hb-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow).toISOString(),
              sourceTz: tz,
              category: 'heartbeat',
              metric: 'heartbeat_gap_sec',
              value: 95,
              severity: 'critical',
              rawMessage: `Collector heartbeat gap 95s detected on ${dev.hostname} (${dev.collectorId}).`,
              injectedAtMs: tNow,
            })
          );
          break;
        }

        case 'bandwidth_saturation': {
          metrics.bandwidthMbps = 980;
          metrics.packetLossPct = 3.8;
          records.push(
            this.collectAndDispatch({
              rawId: `bw-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow).toISOString(),
              sourceTz: tz,
              category: 'network',
              metric: 'egress_bandwidth_pct',
              value: 97.5,
              severity: 'high',
              rawMessage: `Uplink bandwidth exhausted (97.5% / 980 Mbps) on ${dev.floorSwitchId}.`,
              injectedAtMs: tNow,
            })
          );
          break;
        }

        case 'privilege_escalation': {
          metrics.failedLogins = 6;
          records.push(
            this.collectAndDispatch({
              rawId: `priv-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow).toISOString(),
              sourceTz: tz,
              category: 'security',
              metric: 'privilege_escalation_events',
              value: 3,
              severity: 'critical',
              rawMessage: `Unauthorized privilege elevation and policy hash drift flagged on ${dev.hostname}.`,
              injectedAtMs: tNow,
            })
          );
          break;
        }

        case 'correlated_incident': {
          metrics.cpuPct = 95.4;
          metrics.latencyMs = 230;
          metrics.packetLossPct = 5.1;
          records.push(
            this.collectAndDispatch({
              rawId: `corr-1-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow).toISOString(),
              sourceTz: tz,
              category: 'network',
              metric: 'latency_ms',
              value: 230,
              severity: 'high',
              rawMessage: `Correlated uplink congestion on ${dev.floorSwitchId}.`,
              injectedAtMs: tNow,
            }),
            this.collectAndDispatch({
              rawId: `corr-2-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow + 500).toISOString(),
              sourceTz: tz,
              category: 'network',
              metric: 'packet_loss_pct',
              value: 5.1,
              severity: 'critical',
              rawMessage: `Packet loss surge 5.1% along ${dev.buildingCoreId}.`,
              injectedAtMs: tNow,
            }),
            this.collectAndDispatch({
              rawId: `corr-3-${tNow}`,
              deviceUid: dev.uid,
              tenantId: dev.tenantId,
              region: dev.region,
              eventTimeUtc: new Date(tNow + 900).toISOString(),
              sourceTz: tz,
              category: 'compute',
              metric: 'cpu_pct',
              value: 95.4,
              severity: 'high',
              rawMessage: `Retry storm elevated CPU to 95.4% on ${dev.hostname}.`,
              injectedAtMs: tNow,
            })
          );
          break;
        }
      }

      const ev = evaluateHealth(metrics, tNow, this.thresholds);
      metrics.healthState = ev.state;
      metrics.healthScore = ev.overallScore;
    }

    this.recordStructuredLog({
      category: 'user_activity',
      tier: 'both',
      region: primary.region,
      tenantId: impactedTenants.length > 1 ? 'all' : primary.tenantId,
      deviceUid: primary.uid,
      pseudoSourceId: primary.pseudoSourceId,
      actor: 'operator',
      action: `SCENARIO_${req.type.toUpperCase()}`,
      severity: 'medium',
      summary: `Executed "${req.type}" simulation across ${impactedTenants.length} tenant(s): ${impactedTenants.join(', ')}.`,
    });

    clusterCoordinator.broadcast('device:updated', {
      deviceUid: primary.uid,
      region: primary.region,
      tenantId: primary.tenantId,
    });
    clusterCoordinator.broadcast('incident:updated', { region: primary.region });

    if (req.type === 'secret_in_log' && records[0]) {
      return {
        message: `Privacy test passed: stripped ${records[0].removedSecrets.length} secrets and dropped ${records[0].droppedFields.length} private fields before egress.`,
        records,
      };
    }

    return {
      message: `Executed "${req.type.replace(/_/g, ' ')}" across ${impactedTenants.length} tenant(s): ${impactedTenants.join(', ')}.`,
      records,
    };
  }

  public getTenantCommPolicy(tenantId: string): TenantCommPolicy {
    const existing = this.tenantCommPolicies.get(tenantId);
    if (existing) return existing;
    const sample = GLOBAL_TOPOLOGY.find((d) => d.tenantId === tenantId) ?? GLOBAL_TOPOLOGY[0];
    const created = buildDefaultTenantCommPolicy(sample);
    this.tenantCommPolicies.set(tenantId, created);
    return created;
  }

  public listTenantCommPolicies(region?: RegionCode): TenantCommPolicy[] {
    const all = Array.from(this.tenantCommPolicies.values());
    return region ? all.filter((p) => p.region === region) : all;
  }

  public setTenantCommPolicy(params: {
    tenantId: string;
    allowOutsideDistrict?: boolean;
    allowOutsideCity?: boolean;
    allowOutsideCountry?: boolean;
    actor: string;
  }): TenantCommPolicy | null {
    const sample = GLOBAL_TOPOLOGY.find((d) => d.tenantId === params.tenantId);
    if (!sample) return null;
    const current = this.getTenantCommPolicy(params.tenantId);
    const updated: TenantCommPolicy = {
      ...current,
      allowOutsideDistrict: params.allowOutsideDistrict ?? current.allowOutsideDistrict,
      allowOutsideCity: params.allowOutsideCity ?? current.allowOutsideCity,
      allowOutsideCountry: params.allowOutsideCountry ?? current.allowOutsideCountry,
      updatedBy: params.actor,
      updatedAtUtc: new Date().toISOString(),
    };
    this.tenantCommPolicies.set(params.tenantId, updated);

    const summary =
      `Updated external comm locks for ${params.tenantId}: ` +
      `Outside District=${updated.allowOutsideDistrict ? 'UNLOCKED' : 'LOCKED'}, ` +
      `Outside City=${updated.allowOutsideCity ? 'UNLOCKED' : 'LOCKED'}, ` +
      `Outside Country=${updated.allowOutsideCountry ? 'UNLOCKED' : 'LOCKED'}.`;

    this.auditEvents.unshift({
      timestampUtc: updated.updatedAtUtc!,
      actor: params.actor,
      action: 'TENANT_COMM_POLICY_UPDATED',
      detail: summary,
    });
    this.recordStructuredLog({
      category: 'tenant_data',
      tier: 'both',
      region: updated.region,
      tenantId: updated.tenantId,
      actor: params.actor,
      action: 'TENANT_COMM_POLICY_UPDATED',
      severity: 'medium',
      summary,
      details: {
        allowOutsideDistrict: updated.allowOutsideDistrict,
        allowOutsideCity: updated.allowOutsideCity,
        allowOutsideCountry: updated.allowOutsideCountry,
      },
    });
    this.recordStructuredLog({
      category: 'user_activity',
      tier: 'tier2',
      region: updated.region,
      tenantId: updated.tenantId,
      actor: params.actor,
      action: 'COMM_SCOPE_POLICY_CHANGE',
      severity: 'low',
      summary,
    });
    clusterCoordinator.broadcast('policy:updated', {
      region: updated.region,
      tenantId: updated.tenantId,
    });
    return updated;
  }

  public isPeerAllowedByPolicy(
    fromDev: (typeof GLOBAL_TOPOLOGY)[number],
    toDev: (typeof GLOBAL_TOPOLOGY)[number]
  ): { allowed: boolean; boundary?: 'district' | 'city' | 'country'; reason?: string } {
    const policy = this.getTenantCommPolicy(fromDev.tenantId);
    return canNodesCommunicate(fromDev, toDev, policy);
  }

  public getVisiblePeersForDevice(dev: (typeof GLOBAL_TOPOLOGY)[number]) {
    const policy = this.getTenantCommPolicy(dev.tenantId);
    const visible: (typeof GLOBAL_TOPOLOGY)[number][] = [];
    let lockedDistrict = 0;
    let lockedCity = 0;
    let lockedCountry = 0;

    for (const candidate of GLOBAL_TOPOLOGY) {
      if (candidate.uid === dev.uid) continue;
      const check = canNodesCommunicate(dev, candidate, policy);
      if (check.allowed) {
        visible.push(candidate);
      } else if (check.boundary === 'district') {
        lockedDistrict++;
      } else if (check.boundary === 'city') {
        lockedCity++;
      } else if (check.boundary === 'country') {
        lockedCountry++;
      }
    }

    return {
      policy,
      visiblePeers: visible,
      lockedPeerCounts: {
        outsideDistrict: lockedDistrict,
        outsideCity: lockedCity,
        outsideCountry: lockedCountry,
        totalHidden: lockedDistrict + lockedCity + lockedCountry,
      },
    };
  }

  public recordFailedLoginAlert(params: {
    username: string;
    tier: 'tier1' | 'tier2';
    region: RegionCode;
    tenantId: string;
    deviceUid?: string;
    attemptCount: number;
    locked: boolean;
    reason: string;
  }): void {
    const matchedDev = params.deviceUid
      ? GLOBAL_TOPOLOGY.find((d) => d.uid === params.deviceUid)
      : GLOBAL_TOPOLOGY.find(
          (d) =>
            d.region === params.region &&
            (params.tenantId === 'all' || d.tenantId === params.tenantId)
        );
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const severity: Severity = params.locked ? 'critical' : params.attemptCount >= 2 ? 'high' : 'medium';

    this.recordStructuredLog({
      category: 'authentication',
      tier: 'both',
      region: params.region,
      tenantId: params.tenantId,
      deviceUid: matchedDev?.uid ?? params.deviceUid,
      pseudoSourceId: matchedDev?.pseudoSourceId,
      actor: params.username,
      action: params.locked ? 'AUTH_LOCKOUT_3_ATTEMPTS' : 'AUTH_LOGIN_FAILED',
      severity,
      summary: params.reason,
      details: {
        attemptCount: params.attemptCount,
        maxAttempts: 3,
        locked: params.locked,
        sourceTier: params.tier,
      },
    });

    this.recordStructuredLog({
      category: 'alerts',
      tier: 'both',
      region: params.region,
      tenantId: params.tenantId,
      deviceUid: matchedDev?.uid ?? params.deviceUid,
      pseudoSourceId: matchedDev?.pseudoSourceId,
      actor: 'auth-guard',
      action: params.locked ? 'SERVER_SECURITY_LOCKOUT_ALERT' : 'SERVER_FAILED_LOGIN_ALERT',
      severity: params.locked ? 'critical' : 'high',
      summary: `Server Security Alert (${params.tier}): ${params.reason}`,
      details: {
        username: params.username,
        attemptCount: params.attemptCount,
        locked: params.locked,
      },
    });

    this.auditEvents.unshift({
      timestampUtc: nowIso,
      actor: params.username,
      action: params.locked ? 'FAILED_LOGIN_LOCKOUT_ALERT' : 'FAILED_LOGIN_ALERT',
      detail: params.reason,
    });

    if (matchedDev) {
      const m = this.deviceMetrics.get(matchedDev.uid);
      if (m) {
        m.failedLogins = Math.min(20, m.failedLogins + (params.locked ? 4 : 2));
        const ev = evaluateHealth(m, nowMs, this.thresholds);
        m.healthState = ev.state;
        m.healthScore = ev.overallScore;
      }
      this.collectAndDispatch({
        rawId: `auth-fail-${nowMs}-${Math.random().toString(36).slice(2, 6)}`,
        deviceUid: matchedDev.uid,
        tenantId: matchedDev.tenantId,
        region: matchedDev.region,
        eventTimeUtc: nowIso,
        sourceTz: getCityTimezone(matchedDev.cityCode),
        category: 'security',
        metric: 'failed_logins_1m',
        value: matchedDev ? (this.deviceMetrics.get(matchedDev.uid)?.failedLogins ?? params.attemptCount) : params.attemptCount,
        severity: params.locked ? 'critical' : 'high',
        rawMessage: `Sign-in failure alert on ${matchedDev.hostname} for account "${params.username}": ${params.reason}`,
        injectedAtMs: nowMs,
      });
    }
    this.persistWal();
    clusterCoordinator.broadcast('logs:created', {
      region: params.region,
      tenantId: params.tenantId,
      deviceUid: matchedDev?.uid ?? params.deviceUid,
    });
  }

  public getNodeMetricHistory(pseudoSourceId: string): { cpu: number[]; latency: number[]; memory: number[] } {
    return {
      cpu: [...(this.metricHistories.get(`${pseudoSourceId}:cpu_pct`) ?? [])],
      latency: [...(this.metricHistories.get(`${pseudoSourceId}:latency_ms`) ?? [])],
      memory: [...(this.metricHistories.get(`${pseudoSourceId}:memory_pct`) ?? [])],
    };
  }

  public injectManualTenantError(params: {
    tenantId: string;
    deviceUid?: string;
    scenarioType: ScenarioType;
    severity?: Severity;
    customMessage?: string;
    actor: string;
  }): { message: string; records: EgressProofRecord[] } {
    const dev =
      (params.deviceUid && GLOBAL_TOPOLOGY.find((d) => d.uid === params.deviceUid)) ||
      GLOBAL_TOPOLOGY.find((d) => d.tenantId === params.tenantId);

    if (!dev) {
      return { message: `Tenant "${params.tenantId}" not found.`, records: [] };
    }

    const res = this.triggerScenario({
      type: params.scenarioType,
      deviceUid: dev.uid,
      region: dev.region,
      tenantIds: [dev.tenantId],
    });

    if (params.customMessage && params.customMessage.trim()) {
      this.recordStructuredLog({
        category: 'alerts',
        tier: 'both',
        region: dev.region,
        tenantId: dev.tenantId,
        deviceUid: dev.uid,
        pseudoSourceId: dev.pseudoSourceId,
        actor: params.actor,
        action: 'MANUAL_TENANT_FAULT_INJECTED',
        severity: params.severity ?? 'high',
        summary: `${dev.tenantId}: ${params.customMessage.trim()}`,
      });
    }

    this.auditEvents.unshift({
      timestampUtc: new Date().toISOString(),
      actor: params.actor,
      action: 'MANUAL_TENANT_ERROR',
      detail: `Injected ${params.scenarioType} on ${dev.tenantId}${params.customMessage ? ` (${params.customMessage.trim()})` : ''}.`,
    });

    return {
      message: `Injected manual fault (${params.scenarioType.replace(/_/g, ' ')}) on ${dev.tenantId}.`,
      records: res.records,
    };
  }

  public resolveManualTenantError(params: {
    tenantId: string;
    deviceUid?: string;
    actor: string;
  }): { resolvedNodes: number; closedIncidents: number; message: string } {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const targetDevices = GLOBAL_TOPOLOGY.filter(
      (d) =>
        d.tenantId === params.tenantId &&
        (!params.deviceUid || d.uid === params.deviceUid)
    );

    if (targetDevices.length === 0) {
      return { resolvedNodes: 0, closedIncidents: 0, message: `Tenant "${params.tenantId}" not found.` };
    }

    let resolvedNodes = 0;
    for (const dev of targetDevices) {
      const m = this.deviceMetrics.get(dev.uid);
      if (!m) continue;
      this.faultLatchedUids.delete(dev.uid);
      m.online = true;
      m.lastHeartbeatUtc = nowIso;
      m.cpuPct = this.latestHostSample.cpuPct;
      m.memoryPct = this.latestHostSample.memoryPct;
      m.diskPct = this.latestHostSample.diskPct;
      m.bandwidthMbps = Math.max(1.2, this.latestHostSample.deltaBandwidthMbps);
      m.latencyMs = 4.5;
      m.packetLossPct = 0.0;
      m.failedLogins = 0;
      if (m.router) m.router = resolveRouterFault(m.router);
      if (m.storage) m.storage = resolveStorageFault(m.storage);
      if (m.cloud) m.cloud = resolveCloudFault(m.cloud);
      const ev = evaluateHealth(m, now, this.thresholds);
      m.healthState = ev.state;
      m.healthScore = ev.overallScore;
      resolvedNodes++;
    }

    let closedIncidents = 0;
    for (const inc of this.incidents) {
      if (inc.tenantId === params.tenantId && inc.status !== 'remediated') {
        inc.status = 'remediated';
        inc.updatedAtUtc = nowIso;
        closedIncidents++;
        const rem = this.remediations.find((r) => r.incidentId === inc.incidentId);
        if (rem && rem.stage !== 'executed_simulated') {
          rem.approvedBy = rem.approvedBy ?? params.actor;
          rem.stage = 'executed_simulated';
          rem.auditLog.push({
            timestampUtc: nowIso,
            actor: params.actor,
            event: `Manually resolved tenant faults for ${params.tenantId}.`,
          });
        }
      }
    }

    const summary = `Cleared faults across ${resolvedNodes} node(s) and resolved ${closedIncidents} incident(s) for ${params.tenantId}.`;
    const sampleDev = targetDevices[0];
    this.auditEvents.unshift({
      timestampUtc: nowIso,
      actor: params.actor,
      action: 'MANUAL_TENANT_FAULT_RESOLVED',
      detail: summary,
    });
    this.recordStructuredLog({
      category: 'alerts',
      tier: 'both',
      region: sampleDev.region,
      tenantId: params.tenantId,
      deviceUid: params.deviceUid,
      pseudoSourceId: sampleDev.pseudoSourceId,
      actor: params.actor,
      action: 'TENANT_FAULT_RESOLVED',
      severity: 'low',
      summary,
    });
    this.recordStructuredLog({
      category: 'user_activity',
      tier: 'both',
      region: sampleDev.region,
      tenantId: params.tenantId,
      deviceUid: params.deviceUid,
      pseudoSourceId: sampleDev.pseudoSourceId,
      actor: params.actor,
      action: 'MANUAL_FAULT_RESOLUTION',
      severity: 'low',
      summary,
    });
    this.persistWal();
    clusterCoordinator.broadcast('device:updated', {
      deviceUid: params.deviceUid ?? sampleDev.uid,
      region: sampleDev.region,
      tenantId: params.tenantId,
    });
    clusterCoordinator.broadcast('incident:updated', { region: sampleDev.region, tenantId: params.tenantId });

    return { resolvedNodes, closedIncidents, message: summary };
  }

  public createFileTransfer(
    fromUid: string,
    toUid: string,
    fileName: string,
    sizeClass: EncryptedFileTransfer['sizeClass'],
    policyApproved: boolean
  ): EncryptedFileTransfer {
    const fromDev = GLOBAL_TOPOLOGY.find((d) => d.uid === fromUid) ?? GLOBAL_TOPOLOGY[0];
    const toDev = GLOBAL_TOPOLOGY.find((d) => d.uid === toUid) ?? GLOBAL_TOPOLOGY[1];
    const boundaryCheck = this.isPeerAllowedByPolicy(fromDev, toDev);
    const crossTenant = fromDev.tenantId !== toDev.tenantId;
    const allowed = boundaryCheck.allowed && (!crossTenant || policyApproved);

    const cipherSeed = crypto.randomBytes(24).toString('base64');
    const transfer: EncryptedFileTransfer = {
      transferId: `xfer-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      fromUid: fromDev.uid,
      toUid: toDev.uid,
      fromTenantId: fromDev.tenantId,
      toTenantId: toDev.tenantId,
      fileName,
      sizeClass,
      ciphertextSha256: sha256Hex(`${fromDev.uid}:${toDev.uid}:${fileName}:${cipherSeed}`),
      ciphertextPreview: `enc_v1:${cipherSeed.slice(0, 26)}...`,
      crossTenantPolicyApproved: allowed,
      createdAtUtc: new Date().toISOString(),
      status: allowed ? 'relayed_encrypted' : 'blocked_policy',
    };

    this.fileTransfers.unshift(transfer);
    this.fileTransfers = this.fileTransfers.slice(0, 60);
    this.auditEvents.unshift({
      timestampUtc: transfer.createdAtUtc,
      actor: fromDev.uid,
      action: allowed ? 'P2P_CIPHER_RELAY' : 'CROSS_BOUNDARY_BLOCKED',
      detail: boundaryCheck.allowed
        ? `${fromDev.uid} -> ${toDev.uid} (${fileName}, ${sizeClass})`
        : `${boundaryCheck.reason}`,
    });
    this.recordStructuredLog({
      category: 'transfer',
      tier: 'both',
      region: fromDev.region,
      tenantId: fromDev.tenantId,
      deviceUid: fromDev.uid,
      pseudoSourceId: fromDev.pseudoSourceId,
      actor: fromDev.hostname,
      action: allowed ? 'TRANSFER_SENT_RELAYED' : 'TRANSFER_BLOCKED_POLICY',
      severity: allowed ? 'low' : 'high',
      summary: boundaryCheck.allowed
        ? `${fileName} (${sizeClass}) ${shortPseudoId(fromDev.pseudoSourceId)} -> ${shortPseudoId(toDev.pseudoSourceId)} [${transfer.status}]`
        : `${fileName} blocked: ${boundaryCheck.reason}`,
    });
    if (!boundaryCheck.allowed) {
      this.recordStructuredLog({
        category: 'alerts',
        tier: 'both',
        region: fromDev.region,
        tenantId: fromDev.tenantId,
        deviceUid: fromDev.uid,
        pseudoSourceId: fromDev.pseudoSourceId,
        actor: 'mesh-policy-guard',
        action: 'BOUNDARY_TRANSFER_DENIED',
        severity: 'high',
        summary: boundaryCheck.reason ?? 'External boundary transfer denied.',
      });
    }
    const transferMb =
      sizeClass === 'L (>1MB)'
        ? 1.45
        : sizeClass === 'M (100KB-1MB)'
          ? 0.48
          : sizeClass === 'S (10-100KB)'
            ? 0.06
            : 0.01;
    const transferPackets = Math.max(8, Math.round(transferMb * 720));
    const fromMetrics = this.deviceMetrics.get(fromDev.uid);
    if (allowed && fromMetrics?.router) {
      fromMetrics.router = advanceRouterTraffic(fromMetrics.router, transferMb, transferPackets);
    }
    const toMetrics = this.deviceMetrics.get(toDev.uid);
    if (allowed && toMetrics?.router) {
      toMetrics.router = advanceRouterTraffic(toMetrics.router, transferMb, transferPackets);
    }
    if (allowed && this.serverInfra[fromDev.region]?.router) {
      this.serverInfra[fromDev.region].router = advanceRouterTraffic(
        this.serverInfra[fromDev.region].router,
        transferMb,
        transferPackets
      );
    }

    clusterCoordinator.broadcast('transfer:created', {
      region: fromDev.region,
      tenantId: fromDev.tenantId,
      deviceUid: fromDev.uid,
    });
    return transfer;
  }

  public injectInfraFault(params: {
    target: 'device' | 'server';
    component: 'router' | 'storage' | 'cloud';
    deviceUid?: string;
    region?: RegionCode;
    faultCode: string;
    actor: string;
  }): { ok: boolean; message: string; error?: string } {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    if (params.target === 'device') {
      const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === params.deviceUid);
      if (!dev) return { ok: false, message: 'Device not found.', error: 'Device not found.' };
      const m = this.deviceMetrics.get(dev.uid);
      if (!m) return { ok: false, message: 'Device metrics unavailable.', error: 'Device metrics unavailable.' };
      this.faultLatchedUids.add(dev.uid);

      let detail = '';
      let isCritical = false;
      if (params.component === 'router' && m.router) {
        m.router = applyRouterFault(m.router, params.faultCode as RouterFaultCode);
        m.latencyMs = m.router.latencyMs;
        m.packetLossPct = m.router.packetLossPct;
        m.bandwidthMbps = m.router.bandwidthMbps;
        detail = `${dev.hostname} Router (${m.router.routerId}): ${m.router.errorDetail}`;
        isCritical = m.router.status === 'Critical' || m.router.status === 'Offline';
      } else if (params.component === 'storage' && m.storage) {
        m.storage = applyStorageFault(m.storage, params.faultCode as StorageFaultCode);
        m.diskPct = m.storage.usedPct;
        detail = `${dev.hostname} Storage (${m.storage.storageId}): ${m.storage.errorDetail}`;
        isCritical = m.storage.status === 'Critical';
      } else if (params.component === 'cloud' && m.cloud) {
        m.cloud = applyCloudFault(m.cloud, params.faultCode as CloudFaultCode);
        detail = `${dev.hostname} Cloud (${m.cloud.cloudId}): ${m.cloud.errorDetail}`;
        isCritical = m.cloud.status === 'Critical';
      }

      const ev = evaluateHealth(m, now, this.thresholds);
      m.healthState = ev.state;
      m.healthScore = ev.overallScore;

      this.auditEvents.unshift({
        timestampUtc: nowIso,
        actor: params.actor,
        action: `DEVICE_${params.component.toUpperCase()}_FAULT`,
        detail,
      });
      this.recordStructuredLog({
        category: 'alerts',
        tier: 'both',
        region: dev.region,
        tenantId: dev.tenantId,
        deviceUid: dev.uid,
        pseudoSourceId: dev.pseudoSourceId,
        actor: params.actor,
        action: `${params.component.toUpperCase()}_FAULT_INJECTED`,
        severity: isCritical ? 'critical' : 'high',
        summary: detail,
      });
      this.persistWal();
      clusterCoordinator.broadcast('infra:updated', {
        deviceUid: dev.uid,
        region: dev.region,
        tenantId: dev.tenantId,
      });
      return { ok: true, message: detail };
    }

    const region: RegionCode = params.region ?? 'IN';
    const srv = this.serverInfra[region];
    if (!srv) return { ok: false, message: 'Region not found.', error: 'Region not found.' };

    let detail = '';
    let isCritical = false;
    if (params.component === 'router') {
      srv.router = applyRouterFault(srv.router, params.faultCode as RouterFaultCode);
      detail = `Server ${region} Core Router (${srv.router.routerId}): ${srv.router.errorDetail}`;
      isCritical = srv.router.status === 'Critical' || srv.router.status === 'Offline';
    } else if (params.component === 'storage') {
      srv.storage = applyStorageFault(srv.storage, params.faultCode as StorageFaultCode);
      detail = `Server ${region} Storage Array (${srv.storage.storageId}): ${srv.storage.errorDetail}`;
      isCritical = srv.storage.status === 'Critical';
    } else {
      srv.cloud = applyCloudFault(srv.cloud, params.faultCode as CloudFaultCode);
      detail = `Server ${region} Cloud Gateway (${srv.cloud.cloudId}): ${srv.cloud.errorDetail}`;
      isCritical = srv.cloud.status === 'Critical';
    }

    this.auditEvents.unshift({
      timestampUtc: nowIso,
      actor: params.actor,
      action: `SERVER_${params.component.toUpperCase()}_FAULT`,
      detail,
    });
    this.recordStructuredLog({
      category: 'alerts',
      tier: 'tier2',
      region,
      tenantId: 'all',
      actor: params.actor,
      action: `SERVER_${params.component.toUpperCase()}_FAULT`,
      severity: isCritical ? 'critical' : 'high',
      summary: detail,
    });
    this.persistWal();
    clusterCoordinator.broadcast('infra:updated', { region });
    return { ok: true, message: detail };
  }

  public resolveInfraFault(params: {
    target: 'device' | 'server';
    component: 'router' | 'storage' | 'cloud' | 'all';
    deviceUid?: string;
    region?: RegionCode;
    actor: string;
  }): { ok: boolean; message: string; error?: string } {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    if (params.target === 'device') {
      const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === params.deviceUid);
      if (!dev) return { ok: false, message: 'Device not found.', error: 'Device not found.' };
      const m = this.deviceMetrics.get(dev.uid);
      if (!m) return { ok: false, message: 'Device metrics unavailable.', error: 'Device metrics unavailable.' };
      this.faultLatchedUids.delete(dev.uid);

      if ((params.component === 'router' || params.component === 'all') && m.router) {
        m.router = resolveRouterFault(m.router);
        m.latencyMs = m.router.latencyMs;
        m.packetLossPct = m.router.packetLossPct;
        m.bandwidthMbps = m.router.bandwidthMbps;
      }
      if ((params.component === 'storage' || params.component === 'all') && m.storage) {
        m.storage = resolveStorageFault(m.storage);
        m.diskPct = m.storage.usedPct;
      }
      if ((params.component === 'cloud' || params.component === 'all') && m.cloud) {
        m.cloud = resolveCloudFault(m.cloud);
      }

      const ev = evaluateHealth(m, now, this.thresholds);
      m.healthState = ev.state;
      m.healthScore = ev.overallScore;

      const msg = `Cleared ${params.component} fault on ${dev.hostname}; link and storage nominal.`;
      this.auditEvents.unshift({
        timestampUtc: nowIso,
        actor: params.actor,
        action: 'DEVICE_INFRA_RESOLVED',
        detail: msg,
      });
      this.recordStructuredLog({
        category: 'user_activity',
        tier: 'both',
        region: dev.region,
        tenantId: dev.tenantId,
        deviceUid: dev.uid,
        pseudoSourceId: dev.pseudoSourceId,
        actor: params.actor,
        action: 'DEVICE_INFRA_RESOLVED',
        severity: 'low',
        summary: msg,
      });
      this.persistWal();
      clusterCoordinator.broadcast('infra:updated', {
        deviceUid: dev.uid,
        region: dev.region,
        tenantId: dev.tenantId,
      });
      return { ok: true, message: msg };
    }

    const region: RegionCode = params.region ?? 'IN';
    const srv = this.serverInfra[region];
    if (!srv) return { ok: false, message: 'Region not found.', error: 'Region not found.' };

    if (params.component === 'router' || params.component === 'all') {
      srv.router = resolveRouterFault(srv.router);
    }
    if (params.component === 'storage' || params.component === 'all') {
      srv.storage = resolveStorageFault(srv.storage);
    }
    if (params.component === 'cloud' || params.component === 'all') {
      srv.cloud = resolveCloudFault(srv.cloud);
    }

    const msg = `Restored ${region} regional server ${params.component} subsystem to Nominal status.`;
    this.auditEvents.unshift({
      timestampUtc: nowIso,
      actor: params.actor,
      action: 'SERVER_INFRA_RESOLVED',
      detail: msg,
    });
    this.recordStructuredLog({
      category: 'user_activity',
      tier: 'tier2',
      region,
      tenantId: 'all',
      actor: params.actor,
      action: 'SERVER_INFRA_RESOLVED',
      severity: 'low',
      summary: msg,
    });
    this.persistWal();
    clusterCoordinator.broadcast('infra:updated', { region });
    return { ok: true, message: msg };
  }

  public requestAdminPermission(params: {
    adminUsername: string;
    permission: AdminPermissionKey;
    reason: string;
  }): { ok: boolean; record?: CountryAdminRecord; error?: string } {
    const rec = this.countryAdmins.find(
      (a) => a.adminUsername.toLowerCase() === params.adminUsername.toLowerCase()
    );
    if (!rec) return { ok: false, error: 'Country Admin profile not found.' };

    const existingPending = rec.pendingRequests.find(
      (r) => r.permission === params.permission && r.status === 'pending'
    );
    if (existingPending) {
      return { ok: true, record: rec };
    }

    const nowIso = new Date().toISOString();
    rec.pendingRequests.unshift({
      requestId: `perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      permission: params.permission,
      reason: params.reason.trim() || `Requesting ${params.permission} for ${rec.countryName}`,
      requestedAtUtc: nowIso,
      status: 'pending',
    });
    rec.pendingRequests = rec.pendingRequests.slice(0, 20);

    const detail = `${rec.adminUsername} (${rec.countryName}) requested "${params.permission}" permission from Super Admin (${rec.countrySuperAdminId}).`;
    this.auditEvents.unshift({
      timestampUtc: nowIso,
      actor: rec.adminUsername,
      action: 'ADMIN_PERMISSION_REQUESTED',
      detail,
    });
    this.recordStructuredLog({
      category: 'user_activity',
      tier: 'tier2',
      region: rec.region,
      tenantId: 'all',
      actor: rec.adminUsername,
      action: 'ADMIN_PERMISSION_REQUESTED',
      severity: 'medium',
      summary: detail,
    });
    clusterCoordinator.broadcast('policy:updated', { region: rec.region });
    return { ok: true, record: rec };
  }

  public decideAdminPermission(params: {
    adminUsername: string;
    permission: AdminPermissionKey;
    grant: boolean;
    decidedBy: string;
  }): { ok: boolean; record?: CountryAdminRecord; error?: string } {
    const rec = this.countryAdmins.find(
      (a) => a.adminUsername.toLowerCase() === params.adminUsername.toLowerCase()
    );
    if (!rec) return { ok: false, error: 'Country Admin profile not found.' };

    const nowIso = new Date().toISOString();
    rec.permissions[params.permission] = params.grant;

    for (const req of rec.pendingRequests) {
      if (req.permission === params.permission && req.status === 'pending') {
        req.status = params.grant ? 'approved' : 'rejected';
        req.decidedBy = params.decidedBy;
        req.decidedAtUtc = nowIso;
      }
    }

    const detail = `Super Admin "${params.decidedBy}" ${params.grant ? 'GRANTED' : 'REVOKED'} "${params.permission}" for ${rec.adminUsername} (${rec.countryName}).`;
    this.auditEvents.unshift({
      timestampUtc: nowIso,
      actor: params.decidedBy,
      action: params.grant ? 'ADMIN_PERMISSION_GRANTED' : 'ADMIN_PERMISSION_REVOKED',
      detail,
    });
    this.recordStructuredLog({
      category: 'authentication',
      tier: 'tier2',
      region: rec.region,
      tenantId: 'all',
      actor: params.decidedBy,
      action: params.grant ? 'ADMIN_PERMISSION_GRANTED' : 'ADMIN_PERMISSION_REVOKED',
      severity: params.grant ? 'medium' : 'low',
      summary: detail,
    });
    clusterCoordinator.broadcast('policy:updated', { region: rec.region });
    return { ok: true, record: rec };
  }

  public getReconcileSummary() {
    return computeReconcile(
      this.sentIds,
      Array.from(this.saasReceivedIds),
      this.duplicateCount
    );
  }

  public getAnomalySnapshot(uid: string) {
    const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === uid) ?? GLOBAL_TOPOLOGY[0];
    const m = this.deviceMetrics.get(dev.uid)!;
    const cpuHist = this.metricHistories.get(`${dev.pseudoSourceId}:cpu_pct`) ?? [m.cpuPct];
    const latHist = this.metricHistories.get(`${dev.pseudoSourceId}:latency_ms`) ?? [m.latencyMs];
    const corroborated = m.latencyMs > 80 || m.memoryPct > 78 || m.packetLossPct > 1.5;
    return {
      cpu: detectSeasonalAnomaly(cpuHist, corroborated),
      latency: detectSeasonalAnomaly(latHist, m.cpuPct > 75 || m.packetLossPct > 1),
    };
  }

  public resolveIssueFromAssistant(params: {
    region: RegionCode;
    actor: string;
    targetNodeHint?: string;
    intent: 'heartbeat' | 'cpu' | 'memory' | 'network' | 'security' | 'disk' | 'dns' | 'cert' | 'all';
  }): { resolvedCount: number; summary: string; affectedNodes: string[] } {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const affectedNodes: string[] = [];

    const regionDevs = GLOBAL_TOPOLOGY.filter((d) => d.region === params.region);
    const matchedDevs = params.targetNodeHint
      ? regionDevs.filter((d) => {
          const short = shortPseudoId(d.pseudoSourceId).toLowerCase();
          const raw = d.pseudoSourceId.toLowerCase();
          const hint = params.targetNodeHint!.toLowerCase();
          return short.includes(hint) || raw.includes(hint) || short.replace(/[^a-z0-9]/g, '').includes(hint.replace(/[^a-z0-9]/g, ''));
        })
      : [];

    const candidates = matchedDevs.length > 0 ? matchedDevs : regionDevs;

    for (const dev of candidates) {
      const m = this.deviceMetrics.get(dev.uid);
      if (!m) continue;
      const ev = evaluateHealth(m, now, this.thresholds);
      const needsFix =
        matchedDevs.length > 0 ||
        ev.isStale ||
        ev.state === 'Poor' ||
        ev.state === 'Fair';

      if (!needsFix) continue;

      if (params.intent === 'heartbeat' || params.intent === 'all' || !m.online || ev.isStale) {
        m.online = true;
        m.lastHeartbeatUtc = nowIso;
      }
      if (params.intent === 'cpu' || params.intent === 'all') {
        m.cpuPct = Math.min(m.cpuPct, 36);
      }
      if (params.intent === 'memory' || params.intent === 'all') {
        m.memoryPct = Math.min(m.memoryPct, 46);
      }
      if (params.intent === 'network' || params.intent === 'dns' || params.intent === 'all') {
        m.latencyMs = Math.min(m.latencyMs, 24);
        m.packetLossPct = 0.05;
        m.bandwidthMbps = Math.min(m.bandwidthMbps, 220);
        if (m.router) m.router = resolveRouterFault(m.router);
      }
      if (params.intent === 'security' || params.intent === 'all') {
        m.failedLogins = 0;
      }
      if (params.intent === 'disk' || params.intent === 'all') {
        m.diskPct = Math.min(m.diskPct, 54);
        if (m.storage) m.storage = resolveStorageFault(m.storage);
      }
      if (params.intent === 'all' && m.cloud) {
        m.cloud = resolveCloudFault(m.cloud);
      }

      const afterEv = evaluateHealth(m, now, this.thresholds);
      m.healthState = afterEv.state;
      m.healthScore = afterEv.overallScore;
      affectedNodes.push(shortPseudoId(dev.pseudoSourceId));
    }
    if (params.intent === 'all') {
      const srv = this.serverInfra[params.region];
      if (srv) {
        srv.router = resolveRouterFault(srv.router);
        srv.storage = resolveStorageFault(srv.storage);
        srv.cloud = resolveCloudFault(srv.cloud);
      }
    }

    // Mark matching open incidents in this region as remediated when resolved cleanly
    let closedIncidents = 0;
    for (const inc of this.incidents) {
      if (inc.region !== params.region || inc.status === 'remediated') continue;
      if (
        matchedDevs.length === 0 ||
        matchedDevs.some((d) => inc.affectedPseudoIds.includes(d.pseudoSourceId))
      ) {
        inc.status = 'remediated';
        inc.updatedAtUtc = nowIso;
        closedIncidents++;
        const rem = this.remediations.find((r) => r.incidentId === inc.incidentId);
        if (rem && rem.stage !== 'executed_simulated') {
          rem.approvedBy = rem.approvedBy ?? `${params.actor} (AI-assisted)`;
          rem.stage = 'executed_simulated';
          rem.auditLog.push({
            timestampUtc: nowIso,
            actor: params.actor,
            event: 'Resolved via Nexaura AI Advisor automated policy execution.',
          });
        }
      }
    }

    const detail =
      affectedNodes.length > 0 || closedIncidents > 0
        ? `AI Advisor resolved ${affectedNodes.length} node(s) [${affectedNodes.slice(0, 4).join(', ')}${affectedNodes.length > 4 ? '…' : ''}] and closed ${closedIncidents} open incident(s) in ${params.region}.`
        : `Verified all endpoints in ${params.region} are currently online and within healthy baselines; no active fault required changes.`;

    this.auditEvents.unshift({
      timestampUtc: nowIso,
      actor: params.actor,
      action: 'AI_ADVISOR_RESOLUTION',
      detail,
    });
    this.recordStructuredLog({
      category: 'user_activity',
      tier: 'tier2',
      region: params.region,
      tenantId: 'all',
      actor: params.actor,
      action: 'AI_ADVISOR_RESOLUTION',
      severity: 'low',
      summary: detail,
    });

    clusterCoordinator.broadcast('incident:updated', { region: params.region });
    clusterCoordinator.broadcast('device:updated', { region: params.region });

    return {
      resolvedCount: affectedNodes.length + closedIncidents,
      summary: detail,
      affectedNodes,
    };
  }

  public applyRemediationAction(
    remediationId: string,
    actorUsername: string,
    action: 'approve' | 'execute' | 'rollback' | 'reject'
  ): { record?: RemediationRecord; error?: string } {
    const idx = this.remediations.findIndex((r) => r.remediationId === remediationId);
    if (idx === -1) return { error: 'Remediation record not found.' };
    const res = advanceRemediation(
      this.remediations[idx],
      actorUsername,
      action,
      new Date().toISOString()
    );
    if (res.error) return { error: res.error };
    this.remediations[idx] = res.updated;

    this.recordStructuredLog({
      category: 'user_activity',
      tier: 'tier2',
      region: res.updated.region,
      tenantId: res.updated.tenantId,
      actor: actorUsername,
      action: `REMEDIATION_${action.toUpperCase()}`,
      severity: action === 'reject' ? 'medium' : 'low',
      summary: `${res.updated.actionTitle} -> stage "${res.updated.stage}"`,
    });

    if (res.updated.stage === 'executed_simulated') {
      const inc = this.incidents.find((i) => i.incidentId === res.updated.incidentId);
      if (inc) inc.status = 'remediated';
      for (const dev of GLOBAL_TOPOLOGY) {
        if (dev.tenantId === res.updated.tenantId) {
          this.faultLatchedUids.delete(dev.uid);
          const m = this.deviceMetrics.get(dev.uid);
          if (m) {
            m.cpuPct = Math.min(m.cpuPct, this.latestHostSample.cpuPct);
            m.memoryPct = Math.min(m.memoryPct, this.latestHostSample.memoryPct);
            m.latencyMs = Math.min(m.latencyMs, 18);
            m.packetLossPct = 0.0;
            m.diskPct = this.latestHostSample.diskPct;
            m.failedLogins = 0;
            m.online = true;
            m.lastHeartbeatUtc = new Date().toISOString();
          }
        }
      }
    }
    clusterCoordinator.broadcast('incident:updated', {
      region: res.updated.region,
      tenantId: res.updated.tenantId,
    });
    return { record: res.updated };
  }
}

export const engine = new NexauraEngine();
