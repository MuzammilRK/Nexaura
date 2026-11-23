import { Activity, Cpu, Wifi } from 'lucide-react';
import type { HealthState } from '../shared/schema';

export interface TelemetryHealthVisualsProps {
  title: string;
  subtitle?: string;
  score: number;
  state: HealthState;
  subScores: {
    availability: { score: number; weight: number };
    resource: { score: number; weight: number };
    network: { score: number; weight: number };
    security: { score: number; weight: number };
  };
  cpuPct: number;
  memoryPct: number;
  latencyMs: number;
  diskPct: number;
  packetLossPct: number;
  failedLogins: number;
  isStale: boolean;
  cpuHistory?: number[];
  latencyHistory?: number[];
  compact?: boolean;
}

const STATE_PALETTE: Record<
  HealthState,
  { stroke: string; text: string; bar: string; trackBorder: string; label: string }
> = {
  Excellent: {
    stroke: '#10b981',
    text: 'text-emerald-400',
    bar: 'bg-emerald-500',
    trackBorder: 'border-emerald-500/30',
    label: 'Nominal Rhythm',
  },
  Good: {
    stroke: '#3b82f6',
    text: 'text-blue-400',
    bar: 'bg-blue-500',
    trackBorder: 'border-blue-500/30',
    label: 'Steady Rhythm',
  },
  Fair: {
    stroke: '#f59e0b',
    text: 'text-amber-400',
    bar: 'bg-amber-500',
    trackBorder: 'border-amber-500/30',
    label: 'Elevated Load',
  },
  Poor: {
    stroke: '#ef4444',
    text: 'text-rose-400',
    bar: 'bg-rose-500',
    trackBorder: 'border-rose-500/35',
    label: 'Critical Fault',
  },
};

function buildSingleCyclePath(
  startX: number,
  stepW: number,
  midY: number,
  height: number,
  state: HealthState,
  cpuPct: number,
  latencyMs: number,
  cIdx: number
): string {
  const ampScale = Math.min(1.25, Math.max(0.75, 0.72 + cpuPct / 180));
  const noise = state === 'Poor' ? 5.5 : state === 'Fair' ? 2.5 : 0;
  const j = cIdx % 2 === 0 ? noise : -noise;
  const pUp = 6 * ampScale;
  const qDown = 8 * ampScale;
  const rPeak = (state === 'Poor' ? 26 : 23) * ampScale + (cIdx % 2 === 0 ? latencyMs * 0.015 : 0);
  const sDown = 12 * ampScale;
  const tUp = 9 * ampScale;

  return (
    ` L ${(startX + stepW * 0.14).toFixed(1)} ${(midY + j * 0.3).toFixed(1)}` +
    ` Q ${(startX + stepW * 0.21).toFixed(1)} ${(midY - pUp).toFixed(1)}, ${(startX + stepW * 0.28).toFixed(1)} ${midY.toFixed(1)}` +
    ` L ${(startX + stepW * 0.36).toFixed(1)} ${midY.toFixed(1)}` +
    ` L ${(startX + stepW * 0.41).toFixed(1)} ${(midY + qDown).toFixed(1)}` +
    ` L ${(startX + stepW * 0.47).toFixed(1)} ${Math.max(4, midY - rPeak).toFixed(1)}` +
    ` L ${(startX + stepW * 0.53).toFixed(1)} ${Math.min(height - 4, midY + sDown).toFixed(1)}` +
    ` L ${(startX + stepW * 0.59).toFixed(1)} ${(midY - j * 0.5).toFixed(1)}` +
    ` Q ${(startX + stepW * 0.72).toFixed(1)} ${(midY - tUp).toFixed(1)}, ${(startX + stepW * 0.84).toFixed(1)} ${midY.toFixed(1)}` +
    ` L ${(startX + stepW).toFixed(1)} ${midY.toFixed(1)}`
  );
}

function buildLoopingHeartbeatPath(
  halfWidth: number,
  height: number,
  state: HealthState,
  isStale: boolean,
  cpuPct: number,
  latencyMs: number
): string {
  const midY = height * 0.56;
  if (isStale) {
    return `M 0 ${midY} L ${halfWidth * 2} ${midY}`;
  }

  const cyclesPerHalf = state === 'Poor' ? 4 : state === 'Fair' ? 3 : 2;
  const stepW = halfWidth / cyclesPerHalf;

  let d = `M 0 ${midY}`;
  for (let repeat = 0; repeat < 2; repeat++) {
    const offset = repeat * halfWidth;
    for (let c = 0; c < cyclesPerHalf; c++) {
      d += buildSingleCyclePath(offset + c * stepW, stepW, midY, height, state, cpuPct, latencyMs, c);
    }
  }
  return d;
}

