import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  Database,
  Download,
  FilePlus2,
  KeyRound,
  LogIn,
  Search,
  ShieldCheck,
} from 'lucide-react';
import type { LogCategory, RegionCode, Severity, StructuredLogEntry } from '../shared/schema';
import { shortDeviceUid, shortPseudoId, shortTimeUtc } from '../shared/formatters';

interface StructuredLogsPanelProps {
  tier: 'tier1' | 'tier2';
  token: string;
  region: RegionCode;
  tenantIds?: string[];
  deviceUid?: string;
}

const LOG_CATEGORIES: { id: LogCategory; label: string; desc: string; icon: typeof Database }[] = [
  { id: 'metadata', label: 'Metadata', desc: 'Sanitized allow-listed telemetry digests & SHA-256 verification', icon: Database },
  { id: 'tenant_data', label: 'Tenant Data', desc: 'Tenant partition state, RLS boundaries & local store mounts', icon: ShieldCheck },
  { id: 'login_logout', label: 'Login & Logout', desc: 'Operator and administrator sign-in / sign-out lifecycle', icon: LogIn },
  { id: 'authentication', label: 'Authentication', desc: 'Token issuance, failed attempts, lockouts & RBAC enforcement', icon: KeyRound },
  { id: 'alerts', label: 'Alerts', desc: 'High/critical anomalies, stale heartbeats & severe advisor flags', icon: AlertTriangle },
  { id: 'user_activity', label: 'User Activity', desc: 'Scenarios, threshold edits, remediations & advisor resolutions', icon: Activity },
  { id: 'transfer', label: 'Transfer', desc: 'CipherShare encrypted P2P transfers & policy decisions', icon: ArrowLeftRight },
];

