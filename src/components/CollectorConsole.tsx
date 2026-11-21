import { useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  ShieldAlert,
  WifiOff,
  Wifi,
  Send,
  Database,
  RefreshCw,
  Clock,
  FileCode2,
  Copy,
  Check,
  Zap,
} from 'lucide-react';
import type {
  DeviceProfile,
  EgressProofRecord,
  HealthEvaluation,
  LiveDeviceMetrics,
  ScenarioRequest,
  ScenarioType,
  SpoolEntry,
  WindowsLogEntry,
} from '../shared/schema';
import { shortEventId, shortHash, shortTimeUtc } from '../shared/formatters';

export interface ReconcileSummary {
  sentCount: number;
  receivedCount: number;
  missingIds: string[];
  lostCount: number;
  duplicateCount: number;
  matched: boolean;
}

interface CollectorConsoleProps {
  device: DeviceProfile;
  metrics: LiveDeviceMetrics;
  health: HealthEvaluation;
  rawLogs: WindowsLogEntry[];
  egressLog: EgressProofRecord[];
  spool: SpoolEntry[];
  droppedLowSeverityTotal: number;
  outageActive: boolean;
  lastHeartbeatUtc: string;
  reconcile: ReconcileSummary;
  token: string;
  onRefresh: () => void;
}

type ConsoleTab = 'egress' | 'raw' | 'spool';

const EXTRA_ANOMALIES: { value: ScenarioType; label: string }[] = [
  { value: 'disk_io_saturation', label: 'Disk I/O Saturation (96%)' },
  { value: 'dns_failure_burst', label: 'DNS Failure Burst (41%)' },
  { value: 'cert_expiry_warning', label: 'mTLS Cert Expiry (<28h)' },
  { value: 'heartbeat_flap', label: 'Heartbeat Flap (>90s)' },
  { value: 'bandwidth_saturation', label: 'Bandwidth Exhaustion (980 Mbps)' },
  { value: 'privilege_escalation', label: 'Privilege Escalation Alert' },
  { value: 'cpu_spike', label: 'CPU Spike (95%)' },
  { value: 'memory_leak', label: 'Memory Heap Leak (93%)' },
  { value: 'latency_rise', label: 'Uplink Latency Surge (242ms)' },
  { value: 'failed_login_burst', label: 'Credential Brute-Force Burst' },
];

function formatCleanPayloadPreview(serializedBytes: string): string {
  if (!serializedBytes) return 'Held locally by safety gate before transmission.';
  try {
    const parsed = JSON.parse(serializedBytes) as Record<string, unknown>;
    const displayObj = {
      eventRef: typeof parsed.payloadId === 'string' ? shortEventId(parsed.payloadId) : parsed.payloadId,
      tenant: parsed.tenantId,
      node:
        typeof parsed.pseudoSourceId === 'string'
          ? `Node ${parsed.pseudoSourceId.slice(3, 7)}·${parsed.pseudoSourceId.slice(-3)}`
          : parsed.pseudoSourceId,
      time: typeof parsed.eventTimeUtc === 'string' ? shortTimeUtc(parsed.eventTimeUtc) : parsed.eventTimeUtc,
      metric: `${parsed.category}.${parsed.metric} = ${parsed.value}`,
      severity: parsed.severity,
      health: parsed.healthState,
      summary: parsed.contextSummary,
    };
    return JSON.stringify(displayObj, null, 2);
  } catch {
    return serializedBytes;
  }
}

