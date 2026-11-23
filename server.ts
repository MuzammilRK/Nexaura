import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createServer as createViteServer } from 'vite';
import { z } from 'zod';
import type { AdminPermissionKey, LogCategory, PortRole, RegionCode, ScenarioRequest, Severity } from './src/shared/schema';
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
import { clusterCoordinator } from './src/server/cluster';
import { hostTelemetrySampler } from './src/server/telemetrySource';
import { websiteRunner } from './src/server/websiteRunner';
import { evaluateHealth } from './src/core/aiops';
import {
  ADMIN_PERMISSION_LABELS,
  COUNTRY_DIRECTORY,
  ROUTER_FAULT_CATALOG,
  STORAGE_FAULT_CATALOG,
  canAdminApproveOutsideCountry,
  getCountryAuthorityForDevice,
} from './src/core/infra';

const app = express();

// Strict multi-port HTTP gateway (/p/:port/...) routing single-port Cloud Run / HTTPS ingress
// safely into active internal Nexaura cluster listeners (3000-3099) before JSON body parsing.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

app.use((req, res, next) => {
  const match = req.originalUrl.match(/^\/p\/(\d{4,5})(\/.*|\?.*)?$/);
  if (!match) {
    next();
    return;
  }
  if (req.headers['x-nexaura-proxied-by']) {
    res.status(508).json({ error: 'Port gateway loop detected.' });
    return;
  }

  const targetPort = Number(match[1]);
  const binding =
    Number.isInteger(targetPort) && targetPort >= 3000 && targetPort <= 3099
      ? clusterCoordinator.getBindingForPort(targetPort)
      : undefined;

  if (!binding || !binding.active) {
    res.status(404).json({ error: `Coordinated port :${targetPort} is not active.` });
    return;
  }

  const suffix = match[2] || '/';
  const targetPath = suffix.startsWith('?') ? `/${suffix}` : suffix;

  const forwardHeaders: Record<string, string | string[]> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (val === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    forwardHeaders[key] = val;
  }
  forwardHeaders.host = `127.0.0.1:${targetPort}`;
  forwardHeaders['x-nexaura-proxied-by'] = '3000';
  forwardHeaders['x-nexaura-target-port'] = String(targetPort);

  const proxyReq = http.request(
    {
      host: '127.0.0.1',
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: forwardHeaders,
    },
    (proxyRes) => {
      res.statusCode = proxyRes.statusCode ?? 200;
      for (const [key, val] of Object.entries(proxyRes.headers)) {
        if (val === undefined) continue;
        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
        res.setHeader(key, val);
      }
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `Port gateway error forwarding to :${targetPort}: ${err.message}` });
    }
  });

  req.on('aborted', () => {
    proxyReq.destroy();
  });

  req.pipe(proxyReq);
});

app.use(express.json({ limit: '1mb' }));

app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) {
    hostTelemetrySampler.recordAppTraffic(0.004, 2);
  }
  next();
});

function serveHostedSiteHtml(
  siteId: string,
  _port: number,
  req: express.Request,
  res: express.Response
): boolean {
  const started = performance.now();
  const site = websiteRunner.getSite(siteId);
  if (!site) return false;

  const latencyMs = Number(Math.max(0.8, performance.now() - started).toFixed(2));
  websiteRunner.recordSiteHit(siteId, 200, latencyMs);
  const byteSizeMb = Number((Buffer.byteLength(site.html, 'utf8') / (1024 * 1024)).toFixed(4));
  hostTelemetrySampler.recordAppTraffic(Math.max(0.005, byteSizeMb), 6);
  engine.ingestLiveClientSample({
    deviceUid: site.deviceUid,
    latencyMs,
    dataDeltaMb: Math.max(0.005, byteSizeMb),
    packetDelta: 6,
    source: `website-host:${siteId}`,
  });
  clusterCoordinator.broadcast('sites:updated', { siteId, deviceUid: site.deviceUid });

  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none';"
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Nexaura-Site-Id', site.siteId);
  res.statusCode = 200;
  res.end(req.method === 'HEAD' ? undefined : site.html);
  return true;
}

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'nexaura-platform',
    timeUtc: new Date().toISOString(),
    activePorts: clusterCoordinator.listPorts().length,
    wsClients: clusterCoordinator.totalWsClients(),
  });
});

// Runtime port & cluster context for automatic multi-port UI coordination
app.get('/api/runtime/context', (req, res) => {
  const socketPort = req.socket.localPort ?? (Number(process.env.PORT) || 3000);
  const overridePortRaw = Number(req.query.port ?? req.headers['x-nexaura-target-port']);
  const effectivePort =
    Number.isInteger(overridePortRaw) && clusterCoordinator.getBindingForPort(overridePortRaw)
      ? overridePortRaw
      : socketPort;
  const binding = clusterCoordinator.getBindingForPort(effectivePort);
  const envRole = (process.env.NEXAURA_ROLE as PortRole | undefined) ?? 'hub';
  res.json({
    currentPort: effectivePort,
    portRole: binding?.role ?? envRole,
    assignedDeviceUid: binding?.deviceUid ?? GLOBAL_TOPOLOGY[0].uid,
    assignedSiteId: binding?.siteId ?? null,
    activePorts: clusterCoordinator.listPorts(),
    totalWsClients: clusterCoordinator.totalWsClients(),
    hostTelemetry: engine.latestHostSample,
  });
});

// Live host telemetry sample (read directly from Linux /proc & Node OS counters)
app.get('/api/telemetry/host', (_req, res) => {
  const host = hostTelemetrySampler.sample();
  engine.latestHostSample = host;
  res.json({ host });
});

