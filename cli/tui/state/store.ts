// cli/tui/state/store.ts — TUI dashboard state aggregator.
//
// One snapshot drives every panel; one refresh() call rehydrates from the
// canonical substrate views. SSE events from the daemon flow into a
// rolling toast queue and bump a refresh tick so the panels re-poll.
//
// The view bindings are 1:1 with the seven-question framework:
//   1. WHAT IS IT DOING NOW?           dispatch_resolved_view + ready_tasks_view
//   2. WHAT DOES IT WANT FROM ME?      pending_owner_decision_queue_view
//   3. IS IT HEALTHY?                  computed from event counts + bridge events
//   4. WHAT IS IT LEARNING?            promoted_knowledge_view +
//                                      contradictory_candidates_view + recipe count
//   5. WHAT DID IT CHANGE FOR ME?      applied_change_committed events +
//                                      irreversible_effects_view + closures
//   6. HOW WELL DOES IT KNOW ME?       owner_profile_view
//   7. WHAT HAPPENS NEXT IF I IDLE?    ready_tasks_view + active_objectives_view +
//                                      directive_conflicts_view + rolling_review_due_view

import type { SubstrateClient, SseEvent } from "../transport/substrate-client";
import { MIRROR_INLINE_EVENT_TYPES, type EventKind } from "../../../substrate/event_kinds";
import type { OwnerProfileCard } from "../../owner_profile_renderer";

export type Lifecycle = "live" | "queued_at_cap" | "completed" | "failed" | "zombie";

export type DispatchRow = {
  directive_id: string;
  root_task_id: string;
  lifecycle_status: Lifecycle;
  status_reason: string | null;
  residual: number | null;
  latest_signal_at: string | null;
  terminal_kind: string | null;
  evidence_event_id: string | null;
  queued_reason: string | null;
};

export type PendingDecisionRow = {
  group_key: string;
  target: string;
  anchor: string | null;
  duplicate_count: number;
  representative_event_id: string | null;
  newest_ts: string;
  shape_quality_score: number;
  target_risk_score: number;
  staleness_score: number;
  group_decline_reason: string | null;
  decision_rank: number;
};

export type ReadyTaskRow = { directive_id: string; task_id: string; goal: string };

export type LearningSnapshot = {
  knowledge_total: number;
  knowledge_24h: number;
  contradictions: number;
  recipes_recent: number;
  artifacts_recent: number;
};

export type ChangeSnapshot = {
  applied_24h: number;
  failed_24h: number;
  irreversible_24h: number;
  closed_directives: Array<{ directive_id: string; closure_residual: number | null; ts: string }>;
};

export type NextSnapshot = {
  ready_count: number;
  active_objectives: number;
  conflicts: number;
  rolling_review_due: number;
};

export type HealthSnapshot = {
  daemon_status: string;
  uptime_s: number | null;
  events_count: number | null;
  bridge_recent_failures: number;
  bridge_recent_completions: number;
  verdict: "ALIVE" | "DEGRADED" | "DEAD";
};

export type DashboardSnapshot = {
  generated_at: string;
  loading: boolean;
  error: string | null;
  dispatch: DispatchRow[];
  ready_tasks: ReadyTaskRow[];
  pending_decisions: PendingDecisionRow[];
  pending_decisions_total: number;
  learning: LearningSnapshot;
  changes: ChangeSnapshot;
  next: NextSnapshot;
  health: HealthSnapshot;
  owner_profile: OwnerProfileCard & { source_event_id?: string; source_ts?: string };
  toasts: ToastEvent[];
};

export type ToastEvent = {
  event_id: string;
  kind: EventKind;
  ts: string;
  summary: string;
};

const emptySnapshot = (): DashboardSnapshot => ({
  generated_at: new Date(0).toISOString(),
  loading: true,
  error: null,
  dispatch: [],
  ready_tasks: [],
  pending_decisions: [],
  pending_decisions_total: 0,
  learning: { knowledge_total: 0, knowledge_24h: 0, contradictions: 0, recipes_recent: 0, artifacts_recent: 0 },
  changes: { applied_24h: 0, failed_24h: 0, irreversible_24h: 0, closed_directives: [] },
  next: { ready_count: 0, active_objectives: 0, conflicts: 0, rolling_review_due: 0 },
  health: { daemon_status: "unknown", uptime_s: null, events_count: null, bridge_recent_failures: 0, bridge_recent_completions: 0, verdict: "DEAD" },
  owner_profile: {},
  toasts: [],
});

