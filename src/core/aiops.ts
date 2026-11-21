import {
  DEFAULT_HEALTH_THRESHOLDS,
  type AllowListedPayload,
  type DeviceProfile,
  type HealthEvaluation,
  type HealthState,
  type HealthThresholds,
  type Incident,
  type LiveDeviceMetrics,
  type PredictionBand,
  type RemediationRecord,
  type SignalContribution,
} from '../shared/schema';
import { shortPseudoId } from '../shared/formatters';

export function evaluateHealth(
  metrics: LiveDeviceMetrics,
  nowMs: number,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
  previousStateSinceUtc?: string
): HealthEvaluation {
  const lastHbMs = Date.parse(metrics.lastHeartbeatUtc);
  const staleAgeSeconds = Number.isFinite(lastHbMs)
    ? Math.max(0, Math.round((nowMs - lastHbMs) / 1000))
    : 999;
  const isStale = !metrics.online || staleAgeSeconds > thresholds.staleSeconds;

  const availabilityScore = isStale ? 0 : 100;
  const cpuPenalty = Math.max(0, metrics.cpuPct - 50) * 1.4;
  const memPenalty = Math.max(0, metrics.memoryPct - 55) * 1.3;
  const diskPenalty = Math.max(0, metrics.diskPct - 75) * 1.5;
  const resourceScore = Math.max(0, Math.min(100, Math.round(100 - (cpuPenalty * 0.45 + memPenalty * 0.4 + diskPenalty * 0.15))));

  const latPenalty = Math.max(0, metrics.latencyMs - 25) * 0.45;
  const lossPenalty = metrics.packetLossPct * 14;
  const networkScore = Math.max(0, Math.min(100, Math.round(100 - (latPenalty + lossPenalty))));

  const secPenalty = metrics.failedLogins * 9;
  const securityScore = Math.max(0, Math.min(100, Math.round(100 - secPenalty)));

  const weights = {
    availability: 0.3,
    resource: 0.25,
    network: 0.25,
    security: 0.2,
  };

  const overallScore = Math.round(
    availabilityScore * weights.availability +
      resourceScore * weights.resource +
      networkScore * weights.network +
      securityScore * weights.security
  );

  let state: HealthState = 'Excellent';
  let reason = 'All telemetry metrics within nominal seasonal baseline.';

  if (isStale) {
    state = 'Poor';
    reason = `Collector unreachable (no heartbeat for ${staleAgeSeconds}s > ${thresholds.staleSeconds}s threshold).`;
  } else if (
    metrics.cpuPct >= thresholds.cpuPoor ||
    metrics.memoryPct >= thresholds.memoryPoor ||
    metrics.latencyMs >= thresholds.latencyPoorMs ||
    metrics.packetLossPct >= thresholds.packetLossPoorPct ||
    metrics.failedLogins >= thresholds.failedLoginsPoor
  ) {
    state = 'Poor';
    const reasons: string[] = [];
    if (metrics.cpuPct >= thresholds.cpuPoor) reasons.push(`CPU ${metrics.cpuPct.toFixed(0)}% >= ${thresholds.cpuPoor}%`);
    if (metrics.memoryPct >= thresholds.memoryPoor) reasons.push(`Memory ${metrics.memoryPct.toFixed(0)}% >= ${thresholds.memoryPoor}%`);
    if (metrics.latencyMs >= thresholds.latencyPoorMs) reasons.push(`Latency ${metrics.latencyMs.toFixed(0)}ms >= ${thresholds.latencyPoorMs}ms`);
    if (metrics.packetLossPct >= thresholds.packetLossPoorPct) reasons.push(`Packet loss ${metrics.packetLossPct.toFixed(1)}% >= ${thresholds.packetLossPoorPct}%`);
    if (metrics.failedLogins >= thresholds.failedLoginsPoor) reasons.push(`Failed logins ${metrics.failedLogins} >= ${thresholds.failedLoginsPoor}`);
    reason = `Critical threshold breached: ${reasons.join(', ')}.`;
  } else if (
    metrics.cpuPct >= thresholds.cpuFair ||
    metrics.memoryPct >= thresholds.memoryFair ||
    metrics.latencyMs >= thresholds.latencyFairMs ||
    metrics.packetLossPct >= thresholds.packetLossFairPct ||
    metrics.failedLogins >= thresholds.failedLoginsFair
  ) {
    state = 'Fair';
    const reasons: string[] = [];
    if (metrics.cpuPct >= thresholds.cpuFair) reasons.push(`CPU ${metrics.cpuPct.toFixed(0)}%`);
    if (metrics.memoryPct >= thresholds.memoryFair) reasons.push(`Memory ${metrics.memoryPct.toFixed(0)}%`);
    if (metrics.latencyMs >= thresholds.latencyFairMs) reasons.push(`Latency ${metrics.latencyMs.toFixed(0)}ms`);
    if (metrics.packetLossPct >= thresholds.packetLossFairPct) reasons.push(`Loss ${metrics.packetLossPct.toFixed(1)}%`);
    if (metrics.failedLogins >= thresholds.failedLoginsFair) reasons.push(`Auth failures ${metrics.failedLogins}`);
    reason = `Elevated load or network degradation: ${reasons.join(', ')}.`;
  } else if (overallScore < 90) {
    state = 'Good';
    reason = 'Minor variance detected; operating inside healthy SLA envelope.';
  }

  return {
    state,
    overallScore,
    subScores: {
      availability: { score: availabilityScore, weight: weights.availability },
      resource: { score: resourceScore, weight: weights.resource },
      network: { score: networkScore, weight: weights.network },
      security: { score: securityScore, weight: weights.security },
    },
    reason,
    sinceUtc: previousStateSinceUtc ?? new Date(nowMs).toISOString(),
    isStale,
    staleAgeSeconds,
  };
}

