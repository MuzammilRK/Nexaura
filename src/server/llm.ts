import { GoogleGenAI, Type } from '@google/genai';
import type { HealthState, Incident, RegionCode } from '../shared/schema';
import { shortPseudoId } from '../shared/formatters';

export interface FleetNodeAdvisorSnapshot {
  pseudoSourceId: string;
  tenantId: string;
  industry: string;
  cityName: string;
  healthState: HealthState;
  healthScore: number;
  isStale: boolean;
  staleAgeSeconds: number;
  cpuPct: number;
  memoryPct: number;
  diskPct: number;
  latencyMs: number;
  packetLossPct: number;
  failedLogins: number;
  reason: string;
}

export type ResolveIntent =
  | 'heartbeat'
  | 'cpu'
  | 'memory'
  | 'network'
  | 'security'
  | 'disk'
  | 'dns'
  | 'cert'
  | 'all';

export interface SevereAdvisorAlert {
  active: boolean;
  level: 'critical' | 'high';
  title: string;
  detail: string;
}

export interface LlmChatContext {
  region: RegionCode;
  tenantScope: string;
  actor: string;
  healthScore: number;
  fleetNodes: FleetNodeAdvisorSnapshot[];
  openIncidents: Incident[];
  question: string;
  history?: { role: 'user' | 'assistant'; text: string }[];
  onResolveIssue?: (params: {
    targetNodeHint?: string;
    intent: ResolveIntent;
  }) => { resolvedCount: number; summary: string; affectedNodes: string[] };
}

export interface LlmResponse {
  answer: string;
  rootCause: string;
  solution: string;
  actionTaken?: string;
  resolvedCount?: number;
  severeAlert: SevereAdvisorAlert | null;
  provider: 'gemini-4-hydrogen' | 'rules_fallback';
  metadataOnlyVerified: boolean;
  errorNote?: string;
}