const isLifecycle = (value: unknown): value is Lifecycle =>
  typeof value === "string" && ["live", "queued_at_cap", "completed", "failed", "zombie"].includes(value);

const parsePayload = (payload: unknown): Record<string, unknown> => {
  if (!payload) return {};
  if (typeof payload === "string") {
    try { return JSON.parse(payload) as Record<string, unknown>; } catch { return {}; }
  }
  return typeof payload === "object" ? payload as Record<string, unknown> : {};
};

const asArray = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

const toastSummary = (event: SseEvent): string => {
  const payload = parsePayload(event.payload);
  for (const k of ["summary", "claim", "reason", "target", "description"]) {
    const v = payload[k];
    if (typeof v === "string" && v.trim().length > 0) {
      const flat = v.replace(/\s+/g, " ").trim();
      return flat.length > 80 ? flat.slice(0, 79) + "…" : flat;
    }
  }
  return event.kind;
};

const isMirrorInline = (kind: string): kind is EventKind =>
  (MIRROR_INLINE_EVENT_TYPES as ReadonlySet<string>).has(kind);

const computeLearning = (
  promoted: Array<{ ts?: string; created_at?: string }>,
  contradictions: Array<unknown>,
  recipeEvents: SseEvent[],
  artifactEvents: SseEvent[],
  since24hIso: string,
): LearningSnapshot => ({
  knowledge_total: promoted.length,
  knowledge_24h: promoted.filter((r) => typeof r.ts === "string" && r.ts >= since24hIso).length,
  contradictions: contradictions.length,
  recipes_recent: recipeEvents.filter((e) => e.ts >= since24hIso).length,
  artifacts_recent: artifactEvents.filter((e) => e.ts >= since24hIso).length,
});

const computeHealth = (
  health: { ok: boolean; status: string; uptime_s?: number; events_count?: unknown },
  bridgeFails: SseEvent[],
  bridgeComps: SseEvent[],
  eventsLastHour: number,
  since1hIso: string,
): HealthSnapshot => {
  const recentFails = bridgeFails.filter((e) => e.ts >= since1hIso).length;
  const recentComps = bridgeComps.filter((e) => e.ts >= since1hIso).length;
  let verdict: HealthSnapshot["verdict"] = "DEAD";
  if (health.ok) {
    if (recentFails >= 3) verdict = "DEGRADED";
    else if (eventsLastHour === 0 && (typeof health.uptime_s === "number" && health.uptime_s > 600)) verdict = "DEGRADED";
    else verdict = "ALIVE";
  }
  return {
    daemon_status: health.status,
    uptime_s: typeof health.uptime_s === "number" ? health.uptime_s : null,
    events_count: typeof health.events_count === "number" ? health.events_count : null,
    bridge_recent_failures: recentFails,
    bridge_recent_completions: recentComps,
    verdict,
  };
};