// Hosted Website direct preview route
app.get('/hosted/:siteId', (req, res) => {
  const port = req.socket.localPort ?? 3000;
  if (!serveHostedSiteHtml(String(req.params.siteId), port, req, res)) {
    res.status(404).send('Hosted site not found.');
  }
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
    serverInfra: engine.serverInfra,
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

  // Enforce tenant/country boundary unless super_admin
  if (
    req.session!.role !== 'super_admin' &&
    !(req.session!.role === 'country_admin' && req.session!.countryCode === dev.countryCode) &&
    req.session!.tenantId !== dev.tenantId
  ) {
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
  const peerInfo = engine.getVisiblePeersForDevice(dev);
  const authority = getCountryAuthorityForDevice(dev);
  const countryAdminRecord = engine.countryAdmins.find((a) => a.countryCode === dev.countryCode) ?? null;

  res.json({
    device: dev,
    metrics,
    health,
    metricHistory: engine.getNodeMetricHistory(dev.pseudoSourceId),
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
    tenantCommPolicy: peerInfo.policy,
    lockedPeerCounts: peerInfo.lockedPeerCounts,
    assignedAdmin: {
      username: authority.adminUsername,
      displayName: authority.adminDisplayName,
      superAdminId: authority.superAdminId,
      countryName: authority.countryName,
      crossCountryGranted: countryAdminRecord?.permissions.cross_country_transfer ?? false,
    },
    serverInfra: engine.serverInfra[dev.region],
    hostTelemetry: engine.latestHostSample,
    activePorts: clusterCoordinator.listPorts(),
    routerCatalog: ROUTER_FAULT_CATALOG,
    storageCatalog: STORAGE_FAULT_CATALOG,
    peerDevices: peerInfo.visiblePeers
      .slice(0, 32)
      .map((p) => ({
        uid: p.uid,
        hostname: p.hostname,
        tenantId: p.tenantId,
        cityName: p.cityName,
        districtName: p.districtName,
        countryName: p.countryName,
        cityCode: p.cityCode,
        districtCode: p.districtCode,
        countryCode: p.countryCode,
        industry: p.industry,
      })),
  });
});

// Live Telemetry Ingestion from Browser Client or External Node Collector Agent
const LiveIngestSchema = z.object({
  deviceUid: z.string().min(4),
  cpuPct: z.number().min(0).max(100).optional(),
  memoryPct: z.number().min(0).max(100).optional(),
  latencyMs: z.number().min(0.1).max(5000).optional(),
  bandwidthMbps: z.number().min(0.05).max(10000).optional(),
  dataDeltaMb: z.number().min(0).max(500).optional(),
  packetDelta: z.number().int().min(0).max(500000).optional(),
  source: z.string().max(48).optional(),
  dispatchEvent: z.boolean().optional(),
});

app.post('/api/collector/ingest-live', requireAuth(), (req: AuthenticatedRequest, res) => {
  const parsed = LiveIngestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid live telemetry sample payload.' });
    return;
  }
  const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === parsed.data.deviceUid);
  if (!dev) {
    res.status(404).json({ error: 'Device not found.' });
    return;
  }
  if (
    req.session!.role !== 'super_admin' &&
    !(req.session!.role === 'country_admin' && req.session!.countryCode === dev.countryCode) &&
    req.session!.tenantId !== dev.tenantId
  ) {
    res.status(403).json({ error: 'Tenant isolation violation on live telemetry ingest.' });
    return;
  }
  const result = engine.ingestLiveClientSample(parsed.data);
  res.json({ ok: result.ok, metrics: result.metrics });
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
  // Lock non-super_admin sessions to their assigned country or tenant
  if (req.session!.role === 'country_admin') {
    const allowedCountryTenants = Array.from(
      new Set(GLOBAL_TOPOLOGY.filter((d) => d.countryCode === req.session!.countryCode).map((d) => d.tenantId))
    );
    const reqTenants = (payload.tenantIds ?? []).filter((t) => t !== 'all');
    payload.tenantIds =
      reqTenants.length > 0
        ? reqTenants.filter((t) => allowedCountryTenants.includes(t))
        : allowedCountryTenants;
    payload.region = req.session!.region;
  } else if (req.session!.role !== 'super_admin') {
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

  clusterCoordinator.broadcast('device:updated', {
    deviceUid: dev.uid,
    region: dev.region,
    tenantId: dev.tenantId,
  });
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
  clusterCoordinator.broadcast('device:updated', {});
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
  const fromDev = GLOBAL_TOPOLOGY.find((d) => d.uid === parsed.data.fromUid);
  const toDev = GLOBAL_TOPOLOGY.find((d) => d.uid === parsed.data.toUid);
  if (!fromDev || !toDev) {
    res.status(404).json({ error: 'Source or recipient endpoint not found.' });
    return;
  }
  if (req.session!.role !== 'super_admin' && req.session!.tenantId !== fromDev.tenantId) {
    res.status(403).json({ error: 'Tenant isolation check failed on source endpoint.' });
    return;
  }
  const boundaryCheck = engine.isPeerAllowedByPolicy(fromDev, toDev);
  const transfer = engine.createFileTransfer(
    parsed.data.fromUid,
    parsed.data.toUid,
    parsed.data.fileName,
    parsed.data.sizeClass,
    parsed.data.crossTenantPolicyApproved
  );
  if (!boundaryCheck.allowed) {
    res.status(403).json({
      ok: false,
      error: boundaryCheck.reason,
      blockedBoundary: boundaryCheck.boundary,
      transfer,
    });
    return;
  }
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

  clusterCoordinator.broadcast('device:updated', {
    deviceUid: dev.uid,
    region: dev.region,
    tenantId: dev.tenantId,
  });
  res.json({ ok: true, online: m.online, health: ev });
});

// Structured Categorized Logs Query, Manual Creation & Export (both Tier 1 and Tier 2)
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
  actor: z.string().min(1).max(64).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('low'),
  action: z.string().min(2).max(64).optional(),
  summary: z.string().min(3).max(400),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

