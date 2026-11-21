import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { createServer as createViteServer } from 'vite';
import { z } from 'zod';
import type { LogCategory, RegionCode, ScenarioRequest, Severity } from './src/shared/schema';
import { GLOBAL_TOPOLOGY, getCityTimezone } from './src/shared/topology';
import {
  authenticateUser,
  recordLogout,
  requireAuth,
  verifyToken,
  type AuthenticatedRequest,
} from './src/server/auth';
import { askAIOpsAssistant, enhanceRecommendationWording } from './src/server/llm';
import { engine } from './src/server/state';
import { evaluateHealth } from './src/core/aiops';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'nexaura-platform', timeUtc: new Date().toISOString() });
});

// Public topology for 3D Entry World (UIDs and coordinates stay in world shell; no raw logs)
app.get('/api/world/topology', (_req, res) => {
  const devices = GLOBAL_TOPOLOGY.map((d) => {
    const m = engine.deviceMetrics.get(d.uid);
    return {
      ...d,
      metrics: m ?? null,
    };
  });
  res.json({
    devices,
    outageActive: engine.outageActive,
    spoolDepth: engine.spool.length,
  });
});

// Login endpoint (Tier 1 Device Login OR Tier 2 Super Admin / Tenant Admin Login)
const LoginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  requiredRole: z.enum(['super_admin', 'any_admin']).optional(),
  deviceUid: z.string().optional(),
  tenantId: z.string().optional(),
  region: z.enum(['IN', 'EU', 'US']).optional(),
});

app.post('/api/auth/login', (req, res) => {
  const parsed = LoginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Username and password are required.' });
    return;
  }
  const result = authenticateUser(parsed.data);
  if (!result.session) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ session: result.session });
});

// Logout endpoint (records structured login_logout audit trail)
app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  const tier = req.body?.tier === 'tier2' ? 'tier2' : 'tier1';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const session = verifyToken(authHeader.slice(7).trim());
    if (session) {
      recordLogout(session, tier);
    }
  }
  res.json({ ok: true });
});

// Tier 1 Collector & Local Device Desktop API (requires authenticated device_operator or admin)
app.get('/api/collector/device/:uid', requireAuth(), (req: AuthenticatedRequest, res) => {
  const uid = String(req.params.uid);
  const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === uid);
  if (!dev) {
    res.status(404).json({ error: 'Device UID not found.' });
    return;
  }

  // Enforce tenant boundary unless super_admin
  if (req.session!.role !== 'super_admin' && req.session!.tenantId !== dev.tenantId) {
    res.status(403).json({ error: 'Tenant isolation violation: device belongs to a different tenant.' });
    return;
  }

  const metrics = engine.deviceMetrics.get(dev.uid)!;
  const health = evaluateHealth(metrics, Date.now(), engine.thresholds);
  const rawLogs = engine.localRawLogs.get(dev.uid) ?? [];
  const egressLog = engine.egressLog
    .filter((e) => e.deviceUid === dev.uid || e.tenantId === dev.tenantId)
    .slice(0, 35);
  const transfers = engine.fileTransfers.filter((t) => t.fromUid === dev.uid || t.toUid === dev.uid);

  res.json({
    device: dev,
    metrics,
    health,
    rawLogs,
    egressLog,
    spool: engine.spool,
    spoolDepth: engine.spool.length,
    droppedLowSeverityTotal: engine.droppedLowSeverityTotal,
    outageActive: engine.outageActive,
    lastHeartbeatUtc: engine.lastCollectorHeartbeatUtc,
    reconcile: engine.getReconcileSummary(),
    anomaly: engine.getAnomalySnapshot(dev.uid),
    transfers,
    latencySamples: engine.latencySamples.slice(0, 12),
    peerDevices: GLOBAL_TOPOLOGY.filter((p) => p.uid !== dev.uid)
      .slice(0, 18)
      .map((p) => ({
        uid: p.uid,
        hostname: p.hostname,
        tenantId: p.tenantId,
        cityName: p.cityName,
        industry: p.industry,
      })),
  });
});