export function TelemetryHealthVisuals({
  title,
  subtitle,
  score,
  state,
  subScores,
  cpuPct,
  memoryPct,
  latencyMs,
  diskPct,
  packetLossPct,
  failedLogins,
  isStale,
  cpuHistory = [],
  latencyHistory = [],
  compact = false,
}: TelemetryHealthVisualsProps) {
  const palette = STATE_PALETTE[state];
  const halfW = 360;
  const beatH = compact ? 74 : 88;
  const beatPath = buildLoopingHeartbeatPath(halfW, beatH, state, isStale, cpuPct, latencyMs);

  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (clampedScore / 100) * circumference;

  const components = [
    { label: 'Availability', weight: '30%', value: subScores.availability.score, color: '#10b981' },
    { label: 'Resource', weight: '25%', value: subScores.resource.score, color: '#3b82f6' },
    { label: 'Network', weight: '25%', value: subScores.network.score, color: '#f59e0b' },
    { label: 'Security', weight: '20%', value: subScores.security.score, color: '#94a3b8' },
  ];

  const cpuSeries = cpuHistory.length >= 2 ? cpuHistory.slice(-14) : [cpuPct * 0.88, cpuPct * 0.94, cpuPct, cpuPct * 0.97, cpuPct];
  const latSeries = latencyHistory.length >= 2 ? latencyHistory.slice(-14) : [latencyMs * 0.85, latencyMs, latencyMs * 1.05, latencyMs * 0.95, latencyMs];
  const maxCpu = Math.max(100, ...cpuSeries);
  const maxLat = Math.max(80, ...latSeries);

  return (
    <div className="rounded-lg border border-[#222733] bg-[#12151C] p-4 space-y-4">
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222733] pb-3">
        <div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-zinc-400">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-3 font-mono text-xs tabular-nums">
          <span className="text-zinc-400">
            Status: <span className="text-zinc-200">{isStale ? 'STALE' : palette.label}</span>
          </span>
          <span className={`font-semibold ${palette.text}`}>
            {state} · {clampedScore}/100
          </span>
        </div>
      </div>

      {/* Main Grid: Radial Gauge + Live Moving Heart Beat Monitor + Component Bar Chart */}
      <div className="grid gap-4 lg:grid-cols-12">
        {/* Radial Health Ring + Key Telemetry */}
        <div className="lg:col-span-4 flex flex-col justify-between gap-3 rounded-md border border-[#222733] bg-[#0B0D11] p-3.5">
          <div className="flex items-center gap-3">
            <svg width="72" height="72" viewBox="0 0 80 80" className="shrink-0" aria-label={`Health score gauge ${clampedScore}`}>
              <circle
                cx="40"
                cy="40"
                r={radius}
                fill="none"
                stroke="#1E2430"
                strokeWidth="7"
              />
              <circle
                cx="40"
                cy="40"
                r={radius}
                fill="none"
                stroke={palette.stroke}
                strokeWidth="7"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                transform="rotate(-90 40 40)"
              />
              <text
                x="40"
                y="45"
                textAnchor="middle"
                fill="#FFFFFF"
                fontSize="16"
                fontWeight="700"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {clampedScore}
              </text>
            </svg>
            <div className="min-w-0">
              <div className={`text-xs font-semibold ${palette.text}`}>{palette.label}</div>
              <div className="mt-0.5 text-[11px] text-zinc-400">Weighted Fleet Score</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-[#1B202C] pt-2.5 font-mono text-[11px] text-zinc-300 tabular-nums">
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">CPU</span>
              <span>{cpuPct}%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Mem</span>
              <span>{memoryPct}%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Lat</span>
              <span>{latencyMs}ms</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Loss</span>
              <span>{packetLossPct}%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Disk</span>
              <span>{diskPct}%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Auth</span>
              <span className={failedLogins > 0 ? 'text-amber-400' : ''}>{failedLogins}</span>
            </div>
          </div>
        </div>

        {/* Animated Live Heart Beat Monitor */}
        <div className={`lg:col-span-4 flex flex-col justify-between rounded-md border ${palette.trackBorder} bg-[#0B0D11] p-3`}>
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1.5 font-medium text-zinc-200">
              <Activity className={`h-3.5 w-3.5 shrink-0 ${palette.text}`} />
              Heart Beat Monitor
            </span>
            <span className="font-mono text-zinc-400 tabular-nums shrink-0">
              {isStale ? 'Signal Lost' : `${latencyMs}ms`}
            </span>
          </div>
          <div className="relative mt-2 h-24 overflow-hidden rounded border border-[#1B202C] bg-[#080A0E]">
            {/* Fixed oscilloscope background grid */}
            <svg
              viewBox={`0 0 ${halfW} ${beatH}`}
              className="pointer-events-none absolute inset-0 h-full w-full"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {[18, 36, 54, 72].map((gy) => (
                <line key={gy} x1="0" y1={gy} x2={halfW} y2={gy} stroke="#141A24" strokeWidth="1" />
              ))}
              {[45, 90, 135, 180, 225, 270, 315].map((gx) => (
                <line key={gx} x1={gx} y1="0" x2={gx} y2={beatH} stroke="#141A24" strokeWidth="1" />
              ))}
            </svg>
            {/* Moving seamless 200%-width heartbeat waveform */}
            <svg
              viewBox={`0 0 ${halfW * 2} ${beatH}`}
              className={`relative block h-full w-[200%] ${isStale ? '' : 'animate-heartbeat-sweep'}`}
              preserveAspectRatio="none"
              role="img"
              aria-label="Live moving Heart Beat Monitor waveform chart"
            >
              <path
                d={beatPath}
                fill="none"
                stroke={palette.stroke}
                strokeWidth="2.1"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </div>

        {/* Weighted Component Bar Chart */}
        <div className="lg:col-span-4 rounded-md border border-[#222733] bg-[#0B0D11] p-3">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-medium text-zinc-200">Weighted Component Bars</span>
            <span className="font-mono text-zinc-500">0–100</span>
          </div>
          <div className="mt-2.5 space-y-2">
            {components.map((comp) => (
              <div key={comp.label} className="space-y-1">
                <div className="flex items-center justify-between text-[11px] font-mono tabular-nums">
                  <span className="font-sans text-zinc-300">
                    {comp.label} <span className="text-zinc-500">({comp.weight})</span>
                  </span>
                  <span className="text-white font-semibold">{comp.value}</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-sm bg-[#1A202C]">
                  <div
                    className="h-full transition-all duration-300"
                    style={{
                      width: `${Math.max(4, Math.min(100, comp.value))}%`,
                      backgroundColor: comp.color,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Row: CPU & Latency Historical Bar Sparklines */}
      {!compact && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-md border border-[#222733] bg-[#0B0D11] p-3">
            <div className="flex items-center justify-between text-[11px]">
              <span className="inline-flex items-center gap-1.5 font-medium text-zinc-300">
                <Cpu className="h-3.5 w-3.5 text-blue-400" />
                CPU Utilization Bar History
              </span>
              <span className="font-mono text-zinc-400 tabular-nums">{cpuPct}% current</span>
            </div>
            <div className="mt-2 flex h-12 items-end gap-1" aria-label="CPU utilization bar chart">
              {cpuSeries.map((val, idx) => {
                const hPct = Math.max(8, Math.round((val / maxCpu) * 100));
                const barColor = val >= 85 ? 'bg-rose-500' : val >= 70 ? 'bg-amber-500' : 'bg-blue-500';
                return (
                  <div
                    key={idx}
                    title={`Sample ${idx + 1}: ${val}%`}
                    className={`flex-1 rounded-t-sm ${barColor} transition-all`}
                    style={{ height: `${hPct}%` }}
                  />
                );
              })}
            </div>
          </div>

          <div className="rounded-md border border-[#222733] bg-[#0B0D11] p-3">
            <div className="flex items-center justify-between text-[11px]">
              <span className="inline-flex items-center gap-1.5 font-medium text-zinc-300">
                <Wifi className="h-3.5 w-3.5 text-emerald-400" />
                Network Latency Bar History
              </span>
              <span className="font-mono text-zinc-400 tabular-nums">{latencyMs} ms current</span>
            </div>
            <div className="mt-2 flex h-12 items-end gap-1" aria-label="Latency bar chart">
              {latSeries.map((val, idx) => {
                const hPct = Math.max(8, Math.round((val / maxLat) * 100));
                const barColor = val >= 160 ? 'bg-rose-500' : val >= 80 ? 'bg-amber-500' : 'bg-emerald-500';
                return (
                  <div
                    key={idx}
                    title={`Sample ${idx + 1}: ${val} ms`}
                    className={`flex-1 rounded-t-sm ${barColor} transition-all`}
                    style={{ height: `${hPct}%` }}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