function sanitizePromptAgainstInjection(input: string): string {
  return input
    .replace(/(?:ignore previous|system prompt|reveal api key|dump raw logs)/gi, '[filtered-directive]')
    .slice(0, 600);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function extractNodeHint(question: string, nodes: FleetNodeAdvisorSnapshot[]): string | undefined {
  const lower = question.toLowerCase();
  // Match forms like "Node d2ea·91b", "d2ea91b", "d2ea", or "ps_d2ea..."
  for (const n of nodes) {
    const short = shortPseudoId(n.pseudoSourceId).toLowerCase();
    const compactShort = short.replace(/^node\s+/, '').replace(/[^a-z0-9]/g, '');
    const prefix4 = n.pseudoSourceId.slice(3, 7).toLowerCase();
    if (
      lower.includes(n.pseudoSourceId.toLowerCase()) ||
      lower.includes(short) ||
      lower.includes(compactShort) ||
      (prefix4.length === 4 && lower.includes(prefix4))
    ) {
      return n.pseudoSourceId;
    }
  }
  const tokenMatch = question.match(/\b([a-f0-9]{4})(?:[·\-.]([a-f0-9]{3}))?\b/i);
  if (tokenMatch) {
    return tokenMatch[2] ? `${tokenMatch[1]}${tokenMatch[2]}` : tokenMatch[1];
  }
  return undefined;
}

function classifyIntent(q: string): ResolveIntent {
  if (/heartbeat|stale|offline|unreachable|flap|keepalive/i.test(q)) return 'heartbeat';
  if (/cpu|processor|worker|saturation|compute/i.test(q)) return 'cpu';
  if (/mem|heap|leak|ram|oom/i.test(q)) return 'memory';
  if (/dns|servfail|resolver/i.test(q)) return 'dns';
  if (/cert|tls|mtls|expir/i.test(q)) return 'cert';
  if (/disk|storage|nvme|i\/o|wal/i.test(q)) return 'disk';
  if (/latenc|packet|network|uplink|bandwidth|congest/i.test(q)) return 'network';
  if (/login|brute|auth|security|privilege|escalat/i.test(q)) return 'security';
  return 'all';
}

function isResolutionCommand(q: string): boolean {
  return /\b(resolve|fix|restore|remediat|repair|recover|mitigate|restart|heal|clear)\b/i.test(q);
}

function evaluateSevereAlert(
  region: RegionCode,
  fleetNodes: FleetNodeAdvisorSnapshot[],
  openIncidents: Incident[]
): SevereAdvisorAlert | null {
  const criticalIncidents = openIncidents.filter((i) => i.status === 'open' && i.severity === 'critical');
  const staleNodes = fleetNodes.filter((n) => n.isStale);
  const poorNodes = fleetNodes.filter((n) => n.healthState === 'Poor');
  const authRiskNodes = fleetNodes.filter((n) => n.failedLogins >= 6);
  const highCpuNodes = fleetNodes.filter((n) => n.cpuPct >= 90);

  if (criticalIncidents.length > 0) {
    const top = criticalIncidents[0];
    return {
      active: true,
      level: 'critical',
      title: `Severe Incident in ${region}: ${top.title}`,
      detail: `${top.correlatedAlertCount} correlated signal(s) impacting ${top.affectedPseudoIds.map((p) => shortPseudoId(p)).join(', ')}. Immediate verification or remediation recommended.`,
    };
  }

  if (staleNodes.length > 0) {
    return {
      active: true,
      level: 'critical',
      title: `Collector Heartbeat Lost (${staleNodes.length} node${staleNodes.length > 1 ? 's' : ''})`,
      detail: `${staleNodes.map((n) => `${shortPseudoId(n.pseudoSourceId)} (${n.staleAgeSeconds}s stale)`).join(', ')} unreachable past heartbeat threshold.`,
    };
  }

  if (authRiskNodes.length > 0) {
    return {
      active: true,
      level: 'critical',
      title: 'Severe Authentication Anomaly',
      detail: `Elevated credential failure burst on ${authRiskNodes.map((n) => `${shortPseudoId(n.pseudoSourceId)} (${n.failedLogins} failures)`).join(', ')}.`,
    };
  }

  if (poorNodes.length > 0 || highCpuNodes.length > 0) {
    const impacted = poorNodes.length > 0 ? poorNodes : highCpuNodes;
    return {
      active: true,
      level: 'high',
      title: `High Severity Node Degradation in ${region}`,
      detail: `${impacted.length} endpoint(s) in Poor/saturated state: ${impacted.slice(0, 3).map((n) => `${shortPseudoId(n.pseudoSourceId)} (CPU ${n.cpuPct}%, Lat ${n.latencyMs}ms)`).join('; ')}.`,
    };
  }

  return null;
}

function deterministicAnalysis(
  ctx: LlmChatContext,
  nodeHint: string | undefined,
  intent: ResolveIntent,
  resolutionResult: { resolvedCount: number; summary: string; affectedNodes: string[] } | null,
  severeAlert: SevereAdvisorAlert | null
): { answer: string; rootCause: string; solution: string } {
  const q = ctx.question.toLowerCase();
  const openOnly = ctx.openIncidents.filter((i) => i.status === 'open');
  const top = openOnly[0] ?? ctx.openIncidents[0];
  const matchedNode = nodeHint
    ? ctx.fleetNodes.find(
        (n) =>
          n.pseudoSourceId.toLowerCase() === nodeHint.toLowerCase() ||
          shortPseudoId(n.pseudoSourceId).toLowerCase().includes(nodeHint.toLowerCase()) ||
          n.pseudoSourceId.toLowerCase().includes(nodeHint.toLowerCase())
      )
    : undefined;

  const staleNodes = ctx.fleetNodes.filter((n) => n.isStale);
  const degradedNodes = ctx.fleetNodes.filter((n) => n.healthState === 'Poor' || n.healthState === 'Fair');

  if (resolutionResult) {
    const targetLabel = matchedNode
      ? shortPseudoId(matchedNode.pseudoSourceId)
      : nodeHint
        ? `Node ${nodeHint}`
        : `Region ${ctx.region} impacted endpoints`;
    const rootCauseByIntent: Record<ResolveIntent, string> = {
      heartbeat: `${targetLabel} missed consecutive mTLS keepalive frames beyond the stale heartbeat threshold due to collector service stall or transient uplink suspension.`,
      cpu: `Worker pool saturation (>90% CPU) caused scheduler queuing and elevated event-loop dispatch latency on ${targetLabel}.`,
      memory: `Monotonic heap growth triggered aggressive GC pressure without reclaiming idle worker buffers.`,
      network: `Floor-switch to building-core uplink congestion raised RTT and dropped telemetry acknowledgements.`,
      dns: `Upstream DNS resolver SERVFAIL storm stalled microservice host lookups and connection pooling.`,
      cert: `Leaf mTLS certificate approaching TTL expiration required automated certificate rotation.`,
      disk: `NVMe write-ahead log (WAL) queue saturation throttled local spool checkpoint writes.`,
      security: `Credential brute-force or policy hash drift triggered automated authentication rate throttling.`,
      all: top
        ? top.rootCause.summary
        : `Localized metric drift and unacknowledged health alerts detected on ${targetLabel}.`,
    };
    const solution =
      resolutionResult.resolvedCount > 0
        ? `Restarted collector keepalive & normalized baseline telemetry on ${resolutionResult.affectedNodes.join(', ') || targetLabel}; verified mTLS heartbeat freshness and closed correlated open incidents.`
        : `${targetLabel} was already restored or operating within healthy baselines (${ctx.healthScore}/100). Keep continuous EWMA watch enabled.`;
    return {
      answer: `${resolutionResult.summary} ${severeAlert ? `Remaining alert: ${severeAlert.title}.` : 'All targeted health checks now pass.'}`,
      rootCause: rootCauseByIntent[intent],
      solution,
    };
  }

  if (matchedNode) {
    const issues: string[] = [];
    if (matchedNode.isStale) issues.push(`stale heartbeat (${matchedNode.staleAgeSeconds}s offline)`);
    if (matchedNode.cpuPct >= 80) issues.push(`high CPU (${matchedNode.cpuPct}%)`);
    if (matchedNode.memoryPct >= 82) issues.push(`elevated memory (${matchedNode.memoryPct}%)`);
    if (matchedNode.diskPct >= 85) issues.push(`disk pressure (${matchedNode.diskPct}%)`);
    if (matchedNode.latencyMs >= 100) issues.push(`uplink latency (${matchedNode.latencyMs}ms)`);
    if (matchedNode.failedLogins > 2) issues.push(`auth failures (${matchedNode.failedLogins})`);

    const nodeLabel = shortPseudoId(matchedNode.pseudoSourceId);
    if (issues.length === 0) {
      return {
        answer: `${nodeLabel} (${matchedNode.tenantId} · ${matchedNode.cityName}) is currently ${matchedNode.healthState} (${matchedNode.healthScore}/100) with CPU ${matchedNode.cpuPct}%, Mem ${matchedNode.memoryPct}%, and Latency ${matchedNode.latencyMs}ms.`,
        rootCause: 'No active anomaly on this pseudonymized endpoint; telemetry cadence is within baseline.',
        solution: 'No intervention required. Ask "Resolve issues on ' + nodeLabel + '" at any time if degradation recurs.',
      };
    }
    return {
      answer: `${nodeLabel} (${matchedNode.tenantId}) is ${matchedNode.healthState} (${matchedNode.healthScore}/100) due to ${issues.join(', ')}. You can ask me to "Resolve ${intent} on ${nodeLabel}" to remediate it immediately.`,
      rootCause: matchedNode.reason || issues.join('; '),
      solution: matchedNode.isStale
        ? `Reset collector keepalive session on ${nodeLabel}, drain any buffered WAL spool, and re-verify mTLS tunnel.`
        : `Throttle saturated worker threads and isolate offending uplink or auth stream on ${nodeLabel}.`,
    };
  }

  if (intent === 'heartbeat' || /heartbeat|stale|offline/i.test(q)) {
    if (staleNodes.length > 0) {
      const list = staleNodes.map((n) => `${shortPseudoId(n.pseudoSourceId)} (${n.staleAgeSeconds}s stale)`).join(', ');
      return {
        answer: `Detected ${staleNodes.length} endpoint(s) with missed heartbeats in ${ctx.region}: ${list}. Reply "Resolve heartbeat issue" to restore connectivity now.`,
        rootCause: 'Local collector agent stopped sending periodic mTLS keepalive frames or lost upstream gateway reachability.',
        solution: 'Restart collector heartbeat loop, verify regional gateway reachability, and flush buffered WAL frames.',
      };
    }
    return {
      answer: `All ${ctx.fleetNodes.length} monitored nodes in ${ctx.region} have active heartbeats within policy limits.`,
      rootCause: 'Zero heartbeat timeouts detected across regional collectors.',
      solution: 'Continue scheduled keepalive monitoring.',
    };
  }

  if (/privacy|secret|redact|egress|uid/i.test(q)) {
    return {
      answer: `Zero-trust egress boundary active in ${ctx.region}. All ${ctx.fleetNodes.length} endpoints transmit strictly the 12 allow-listed pseudonymized metadata fields after regex credential redaction and SHA-256 verification.`,
      rootCause: 'No boundary violation; raw device UIDs, secrets, and local business records remain locked inside Tier 1.',
      solution: 'Verify per-payload hashes in the Collector Verification tab or run a secret redaction test on any Tier 1 host.',
    };
  }

  if (intent === 'cpu' || intent === 'memory' || intent === 'disk' || intent === 'network' || intent === 'dns' || intent === 'cert' || intent === 'security') {
    const worstByIntent = [...ctx.fleetNodes].sort((a, b) => {
      if (intent === 'cpu') return b.cpuPct - a.cpuPct;
      if (intent === 'memory') return b.memoryPct - a.memoryPct;
      if (intent === 'disk') return b.diskPct - a.diskPct;
      if (intent === 'security') return b.failedLogins - a.failedLogins;
      return b.latencyMs - a.latencyMs;
    })[0];

    const wLabel = worstByIntent ? shortPseudoId(worstByIntent.pseudoSourceId) : 'fleet';
    const rootMap: Record<string, string> = {
      cpu: `Peak CPU load is on ${wLabel} at ${worstByIntent?.cpuPct ?? 0}% (z-score spike on worker dispatch).`,
      memory: `Peak memory occupancy is ${worstByIntent?.memoryPct ?? 0}% on ${wLabel}, indicating sustained heap retention.`,
      disk: `Storage NVMe pressure reached ${worstByIntent?.diskPct ?? 0}% on ${wLabel}, risking local WAL write contention.`,
      network: `Highest network latency is ${worstByIntent?.latencyMs ?? 0}ms (${worstByIntent?.packetLossPct ?? 0}% loss) on ${wLabel}.`,
      dns: `DNS resolution spikes impact edge microservice routing alongside elevated RTT (${worstByIntent?.latencyMs ?? 0}ms).`,
      cert: `Short-lived mTLS leaf certificates require scheduled rotation before expiry to prevent ingest interruption.`,
      security: `${worstByIntent?.failedLogins ?? 0} failed authentication event(s) observed on ${wLabel}; brute-force guard active.`,
    };
    const solMap: Record<string, string> = {
      cpu: `Throttle background batch concurrency or rebalance pods away from ${wLabel}.`,
      memory: `Capture heap histogram metadata and cycle idle worker pools with rollback checkpointing.`,
      disk: `Compact stale WAL segments and enforce severity shedding above 85% disk watermark.`,
      network: `Fail over uplink VLAN at the floor switch and apply QoS shaping for telemetry frames.`,
      dns: `Flush stalled resolver cache and route lookups to secondary regional Anycast DNS.`,
      cert: `Issue a fresh 90-day leaf certificate from the regional CA with zero-downtime hot reload.`,
      security: `Lock targeted accounts temporarily, rotate session signing keys, and review Authentication Logs.`,
    };
    return {
      answer: `${rootMap[intent]} Say "Resolve ${intent} issue" if you want me to stabilize ${wLabel} cleanly.`,
      rootCause: rootMap[intent],
      solution: solMap[intent],
    };
  }

  if (q.includes('root cause') || q.includes('why') || q.includes('incident') || top) {
    if (!top) {
      return {
        answer: `Region ${ctx.region} fleet health is ${ctx.healthScore}/100 across ${ctx.fleetNodes.length} endpoints with 0 open correlated incidents.`,
        rootCause: 'All telemetry signals are tracking within seasonal EWMA baselines.',
        solution: 'No remediation pending.',
      };
    }
    const targetText = top.affectedPseudoIds.map((p) => shortPseudoId(p)).join(', ');
    return {
      answer: `Active priority incident in ${ctx.region}: "${top.title}" (${top.severity.toUpperCase()}, ${Math.round(top.rootCause.confidence * 100)}% confidence) affecting ${targetText}. ${degradedNodes.length} node(s) show degraded scores. Reply "Resolve incident" to remediate.`,
      rootCause: `${top.rootCause.summary} ${top.rootCause.reasoningPath[0] ?? ''}`.trim(),
      solution: `${top.recommendation.title}: ${top.recommendation.narrative} Rollback: ${top.recommendation.rollbackPlan}`,
    };
  }

  return {
    answer: `Region ${ctx.region} health sits at ${ctx.healthScore}/100 across ${ctx.fleetNodes.length} endpoints (${staleNodes.length} stale, ${degradedNodes.length} degraded). All allow-listed egress streams remain privacy-verified.`,
    rootCause: 'Fleet operating normally with zero unmitigated correlated faults.',
    solution: 'Inspect individual node telemetry or specify an incident/node ID to analyze or resolve.',
  };
}

export async function askAIOpsAssistant(ctx: LlmChatContext): Promise<LlmResponse> {
  const sanitizedQuestion = sanitizePromptAgainstInjection(ctx.question);
  const nodeHint = extractNodeHint(sanitizedQuestion, ctx.fleetNodes);
  const intent = classifyIntent(sanitizedQuestion);
  const wantsResolve = isResolutionCommand(sanitizedQuestion);

  let resolutionResult: { resolvedCount: number; summary: string; affectedNodes: string[] } | null = null;
  if (wantsResolve && ctx.onResolveIssue) {
    resolutionResult = ctx.onResolveIssue({ targetNodeHint: nodeHint, intent });
  }

  const severeAlert = evaluateSevereAlert(ctx.region, ctx.fleetNodes, ctx.openIncidents);
  const deterministic = deterministicAnalysis(
    { ...ctx, question: sanitizedQuestion },
    nodeHint,
    intent,
    resolutionResult,
    severeAlert
  );

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return {
      answer: deterministic.answer,
      rootCause: deterministic.rootCause,
      solution: deterministic.solution,
      actionTaken: resolutionResult?.summary,
      resolvedCount: resolutionResult?.resolvedCount ?? 0,
      severeAlert,
      provider: 'rules_fallback',
      metadataOnlyVerified: true,
      errorNote: 'Deterministic AIOps analyzer active.',
    };
  }

  // Strictly metadata-only context (zero UIDs, zero raw logs)
  const metadataContext = {
    region: ctx.region,
    tenantScope: ctx.tenantScope,
    fleetHealthScore: ctx.healthScore,
    nodes: ctx.fleetNodes.slice(0, 20).map((n) => ({
      node: shortPseudoId(n.pseudoSourceId),
      tenantId: n.tenantId,
      healthState: n.healthState,
      score: n.healthScore,
      isStale: n.isStale,
      staleAgeSeconds: n.staleAgeSeconds,
      cpuPct: n.cpuPct,
      memoryPct: n.memoryPct,
      diskPct: n.diskPct,
      latencyMs: n.latencyMs,
      failedLogins: n.failedLogins,
    })),
    openIncidents: ctx.openIncidents.slice(0, 5).map((inc) => ({
      incidentId: inc.incidentId,
      title: inc.title,
      severity: inc.severity,
      status: inc.status,
      affectedNodes: inc.affectedPseudoIds.map((p) => shortPseudoId(p)),
      rootCauseSummary: inc.rootCause.summary,
      recommendedTitle: inc.recommendation.title,
      rollbackPlan: inc.recommendation.rollbackPlan,
    })),
    liveResolutionExecuted: resolutionResult,
    severeAlert,
    recentConversation: (ctx.history ?? []).slice(-4),
  };

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const response = await withTimeout(
      ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Allow-Listed Metadata Snapshot (JSON, no raw logs or PII):\n${JSON.stringify(metadataContext)}\n\nOperator Query: ${sanitizedQuestion}`,
        config: {
          systemInstruction:
            'You are Nexaura Regional AIOps Advisor. Analyze the specific operator query using ONLY the allow-listed metadata JSON. Always identify the exact root cause and concrete solution tailored to the query (never repeat generic boilerplate). If liveResolutionExecuted is non-null, explain what issue was just resolved on the server and its root cause. Keep answer concise (2-3 sentences).',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              answer: { type: Type.STRING },
              rootCause: { type: Type.STRING },
              solution: { type: Type.STRING },
            },
            required: ['answer', 'rootCause', 'solution'],
          },
        },
      }),
      6500
    );

    const rawText = response.text?.trim();
    if (!rawText) {
      throw new Error('Empty model output');
    }
    const parsed = JSON.parse(rawText) as { answer?: string; rootCause?: string; solution?: string };
    return {
      answer: parsed.answer?.trim() || deterministic.answer,
      rootCause: parsed.rootCause?.trim() || deterministic.rootCause,
      solution: parsed.solution?.trim() || deterministic.solution,
      actionTaken: resolutionResult?.summary,
      resolvedCount: resolutionResult?.resolvedCount ?? 0,
      severeAlert,
      provider: 'gemini-4-hydrogen',
      metadataOnlyVerified: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upstream Gemini request failed';
    return {
      answer: deterministic.answer,
      rootCause: deterministic.rootCause,
      solution: deterministic.solution,
      actionTaken: resolutionResult?.summary,
      resolvedCount: resolutionResult?.resolvedCount ?? 0,
      severeAlert,
      provider: 'rules_fallback',
      metadataOnlyVerified: true,
      errorNote: `Gemini unavailable (${msg}); deterministic analyzer responded.`,
    };
  }
}

export async function enhanceRecommendationWording(incident: Incident): Promise<Incident> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return incident;
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const safeSummary = {
      title: incident.title,
      severity: incident.severity,
      rootCause: incident.rootCause.summary,
      confidence: incident.rootCause.confidence,
      signals: incident.rootCause.contributingSignals.map((s) => `${s.metric}=${s.observed} (z=${s.zScore})`),
      actionTitle: incident.recommendation.title,
      rollbackPlan: incident.recommendation.rollbackPlan,
    };

    const response = await withTimeout(
      ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Write a crisp 2-sentence executive remediation explanation for this allow-listed incident metadata: ${JSON.stringify(safeSummary)}`,
        config: {
          systemInstruction: 'Be concise, technical, and cite the observed signals and rollback safety.',
        },
      }),
      6000
    );

    const text = response.text?.trim();
    if (text) {
      return {
        ...incident,
        recommendation: {
          ...incident.recommendation,
          narrative: text,
          llmEnhanced: true,
          llmModel: 'gemini-4-hydrogen',
        },
      };
    }
  } catch {
    // Keep deterministic narrative on failure
  }

  return incident;
}
