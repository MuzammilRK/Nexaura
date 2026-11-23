import { validatePublicHttpUrl } from '../core/urlGuard';
import type { HostedWebsite, WebsiteProbeResult } from '../shared/schema';
import { GLOBAL_TOPOLOGY } from '../shared/topology';

const DEFAULT_SITES: Omit<HostedWebsite, 'requestsCount' | 'lastStatus' | 'avgLatencyMs' | 'lastAccessedUtc' | 'updatedAtUtc'>[] = [
  {
    siteId: 'nexaura-status',
    title: 'Nexaura Edge Status Portal',
    description: 'Live node diagnostics web app checking server API health in real time.',
    deviceUid: GLOBAL_TOPOLOGY[0].uid,
    tenantId: GLOBAL_TOPOLOGY[0].tenantId,
    boundPort: null,
    html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Nexaura Edge Status Portal</title>
  <style>
    body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:#0b0f17; color:#e2e8f0; padding:24px; }
    .card { max-width:680px; margin:0 auto; background:#121826; border:1px solid #243044; border-radius:10px; padding:20px; }
    h1 { margin:0 0 8px; font-size:18px; color:#fff; }
    .meta { font-size:12px; color:#94a3b8; margin-bottom:16px; }
    .row { display:flex; justify-content:space-between; padding:8px 0; border-top:1px solid #1e293b; font-family:monospace; font-size:12px; }
    .ok { color:#34d399; font-weight:600; }
    button { margin-top:14px; background:#2563eb; color:#fff; border:none; border-radius:6px; padding:8px 14px; font-size:12px; cursor:pointer; }
    button:hover { background:#1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Nexaura Edge Status Portal</h1>
    <div class="meta">Hosted live inside Nexaura Website Runner · Multi-port telemetry active</div>
    <div class="row"><span>Runtime Origin</span><span id="origin">-</span></div>
    <div class="row"><span>UTC Clock</span><span id="clock">-</span></div>
    <div class="row"><span>Live Probe Status</span><span class="ok" id="probe">ACTIVE</span></div>
    <div class="row"><span>Client Interaction Count</span><span id="hits">0</span></div>
    <button id="btn" type="button">Trigger Interactive Event</button>
  </div>
  <script>
    var hits = 0;
    document.getElementById('origin').textContent = window.location.origin || 'sandboxed-viewport';
    function tick() {
      document.getElementById('clock').textContent = new Date().toISOString();
    }
    tick();
    setInterval(tick, 1000);
    document.getElementById('btn').addEventListener('click', function () {
      hits += 1;
      document.getElementById('hits').textContent = String(hits);
      document.getElementById('probe').textContent = 'EVENT RECORDED #' + hits;
    });
  </script>
</body>
</html>`,
  },
  {
    siteId: 'fintech-ledger',
    title: 'FinTech Edge Settlement Desk',
    description: 'Local settlement verification portal running inside Tier 1 client network.',
    deviceUid: GLOBAL_TOPOLOGY[0].uid,
    tenantId: GLOBAL_TOPOLOGY[0].tenantId,
    boundPort: null,
    html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>FinTech Edge Settlement Desk</title>
  <style>
    body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:#09111a; color:#e5e7eb; padding:24px; }
    .wrap { max-width:700px; margin:0 auto; background:#101b27; border:1px solid #1f334a; border-radius:10px; padding:20px; }
    h1 { font-size:17px; margin:0 0 6px; color:#f8fafc; }
    p { font-size:12px; color:#94a3b8; margin:0 0 14px; }
    table { width:100%; border-collapse:collapse; font-family:monospace; font-size:12px; }
    th, td { text-align:left; padding:8px; border-bottom:1px solid #1e2d3d; }
    th { color:#94a3b8; }
    .badge { color:#34d399; }
    form { display:flex; gap:8px; margin-top:14px; }
    input { flex:1; background:#09111a; border:1px solid #26394d; color:#fff; border-radius:6px; padding:7px 10px; font-size:12px; }
    button { background:#059669; color:#fff; border:none; border-radius:6px; padding:7px 12px; font-size:12px; cursor:pointer; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>FinTech Edge Settlement Desk</h1>
    <p>Isolated customer application served via Nexaura Web Host.</p>
    <table>
      <thead><tr><th>Batch ID</th><th>Route</th><th>Status</th></tr></thead>
      <tbody id="rows">
        <tr><td>SET-9041</td><td>BLR-CORE-01</td><td class="badge">CLEARED</td></tr>
        <tr><td>SET-9042</td><td>MUM-EDGE-02</td><td class="badge">CLEARED</td></tr>
      </tbody>
    </table>
    <form id="f">
      <input id="batch" placeholder="New settlement ID (e.g. SET-9043)" value="SET-9043" />
      <button type="submit">Post Batch</button>
    </form>
  </div>
  <script>
    document.getElementById('f').addEventListener('submit', function(e) {
      e.preventDefault();
      var val = document.getElementById('batch').value.trim();
      if (!val) return;
      var tr = document.createElement('tr');
      var td1 = document.createElement('td');
      td1.textContent = val;
      var td2 = document.createElement('td');
      td2.textContent = 'LOCAL-HOSTED';
      var td3 = document.createElement('td');
      td3.className = 'badge';
      td3.textContent = 'VERIFIED';
      tr.appendChild(td1);
      tr.appendChild(td2);
      tr.appendChild(td3);
      document.getElementById('rows').prepend(tr);
      document.getElementById('batch').value = 'SET-' + (Math.floor(Math.random() * 9000) + 1000);
    });
  </script>
</body>
</html>`,
  },
  {
    siteId: 'ops-runbook',
    title: 'SRE Incident Checklist App',
    description: 'Interactive engineering diagnostics runbook hosted on Nexaura node.',
    deviceUid: GLOBAL_TOPOLOGY[0].uid,
    tenantId: GLOBAL_TOPOLOGY[0].tenantId,
    boundPort: null,
    html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>SRE Incident Checklist App</title>
  <style>
    body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:#0d1017; color:#e2e8f0; padding:24px; }
    .panel { max-width:660px; margin:0 auto; background:#141923; border:1px solid #262f40; border-radius:10px; padding:20px; }
    h1 { font-size:17px; margin:0 0 10px; }
    label { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid #232c3d; border-radius:6px; margin-bottom:8px; font-size:13px; cursor:pointer; }
    .pct { font-family:monospace; color:#60a5fa; font-size:12px; margin-top:10px; }
  </style>
</head>
<body>
  <div class="panel">
    <h1>Site Reliability Runbook</h1>
    <label><input type="checkbox" checked /> Verify collector heartbeat &amp; edge mTLS tunnel</label>
    <label><input type="checkbox" /> Confirm regional spool queue drained with zero dupes</label>
    <label><input type="checkbox" /> Validate Edge Router packet loss below 0.5%</label>
    <div class="pct" id="pct">Completion: 1 / 3 verified</div>
  </div>
  <script>
    var boxes = Array.prototype.slice.call(document.querySelectorAll('input[type="checkbox"]'));
    function update() {
      var done = boxes.filter(function(b) { return b.checked; }).length;
      document.getElementById('pct').textContent = 'Completion: ' + done + ' / ' + boxes.length + ' verified';
    }
    boxes.forEach(function(b) { b.addEventListener('change', update); });
  </script>
</body>
</html>`,
  },
];

function extractHtmlTitle(htmlSnippet: string): string {
  const m = htmlSnippet.match(/<title[^>]*>([\s\S]{1,120}?)<\/title>/i);
  if (!m) return 'Untitled Page';
  return m[1].replace(/\s+/g, ' ').trim() || 'Untitled Page';
}

export class WebsiteRunnerService {
  private sites = new Map<string, HostedWebsite>();
  private recentProbes: WebsiteProbeResult[] = [];

  constructor() {
    const nowIso = new Date().toISOString();
    for (const s of DEFAULT_SITES) {
      this.sites.set(s.siteId, {
        ...s,
        requestsCount: 0,
        lastStatus: 200,
        avgLatencyMs: 4.2,
        lastAccessedUtc: null,
        updatedAtUtc: nowIso,
      });
    }
  }

  public listSites(): HostedWebsite[] {
    return Array.from(this.sites.values());
  }

  public getSite(siteId: string): HostedWebsite | undefined {
    return this.sites.get(siteId);
  }

  public upsertSite(input: {
    siteId?: string;
    title: string;
    description?: string;
    deviceUid: string;
    html: string;
  }): HostedWebsite {
    const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === input.deviceUid) ?? GLOBAL_TOPOLOGY[0];
    const cleanId = (input.siteId || input.title)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `site-${Date.now().toString(36)}`;

    const existing = this.sites.get(cleanId);
    const site: HostedWebsite = {
      siteId: cleanId,
      title: input.title.trim().slice(0, 80) || cleanId,
      description: (input.description ?? 'Custom hosted web application').trim().slice(0, 200),
      deviceUid: dev.uid,
      tenantId: dev.tenantId,
      html: input.html,
      boundPort: existing?.boundPort ?? null,
      requestsCount: existing?.requestsCount ?? 0,
      lastStatus: existing?.lastStatus ?? 200,
      avgLatencyMs: existing?.avgLatencyMs ?? 3.5,
      lastAccessedUtc: existing?.lastAccessedUtc ?? null,
      updatedAtUtc: new Date().toISOString(),
    };
    this.sites.set(cleanId, site);
    return site;
  }

  public setSiteBoundPort(siteId: string, port: number | null): void {
    const s = this.sites.get(siteId);
    if (s) {
      s.boundPort = port;
      s.updatedAtUtc = new Date().toISOString();
    }
  }

  public recordSiteHit(siteId: string, status: number, latencyMs: number): HostedWebsite | undefined {
    const s = this.sites.get(siteId);
    if (!s) return undefined;
    s.requestsCount += 1;
    s.lastStatus = status;
    s.avgLatencyMs = Number(((s.avgLatencyMs * 0.75) + (latencyMs * 0.25)).toFixed(2));
    s.lastAccessedUtc = new Date().toISOString();
    return s;
  }

  public getRecentProbes(): WebsiteProbeResult[] {
    return this.recentProbes;
  }

  public async probeExternalUrl(
    rawUrl: string,
    deviceUid: string
  ): Promise<{ ok: true; probe: WebsiteProbeResult } | { ok: false; status: number; error: string }> {
    const check = await validatePublicHttpUrl(rawUrl);
    if (!check.ok) {
      return { ok: false, status: 403, error: check.reason };
    }

    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5500);

    try {
      const response = await fetch(check.url.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Nexaura-EdgeBrowser/1.0',
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        },
      });
      clearTimeout(timer);

      const latencyMs = Number(Math.max(1, performance.now() - started).toFixed(1));
      const contentType = response.headers.get('content-type') || 'text/html';
      const xFrame = (response.headers.get('x-frame-options') || '').toLowerCase();
      const csp = (response.headers.get('content-security-policy') || '').toLowerCase();

      let frameRestrictionReason: string | null = null;
      if (xFrame.includes('deny') || xFrame.includes('sameorigin')) {
        frameRestrictionReason = `Target header X-Frame-Options: ${xFrame.toUpperCase()} blocks embedded viewport rendering.`;
      } else if (csp.includes('frame-ancestors') && !csp.includes('frame-ancestors *')) {
        frameRestrictionReason = 'Target Content-Security-Policy restricts frame-ancestors embedding.';
      }

      const buf = await response.arrayBuffer();
      const bytesReceived = buf.byteLength;
      const snippet = new TextDecoder().decode(buf.slice(0, 65_536));
      const title = contentType.includes('html') ? extractHtmlTitle(snippet) : check.url.hostname;

      const probe: WebsiteProbeResult = {
        url: check.url.toString(),
        statusCode: response.status,
        ok: response.status >= 200 && response.status < 400,
        latencyMs,
        bytesReceived,
        contentType,
        title,
        frameable: !frameRestrictionReason && response.status < 400,
        frameRestrictionReason,
        fetchedAtUtc: new Date().toISOString(),
        deviceUid,
      };
      this.recentProbes.unshift(probe);
      this.recentProbes = this.recentProbes.slice(0, 20);
      return { ok: true, probe };
    } catch (err) {
      clearTimeout(timer);
      return {
        ok: false,
        status: 502,
        error: err instanceof Error && err.name === 'AbortError'
          ? 'Target website timed out (>5.5s).'
          : `Unable to fetch target website: ${err instanceof Error ? err.message : 'network error'}`,
      };
    }
  }
}

export const websiteRunner = new WebsiteRunnerService();