export function CollectorConsole({
  device,
  health,
  rawLogs,
  egressLog,
  spool,
  droppedLowSeverityTotal,
  outageActive,
  lastHeartbeatUtc,
  reconcile,
  token,
  onRefresh,
}: CollectorConsoleProps) {
  const [tab, setTab] = useState<ConsoleTab>('egress');
  const [selectedPayloadId, setSelectedPayloadId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [showFullRawBytes, setShowFullRawBytes] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedAnomaly, setSelectedAnomaly] = useState<ScenarioType>('disk_io_saturation');

  // Custom raw injection state
  const [rawMsg, setRawMsg] = useState(
    'User auth failure password=TopSecretPass99! token=sk-live-8877665544332211'
  );
  const [extraKey, setExtraKey] = useState('employeeSsn');
  const [extraVal, setExtraVal] = useState('999-00-1234');
  const [testLastGate, setTestLastGate] = useState(false);

  // NDJSON test input
  const [ndjsonInput, setNdjsonInput] = useState(
    JSON.stringify({ deviceUid: device.uid, metric: 'pos_tx_latency_ms', value: 42.5, message: 'Stream health sample' })
  );

  const selectedRecord =
    egressLog.find((r) => r.payloadId === selectedPayloadId) ?? egressLog[0] ?? null;

  const copyValue = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopiedId(key);
    window.setTimeout(() => setCopiedId((cur) => (cur === key ? null : cur)), 1500);
  };

  const triggerScenario = async (type: ScenarioRequest['type']) => {
    setBusyAction(type);
    setActionFeedback(null);
    try {
      const res = await fetch('/api/collector/scenario', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ type, deviceUid: device.uid, region: device.region }),
      });
      const data = await res.json();
      if (data.records?.[0]?.payloadId) {
        setSelectedPayloadId(data.records[0].payloadId);
      }
      setActionFeedback(data.message || data.error || 'Action completed.');
      onRefresh();
    } catch {
      setActionFeedback('Failed to reach collector service.');
    } finally {
      setBusyAction(null);
    }
  };

  const toggleHeartbeatOffline = async () => {
    setBusyAction('heartbeat');
    try {
      const res = await fetch(`/api/collector/device/${encodeURIComponent(device.uid)}/heartbeat-toggle`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setActionFeedback(
        data.online
          ? 'Collector heartbeat restored (online).'
          : 'Collector marked unreachable (>90s stale heartbeat).'
      );
      onRefresh();
    } finally {
      setBusyAction(null);
    }
  };

  const handleInjectRaw = async (e: FormEvent) => {
    e.preventDefault();
    if (!rawMsg.trim()) return;
    setBusyAction('custom-raw');
    try {
      const res = await fetch('/api/collector/inject-raw', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          deviceUid: device.uid,
          category: 'security',
          metric: 'custom_log_audit',
          value: 1,
          severity: 'high',
          rawMessage: rawMsg,
          extraFieldKey: extraKey,
          extraFieldVal: extraVal,
          testLastGateBlock: testLastGate,
        }),
      });
      const data = await res.json();
      if (data.record) {
        setSelectedPayloadId(data.record.payloadId);
        setTab('egress');
        setActionFeedback(
          data.record.status === 'blocked'
            ? `Safety gate held ${shortEventId(data.record.payloadId)} locally before transmission.`
            : `Processed ${shortEventId(data.record.payloadId)}: stripped ${data.record.removedSecrets.length} secret(s) and ${data.record.droppedFields.length} extra field(s).`
        );
      }
      onRefresh();
    } finally {
      setBusyAction(null);
    }
  };

  const handleNdjsonIngest = async () => {
    setBusyAction('ndjson');
    try {
      const res = await fetch('/api/collector/ndjson', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ndjson: ndjsonInput }),
      });
      const data = await res.json();
      setActionFeedback(`Ingested ${data.ingestedCount ?? 0} NDJSON record(s).`);
      onRefresh();
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#0E1117] text-zinc-100">
      {/* Compact Status & Scenario Actions Bar */}
      <div className="border-b border-[#222733] bg-[#12151C] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-medium ${
                outageActive
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              }`}
            >
              {outageActive ? <WifiOff className="h-3.5 w-3.5" /> : <Wifi className="h-3.5 w-3.5" />}
              {outageActive ? 'Offline Spooling' : 'mTLS Connected'}
            </span>
            <span className="font-mono text-[11px] text-zinc-400 tabular-nums">
              Queue: {spool.length} · Heartbeat: {health.isStale ? `Stale (${health.staleAgeSeconds}s)` : 'OK'}
            </span>
          </div>

          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh Collector State"
            className="inline-flex items-center gap-1.5 rounded-md border border-[#2B3242] bg-[#1A1E28] px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-[#232836] hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>

        {/* Action Controls + Anomaly Selector */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => triggerScenario('secret_in_log')}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            Test Secret Redaction
          </button>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => triggerScenario('saas_outage_toggle')}
            className="rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-[#232836] disabled:opacity-50 transition-colors"
          >
            {outageActive ? 'Restore Connection' : 'Simulate Outage'}
          </button>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => triggerScenario('duplicate_replay')}
            className="rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-[#232836] disabled:opacity-50 transition-colors"
          >
            Test Duplicate Replay
          </button>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => triggerScenario('out_of_order_delivery')}
            className="rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-[#232836] disabled:opacity-50 transition-colors"
          >
            Out-of-Order Event
          </button>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => triggerScenario('clock_skew')}
            className="rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-[#232836] disabled:opacity-50 transition-colors"
          >
            Clock Skew (+120s)
          </button>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={toggleHeartbeatOffline}
            className="rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-[#232836] disabled:opacity-50 transition-colors"
          >
            {health.isStale ? 'Restore Heartbeat' : 'Simulate Stale Heartbeat'}
          </button>

          <div className="flex items-center gap-1.5 pl-1 border-l border-[#222733]">
            <select
              aria-label="Select device anomaly scenario"
              value={selectedAnomaly}
              onChange={(e) => setSelectedAnomaly(e.target.value as ScenarioType)}
              className="rounded-md border border-[#2B3242] bg-[#0B0D11] px-2.5 py-1.5 text-xs text-zinc-200"
            >
              {EXTRA_ANOMALIES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => triggerScenario(selectedAnomaly)}
              className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/25 disabled:opacity-50"
            >
              <Zap className="h-3 w-3" />
              Inject Anomaly
            </button>
          </div>
        </div>

        {actionFeedback && (
          <div className="mt-2.5 rounded-md border border-[#2B3242] bg-[#181C25] px-3 py-1.5 text-xs text-zinc-200">
            {actionFeedback}
          </div>
        )}
      </div>

      {/* Sub-navigation Tabs */}
      <div className="flex items-center gap-1 border-b border-[#222733] bg-[#0F1218] px-4 py-2">
        <button
          type="button"
          onClick={() => setTab('egress')}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            tab === 'egress' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white'
          }`}
        >
          Outbound Verification ({egressLog.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('raw')}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            tab === 'raw' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white'
          }`}
        >
          Local Logs & Privacy Test ({rawLogs.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('spool')}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            tab === 'spool' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white'
          }`}
        >
          Offline Queue & Sync ({spool.length})
        </button>
      </div>

      {/* Tab Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'egress' && (
          <div className="grid gap-4 lg:grid-cols-12">
            {/* Compact Event List */}
            <div className="lg:col-span-5 space-y-2">
              <h3 className="text-xs font-medium text-zinc-400">Recent Outbound Events</h3>
              {egressLog.length === 0 ? (
                <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4 text-xs text-zinc-400">
                  No outbound telemetry processed yet.
                </div>
              ) : (
                <div className="max-h-[430px] space-y-1.5 overflow-y-auto pr-1">
                  {egressLog.map((rec) => {
                    const active = selectedRecord?.payloadId === rec.payloadId;
                    return (
                      <button
                        key={rec.payloadId}
                        type="button"
                        onClick={() => setSelectedPayloadId(rec.payloadId)}
                        className={`w-full rounded-lg border p-2.5 text-left transition-colors ${
                          active
                            ? 'border-blue-500/80 bg-[#171B24]'
                            : 'border-[#222733] bg-[#12151C] hover:border-zinc-700'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-medium text-white" title={rec.payloadId}>
                            {shortEventId(rec.payloadId)}
                          </span>
                          <span
                            className={`text-[11px] font-medium ${
                              rec.status === 'delivered'
                                ? 'text-emerald-400'
                                : rec.status === 'blocked'
                                  ? 'text-rose-400'
                                  : 'text-amber-400'
                            }`}
                          >
                            {rec.status === 'delivered' ? 'Delivered' : rec.status === 'blocked' ? 'Held Locally' : 'Queued'}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-400">
                          <span>
                            {rec.removedSecrets.length} redacted · {rec.droppedFields.length} dropped · {shortTimeUtc(rec.createdAtUtc)}
                          </span>
                          {rec.hashVerified && <span className="text-emerald-400">Verified</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Egress Proof Inspector */}
            <div className="lg:col-span-7">
              {selectedRecord ? (
                <div className="space-y-3 rounded-lg border border-[#222733] bg-[#12151C] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222733] pb-3">
                    <div>
                      <div className="text-xs text-zinc-400">Outbound Payload Proof</div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-white" title={selectedRecord.payloadId}>
                          {shortEventId(selectedRecord.payloadId)}
                        </span>
                        <button
                          type="button"
                          onClick={() => copyValue('id', selectedRecord.payloadId)}
                          className="inline-flex items-center gap-1 rounded border border-[#2B3242] bg-[#1A1E28] px-1.5 py-0.5 text-[10px] text-zinc-400 hover:text-white"
                          title={`Copy full ID: ${selectedRecord.payloadId}`}
                        >
                          {copiedId === 'id' ? <Check className="h-2.5 w-2.5 text-emerald-400" /> : <Copy className="h-2.5 w-2.5" />}
                          {copiedId === 'id' ? 'Copied' : 'Full ID'}
                        </button>
                      </div>
                    </div>
                    {selectedRecord.status === 'blocked' ? (
                      <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300">
                        <ShieldAlert className="h-3.5 w-3.5" />
                        Held Locally (Safety Gate)
                      </span>
                    ) : selectedRecord.hashVerified ? (
                      <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        SHA-256 Match Verified
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300">
                        <Clock className="h-3.5 w-3.5" />
                        Buffered in Local Spool
                      </span>
                    )}
                  </div>

                  {selectedRecord.blockedReason && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                      Safety gate held this event locally so unredacted credentials never leave the device.
                    </div>
                  )}

                  {selectedRecord.clockSkewFlagged && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200">
                      Clock skew normalized to server UTC ({shortTimeUtc(selectedRecord.serverFallbackUtc ?? '')}).
                    </div>
                  )}

                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-zinc-300">Sanitized Metadata Sent Over mTLS</span>
                      <button
                        type="button"
                        onClick={() => setShowFullRawBytes(!showFullRawBytes)}
                        className="text-[11px] text-blue-400 hover:text-blue-300"
                      >
                        {showFullRawBytes ? 'Readable View' : 'Raw JSON Bytes'}
                      </button>
                    </div>
                    <pre className="mt-1.5 whitespace-pre-wrap break-all rounded-md border border-[#222733] bg-[#0B0D11] p-3 font-mono text-[11px] text-zinc-200">
                      {showFullRawBytes
                        ? selectedRecord.serializedBytes || '(Held before egress)'
                        : formatCleanPayloadPreview(selectedRecord.serializedBytes)}
                    </pre>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md border border-[#222733] bg-[#0B0D11] p-3">
                      <div className="flex items-center justify-between text-[11px] text-zinc-400">
                        <span>Collector SHA-256</span>
                        {selectedRecord.egressSha256 && (
                          <button
                            type="button"
                            onClick={() => copyValue('ehash', selectedRecord.egressSha256)}
                            className="text-[10px] text-zinc-400 hover:text-white"
                            title={selectedRecord.egressSha256}
                          >
                            {copiedId === 'ehash' ? 'Copied' : 'Copy'}
                          </button>
                        )}
                      </div>
                      <div className="mt-1 font-mono text-xs text-zinc-200" title={selectedRecord.egressSha256}>
                        {shortHash(selectedRecord.egressSha256)}
                      </div>
                    </div>
                    <div className="rounded-md border border-[#222733] bg-[#0B0D11] p-3">
                      <div className="flex items-center justify-between text-[11px] text-zinc-400">
                        <span>Regional SaaS SHA-256</span>
                        {selectedRecord.saasStoredSha256 && (
                          <button
                            type="button"
                            onClick={() => copyValue('shash', selectedRecord.saasStoredSha256!)}
                            className="text-[10px] text-zinc-400 hover:text-white"
                            title={selectedRecord.saasStoredSha256}
                          >
                            {copiedId === 'shash' ? 'Copied' : 'Copy'}
                          </button>
                        )}
                      </div>
                      <div className="mt-1 font-mono text-xs text-emerald-400" title={selectedRecord.saasStoredSha256}>
                        {selectedRecord.saasStoredSha256 ? shortHash(selectedRecord.saasStoredSha256) : 'Pending / Held'}
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 text-xs">
                    <div className="rounded-md border border-[#222733] bg-[#0B0D11] p-3">
                      <div className="font-medium text-zinc-300">
                        Dropped Private Fields ({selectedRecord.droppedFields.length})
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-zinc-400">
                        {selectedRecord.droppedFields.length > 0
                          ? selectedRecord.droppedFields.join(', ')
                          : 'None'}
                      </div>
                    </div>
                    <div className="rounded-md border border-[#222733] bg-[#0B0D11] p-3">
                      <div className="font-medium text-zinc-300">
                        Redacted Secrets ({selectedRecord.removedSecrets.length})
                      </div>
                      <div className="mt-1 space-y-1 font-mono text-[11px] text-zinc-400">
                        {selectedRecord.removedSecrets.length > 0
                          ? selectedRecord.removedSecrets.map((s, idx) => (
                              <div key={idx}>
                                {s.pattern} ({s.snippetPreview})
                              </div>
                            ))
                          : 'None detected'}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-[#222733] bg-[#12151C] p-6 text-xs text-zinc-400">
                  Select an event on the left to inspect its sanitized payload and SHA-256 verification.
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'raw' && (
          <div className="grid gap-4 lg:grid-cols-12">
            <form onSubmit={handleInjectRaw} className="lg:col-span-5 space-y-3 rounded-lg border border-[#222733] bg-[#12151C] p-4">
              <h3 className="text-xs font-semibold text-white">Custom Log & Privacy Filter Test</h3>
              <p className="text-[11px] text-zinc-400">
                Raw logs stay on this device. Test how passwords, API keys, and private fields are stripped before leaving Tier 1.
              </p>

              <div>
                <label htmlFor="raw-msg-input" className="block text-[11px] font-medium text-zinc-300">
                  Raw Event Message
                </label>
                <textarea
                  id="raw-msg-input"
                  rows={3}
                  value={rawMsg}
                  onChange={(e) => setRawMsg(e.target.value)}
                  className="mt-1 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] p-2.5 font-mono text-xs text-zinc-100 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="extra-key" className="block text-[11px] font-medium text-zinc-300">
                    Extra Field Name
                  </label>
                  <input
                    id="extra-key"
                    type="text"
                    value={extraKey}
                    onChange={(e) => setExtraKey(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                  />
                </div>
                <div>
                  <label htmlFor="extra-val" className="block text-[11px] font-medium text-zinc-300">
                    Extra Field Value
                  </label>
                  <input
                    id="extra-val"
                    type="text"
                    value={extraVal}
                    onChange={(e) => setExtraVal(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={testLastGate}
                  onChange={(e) => setTestLastGate(e.target.checked)}
                  className="rounded border-[#2B3242] bg-[#0B0D11]"
                />
                Test safety gate block (hold unredacted leak locally)
              </label>

              <button
                type="submit"
                disabled={busyAction !== null}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-500"
              >
                <Send className="h-3.5 w-3.5" />
                Run Privacy Filter & Dispatch
              </button>
            </form>

            <div className="lg:col-span-7 space-y-2">
              <h3 className="text-xs font-semibold text-white">
                Local Tier 1 Raw Event Buffer (Stays On-Device)
              </h3>
              <div className="max-h-[420px] space-y-2 overflow-y-auto">
                {rawLogs.map((log) => (
                  <div
                    key={log.id}
                    className="rounded-lg border border-[#222733] bg-[#12151C] p-3 text-xs"
                  >
                    <div className="flex items-center justify-between text-[11px] text-zinc-400">
                      <span className="font-medium text-zinc-200">
                        {log.channel} · Event {log.eventId} · {log.level}
                      </span>
                      <span className="font-mono tabular-nums">{shortTimeUtc(log.timestampUtc)}</span>
                    </div>
                    <div className="mt-1.5 break-all font-mono text-[11px] text-zinc-300">{log.message}</div>
                    {log.containsSecret && (
                      <div className="mt-1.5 text-[11px] font-medium text-amber-400">
                        Local secret detected — stripped before SaaS upload
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'spool' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">Delivery Reconciliation</h3>
                  <p className="text-xs text-zinc-400">
                    Confirms every event sent by the collector arrived once at the Regional SaaS store.
                  </p>
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-xs font-medium ${
                    reconcile.matched
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                  }`}
                >
                  <Database className="h-3.5 w-3.5" />
                  {reconcile.matched ? 'Reconciled: 0 Lost · 0 Duplicates' : `In-flight Queue (${reconcile.lostCount} pending)`}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 font-mono tabular-nums">
                <div className="rounded-md border border-[#222733] bg-[#0B0D11] p-3">
                  <div className="text-[11px] text-zinc-400">Sent Events</div>
                  <div className="mt-1 text-lg font-semibold text-white">{reconcile.sentCount}</div>
                </div>
                <div className="rounded-md border border-[#222733] bg-[#0B0D11] p-3">
                  <div className="text-[11px] text-zinc-400">SaaS Received</div>
                  <div className="mt-1 text-lg font-semibold text-emerald-400">{reconcile.receivedCount}</div>
                </div>
                <div className="rounded-md border border-[#222733] bg-[#0B0D11] p-3">
                  <div className="text-[11px] text-zinc-400">Lost</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-200">{reconcile.lostCount}</div>
                </div>
                <div className="rounded-md border border-[#222733] bg-[#0B0D11] p-3">
                  <div className="text-[11px] text-zinc-400">Duplicates Blocked</div>
                  <div className="mt-1 text-lg font-semibold text-amber-400">{reconcile.duplicateCount}</div>
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4">
                <div className="flex items-center justify-between text-xs">
                  <h3 className="font-semibold text-white">Local WAL Queue ({spool.length})</h3>
                  <span className="font-mono text-[11px] text-zinc-400">
                    Cap drops: {droppedLowSeverityTotal} · HB: {shortTimeUtc(lastHeartbeatUtc)}
                  </span>
                </div>
                {spool.length === 0 ? (
                  <p className="mt-3 text-xs text-zinc-400">
                    Queue is clear. Click "Simulate Outage" above to buffer events locally during disconnect.
                  </p>
                ) : (
                  <div className="mt-3 max-h-48 space-y-1.5 overflow-y-auto">
                    {spool.map((item) => (
                      <div
                        key={item.payload.payloadId}
                        className="flex items-center justify-between rounded border border-[#222733] bg-[#0B0D11] px-2.5 py-1.5 font-mono text-[11px]"
                      >
                        <span className="text-blue-400" title={item.payload.payloadId}>
                          {shortEventId(item.payload.payloadId)}
                        </span>
                        <span className="text-zinc-400">
                          {item.payload.metric}={item.payload.value} ({item.payload.severity})
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-white">
                  <FileCode2 className="h-4 w-4 text-blue-400" />
                  NDJSON Stream Adapter
                </div>
                <textarea
                  rows={3}
                  value={ndjsonInput}
                  onChange={(e) => setNdjsonInput(e.target.value)}
                  className="mt-2 w-full rounded-md border border-[#2B3242] bg-[#0B0D11] p-2 font-mono text-[11px] text-zinc-200"
                />
                <button
                  type="button"
                  onClick={handleNdjsonIngest}
                  className="mt-2 rounded-md border border-[#2B3242] bg-[#1A1E28] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#232836]"
                >
                  Ingest NDJSON Line(s)
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
