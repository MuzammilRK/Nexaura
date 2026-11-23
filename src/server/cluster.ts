import http from 'node:http';
import type { Express, Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClusterPortBinding, PortRole } from '../shared/schema';
import { GLOBAL_TOPOLOGY } from '../shared/topology';

export type RealtimeEventType =
  | 'hello'
  | 'telemetry:tick'
  | 'device:updated'
  | 'infra:updated'
  | 'incident:updated'
  | 'policy:updated'
  | 'transfer:created'
  | 'logs:created'
  | 'ports:updated'
  | 'sites:updated';

export interface RealtimeMessage {
  type: RealtimeEventType;
  port?: number;
  deviceUid?: string;
  region?: string;
  tenantId?: string;
  siteId?: string;
  timestampUtc: string;
}

interface ManagedPortServer {
  binding: ClusterPortBinding;
  server: http.Server;
  sockets: Set<WebSocket>;
}

interface WsClientMeta {
  port: number;
  role: PortRole;
  deviceUid?: string;
  alive: boolean;
}

export interface LiveTelemetryCallbackPayload {
  deviceUid: string;
  cpuPct?: number;
  memoryPct?: number;
  latencyMs?: number;
  bandwidthMbps?: number;
  dataDeltaMb?: number;
  packetDelta?: number;
  source?: string;
}

class ClusterCoordinator {
  private ports = new Map<number, ManagedPortServer>();
  private wss = new WebSocketServer({ noServer: true });
  private clientMeta = new Map<WebSocket, WsClientMeta>();
  private expressApp: Express | null = null;
  private siteHtmlRenderer: ((siteId: string, port: number, req: Request, res: Response) => boolean) | null = null;
  private onLiveTelemetry: ((payload: LiveTelemetryCallbackPayload) => void) | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private hubPeerWs: WebSocket | null = null;