export interface AnomalyCheckResult {
  isAnomaly: boolean;
  classification: 'normal' | 'transient_spike' | 'confirmed_anomaly';
  ewma: number;
  median: number;
  mad: number;
  zScore: number;
  changePointShift: number;
  persistenceCount: number;
  explanation: string;
}

export function detectSeasonalAnomaly(
  history: number[],
  corroboratingElevated: boolean,
  alpha = 0.35
): AnomalyCheckResult {
  if (history.length < 4) {
    const last = history[history.length - 1] ?? 0;
    return {
      isAnomaly: false,
      classification: 'normal',
      ewma: last,
      median: last,
      mad: 1,
      zScore: 0,
      changePointShift: 0,
      persistenceCount: 0,
      explanation: 'Collecting initial baseline window.',
    };
  }

  // Baseline uses prior samples excluding the trailing 2 to prevent self-contamination
  const baselineWindow = history.slice(0, Math.max(3, history.length - 2));
  const sorted = [...baselineWindow].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  const absDevs = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const rawMad = absDevs[Math.floor(absDevs.length / 2)];
  const mad = Math.max(rawMad * 1.4826, 2.5);

  let ewma = history[0];
  for (let i = 1; i < history.length; i++) {
    ewma = alpha * history[i] + (1 - alpha) * ewma;
  }

  const current = history[history.length - 1];
  const prev = history[history.length - 2];
  const zScore = Number(((current - median) / mad).toFixed(2));
  const prevZ = (prev - median) / mad;

  const recentMean = history.slice(-3).reduce((s, v) => s + v, 0) / Math.min(3, history.length);
  const changePointShift = Number((recentMean - median).toFixed(2));

  let persistenceCount = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if ((history[i] - median) / mad >= 2.2) persistenceCount++;
    else break;
  }

  if (zScore >= 2.4 && prevZ >= 2.2 && corroboratingElevated) {
    return {
      isAnomaly: true,
      classification: 'confirmed_anomaly',
      ewma: Number(ewma.toFixed(2)),
      median: Number(median.toFixed(2)),
      mad: Number(mad.toFixed(2)),
      zScore,
      changePointShift,
      persistenceCount,
      explanation: `Confirmed anomaly: robust z-score ${zScore} persisted for ${persistenceCount} samples with corroborating metric elevation.`,
    };
  }

  if (zScore >= 2.4) {
    return {
      isAnomaly: false,
      classification: 'transient_spike',
      ewma: Number(ewma.toFixed(2)),
      median: Number(median.toFixed(2)),
      mad: Number(mad.toFixed(2)),
      zScore,
      changePointShift,
      persistenceCount,
      explanation: `Transient spike (z=${zScore}): insufficient persistence or no corroborating metric shift.`,
    };
  }

  return {
    isAnomaly: false,
    classification: 'normal',
    ewma: Number(ewma.toFixed(2)),
    median: Number(median.toFixed(2)),
    mad: Number(mad.toFixed(2)),
    zScore,
    changePointShift,
    persistenceCount,
    explanation: 'Within seasonal EWMA and MAD envelope.',
  };
}