// Inject custom raw telemetry or trigger scenario from Tier 1 / Tier 2
const ScenarioBodySchema = z.object({
  type: z.enum([
    'cpu_spike',
    'memory_leak',
    'latency_rise',
    'failed_login_burst',
    'secret_in_log',
    'saas_outage_toggle',
    'duplicate_replay',
    'out_of_order_delivery',
    'correlated_incident',
    'clock_skew',
    'disk_io_saturation',
    'dns_failure_burst',
    'cert_expiry_warning',
    'heartbeat_flap',
    'bandwidth_saturation',
    'privilege_escalation',
  ]),
  deviceUid: z.string().min(4),
  region: z.enum(['IN', 'EU', 'US']).optional(),
  tenantIds: z.array(z.string()).optional(),
});

app.post('/api/collector/scenario', requireAuth(), (req: AuthenticatedRequest, res) => {
  const parsed = ScenarioBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid scenario payload.' });
    return;
  }
  const payload = { ...parsed.data } as ScenarioRequest;
  // Lock non-super_admin sessions to their assigned tenant
  if (req.session!.role !== 'super_admin') {
    payload.tenantIds = [req.session!.tenantId];
    payload.region = req.session!.region;
  }
  const result = engine.triggerScenario(payload);
  res.json({
    ok: true,
    message: result.message,
    records: result.records,
    outageActive: engine.outageActive,
    spoolDepth: engine.spool.length,
    reconcile: engine.getReconcileSummary(),
  });
});

// Custom raw log injection (verifies secret redaction & allow-list live)
const CustomLogSchema = z.object({
  deviceUid: z.string().min(4),
  category: z.enum(['compute', 'memory', 'storage', 'network', 'security', 'application']),
  metric: z.string().min(1).max(64),
  value: z.number().finite(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  rawMessage: z.string().min(1).max(1200),
  extraFieldKey: z.string().optional(),
  extraFieldVal: z.string().optional(),
  testLastGateBlock: z.boolean().optional(),
});

app.post('/api/collector/inject-raw', requireAuth(), (req: AuthenticatedRequest, res) => {
  const parsed = CustomLogSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid raw telemetry payload.' });
    return;
  }
  const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === parsed.data.deviceUid);
  if (!dev) {
    res.status(404).json({ error: 'Device not found.' });
    return;
  }
  if (req.session!.role !== 'super_admin' && req.session!.tenantId !== dev.tenantId) {
    res.status(403).json({ error: 'Tenant isolation check failed.' });
    return;
  }

  const extraFields =
    parsed.data.extraFieldKey && parsed.data.extraFieldKey.trim()
      ? { [parsed.data.extraFieldKey.trim()]: parsed.data.extraFieldVal ?? 'untrusted-extra' }
      : undefined;

  const record = engine.collectAndDispatch(
    {
      rawId: `custom-${Date.now()}`,
      deviceUid: dev.uid,
      tenantId: dev.tenantId,
      region: dev.region,
      eventTimeUtc: new Date().toISOString(),
      sourceTz: getCityTimezone(dev.cityCode),
      category: parsed.data.category,
      metric: parsed.data.metric,
      value: parsed.data.value,
      severity: parsed.data.severity,
      rawMessage: parsed.data.rawMessage,
      extraFields,
      injectedAtMs: Date.now(),
    },
    Boolean(parsed.data.testLastGateBlock)
  );

  res.json({ ok: true, record, reconcile: engine.getReconcileSummary() });
});