  constructor() {
    this.wss.on('connection', (ws, request) => {
      const socketPort = request.socket.localPort ?? 3000;
      const url = new URL(request.url || '/ws', 'http://localhost');
      const targetPortParam = Number(url.searchParams.get('targetPort'));
      const effectivePort =
        Number.isInteger(targetPortParam) && this.ports.has(targetPortParam)
          ? targetPortParam
          : socketPort;
      const managed = this.ports.get(effectivePort);
      const roleParam = (url.searchParams.get('role') as PortRole | null) ?? managed?.binding.role ?? 'hub';
      const uidParam = url.searchParams.get('uid') ?? managed?.binding.deviceUid;

      this.clientMeta.set(ws, {
        port: effectivePort,
        role: roleParam,
        deviceUid: uidParam,
        alive: true,
      });

      if (managed) {
        managed.sockets.add(ws);
        managed.binding.wsClients = managed.sockets.size;
      }

      this.sendToClient(ws, {
        type: 'hello',
        port: effectivePort,
        deviceUid: uidParam,
        timestampUtc: new Date().toISOString(),
      });
      this.broadcast('ports:updated', { port: effectivePort });

      ws.on('pong', () => {
        const meta = this.clientMeta.get(ws);
        if (meta) meta.alive = true;
      });

      ws.on('message', (raw) => {
        try {
          const text = typeof raw === 'string' ? raw : raw.toString('utf8');
          const msg = JSON.parse(text) as Record<string, unknown>;
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({
              type: 'pong',
              clientTs: msg.clientTs,
              serverTs: Date.now(),
              port: effectivePort,
            }));
            return;
          }
          if (msg.type === 'client:telemetry' && typeof msg.deviceUid === 'string') {
            this.onLiveTelemetry?.({
              deviceUid: msg.deviceUid,
              cpuPct: typeof msg.cpuPct === 'number' ? msg.cpuPct : undefined,
              memoryPct: typeof msg.memoryPct === 'number' ? msg.memoryPct : undefined,
              latencyMs: typeof msg.latencyMs === 'number' ? msg.latencyMs : undefined,
              bandwidthMbps: typeof msg.bandwidthMbps === 'number' ? msg.bandwidthMbps : undefined,
              dataDeltaMb: typeof msg.dataDeltaMb === 'number' ? msg.dataDeltaMb : undefined,
              packetDelta: typeof msg.packetDelta === 'number' ? msg.packetDelta : undefined,
              source: typeof msg.source === 'string' ? msg.source : 'ws-browser',
            });
          }
        } catch {
          // Ignore malformed WS payloads cleanly
        }
      });

      ws.on('close', () => {
        this.clientMeta.delete(ws);
        if (managed) {
          managed.sockets.delete(ws);
          managed.binding.wsClients = managed.sockets.size;
        }
        this.broadcast('ports:updated', { port: effectivePort });
      });
    });

    this.heartbeatInterval = setInterval(() => {
      for (const [ws, meta] of this.clientMeta.entries()) {
        if (!meta.alive) {
          ws.terminate();
          this.clientMeta.delete(ws);
          continue;
        }
        meta.alive = false;
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
    }, 20000);
  }

  public configure(params: {
    app: Express;
    siteHtmlRenderer: (siteId: string, port: number, req: Request, res: Response) => boolean;
    onLiveTelemetry: (payload: LiveTelemetryCallbackPayload) => void;
  }): void {
    this.expressApp = params.app;
    this.siteHtmlRenderer = params.siteHtmlRenderer;
    this.onLiveTelemetry = params.onLiveTelemetry;
  }

  public getBindingForPort(port: number): ClusterPortBinding | undefined {
    return this.ports.get(port)?.binding;
  }

  public incrementPortRequest(port: number): void {
    const m = this.ports.get(port);
    if (m) m.binding.requestsServed += 1;
  }

  public listPorts(): ClusterPortBinding[] {
    return Array.from(this.ports.values())
      .map((m) => ({
        ...m.binding,
        wsClients: m.sockets.size,
      }))
      .sort((a, b) => a.port - b.port);
  }

  public totalWsClients(): number {
    let total = 0;
    for (const m of this.ports.values()) {
      total += m.sockets.size;
    }
    return total;
  }

  public async openPort(opts: {
    port?: number;
    role: PortRole;
    label?: string;
    deviceUid?: string;
    siteId?: string;
    primary?: boolean;
  }): Promise<{ ok: true; binding: ClusterPortBinding } | { ok: false; error: string }> {
    if (!this.expressApp) {
      return { ok: false, error: 'Cluster app handler is not configured yet.' };
    }

    const candidatePort = opts.port ?? this.findNextFreePort(3003, 3099);
    if (!Number.isInteger(candidatePort) || candidatePort < 3000 || candidatePort > 65535) {
      return { ok: false, error: 'Port must be between 3000 and 65535.' };
    }

    const existing = this.ports.get(candidatePort);
    if (existing) {
      // Update binding metadata cleanly if reopening non-primary port or already running
      existing.binding.role = opts.role;
      if (opts.label) existing.binding.label = opts.label;
      if (opts.deviceUid) existing.binding.deviceUid = opts.deviceUid;
      if (opts.siteId) existing.binding.siteId = opts.siteId;
      this.broadcast('ports:updated', { port: candidatePort });
      return { ok: true, binding: existing.binding };
    }

    const effectiveDeviceUid =
      opts.deviceUid || (opts.role === 'client' ? GLOBAL_TOPOLOGY[0].uid : undefined);
    const defaultLabel =
      opts.label ||
      (opts.role === 'hub'
        ? 'Primary Hub (World · Tier 1 · Tier 2)'
        : opts.role === 'client'
          ? `Tier 1 Client Portal (${effectiveDeviceUid?.slice(-10) ?? 'Node'})`
          : opts.role === 'saas'
            ? 'Tier 2 Regional SaaS Portal'
            : `Website Host (${opts.siteId ?? 'site'})`);

    const binding: ClusterPortBinding = {
      port: candidatePort,
      role: opts.role,
      label: defaultLabel,
      deviceUid: effectiveDeviceUid,
      siteId: opts.siteId,
      primary: Boolean(opts.primary),
      active: true,
      wsClients: 0,
      requestsServed: 0,
      startedAtUtc: new Date().toISOString(),
    };

    const server = http.createServer((req, res) => {
      binding.requestsServed += 1;
      const reqUrl = (req.url || '/').split('?')[0];
      if (
        binding.role === 'website' &&
        binding.siteId &&
        this.siteHtmlRenderer &&
        !reqUrl.startsWith('/api/') &&
        !reqUrl.startsWith('/hosted/')
      ) {
        if (this.siteHtmlRenderer(binding.siteId, candidatePort, req as Request, res as Response)) {
          return;
        }
      }
      this.expressApp!(req, res);
    });

    server.on('upgrade', (request, socket, head) => {
      const reqPath = (request.url || '').split('?')[0];
      if (reqPath === '/ws') {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    const listenResult = await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        resolve({
          ok: false,
          error: err.code === 'EADDRINUSE'
            ? `Port ${candidatePort} is already in use.`
            : err.message,
        });
      };
      server.once('error', onError);
      server.listen(candidatePort, '0.0.0.0', () => {
        server.removeListener('error', onError);
        resolve({ ok: true });
      });
    });

    if (!listenResult.ok) {
      return listenResult;
    }

    this.ports.set(candidatePort, {
      binding,
      server,
      sockets: new Set<WebSocket>(),
    });

    this.broadcast('ports:updated', { port: candidatePort });
    return { ok: true, binding };
  }

  public async closePort(port: number): Promise<{ ok: boolean; error?: string }> {
    const managed = this.ports.get(port);
    if (!managed) {
      return { ok: false, error: `Port ${port} is not active.` };
    }
    if (managed.binding.primary) {
      return { ok: false, error: `Cannot close primary port ${port}.` };
    }

    for (const ws of managed.sockets) {
      try {
        ws.close(1000, 'Port closed');
      } catch {
        // ignore
      }
    }
    managed.sockets.clear();

    await new Promise<void>((resolve) => {
      managed.server.close(() => resolve());
    });

    this.ports.delete(port);
    this.broadcast('ports:updated', { port });
    return { ok: true };
  }

  private findNextFreePort(start: number, end: number): number {
    for (let p = start; p <= end; p++) {
      if (!this.ports.has(p)) return p;
    }
    return end + 1;
  }

  private sendToClient(ws: WebSocket, msg: RealtimeMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  public broadcast(
    type: RealtimeEventType,
    extra: Omit<RealtimeMessage, 'type' | 'timestampUtc'> = {}
  ): void {
    const payload: RealtimeMessage = {
      type,
      ...extra,
      timestampUtc: new Date().toISOString(),
    };
    const encoded = JSON.stringify(payload);
    for (const ws of this.clientMeta.keys()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encoded);
      }
    }
  }

  /**
   * Optional separate-process coordination if a worker process boots with NEXAURA_HUB_URL=http://localhost:3000
   */
  public connectToExternalHub(hubUrl: string, onRemoteEvent: (msg: RealtimeMessage) => void): void {
    try {
      const parsed = new URL(hubUrl);
      const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      const targetWs = `${wsProtocol}//${parsed.host}/ws?role=peer`;
      const ws = new WebSocket(targetWs);
      this.hubPeerWs = ws;
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString('utf8')) as RealtimeMessage;
          onRemoteEvent(msg);
        } catch {
          // ignore
        }
      });
      ws.on('close', () => {
        this.hubPeerWs = null;
      });
      ws.on('error', () => {
        this.hubPeerWs = null;
      });
    } catch {
      // ignore invalid hub url
    }
  }

  public shutdown(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.hubPeerWs) this.hubPeerWs.close();
  }
}

export const clusterCoordinator = new ClusterCoordinator();
