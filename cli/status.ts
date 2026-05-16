// acc status - one-screen owner state answer. Uses substrate.read/MCP
// projections for organism state and keeps daemon health as the only direct
// auxiliary HTTP read. --json is intentionally shaped for a future Ink TUI.

import { auxBaseUrl, mcpCall, rpcGet } from "./rpc";
import type { OwnerProfileCard } from "./owner_profile_renderer";

type Lifecycle = "live" | "queued_at_cap" | "completed" | "failed" | "zombie";
type ViewEnvelope = { ok: true; result: any } | { ok: false; error: string };
type DispatchRow = {
  directive_id?: string;
  root_task_id?: string;
  status?: string;
  lifecycle_status?: string;
  status_reason?: string | null;
  residual?: number | null;
  queued_reason?: string | null;
  ready_since?: string | null;
  latest_signal_at?: string | null;
};
type ReadyRow = { directive_id?: string; task_id?: string; payload?: Record<string, unknown>; ts?: string };
type TimedRow = { ts?: string; created_at?: string; updated_at?: string; committed_at?: string };
type EffectivenessRow = TimedRow & { compounded?: boolean; tier0_replay_hit?: boolean; residual_delta?: number | null };
type AppliedChangeEvent = RecentEvent & { payload?: { status?: string; summary?: string; target?: string; [key: string]: unknown } };
type OwnerProfileRow = { event_id?: string; ts?: string; payload?: OwnerProfileCard | string };
type RecentEvent = { event_id?: string; ts?: string; kind?: string; directive_id?: string; task_id?: string; payload?: Record<string, unknown> };

export type StatusReport = {
  generated_at: string;
  contract: { name: "acc_status_snapshot"; version: 1; lifecycle_values: Lifecycle[]; sources: Record<string, string[]> };
  daemon: { running: boolean; status: string; pid?: unknown; uptime_s?: number; events_count?: unknown; stuck_workers: number; error?: string };
  dispatch_lifecycle: Record<Lifecycle, number> & { total: number };
  pending_owner_decisions: { count: number; top: Array<Record<string, unknown>> };
  owner_profile: {
    autonomy_score: number | null;
    autonomy_score_floor: number | null;
    detected_language: string | null;
    preferred_terms: string[];
    avoided_terms: string[];
    things_to_never_do: string[];
    manual_review_patterns: string[];
    hot_topics: string[];
    signal_summary: Record<string, Array<{ key: string; value: number }>>;
    source_event_id?: string;
    source_ts?: string;
  };
  learning: {
    knowledge_total: number;
    knowledge_24h: number;
    recipe_total: number;
    recipe_24h: number;
    artifact_total: number;
    artifact_24h: number;
    applied_lessons_total: number;
    applied_lessons_24h: number;
    compounded_total: number;
    tier0_replay_hits: number;
    avg_residual_delta: number | null;
    contradictions: number;
  };
  actual_changes: { applied_24h: number; failed_24h: number; refused_24h: number; recent: Array<{ event_id: string; ts: string; status: string; target: string | null; summary: string | null }> };
  active_directives: Array<{ directive_id: string; root_task_id: string; status: Lifecycle; reason: string | null; closure_residual: number | null; latest_signal_at: string | null }>;
  ready_tasks: { count: number; sample: Array<{ directive_id: string; task_id: string; goal: string }> };
  blocked: string[];
  next_action: string;
  failures: Array<Record<string, unknown>>;
  view_errors: Record<string, string>;
};

const LIFECYCLES: Lifecycle[] = ["live", "queued_at_cap", "completed", "failed", "zombie"];
const STATUS_SOURCES: StatusReport["contract"]["sources"] = {
  daemon: ["/health"],
  dispatch_lifecycle: ["dispatch_resolved_view"],
  pending_owner_decisions: ["pending_owner_decision_queue_view"],
  owner_profile: ["owner_profile_view"],
  learning: ["promoted_knowledge_view", "recipe_registry_view", "code_artifact_registry_view", "applied_lesson_effectiveness_view", "contradictory_candidates_view"],
  actual_changes: ["runtime.recent_events:applied_change_committed"],
  active_directives: ["dispatch_resolved_view", "runtime.recent_events:task_closure_audited"],
  ready_tasks: ["ready_tasks_view"],
  failures: ["failure_view"],
  view_errors: ["substrate.read", "runtime.recent_events"],
};