export function StructuredLogsPanel({
  tier,
  token,
  region,
  tenantIds,
  deviceUid,
}: StructuredLogsPanelProps) {
  const [activeCategory, setActiveCategory] = useState<LogCategory>('metadata');
  const [searchQuery, setSearchQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState<'all' | Severity>('all');

  // Create log form
  const [newAction, setNewAction] = useState('');
  const [newSeverity, setNewSeverity] = useState<Severity>('medium');
  const [newSummary, setNewSummary] = useState('');
  const [creating, setCreating] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const tenantParam = tenantIds && tenantIds.length > 0 ? tenantIds.join(',') : 'all';

  const { data, isLoading, refetch } = useQuery<{ tier: string; logs: StructuredLogEntry[] }>({
    queryKey: ['structured-logs', tier, activeCategory, region, tenantParam, deviceUid, token],
    enabled: Boolean(token),
    queryFn: async () => {
      const qs = new URLSearchParams({
        tier,
        category: activeCategory,
        region,
        tenantIds: tenantParam,
      });
      if (tier === 'tier1' && deviceUid) {
        qs.set('deviceUid', deviceUid);
      }
      const r = await fetch(`/api/logs?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error('Failed to fetch logs');
      return r.json();
    },
    refetchInterval: 5000,
  });

  const logs = (data?.logs ?? []).filter((l) => {
    if (severityFilter !== 'all' && l.severity !== severityFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        l.summary.toLowerCase().includes(q) ||
        l.action.toLowerCase().includes(q) ||
        l.actor.toLowerCase().includes(q) ||
        l.tenantId.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const activeMeta = LOG_CATEGORIES.find((c) => c.id === activeCategory)!;

  const handleCreateLog = async (e: FormEvent) => {
    e.preventDefault();
    if (!newSummary.trim()) return;
    setCreating(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/logs/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          category: activeCategory,
          tier,
          region,
          tenantId: tenantIds && tenantIds.length === 1 ? tenantIds[0] : 'all',
          deviceUid: tier === 'tier1' ? deviceUid : undefined,
          severity: newSeverity,
          action: newAction.trim() || undefined,
          summary: newSummary.trim(),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setFeedback(body.error || 'Could not record log entry.');
        return;
      }
      setNewAction('');
      setNewSummary('');
      setFeedback(`Recorded ${activeMeta.label} entry (${body.entry.action}).`);
      refetch();
    } finally {
      setCreating(false);
    }
  };

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexaura-${tier}-${activeCategory}-${region.toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4 p-4 sm:p-5">
      {/* Category Page Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222733] pb-3">
        <div>
          <h2 className="text-sm font-semibold text-white">
            {tier === 'tier1' ? 'Tier 1 Device & Collector Logs' : `Tier 2 Regional Audit Logs (${region})`}
          </h2>
          <p className="mt-0.5 text-xs text-zinc-400">
            {tier === 'tier1'
              ? 'Local endpoint records including device identifiers and on-host lifecycle events.'
              : 'Metadata-only governance streams scoped to selected tenants; zero device UIDs or raw payloads.'}
          </p>
        </div>
        <button
          type="button"
          onClick={handleExportJson}
          className="inline-flex items-center gap-1.5 rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-[#232836]"
        >
          <Download className="h-3.5 w-3.5" />
          Export {activeMeta.label} JSON
        </button>
      </div>

      {/* 7 Separate Log Category Pages */}
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7">
        {LOG_CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          const active = activeCategory === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => {
                setActiveCategory(cat.id);
                setFeedback(null);
              }}
              className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs font-medium transition-colors ${
                active
                  ? 'border-blue-500 bg-blue-600/20 text-white'
                  : 'border-[#222733] bg-[#12151C] text-zinc-400 hover:border-zinc-600 hover:text-white'
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-blue-400" />
              <span className="truncate">{cat.label}</span>
            </button>
          );
        })}
      </div>

      {/* Active Category Header + Create Log Form */}
      <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222733] pb-3">
          <div>
            <h3 className="text-xs font-semibold text-white">{activeMeta.label} Log Stream</h3>
            <p className="text-[11px] text-zinc-400">{activeMeta.desc}</p>
          </div>
          <span className="font-mono text-xs text-zinc-400 tabular-nums">
            {logs.length} record{logs.length === 1 ? '' : 's'}
          </span>
        </div>

        <form onSubmit={handleCreateLog} className="mt-3 grid gap-2.5 sm:grid-cols-12">
          <div className="sm:col-span-3">
            <label htmlFor={`log-action-${tier}`} className="block text-[11px] text-zinc-400">
              Event Code
            </label>
            <input
              id={`log-action-${tier}`}
              type="text"
              value={newAction}
              onChange={(e) => setNewAction(e.target.value)}
              placeholder={`e.g. ${activeCategory.toUpperCase()}_CHECK`}
              className="mt-1 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] px-2.5 py-1.5 font-mono text-xs text-white placeholder:text-zinc-500"
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`log-sev-${tier}`} className="block text-[11px] text-zinc-400">
              Severity
            </label>
            <select
              id={`log-sev-${tier}`}
              value={newSeverity}
              onChange={(e) => setNewSeverity(e.target.value as Severity)}
              className="mt-1 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] px-2.5 py-1.5 text-xs text-white"
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="critical">critical</option>
            </select>
          </div>
          <div className="sm:col-span-5">
            <label htmlFor={`log-sum-${tier}`} className="block text-[11px] text-zinc-400">
              Log Entry Summary
            </label>
            <input
              id={`log-sum-${tier}`}
              type="text"
              value={newSummary}
              onChange={(e) => setNewSummary(e.target.value)}
              placeholder={`Record a new ${activeMeta.label.toLowerCase()} entry...`}
              className="mt-1 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] px-2.5 py-1.5 text-xs text-white placeholder:text-zinc-500"
            />
          </div>
          <div className="flex items-end sm:col-span-2">
            <button
              type="submit"
              disabled={creating || !newSummary.trim()}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              <FilePlus2 className="h-3.5 w-3.5" />
              Create Log
            </button>
          </div>
        </form>
        {feedback && <p className="mt-2 text-xs text-emerald-400">{feedback}</p>}
      </div>

      {/* Filters + Records Table */}
      <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Filter ${activeMeta.label.toLowerCase()} logs...`}
              className="w-full rounded-md border border-[#2B3242] bg-[#0B0D11] py-1.5 pl-8 pr-3 text-xs text-white placeholder:text-zinc-500"
            />
          </div>
          <select
            aria-label="Filter logs by severity"
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value as 'all' | Severity)}
            className="rounded-md border border-[#2B3242] bg-[#0B0D11] px-2.5 py-1.5 text-xs text-zinc-200"
          >
            <option value="all">All Severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>

        {isLoading ? (
          <div className="py-6 text-center text-xs text-zinc-400">Loading {activeMeta.label} logs...</div>
        ) : logs.length === 0 ? (
          <div className="py-6 text-center text-xs text-zinc-400">
            No {activeMeta.label.toLowerCase()} entries recorded for this scope yet. Use "Create Log" above to add one.
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#222733] text-zinc-400">
                <tr>
                  <th className="py-2 pr-3">Time (UTC)</th>
                  <th className="py-2 pr-3">Severity</th>
                  <th className="py-2 pr-3">Event</th>
                  <th className="py-2 pr-3">Actor / Source</th>
                  <th className="py-2 pr-3">Tenant</th>
                  <th className="py-2">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#222733]">
                {logs.map((entry) => (
                  <tr key={entry.id} className="hover:bg-[#171B24]">
                    <td className="py-2 pr-3 font-mono text-[11px] text-zinc-400 whitespace-nowrap tabular-nums">
                      {shortTimeUtc(entry.timestampUtc)}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <span
                        className={`font-mono text-[11px] font-medium uppercase ${
                          entry.severity === 'critical'
                            ? 'text-rose-400'
                            : entry.severity === 'high'
                              ? 'text-amber-400'
                              : entry.severity === 'medium'
                                ? 'text-blue-400'
                                : 'text-emerald-400'
                        }`}
                      >
                        {entry.severity}
                      </span>
                    </td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-zinc-200 whitespace-nowrap">
                      {entry.action}
                    </td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-zinc-300 whitespace-nowrap">
                      {entry.actor}
                      {tier === 'tier1' && entry.deviceUid
                        ? ` (${shortDeviceUid(entry.deviceUid)})`
                        : entry.pseudoSourceId
                          ? ` (${shortPseudoId(entry.pseudoSourceId)})`
                          : ''}
                    </td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-zinc-400 whitespace-nowrap">
                      {entry.tenantId}
                    </td>
                    <td className="py-2 text-zinc-300">{entry.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
