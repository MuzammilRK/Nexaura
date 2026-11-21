import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  FolderOpen,
  Terminal as TerminalIcon,
  Shield,
  FileText,
  Lock,
  Briefcase,
  Globe2,
  LogOut,
  Send,
  ScrollText,
  ArrowDownLeft,
  ArrowUpRight,
  Download,
} from 'lucide-react';
import { useNexauraStore, type DesktopAppId } from '../state/useNexauraStore';
import { CollectorConsole, type ReconcileSummary } from './CollectorConsole';
import { StructuredLogsPanel } from './StructuredLogsPanel';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import type {
  DeviceProfile,
  EgressProofRecord,
  EncryptedFileTransfer,
  HealthEvaluation,
  LiveDeviceMetrics,
  SpoolEntry,
  WindowsLogEntry,
} from '../shared/schema';
import { GLOBAL_TOPOLOGY } from '../shared/topology';
import { shortDeviceUid, shortHash, shortTimeUtc } from '../shared/formatters';

interface CollectorDeviceResponse {
  device: DeviceProfile;
  metrics: LiveDeviceMetrics;
  health: HealthEvaluation;
  rawLogs: WindowsLogEntry[];
  egressLog: EgressProofRecord[];
  spool: SpoolEntry[];
  spoolDepth: number;
  droppedLowSeverityTotal: number;
  outageActive: boolean;
  lastHeartbeatUtc: string;
  reconcile: ReconcileSummary;
  transfers: EncryptedFileTransfer[];
  peerDevices: {
    uid: string;
    hostname: string;
    tenantId: string;
    cityName: string;
    industry: string;
  }[];
}

const WALLPAPER_GRADIENTS: Record<DeviceProfile['wallpaperStyle'], string> = {
  'cobalt-grid': 'from-[#0B0D11] via-[#101827] to-[#0B0D11]',
  'emerald-prism': 'from-[#0B0D11] via-[#0E1A18] to-[#0B0D11]',
  'amber-circuit': 'from-[#0B0D11] via-[#1B160E] to-[#0B0D11]',
  'indigo-wave': 'from-[#0B0D11] via-[#131424] to-[#0B0D11]',
  'teal-slate': 'from-[#0B0D11] via-[#0F191E] to-[#0B0D11]',
  'cyan-horizon': 'from-[#0B0D11] via-[#0F1722] to-[#0B0D11]',
};

type TransferFilter = 'all' | 'sent' | 'received';