function csvCell(v: unknown): string {
  const str = v === undefined || v === null ? '' : String(v);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

app.get('/api/logs', requireAuth(), (req: AuthenticatedRequest, res) => {
  const tier = req.query.tier === 'tier2' ? 'tier2' : 'tier1';
  if (tier === 'tier2' && req.session!.role === 'device_operator') {
    res.status(403).json({ error: 'Device operators cannot query Tier 2 governance logs.' });
    return;
  }

  const rawCat = req.query.category ? String(req.query.category) : undefined;
  const category = rawCat && rawCat !== 'all' ? (rawCat as LogCategory) : undefined;
  const region = req.query.region ? (String(req.query.region) as RegionCode) : req.session!.region;
  const deviceUid = req.query.deviceUid ? String(req.query.deviceUid) : undefined;
  const tenantIdsParam = req.query.tenantIds ? String(req.query.tenantIds) : '';
  const requestedTenants = tenantIdsParam
    ? tenantIdsParam.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  let tenantIds: string[] | undefined;
  if (req.session!.role === 'super_admin') {
    tenantIds = requestedTenants;
  } else if (req.session!.role === 'country_admin') {
    const countryTenants = Array.from(
      new Set(GLOBAL_TOPOLOGY.filter((d) => d.countryCode === req.session!.countryCode).map((d) => d.tenantId))
    );
    tenantIds =
      requestedTenants && !requestedTenants.includes('all')
        ? requestedTenants.filter((t) => countryTenants.includes(t))
        : countryTenants;
  } else {
    tenantIds = [req.session!.tenantId];
  }

  const logs = engine.getStructuredLogs({
    tier,
    category,
    region: tier === 'tier2' && req.session!.role !== 'super_admin' ? req.session!.region : region,
    tenantIds,
    deviceUid: tier === 'tier1' ? deviceUid : undefined,
  });

  res.json({ tier, logs });
});

app.get('/api/logs/export', requireAuth(), (req: AuthenticatedRequest, res) => {
  const tier = req.query.tier === 'tier2' ? 'tier2' : 'tier1';
  if (tier === 'tier2' && req.session!.role === 'device_operator') {
    res.status(403).json({ error: 'Device operators cannot export Tier 2 governance logs.' });
    return;
  }
  if (tier === 'tier2' && req.session!.role === 'country_admin') {
    const adminRec = engine.countryAdmins.find(
      (a) => a.adminUsername.toLowerCase() === req.session!.username.toLowerCase()
    );
    if (!adminRec?.permissions.export_governance_logs) {
      res.status(403).json({
        error: `Super Admin approval required: "${req.session!.username}" needs "export_governance_logs" permission before downloading Tier 2 governance logs.`,
      });
      return;
    }
  }

  const rawCat = req.query.category ? String(req.query.category) : undefined;
  const category = rawCat && rawCat !== 'all' ? (rawCat as LogCategory) : undefined;
  const region = req.query.region ? (String(req.query.region) as RegionCode) : req.session!.region;
  const deviceUid = req.query.deviceUid ? String(req.query.deviceUid) : undefined;
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const tenantIdsParam = req.query.tenantIds ? String(req.query.tenantIds) : '';
  const requestedTenants = tenantIdsParam
    ? tenantIdsParam.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  let tenantIds: string[] | undefined;
  if (req.session!.role === 'super_admin') {
    tenantIds = requestedTenants;
  } else if (req.session!.role === 'country_admin') {
    const countryTenants = Array.from(
      new Set(GLOBAL_TOPOLOGY.filter((d) => d.countryCode === req.session!.countryCode).map((d) => d.tenantId))
    );
    tenantIds =
      requestedTenants && !requestedTenants.includes('all')
        ? requestedTenants.filter((t) => countryTenants.includes(t))
        : countryTenants;
  } else {
    tenantIds = [req.session!.tenantId];
  }

  const effectiveRegion =
    tier === 'tier2' && req.session!.role !== 'super_admin' ? req.session!.region : region;

  const logs = engine.getStructuredLogs({
    tier,
    category,
    region: effectiveRegion,
    tenantIds,
    deviceUid: tier === 'tier1' ? deviceUid : undefined,
  });

  const catSlug = category ?? 'all-categories';
  const fileBase = `nexaura-${tier}-${catSlug}-${effectiveRegion.toLowerCase()}`;

  engine.recordStructuredLog({
    category: 'user_activity',
    tier,
    region: effectiveRegion,
    tenantId: req.session!.tenantId,
    deviceUid: tier === 'tier1' ? deviceUid : undefined,
    actor: req.session!.username,
    action: 'LOGS_EXPORTED',
    severity: 'low',
    summary: `Exported ${logs.length} ${catSlug} log record(s) in ${format.toUpperCase()} format.`,
  });

  if (format === 'csv') {
    const header = [
      'id',
      'timestampUtc',
      'category',
      'tier',
      'region',
      'tenantId',
      'sourceRef',
      'actor',
      'action',
      'severity',
      'summary',
      'details',
    ].join(',');
    const rows = logs.map((l) =>
      [
        l.id,
        l.timestampUtc,
        l.category,
        l.tier,
        l.region,
        l.tenantId,
        tier === 'tier1' ? (l.deviceUid ?? l.pseudoSourceId ?? '') : (l.pseudoSourceId ?? ''),
        l.actor,
        l.action,
        l.severity,
        l.summary,
        l.details ? JSON.stringify(l.details) : '',
      ]
        .map(csvCell)
        .join(',')
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.csv"`);
    res.send([header, ...rows].join('\n'));
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.json"`);
  res.send(JSON.stringify(logs, null, 2));
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
    region: req.session!.role === 'super_admin' ? data.region ?? req.session!.region : req.session!.region,
    tenantId:
      req.session!.role === 'super_admin' || req.session!.role === 'country_admin'
        ? data.tenantId ?? 'all'
        : req.session!.tenantId,
    deviceUid: data.tier === 'tier1' ? data.deviceUid ?? req.session!.deviceUid : undefined,
    actor: data.actor?.trim() || req.session!.username,
    severity: data.severity as Severity,
    action: data.action,
    summary: data.summary.trim(),
    details: data.details,
  });

  clusterCoordinator.broadcast('logs:created', {
    region: created.region,
    tenantId: created.tenantId,
    deviceUid: created.deviceUid,
  });
  res.json({ ok: true, entry: created });
});

// Tier 2 Regional SaaS Dashboard API (strictly metadata-only; requires super_admin, country_admin, or tenant_admin)
app.get('/api/saas/dashboard', requireAuth(['super_admin', 'country_admin', 'tenant_admin']), (req: AuthenticatedRequest, res) => {
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

  // Residency check: country_admin and tenant_admin cannot read out-of-region stores
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

  const isCountryAdmin = req.session!.role === 'country_admin';
  const scopedCountryCode = isCountryAdmin ? req.session!.countryCode : undefined;
  const countryTenants = scopedCountryCode
    ? Array.from(
        new Set(
          GLOBAL_TOPOLOGY.filter(
            (d) => d.region === requestedRegion && d.countryCode === scopedCountryCode
          ).map((d) => d.tenantId)
        )
      )
    : [];

  let effectiveTenants: string[];
  if (req.session!.role === 'super_admin') {
    effectiveTenants =
      parsedTenantList.length === 0 || parsedTenantList.includes('all') ? ['all'] : parsedTenantList;
  } else if (isCountryAdmin) {
    effectiveTenants =
      parsedTenantList.length === 0 || parsedTenantList.includes('all')
        ? countryTenants
        : parsedTenantList.filter((t) => countryTenants.includes(t));
  } else {
    effectiveTenants = [req.session!.tenantId];
  }

  const isAllTenants = req.session!.role === 'super_admin' && effectiveTenants.includes('all');

  const regionDevices = GLOBAL_TOPOLOGY.filter((d) => {
    if (d.region !== requestedRegion) return false;
    if (scopedCountryCode && d.countryCode !== scopedCountryCode) return false;
    if (!isAllTenants && !effectiveTenants.includes(d.tenantId)) return false;
    return true;
  });

  // SaaS only exposes pseudonymized metadata, NEVER UIDs or raw logs!
  const fleetNodes = regionDevices.map((d) => {
    const m = engine.deviceMetrics.get(d.uid)!;
    const ev = evaluateHealth(m, Date.now(), engine.thresholds);
    const auth = getCountryAuthorityForDevice(d);
    return {
      pseudoSourceId: d.pseudoSourceId,
      tenantId: d.tenantId,
      region: d.region,
      countryCode: d.countryCode,
      countryName: d.countryName,
      industry: d.industry,
      cityName: d.cityName,
      assignedAdmin: auth.adminUsername,
      countrySuperAdminId: auth.superAdminId,
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
      metricHistory: engine.getNodeMetricHistory(d.pseudoSourceId),
      router: m.router ?? null,
      storage: m.storage ?? null,
      cloud: m.cloud ?? null,
    };
  });

  const avgScore =
    fleetNodes.length > 0
      ? Math.round(fleetNodes.reduce((s, n) => s + n.healthScore, 0) / fleetNodes.length)
      : 100;

  const allowedTenantSet = new Set(regionDevices.map((d) => d.tenantId));
  const rawPayloads = engine.saasReceivedPayloads[requestedRegion].filter((p) =>
    isAllTenants ? true : allowedTenantSet.has(p.tenantId)
  );

  const incidents = engine.incidents.filter((inc) => {
    if (inc.region !== requestedRegion) return false;
    if (!isAllTenants && !allowedTenantSet.has(inc.tenantId)) return false;
    return true;
  });

  const remediations = engine.remediations.filter((r) => {
    if (r.region !== requestedRegion) return false;
    if (!isAllTenants && !allowedTenantSet.has(r.tenantId)) return false;
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

  const availableTenants =
    req.session!.role === 'super_admin'
      ? Array.from(new Set(GLOBAL_TOPOLOGY.filter((d) => d.region === requestedRegion).map((d) => d.tenantId)))
      : isCountryAdmin
        ? countryTenants
        : [req.session!.tenantId];

  const tenantCommPolicies =
    req.session!.role === 'super_admin'
      ? engine.listTenantCommPolicies(requestedRegion)
      : isCountryAdmin
        ? engine.listTenantCommPolicies(requestedRegion).filter((p) => p.countryCode === scopedCountryCode)
        : [engine.getTenantCommPolicy(req.session!.tenantId)];

  const visibleCountryAdmins =
    req.session!.role === 'super_admin'
      ? engine.countryAdmins
      : isCountryAdmin
        ? engine.countryAdmins.filter((a) => a.countryCode === scopedCountryCode)
        : [];

  res.json({
    region: requestedRegion,
    effectiveTenant: isAllTenants ? 'all' : effectiveTenants.join(','),
    effectiveTenants,
    availableTenants,
    tenantCommPolicies,
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
    serverInfra: engine.serverInfra[requestedRegion],
    hostTelemetry: engine.latestHostSample,
    activePorts: clusterCoordinator.listPorts(),
    totalWsClients: clusterCoordinator.totalWsClients(),
    routerCatalog: ROUTER_FAULT_CATALOG,
    storageCatalog: STORAGE_FAULT_CATALOG,
    countryAdmins: visibleCountryAdmins,
    countryDirectory: COUNTRY_DIRECTORY,
    permissionLabels: ADMIN_PERMISSION_LABELS,
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

// Super Admin OR Permitted Country Admin: Lock / Unlock per-tenant Cross-District, Cross-City, Cross-Country communication
const TenantPolicyUpdateSchema = z.object({
  tenantId: z.string().min(2),
  allowOutsideDistrict: z.boolean().optional(),
  allowOutsideCity: z.boolean().optional(),
  allowOutsideCountry: z.boolean().optional(),
});

app.post('/api/saas/tenant-policy', requireAuth(['super_admin', 'country_admin']), (req: AuthenticatedRequest, res) => {
  const parsed = TenantPolicyUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid tenant policy payload.' });
    return;
  }

  const sample = GLOBAL_TOPOLOGY.find((d) => d.tenantId === parsed.data.tenantId);
  if (!sample) {
    res.status(404).json({ error: `Tenant "${parsed.data.tenantId}" not found.` });
    return;
  }

  if (req.session!.role === 'country_admin' && sample.countryCode !== req.session!.countryCode) {
    res.status(403).json({
      error: `Country Admin "${req.session!.username}" can only manage tenants in ${req.session!.countryCode}.`,
    });
    return;
  }

  if (parsed.data.allowOutsideCountry !== undefined) {
    const adminRec = engine.countryAdmins.find(
      (a) => a.adminUsername.toLowerCase() === req.session!.username.toLowerCase()
    );
    const permCheck = canAdminApproveOutsideCountry(
      req.session!.role,
      adminRec,
      sample.countryCode
    );
    if (!permCheck.allowed) {
      res.status(403).json({ error: permCheck.reason });
      return;
    }
  }

  const updated = engine.setTenantCommPolicy({
    tenantId: parsed.data.tenantId,
    allowOutsideDistrict: parsed.data.allowOutsideDistrict,
    allowOutsideCity: parsed.data.allowOutsideCity,
    allowOutsideCountry: parsed.data.allowOutsideCountry,
    actor: req.session!.username,
  });
  if (!updated) {
    res.status(404).json({ error: `Tenant "${parsed.data.tenantId}" not found.` });
    return;
  }
  const policies =
    req.session!.role === 'country_admin'
      ? engine.listTenantCommPolicies(updated.region).filter((p) => p.countryCode === req.session!.countryCode)
      : engine.listTenantCommPolicies(updated.region);
  res.json({
    ok: true,
    policy: updated,
    tenantCommPolicies: policies,
  });
});

// Country Admin requests permission from Super Admin; Super Admin grants/revokes permissions
const AdminPermissionRequestSchema = z.object({
  permission: z.enum([
    'cross_country_transfer',
    'edit_health_thresholds',
    'manage_server_faults',
    'export_governance_logs',
  ]),
  reason: z.string().max(240).optional(),
});

app.post('/api/saas/admin-permissions/request', requireAuth(['country_admin']), (req: AuthenticatedRequest, res) => {
  const parsed = AdminPermissionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid permission request payload.' });
    return;
  }
  const result = engine.requestAdminPermission({
    adminUsername: req.session!.username,
    permission: parsed.data.permission as AdminPermissionKey,
    reason: parsed.data.reason ?? `Requesting Super Admin grant for ${parsed.data.permission}.`,
  });
  if (!result.ok) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json({
    ok: true,
    message: `Permission request for "${ADMIN_PERMISSION_LABELS[parsed.data.permission].label}" sent to Super Admin (${result.record!.countrySuperAdminId}).`,
    record: result.record,
  });
});

const AdminPermissionDecisionSchema = z.object({
  adminUsername: z.string().min(3),
  permission: z.enum([
    'cross_country_transfer',
    'edit_health_thresholds',
    'manage_server_faults',
    'export_governance_logs',
  ]),
  grant: z.boolean(),
});

app.post('/api/saas/admin-permissions/decide', requireAuth(['super_admin']), (req: AuthenticatedRequest, res) => {
  const parsed = AdminPermissionDecisionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid permission decision payload.' });
    return;
  }
  const result = engine.decideAdminPermission({
    adminUsername: parsed.data.adminUsername,
    permission: parsed.data.permission as AdminPermissionKey,
    grant: parsed.data.grant,
    decidedBy: req.session!.username,
  });
  if (!result.ok) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json({
    ok: true,
    message: `${parsed.data.grant ? 'Granted' : 'Revoked'} "${ADMIN_PERMISSION_LABELS[parsed.data.permission].label}" for ${result.record!.adminUsername}.`,
    record: result.record,
  });
});

// Router, Storage & Cloud Subsystem Fault Injection and Resolution (Device & Server)
const InfraFaultSchema = z.object({
  target: z.enum(['device', 'server']),
  component: z.enum(['router', 'storage', 'cloud']),
  deviceUid: z.string().optional(),
  region: z.enum(['IN', 'EU', 'US']).optional(),
  faultCode: z.string().min(3),
});

app.post('/api/infra/fault', requireAuth(), (req: AuthenticatedRequest, res) => {
  const parsed = InfraFaultSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid infrastructure fault request.' });
    return;
  }

  if (parsed.data.target === 'server') {
    if (req.session!.role === 'device_operator' || req.session!.role === 'tenant_admin') {
      res.status(403).json({ error: 'Server subsystem fault controls require Super Admin or authorized Country Admin.' });
      return;
    }
    if (req.session!.role === 'country_admin') {
      const adminRec = engine.countryAdmins.find(
        (a) => a.adminUsername.toLowerCase() === req.session!.username.toLowerCase()
      );
      if (!adminRec?.permissions.manage_server_faults) {
        res.status(403).json({
          error: `Super Admin approval required: "${req.session!.username}" needs "manage_server_faults" permission to modify server router/storage.`,
        });
        return;
      }
      if ((parsed.data.region ?? req.session!.region) !== req.session!.region) {
        res.status(403).json({ error: 'Country Admin cannot access another region server.' });
        return;
      }
    }
  } else {
    const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === parsed.data.deviceUid);
    if (!dev) {
      res.status(404).json({ error: 'Target device not found.' });
      return;
    }
    if (
      req.session!.role !== 'super_admin' &&
      !(req.session!.role === 'country_admin' && req.session!.countryCode === dev.countryCode) &&
      req.session!.tenantId !== dev.tenantId
    ) {
      res.status(403).json({ error: 'Boundary check denied modifying this device subsystem.' });
      return;
    }
  }

  const out = engine.injectInfraFault({
    target: parsed.data.target,
    component: parsed.data.component,
    deviceUid: parsed.data.deviceUid,
    region: parsed.data.region ?? req.session!.region,
    faultCode: parsed.data.faultCode,
    actor: req.session!.username,
  });
  if (!out.ok) {
    res.status(400).json({ error: out.error });
    return;
  }
  res.json(out);
});

const InfraResolveSchema = z.object({
  target: z.enum(['device', 'server']),
  component: z.enum(['router', 'storage', 'cloud', 'all']).default('all'),
  deviceUid: z.string().optional(),
  region: z.enum(['IN', 'EU', 'US']).optional(),
});

app.post('/api/infra/resolve', requireAuth(), (req: AuthenticatedRequest, res) => {
  const parsed = InfraResolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid infrastructure resolve request.' });
    return;
  }

  if (parsed.data.target === 'server') {
    if (req.session!.role === 'device_operator' || req.session!.role === 'tenant_admin') {
      res.status(403).json({ error: 'Server subsystem resolution requires Super Admin or authorized Country Admin.' });
      return;
    }
    if (req.session!.role === 'country_admin') {
      const adminRec = engine.countryAdmins.find(
        (a) => a.adminUsername.toLowerCase() === req.session!.username.toLowerCase()
      );
      if (!adminRec?.permissions.manage_server_faults) {
        res.status(403).json({
          error: `Super Admin approval required: "${req.session!.username}" needs "manage_server_faults" permission to restore server subsystems.`,
        });
        return;
      }
    }
  } else {
    const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === parsed.data.deviceUid);
    if (!dev) {
      res.status(404).json({ error: 'Target device not found.' });
      return;
    }
    if (
      req.session!.role !== 'super_admin' &&
      !(req.session!.role === 'country_admin' && req.session!.countryCode === dev.countryCode) &&
      req.session!.tenantId !== dev.tenantId
    ) {
      res.status(403).json({ error: 'Boundary check denied resolving this device subsystem.' });
      return;
    }
  }

  const out = engine.resolveInfraFault({
    target: parsed.data.target,
    component: parsed.data.component,
    deviceUid: parsed.data.deviceUid,
    region: parsed.data.region ?? req.session!.region,
    actor: req.session!.username,
  });
  if (!out.ok) {
    res.status(400).json({ error: out.error });
    return;
  }
  res.json(out);
});

