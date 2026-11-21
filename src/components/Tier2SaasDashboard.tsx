import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertOctagon,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Database,
  Globe2,
  LogOut,
  Play,
  RotateCcw,
  Send,
  Shield,
  ShieldAlert,
  Sliders,
  Sparkles,
  Timer,
  Zap,
} from 'lucide-react';
import { useNexauraStore } from '../state/useNexauraStore';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import { StructuredLogsPanel } from './StructuredLogsPanel';
import type {
  HealthState,
  HealthThresholds,
  Incident,
  RegionCode,
  RemediationRecord,
  ScenarioRequest,
  ScenarioType,
} from '../shared/schema';
import type { ReconcileSummary } from './CollectorConsole';
import {
  shortEventId,
  shortHash,
  shortIncidentId,
  shortPseudoId,
  shortTimeUtc,
} from '../shared/formatters';

interface FleetNode {
  pseudoSourceId: string;
  tenantId: string;
  region: RegionCode;
  industry: string;
  cityName: string;
  healthState: HealthState;
  healthScore: number;
  subScores: {
    availability: { score: number; weight: number };
    resource: { score: number; weight: number };
    network: { score: number; weight: number };
    security: { score: number; weight: number };
  };
  isStale: boolean;
  staleAgeSeconds: number;
  reason: string;
  cpuPct: number;
  memoryPct: number;
  diskPct: number;
  bandwidthMbps: number;
  latencyMs: number;
  packetLossPct: number;
  failedLogins: number;
  lastHeartbeatUtc: string;
}

interface StoredPayloadRow {
  payloadId: string;
  pseudoSourceId: string;
  tenantId: string;
  metric: string;
  value: number;
  severity: string;
  eventTimeUtc: string;
  contextSummary: string;
  saasStoredSha256: string;
}

interface SaasDashboardResponse {
  region: RegionCode;
  effectiveTenant: string;
  effectiveTenants: string[];
  availableTenants: string[];
  fleetHealthScore: number;
  fleetNodes: FleetNode[];
  incidents: Incident[];
  remediations: RemediationRecord[];
  storedPayloads: StoredPayloadRow[];
  reconcile: ReconcileSummary;
  thresholds: HealthThresholds;
  outageActive: boolean;
  spoolDepth: number;
  auditEvents: { timestampUtc: string; actor: string; action: string; detail: string }[];
  latencySamples: {
    payloadId: string;
    collectionMs: number;
    endToEndMs: number;
    alertTriggeredMs?: number;
  }[];
  fileTransferMetadata: {
    transferId: string;
    sizeClass: string;
    ciphertextSha256: string;
    crossTenantPolicyApproved: boolean;
    createdAtUtc: string;
    status: string;
  }[];
}

interface SevereAdvisorAlert {
  active: boolean;
  level: 'critical' | 'high';
  title: string;
  detail: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  rootCause?: string;
  solution?: string;
  actionTaken?: string;
  severeAlert?: SevereAdvisorAlert | null;
  provider?: string;
}

type SaasTab = 'overview' | 'aiops' | 'verify' | 'logs';

const ANOMALY_OPTIONS: { value: ScenarioType; label: string }[] = [
  { value: 'disk_io_saturation', label: 'Disk I/O Saturation (96%)' },
  { value: 'dns_failure_burst', label: 'DNS Failure Burst (41%)' },
  { value: 'cert_expiry_warning', label: 'mTLS Cert Expiry (<28h)' },
  { value: 'heartbeat_flap', label: 'Collector Heartbeat Flap' },
  { value: 'bandwidth_saturation', label: 'Uplink Bandwidth Exhaustion' },
  { value: 'privilege_escalation', label: 'Privilege Escalation Alert' },
  { value: 'cpu_spike', label: 'CPU Spike (95%)' },
  { value: 'latency_rise', label: 'Uplink Latency Surge' },
];