// NDJSON format adapter endpoint (supports external stream ingestion)
app.post('/api/collector/ndjson', requireAuth(), (req: AuthenticatedRequest, res) => {
  const ndjsonText = typeof req.body?.ndjson === 'string' ? req.body.ndjson : '';
  const lines = ndjsonText
    .split('\n')
    .map((l: string) => l.trim())
    .filter(Boolean);
  const processed: string[] = [];

  for (const line of lines.slice(0, 25)) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === obj.deviceUid) ?? GLOBAL_TOPOLOGY[0];
      const rec = engine.collectAndDispatch({
        rawId: `ndjson-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        deviceUid: dev.uid,
        tenantId: dev.tenantId,
        region: dev.region,
        eventTimeUtc: typeof obj.eventTimeUtc === 'string' ? obj.eventTimeUtc : new Date().toISOString(),
        sourceTz: getCityTimezone(dev.cityCode),
        category: 'application',
        metric: typeof obj.metric === 'string' ? obj.metric : 'ndjson_event',
        value: typeof obj.value === 'number' ? obj.value : 1,
        severity: 'medium',
        rawMessage: typeof obj.message === 'string' ? obj.message : JSON.stringify(obj),
        injectedAtMs: Date.now(),
      });
      processed.push(rec.payloadId);
    } catch {
      // Skip malformed line
    }
  }
  res.json({ ok: true, ingestedCount: processed.length, payloadIds: processed });
});

// P2P Encrypted File Sharing Relay (separate data plane from telemetry)
const FileTransferSchema = z.object({
  fromUid: z.string(),
  toUid: z.string(),
  fileName: z.string().min(1).max(120),
  sizeClass: z.enum(['XS (<10KB)', 'S (10-100KB)', 'M (100KB-1MB)', 'L (>1MB)']),
  crossTenantPolicyApproved: z.boolean().default(false),
});

app.post('/api/mesh/transfer', requireAuth(), (req: AuthenticatedRequest, res) => {
  const parsed = FileTransferSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid encrypted transfer request.' });
    return;
  }
  const transfer = engine.createFileTransfer(
    parsed.data.fromUid,
    parsed.data.toUid,
    parsed.data.fileName,
    parsed.data.sizeClass,
    parsed.data.crossTenantPolicyApproved
  );
  res.json({ ok: true, transfer });
});

// Simulate receiving an inbound encrypted transfer from a peer device
app.post('/api/mesh/simulate-incoming', requireAuth(), (req: AuthenticatedRequest, res) => {
  const toUid = String(req.body?.toUid || req.session?.deviceUid || GLOBAL_TOPOLOGY[0].uid);
  const toDev = GLOBAL_TOPOLOGY.find((d) => d.uid === toUid) ?? GLOBAL_TOPOLOGY[0];
  const fromDev =
    GLOBAL_TOPOLOGY.find((d) => d.uid !== toDev.uid && d.tenantId === toDev.tenantId) ??
    GLOBAL_TOPOLOGY.find((d) => d.uid !== toDev.uid)!;
  const sampleName =
    typeof req.body?.fileName === 'string' && req.body.fileName.trim()
      ? req.body.fileName.trim().slice(0, 80)
      : `peer-sync-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.enc`;

  const transfer = engine.createFileTransfer(
    fromDev.uid,
    toDev.uid,
    sampleName,
    'S (10-100KB)',
    true
  );
  res.json({ ok: true, transfer });
});

// Toggle device online/offline to test >60s collector unreachable stale detection
app.post('/api/collector/device/:uid/heartbeat-toggle', requireAuth(), (req: AuthenticatedRequest, res) => {
  const uid = String(req.params.uid);
  const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === uid);
  const m = engine.deviceMetrics.get(uid);
  if (!m || !dev) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  m.online = !m.online;
  if (!m.online) {
    m.lastHeartbeatUtc = new Date(Date.now() - 95_000).toISOString();
  } else {
    m.lastHeartbeatUtc = new Date().toISOString();
  }
  const ev = evaluateHealth(m, Date.now(), engine.thresholds);
  m.healthState = ev.state;
  m.healthScore = ev.overallScore;

  engine.recordStructuredLog({
    category: 'alerts',
    tier: 'both',
    region: dev.region,
    tenantId: dev.tenantId,
    deviceUid: dev.uid,
    pseudoSourceId: dev.pseudoSourceId,
    actor: req.session?.username ?? 'collector',
    action: m.online ? 'HEARTBEAT_RESTORED' : 'HEARTBEAT_STALE_SIMULATED',
    severity: m.online ? 'low' : 'critical',
    summary: m.online
      ? `Collector heartbeat restored on ${dev.hostname}.`
      : `Collector heartbeat marked stale (>90s unreachable) on ${dev.hostname}.`,
  });

  res.json({ ok: true, online: m.online, health: ev });
});

// Structured Categorized Logs Query & Manual Creation (both Tier 1 and Tier 2)
const CreateLogSchema = z.object({
  category: z.enum([
    'metadata',
    'tenant_data',
    'login_logout',
    'authentication',
    'alerts',
    'user_activity',
    'transfer',
  ]),
  tier: z.enum(['tier1', 'tier2']),
  region: z.enum(['IN', 'EU', 'US']).optional(),
  tenantId: z.string().optional(),
  deviceUid: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('low'),
  action: z.string().min(2).max(64).optional(),
  summary: z.string().min(3).max(400),
});

app.get('/api/logs', requireAuth(), (req: AuthenticatedRequest, res) => {
  const tier = req.query.tier === 'tier2' ? 'tier2' : 'tier1';
  if (tier === 'tier2' && req.session!.role === 'device_operator') {
    res.status(403).json({ error: 'Device operators cannot query Tier 2 governance logs.' });
    return;
  }

  const category = req.query.category ? (String(req.query.category) as LogCategory) : undefined;
  const region = req.query.region ? (String(req.query.region) as RegionCode) : req.session!.region;
  const deviceUid = req.query.deviceUid ? String(req.query.deviceUid) : undefined;
  const tenantIdsParam = req.query.tenantIds ? String(req.query.tenantIds) : '';
  const requestedTenants = tenantIdsParam
    ? tenantIdsParam.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const tenantIds =
    req.session!.role === 'super_admin'
      ? requestedTenants
      : [req.session!.tenantId];

  const logs = engine.getStructuredLogs({
    tier,
    category,
    region: tier === 'tier2' && req.session!.role !== 'super_admin' ? req.session!.region : region,
    tenantIds,
    deviceUid: tier === 'tier1' ? deviceUid : undefined,
  });

  res.json({ tier, logs });
});

app.post('/api/logs/create', requireAuth(), (req: AuthenticatedRequest, res) => {
  const parsed = CreateLogSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid structured log payload.' });
    return;
  }
  const data = parsed.data;
  if (data.tier === 'tier2' && req.session!.role === 'device_operator') {
    res.status(403).json({ error: 'Unauthorized to create Tier 2 log.' });
    return;
  }

  const created = engine.createManualLog({
    category: data.category,
    tier: data.tier,
    region: data.region ?? req.session!.region,
    tenantId: req.session!.role === 'super_admin' ? data.tenantId ?? 'all' : req.session!.tenantId,
    deviceUid: data.tier === 'tier1' ? data.deviceUid ?? req.session!.deviceUid : undefined,
    actor: req.session!.username,
    severity: data.severity as Severity,
    action: data.action,
    summary: data.summary.trim(),
  });

  res.json({ ok: true, entry: created });
});

// Tier 2 Regional SaaS Dashboard API (strictly metadata-only; requires super_admin or tenant_admin)
app.get('/api/saas/dashboard', requireAuth(['super_admin', 'tenant_admin']), (req: AuthenticatedRequest, res) => {
  const requestedRegion = String(req.query.region || 'IN') as RegionCode;
  const tenantIdsParam = req.query.tenantIds
    ? String(req.query.tenantIds)
    : req.query.tenantId
      ? String(req.query.tenantId)
      : 'all';
  const parsedTenantList = tenantIdsParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Residency check: tenant_admin cannot read out-of-region stores
  if (req.session!.role !== 'super_admin' && requestedRegion !== req.session!.region) {
    engine.auditEvents.unshift({
      timestampUtc: new Date().toISOString(),
      actor: req.session!.username,
      action: 'RESIDENCY_READ_DENIED',
      detail: `Denied out-of-region read attempt to ${requestedRegion} from home region ${req.session!.region}.`,
    });
    res.status(403).json({
      error: `Data residency policy denied cross-region read (${requestedRegion} != home region ${req.session!.region}).`,
    });
    return;
  }

  // Tenant isolation check: tenant_admin forged tenantIds query is overridden by token tenantId
  const effectiveTenants =
    req.session!.role === 'super_admin'
      ? parsedTenantList.length === 0 || parsedTenantList.includes('all')
        ? ['all']
        : parsedTenantList
      : [req.session!.tenantId];

  const isAllTenants = effectiveTenants.includes('all');

  const regionDevices = GLOBAL_TOPOLOGY.filter((d) => {
    if (d.region !== requestedRegion) return false;
    if (!isAllTenants && !effectiveTenants.includes(d.tenantId)) return false;
    return true;
  });

  // SaaS only exposes pseudonymized metadata, NEVER UIDs or raw logs!
  const fleetNodes = regionDevices.map((d) => {
    const m = engine.deviceMetrics.get(d.uid)!;
    const ev = evaluateHealth(m, Date.now(), engine.thresholds);
    return {
      pseudoSourceId: d.pseudoSourceId,
      tenantId: d.tenantId,
      region: d.region,
      industry: d.industry,
      cityName: d.cityName,
      healthState: ev.state,
      healthScore: ev.overallScore,
      subScores: ev.subScores,
      isStale: ev.isStale,
      staleAgeSeconds: ev.staleAgeSeconds,
      reason: ev.reason,
      cpuPct: m.cpuPct,
      memoryPct: m.memoryPct,
      diskPct: m.diskPct,
      bandwidthMbps: m.bandwidthMbps,
      latencyMs: m.latencyMs,
      packetLossPct: m.packetLossPct,
      failedLogins: m.failedLogins,
      lastHeartbeatUtc: m.lastHeartbeatUtc,
    };
  });

  const avgScore =
    fleetNodes.length > 0
      ? Math.round(fleetNodes.reduce((s, n) => s + n.healthScore, 0) / fleetNodes.length)
      : 100;

  const rawPayloads = engine.saasReceivedPayloads[requestedRegion].filter((p) =>
    isAllTenants ? true : effectiveTenants.includes(p.tenantId)
  );

  const incidents = engine.incidents.filter((inc) => {
    if (inc.region !== requestedRegion) return false;
    if (!isAllTenants && !effectiveTenants.includes(inc.tenantId)) return false;
    return true;
  });

  const remediations = engine.remediations.filter((r) => {
    if (r.region !== requestedRegion) return false;
    if (!isAllTenants && !effectiveTenants.includes(r.tenantId)) return false;
    return true;
  });

  const storedHashesSubset = rawPayloads.slice(-20).reverse().map((p) => ({
    payloadId: p.payloadId,
    pseudoSourceId: p.pseudoSourceId,
    tenantId: p.tenantId,
    metric: p.metric,
    value: p.value,
    severity: p.severity,
    eventTimeUtc: p.eventTimeUtc,
    contextSummary: p.contextSummary,
    saasStoredSha256: engine.saasStoredHashes.get(p.payloadId) ?? '',
  }));

  const availableTenants = Array.from(
    new Set(GLOBAL_TOPOLOGY.filter((d) => d.region === requestedRegion).map((d) => d.tenantId))
  );

  res.json({
    region: requestedRegion,
    effectiveTenant: isAllTenants ? 'all' : effectiveTenants.join(','),
    effectiveTenants,
    availableTenants,
    fleetHealthScore: avgScore,
    fleetNodes,
    incidents,
    remediations,
    storedPayloads: storedHashesSubset,
    reconcile: engine.getReconcileSummary(),
    thresholds: engine.thresholds,
    outageActive: engine.outageActive,
    spoolDepth: engine.spool.length,
    auditEvents: engine.auditEvents.slice(0, 25),
    latencySamples: engine.latencySamples.slice(0, 12),
    fileTransferMetadata: engine.fileTransfers.slice(0, 12).map((f) => ({
      transferId: f.transferId,
      sizeClass: f.sizeClass,
      ciphertextSha256: f.ciphertextSha256,
      crossTenantPolicyApproved: f.crossTenantPolicyApproved,
      createdAtUtc: f.createdAtUtc,
      status: f.status,
    })),
  });
});

// Explicit Cross-Tenant / Out-of-Region Isolation Probe (for verification & judge demos)
app.post('/api/saas/isolation-probe', requireAuth(['super_admin', 'tenant_admin']), (req: AuthenticatedRequest, res) => {
  const targetRegion = String(req.body?.targetRegion || 'EU') as RegionCode;
  const targetTenant = String(req.body?.targetTenantId || 'tenant-de-bank-09');
  const session = req.session!;

  if (targetRegion !== session.region || (session.role !== 'super_admin' && targetTenant !== session.tenantId)) {
    const detail = `Blocked cross-boundary read: actor=${session.username} (${session.region}/${session.tenantId}) attempted access to ${targetRegion}/${targetTenant}.`;
    engine.auditEvents.unshift({
      timestampUtc: new Date().toISOString(),
      actor: session.username,
      action: 'TENANT_RESIDENCY_BLOCK',
      detail,
    });
    engine.recordStructuredLog({
      category: 'alerts',
      tier: 'tier2',
      region: session.region,
      tenantId: session.tenantId,
      actor: session.username,
      action: 'TENANT_RESIDENCY_BLOCK',
      severity: 'high',
      summary: detail,
    });
    res.status(403).json({ blocked: true, policy: 'RLS + Regional Residency Guard', detail });
    return;
  }

  res.json({ blocked: false, detail: 'Read within authorized home region.' });
});

// Update per-tenant health thresholds
const ThresholdsBodySchema = z.object({
  cpuFair: z.number().min(20).max(95).optional(),
  cpuPoor: z.number().min(30).max(100).optional(),
  memoryFair: z.number().min(20).max(95).optional(),
  memoryPoor: z.number().min(30).max(100).optional(),
  latencyFairMs: z.number().min(10).max(1000).optional(),
  latencyPoorMs: z.number().min(20).max(2000).optional(),
  staleSeconds: z.number().min(15).max(600).optional(),
});

app.post('/api/saas/thresholds', requireAuth(['super_admin', 'tenant_admin']), (req: AuthenticatedRequest, res) => {
  const parsed = ThresholdsBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid threshold values.' });
    return;
  }
  const next = { ...engine.thresholds, ...parsed.data };
  engine.thresholds = next;
  const detail = `Updated CPU Poor=${next.cpuPoor}%, Latency Poor=${next.latencyPoorMs}ms, Stale=${next.staleSeconds}s.`;
  engine.auditEvents.unshift({
    timestampUtc: new Date().toISOString(),
    actor: req.session!.username,
    action: 'THRESHOLDS_UPDATED',
    detail,
  });
  engine.recordStructuredLog({
    category: 'user_activity',
    tier: 'tier2',
    region: req.session!.region,
    tenantId: req.session!.tenantId,
    actor: req.session!.username,
    action: 'THRESHOLDS_UPDATED',
    severity: 'low',
    summary: detail,
  });
  res.json({ ok: true, thresholds: engine.thresholds });
});

// Safe Remediation Action (Two-person approval, simulated execution, rollback)
app.post('/api/saas/remediation/:id', requireAuth(['super_admin', 'tenant_admin']), (req: AuthenticatedRequest, res) => {
  const action = String(req.body?.action || '') as 'approve' | 'execute' | 'rollback' | 'reject';
  if (!['approve', 'execute', 'rollback', 'reject'].includes(action)) {
    res.status(400).json({ error: 'Invalid remediation action.' });
    return;
  }
  const result = engine.applyRemediationAction(String(req.params.id), req.session!.username, action);
  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, remediation: result.record });
});

// Enhance incident wording via Gemini LLM_PROVIDER adapter (metadata-only)
app.post('/api/saas/incidents/:id/enhance', requireAuth(['super_admin', 'tenant_admin']), async (req, res) => {
  const idx = engine.incidents.findIndex((i) => i.incidentId === String(req.params.id));
  if (idx === -1) {
    res.status(404).json({ error: 'Incident not found.' });
    return;
  }
  engine.incidents[idx] = await enhanceRecommendationWording(engine.incidents[idx]);
  res.json({ ok: true, incident: engine.incidents[idx] });
});

// Gemini Monitoring Chatbot endpoint (strictly metadata-only + live issue resolution + severe alerts)
app.post('/api/saas/chat', requireAuth(['super_admin', 'tenant_admin']), async (req: AuthenticatedRequest, res) => {
  const region = String(req.body?.region || 'IN') as RegionCode;
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  if (!question) {
    res.status(400).json({ error: 'Please enter a question.' });
    return;
  }

  const regionalIncidents = engine.incidents.filter((i) => i.region === region);
  const regionDevs = GLOBAL_TOPOLOGY.filter((d) => {
    if (d.region !== region) return false;
    if (req.session!.role !== 'super_admin' && d.tenantId !== req.session!.tenantId) return false;
    return true;
  });

  const fleetNodes = regionDevs.map((d) => {
    const m = engine.deviceMetrics.get(d.uid)!;
    const ev = evaluateHealth(m, Date.now(), engine.thresholds);
    return {
      pseudoSourceId: d.pseudoSourceId,
      tenantId: d.tenantId,
      industry: d.industry,
      cityName: d.cityName,
      healthState: ev.state,
      healthScore: ev.overallScore,
      isStale: ev.isStale,
      staleAgeSeconds: ev.staleAgeSeconds,
      cpuPct: m.cpuPct,
      memoryPct: m.memoryPct,
      diskPct: m.diskPct,
      latencyMs: m.latencyMs,
      packetLossPct: m.packetLossPct,
      failedLogins: m.failedLogins,
      reason: ev.reason,
    };
  });

  const avgScore = Math.round(
    fleetNodes.reduce((s, n) => s + n.healthScore, 0) / Math.max(1, fleetNodes.length)
  );

  const response = await askAIOpsAssistant({
    region,
    tenantScope: req.session!.tenantId,
    actor: req.session!.username,
    healthScore: avgScore,
    fleetNodes,
    openIncidents: regionalIncidents,
    question,
    history,
    onResolveIssue: ({ targetNodeHint, intent }) =>
      engine.resolveIssueFromAssistant({
        region,
        actor: req.session!.username,
        targetNodeHint,
        intent,
      }),
  });

  if (response.severeAlert?.active) {
    engine.recordStructuredLog({
      category: 'alerts',
      tier: 'tier2',
      region,
      tenantId: req.session!.tenantId,
      actor: 'aiops-advisor',
      action: 'SEVERE_ALERT_RAISED',
      severity: response.severeAlert.level,
      summary: `${response.severeAlert.title}: ${response.severeAlert.detail}`,
    });
  }

  res.json({
    ...response,
    dashboardNeedsRefresh: (response.resolvedCount ?? 0) > 0,
  });
});

async function startServer() {
  const port = 3000;
  const distDir = path.resolve(process.cwd(), 'dist');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(distDir);

  if (isProd) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Nexaura platform listening on http://localhost:${port}`);
  });
}

startServer();