export const fetchDashboardSnapshot = async (client: SubstrateClient): Promise<DashboardSnapshot> => {
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const since1h = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  const [
    dispatchEnv,
    pendingEnv,
    readyEnv,
    ownerEnv,
    knowledgeEnv,
    contradictoryEnv,
    activeEnv,
    conflictsEnv,
    rollingEnv,
    irreversibleEnv,
    appliedEnv,
    closureEnv,
    bridgeFailEnv,
    bridgeCompEnv,
    recipeEnv,
    artifactEnv,
    health,
  ] = await Promise.all([
    client.read<unknown[]>("dispatch_resolved_view"),
    client.read<unknown[]>("pending_owner_decision_queue_view"),
    client.read<unknown[]>("ready_tasks_view"),
    client.read<unknown[]>("owner_profile_view"),
    client.read<unknown[]>("promoted_knowledge_view"),
    client.read<unknown[]>("contradictory_candidates_view"),
    client.read<unknown[]>("active_objectives_view"),
    client.read<unknown[]>("directive_conflicts_view"),
    client.read<unknown[]>("rolling_review_due_view"),
    client.read<unknown[]>("irreversible_effects_view"),
    client.recentEvents(["applied_change_committed"], 100),
    client.recentEvents(["task_closure_audited", "directive_closed"], 80),
    client.recentEvents(["bridge_failed"], 50),
    client.recentEvents(["bridge_completed"], 50),
    client.recentEvents(["recipe_extracted"], 30),
    client.recentEvents(["code_artifact_admitted", "code_artifact_promoted"], 50),
    client.health(),
  ]);

  const dispatchRows = (dispatchEnv.ok ? asArray<Record<string, unknown>>(dispatchEnv.result) : []).map((r): DispatchRow => {
    const ls = isLifecycle(r.lifecycle_status) ? r.lifecycle_status : isLifecycle(r.status) ? r.status as Lifecycle : "live";
    return {
      directive_id: String(r.directive_id ?? ""),
      root_task_id: String(r.root_task_id ?? ""),
      lifecycle_status: ls,
      status_reason: typeof r.status_reason === "string" ? r.status_reason : null,
      residual: typeof r.residual === "number" ? r.residual : null,
      latest_signal_at: typeof r.latest_signal_at === "string" ? r.latest_signal_at : null,
      terminal_kind: typeof r.terminal_kind === "string" ? r.terminal_kind : null,
      evidence_event_id: typeof r.evidence_event_id === "string" ? r.evidence_event_id : (typeof r.terminal_event_id === "string" ? r.terminal_event_id : null),
      queued_reason: typeof r.queued_reason === "string" ? r.queued_reason : null,
    };
  });

  const pendingRowsRaw = pendingEnv.ok ? asArray<Record<string, unknown>>(pendingEnv.result) : [];
  const pending = pendingRowsRaw.slice(0, 8).map((r): PendingDecisionRow => ({
    group_key: String(r.group_key ?? ""),
    target: String(r.target ?? "?"),
    anchor: typeof r.anchor === "string" ? r.anchor : null,
    duplicate_count: Number(r.duplicate_count ?? 1),
    representative_event_id: typeof r.representative_event_id === "string" ? r.representative_event_id : null,
    newest_ts: String(r.newest_ts ?? new Date().toISOString()),
    shape_quality_score: Number(r.shape_quality_score ?? 0),
    target_risk_score: Number(r.target_risk_score ?? 0),
    staleness_score: Number(r.staleness_score ?? 0),
    group_decline_reason: typeof r.group_decline_reason === "string" ? r.group_decline_reason : null,
    decision_rank: Number(r.decision_rank ?? 0),
  }));

  const readyRows = (readyEnv.ok ? asArray<Record<string, unknown>>(readyEnv.result) : []).slice(0, 6).map((r): ReadyTaskRow => {
    const payload = parsePayload(r.payload);
    const goal = (typeof payload.goal === "string" ? payload.goal : (typeof payload.task_goal === "string" ? payload.task_goal : ""));
    return {
      directive_id: String(r.directive_id ?? ""),
      task_id: String(r.task_id ?? ""),
      goal: goal.replace(/\s+/g, " ").trim().slice(0, 96),
    };
  });

  const ownerRowsArr = ownerEnv.ok ? asArray<{ event_id?: string; ts?: string; payload?: unknown }>(ownerEnv.result) : [];
  const ownerRow = ownerRowsArr[0];
  const ownerProfile: DashboardSnapshot["owner_profile"] = {
    ...(parsePayload(ownerRow?.payload) as OwnerProfileCard),
    source_event_id: ownerRow?.event_id,
    source_ts: ownerRow?.ts,
  };

  const promoted = knowledgeEnv.ok ? asArray<{ ts?: string }>(knowledgeEnv.result) : [];
  const contradictions = contradictoryEnv.ok ? asArray<unknown>(contradictoryEnv.result) : [];
  const recipeEvents = recipeEnv.ok ? asArray<SseEvent>(recipeEnv.result.events) : [];
  const artifactEvents = artifactEnv.ok ? asArray<SseEvent>(artifactEnv.result.events) : [];
  const bridgeFailEvents = bridgeFailEnv.ok ? asArray<SseEvent>(bridgeFailEnv.result.events) : [];
  const bridgeCompEvents = bridgeCompEnv.ok ? asArray<SseEvent>(bridgeCompEnv.result.events) : [];
  const learning = computeLearning(promoted, contradictions, recipeEvents, artifactEvents, since24h);

  const appliedEvents = appliedEnv.ok ? asArray<SseEvent>(appliedEnv.result.events) : [];
  const closureEvents = closureEnv.ok ? asArray<SseEvent>(closureEnv.result.events) : [];
  const applied24h = appliedEvents.filter((e) => e.ts >= since24h).map((e) => ({ status: String(parsePayload(e.payload).status ?? "applied") }));
  const irreversibleRows = irreversibleEnv.ok ? asArray<{ effect_count?: number; latest_ts?: string }>(irreversibleEnv.result) : [];
  const irreversible24h = irreversibleRows.filter((r) => typeof r.latest_ts === "string" && r.latest_ts >= since24h).reduce((sum, r) => sum + Number(r.effect_count ?? 0), 0);
  const closedDirectives = closureEvents
    .filter((e) => e.kind === "task_closure_audited" && (e.directive_id))
    .slice(-5)
    .map((e) => ({
      directive_id: String(e.directive_id ?? ""),
      closure_residual: typeof parsePayload(e.payload).closure_residual === "number" ? Number(parsePayload(e.payload).closure_residual) : null,
      ts: e.ts,
    }));
  const changes: ChangeSnapshot = {
    applied_24h: applied24h.filter((e) => e.status === "applied" || e.status === "committed").length,
    failed_24h: applied24h.filter((e) => e.status === "failed" || e.status === "refused").length,
    irreversible_24h: irreversible24h,
    closed_directives: closedDirectives,
  };

  const activeRows = activeEnv.ok ? asArray<unknown>(activeEnv.result) : [];
  const conflictsRows = conflictsEnv.ok ? asArray<unknown>(conflictsEnv.result) : [];
  const rollingRows = rollingEnv.ok ? asArray<{ past_due?: number | null }>(rollingEnv.result) : [];
  const next: NextSnapshot = {
    ready_count: readyEnv.ok ? asArray<unknown>(readyEnv.result).length : 0,
    active_objectives: activeRows.length,
    conflicts: conflictsRows.length,
    rolling_review_due: rollingRows.filter((r) => Number(r.past_due ?? 0) > 0).length,
  };

  // Rough events-last-hour estimate from the bridge stream: if both are 0
  // AND uptime > 10 min, the daemon is likely idle (still ALIVE) — handled
  // inside computeHealth.
  const eventsLastHour = bridgeFailEvents.filter((e) => e.ts >= since1h).length + bridgeCompEvents.filter((e) => e.ts >= since1h).length;
  const healthSnap = computeHealth(health, bridgeFailEvents, bridgeCompEvents, eventsLastHour, since1h);

  const error = !dispatchEnv.ok ? `dispatch_resolved_view:${dispatchEnv.error}` : null;

  return {
    generated_at: now.toISOString(),
    loading: false,
    error,
    dispatch: dispatchRows,
    ready_tasks: readyRows,
    pending_decisions: pending,
    pending_decisions_total: pendingRowsRaw.length,
    learning,
    changes,
    next,
    health: healthSnap,
    owner_profile: ownerProfile,
    toasts: [],
  };
};

/** Project an incoming SSE event into a toast row when it matches the
 *  canonical MIRROR_INLINE_EVENT_TYPES set. Non-mirror events return null
 *  so the caller can drop them silently. */
export const sseEventToToast = (event: SseEvent): ToastEvent | null => {
  if (!isMirrorInline(event.kind)) return null;
  return {
    event_id: event.event_id,
    kind: event.kind as EventKind,
    ts: event.ts,
    summary: toastSummary(event),
  };
};

export const initialSnapshot = emptySnapshot;