const isLifecycle = (value: unknown): value is Lifecycle =>
  typeof value === "string" && (LIFECYCLES as string[]).includes(value);

const asArray = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

const parsePayload = (payload: unknown): Record<string, unknown> => {
  if (!payload) return {};
  if (typeof payload === "string") {
    try { return JSON.parse(payload) as Record<string, unknown>; } catch { return {}; }
  }
  return typeof payload === "object" ? payload as Record<string, unknown> : {};
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];

const countSince = (rows: TimedRow[], sinceIso: string, field: "ts" | "created_at" | "updated_at" | "committed_at" = "ts"): number =>
  rows.filter((row) => typeof row[field] === "string" && row[field]! >= sinceIso).length;

const topNumberSignals = (value: unknown, limit = 3): Array<{ key: string; value: number }> => {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, signalValue]) => ({ key, value: signalValue }));
};

const countTrue = (rows: EffectivenessRow[], field: "compounded" | "tier0_replay_hit"): number =>
  rows.filter((row) => row[field] === true).length;

const averageNumber = (values: Array<number | null | undefined>): number | null => {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
};

const readView = async (viewName: string, args: Record<string, unknown> = {}): Promise<ViewEnvelope> => {
  try {
    return await mcpCall("substrate.read", { view_name: viewName, args });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
};

const recentEvents = async (kinds: string[], k = 200): Promise<ViewEnvelope> => {
  try {
    return await mcpCall("runtime.recent_events", { kinds, k });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
};

const daemonSummary = async (): Promise<StatusReport["daemon"]> => {
  const base = auxBaseUrl();
  if (!base) return { running: false, status: "not_running", stuck_workers: 0, error: "run acc daemon start" };
  const health = await rpcGet<Record<string, unknown>>(base + "/health");
  if (health && health.ok === false) {
    return { running: false, status: "unreachable", stuck_workers: 0, error: String(health.error ?? "unknown") };
  }
  return {
    running: true,
    status: String(health.status ?? "unknown"),
    pid: health.pid,
    uptime_s: Math.round(Number(health.uptime_ms ?? 0) / 1000),
    events_count: health.events_count,
    stuck_workers: Array.isArray(health.stuck_workers) ? health.stuck_workers.length : 0,
  };
};

const latestClosureResiduals = (events: RecentEvent[]): Map<string, number> => {
  const byDirective = new Map<string, number>();
  for (const event of events) {
    const directiveId = event.directive_id;
    const residual = event.payload?.closure_residual;
    if (directiveId && typeof residual === "number" && Number.isFinite(residual)) byDirective.set(directiveId, residual);
  }
  return byDirective;
};

export const buildStatusReport = async (): Promise<StatusReport> => {
  const generatedAt = new Date().toISOString();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [daemon, dispatchEnv, pendingEnv, readyEnv, ownerEnv, knowledgeEnv, recipeEnv, artifactEnv, effectivenessEnv, contradictoryEnv, failureEnv, closureEnv, changesEnv] = await Promise.all([
    daemonSummary(),
    readView("dispatch_resolved_view"),
    readView("pending_owner_decision_queue_view"),
    readView("ready_tasks_view"),
    readView("owner_profile_view"),
    readView("promoted_knowledge_view"),
    readView("recipe_registry_view"),
    readView("code_artifact_registry_view"),
    readView("applied_lesson_effectiveness_view"),
    readView("contradictory_candidates_view"),
    readView("failure_view"),
    recentEvents(["task_closure_audited"]),
    recentEvents(["applied_change_committed"]),
  ]);

  const viewErrors: Record<string, string> = {};
  const rows = <T>(name: string, env: ViewEnvelope): T[] => {
    if (!env.ok) { viewErrors[name] = env.error; return []; }
    return asArray<T>(env.result);
  };

  const dispatchRows = rows<DispatchRow>("dispatch_resolved_view", dispatchEnv);
  const pendingRows = rows<Record<string, unknown>>("pending_owner_decision_queue_view", pendingEnv);
  const readyRows = rows<ReadyRow>("ready_tasks_view", readyEnv);
  const ownerRows = rows<OwnerProfileRow>("owner_profile_view", ownerEnv);
  const knowledgeRows = rows<TimedRow>("promoted_knowledge_view", knowledgeEnv);
  const recipeRows = rows<TimedRow>("recipe_registry_view", recipeEnv);
  const artifactRows = rows<TimedRow>("code_artifact_registry_view", artifactEnv);
  const effectivenessRows = rows<EffectivenessRow>("applied_lesson_effectiveness_view", effectivenessEnv);
  const contradictionRows = rows<Record<string, unknown>>("contradictory_candidates_view", contradictoryEnv);
  const failureRows = rows<Record<string, unknown>>("failure_view", failureEnv);
  const closureEvents = closureEnv.ok ? asArray<RecentEvent>((closureEnv.result as { events?: unknown[] }).events) : [];
  const changeEvents = changesEnv.ok ? asArray<AppliedChangeEvent>((changesEnv.result as { events?: unknown[] }).events) : [];
  if (!closureEnv.ok) viewErrors["runtime.recent_events:task_closure_audited"] = closureEnv.error;
  if (!changesEnv.ok) viewErrors["runtime.recent_events:applied_change_committed"] = changesEnv.error;

  const dispatchLifecycle = { live: 0, queued_at_cap: 0, completed: 0, failed: 0, zombie: 0, total: dispatchRows.length };
  for (const row of dispatchRows) {
    const status = isLifecycle(row.lifecycle_status) ? row.lifecycle_status : isLifecycle(row.status) ? row.status : "live";
    dispatchLifecycle[status] += 1;
  }

  const profileRow = ownerRows[0];
  const profile = parsePayload(profileRow?.payload) as OwnerProfileCard;
  const ownerProfile = {
    autonomy_score: typeof profile.autonomy_score === "number" ? profile.autonomy_score : null,
    autonomy_score_floor: typeof profile.autonomy_score_floor === "number" ? profile.autonomy_score_floor : null,
    detected_language: typeof profile.detected_language === "string" ? profile.detected_language : null,
    preferred_terms: asStringArray(profile.preferred_terms).slice(0, 8),
    avoided_terms: asStringArray(profile.avoided_terms).slice(0, 8),
    things_to_never_do: asStringArray(profile.things_to_never_do).slice(0, 5),
    manual_review_patterns: asStringArray(profile.manual_review_patterns).slice(0, 5),
    hot_topics: asStringArray(profile.hot_topics).slice(0, 5),
    signal_summary: {
      rendering_signals: topNumberSignals(profile.rendering_signals),
      autonomy_signals: topNumberSignals(profile.autonomy_signals),
      control_signals: topNumberSignals(profile.control_signals),
      risk_signals: topNumberSignals(profile.risk_signals),
      collaboration_signals: topNumberSignals(profile.collaboration_signals),
      goal_continuity_signals: topNumberSignals(profile.goal_continuity_signals),
    },
    source_event_id: profileRow?.event_id,
    source_ts: profileRow?.ts,
  };

  const closureByDirective = latestClosureResiduals(closureEvents);
  const activeDirectives = dispatchRows
    .filter((row) => {
      const status = isLifecycle(row.lifecycle_status) ? row.lifecycle_status : row.status;
      return status === "live" || status === "queued_at_cap" || status === "zombie";
    })
    .slice(0, 10)
    .map((row) => {
      const directiveId = String(row.directive_id ?? "");
      const status = isLifecycle(row.lifecycle_status) ? row.lifecycle_status : isLifecycle(row.status) ? row.status : "live";
      return {
        directive_id: directiveId,
        root_task_id: String(row.root_task_id ?? ""),
        status,
        reason: row.status_reason ?? row.queued_reason ?? null,
        closure_residual: closureByDirective.get(directiveId) ?? (typeof row.residual === "number" ? row.residual : null),
        latest_signal_at: row.latest_signal_at ?? null,
      };
    });

  const readySample = readyRows.slice(0, 5).map((row) => {
    const payload = parsePayload(row.payload);
    const goal = typeof payload.goal === "string" ? payload.goal : typeof payload.task_goal === "string" ? payload.task_goal : "";
    return { directive_id: String(row.directive_id ?? ""), task_id: String(row.task_id ?? ""), goal };
  });

  const blocked: string[] = [];
  if (pendingRows.length > 0) blocked.push("owner_decision_required=" + pendingRows.length);
  if (dispatchLifecycle.queued_at_cap > 0) blocked.push("queued_at_cap=" + dispatchLifecycle.queued_at_cap);
  if (dispatchLifecycle.zombie > 0) blocked.push("zombie=" + dispatchLifecycle.zombie);
  if (dispatchLifecycle.failed > 0) blocked.push("failed=" + dispatchLifecycle.failed);
  if (contradictionRows.length > 0) blocked.push("knowledge_contradictions=" + contradictionRows.length);
  if (!daemon.running || daemon.stuck_workers > 0) blocked.push("daemon=" + daemon.status);

  const nextAction = pendingRows.length > 0
    ? "answer_owner_decision"
    : dispatchLifecycle.zombie > 0
      ? "inspect_zombie_dispatch"
      : readyRows.length > 0
        ? "scheduler_tick_ready"
        : dispatchLifecycle.queued_at_cap > 0
          ? "wait_or_raise_dispatch_cap"
          : dispatchLifecycle.live > 0
            ? "watch_live_dispatch"
            : contradictionRows.length > 0
              ? "resolve_knowledge_contradictions"
              : "idle_no_owner_action";

  const recentChanges = changeEvents.slice(0, 5).map((event) => ({
    event_id: String(event.event_id ?? ""),
    ts: String(event.ts ?? ""),
    status: typeof event.payload?.status === "string" ? event.payload.status : "unknown",
    target: typeof event.payload?.target === "string" ? event.payload.target : null,
    summary: typeof event.payload?.summary === "string" ? event.payload.summary : null,
  }));

  return {
    generated_at: generatedAt,
    contract: { name: "acc_status_snapshot", version: 1, lifecycle_values: [...LIFECYCLES], sources: STATUS_SOURCES },
    daemon,
    dispatch_lifecycle: dispatchLifecycle,
    pending_owner_decisions: { count: pendingRows.length, top: pendingRows.slice(0, 5) },
    owner_profile: ownerProfile,
    learning: {
      knowledge_total: knowledgeRows.length,
      knowledge_24h: countSince(knowledgeRows, since24h),
      recipe_total: recipeRows.length,
      recipe_24h: countSince(recipeRows, since24h),
      artifact_total: artifactRows.length,
      artifact_24h: countSince(artifactRows, since24h, "created_at"),
      applied_lessons_total: effectivenessRows.length,
      applied_lessons_24h: countSince(effectivenessRows, since24h, "committed_at"),
      compounded_total: countTrue(effectivenessRows, "compounded"),
      tier0_replay_hits: countTrue(effectivenessRows, "tier0_replay_hit"),
      avg_residual_delta: averageNumber(effectivenessRows.map((row) => row.residual_delta)),
      contradictions: contradictionRows.length,
    },
    actual_changes: {
      applied_24h: changeEvents.filter((event) => event.ts && event.ts >= since24h && event.payload?.status === "applied").length,
      failed_24h: changeEvents.filter((event) => event.ts && event.ts >= since24h && event.payload?.status === "failed").length,
      refused_24h: changeEvents.filter((event) => event.ts && event.ts >= since24h && event.payload?.status === "refused").length,
      recent: recentChanges,
    },
    active_directives: activeDirectives,
    ready_tasks: { count: readyRows.length, sample: readySample },
    blocked,
    next_action: nextAction,
    failures: failureRows.slice(0, 5),
    view_errors: viewErrors,
  };
};

const line = (title: string, rows: string[]): string =>
  title + "\n" + (rows.length === 0 ? "  (none)" : rows.map((row) => "  " + row).join("\n"));

const fmtNum = (value: number | null | undefined): string =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "unset";

export const renderStatusReport = (report: StatusReport): string => {
  const sections: string[] = [];
  sections.push("acc status - owner state @ " + report.generated_at);
  sections.push(line("answer", ["next_action=" + report.next_action, "blocked=" + (report.blocked.length ? report.blocked.join(", ") : "none")]));
  sections.push(line("daemon", ["status=" + report.daemon.status + " running=" + report.daemon.running + " pid=" + (report.daemon.pid ?? "?") + " uptime=" + (report.daemon.uptime_s ?? "?") + "s stuck_workers=" + report.daemon.stuck_workers + (report.daemon.error ? " error=" + report.daemon.error : "")]));
  sections.push(line("dispatch lifecycle", ["live=" + report.dispatch_lifecycle.live + " queued_at_cap=" + report.dispatch_lifecycle.queued_at_cap + " completed=" + report.dispatch_lifecycle.completed + " failed=" + report.dispatch_lifecycle.failed + " zombie=" + report.dispatch_lifecycle.zombie + " total=" + report.dispatch_lifecycle.total]));
  sections.push(line("owner", ["pending_decisions=" + report.pending_owner_decisions.count + " autonomy_score=" + fmtNum(report.owner_profile.autonomy_score) + " floor=" + fmtNum(report.owner_profile.autonomy_score_floor) + " language=" + (report.owner_profile.detected_language ?? "unset"), "preferred_terms=" + (report.owner_profile.preferred_terms.length ? report.owner_profile.preferred_terms.join(", ") : "none"), "avoided_terms=" + (report.owner_profile.avoided_terms.length ? report.owner_profile.avoided_terms.join(", ") : "none")]));
  sections.push(line("learning growth", ["knowledge=" + report.learning.knowledge_total + " (+" + report.learning.knowledge_24h + "/24h) recipes=" + report.learning.recipe_total + " (+" + report.learning.recipe_24h + "/24h) artifacts=" + report.learning.artifact_total + " (+" + report.learning.artifact_24h + "/24h) applied_lessons=" + report.learning.applied_lessons_total + " (+" + report.learning.applied_lessons_24h + "/24h) compounded=" + report.learning.compounded_total + " tier0=" + report.learning.tier0_replay_hits + " contradictions=" + report.learning.contradictions]));
  sections.push(line("actual changes", ["applied_24h=" + report.actual_changes.applied_24h + " failed_24h=" + report.actual_changes.failed_24h + " refused_24h=" + report.actual_changes.refused_24h]));
  sections.push(line("active directives", report.active_directives.length ? report.active_directives.map((d) => d.directive_id.slice(0, 12) + " root=" + d.root_task_id.slice(0, 8) + " status=" + d.status + " reason=" + (d.reason ?? "?") + " closure_residual=" + fmtNum(d.closure_residual)) : ["none"]));
  sections.push(line("ready tasks", report.ready_tasks.count > 0 ? [String(report.ready_tasks.count) + " ready", ...report.ready_tasks.sample.map((t) => t.task_id.slice(0, 8) + " " + t.directive_id.slice(0, 12) + " " + t.goal.slice(0, 70))] : ["0 ready tasks"]));
  sections.push(line("failures", report.failures.length ? report.failures.map((f) => String(f.failure_kind ?? "unknown") + " count=" + String(f.count ?? "?") + " latest=" + String(f.latest_ts ?? "?")) : ["none"]));
  if (Object.keys(report.view_errors).length > 0) {
    sections.push(line("view errors", Object.entries(report.view_errors).map(([name, error]) => name + ": " + error)));
  }
  return sections.join("\n\n") + "\n";
};

export const runStatus = async (argv: string[]): Promise<number> => {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("usage: acc status [--json]\n\nOne-screen owner state answer from substrate.read projections.\n");
    return 0;
  }
  const report = await buildStatusReport();
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(renderStatusReport(report));
  return Object.keys(report.view_errors).length > 0 && report.dispatch_lifecycle.total === 0 && report.ready_tasks.count === 0 ? 1 : 0;
};
