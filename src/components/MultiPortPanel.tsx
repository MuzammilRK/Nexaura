import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Check,
  Copy,
  ExternalLink,
  Network,
  Plus,
  Radio,
  Trash2,
  X,
} from 'lucide-react';
import { useNexauraStore } from '../state/useNexauraStore';
import type { ClusterPortBinding, HostTelemetrySample, PortRole } from '../shared/schema';
import { GLOBAL_TOPOLOGY } from '../shared/topology';
import { buildPortOpenUrl } from '../shared/portUrl';

interface PortsApiResponse {
  ports: ClusterPortBinding[];
  totalWsClients: number;
}

interface MultiPortPanelProps {
  authToken?: string;
  hostTelemetry?: HostTelemetrySample | null;
}

function buildPortHref(port: number): string {
  return buildPortOpenUrl(port);
}

export function MultiPortPanel({ authToken, hostTelemetry }: MultiPortPanelProps) {
  const {
    runtimePort,
    portRole,
    activePorts,
    wsConnected,
    wsLastRttMs,
    setScreen,
    setWorldFocus,
  } = useNexauraStore();

  const [open, setOpen] = useState(false);
  const [newRole, setNewRole] = useState<PortRole>('client');
  const [newPort, setNewPort] = useState('');
  const [newDeviceUid, setNewDeviceUid] = useState(GLOBAL_TOPOLOGY[0].uid);
  const [copiedPort, setCopiedPort] = useState<number | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, refetch } = useQuery<PortsApiResponse>({
    queryKey: ['cluster-ports'],
    queryFn: async () => {
      const r = await fetch('/api/cluster/ports');
      if (!r.ok) throw new Error('Failed to load cluster ports');
      return r.json();
    },
    refetchInterval: 20000,
    refetchOnWindowFocus: false,
  });

  const ports = data?.ports ?? activePorts;
  const totalWs = data?.totalWsClients ?? 0;

  const copyPortUrl = (port: number) => {
    const href = buildPortHref(port);
    navigator.clipboard?.writeText(href).catch(() => undefined);
    setCopiedPort(port);
    window.setTimeout(() => setCopiedPort((cur) => (cur === port ? null : cur)), 1500);
  };

  const handleOpenPort = async (e: FormEvent) => {
    e.preventDefault();
    if (!authToken) {
      setStatusMsg('Sign in to a Tier 1 device or Tier 2 SaaS admin to bind new runtime ports.');
      return;
    }
    setBusy(true);
    setStatusMsg(null);
    try {
      const parsedPort = newPort.trim() ? Number(newPort.trim()) : undefined;
      const res = await fetch('/api/cluster/ports/open', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          port: parsedPort,
          role: newRole,
          deviceUid: newRole === 'client' ? newDeviceUid : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setStatusMsg(body.error || 'Unable to bind port.');
      } else {
        setStatusMsg(`Bound live HTTP/WS portal on port :${body.binding.port} (${body.binding.role}).`);
        setNewPort('');
        refetch();
      }
    } catch {
      setStatusMsg('Network error opening port.');
    } finally {
      setBusy(false);
    }
  };

  const handleClosePort = async (port: number) => {
    if (!authToken) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/cluster/ports/close', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ port }),
      });
      const body = await res.json();
      if (!res.ok) {
        setStatusMsg(body.error || 'Unable to close port.');
      } else {
        setStatusMsg(`Closed coordinated port :${port}.`);
        refetch();
      }
    } finally {
      setBusy(false);
    }
  };

  const switchRoleInTab = (binding: ClusterPortBinding) => {
    setOpen(false);
    if (binding.role === 'saas') {
      setScreen('super-login');
    } else if (binding.role === 'client') {
      const dev = GLOBAL_TOPOLOGY.find((d) => d.uid === binding.deviceUid) ?? GLOBAL_TOPOLOGY[0];
      setWorldFocus({
        level: 'device',
        countryCode: dev.countryCode,
        cityCode: dev.cityCode,
        districtCode: dev.districtCode,
        buildingCode: dev.buildingCode,
        floorNumber: dev.floorNumber,
        deviceUid: dev.uid,
      });
      setScreen('device-login');
    } else {
      setScreen('world');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          refetch();
        }}
        data-testid="multiport-trigger"
        className="inline-flex items-center gap-2 rounded-md border border-[#2B3242] bg-[#141821] px-2.5 py-1.5 text-[11px] font-medium text-zinc-200 hover:bg-[#1D2330] transition-colors whitespace-nowrap shrink-0"
      >
        <span
          className={`h-2 w-2 rounded-full ${
            wsConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
          }`}
        />
        <Network className="h-3.5 w-3.5 text-blue-400" />
        <span className="font-mono tabular-nums">
          :{runtimePort} ({portRole}) · {ports.length || 1} Ports
        </span>
        {wsLastRttMs !== null && (
          <span className="hidden xl:inline font-mono text-emerald-400 tabular-nums">
            {wsLastRttMs}ms
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs">
          <div className="w-full max-w-2xl rounded-xl border border-[#2B3242] bg-[#10141C] text-zinc-100 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#222733] px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <Radio className={`h-4 w-4 ${wsConnected ? 'text-emerald-400' : 'text-amber-400'}`} />
                <div>
                  <h2 className="text-sm font-semibold text-white">
                    Multi-Port Cluster &amp; Real-Time Coordination
                  </h2>
                  <p className="text-[11px] text-zinc-400">
                    Open Client and SaaS on separate ports simultaneously — every fault, log, policy, and site hit syncs via shared WebSocket hub.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close port coordinator"
                className="rounded-md border border-[#2B3242] bg-[#1A1E28] p-1.5 text-zinc-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[75vh] overflow-y-auto p-5 space-y-4 text-xs">
              {hostTelemetry && (
                <div className="rounded-lg border border-[#222733] bg-[#0B0D11] p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <span className="font-semibold text-emerald-400">
                      Live OS Stream ({hostTelemetry.sourceKind}) · {hostTelemetry.hostname}
                    </span>
                    <span className="font-mono text-zinc-400 tabular-nums">
                      NIC {hostTelemetry.interfaceName} · WS RTT {wsLastRttMs ?? '--'}ms · {totalWs} WS Peer(s)
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px] tabular-nums">
                    <div className="rounded border border-[#1E2430] bg-[#12161F] px-2.5 py-1.5">
                      <div className="text-zinc-400">Host CPU</div>
                      <div className="text-white font-semibold">{hostTelemetry.cpuPct}% ({hostTelemetry.cpuCores}c)</div>
                    </div>
                    <div className="rounded border border-[#1E2430] bg-[#12161F] px-2.5 py-1.5">
                      <div className="text-zinc-400">Host RAM</div>
                      <div className="text-white font-semibold">
                        {hostTelemetry.memoryPct}% ({hostTelemetry.memoryUsedGb}/{hostTelemetry.memoryTotalGb} GB)
                      </div>
                    </div>
                    <div className="rounded border border-[#1E2430] bg-[#12161F] px-2.5 py-1.5">
                      <div className="text-zinc-400">Root Disk</div>
                      <div className="text-white font-semibold">
                        {hostTelemetry.diskPct}% ({hostTelemetry.diskUsedGb}/{hostTelemetry.diskTotalGb} GB)
                      </div>
                    </div>
                    <div className="rounded border border-[#1E2430] bg-[#12161F] px-2.5 py-1.5">
                      <div className="text-zinc-400">Load / RSS</div>
                      <div className="text-white font-semibold">
                        {hostTelemetry.loadAvg1m} · {hostTelemetry.processRssMb} MB
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Active Coordinated Ports */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">Active Coordinated Ports ({ports.length})</span>
                  <span className="font-mono text-[11px] text-zinc-400">
                    Current Window: :{runtimePort} ({portRole})
                  </span>
                </div>

                {ports.map((b) => {
                  const href = buildPortHref(b.port);
                  const isCurrent = b.port === runtimePort;
                  return (
                    <div
                      key={b.port}
                      className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 ${
                        isCurrent
                          ? 'border-blue-500/40 bg-blue-500/10'
                          : 'border-[#222733] bg-[#12151C]'
                      }`}
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-white tabular-nums">
                            :{b.port}
                          </span>
                          <span className="rounded border border-[#2B3242] bg-[#0B0D11] px-1.5 py-0.5 font-mono text-[10px] uppercase text-blue-300">
                            {b.role}
                          </span>
                          {isCurrent && (
                            <span className="text-[10px] font-medium text-emerald-400">Current Port</span>
                          )}
                        </div>
                        <div className="text-[11px] text-zinc-400 truncate">
                          {b.label} · {b.wsClients} WS · {b.requestsServed} HTTP reqs
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => copyPortUrl(b.port)}
                          className="inline-flex items-center gap-1 rounded border border-[#2B3242] bg-[#1A1E28] px-2 py-1 text-[11px] text-zinc-200 hover:bg-[#232836]"
                        >
                          {copiedPort === b.port ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                          {copiedPort === b.port ? 'Copied' : 'Copy URL'}
                        </button>
                        {b.role !== 'website' && (
                          <button
                            type="button"
                            onClick={() => switchRoleInTab(b)}
                            className="rounded border border-[#2B3242] bg-[#1A1E28] px-2 py-1 text-[11px] text-zinc-200 hover:bg-[#232836]"
                          >
                            Switch View
                          </button>
                        )}
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-500"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Open :{b.port}
                        </a>
                        {!b.primary && authToken && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleClosePort(b.port)}
                            aria-label={`Close port ${b.port}`}
                            className="rounded border border-rose-500/30 bg-rose-500/10 p-1 text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Spawn Additional Coordinated Port */}
              <form onSubmit={handleOpenPort} className="rounded-lg border border-[#222733] bg-[#0B0D11] p-3.5 space-y-3">
                <div className="font-semibold text-white">Open Additional Coordinated Port</div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <div>
                    <label className="block text-[11px] text-zinc-400">Role</label>
                    <select
                      value={newRole}
                      onChange={(e) => setNewRole(e.target.value as PortRole)}
                      className="mt-1 w-full rounded border border-[#2B3242] bg-[#12151C] px-2 py-1.5 text-xs text-white"
                    >
                      <option value="client">Tier 1 Client Portal</option>
                      <option value="saas">Tier 2 Regional SaaS</option>
                      <option value="hub">Full Hub Portal</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-zinc-400">Port (3001-3099 or Auto)</label>
                    <input
                      type="number"
                      min={3001}
                      max={3099}
                      value={newPort}
                      onChange={(e) => setNewPort(e.target.value)}
                      placeholder="Auto (e.g. 3003)"
                      className="mt-1 w-full rounded border border-[#2B3242] bg-[#12151C] px-2 py-1.5 text-xs text-white font-mono"
                    />
                  </div>

                  {newRole === 'client' ? (
                    <div>
                      <label className="block text-[11px] text-zinc-400">Target Client Node</label>
                      <select
                        value={newDeviceUid}
                        onChange={(e) => setNewDeviceUid(e.target.value)}
                        className="mt-1 w-full rounded border border-[#2B3242] bg-[#12151C] px-2 py-1.5 text-xs text-white"
                      >
                        {GLOBAL_TOPOLOGY.slice(0, 12).map((d) => (
                          <option key={d.uid} value={d.uid}>
                            {d.cityCode} · {d.hostname}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="flex items-end">
                      <button
                        type="submit"
                        disabled={busy || !authToken}
                        className="w-full inline-flex items-center justify-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Bind Port
                      </button>
                    </div>
                  )}
                </div>
                {newRole === 'client' && (
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={busy || !authToken}
                      className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Bind Client Port
                    </button>
                  </div>
                )}
                {!authToken && (
                  <p className="text-[11px] text-amber-400">
                    Ports 3000, 3001 (Client), and 3002 (SaaS) are already active. Sign in first to dynamically open extra ports (3003+).
                  </p>
                )}
                {statusMsg && <p className="text-[11px] text-blue-400">{statusMsg}</p>}
              </form>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