// Manual Per-Tenant Error Injection & Direct Resolution (Tier 1 & Tier 2)
const ManualFaultInjectSchema = z.object({
  tenantId: z.string().min(2),
  deviceUid: z.string().optional(),
  scenarioType: ScenarioBodySchema.shape.type.default('cpu_spike'),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  customMessage: z.string().max(300).optional(),
});

app.post('/api/fault/inject', requireAuth(), (req: AuthenticatedRequest, res) => {
  const parsed = ManualFaultInjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid fault injection request.' });
    return;
  }
  const sampleDev = GLOBAL_TOPOLOGY.find((d) => d.tenantId === parsed.data.tenantId);
  const countryAuthorized =
    req.session!.role === 'country_admin' && sampleDev?.countryCode === req.session!.countryCode;

  if (req.session!.role !== 'super_admin' && !countryAuthorized && parsed.data.tenantId !== req.session!.tenantId) {
    res.status(403).json({ error: 'Tenant boundary check denied injecting fault on another tenant.' });
    return;
  }
  const result = engine.injectManualTenantError({
    tenantId: parsed.data.tenantId,
    deviceUid:
      req.session!.role === 'super_admin' || countryAuthorized
        ? parsed.data.deviceUid
        : req.session!.deviceUid ?? parsed.data.deviceUid,
    scenarioType: parsed.data.scenarioType,
    severity: parsed.data.severity,
    customMessage: parsed.data.customMessage,
    actor: req.session!.username,
  });
  res.json({ ok: true, ...result });
});