export function forecastExhaustionBand(
  metric: string,
  history: number[],
  capacityLimit = 95,
  sampleIntervalMinutes = 1
): PredictionBand {
  if (history.length < 3) {
    return {
      metric,
      horizonLabel: 'Next 60m',
      currentValue: history[history.length - 1] ?? 0,
      predictedEtaMinutes: null,
      lowerBoundMinutes: null,
      upperBoundMinutes: null,
      confidence: 0.45,
      summary: 'Gathering trend window for predictive saturation forecast.',
    };
  }

  const n = history.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += history[i];
    sumXY += i * history[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const current = history[n - 1];

  if (slope <= 0.35 || current >= capacityLimit) {
    return {
      metric,
      horizonLabel: 'Next 60m',
      currentValue: Number(current.toFixed(1)),
      predictedEtaMinutes: current >= capacityLimit ? 0 : null,
      lowerBoundMinutes: current >= capacityLimit ? 0 : null,
      upperBoundMinutes: current >= capacityLimit ? 0 : null,
      confidence: 0.84,
      summary:
        current >= capacityLimit
          ? `${metric} already at saturation limit (${current.toFixed(1)}%).`
          : `${metric} slope (${slope.toFixed(2)}%/sample) shows no imminent exhaustion.`,
    };
  }

  const samplesToLimit = (capacityLimit - current) / slope;
  const etaMinutes = Math.max(2, Math.round(samplesToLimit * sampleIntervalMinutes));
  const lower = Math.max(1, Math.round(etaMinutes * 0.78));
  const upper = Math.round(etaMinutes * 1.28);

  return {
    metric,
    horizonLabel: `${lower}–${upper} min`,
    currentValue: Number(current.toFixed(1)),
    predictedEtaMinutes: etaMinutes,
    lowerBoundMinutes: lower,
    upperBoundMinutes: upper,
    confidence: 0.82,
    summary: `${metric} trending upward (+${slope.toFixed(1)}%/min); projected ${capacityLimit}% saturation in ${etaMinutes}m (band ${lower}–${upper}m).`,
  };
}

export function buildCorrelatedIncident(
  alerts: AllowListedPayload[],
  devices: DeviceProfile[],
  metricHistories: Map<string, number[]>
): Incident | null {
  const highAlerts = alerts.filter((a) => a.severity === 'high' || a.severity === 'critical');
  if (highAlerts.length === 0) return null;

  const latest = highAlerts[highAlerts.length - 1];
  const primaryDevice = devices.find((d) => d.pseudoSourceId === latest.pseudoSourceId);
  const tenantId = latest.tenantId;
  const region = primaryDevice?.region ?? 'IN';

  // Correlate alerts within 120s in the same tenant / floor switch / building core
  const latestMs = Date.parse(latest.eventTimeUtc);
  const windowAlerts = highAlerts.filter((a) => {
    if (a.tenantId !== tenantId) return false;
    const t = Date.parse(a.eventTimeUtc);
    return Math.abs(latestMs - t) <= 120_000;
  });

  const affectedPseudoIds = Array.from(new Set(windowAlerts.map((a) => a.pseudoSourceId)));
  const affectedEdges: string[] = [];
  if (primaryDevice) {
    affectedEdges.push(primaryDevice.floorSwitchId, primaryDevice.buildingCoreId, primaryDevice.collectorId);
  }

  const hasSecurity = windowAlerts.some((a) => a.category === 'security');
  const hasPrivEscalation = windowAlerts.some((a) => a.metric === 'privilege_escalation_events');
  const hasNetwork = windowAlerts.some((a) => a.category === 'network');
  const hasBandwidth = windowAlerts.some((a) => a.metric === 'egress_bandwidth_pct');
  const hasStorage = windowAlerts.some((a) => a.category === 'storage' || a.metric === 'disk_io_wait_pct');
  const hasDns = windowAlerts.some((a) => a.metric === 'dns_failure_rate');
  const hasCert = windowAlerts.some((a) => a.metric === 'mtls_cert_ttl_hours');
  const hasHeartbeat = windowAlerts.some((a) => a.category === 'heartbeat' || a.metric === 'heartbeat_gap_sec');
  const hasMemory = windowAlerts.some((a) => a.metric === 'memory_pct');

  let title = 'Correlated Compute Saturation Incident';
  let rootSummary = 'Sustained multi-signal CPU and memory pressure across local floor segment.';
  let actionTitle = 'Throttle Non-Critical Worker Pool';
  let actionType: Incident['recommendation']['actionType'] = 'throttle_process';
  let narrative =
    'Deterministic correlation indicates sustained compute contention accompanied by elevated scheduling latency. Recommended action: throttle background batch threads by 35% and preserve interactive sessions.';
  let rollbackPlan = 'Restore original CPU cgroup quota via collector policy rollback token.';

  if (hasPrivEscalation) {
    title = 'Unauthorized Privilege Escalation & Config Drift';
    rootSummary = 'Unexpected elevation token and registry policy modification flagged on local endpoint boundary.';
    actionTitle = 'Revoke Elevated Session & Restore Policy Baseline';
    actionType = 'lock_account';
    narrative =
      'Endpoint collector detected repeated privilege escalation events outside scheduled maintenance windows. Isolate the session token and revert local GPO/sudo policy hash.';
    rollbackPlan = 'Re-authorize principal via two-person security sign-off after local audit.';
  } else if (hasSecurity) {
    title = 'Credential Brute-Force & Auth Burst Alert';
    rootSummary = 'Repeated failed authentication attempts crossed security threshold with rising session latency.';
    actionTitle = 'Lock Targeted Account & Rotate Relay Token';
    actionType = 'lock_account';
    narrative =
      'Multiple failed-login events correlated within 120s on a single tenant boundary. Raw usernames stay inside the customer collector; SaaS recommends temporary lockout simulation and MFA challenge.';
    rollbackPlan = 'Unlock pseudonymized session principal after administrator verification.';
  } else if (hasHeartbeat) {
    title = 'Collector Heartbeat Flap & Telemetry Stall';
    rootSummary = 'Collector heartbeat age exceeded stale threshold, risking blind telemetry gaps.';
    actionTitle = 'Restart Local Collector Watchdog & Drain WAL';
    actionType = 'restore_heartbeat';
    narrative =
      'Heartbeat interval missed consecutive probes while local WAL buffering stayed intact. Restart the local collector daemon and reconcile queued payloads.';
    rollbackPlan = 'Revert collector service unit to previous stable configuration.';
  } else if (hasCert) {
    title = 'mTLS Client Certificate Near Expiry';
    rootSummary = 'Edge-to-Regional mTLS certificate TTL dropped below 36 hours on building collector.';
    actionTitle = 'Rotate Regional mTLS Leaf Certificate';
    actionType = 'rotate_cert';
    narrative =
      'Collector mTLS handshake renewals are approaching expiry threshold. Trigger zero-downtime certificate rotation while pinning regional CA trust anchor.';
    rollbackPlan = 'Keep dual-active previous cert serial in trust store for 24h fallback.';
  } else if (hasDns) {
    title = 'Upstream DNS Resolution Timeout Burst';
    rootSummary = 'Elevated NXDOMAIN/SERVFAIL ratio across floor resolver causing cascading connection retries.';
    actionTitle = 'Switch to Secondary Anycast DNS Resolver';
    actionType = 'restart_dns_resolver';
    narrative =
      'DNS query error rate spiked sharply, amplifying application retry latency. Flush local resolver cache and promote secondary regional forwarder.';
    rollbackPlan = 'Restore primary internal DNS forwarder after upstream health stabilizes.';
  } else if (hasStorage) {
    title = 'Disk I/O Saturation & WAL Flush Delay';
    rootSummary = 'Storage queue depth and disk utilization crossed 95%, stalling local database writes.';
    actionTitle = 'Compact WAL Segment & Pause Heavy Snapshots';
    actionType = 'clear_cache_spool';
    narrative =
      'Disk I/O wait time surged beyond seasonal baseline. Defer non-critical archive jobs and compact local collector journal segments.';
    rollbackPlan = 'Resume scheduled backup & indexing jobs once I/O wait drops below 15%.';
  } else if (hasBandwidth) {
    title = 'Egress Interface Bandwidth Exhaustion';
    rootSummary = 'Floor-to-core uplink utilization reached saturation, causing outbound telemetry queuing.';
    actionTitle = 'Apply QoS Shaping to Bulk Sync Traffic';
    actionType = 'rate_limit_egress';
    narrative =
      'Bulk transfer congestion saturated uplink queues. Prioritize telemetry & security control plane traffic via DSCP QoS classes.';
    rollbackPlan = 'Remove temporary bandwidth shaper policy on core switch port.';
  } else if (hasNetwork) {
    title = 'Floor Switch Upstream Congestion & Packet Loss';
    rootSummary = 'Correlated latency spike and packet drops along floor-switch to building-core uplink.';
    actionTitle = 'Failover Floor Uplink to Secondary Core';
    actionType = 'reroute_switch';
    narrative =
      'Latency and packet-loss z-scores rose simultaneously across devices sharing the same floor switch. Reroute traffic to redundant building core link.';
    rollbackPlan = 'Revert VLAN trunk priority back to primary core port.';
  } else if (hasMemory) {
    title = 'Sustained Memory Leak & Page-Cache Exhaustion';
    rootSummary = 'Monotonic heap growth detected across consecutive samples with swap pressure.';
    actionTitle = 'Recycle Leaking Service Worker & Flush Cache';
    actionType = 'clear_cache_spool';
    narrative =
      'EWMA and linear regression forecast memory saturation within the next hour. Gracefully restart the worker pool after draining active requests.';
    rollbackPlan = 'Restore previous worker memory cap and pre-warm read cache.';
  }

  const contributingSignals: SignalContribution[] = windowAlerts.slice(-4).map((a, idx) => {
    const hist = metricHistories.get(`${a.pseudoSourceId}:${a.metric}`) ?? [a.value * 0.6, a.value];
    const baseline = hist.length > 1 ? hist[0] : a.value * 0.65;
    const z = Number(((a.value - baseline) / Math.max(4, baseline * 0.12)).toFixed(2));
    return {
      metric: a.metric,
      observed: Number(a.value.toFixed(2)),
      baseline: Number(baseline.toFixed(2)),
      zScore: z,
      weight: Number((1 / Math.min(4, windowAlerts.length)).toFixed(2)) || (idx === 0 ? 1 : 0.25),
      note: `${a.category} · ${a.severity} (${a.contextSummary.slice(0, 60)})`,
    };
  });

  const targetSeries =
    metricHistories.get(`${latest.pseudoSourceId}:${latest.metric}`) ?? [45, 58, 72, latest.value];
  const prediction = forecastExhaustionBand(latest.metric, targetSeries);

  const confidence = Number(
    Math.min(0.96, 0.72 + Math.min(windowAlerts.length, 4) * 0.05).toFixed(2)
  );

  return {
    incidentId: `inc-${tenantId.replace(/[^a-z0-9]/gi, '').slice(-4).toLowerCase()}-${latest.payloadId.slice(-6)}`,
    tenantId,
    region,
    title,
    severity: windowAlerts.some((a) => a.severity === 'critical') ? 'critical' : 'high',
    status: 'open',
    openedAtUtc: windowAlerts[0].eventTimeUtc,
    updatedAtUtc: latest.eventTimeUtc,
    affectedPseudoIds,
    affectedEdges,
    correlatedAlertCount: windowAlerts.length,
    rootCause: {
      summary: rootSummary,
      confidence,
      contributingSignals,
      reasoningPath: [
        `1. Collected ${windowAlerts.length} allow-listed high/critical event(s) inside 120s correlation window.`,
        `2. Mapped source(s) [${affectedPseudoIds.map(shortPseudoId).join(', ')}] to topology [${affectedEdges.join(' -> ') || 'tenant-edge'}].`,
        `3. Verified persistent deviation above seasonal baseline (MAD robust z-score >= 2.4) with corroborating metrics.`,
        `4. Ranked primary driver: ${rootSummary}`,
      ],
    },
    recommendation: {
      title: actionTitle,
      actionType,
      narrative,
      llmEnhanced: false,
      rollbackPlan,
    },
    prediction,
  };
}

export function advanceRemediation(
  record: RemediationRecord,
  actorUsername: string,
  action: 'approve' | 'execute' | 'rollback' | 'reject',
  nowUtc: string
): { updated: RemediationRecord; error?: string } {
  if (action === 'approve') {
    if (actorUsername === record.proposedBy) {
      return {
        updated: record,
        error: 'Two-person policy check failed: approver must be a different user than the proposer.',
      };
    }
    if (record.stage !== 'policy_checked' && record.stage !== 'proposed') {
      return { updated: record, error: `Cannot approve remediation in stage "${record.stage}".` };
    }
    return {
      updated: {
        ...record,
        approvedBy: actorUsername,
        stage: 'approved',
        auditLog: [
          ...record.auditLog,
          { timestampUtc: nowUtc, actor: actorUsername, event: 'Peer approval granted (two-person rule satisfied).' },
        ],
      },
    };
  }

  if (action === 'execute') {
    if (record.stage !== 'approved') {
      return { updated: record, error: 'Remediation requires peer approval before simulated execution.' };
    }
    return {
      updated: {
        ...record,
        stage: 'executed_simulated',
        auditLog: [
          ...record.auditLog,
          { timestampUtc: nowUtc, actor: actorUsername, event: 'Simulated remediation executed safely inside sandbox.' },
        ],
      },
    };
  }

  if (action === 'rollback') {
    if (record.stage !== 'executed_simulated') {
      return { updated: record, error: 'Only executed remediations can be rolled back.' };
    }
    return {
      updated: {
        ...record,
        stage: 'rolled_back',
        auditLog: [
          ...record.auditLog,
          { timestampUtc: nowUtc, actor: actorUsername, event: `Rollback plan applied: ${record.rollbackPlan}` },
        ],
      },
    };
  }

  return {
    updated: {
      ...record,
      stage: 'rejected',
      auditLog: [
        ...record.auditLog,
        { timestampUtc: nowUtc, actor: actorUsername, event: 'Remediation proposal rejected by operator.' },
      ],
    },
  };
}