export function Tier1Desktop() {
  const {
    deviceSession,
    worldFocus,
    activeDesktopApp,
    setActiveDesktopApp,
    setDeviceSession,
    setScreen,
  } = useNexauraStore();

  const targetUid = deviceSession?.deviceUid ?? worldFocus.deviceUid ?? GLOBAL_TOPOLOGY[0].uid;

  const { data, isLoading, isError, refetch } = useQuery<CollectorDeviceResponse>({
    queryKey: ['collector-device', targetUid, deviceSession?.token],
    enabled: Boolean(deviceSession?.token),
    queryFn: async () => {
      const r = await fetch(`/api/collector/device/${encodeURIComponent(targetUid)}`, {
        headers: { Authorization: `Bearer ${deviceSession!.token}` },
      });
      if (!r.ok) throw new Error('Failed to load Tier 1 device state');
      return r.json();
    },
    refetchInterval: 4000,
  });

  // Terminal state
  const [termCmd, setTermCmd] = useState('');
  const [termHistory, setTermHistory] = useState<string[]>([
    `Nexaura WinShell [${shortDeviceUid(targetUid)}]`,
    'Type "help", "uid", "status", or "whoami".',
  ]);

  // CipherShare Mesh state
  const [peerUid, setPeerUid] = useState('');
  const [fileName, setFileName] = useState('audit-bundle-2026.zip');
  const [crossApprove, setCrossApprove] = useState(false);
  const [meshMsg, setMeshMsg] = useState<string | null>(null);
  const [transferFilter, setTransferFilter] = useState<TransferFilter>('all');

  if (!deviceSession) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0B0D11] text-zinc-200">
        <button
          type="button"
          onClick={() => setScreen('device-login')}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          Sign In to Device
        </button>
      </div>
    );
  }

  const device = data?.device;
  const accent = device?.accentHex ?? '#3b82f6';
  const wallpaper = device ? WALLPAPER_GRADIENTS[device.wallpaperStyle] : WALLPAPER_GRADIENTS['cobalt-grid'];

  const handleSignOut = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${deviceSession.token}`,
        },
        body: JSON.stringify({ tier: 'tier1' }),
      });
    } catch {
      // ignore network glitches on logout
    }
    setDeviceSession(null);
    setScreen('device-login');
  };

  const handleTerminalSubmit = (e: FormEvent) => {
    e.preventDefault();
    const cmd = termCmd.trim();
    if (!cmd) return;
    let out = `Unknown command: ${cmd}`;
    if (cmd === 'help') out = 'Commands: uid | whoami | status | topology | clear';
    else if (cmd === 'uid') out = `Local UID: ${targetUid} (SaaS Pseudonym: ${device?.pseudoSourceId})`;
    else if (cmd === 'whoami') out = `${device?.username ?? deviceSession.username}@${device?.hostname ?? 'host'} [${deviceSession.role}]`;
    else if (cmd === 'status') out = `Health: ${data?.health.state} (${data?.health.overallScore}/100) · Queue: ${data?.spoolDepth ?? 0}`;
    else if (cmd === 'topology') out = `${shortDeviceUid(targetUid)} -> ${device?.floorSwitchId} -> ${device?.buildingCoreId} -> ${device?.collectorId}`;
    else if (cmd === 'clear') {
      setTermHistory([]);
      setTermCmd('');
      return;
    }
    setTermHistory((prev) => [...prev, `PS C:\\Nexaura> ${cmd}`, out]);
    setTermCmd('');
  };

  const handleCipherSend = async (e: FormEvent) => {
    e.preventDefault();
    if (!device) return;
    const to = peerUid || data?.peerDevices[0]?.uid;
    if (!to) return;
    const res = await fetch('/api/mesh/transfer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deviceSession.token}`,
      },
      body: JSON.stringify({
        fromUid: device.uid,
        toUid: to,
        fileName,
        sizeClass: 'M (100KB-1MB)',
        crossTenantPolicyApproved: crossApprove,
      }),
    });
    const body = await res.json();
    if (body.transfer) {
      setMeshMsg(
        body.transfer.status === 'blocked_policy'
          ? 'Cross-tenant transfer blocked: enable policy handshake approval first.'
          : `Sent encrypted file ${body.transfer.fileName} (${shortHash(body.transfer.ciphertextSha256)})`
      );
      refetch();
    }
  };

  const handleSimulateIncoming = async () => {
    if (!device) return;
    const res = await fetch('/api/mesh/simulate-incoming', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deviceSession.token}`,
      },
      body: JSON.stringify({ toUid: device.uid }),
    });
    const body = await res.json();
    if (body.transfer) {
      setMeshMsg(
        `Received inbound encrypted file "${body.transfer.fileName}" from ${shortDeviceUid(body.transfer.fromUid)}.`
      );
      setTransferFilter('received');
      refetch();
    }
  };

  const sentTransfers = (data?.transfers ?? []).filter((t) => t.fromUid === device?.uid);
  const receivedTransfers = (data?.transfers ?? []).filter((t) => t.toUid === device?.uid);
  const filteredTransfers =
    transferFilter === 'sent'
      ? sentTransfers
      : transferFilter === 'received'
        ? receivedTransfers
        : data?.transfers ?? [];

  const desktopApps: { id: DesktopAppId; label: string; icon: typeof Shield }[] = [
    { id: 'collector', label: 'Nexaura Collector', icon: Shield },
    { id: 'logs', label: 'Logs & Audit', icon: ScrollText },
    { id: 'taskmgr', label: 'Task Manager', icon: Activity },
    { id: 'eventvwr', label: 'Event Viewer', icon: FileText },
    { id: 'explorer', label: 'File Explorer', icon: FolderOpen },
    { id: 'terminal', label: 'Terminal', icon: TerminalIcon },
    { id: 'ciphershare', label: 'CipherShare Mesh', icon: Lock },
    { id: 'industry', label: device?.installedApps[6] ?? 'Industry App', icon: Briefcase },
  ];

  return (
    <div className={`flex h-screen w-screen flex-col overflow-hidden bg-gradient-to-br ${wallpaper} text-zinc-100`}>
      {/* Top Bar */}
      <header className="flex items-center justify-between gap-4 border-b border-[#222733] bg-[#0F1218] px-4 py-2 text-xs">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-mono font-semibold text-white truncate" title={targetUid}>
            {shortDeviceUid(targetUid)}
          </span>
          {device && (
            <span className="hidden md:inline text-zinc-400 truncate">
              {device.hostname} · {device.username} · {device.cpuSpec} ({device.ramGb} GB)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setScreen('world')}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#2B3242] bg-[#1A1E28] px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-[#232836] hover:text-white"
          >
            <Globe2 className="h-3.5 w-3.5" />
            3D World
          </button>
          <button
            type="button"
            onClick={() => setScreen('super-login')}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
          >
            <Shield className="h-3.5 w-3.5" />
            Switch to Tier 2 SaaS
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            aria-label="Sign out of device"
            className="rounded-md border border-[#2B3242] bg-[#1A1E28] p-1.5 text-zinc-300 hover:bg-[#232836] hover:text-white"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* Main Desktop Workspace */}
      <div className="flex min-h-0 flex-1">
        {/* Left App Rail */}
        <aside className="hidden sm:flex w-52 flex-col gap-1 border-r border-[#222733] bg-[#0F1218]/90 p-3">
          <div className="mb-1.5 px-2 text-[11px] font-medium text-zinc-500">System Apps</div>
          {desktopApps.map((app) => {
            const Icon = app.icon;
            const active = activeDesktopApp === app.id;
            return (
              <button
                key={app.id}
                type="button"
                onClick={() => setActiveDesktopApp(app.id)}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs font-medium transition-colors ${
                  active
                    ? 'bg-[#1A1E28] text-white border border-[#2B3242]'
                    : 'text-zinc-400 hover:bg-[#141820] hover:text-white border border-transparent'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" style={{ color: active ? accent : undefined }} />
                <span className="truncate">{app.label}</span>
              </button>
            );
          })}
        </aside>

        {/* Active Application Window */}
        <main className="min-w-0 flex-1 p-3 sm:p-4">
          <div className="flex h-full flex-col overflow-hidden rounded-lg border border-[#222733] bg-[#0E1117] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#222733] bg-[#12151C] px-4 py-2.5">
              <h1 className="text-xs font-semibold text-white">
                {desktopApps.find((a) => a.id === activeDesktopApp)?.label} · {shortDeviceUid(targetUid)}
              </h1>
              <span className="font-mono text-[11px] text-zinc-400 tabular-nums">
                {data?.health.isStale ? (
                  <span className="text-rose-400">Collector Stale ({data.health.staleAgeSeconds}s)</span>
                ) : (
                  <span>
                    Health: {data?.health.state ?? 'Loading'} ({data?.health.overallScore ?? '--'}/100)
                  </span>
                )}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {isLoading ? (
                <div className="p-6 space-y-3">
                  <div className="h-8 w-2/3 rounded bg-[#181C25] animate-pulse" />
                  <div className="h-40 rounded bg-[#181C25] animate-pulse" />
                </div>
              ) : isError || !data ? (
                <div className="p-6 text-xs text-rose-400">
                  Failed to fetch local device telemetry.{' '}
                  <button type="button" onClick={() => refetch()} className="underline text-zinc-200">
                    Retry
                  </button>
                </div>
              ) : (
                <PanelErrorBoundary title="Tier 1 Application Window">
                  {activeDesktopApp === 'collector' && (
                    <CollectorConsole
                      device={data.device}
                      metrics={data.metrics}
                      health={data.health}
                      rawLogs={data.rawLogs}
                      egressLog={data.egressLog}
                      spool={data.spool}
                      droppedLowSeverityTotal={data.droppedLowSeverityTotal}
                      outageActive={data.outageActive}
                      lastHeartbeatUtc={data.lastHeartbeatUtc}
                      reconcile={data.reconcile}
                      token={deviceSession.token}
                      onRefresh={() => refetch()}
                    />
                  )}

                  {activeDesktopApp === 'logs' && (
                    <StructuredLogsPanel
                      tier="tier1"
                      token={deviceSession.token}
                      region={data.device.region}
                      tenantIds={[data.device.tenantId]}
                      deviceUid={data.device.uid}
                    />
                  )}

                  {activeDesktopApp === 'taskmgr' && (
                    <div className="p-5 space-y-5">
                      <div className="grid gap-3 sm:grid-cols-4 font-mono tabular-nums">
                        <div className="rounded-lg border border-[#222733] bg-[#12151C] p-3.5">
                          <div className="text-xs text-zinc-400">CPU Utilization</div>
                          <div className="mt-1 text-2xl font-semibold text-white">{data.metrics.cpuPct}%</div>
                        </div>
                        <div className="rounded-lg border border-[#222733] bg-[#12151C] p-3.5">
                          <div className="text-xs text-zinc-400">Memory Usage</div>
                          <div className="mt-1 text-2xl font-semibold text-white">{data.metrics.memoryPct}%</div>
                        </div>
                        <div className="rounded-lg border border-[#222733] bg-[#12151C] p-3.5">
                          <div className="text-xs text-zinc-400">Uplink Latency</div>
                          <div className="mt-1 text-2xl font-semibold text-blue-400">{data.metrics.latencyMs} ms</div>
                        </div>
                        <div className="rounded-lg border border-[#222733] bg-[#12151C] p-3.5">
                          <div className="text-xs text-zinc-400">Disk / Loss</div>
                          <div className="mt-1 text-2xl font-semibold text-amber-400">
                            {data.metrics.diskPct}% · {data.metrics.packetLossPct}%
                          </div>
                        </div>
                      </div>
                      <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4">
                        <h2 className="text-xs font-semibold text-white">Running Processes ({data.device.hostname})</h2>
                        <table className="mt-3 w-full text-left text-xs">
                          <thead className="border-b border-[#222733] text-zinc-400">
                            <tr>
                              <th className="py-2">Process</th>
                              <th className="py-2">Category</th>
                              <th className="py-2 text-right">CPU %</th>
                              <th className="py-2 text-right">Memory</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#222733] font-mono tabular-nums">
                            <tr>
                              <td className="py-2 text-blue-400">nexaura-collector.exe</td>
                              <td className="py-2 text-zinc-400">Privacy Agent</td>
                              <td className="py-2 text-right">1.8%</td>
                              <td className="py-2 text-right">64 MB</td>
                            </tr>
                            <tr>
                              <td className="py-2 text-white">{data.device.installedApps[6]?.toLowerCase().replace(/\s+/g, '-')}.exe</td>
                              <td className="py-2 text-zinc-400">{data.device.industry}</td>
                              <td className="py-2 text-right">{(data.metrics.cpuPct * 0.52).toFixed(1)}%</td>
                              <td className="py-2 text-right">1,420 MB</td>
                            </tr>
                            <tr>
                              <td className="py-2 text-white">ciphershare-relay.exe</td>
                              <td className="py-2 text-zinc-400">P2P Mesh</td>
                              <td className="py-2 text-right">0.4%</td>
                              <td className="py-2 text-right">48 MB</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {activeDesktopApp === 'eventvwr' && (
                    <div className="p-5 space-y-2">
                      <h2 className="text-xs font-semibold text-white">
                        Windows Event Viewer — Local Security, System & Application Logs
                      </h2>
                      <div className="overflow-x-auto rounded-lg border border-[#222733] bg-[#12151C]">
                        <table className="w-full text-left text-xs">
                          <thead className="border-b border-[#222733] text-zinc-400">
                            <tr>
                              <th className="p-2.5">Level</th>
                              <th className="p-2.5">Channel</th>
                              <th className="p-2.5">Event ID</th>
                              <th className="p-2.5">Time</th>
                              <th className="p-2.5">Message</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#222733]">
                            {data.rawLogs.map((l) => (
                              <tr key={l.id}>
                                <td className="p-2.5 font-medium text-zinc-200">{l.level}</td>
                                <td className="p-2.5 text-blue-400">{l.channel}</td>
                                <td className="p-2.5 font-mono tabular-nums">{l.eventId}</td>
                                <td className="p-2.5 font-mono text-[11px] text-zinc-400 tabular-nums">{shortTimeUtc(l.timestampUtc)}</td>
                                <td className="p-2.5 font-mono text-[11px] text-zinc-300">{l.message}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {activeDesktopApp === 'explorer' && (
                    <div className="p-5 space-y-4">
                      <h2 className="text-xs font-semibold text-white">
                        Local Filesystem — {data.device.osVersion} ({data.device.hostname})
                      </h2>
                      <div className="grid gap-3 sm:grid-cols-3 text-xs">
                        {[
                          { name: 'C:\\Nexaura\\Collector\\spool.wal', meta: `Encrypted WAL · ${data.spoolDepth} queued` },
                          { name: 'C:\\Nexaura\\Keys\\device_ed25519.pub', meta: 'P2P Mesh Public Key' },
                          { name: `C:\\${data.device.industry}\\runtime.db`, meta: 'Local Business Store (Never Uploaded)' },
                        ].map((f) => (
                          <div key={f.name} className="rounded-lg border border-[#222733] bg-[#12151C] p-3.5">
                            <div className="font-mono text-blue-400 break-all">{f.name}</div>
                            <div className="mt-1 text-zinc-400">{f.meta}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {activeDesktopApp === 'terminal' && (
                    <div className="flex h-full flex-col bg-[#090B0E] p-4 font-mono text-xs text-emerald-400">
                      <div className="flex-1 space-y-1 overflow-y-auto">
                        {termHistory.map((line, i) => (
                          <div key={i} className="whitespace-pre-wrap">{line}</div>
                        ))}
                      </div>
                      <form onSubmit={handleTerminalSubmit} className="mt-3 flex items-center gap-2 border-t border-[#222733] pt-2">
                        <span className="text-blue-400">PS&gt;</span>
                        <input
                          type="text"
                          value={termCmd}
                          onChange={(e) => setTermCmd(e.target.value)}
                          placeholder="Enter command (help, uid, status, topology)"
                          className="flex-1 bg-transparent text-white focus:outline-none"
                        />
                      </form>
                    </div>
                  )}

                  {activeDesktopApp === 'ciphershare' && (
                    <div className="p-5 space-y-4">
                      <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <h2 className="text-sm font-semibold text-white">
                              CipherShare Encrypted Device-to-Device Relay
                            </h2>
                            <p className="mt-1 text-xs text-zinc-400">
                              Encrypted peer-to-peer relay separate from telemetry. SaaS sees size class and SHA-256 hash only.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={handleSimulateIncoming}
                            className="inline-flex items-center gap-1.5 rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-[#232836]"
                          >
                            <Download className="h-3.5 w-3.5 text-emerald-400" />
                            Simulate Incoming File
                          </button>
                        </div>

                        <form onSubmit={handleCipherSend} className="mt-4 grid gap-3 sm:grid-cols-3">
                          <div>
                            <label htmlFor="peer-select" className="block text-[11px] text-zinc-300">
                              Recipient Device
                            </label>
                            <select
                              id="peer-select"
                              value={peerUid || data.peerDevices[0]?.uid || ''}
                              onChange={(e) => setPeerUid(e.target.value)}
                              className="mt-1 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] px-2.5 py-2 text-xs text-white"
                            >
                              {data.peerDevices.map((p) => (
                                <option key={p.uid} value={p.uid}>
                                  {shortDeviceUid(p.uid)} ({p.cityName})
                                </option>
                              ))}
                            </select>
                          </div>

                          <div>
                            <label htmlFor="cipher-file" className="block text-[11px] text-zinc-300">
                              File Name
                            </label>
                            <input
                              id="cipher-file"
                              type="text"
                              value={fileName}
                              onChange={(e) => setFileName(e.target.value)}
                              className="mt-1 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] px-2.5 py-2 text-xs text-white"
                            />
                          </div>

                          <div className="flex flex-col justify-end">
                            <label className="mb-1.5 flex items-center gap-1.5 text-[11px] text-zinc-300">
                              <input
                                type="checkbox"
                                checked={crossApprove}
                                onChange={(e) => setCrossApprove(e.target.checked)}
                              />
                              Cross-tenant policy handshake
                            </label>
                            <button
                              type="submit"
                              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500"
                            >
                              <Send className="h-3.5 w-3.5" />
                              Encrypt & Relay
                            </button>
                          </div>
                        </form>
                        {meshMsg && <p className="mt-2 text-xs text-blue-400">{meshMsg}</p>}
                      </div>

                      {/* Sent vs Received Filter Tabs */}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 rounded-md border border-[#222733] bg-[#12151C] p-1 text-xs">
                          <button
                            type="button"
                            onClick={() => setTransferFilter('all')}
                            className={`rounded px-3 py-1 font-medium transition-colors ${
                              transferFilter === 'all' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white'
                            }`}
                          >
                            All Files ({data.transfers.length})
                          </button>
                          <button
                            type="button"
                            onClick={() => setTransferFilter('sent')}
                            className={`inline-flex items-center gap-1.5 rounded px-3 py-1 font-medium transition-colors ${
                              transferFilter === 'sent' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white'
                            }`}
                          >
                            <ArrowUpRight className="h-3 w-3" />
                            Sent ({sentTransfers.length})
                          </button>
                          <button
                            type="button"
                            onClick={() => setTransferFilter('received')}
                            className={`inline-flex items-center gap-1.5 rounded px-3 py-1 font-medium transition-colors ${
                              transferFilter === 'received' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white'
                            }`}
                          >
                            <ArrowDownLeft className="h-3 w-3" />
                            Received ({receivedTransfers.length})
                          </button>
                        </div>
                        <span className="text-[11px] text-zinc-400">
                          Endpoint: {shortDeviceUid(data.device.uid)}
                        </span>
                      </div>

                      <div className="space-y-2">
                        {filteredTransfers.length === 0 ? (
                          <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4 text-xs text-zinc-400">
                            No {transferFilter === 'all' ? '' : transferFilter} file transfers on this endpoint yet.
                          </div>
                        ) : (
                          filteredTransfers.map((t) => {
                            const isSent = t.fromUid === data.device.uid;
                            return (
                              <div key={t.transferId} className="rounded-lg border border-[#222733] bg-[#12151C] p-3 text-xs">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                                        isSent
                                          ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30'
                                          : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                      }`}
                                    >
                                      {isSent ? (
                                        <>
                                          <ArrowUpRight className="h-3 w-3" /> Sent
                                        </>
                                      ) : (
                                        <>
                                          <ArrowDownLeft className="h-3 w-3" /> Received
                                        </>
                                      )}
                                    </span>
                                    <span className="font-mono text-white">
                                      {isSent
                                        ? `To ${shortDeviceUid(t.toUid)} (${t.toTenantId})`
                                        : `From ${shortDeviceUid(t.fromUid)} (${t.fromTenantId})`}
                                    </span>
                                  </div>
                                  <span className={t.status === 'relayed_encrypted' ? 'text-emerald-400 font-medium' : 'text-rose-400 font-medium'}>
                                    {t.status === 'relayed_encrypted' ? 'Relayed Encrypted' : 'Policy Blocked'}
                                  </span>
                                </div>
                                <div className="mt-1.5 font-mono text-[11px] text-zinc-400 flex flex-wrap justify-between gap-2">
                                  <span>
                                    {t.fileName} · {t.sizeClass} · SHA-256: {shortHash(t.ciphertextSha256)}
                                  </span>
                                  <span>{shortTimeUtc(t.createdAtUtc)}</span>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}

                  {activeDesktopApp === 'industry' && (
                    <div className="p-5 space-y-4">
                      <h2 className="text-sm font-semibold text-white">
                        {data.device.installedApps[6]} ({data.device.industry.toUpperCase()})
                      </h2>
                      <p className="text-xs text-zinc-400">
                        Local business application running inside Tier 1 on {data.device.hostname}. Customer records remain strictly on-device.
                      </p>
                      <div className="grid gap-3 sm:grid-cols-3 text-xs">
                        {data.device.installedApps.slice(6).map((app) => (
                          <div key={app} className="rounded-lg border border-[#222733] bg-[#12151C] p-4">
                            <div className="font-semibold text-white">{app}</div>
                            <div className="mt-1 text-zinc-400">Local encrypted workspace active</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </PanelErrorBoundary>
              )}
            </div>
          </div>
        </main>
      </div>

      {/* Bottom Taskbar */}
      <footer className="flex items-center justify-between border-t border-[#222733] bg-[#0F1218] px-4 py-1.5 text-xs">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {desktopApps.map((app) => {
            const Icon = app.icon;
            const active = activeDesktopApp === app.id;
            return (
              <button
                key={app.id}
                type="button"
                onClick={() => setActiveDesktopApp(app.id)}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs whitespace-nowrap shrink-0 ${
                  active ? 'bg-[#1A1E28] text-white' : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Icon className="h-3.5 w-3.5" style={{ color: active ? accent : undefined }} />
                <span>{app.label}</span>
              </button>
            );
          })}
        </div>
        <span className="hidden md:inline font-mono text-[11px] text-zinc-400 tabular-nums">
          {device?.cityName ?? 'BLR'} · {new Date().toISOString().slice(11, 16)} UTC
        </span>
      </footer>
    </div>
  );
}