const ManualFaultResolveSchema = z.object({
  tenantId: z.string().min(2),
  deviceUid: z.string().optional(),
});

app.post('/api/fault/resolve', requireAuth(), (req: AuthenticatedRequest, res) => {
  const parsed = ManualFaultResolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid fault resolution request.' });
    return;
  }
  const sampleDev = GLOBAL_TOPOLOGY.find((d) => d.tenantId === parsed.data.tenantId);
  const countryAuthorized =
    req.session!.role === 'country_admin' && sampleDev?.countryCode === req.session!.countryCode;

  if (req.session!.role !== 'super_admin' && !countryAuthorized && parsed.data.tenantId !== req.session!.tenantId) {
    res.status(403).json({ error: 'Tenant boundary check denied resolving fault on another tenant.' });
    return;
  }
  const result = engine.resolveManualTenantError({
    tenantId: parsed.data.tenantId,
    deviceUid:
      req.session!.role === 'super_admin' || countryAuthorized
        ? parsed.data.deviceUid
        : req.session!.deviceUid ?? parsed.data.deviceUid,
    actor: req.session!.username,
  });
  res.json({ ok: true, ...result });
});

// Explicit Cross-Tenant / Out-of-Region Isolation Probe (for verification & judge demos)
app.post('/api/saas/isolation-probe', requireAuth(['super_admin', 'country_admin', 'tenant_admin']), (req: AuthenticatedRequest, res) => {
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

app.post('/api/saas/thresholds', requireAuth(['super_admin', 'country_admin', 'tenant_admin']), (req: AuthenticatedRequest, res) => {
  if (req.session!.role === 'country_admin') {
    const adminRec = engine.countryAdmins.find(
      (a) => a.adminUsername.toLowerCase() === req.session!.username.toLowerCase()
    );
    if (!adminRec?.permissions.edit_health_thresholds) {
      res.status(403).json({
        error: `Super Admin approval required: "${req.session!.username}" needs "edit_health_thresholds" permission before editing SLA thresholds.`,
      });
      return;
    }
  }
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
  clusterCoordinator.broadcast('policy:updated', {
    region: req.session!.region,
    tenantId: req.session!.tenantId,
  });
  res.json({ ok: true, thresholds: engine.thresholds });
});

// Safe Remediation Action (Two-person approval, simulated execution, rollback)
app.post('/api/saas/remediation/:id', requireAuth(['super_admin', 'country_admin', 'tenant_admin']), (req: AuthenticatedRequest, res) => {
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
app.post('/api/saas/incidents/:id/enhance', requireAuth(['super_admin', 'country_admin', 'tenant_admin']), async (req, res) => {
  const idx = engine.incidents.findIndex((i) => i.incidentId === String(req.params.id));
  if (idx === -1) {
    res.status(404).json({ error: 'Incident not found.' });
    return;
  }
  engine.incidents[idx] = await enhanceRecommendationWording(engine.incidents[idx]);
  res.json({ ok: true, incident: engine.incidents[idx] });
});

// Gemini Monitoring Chatbot endpoint (strictly metadata-only + live issue resolution + severe alerts)
app.post('/api/saas/chat', requireAuth(['super_admin', 'country_admin', 'tenant_admin']), async (req: AuthenticatedRequest, res) => {
  const region = String(req.body?.region || 'IN') as RegionCode;
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  if (!question) {
    res.status(400).json({ error: 'Please enter a question.' });
    return;
  }

  const isCountryAdmin = req.session!.role === 'country_admin';
  const regionDevs = GLOBAL_TOPOLOGY.filter((d) => {
    if (d.region !== region) return false;
    if (isCountryAdmin && d.countryCode !== req.session!.countryCode) return false;
    if (req.session!.role !== 'super_admin' && !isCountryAdmin && d.tenantId !== req.session!.tenantId) return false;
    return true;
  });
  const allowedTenants = new Set(regionDevs.map((d) => d.tenantId));
  const regionalIncidents = engine.incidents.filter(
    (i) => i.region === region && (req.session!.role === 'super_admin' || allowedTenants.has(i.tenantId))
  );

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

// Multi-Port Cluster Coordination Endpoints
app.get('/api/cluster/ports', (_req, res) => {
  res.json({
    ports: clusterCoordinator.listPorts(),
    totalWsClients: clusterCoordinator.totalWsClients(),
  });
});

const OpenPortSchema = z.object({
  port: z.number().int().min(3001).max(3099).optional(),
  role: z.enum(['client', 'saas', 'hub', 'website']),
  deviceUid: z.string().optional(),
  siteId: z.string().optional(),
  label: z.string().max(80).optional(),
});

app.post('/api/cluster/ports/open', requireAuth(), async (req: AuthenticatedRequest, res) => {
  const parsed = OpenPortSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid port configuration (allowed range 3001-3099).' });
    return;
  }
  const result = await clusterCoordinator.openPort(parsed.data);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  if (parsed.data.role === 'website' && parsed.data.siteId) {
    websiteRunner.setSiteBoundPort(parsed.data.siteId, result.binding.port);
    clusterCoordinator.broadcast('sites:updated', { siteId: parsed.data.siteId });
  }
  engine.recordStructuredLog({
    category: 'user_activity',
    tier: 'both',
    region: req.session!.region,
    tenantId: req.session!.tenantId,
    deviceUid: parsed.data.deviceUid,
    actor: req.session!.username,
    action: 'CLUSTER_PORT_OPENED',
    severity: 'low',
    summary: `Opened coordinated HTTP/WS port :${result.binding.port} (${result.binding.role}).`,
  });
  res.json({ ok: true, binding: result.binding, ports: clusterCoordinator.listPorts() });
});

app.post('/api/cluster/ports/close', requireAuth(), async (req: AuthenticatedRequest, res) => {
  const port = Number(req.body?.port);
  if (!Number.isInteger(port) || port <= 3000) {
    res.status(400).json({ error: 'Cannot close primary port 3000.' });
    return;
  }
  const existing = clusterCoordinator.getBindingForPort(port);
  const result = await clusterCoordinator.closePort(port);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  if (existing?.siteId) {
    websiteRunner.setSiteBoundPort(existing.siteId, null);
    clusterCoordinator.broadcast('sites:updated', { siteId: existing.siteId });
  }
  engine.recordStructuredLog({
    category: 'user_activity',
    tier: 'both',
    region: req.session!.region,
    tenantId: req.session!.tenantId,
    actor: req.session!.username,
    action: 'CLUSTER_PORT_CLOSED',
    severity: 'low',
    summary: `Closed coordinated port :${port}.`,
  });
  res.json({ ok: true, ports: clusterCoordinator.listPorts() });
});

// Website Runner & External Web Browser API
app.get('/api/websites', requireAuth(), (_req, res) => {
  res.json({
    sites: websiteRunner.listSites(),
    recentProbes: websiteRunner.getRecentProbes(),
  });
});

const UpsertWebsiteSchema = z.object({
  siteId: z.string().max(48).optional(),
  title: z.string().min(2).max(80),
  description: z.string().max(200).optional(),
  deviceUid: z.string().min(4),
  html: z.string().min(10).max(120_000),
});

app.post('/api/websites', requireAuth(), (req: AuthenticatedRequest, res) => {
  const parsed = UpsertWebsiteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid hosted website definition.' });
    return;
  }
  const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === parsed.data.deviceUid);
  if (!dev) {
    res.status(404).json({ error: 'Target device UID not found.' });
    return;
  }
  if (
    req.session!.role !== 'super_admin' &&
    !(req.session!.role === 'country_admin' && req.session!.countryCode === dev.countryCode) &&
    req.session!.tenantId !== dev.tenantId
  ) {
    res.status(403).json({ error: 'Tenant isolation denied saving website on this device.' });
    return;
  }
  const site = websiteRunner.upsertSite(parsed.data);
  engine.recordStructuredLog({
    category: 'user_activity',
    tier: 'both',
    region: dev.region,
    tenantId: dev.tenantId,
    deviceUid: dev.uid,
    pseudoSourceId: dev.pseudoSourceId,
    actor: req.session!.username,
    action: 'HOSTED_WEBSITE_SAVED',
    severity: 'low',
    summary: `Saved web app "${site.title}" (/hosted/${site.siteId}) on ${dev.hostname}.`,
  });
  clusterCoordinator.broadcast('sites:updated', { siteId: site.siteId, deviceUid: dev.uid });
  res.json({ ok: true, site, sites: websiteRunner.listSites() });
});

app.post('/api/websites/:siteId/publish-port', requireAuth(), async (req: AuthenticatedRequest, res) => {
  const siteId = String(req.params.siteId);
  const site = websiteRunner.getSite(siteId);
  if (!site) {
    res.status(404).json({ error: 'Website not found.' });
    return;
  }
  const requestedPort = req.body?.port ? Number(req.body.port) : undefined;
  const openRes = await clusterCoordinator.openPort({
    port: requestedPort,
    role: 'website',
    siteId: site.siteId,
    deviceUid: site.deviceUid,
    label: `Web App · ${site.title}`,
  });
  if (!openRes.ok) {
    res.status(400).json({ error: openRes.error });
    return;
  }
  websiteRunner.setSiteBoundPort(site.siteId, openRes.binding.port);
  clusterCoordinator.broadcast('sites:updated', { siteId: site.siteId, deviceUid: site.deviceUid });
  res.json({ ok: true, binding: openRes.binding, site, ports: clusterCoordinator.listPorts() });
});

app.post('/api/websites/:siteId/unpublish-port', requireAuth(), async (req: AuthenticatedRequest, res) => {
  const siteId = String(req.params.siteId);
  const site = websiteRunner.getSite(siteId);
  if (!site) {
    res.status(404).json({ error: 'Website not found.' });
    return;
  }
  if (site.boundPort && site.boundPort > 3000) {
    await clusterCoordinator.closePort(site.boundPort);
  }
  websiteRunner.setSiteBoundPort(site.siteId, null);
  clusterCoordinator.broadcast('sites:updated', { siteId: site.siteId, deviceUid: site.deviceUid });
  res.json({ ok: true, site, ports: clusterCoordinator.listPorts() });
});

const BrowserProbeSchema = z.object({
  url: z.string().min(4).max(1024),
  deviceUid: z.string().min(4),
});

app.post('/api/browser/probe', requireAuth(), async (req: AuthenticatedRequest, res) => {
  const parsed = BrowserProbeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid target URL and device UID are required.' });
    return;
  }
  const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === parsed.data.deviceUid);
  if (!dev) {
    res.status(404).json({ error: 'Target device not found.' });
    return;
  }
  if (
    req.session!.role !== 'super_admin' &&
    !(req.session!.role === 'country_admin' && req.session!.countryCode === dev.countryCode) &&
    req.session!.tenantId !== dev.tenantId
  ) {
    res.status(403).json({ error: 'Tenant isolation check failed.' });
    return;
  }

  const out = await websiteRunner.probeExternalUrl(parsed.data.url, dev.uid);
  if (!out.ok) {
    if (out.status === 403) {
      engine.recordStructuredLog({
        category: 'alerts',
        tier: 'both',
        region: dev.region,
        tenantId: dev.tenantId,
        deviceUid: dev.uid,
        pseudoSourceId: dev.pseudoSourceId,
        actor: req.session!.username,
        action: 'WEB_RUNNER_URL_BLOCKED',
        severity: 'high',
        summary: `Blocked unsafe web request from ${dev.hostname}: ${out.error}`,
      });
      clusterCoordinator.broadcast('logs:created', {
        region: dev.region,
        tenantId: dev.tenantId,
        deviceUid: dev.uid,
      });
    }
    res.status(out.status).json({ ok: false, error: out.error });
    return;
  }

  const transferMb = Number(Math.max(0.002, out.probe.bytesReceived / (1024 * 1024)).toFixed(4));
  const packets = Math.max(4, Math.ceil(out.probe.bytesReceived / 1400));
  hostTelemetrySampler.recordAppTraffic(transferMb, packets);
  engine.ingestLiveClientSample({
    deviceUid: dev.uid,
    latencyMs: out.probe.latencyMs,
    dataDeltaMb: transferMb,
    packetDelta: packets,
    source: 'web-runner',
  });
  engine.recordStructuredLog({
    category: 'user_activity',
    tier: 'tier1',
    region: dev.region,
    tenantId: dev.tenantId,
    deviceUid: dev.uid,
    pseudoSourceId: dev.pseudoSourceId,
    actor: req.session!.username,
    action: 'WEB_RUNNER_SITE_OPENED',
    severity: 'low',
    summary: `Loaded ${out.probe.url} -> HTTP ${out.probe.statusCode} (${out.probe.latencyMs}ms, ${out.probe.bytesReceived} bytes).`,
  });
  clusterCoordinator.broadcast('sites:updated', { deviceUid: dev.uid });
  res.json({ ok: true, probe: out.probe });
});

async function startServer() {
  const primaryPort = Number(process.env.PORT) || 3000;
  const primaryRole = (process.env.NEXAURA_ROLE as PortRole | undefined) || 'hub';
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

  clusterCoordinator.configure({
    app,
    siteHtmlRenderer: (siteId, port, req, res) => serveHostedSiteHtml(siteId, port, req, res),
    onLiveTelemetry: (payload) => {
      engine.ingestLiveClientSample(payload);
    },
  });

  const hubRes = await clusterCoordinator.openPort({
    port: primaryPort,
    role: primaryRole,
    primary: true,
    label:
      primaryRole === 'client'
        ? 'Primary Client Instance'
        : primaryRole === 'saas'
          ? 'Primary SaaS Instance'
          : 'Primary Hub (World · Tier 1 · Tier 2)',
  });

  if (!hubRes.ok) {
    console.error(`Failed to start primary port ${primaryPort}: ${hubRes.error}`);
    process.exit(1);
  }
  console.log(`Nexaura platform listening on http://localhost:${primaryPort} [role=${primaryRole}]`);

  // Simultaneously open coordinated Client & SaaS ports unless disabled or running external peer
  if (primaryPort === 3000 && process.env.NEXAURA_DISABLE_PEER_PORTS !== '1') {
    const clientPort = Number(process.env.CLIENT_PORT) || 3001;
    const saasPort = Number(process.env.SAAS_PORT) || 3002;

    const cRes = await clusterCoordinator.openPort({
      port: clientPort,
      role: 'client',
      deviceUid: GLOBAL_TOPOLOGY[0].uid,
      label: `Tier 1 Client Portal (${GLOBAL_TOPOLOGY[0].cityCode})`,
    });
    if (cRes.ok) {
      console.log(`Nexaura Client portal listening on http://localhost:${clientPort} [role=client]`);
    }

    const sRes = await clusterCoordinator.openPort({
      port: saasPort,
      role: 'saas',
      label: 'Tier 2 Regional SaaS Portal',
    });
    if (sRes.ok) {
      console.log(`Nexaura SaaS portal listening on http://localhost:${saasPort} [role=saas]`);
    }
  }

  if (process.env.NEXAURA_HUB_URL) {
    clusterCoordinator.connectToExternalHub(process.env.NEXAURA_HUB_URL, (remoteMsg) => {
      clusterCoordinator.broadcast(remoteMsg.type, {
        deviceUid: remoteMsg.deviceUid,
        region: remoteMsg.region,
        tenantId: remoteMsg.tenantId,
      });
    });
  }
}

startServer();
