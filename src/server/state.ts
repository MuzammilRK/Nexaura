import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DEFAULT_HEALTH_THRESHOLDS,
  type AllowListedPayload,
  type EgressProofRecord,
  type EncryptedFileTransfer,
  type HealthThresholds,
  type Incident,
  type LiveDeviceMetrics,
  type LogCategory,
  type RegionCode,
  type RemediationRecord,
  type ScenarioRequest,
  type Severity,
  type SpoolEntry,
  type StructuredLogEntry,
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
import { processCollectorEvent } from '../core/pipeline';
import { canonicalSerialize, sha256Hex } from '../core/redactor';
import {
  computeReconcile,
  enqueueSpool,
  ingestWithDedupe,
  nextRetryBackoffMs,
  sortByEventTimeUtc,
} from '../core/spool';

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
  public latencySamples: {
    payloadId: string;
    collectionMs: number;
    endToEndMs: number;
    alertTriggeredMs?: number;
  }[] = [];

  private tickHandle: NodeJS.Timeout | null = null;
  private tickCounter = 0;

  constructor() {
    this.initDevices();
    this.loadPersistedWal();
    this.seedInitialPipeline();
    this.startLoop();
  }

  private initDevices(): void {
    const nowIso = new Date().toISOString();
    for (let i = 0; i < GLOBAL_TOPOLOGY.length; i++) {
      const d = GLOBAL_TOPOLOGY[i];
      const baseCpu = 24 + ((i * 7) % 34);
      const baseMem = 36 + ((i * 11) % 32);
      const baseLat = d.region === 'IN' ? 18 + (i % 15) : d.region === 'EU' ? 24 + (i % 18) : 21 + (i % 16);
      const m: LiveDeviceMetrics = {
        uid: d.uid,
        cpuPct: baseCpu,
        memoryPct: baseMem,
        diskPct: 42 + ((i * 5) % 30),
        bandwidthMbps: 110 + ((i * 13) % 240),
        latencyMs: baseLat,
        packetLossPct: Number(((i % 5) * 0.08).toFixed(2)),
        failedLogins: 0,
        online: true,
        lastHeartbeatUtc: nowIso,
        healthState: 'Excellent',
        healthScore: 95,
      };
      const evalRes = evaluateHealth(m, Date.now(), this.thresholds);
      m.healthState = evalRes.state;
      m.healthScore = evalRes.overallScore;
      this.deviceMetrics.set(d.uid, m);
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
    const peerSameTenant = GLOBAL_TOPOLOGY.find((d) => d.uid !== flagship.uid && d.tenantId === flagship.tenantId) ?? GLOBAL_TOPOLOGY[1];
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
      // Seed one outbound (sent from flagship) and two inbound (received by flagship) encrypted transfers
      this.createFileTransfer(flagship.uid, peerSameTenant.uid, 'Q4-settlement-audit.enc', 'S (10-100KB)', false);
      this.createFileTransfer(peerSameTenant.uid, flagship.uid, 'treasury-reconcile-batch.enc', 'M (100KB-1MB)', false);
      this.createFileTransfer(peerOtherTenant.uid, flagship.uid, 'interop-compliance-pack.enc', 'S (10-100KB)', true);
    }

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
    }, 3500);
  }

  public runSimulationTick(): void {
    this.tickCounter++;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    this.lastCollectorHeartbeatUtc = nowIso;

    // Advance metrics gently for all devices
    for (let i = 0; i < GLOBAL_TOPOLOGY.length; i++) {
      const dev = GLOBAL_TOPOLOGY[i];
      const m = this.deviceMetrics.get(dev.uid);
      if (!m) continue;

      const jitter = Math.sin((this.tickCounter + i) * 0.7) * 2.8;
      m.cpuPct = Number(Math.max(8, Math.min(99, m.cpuPct * 0.88 + (28 + (i % 25) + jitter) * 0.12)).toFixed(1));
      m.memoryPct = Number(Math.max(18, Math.min(99, m.memoryPct * 0.92 + (42 + (i % 22) + jitter * 0.5) * 0.08)).toFixed(1));
      m.latencyMs = Number(Math.max(8, Math.min(450, m.latencyMs * 0.85 + (20 + (i % 16) + Math.abs(jitter) * 1.4) * 0.15)).toFixed(1));
      if (m.failedLogins > 0 && this.tickCounter % 5 === 0) {
        m.failedLogins = Math.max(0, m.failedLogins - 1);
      }
      if (m.online) {
        m.lastHeartbeatUtc = nowIso;
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
    }

    // Collect telemetry from a rotating device + flagship device
    const targetDev = GLOBAL_TOPOLOGY[this.tickCounter % Math.min(8, GLOBAL_TOPOLOGY.length)];
    const targetMetrics = this.deviceMetrics.get(targetDev.uid);
    if (targetMetrics && targetMetrics.online) {
      this.collectAndDispatch({
        rawId: `sim-${this.tickCounter}-${targetDev.uid.slice(-4)}`,
        deviceUid: targetDev.uid,
        tenantId: targetDev.tenantId,
        region: targetDev.region,
        eventTimeUtc: nowIso,
        sourceTz: getCityTimezone(targetDev.cityCode),
        category: this.tickCounter % 2 === 0 ? 'compute' : 'network',
        metric: this.tickCounter % 2 === 0 ? 'cpu_pct' : 'latency_ms',
        value: this.tickCounter % 2 === 0 ? targetMetrics.cpuPct : targetMetrics.latencyMs,
        severity:
          targetMetrics.healthState === 'Poor'
            ? 'high'
            : targetMetrics.healthState === 'Fair'
              ? 'medium'
              : 'low',
        rawMessage: `Periodic collector sample from ${targetDev.hostname}: cpu=${targetMetrics.cpuPct}% lat=${targetMetrics.latencyMs}ms`,
        injectedAtMs: now - 40,
      });
    }

    // Drain spool if online
    if (!this.outageActive && this.spool.length > 0) {
      this.drainSpoolBatch(now);
    }
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
      return { message: msg, records };
    }

    if (req.type === 'duplicate_replay') {
      const existing = this.saasReceivedPayloads[primary.region].slice(-1)[0];
      if (!existing) {
        return { message: 'No delivered payload yet to replay.', records };
      }
      const res = this.deliverToRegionalSaas(primary.region, [existing, existing]);
      this.persistWal();
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

  public createFileTransfer(
    fromUid: string,
    toUid: string,
    fileName: string,
    sizeClass: EncryptedFileTransfer['sizeClass'],
    policyApproved: boolean
  ): EncryptedFileTransfer {
    const fromDev = GLOBAL_TOPOLOGY.find((d) => d.uid === fromUid) ?? GLOBAL_TOPOLOGY[0];
    const toDev = GLOBAL_TOPOLOGY.find((d) => d.uid === toUid) ?? GLOBAL_TOPOLOGY[1];
    const crossTenant = fromDev.tenantId !== toDev.tenantId;
    const allowed = !crossTenant || policyApproved;

    const cipherSeed = crypto.randomBytes(24).toString('base64');
    const transfer: EncryptedFileTransfer = {
      transferId: `xfer-${Date.now().toString(36)}`,
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
      action: allowed ? 'P2P_CIPHER_RELAY' : 'CROSS_TENANT_BLOCKED',
      detail: `${fromDev.uid} -> ${toDev.uid} (${fileName}, ${sizeClass})`,
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
      summary: `${fileName} (${sizeClass}) ${shortPseudoId(fromDev.pseudoSourceId)} -> ${shortPseudoId(toDev.pseudoSourceId)} [${transfer.status}]`,
    });
    return transfer;
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
      }
      if (params.intent === 'security' || params.intent === 'all') {
        m.failedLogins = 0;
      }
      if (params.intent === 'disk' || params.intent === 'all') {
        m.diskPct = Math.min(m.diskPct, 54);
      }

      const afterEv = evaluateHealth(m, now, this.thresholds);
      m.healthState = afterEv.state;
      m.healthScore = afterEv.overallScore;
      affectedNodes.push(shortPseudoId(dev.pseudoSourceId));
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
          const m = this.deviceMetrics.get(dev.uid);
          if (m) {
            m.cpuPct = Math.min(m.cpuPct, 38);
            m.memoryPct = Math.min(m.memoryPct, 48);
            m.latencyMs = Math.min(m.latencyMs, 26);
            m.packetLossPct = 0.05;
            m.diskPct = Math.min(m.diskPct, 55);
            m.failedLogins = 0;
            m.online = true;
            m.lastHeartbeatUtc = new Date().toISOString();
          }
        }
      }
    }
    return { record: res.updated };
  }
}

export const engine = new NexauraEngine();