export function Tier2SaasDashboard() {
  const {
    saasSession,
    setSaasSession,
    activeSaasRegion,
    setActiveSaasRegion,
    setScreen,
  } = useNexauraStore();

  const [tab, setTab] = useState<SaasTab>('overview');
  const [selectedTenants, setSelectedTenants] = useState<string[]>(['all']);
  const [tenantMenuOpen, setTenantMenuOpen] = useState(false);
  const [selectedAnomaly, setSelectedAnomaly] = useState<ScenarioType>('disk_io_saturation');
  const [bannerMsg, setBannerMsg] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      text: 'Nexaura Regional Advisor ready. Ask about any node, root cause, latency/disk/DNS anomalies, or instruct me to resolve active issues.',
      provider: 'metadata-only',
    },
  ]);

  // Threshold policy editor state
  const [cpuPoorInput, setCpuPoorInput] = useState('90');
  const [latPoorInput, setLatPoorInput] = useState('180');
  const [staleSecInput, setStaleSecInput] = useState('60');
  const [savingThresholds, setSavingThresholds] = useState(false);

  const tenantQueryParam = selectedTenants.length === 0 || selectedTenants.includes('all')
    ? 'all'
    : selectedTenants.join(',');

  const { data, isLoading, isError, error, refetch } = useQuery<SaasDashboardResponse>({
    queryKey: ['saas-dashboard', activeSaasRegion, tenantQueryParam, saasSession?.token],
    enabled: Boolean(saasSession?.token),
    queryFn: async () => {
      const r = await fetch(
        `/api/saas/dashboard?region=${encodeURIComponent(activeSaasRegion)}&tenantIds=${encodeURIComponent(tenantQueryParam)}`,
        {
          headers: { Authorization: `Bearer ${saasSession!.token}` },
        }
      );
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Failed to load Regional SaaS dashboard');
      return body;
    },
    refetchInterval: 4500,
  });

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chatMessages.length, chatLoading]);

  useEffect(() => {
    if (data?.thresholds) {
      setCpuPoorInput(String(data.thresholds.cpuPoor));
      setLatPoorInput(String(data.thresholds.latencyPoorMs));
      setStaleSecInput(String(data.thresholds.staleSeconds));
    }
  }, [data?.thresholds?.cpuPoor, data?.thresholds?.latencyPoorMs, data?.thresholds?.staleSeconds]);

  if (!saasSession) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0B0D11] text-zinc-200">
        <button
          type="button"
          onClick={() => setScreen('super-login')}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          Sign In to Regional SaaS
        </button>
      </div>
    );
  }

  const toggleTenantSelection = (tId: string) => {
    if (tId === 'all') {
      setSelectedTenants(['all']);
      return;
    }
    setSelectedTenants((prev) => {
      const cleaned = prev.filter((x) => x !== 'all');
      const exists = cleaned.includes(tId);
      const next = exists ? cleaned.filter((x) => x !== tId) : [...cleaned, tId];
      return next.length === 0 ? ['all'] : next;
    });
  };

  const tenantFilterLabel =
    selectedTenants.includes('all') || selectedTenants.length === 0
      ? `All Tenants (${activeSaasRegion})`
      : selectedTenants.length === 1
        ? selectedTenants[0]
        : `${selectedTenants.length} Tenants Selected`;

  const triggerRegionalScenario = async (type: ScenarioRequest['type']) => {
    const res = await fetch('/api/collector/scenario', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${saasSession.token}`,
      },
      body: JSON.stringify({
        type,
        deviceUid: activeSaasRegion === 'IN' ? 'IN-KA-BLR-D02-B07-F03-W014-X' : `${activeSaasRegion}-REGION-NODE`,
        region: activeSaasRegion,
        tenantIds: selectedTenants.length === 0 ? ['all'] : selectedTenants,
      }),
    });
    const body = await res.json();
    setBannerMsg(body.message || body.error || 'Scenario triggered.');
    refetch();
  };

  const handleRemediationAction = async (
    remediationId: string,
    action: 'approve' | 'execute' | 'rollback' | 'reject'
  ) => {
    const res = await fetch(`/api/saas/remediation/${encodeURIComponent(remediationId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${saasSession.token}`,
      },
      body: JSON.stringify({ action }),
    });
    const body = await res.json();
    if (!res.ok) {
      setBannerMsg(body.error || 'Remediation action blocked by policy.');
      return;
    }
    setBannerMsg(`Remediation ${shortIncidentId(remediationId)} updated to "${body.remediation.stage}".`);
    refetch();
  };

  const handleEnhanceNarrative = async (incidentId: string) => {
    const res = await fetch(`/api/saas/incidents/${encodeURIComponent(incidentId)}/enhance`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saasSession.token}` },
    });
    if (res.ok) {
      setBannerMsg(`Refined incident ${shortIncidentId(incidentId)} summary via Gemini metadata adapter.`);
      refetch();
    }
  };

  const handleIsolationProbe = async () => {
    const targetRegion: RegionCode = saasSession.region === 'EU' ? 'IN' : 'EU';
    const res = await fetch('/api/saas/isolation-probe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${saasSession.token}`,
      },
      body: JSON.stringify({ targetRegion, targetTenantId: 'tenant-de-bank-09' }),
    });
    const body = await res.json();
    setBannerMsg(body.detail || 'Isolation probe completed.');
    refetch();
  };

  const handleSaveThresholds = async (e: FormEvent) => {
    e.preventDefault();
    setSavingThresholds(true);
    try {
      const res = await fetch('/api/saas/thresholds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${saasSession.token}`,
        },
        body: JSON.stringify({
          cpuPoor: Number(cpuPoorInput),
          latencyPoorMs: Number(latPoorInput),
          staleSeconds: Number(staleSecInput),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setBannerMsg(body.error || 'Invalid threshold values.');
        return;
      }
      setBannerMsg(
        `Saved policy thresholds: CPU Poor ${body.thresholds.cpuPoor}%, Latency Poor ${body.thresholds.latencyPoorMs}ms, Stale ${body.thresholds.staleSeconds}s.`
      );
      refetch();
    } finally {
      setSavingThresholds(false);
    }
  };

  const sendAdvisorPrompt = async (questionText: string) => {
    const q = questionText.trim();
    if (!q || chatLoading) return;
    const recentHistory = chatMessages.slice(-4).map((m) => ({ role: m.role, text: m.text }));
    setChatMessages((prev) => [...prev, { role: 'user', text: q }]);
    setChatInput('');
    setChatLoading(true);
    try {
      const res = await fetch('/api/saas/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${saasSession.token}`,
        },
        body: JSON.stringify({
          region: activeSaasRegion,
          question: q,
          history: recentHistory,
        }),
      });
      const body = await res.json();
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: body.answer || body.error || 'No response received.',
          rootCause: body.rootCause,
          solution: body.solution,
          actionTaken: body.actionTaken,
          severeAlert: body.severeAlert ?? null,
          provider: body.provider,
        },
      ]);
      if (body.dashboardNeedsRefresh) {
        setBannerMsg(body.actionTaken || 'AI Advisor applied live fleet remediation.');
        refetch();
      }
    } catch {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', text: 'Chatbot request failed.', provider: 'error' },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleChatSubmit = (e: FormEvent) => {
    e.preventDefault();
    void sendAdvisorPrompt(chatInput);
  };

  const handleSignOut = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${saasSession.token}`,
        },
        body: JSON.stringify({ tier: 'tier2' }),
      });
    } catch {
      // ignore network glitches on logout
    }
    setSaasSession(null);
    setScreen('super-login');
  };

  const avgNode = data?.fleetNodes[0];
  const liveCriticalNodes = (data?.fleetNodes ?? []).filter(
    (n) => n.isStale || n.healthState === 'Poor' || n.failedLogins >= 6
  );
  const openCriticalIncidents = (data?.incidents ?? []).filter(
    (i) => i.status === 'open' && i.severity === 'critical'
  );
  const hasLiveSevereCondition = liveCriticalNodes.length > 0 || openCriticalIncidents.length > 0;
  const staleExample = (data?.fleetNodes ?? []).find((n) => n.isStale) ?? liveCriticalNodes[0];

  return (
    <div className="min-h-screen bg-[#0B0D11] text-zinc-100">
      {/* Top 3-Zone Header */}
      <header className="flex flex-wrap items-center justify-between gap-6 border-b border-[#222733] bg-[#0F1218] px-6 py-3">
        <span className="font-display text-lg font-semibold tracking-tight text-white whitespace-nowrap shrink-0">
          Nexaura Regional SaaS
        </span>

        <nav className="flex flex-wrap items-center gap-6 text-xs font-medium text-zinc-400">
          <button
            type="button"
            onClick={() => setTab('overview')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              tab === 'overview' ? 'border-blue-500 text-white' : 'border-transparent hover:text-white'
            }`}
          >
            Fleet & Health Score
          </button>
          <button
            type="button"
            onClick={() => setTab('aiops')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              tab === 'aiops' ? 'border-blue-500 text-white' : 'border-transparent hover:text-white'
            }`}
          >
            Incidents & Remediation ({data?.incidents.filter((i) => i.status !== 'remediated').length ?? 0})
          </button>
          <button
            type="button"
            onClick={() => setTab('verify')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              tab === 'verify' ? 'border-blue-500 text-white' : 'border-transparent hover:text-white'
            }`}
          >
            Metadata Store, Policy & SLA
          </button>
          <button
            type="button"
            onClick={() => setTab('logs')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              tab === 'logs' ? 'border-blue-500 text-white' : 'border-transparent hover:text-white'
            }`}
          >
            Logs & Governance
          </button>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden lg:inline font-mono text-xs text-zinc-400">
            {saasSession.username} · {saasSession.role}
          </span>
          <button
            type="button"
            onClick={() => setScreen('world')}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-[#232836]"
          >
            <Globe2 className="h-3.5 w-3.5" />
            3D World
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            aria-label="Sign Out of Regional SaaS"
            className="inline-flex items-center gap-1.5 rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-[#232836]"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign Out
          </button>
        </div>
      </header>

      {/* Regional Endpoint, Multi-Tenant Selection & Scenario Controls Toolbar */}
      <div className="border-b border-[#222733] bg-[#12151C] px-6 py-3">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 rounded-md border border-[#222733] bg-[#0B0D11] p-1 text-xs">
              {(['IN', 'EU', 'US'] as RegionCode[]).map((reg) => (
                <button
                  key={reg}
                  type="button"
                  onClick={() => {
                    setActiveSaasRegion(reg);
                    setSelectedTenants(['all']);
                    setTenantMenuOpen(false);
                  }}
                  className={`rounded px-3 py-1 font-medium transition-colors ${
                    activeSaasRegion === reg
                      ? 'bg-blue-600 text-white'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {reg}
                </button>
              ))}
            </div>

            {/* Individual & Multi-Tenant Selector */}
            <div className="relative">
              <button
                type="button"
                aria-label="Filter by Tenants"
                onClick={() => setTenantMenuOpen(!tenantMenuOpen)}
                className="inline-flex items-center gap-2 rounded-md border border-[#2B3242] bg-[#0B0D11] px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-500"
              >
                <span>{tenantFilterLabel}</span>
                <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
              </button>

              {tenantMenuOpen && (
                <div className="absolute left-0 top-full z-30 mt-1.5 w-64 rounded-lg border border-[#2B3242] bg-[#12151C] p-2 shadow-2xl">
                  <div className="flex items-center justify-between border-b border-[#222733] px-2 pb-1.5 text-[11px] text-zinc-400">
                    <span>Select Regional Tenants</span>
                    <button
                      type="button"
                      onClick={() => setTenantMenuOpen(false)}
                      className="text-blue-400 hover:text-blue-300"
                    >
                      Done
                    </button>
                  </div>
                  <div className="mt-1.5 max-h-56 space-y-1 overflow-y-auto text-xs">
                    <button
                      type="button"
                      onClick={() => toggleTenantSelection('all')}
                      className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left ${
                        selectedTenants.includes('all')
                          ? 'bg-blue-600/20 text-white'
                          : 'text-zinc-300 hover:bg-[#1A1E28]'
                      }`}
                    >
                      <span>All Tenants ({activeSaasRegion})</span>
                      {selectedTenants.includes('all') && <Check className="h-3.5 w-3.5 text-blue-400" />}
                    </button>
                    {(data?.availableTenants ?? []).map((t) => {
                      const checked = !selectedTenants.includes('all') && selectedTenants.includes(t);
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => toggleTenantSelection(t)}
                          className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left font-mono text-[11px] ${
                            checked ? 'bg-blue-600/20 text-white' : 'text-zinc-300 hover:bg-[#1A1E28]'
                          }`}
                        >
                          <span>{t}</span>
                          {checked && <Check className="h-3.5 w-3.5 text-blue-400" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => triggerRegionalScenario('correlated_incident')}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
            >
              <Play className="h-3 w-3" />
              Trigger Correlated Incident
            </button>
            <button
              type="button"
              onClick={() => triggerRegionalScenario('memory_leak')}
              className="rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-[#232836] transition-colors"
            >
              Memory Leak Forecast
            </button>
            <button
              type="button"
              onClick={() => triggerRegionalScenario('failed_login_burst')}
              className="rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-[#232836] transition-colors"
            >
              Failed Login Burst
            </button>

            <div className="flex items-center gap-1.5">
              <select
                aria-label="Additional Anomaly Scenario"
                value={selectedAnomaly}
                onChange={(e) => setSelectedAnomaly(e.target.value as ScenarioType)}
                className="rounded-md border border-[#2B3242] bg-[#0B0D11] px-2.5 py-1.5 text-xs text-zinc-200"
              >
                {ANOMALY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => triggerRegionalScenario(selectedAnomaly)}
                className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/25"
              >
                <Zap className="h-3 w-3" />
                Run Anomaly
              </button>
            </div>

            <button
              type="button"
              onClick={handleIsolationProbe}
              className="rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-[#232836] transition-colors"
            >
              Test Residency Guard
            </button>
          </div>
        </div>

        {bannerMsg && (
          <div className="mx-auto mt-2.5 max-w-7xl rounded-md border border-[#2B3242] bg-[#181C25] px-3.5 py-2 text-xs text-zinc-200">
            {bannerMsg}
          </div>
        )}
      </div>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl p-6">
        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-3">
            <div className="h-36 rounded-lg bg-[#12151C] animate-pulse" />
            <div className="h-36 rounded-lg bg-[#12151C] animate-pulse" />
            <div className="h-36 rounded-lg bg-[#12151C] animate-pulse" />
          </div>
        ) : isError ? (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-6 text-sm text-rose-200">
            <p className="font-semibold">Regional Access Notice</p>
            <p className="mt-1 text-xs">{(error as Error)?.message}</p>
            <button
              type="button"
              onClick={() => {
                setActiveSaasRegion(saasSession.region);
                refetch();
              }}
              className="mt-3 rounded-md bg-[#1A1E28] px-3 py-1.5 text-xs text-white"
            >
              Return to Home Region ({saasSession.region})
            </button>
          </div>
        ) : !data ? null : (
          <div className="grid gap-6 lg:grid-cols-12">
            {/* Primary 8-col workspace */}
            <div className="lg:col-span-8 space-y-6">
              {tab === 'overview' && (
                <PanelErrorBoundary title="Regional Fleet & Health Score">
                  {/* Top KPI Summary */}
                  <div className="grid gap-4 sm:grid-cols-4">
                    <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4">
                      <div className="text-xs text-zinc-400">Regional Health</div>
                      <div className="mt-1 font-mono text-3xl font-semibold text-white tabular-nums">
                        {data.fleetHealthScore}
                        <span className="text-sm font-normal text-zinc-500">/100</span>
                      </div>
                      <div className="mt-1 text-[11px] text-zinc-400">
                        {data.fleetNodes.length} active nodes
                      </div>
                    </div>

                    <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4 sm:col-span-3">
                      <div className="text-xs font-medium text-zinc-300">
                        Health Score Formula Breakdown
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 font-mono text-xs tabular-nums">
                        <div>
                          <div className="text-zinc-400">Availability (30%)</div>
                          <div className="mt-1 text-base font-semibold text-emerald-400">
                            {avgNode?.subScores.availability.score ?? 100}
                          </div>
                        </div>
                        <div>
                          <div className="text-zinc-400">Resource (25%)</div>
                          <div className="mt-1 text-base font-semibold text-blue-400">
                            {avgNode?.subScores.resource.score ?? 92}
                          </div>
                        </div>
                        <div>
                          <div className="text-zinc-400">Network (25%)</div>
                          <div className="mt-1 text-base font-semibold text-amber-400">
                            {avgNode?.subScores.network.score ?? 94}
                          </div>
                        </div>
                        <div>
                          <div className="text-zinc-400">Security (20%)</div>
                          <div className="mt-1 text-base font-semibold text-white">
                            {avgNode?.subScores.security.score ?? 100}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Pseudonymized Fleet Table */}
                  <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222733] pb-3">
                      <div>
                        <h2 className="text-sm font-semibold text-white">
                          Regional Fleet ({activeSaasRegion})
                        </h2>
                        <p className="text-xs text-zinc-400">
                          Anonymized source nodes only; customer device UIDs and raw logs never leave the edge.
                        </p>
                      </div>
                      <span className="font-mono text-xs text-zinc-400 tabular-nums">
                        Sync: {data.reconcile.receivedCount}/{data.reconcile.sentCount} ({data.reconcile.lostCount} lost)
                      </span>
                    </div>

                    {data.fleetNodes.length === 0 ? (
                      <div className="py-8 text-center text-xs text-zinc-400">
                        No nodes matched this tenant filter.
                      </div>
                    ) : (
                      <div className="mt-3 overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="border-b border-[#222733] text-zinc-400">
                            <tr>
                              <th className="py-2 pr-3">Source Node</th>
                              <th className="py-2 pr-3">Tenant · Sector</th>
                              <th className="py-2 pr-3">Health</th>
                              <th className="py-2 pr-3 text-right">CPU</th>
                              <th className="py-2 pr-3 text-right">Latency</th>
                              <th className="py-2 text-right">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#222733] font-mono tabular-nums">
                            {data.fleetNodes.slice(0, 18).map((node) => (
                              <tr
                                key={node.pseudoSourceId}
                                className={node.isStale ? 'opacity-65 text-rose-300' : 'text-zinc-200'}
                              >
                                <td className="py-2 pr-3 text-blue-400" title={node.pseudoSourceId}>
                                  {shortPseudoId(node.pseudoSourceId)}
                                </td>
                                <td className="py-2 pr-3 font-sans text-zinc-300">
                                  {node.tenantId} · {node.industry}
                                </td>
                                <td className="py-2 pr-3">
                                  <span
                                    className={`font-sans font-medium ${
                                      node.healthState === 'Poor'
                                        ? 'text-rose-400'
                                        : node.healthState === 'Fair'
                                          ? 'text-amber-400'
                                          : 'text-emerald-400'
                                    }`}
                                  >
                                    {node.healthState} ({node.healthScore})
                                  </span>
                                </td>
                                <td className="py-2 pr-3 text-right">{node.cpuPct}%</td>
                                <td className="py-2 pr-3 text-right">{node.latencyMs}ms</td>
                                <td className="py-2 text-right">
                                  {node.isStale ? `Stale (${node.staleAgeSeconds}s)` : 'Live'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </PanelErrorBoundary>
              )}

              {tab === 'aiops' && (
                <PanelErrorBoundary title="Explainable AIOps & Safe Remediation">
                  <div className="space-y-4">
                    {data.incidents.length === 0 ? (
                      <div className="rounded-lg border border-[#222733] bg-[#12151C] p-8 text-center">
                        <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-400" />
                        <h3 className="mt-2 text-sm font-semibold text-white">No Open Incidents</h3>
                        <p className="mt-1 text-xs text-zinc-400">
                          Trigger a scenario above to run deterministic root-cause correlation across selected tenants.
                        </p>
                      </div>
                    ) : (
                      data.incidents.map((inc) => {
                        const rem = data.remediations.find((r) => r.incidentId === inc.incidentId);
                        return (
                          <div key={inc.incidentId} className="rounded-lg border border-[#222733] bg-[#12151C] p-5 space-y-4">
                            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#222733] pb-3">
                              <div>
                                <div className="flex items-center gap-2 text-xs text-rose-400 font-medium">
                                  <ShieldAlert className="h-4 w-4" />
                                  <span>{inc.severity.toUpperCase()} INCIDENT</span>
                                  <span>·</span>
                                  <span className="font-mono text-zinc-400" title={inc.incidentId}>
                                    {shortIncidentId(inc.incidentId)}
                                  </span>
                                  <span>·</span>
                                  <span className="font-mono text-zinc-300">{inc.tenantId}</span>
                                </div>
                                <h3 className="mt-1 text-base font-semibold text-white">{inc.title}</h3>
                              </div>
                              <div className="text-right font-mono text-xs tabular-nums">
                                <div className="text-blue-400">
                                  Confidence: {Math.round(inc.rootCause.confidence * 100)}%
                                </div>
                                <div className="text-zinc-400">
                                  {inc.correlatedAlertCount} alerts · {inc.status}
                                </div>
                              </div>
                            </div>

                            <div className="grid gap-4 md:grid-cols-2">
                              <div className="rounded-md border border-[#222733] bg-[#0B0D11] p-3.5">
                                <div className="text-xs font-semibold text-white">Root Cause Analysis</div>
                                <p className="mt-1 text-xs text-zinc-300">{inc.rootCause.summary}</p>
                                <ol className="mt-2 space-y-1 text-[11px] text-zinc-400">
                                  {inc.rootCause.reasoningPath.map((step, i) => (
                                    <li key={i}>
                                      {step.replace(/ps_[a-f0-9]{8,}/g, (match) => shortPseudoId(match))}
                                    </li>
                                  ))}
                                </ol>
                              </div>

                              <div className="rounded-md border border-[#222733] bg-[#0B0D11] p-3.5">
                                <div className="text-xs font-semibold text-white">Signal Evidence (Z-Score)</div>
                                <div className="mt-2 space-y-1.5 font-mono text-[11px] tabular-nums">
                                  {inc.rootCause.contributingSignals.map((sig, i) => (
                                    <div key={i} className="flex items-center justify-between border-b border-[#222733] pb-1">
                                      <span className="text-blue-400">{sig.metric}</span>
                                      <span className="text-zinc-200">
                                        {sig.observed} (base {sig.baseline} · z={sig.zScore})
                                      </span>
                                    </div>
                                  ))}
                                </div>
                                {inc.prediction && (
                                  <div className="mt-2.5 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200">
                                    Forecast: {inc.prediction.summary}
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Recommendation & Safe Remediation */}
                            <div className="rounded-md border border-[#222733] bg-[#0B0D11] p-4 space-y-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <div className="text-xs font-semibold text-white">
                                    Recommended Action: {inc.recommendation.title}
                                  </div>
                                  <p className="mt-1 text-xs text-zinc-300">{inc.recommendation.narrative}</p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleEnhanceNarrative(inc.incidentId)}
                                  className="inline-flex items-center gap-1.5 rounded-md border border-[#2B3242] bg-[#1A1E28] px-2.5 py-1.5 text-[11px] font-medium text-zinc-200 hover:bg-[#232836]"
                                >
                                  <Sparkles className="h-3 w-3 text-blue-400" />
                                  {inc.recommendation.llmEnhanced ? 'Gemini Refined' : 'Refine Summary'}
                                </button>
                              </div>

                              {rem && (
                                <div className="border-t border-[#222733] pt-3">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="text-xs">
                                      <span className="text-zinc-400">Stage: </span>
                                      <span className="font-mono font-semibold text-white">{rem.stage}</span>
                                      <span className="ml-2 text-zinc-400">
                                        (Proposed by {rem.proposedBy}
                                        {rem.approvedBy ? ` · Approved by ${rem.approvedBy}` : ''})
                                      </span>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                      {rem.stage === 'policy_checked' && (
                                        <>
                                          <button
                                            type="button"
                                            onClick={() => handleRemediationAction(rem.remediationId, 'approve')}
                                            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                                          >
                                            Peer Approve
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => handleRemediationAction(rem.remediationId, 'reject')}
                                            className="rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-[#232836]"
                                          >
                                            Reject
                                          </button>
                                        </>
                                      )}
                                      {rem.stage === 'approved' && (
                                        <button
                                          type="button"
                                          onClick={() => handleRemediationAction(rem.remediationId, 'execute')}
                                          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                                        >
                                          Execute Simulated Fix
                                        </button>
                                      )}
                                      {rem.stage === 'executed_simulated' && (
                                        <button
                                          type="button"
                                          onClick={() => handleRemediationAction(rem.remediationId, 'rollback')}
                                          className="inline-flex items-center gap-1 rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-[#232836]"
                                        >
                                          <RotateCcw className="h-3 w-3" />
                                          Rollback Change
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                  <div className="mt-2 text-[11px] text-zinc-400">
                                    Rollback Plan: {rem.rollbackPlan}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </PanelErrorBoundary>
              )}

              {tab === 'verify' && (
                <PanelErrorBoundary title="Metadata Store, Policy & SLA">
                  <div className="space-y-5">
                    {/* Health Thresholds Policy Editor */}
                    <form onSubmit={handleSaveThresholds} className="rounded-lg border border-[#222733] bg-[#12151C] p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm font-semibold text-white">
                          <Sliders className="h-4 w-4 text-blue-400" />
                          Health Policy Thresholds ({activeSaasRegion})
                        </div>
                        <button
                          type="submit"
                          disabled={savingThresholds}
                          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                        >
                          {savingThresholds ? 'Saving...' : 'Save Thresholds'}
                        </button>
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-3 text-xs">
                        <div>
                          <label htmlFor="th-cpu" className="block text-zinc-400">CPU Poor Limit (%)</label>
                          <input
                            id="th-cpu"
                            type="number"
                            min={30}
                            max={100}
                            value={cpuPoorInput}
                            onChange={(e) => setCpuPoorInput(e.target.value)}
                            className="mt-1 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] px-2.5 py-1.5 font-mono text-white"
                          />
                        </div>
                        <div>
                          <label htmlFor="th-lat" className="block text-zinc-400">Latency Poor Limit (ms)</label>
                          <input
                            id="th-lat"
                            type="number"
                            min={20}
                            max={2000}
                            value={latPoorInput}
                            onChange={(e) => setLatPoorInput(e.target.value)}
                            className="mt-1 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] px-2.5 py-1.5 font-mono text-white"
                          />
                        </div>
                        <div>
                          <label htmlFor="th-stale" className="block text-zinc-400">Stale Heartbeat (sec)</label>
                          <input
                            id="th-stale"
                            type="number"
                            min={15}
                            max={600}
                            value={staleSecInput}
                            onChange={(e) => setStaleSecInput(e.target.value)}
                            className="mt-1 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] px-2.5 py-1.5 font-mono text-white"
                          />
                        </div>
                      </div>
                    </form>

                    {/* SLA Measurement Harness */}
                    <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm font-semibold text-white">
                          <Timer className="h-4 w-4 text-blue-400" />
                          Latency SLA (Target &lt;10s Dashboard · &lt;15s Alert)
                        </div>
                        <span className="font-mono text-xs text-emerald-400">Passing</span>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-3 font-mono text-xs tabular-nums">
                        {data.latencySamples.slice(0, 6).map((s) => (
                          <div key={s.payloadId} className="rounded-md border border-[#222733] bg-[#0B0D11] p-2.5">
                            <div className="text-blue-400" title={s.payloadId}>{shortEventId(s.payloadId)}</div>
                            <div className="mt-1 text-zinc-300">
                              Collect: {s.collectionMs}ms · E2E: {s.endToEndMs}ms
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* SaaS Stored Payloads & SHA-256 Verification */}
                    <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-white">
                        <Database className="h-4 w-4 text-emerald-400" />
                        Stored Metadata & SHA-256 Verification ({activeSaasRegion})
                      </div>
                      <p className="mt-1 text-xs text-zinc-400">
                        Compact event digests verified against Tier 1 Collector hashes. Zero credentials or device UIDs stored here.
                      </p>
                      <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
                        {data.storedPayloads.map((row) => (
                          <div key={row.payloadId} className="rounded-md border border-[#222733] bg-[#0B0D11] p-3 font-mono text-[11px]">
                            <div className="flex items-center justify-between text-blue-400">
                              <span title={row.payloadId}>{shortEventId(row.payloadId)}</span>
                              <span className="text-zinc-400">{shortTimeUtc(row.eventTimeUtc)}</span>
                            </div>
                            <div className="mt-1 text-zinc-200">
                              {shortPseudoId(row.pseudoSourceId)} ({row.tenantId}) · {row.metric}={row.value} · {row.contextSummary}
                            </div>
                            <div className="mt-1 text-emerald-400" title={row.saasStoredSha256}>
                              SHA-256: {shortHash(row.saasStoredSha256)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Residency & Tenant Audit Log */}
                    <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4">
                      <h3 className="text-sm font-semibold text-white">Security & Residency Audit Log</h3>
                      <div className="mt-2 max-h-48 space-y-1.5 overflow-y-auto font-mono text-[11px]">
                        {data.auditEvents.map((ev, i) => (
                          <div key={i} className="rounded border border-[#222733] bg-[#0B0D11] px-3 py-1.5 text-zinc-300">
                            <span className="text-blue-400">[{ev.action}]</span> {ev.detail} ({shortTimeUtc(ev.timestampUtc)})
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </PanelErrorBoundary>
              )}

              {tab === 'logs' && (
                <PanelErrorBoundary title="Tier 2 Governance Logs">
                  <div className="rounded-lg border border-[#222733] bg-[#12151C]">
                    <StructuredLogsPanel
                      tier="tier2"
                      token={saasSession.token}
                      region={activeSaasRegion}
                      tenantIds={selectedTenants}
                    />
                  </div>
                </PanelErrorBoundary>
              )}
            </div>

            {/* Right 4-col Gemini Metadata-Only Monitoring & Resolution Advisor */}
            <aside className="lg:col-span-4">
              <PanelErrorBoundary title="Gemini AIOps Advisor">
                <div className="flex h-[620px] flex-col rounded-lg border border-[#222733] bg-[#12151C]">
                  <div className="border-b border-[#222733] p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Bot className="h-4 w-4 text-blue-400" />
                        <h2 className="text-sm font-semibold text-white">Nexaura AI Advisor</h2>
                      </div>
                      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                        <Shield className="h-3 w-3" />
                        Metadata-Only
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-zinc-400">
                      Diagnoses specific root causes, flags severe fleet conditions, and executes safe node resolution on request.
                    </p>

                    {hasLiveSevereCondition && (
                      <div
                        role="alert"
                        className="mt-3 rounded-md border border-rose-500/40 bg-rose-500/15 p-2.5 text-[11px] text-rose-200"
                      >
                        <div className="flex items-center gap-1.5 font-semibold text-rose-300">
                          <AlertOctagon className="h-3.5 w-3.5 shrink-0" />
                          SEVERE ALERT ({liveCriticalNodes.length} degraded node / {openCriticalIncidents.length} critical incident)
                        </div>
                        <div className="mt-1 text-rose-200/90">
                          {staleExample
                            ? `${shortPseudoId(staleExample.pseudoSourceId)} (${staleExample.reason})`
                            : openCriticalIncidents[0]?.title}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Quick diagnostic & resolution actions */}
                  <div className="flex flex-wrap gap-1.5 border-b border-[#222733] bg-[#0F1218] px-3 py-2">
                    <button
                      type="button"
                      onClick={() =>
                        void sendAdvisorPrompt(
                          staleExample
                            ? `Resolve the Heartbeat issue of ${shortPseudoId(staleExample.pseudoSourceId)}`
                            : 'Analyze current root causes and fleet health'
                        )
                      }
                      className="rounded border border-[#2B3242] bg-[#1A1E28] px-2 py-1 text-[11px] text-zinc-200 hover:bg-[#232836]"
                    >
                      {staleExample ? `Resolve ${shortPseudoId(staleExample.pseudoSourceId)}` : 'Diagnose Fleet'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void sendAdvisorPrompt('Analyze open security and DNS alerts')}
                      className="rounded border border-[#2B3242] bg-[#1A1E28] px-2 py-1 text-[11px] text-zinc-200 hover:bg-[#232836]"
                    >
                      Security & Alerts
                    </button>
                    <button
                      type="button"
                      onClick={() => void sendAdvisorPrompt('Resolve all open incidents cleanly')}
                      className="rounded border border-blue-500/40 bg-blue-600/20 px-2 py-1 text-[11px] text-blue-200 hover:bg-blue-600/30"
                    >
                      Resolve Open Faults
                    </button>
                  </div>

                  <div className="flex-1 space-y-3 overflow-y-auto p-4">
                    {chatMessages.map((msg, idx) => (
                      <div
                        key={idx}
                        className={`rounded-lg p-3 text-xs leading-relaxed ${
                          msg.role === 'user'
                            ? 'ml-6 border border-blue-500/30 bg-blue-600/15 text-zinc-100'
                            : 'mr-2 border border-[#222733] bg-[#0B0D11] text-zinc-200 space-y-2'
                        }`}
                      >
                        <div>{msg.text}</div>
                        {msg.rootCause && (
                          <div className="rounded border border-[#222733] bg-[#12151C] px-2.5 py-1.5 text-[11px]">
                            <span className="font-semibold text-amber-300">Root Cause: </span>
                            <span className="text-zinc-300">{msg.rootCause}</span>
                          </div>
                        )}
                        {msg.solution && (
                          <div className="rounded border border-[#222733] bg-[#12151C] px-2.5 py-1.5 text-[11px]">
                            <span className="font-semibold text-blue-300">Solution: </span>
                            <span className="text-zinc-300">{msg.solution}</span>
                          </div>
                        )}
                        {msg.actionTaken && (
                          <div className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-300">
                            Action Executed: {msg.actionTaken}
                          </div>
                        )}
                        {msg.severeAlert?.active && (
                          <div className="rounded border border-rose-500/40 bg-rose-500/15 px-2.5 py-1.5 text-[11px] text-rose-200">
                            <span className="font-semibold uppercase">[{msg.severeAlert.level} Alert] </span>
                            {msg.severeAlert.title} — {msg.severeAlert.detail}
                          </div>
                        )}
                        {msg.provider && (
                          <div className="font-mono text-[10px] text-zinc-500">
                            {msg.provider}
                          </div>
                        )}
                      </div>
                    ))}
                    {chatLoading && (
                      <div className="mr-4 rounded-lg border border-[#222733] bg-[#0B0D11] p-3 text-xs text-zinc-400">
                        Analyzing regional metadata...
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  <form onSubmit={handleChatSubmit} className="border-t border-[#222733] p-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        placeholder="Ask root cause or tell AI to resolve a node..."
                        aria-label="Ask Nexaura AI Advisor"
                        className="flex-1 rounded-md border border-[#2B3242] bg-[#0B0D11] px-3 py-2 text-xs text-white placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={chatLoading}
                        aria-label="Send message to AI Advisor"
                        className="rounded-md bg-blue-600 p-2 text-white hover:bg-blue-500 disabled:opacity-60"
                      >
                        <Send className="h-4 w-4" />
                      </button>
                    </div>
                  </form>
                </div>
              </PanelErrorBoundary>
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
