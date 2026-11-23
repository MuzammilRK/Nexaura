import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Code2,
  ExternalLink,
  Globe,
  Play,
  RefreshCw,
  Server,
  ShieldAlert,
  Square,
} from 'lucide-react';
import type { HostedWebsite, WebsiteProbeResult } from '../shared/schema';
import { buildPortOpenUrl } from '../shared/portUrl';

interface WebsitesApiResponse {
  sites: HostedWebsite[];
  recentProbes: WebsiteProbeResult[];
}

interface WebsiteRunnerAppProps {
  deviceUid: string;
  token: string;
  onTrafficRecorded: () => void;
}

type RunnerMode = 'hosted' | 'external' | 'studio';

const STARTER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Custom Nexaura Web App</title>
  <style>
    body { margin:0; font-family: system-ui, sans-serif; background:#090d14; color:#e2e8f0; padding:24px; }
    .box { max-width:560px; margin:0 auto; background:#121826; border:1px solid #263145; border-radius:10px; padding:20px; }
    h1 { margin:0 0 8px; font-size:18px; color:#fff; }
    p { font-size:13px; color:#94a3b8; }
    button { margin-top:12px; background:#2563eb; color:#fff; border:none; border-radius:6px; padding:8px 14px; cursor:pointer; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Custom Hosted Web App</h1>
    <p>Served directly from Nexaura Node HTTP engine with real Edge Router telemetry tracking.</p>
    <div id="out" style="font-family:monospace; color:#34d399; margin-top:10px;">Ready.</div>
    <button type="button" onclick="document.getElementById('out').textContent='Executed live JS event at ' + new Date().toISOString();">Run Action</button>
  </div>
</body>
</html>`;

export function WebsiteRunnerApp({ deviceUid, token, onTrafficRecorded }: WebsiteRunnerAppProps) {
  const [mode, setMode] = useState<RunnerMode>('hosted');
  const [selectedSiteId, setSelectedSiteId] = useState<string>('nexaura-status');
  const [reloadNonce, setReloadNonce] = useState<number>(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // External website runner state
  const [targetUrl, setTargetUrl] = useState('https://example.com');
  const [activeProbe, setActiveProbe] = useState<WebsiteProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  // Site studio editor state
  const [draftTitle, setDraftTitle] = useState('Branch Treasury Portal');
  const [draftDesc, setDraftDesc] = useState('Live client web micro-app served on local node');
  const [draftHtml, setDraftHtml] = useState(STARTER_HTML);

  const { data, refetch } = useQuery<WebsitesApiResponse>({
    queryKey: ['hosted-websites', deviceUid],
    enabled: Boolean(token),
    queryFn: async () => {
      const r = await fetch('/api/websites', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error('Failed to load hosted websites');
      return r.json();
    },
    refetchInterval: 20000,
    refetchOnWindowFocus: false,
  });

  const sites = data?.sites ?? [];
  const activeSite = sites.find((s) => s.siteId === selectedSiteId) ?? sites[0] ?? null;

  const handleRunHosted = () => {
    setReloadNonce((n) => n + 1);
    onTrafficRecorded();
    refetch();
  };

  const handlePublishPort = async (site: HostedWebsite) => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/websites/${encodeURIComponent(site.siteId)}/publish-port`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      if (!res.ok) {
        setFeedback(body.error || 'Unable to bind website port.');
      } else {
        setFeedback(`Website "${site.title}" is now running live on port :${body.binding.port}.`);
        refetch();
        onTrafficRecorded();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleUnpublishPort = async (site: HostedWebsite) => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/websites/${encodeURIComponent(site.siteId)}/unpublish-port`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      const body = await res.json();
      if (!res.ok) {
        setFeedback(body.error || 'Failed to stop website port.');
      } else {
        setFeedback(`Stopped standalone port listener for "${site.title}".`);
        refetch();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleProbeUrl = async (e?: FormEvent, overrideUrl?: string) => {
    e?.preventDefault();
    const urlToRun = (overrideUrl ?? targetUrl).trim();
    if (!urlToRun) return;
    if (overrideUrl) setTargetUrl(overrideUrl);

    setBusy(true);
    setProbeError(null);
    setFeedback(null);
    try {
      const res = await fetch('/api/browser/probe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: urlToRun, deviceUid }),
      });
      const body = await res.json();
      if (!res.ok) {
        setProbeError(body.error || 'Request blocked or unreachable.');
        setActiveProbe(null);
      } else {
        setActiveProbe(body.probe);
        onTrafficRecorded();
        refetch();
      }
    } catch {
      setProbeError('Failed to reach Nexaura web proxy.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveCustomSite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/websites', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: draftTitle,
          description: draftDesc,
          deviceUid,
          html: draftHtml,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setFeedback(body.error || 'Failed to save website.');
      } else {
        setSelectedSiteId(body.site.siteId);
        setMode('hosted');
        setReloadNonce((n) => n + 1);
        setFeedback(`Saved and launched "${body.site.title}" on /hosted/${body.site.siteId}.`);
        refetch();
        onTrafficRecorded();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-5 space-y-4 text-xs">
      {/* Mode Switcher Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#222733] bg-[#12151C] p-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Nexaura Web Runner &amp; Live Site Host</h2>
          <p className="text-[11px] text-zinc-400">
            Run isolated web apps on dedicated coordinated ports or inspect live external websites with Edge Router telemetry capture.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-[#2B3242] bg-[#0B0D11] p-1">
          <button
            type="button"
            onClick={() => setMode('hosted')}
            className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-medium ${
              mode === 'hosted' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Server className="h-3.5 w-3.5" />
            Hosted Sites ({sites.length})
          </button>
          <button
            type="button"
            onClick={() => setMode('external')}
            className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-medium ${
              mode === 'external' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            Run External URL
          </button>
          <button
            type="button"
            onClick={() => setMode('studio')}
            className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-medium ${
              mode === 'studio' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Code2 className="h-3.5 w-3.5" />
            Build Website
          </button>
        </div>
      </div>

      {feedback && (
        <div className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-blue-300">
          {feedback}
        </div>
      )}

      {/* Mode 1: Run Hosted Sites & Publish to Dedicated Coordinated Ports */}
      {mode === 'hosted' && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-2.5">
            {sites.map((s) => {
              const selected = activeSite?.siteId === s.siteId;
              const portHref = s.boundPort ? buildPortOpenUrl(s.boundPort) : null;
              return (
                <div
                  key={s.siteId}
                  onClick={() => {
                    setSelectedSiteId(s.siteId);
                    setReloadNonce((n) => n + 1);
                  }}
                  className={`cursor-pointer rounded-lg border p-3 transition-colors ${
                    selected
                      ? 'border-blue-500/50 bg-blue-500/10'
                      : 'border-[#222733] bg-[#12151C] hover:border-[#2E3647]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-semibold text-white">{s.title}</div>
                    {s.boundPort ? (
                      <span className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
                        :{s.boundPort} LIVE
                      </span>
                    ) : (
                      <span className="rounded border border-[#2B3242] bg-[#0B0D11] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                        /hosted/{s.siteId}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-400">{s.description}</p>
                  <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-zinc-400 tabular-nums">
                    <span>Hits: {s.requestsCount} · Avg RTT: {s.avgLatencyMs}ms</span>
                    <span>HTTP {s.lastStatus}</span>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
                    {s.boundPort && portHref ? (
                      <>
                        <a
                          href={portHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Open :{s.boundPort}
                        </a>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleUnpublishPort(s)}
                          className="inline-flex items-center gap-1 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20"
                        >
                          <Square className="h-3 w-3" />
                          Stop Port
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handlePublishPort(s)}
                        className="inline-flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-500"
                      >
                        <Play className="h-3 w-3" />
                        Run on Live Port
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="lg:col-span-2 flex flex-col rounded-lg border border-[#222733] bg-[#0B0D11] overflow-hidden">
            {activeSite ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222733] bg-[#12151C] px-3 py-2">
                  <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-300 truncate">
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    <span>
                      {activeSite.boundPort
                        ? buildPortOpenUrl(activeSite.boundPort)
                        : `${window.location.origin}/hosted/${activeSite.siteId}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleRunHosted}
                      className="inline-flex items-center gap-1 rounded border border-[#2B3242] bg-[#1A1E28] px-2 py-1 text-[11px] text-zinc-200 hover:bg-[#232836]"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Reload
                    </button>
                    <a
                      href={
                        activeSite.boundPort
                          ? buildPortOpenUrl(activeSite.boundPort)
                          : `/hosted/${encodeURIComponent(activeSite.siteId)}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded border border-[#2B3242] bg-[#1A1E28] px-2 py-1 text-[11px] text-zinc-200 hover:bg-[#232836]"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Pop Out
                    </a>
                  </div>
                </div>
                <iframe
                  key={`${activeSite.siteId}-${activeSite.boundPort ?? 'hosted'}-${reloadNonce}`}
                  title={activeSite.title}
                  src={
                    activeSite.boundPort
                      ? `/p/${activeSite.boundPort}/?v=${reloadNonce}`
                      : `/hosted/${encodeURIComponent(activeSite.siteId)}?v=${reloadNonce}`
                  }
                  sandbox="allow-scripts allow-forms"
                  className="h-[380px] w-full bg-[#090B0E]"
                />
              </>
            ) : (
              <div className="p-8 text-center text-zinc-400">Select a hosted website to run.</div>
            )}
          </div>
        </div>
      )}

      {/* Mode 2: External Public URL Probe & Sandboxed Browser Viewport */}
      {mode === 'external' && (
        <div className="space-y-4">
          <form onSubmit={(e) => handleProbeUrl(e)} className="flex flex-wrap gap-2">
            <input
              type="url"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://example.com"
              className="flex-1 min-w-[240px] rounded-md border border-[#2B3242] bg-[#0B0D11] px-3 py-2 font-mono text-xs text-white"
            />
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              {busy ? 'Loading...' : 'Run Website'}
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-zinc-400">Quick Presets:</span>
            {[
              'https://example.com',
              'https://httpbin.org/html',
              'https://www.wikipedia.org',
            ].map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => handleProbeUrl(undefined, u)}
                className="rounded border border-[#2B3242] bg-[#12151C] px-2 py-1 font-mono text-zinc-300 hover:text-white"
              >
                {u}
              </button>
            ))}
          </div>

          {probeError && (
            <div className="flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-rose-300">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              <span>{probeError}</span>
            </div>
          )}

          {activeProbe && (
            <div className="rounded-lg border border-[#222733] bg-[#0B0D11] overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222733] bg-[#12151C] px-4 py-2.5 font-mono text-[11px]">
                <div className="flex items-center gap-3">
                  <span className={activeProbe.ok ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'}>
                    HTTP {activeProbe.statusCode}
                  </span>
                  <span className="text-white truncate max-w-sm">{activeProbe.title}</span>
                  <span className="text-zinc-400">{activeProbe.latencyMs}ms · {activeProbe.bytesReceived} B</span>
                </div>
                <a
                  href={activeProbe.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded border border-[#2B3242] bg-[#1A1E28] px-2.5 py-1 text-zinc-200 hover:text-white"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open Externally
                </a>
              </div>

              {activeProbe.frameable ? (
                <iframe
                  title={activeProbe.title}
                  src={activeProbe.url}
                  sandbox="allow-scripts allow-forms allow-popups"
                  className="h-[380px] w-full bg-white"
                />
              ) : (
                <div className="p-6 space-y-2 text-zinc-300">
                  <div className="flex items-center gap-2 font-semibold text-amber-400">
                    <AlertTriangle className="h-4 w-4" />
                    Iframe Embedding Restricted by Target Site
                  </div>
                  <p className="text-zinc-400">
                    {activeProbe.frameRestrictionReason ?? 'Remote site prevented embedded iframe preview.'}
                  </p>
                  <p className="font-mono text-[11px] text-zinc-400">
                    Edge Router still measured {activeProbe.bytesReceived} bytes across {activeProbe.latencyMs}ms RTT and logged the session telemetry cleanly.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Mode 3: Build & Run Custom HTML/CSS/JS Website */}
      {mode === 'studio' && (
        <form onSubmit={handleSaveCustomSite} className="rounded-lg border border-[#222733] bg-[#12151C] p-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-[11px] text-zinc-300">Website Title</label>
              <input
                type="text"
                required
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                className="mt-1 w-full rounded border border-[#2B3242] bg-[#0B0D11] px-2.5 py-1.5 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-300">Description</label>
              <input
                type="text"
                value={draftDesc}
                onChange={(e) => setDraftDesc(e.target.value)}
                className="mt-1 w-full rounded border border-[#2B3242] bg-[#0B0D11] px-2.5 py-1.5 text-xs text-white"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-zinc-300">HTML / CSS / JS Source</label>
            <textarea
              rows={11}
              required
              value={draftHtml}
              onChange={(e) => setDraftHtml(e.target.value)}
              className="mt-1 w-full rounded border border-[#2B3242] bg-[#090B0E] p-3 font-mono text-[11px] text-emerald-300 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              Save &amp; Launch Website
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
