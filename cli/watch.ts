#!/usr/bin/env bun
// `acc watch` - ANSI TUI for the substrate event stream. The public test
// surface is intentionally small: keep runWatch(argv, opts?) and
// renderFrame(state, columns, rows) stable and side-effect free.

import { mcpCall, sseConnect, type SseEvent, requireAux, rpcGet } from "./rpc";
import type { Database } from "bun:sqlite";
import { resolve as resolvePath } from "node:path";
import { openDb } from "../substrate/db";
import { resolveDbPath } from "../runtime/state_paths";
import { gatherTrustMetrics, type TrustMetrics } from "./trust";
import { aggregateVerify } from "./verify";
import { OWNER_GATED_PATH_PATTERNS } from "../runtime/owner_gate";

const CSI = "\x1b[";
const CLEAR_SCREEN = `${CSI}2J`;
const HOME = `${CSI}H`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const ALT_ENTER = `${CSI}?1049h`;
const ALT_EXIT = `${CSI}?1049l`;
const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const RED = `${CSI}31m`;
const GREEN = `${CSI}32m`;
const YELLOW = `${CSI}33m`;
const MAGENTA = `${CSI}35m`;
const CYAN = `${CSI}36m`;
const WHITE = `${CSI}37m`;
const INVERT = `${CSI}7m`;

const moveTo = (row: number, col: number): string => `${CSI}${row};${col}H`;

type ActiveDirective = {
  directive_id: string;
  opened_ts: string;
  text: string;
  lifecycle: string;
  status?: string;
  urgency?: string;
};

type ReadyTask = {
  task_id: string;
  directive_id: string;
  goal: string;
  status?: string;
  depth?: number;
};

// Each substrate row carries every column the source view exposed in
// `view_row` so the TUI's Detail pane / Enter-toggled viewer can render
// the full record (declared_sandbox, posterior alpha/beta, body code,
// trajectory, etc.) without a second round-trip to the substrate.
type ArtifactRow = {
  id: string;
  runtime: string;
  score: number;
  status: string;
  name: string | null;
  confidence?: number;
  view_row?: Record<string, unknown>;
};

type RecipeRow = {
  id: string;
  name: string;
  confidence: number;
  goal_shape?: string;
  status?: string;
  view_row?: Record<string, unknown>;
};

type LessonRow = {
  id: string;
  kind: string;
  summary: string;
  target?: string;
  ts?: string;
  view_row?: Record<string, unknown>;
};

type KnowledgeRow = {
  id: string;
  text: string;
  score: number;
  status?: string;
  origin?: string;
  view_row?: Record<string, unknown>;
};

type DaemonHealth = {
  pid?: number;
  uptime_ms?: number;
  events_count?: number;
  mcp_port?: number;
  aux_port?: number;
  ok?: boolean;
  status?: string;
  // Brain audit boxbz1d1q axis J + TUI rewrite proposal axis F (2026-05-15):
  // organism-pulse fields surfaced from /health so the TUI's footer
  // line is always-visible substrate health.
  stuck_workers?: Array<{ worker: string; last_tick_ms_ago: number | null }>;
  hotreload?: {
    last_reload_ts?: string | null;
    last_reload_module?: string | null;
    last_failure?: { ts: string; module: string; reason: string } | null;
    watched_module_count?: number;
    reload_total?: number;
    failure_total?: number;
  } | null;
  activation_listener_count?: number;
  pathology_budget_exhausted_recent_count?: number;
  pathology_budget_debited_recent_count?: number;
  brain_failed_recent_count?: number;
  health_window_iso?: string;
};

type EventRow = {
  event_id: string;
  ts: string;
  kind: string;
  directive_id?: string;
  task_id?: string;
  payload?: unknown;
};

type ViewKey = "dag" | "directives" | "tasks" | "events" | "artifacts" | "recipes" | "lessons" | "interventions" | "knowledge" | "trust" | "decisions" | "health" | "drift";

// Operator-dashboard panels (consolidated `acc watch` per brain audit
// V7FBAW66C95FD3447GHAXK48XM). Render as full-pane text blocks, kept OUT
// of the numbered tab list so existing 1-8 shortcuts stay unchanged.
const PANEL_VIEWS: ReadonlySet<ViewKey> = new Set<ViewKey>(["trust", "decisions", "health", "drift"]);

type PendingDecision = { event_id: string; kind: string; target: string; anchor: string; age_ms: number };
type DriftSummary = { directive_id: string; status: string; applied: number; failed: number; refused: number; stranded: number; drift: number; missing: number };

// DAG-first TUI (brain audit bs00e26fx, 2026-05-15): the substrate IS a
// DAG of directive → task → event nodes joined by task_edge_recorded
// `refines | requires | blocks | contains` edges. The DAG view is the
// canonical entry surface; the other tabs are saved-filter overlays
// over the same underlying ledger.
type DagEdgeKind = "refines" | "requires" | "blocks" | "contains" | "event";
type DagRowKind = "directive" | "task" | "event" | "fold" | "surface" | "substrate";

type DagNode = {
  id: string;
  rowKind: DagRowKind;
  title: string;
  meta: string;
  body: string;
  status?: string;
  eventKind?: string;
  directive_id?: string;
  task_id?: string;
  parent_id?: string;
  edgeKind?: DagEdgeKind;
  depth: number;
  children: DagNode[];
  raw?: unknown;
};

export type WatchState = {
  events: EventRow[];
  active: ActiveDirective[];
  ready: ReadyTask[];
  artifacts: ArtifactRow[];
  health: DaemonHealth;
  recipes?: RecipeRow[];
  lessons?: LessonRow[];
  knowledge?: KnowledgeRow[];
  // Dedicated buffers for rare-event panels. Pre-fix these views filtered
  // state.events post-hoc, but the recent-events buffer is bounded (160 rows
  // by default) and supervisor / lesson rows can be hours old - they drop
  // off the buffer and the panel renders empty even when many such rows
  // exist in the substrate. Each panel now fetches its OWN buffer via
  // runtime.recent_events with a kinds filter so the data flow doesn't
  // depend on the live event stream's rotation.
  supervisorEvents?: EventRow[];
  lessonEvents?: EventRow[];
  view?: ViewKey;
  selected?: Partial<Record<ViewKey, number>>;
  filter?: string;
  showHelp?: boolean;
  // Operator-dashboard panels populated by refreshPanels()
  trust?: TrustMetrics | null;
  trust_refreshed_ms?: number;
  decisions?: PendingDecision[];
  decisions_refreshed_ms?: number;
  drift?: DriftSummary[];
  drift_refreshed_ms?: number;
  /** Enter toggles a full-screen detail viewer that shows the selected
   *  row's full untrimmed body. j/k scroll within the viewer. Esc/Enter
   *  exits back to the split list+preview layout. */
  expanded?: boolean;
  detailScrollY?: number;
};

type ListItem = {
  id: string;
  title: string;
  meta: string;
  body: string;
  status?: string;
  kind?: string;
  score?: number;
  raw?: unknown;
};

const MAX_EVENTS = 300;
const MAX_INITIAL_EVENTS = 120;
const POLL_INTERVAL_MS = 2000;
const VIEWS: Array<{ key: ViewKey; label: string }> = [
  { key: "dag", label: "Now" },
  { key: "directives", label: "Goals" },
  { key: "tasks", label: "Ready" },
  { key: "lessons", label: "Lessons" },
  { key: "knowledge", label: "Evidence" },
  { key: "recipes", label: "Recipes" },
  { key: "interventions", label: "Risks" },
  { key: "events", label: "Event Log" },
];
// Brain TUI rewrite proposal (btqner8jn axis B, 2026-05-15): treat noisy
// heartbeat events as semantic folds - keep them in the buffer but
// collapse consecutive identical-kind rows under one entry with a
// grouped_count + latest_ts. Pre-fix the Recent Events panel was
// 300 rows of worker_tick_completed and the operator saw no signal.
const HEARTBEAT_KINDS = new Set([
  "father_cycle_recorded",
  "scheduler_tick_completed",
  "worker_tick_completed",
  "bridge_frame_received",
  "brain_reasoning_recorded",
  "brain_message_emitted",
]);

const emptyState = (): WatchState => ({
  events: [],
  active: [],
  ready: [],
  artifacts: [],
  recipes: [],
  lessons: [],
  knowledge: [],
  health: {},
  view: "dag",
  selected: {},
  filter: "",
  showHelp: false,
});

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const visibleLength = (s: string): number => stripAnsi(s).length;

const truncate = (s: string, max: number): string => {
  if (max <= 0) return "";
  const plain = stripAnsi(s);
  if (plain.length <= max) return s;
  if (s !== plain) return plain.slice(0, Math.max(0, max - 1)) + "...";
  return s.slice(0, Math.max(0, max - 1)) + "...";
};

const pad = (s: string, width: number): string => {
  const clipped = truncate(s, width);
  return clipped + " ".repeat(Math.max(0, width - visibleLength(clipped)));
};

const asObject = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  // Substrate views return event payloads as JSON-serialised TEXT columns
  // (the underlying events.payload column is TEXT). Pre-fix the TUI treated
  // these as opaque strings and fell through to "(no text)" for every
  // directive / ready task. Try one parse pass so the panels see structured
  // fields like directive_text / goal / lifecycle.
  if (typeof v === "string" && v.length > 0 && (v[0] === "{" || v[0] === "[")) {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* malformed JSON - fall through to {} */ }
  }
  return {};
};

const asString = (v: unknown, fallback = ""): string => typeof v === "string" ? v : fallback;
const asNumber = (v: unknown, fallback = 0): number => typeof v === "number" && Number.isFinite(v) ? v : fallback;

const shortId = (s: string | undefined, n = 10): string => s ? s.slice(0, n) : "-";

const formatPayloadPreview = (payload: unknown, max = 90): string => {
  if (payload === null || payload === undefined) return "";
  try {
    const s = typeof payload === "string" ? payload : JSON.stringify(payload);
    return truncate(s.replace(/\s+/g, " "), max);
  } catch { return ""; }
};

/** Full pretty-printed payload, no truncation, preserves whitespace. Used by
 *  the events/supervisor body fields so the side-pane preview and the
 *  Enter-toggled full-screen viewer can render every byte. */
const formatPayloadFull = (payload: unknown): string => {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") {
    if (payload.length > 0 && (payload[0] === "{" || payload[0] === "[")) {
      try { return JSON.stringify(JSON.parse(payload), null, 2); } catch { return payload; }
    }
    return payload;
  }
  try { return JSON.stringify(payload, null, 2); } catch { return String(payload); }
};

const labelForView = (view: ViewKey): string => VIEWS.find((v) => v.key === view)?.label ?? view;
const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

const eventColor = (kind = ""): string => {
  if (kind.includes("failed") || kind.includes("violation") || kind.includes("conflict")) return RED;
  if (kind.includes("committed") || kind.includes("promoted") || kind.includes("scored")) return GREEN;
  if (kind.includes("opened") || kind.includes("predicted") || kind.includes("candidate")) return CYAN;
  if (kind.includes("lesson") || kind.includes("amendment")) return MAGENTA;
  if (HEARTBEAT_KINDS.has(kind)) return DIM;
  return WHITE;
};

const statusColor = (status = "", score?: number): string => {
  const s = status.toLowerCase();
  if (s.includes("fail") || s.includes("blocked") || s.includes("hold")) return RED;
  if (s.includes("commit") || s.includes("success") || s.includes("active") || s.includes("ready")) return GREEN;
  if (typeof score === "number" && score >= 0.85) return GREEN;
  if (typeof score === "number" && score >= 0.6) return YELLOW;
  if (typeof score === "number" && score > 0) return MAGENTA;
  return WHITE;
};

const readGenericView = async (view_name: string, args?: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
  try {
    const env = await mcpCall("substrate.read", { view_name, ...(args ? { args } : {}) });
    if (!env.ok || !Array.isArray(env.result)) return [];
    return env.result as Array<Record<string, unknown>>;
  } catch { return []; }
};

const readActiveDirectives = async (): Promise<ActiveDirective[]> => {
  const rows = await readGenericView("active_objectives_view");
  return rows.slice(0, 80).map((r) => {
    const payload = asObject(r.payload);
    return {
      directive_id: asString(r.directive_id, asString(r.id, "unknown")),
      opened_ts: asString(r.opened_ts, asString(r.ts, "")),
      text: asString(payload.text, asString(payload.directive_text, asString(payload.goal, "(no text)"))),
      lifecycle: asString(payload.lifecycle, asString(r.lifecycle, "finite")),
      status: asString(r.status, asString(payload.status, "active")),
      urgency: asString(payload.urgency, asString(r.urgency, "normal")),
    };
  });
};

const readReadyTasks = async (): Promise<ReadyTask[]> => {
  const rows = await readGenericView("ready_tasks_view", { limit: 120 });
  return rows.slice(0, 120).map((r) => {
    const payload = asObject(r.payload);
    return {
      task_id: asString(r.task_id, asString(r.id, "unknown")),
      directive_id: asString(r.directive_id, ""),
      goal: asString(payload.goal, asString(r.goal, "(no goal)")),
      status: asString(r.status, asString(payload.status, "ready")),
      depth: asNumber(r.depth, asNumber(payload.depth, 0)),
    };
  });
};

const readArtifactLeaderboard = async (): Promise<ArtifactRow[]> => {
  const rows = await readGenericView("code_artifact_registry_view");
  return rows.slice(0, 120).map((r) => ({
    id: asString(r.id, asString(r.artifact_id, "unknown")),
    runtime: asString(r.runtime, "?"),
    score: asNumber(r.score, asNumber(r.posterior, 0)),
    status: asString(r.status, "unknown"),
    name: asString(r.name, "") || null,
    confidence: asNumber(r.confidence, 0),
    view_row: r,
  }));
};

const readRecipes = async (): Promise<RecipeRow[]> => {
  const rows = await readGenericView("recipe_registry_view");
  return rows.slice(0, 120).map((r) => ({
    id: asString(r.id, asString(r.recipe_id, "unknown")),
    name: asString(r.name, asString(r.goal_shape, "recipe")),
    confidence: asNumber(r.confidence, asNumber(r.score, 0)),
    goal_shape: asString(r.goal_shape, ""),
    status: asString(r.status, "available"),
    view_row: r,
  }));
};

const readKnowledge = async (): Promise<KnowledgeRow[]> => {
  const rows = await readGenericView("promoted_knowledge_view");
  return rows.slice(0, 160).map((r) => ({
    // promoted_knowledge_view exposes the promotion row's id as `event_id`
    // (the canonical handle) and the originating candidate as `candidate_id`.
    // Fall through to those before defaulting to "unknown" so the operator
    // sees real ids instead of placeholders.
    id: asString(
      r.id,
      asString(
        r.knowledge_id,
        asString(r.event_id, asString(r.candidate_id, "unknown")),
      ),
    ),
    text: asString(r.text, asString(r.summary, asString(r.content, "(no text)"))),
    score: asNumber(r.score, asNumber(r.posterior, 0)),
    status: asString(r.status, "promoted"),
    origin: asString(r.substrate_origin, asString(r.origin, "")),
    view_row: r,
  }));
};

const readHealth = async (): Promise<DaemonHealth> => {
  try {
    const base = requireAux();
    return await rpcGet<DaemonHealth>(`${base}/health`);
  } catch { return {}; }
};

// Operator-dashboard readers (re-use gatherTrustMetrics, aggregateVerify, OWNER_GATED_PATH_PATTERNS).
let _panelDb: Database | null = null;
const panelDb = (): Database | null => {
  if (_panelDb) return _panelDb;
  try { _panelDb = openDb(resolveDbPath()); } catch { _panelDb = null; }
  return _panelDb;
};
const parseJsonSafe = (s: unknown): Record<string, unknown> => {
  if (s && typeof s === "object") return s as Record<string, unknown>;
  try { return JSON.parse(String(s ?? "{}")) as Record<string, unknown>; } catch { return {}; }
};
const ageOf = (ts: string, now: number): number => { const t = Date.parse(ts || ""); return Number.isFinite(t) ? Math.max(0, now - t) : 0; };

export const readPendingDecisions = (db: Database, nowMs: number): PendingDecision[] => {
  type R = { id: string; ts: string; payload: string };
  const out: PendingDecision[] = [];
  const isResolved = (id: string, kinds: string) =>
    !!db.query(`SELECT 1 FROM events WHERE kind IN (${kinds}) AND context_refs LIKE ? LIMIT 1`).get(`%${id}%`);
  for (const r of db.query(`SELECT id, ts, payload FROM events WHERE kind='owner_input_required' ORDER BY ts DESC LIMIT 200`).all() as R[]) {
    if (isResolved(r.id, `'owner_decision_recorded'`)) continue;
    const p = parseJsonSafe(r.payload);
    out.push({ event_id: r.id, kind: "owner_input_required", target: String(p.target ?? p.question ?? "-").slice(0, 60), anchor: String(p.anchor ?? p.summary ?? p.question ?? "").slice(0, 30), age_ms: ageOf(r.ts, nowMs) });
  }
  for (const r of db.query(`SELECT id, ts, payload FROM events WHERE kind='hidl_action_required' ORDER BY ts DESC LIMIT 200`).all() as R[]) {
    if (isResolved(r.id, `'hidl_action_resolved','owner_decision_recorded'`)) continue;
    const p = parseJsonSafe(r.payload);
    out.push({ event_id: r.id, kind: "hidl_action_required", target: String(p.target ?? p.action ?? "-").slice(0, 60), anchor: String(p.anchor ?? p.summary ?? p.action ?? "").slice(0, 30), age_ms: ageOf(r.ts, nowMs) });
  }
  for (const r of db.query(`SELECT id, ts, payload FROM events WHERE kind='contract_amendment_proposed' ORDER BY ts DESC LIMIT 400`).all() as R[]) {
    const p = parseJsonSafe(r.payload);
    const target = String(p.target ?? "");
    if (!target || !OWNER_GATED_PATH_PATTERNS.some(({ regex }) => regex.test(target))) continue;
    if (db.query(`SELECT 1 FROM events WHERE kind='contract_amendment_applied' AND (context_refs LIKE ? OR json_extract(payload,'$.source_event_id')=?) LIMIT 1`).get(`%${r.id}%`, r.id)) continue;
    out.push({ event_id: r.id, kind: "contract_amendment_proposed", target: target.slice(0, 60), anchor: String(p.anchor ?? "").slice(0, 30), age_ms: ageOf(r.ts, nowMs) });
  }
  out.sort((a, b) => b.age_ms - a.age_ms);
  return out;
};

export const readDriftSummaries = (db: Database, repoRoot: string, n = 10): DriftSummary[] => {
  const ids = (db.query(`SELECT directive_id FROM events WHERE kind='directive_opened' GROUP BY directive_id ORDER BY MAX(ts) DESC LIMIT ?`).all(n) as Array<{ directive_id: string }>).map((r) => r.directive_id).filter(Boolean);
  const out: DriftSummary[] = [];
  for (const directive_id of ids) {
    try {
      const agg = aggregateVerify(db, directive_id, repoRoot);
      const term = db.query(`SELECT kind FROM events WHERE directive_id=? AND kind IN ('task_committed','task_failed') ORDER BY ts DESC LIMIT 1`).get(directive_id) as { kind?: string } | null;
      const status = term?.kind === "task_committed" ? "committed" : term?.kind === "task_failed" ? "failed" : "in-flight";
      out.push({ directive_id, status, applied: agg.applied, failed: agg.failed, refused: agg.refused, stranded: agg.stranded.length, drift: agg.drift, missing: agg.missing });
    } catch { /* skip directives we can't verify */ }
  }
  out.sort((a, b) => (b.drift + b.missing) - (a.drift + a.missing));
  return out;
};

const formatAge = (ms: number): string =>
  ms < 60_000 ? `${Math.floor(ms / 1000)}s`
  : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m`
  : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h` : `${Math.floor(ms / 86_400_000)}d`;
const firstWord = (s: string): string => { const m = String(s ?? "").trim().match(/^[\w-]+/); return m ? m[0] : "-"; };

const readRecentEvents = async (): Promise<EventRow[]> => {
  try {
    const env = await mcpCall("runtime.recent_events", { k: MAX_INITIAL_EVENTS });
    if (!env.ok) return [];
    const data = env.result as { events?: Array<Record<string, unknown>> };
    return (data.events ?? []).map((e) => ({
      event_id: asString(e.event_id, asString(e.id, "")),
      ts: asString(e.ts, ""),
      kind: asString(e.kind, "unknown"),
      directive_id: asString(e.directive_id, "") || undefined,
      task_id: asString(e.task_id, "") || undefined,
      payload: e.payload,
    }));
  } catch { return []; }
};

// Kinds the Lessons panel surfaces. Centralised so the buffer fetch and the
// post-fetch render contract stay aligned - the same canonical kind list
// gates both the dedicated runtime.recent_events query AND the SSE-time
// state-events filter.
const LESSON_EVENT_KINDS = ["lesson_extracted", "contract_amendment_proposed"];

// Kinds the Supervisor panel surfaces. Mirrors the structural-fault and
// observability taxonomy emitted by runtime/supervisor.ts +
// runtime/bridge_health.ts + crisis_mode + integrity workers.
const SUPERVISOR_EVENT_KINDS = [
  "supervisor_intervention_recorded",
  "bridge_health_degraded",
  "bridge_health_recovered",
  "dispatcher_violation",
  "irreversible_effect_recorded",
  "pathology_budget_debited",
  "pathology_budget_exhausted",
  "bridge_stuck",
  "applied_change_failed",
  "owner_input_required",
  "hidl_action_required",
];

// Dedicated buffer fetch for low-frequency events. We pull the most recent
// k=200 rows matching the kinds filter; this surfaces hours-old supervisor
// interventions that the bounded live-events buffer would have rotated out.
const readKindBuffer = async (kinds: string[], k = 200): Promise<EventRow[]> => {
  try {
    const env = await mcpCall("runtime.recent_events", { k, kinds });
    if (!env.ok) return [];
    const data = env.result as { events?: Array<Record<string, unknown>> };
    // runtime.recent_events returns ts-ascending; reverse so the panel
    // renders newest-first like every other surface.
    return (data.events ?? []).reverse().map((e) => ({
      event_id: asString(e.event_id, asString(e.id, "")),
      ts: asString(e.ts, ""),
      kind: asString(e.kind, "unknown"),
      directive_id: asString(e.directive_id, "") || undefined,
      task_id: asString(e.task_id, "") || undefined,
      payload: e.payload,
    }));
  } catch { return []; }
};

const deriveDirectives = (state: WatchState): ActiveDirective[] => {
  const byId = new Map<string, ActiveDirective>();
  for (const d of state.active ?? []) byId.set(d.directive_id, d);
  for (const ev of state.events ?? []) {
    if (!ev.directive_id && ev.kind !== "directive_opened") continue;
    const payload = asObject(ev.payload);
    const id = ev.directive_id ?? asString(payload.directive_id, ev.event_id);
    if (!id || byId.has(id)) continue;
    if (ev.kind === "directive_opened" || asString(payload.directive_text) || asString(payload.text)) {
      byId.set(id, {
        directive_id: id,
        opened_ts: ev.ts,
        text: asString(payload.directive_text, asString(payload.text, asString(payload.goal, "(no directive text)"))),
        lifecycle: asString(payload.lifecycle, "finite"),
        status: "seen",
        urgency: asString(payload.urgency, "normal"),
      });
    }
  }
  return [...byId.values()].sort((a, b) => (b.opened_ts || "").localeCompare(a.opened_ts || ""));
};

const deriveTasks = (state: WatchState): ReadyTask[] => {
  const byId = new Map<string, ReadyTask>();
  for (const t of state.ready ?? []) byId.set(t.task_id, t);
  for (const ev of state.events ?? []) {
    if (!ev.task_id) continue;
    const payload = asObject(ev.payload);
    const existing = byId.get(ev.task_id);
    const status = ev.kind === "task_committed" ? "committed" : ev.kind === "task_failed" ? "failed" : ev.kind === "task_node_opened" ? "opened" : existing?.status ?? "seen";
    byId.set(ev.task_id, {
      task_id: ev.task_id,
      directive_id: ev.directive_id ?? existing?.directive_id ?? "",
      goal: asString(payload.goal, existing?.goal ?? (formatPayloadPreview(ev.payload, 120) || ev.kind)),
      status,
      depth: existing?.depth,
    });
  }
  return [...byId.values()];
};

const deriveRecipes = (state: WatchState): RecipeRow[] => {
  const rows = [...(state.recipes ?? [])];
  for (const ev of state.events ?? []) {
    if (ev.kind !== "recipe_extracted" && ev.kind !== "recipe_replayed" && ev.kind !== "recipe_replay_aborted") continue;
    const p = asObject(ev.payload);
    rows.push({
      id: asString(p.recipe_id, ev.event_id),
      name: asString(p.name, asString(p.goal_shape, ev.kind)),
      confidence: asNumber(p.confidence, asNumber(p.score, 0)),
      goal_shape: asString(p.goal_shape, ""),
      status: ev.kind,
    });
  }
  return rows;
};

const deriveLessons = (state: WatchState): LessonRow[] => {
  // Prefer the dedicated lesson buffer when present (it carries the FULL
  // history of lesson-class events independent of the bounded live stream).
  // Fall back to scanning state.events so the legacy path still works for
  // any test that doesn't seed lessonEvents.
  const source = (state.lessonEvents && state.lessonEvents.length > 0)
    ? state.lessonEvents
    : (state.events ?? []);
  const rows: LessonRow[] = [];
  const seen = new Set<string>();
  for (const ev of source) {
    if (ev.kind !== "lesson_extracted" && ev.kind !== "contract_amendment_proposed") continue;
    if (seen.has(ev.event_id)) continue;
    seen.add(ev.event_id);
    const p = asObject(ev.payload);
    rows.push({
      id: ev.event_id,
      kind: asString(p.lesson_kind, ev.kind),
      summary: asString(p.summary, asString(p.proposed_behavior, formatPayloadPreview(ev.payload, 160))),
      target: asString(p.target, ""),
      ts: ev.ts,
    });
  }
  return rows;
};

const deriveKnowledge = (state: WatchState): KnowledgeRow[] => {
  const rows = [...(state.knowledge ?? [])];
  for (const ev of state.events ?? []) {
    if (!ev.kind.startsWith("knowledge_") && ev.kind !== "candidate_confirmed" && ev.kind !== "contradictory_candidates") continue;
    const p = asObject(ev.payload);
    rows.push({
      id: asString(p.knowledge_id, ev.event_id),
      text: asString(p.text, asString(p.summary, formatPayloadPreview(ev.payload, 180))),
      score: asNumber(p.score, asNumber(p.posterior, 0)),
      status: ev.kind,
      origin: asString(ev.kind, ""),
    });
  }
  return rows;
};

// ----------------------------------------------------------------------------
// DAG view builders (brain audit bs00e26fx, 2026-05-15)
// ----------------------------------------------------------------------------

const STRUCTURAL_EVENT_KINDS = new Set([
  "action_predicted", "action_scored", "task_committed", "task_failed",
  "knowledge_candidate", "code_artifact_candidate", "lesson_extracted",
  "contract_amendment_proposed", "recipe_extracted", "recipe_replayed",
  "dispatcher_violation",
]);
void STRUCTURAL_EVENT_KINDS;

const taskGoalFromEvent = (ev: EventRow): string => {
  const p = asObject(ev.payload);
  return asString(p.goal, asString(p.task_goal, formatPayloadPreview(ev.payload, 120) || ev.kind));
};

const edgePayload = (ev: EventRow): { from?: string; to?: string; kind: DagEdgeKind } => {
  const p = asObject(ev.payload);
  return {
    from: asString(p.from_task, asString(p.from, "")) || undefined,
    to: asString(p.to_task, asString(p.to, "")) || undefined,
    kind: (asString(p.kind, "refines") as DagEdgeKind),
  };
};

const makeEventNode = (ev: EventRow, depth: number): DagNode => ({
  id: ev.event_id,
  rowKind: HEARTBEAT_KINDS.has(ev.kind) ? "fold" : "event",
  title: ev.kind,
  meta: `${ev.ts.slice(11, 19)} dir=${shortId(ev.directive_id)} task=${shortId(ev.task_id)}`,
  body: `event_id=${ev.event_id}\nts=${ev.ts}\nkind=${ev.kind}\ndirective_id=${ev.directive_id ?? ""}\ntask_id=${ev.task_id ?? ""}\n\npayload=${formatPayloadFull(ev.payload)}`,
  status: ev.kind,
  eventKind: ev.kind,
  directive_id: ev.directive_id,
  task_id: ev.task_id,
  depth,
  children: [],
  raw: ev,
});

const groupDagHeartbeatNodes = (nodes: DagNode[], depth: number): DagNode[] => {
  const grouped: DagNode[] = [];
  for (const node of nodes) {
    const prev = grouped[grouped.length - 1];
    if (prev && prev.eventKind === node.eventKind && node.eventKind && HEARTBEAT_KINDS.has(node.eventKind)) {
      prev.children.push({ ...node, depth: depth + 1 });
      prev.title = `${node.eventKind} x${prev.children.length + 1}`;
      prev.meta = `${prev.meta} latest=${node.meta.slice(0, 8)}`;
      prev.body = `${prev.body}\n\n--- folded member ---\n${node.body}`;
      continue;
    }
    grouped.push({ ...node, depth });
  }
  return grouped;
};

const buildDagNodes = (state: WatchState): DagNode[] => {
  const directiveMap = new Map<string, DagNode>();
  const taskMap = new Map<string, DagNode>();
  const taskEvents = new Map<string, DagNode[]>();
  const directiveEvents = new Map<string, DagNode[]>();
  const unthreaded: DagNode[] = [];
  const edges: Array<{ from: string; to: string; kind: DagEdgeKind }> = [];

  for (const d of deriveDirectives(state)) {
    directiveMap.set(d.directive_id, {
      id: d.directive_id,
      rowKind: "directive",
      title: d.text,
      meta: `${d.lifecycle} ${d.status ?? ""} ${d.urgency ?? ""}`.trim(),
      body: `directive_id=${d.directive_id}\nopened=${d.opened_ts}\nlifecycle=${d.lifecycle}\nurgency=${d.urgency ?? "normal"}\n\n${d.text}`,
      status: d.status ?? d.lifecycle,
      directive_id: d.directive_id,
      depth: 0,
      children: [],
      raw: d,
    });
  }

  // Canonical task source: state.ready (ready_tasks_view projection).
  // Pre-fix this loop pulled from deriveTasks(state), which synthesized
  // a "task" entry for ANY event with a task_id - turning every
  // artifact_invoked/worker_tick/etc. payload into a fake task whose
  // goal was a JSON preview of the payload. That painted hundreds of
  // garbage "T {runtime:bun,pid:...}" rows in the DAG view.
  // Real tasks are: (a) rows in state.ready, (b) task_node_opened events
  // in the buffer (handled in the next loop).
  for (const t of state.ready ?? []) {
    taskMap.set(t.task_id, {
      id: t.task_id,
      rowKind: "task",
      title: t.goal,
      meta: `${t.status ?? "ready"} dir=${shortId(t.directive_id)} depth=${t.depth ?? 0}`,
      body: `task_id=${t.task_id}\ndirective_id=${t.directive_id}\nstatus=${t.status ?? "ready"}\ndepth=${t.depth ?? 0}\n\n${t.goal}`,
      status: t.status ?? "ready",
      directive_id: t.directive_id,
      task_id: t.task_id,
      depth: Math.max(1, (t.depth ?? 0) + 1),
      children: [],
      raw: t,
    });
  }

  for (const ev of state.events ?? []) {
    if (ev.kind === "task_node_opened" && ev.task_id && !taskMap.has(ev.task_id)) {
      const p = asObject(ev.payload);
      taskMap.set(ev.task_id, {
        id: ev.task_id,
        rowKind: "task",
        title: taskGoalFromEvent(ev),
        meta: `opened dir=${shortId(ev.directive_id)} depth=${asNumber(p.depth, 0)}`,
        body: `task_id=${ev.task_id}\ndirective_id=${ev.directive_id ?? ""}\nstatus=opened\n\n${formatPayloadFull(ev.payload)}`,
        status: "opened",
        directive_id: ev.directive_id,
        task_id: ev.task_id,
        depth: Math.max(1, asNumber(p.depth, 0) + 1),
        children: [],
        raw: ev,
      });
    }
    if (ev.kind === "task_edge_recorded") {
      const edge = edgePayload(ev);
      if (edge.from && edge.to) edges.push({ from: edge.from, to: edge.to, kind: edge.kind });
    }
  }

  for (const ev of state.events ?? []) {
    if (ev.kind === "task_node_opened" || ev.kind === "task_edge_recorded") continue;
    // Self-referential dir=/task= rows (events.ts:73-74 fallback to event id
    // when the field is genuinely absent) shouldn't fake a DAG link. Treat
    // them as unthreaded so heartbeat / global events don't pollute task
    // children. Brain dataflow audit bxdhdkm9e finding #1 (2026-05-15).
    const realTask = ev.task_id && ev.task_id !== ev.event_id ? ev.task_id : undefined;
    const realDirective = ev.directive_id && ev.directive_id !== ev.event_id ? ev.directive_id : undefined;
    const node = makeEventNode(ev, 0);
    if (realTask) {
      const list = taskEvents.get(realTask) ?? [];
      list.push(node);
      taskEvents.set(realTask, list);
    } else if (realDirective) {
      const list = directiveEvents.get(realDirective) ?? [];
      list.push(node);
      directiveEvents.set(realDirective, list);
    } else {
      unthreaded.push(node);
    }
  }

  for (const [taskId, events] of taskEvents) {
    const task = taskMap.get(taskId);
    if (task) {
      task.children.push(...groupDagHeartbeatNodes(events, task.depth + 1));
      continue;
    }
    // No task node was opened for this id - surface the orphan events under
    // the directive (when known) instead of silently dropping them.
    const firstEv = events[0]?.raw as EventRow | undefined;
    const dirId = firstEv?.directive_id;
    if (dirId && dirId !== firstEv?.event_id) {
      const list = directiveEvents.get(dirId) ?? [];
      list.push(...events);
      directiveEvents.set(dirId, list);
    } else {
      unthreaded.push(...events);
    }
  }

  const hasParent = new Set<string>();
  for (const edge of edges) {
    const from = taskMap.get(edge.from);
    const to = taskMap.get(edge.to);
    if (!from || !to) continue;
    if (to.id === from.id) continue;
    to.edgeKind = edge.kind;
    to.parent_id = from.id;
    to.depth = from.depth + 1;
    from.children.push(to);
    hasParent.add(to.id);
  }

  const orphanTasks: DagNode[] = [];
  for (const task of taskMap.values()) {
    if (hasParent.has(task.id)) continue;
    const dir = task.directive_id ? directiveMap.get(task.directive_id) : undefined;
    if (dir) {
      task.edgeKind = "contains";
      task.parent_id = dir.id;
      task.depth = 1;
      dir.children.push(task);
    } else {
      // Task whose directive_opened header is older than the local buffer.
      // Stash for the unthreaded bucket instead of spawning a placeholder
      // directive - preserves visibility without inflating the root count.
      task.depth = 1;
      orphanTasks.push(task);
    }
  }

  // Events whose directive_opened header is not in the local buffer get
  // routed to the unthreaded bucket - pre-fix each got its own synthetic
  // "(directive XX - header not in local buffer)" root, which painted
  // hundreds of placeholder rows. We KEEP every event (no drop), but
  // group them into one operator-visible bucket so the DAG stays readable.
  for (const [directiveId, events] of directiveEvents) {
    const dir = directiveMap.get(directiveId);
    if (dir) {
      dir.children.push(...groupDagHeartbeatNodes(events, 1));
    } else {
      unthreaded.push(...events);
    }
  }

  const roots = [...directiveMap.values()].sort((a, b) => b.id.localeCompare(a.id));
  if (unthreaded.length > 0 || orphanTasks.length > 0) {
    // Reverse so newest unthreaded events render at the top of the
    // substrate-noise subtree - matches the "new items at top" rule.
    const unthreadedNewestFirst = [...unthreaded].reverse();
    const unthreadedChildren = groupDagHeartbeatNodes(unthreadedNewestFirst, 1);
    const orphanCount = orphanTasks.length;
    roots.push({
      id: "substrate",
      rowKind: "substrate",
      title: "Substrate noise (no in-buffer directive)",
      meta: `${unthreaded.length} events + ${orphanCount} orphan tasks`,
      body: `Events whose directive_opened is older than the recent_events buffer,\nplus tasks whose directive header is similarly out-of-range.\n\nCount: ${unthreaded.length} events + ${orphanCount} tasks.`,
      depth: 0,
      children: [...orphanTasks, ...unthreadedChildren],
    });
  }
  return roots;
};

// Brain in-flight panel detector (option B, 2026-05-15). Scans the event
// buffer for the most recent `bridge_invoked` whose matching
// `brain_dispatch_closed` hasn't landed yet. Returns a snapshot for the
// footer panel so the operator can see what the brain is doing right now
// - answers the recurring "is the brain working?" question without leaving
// the view. Returns null when no brain dispatch is in flight.
type BrainInFlight = {
  task_id: string;
  directive_id: string;
  started_ts: string;
  elapsed_ms: number;
  intent: string;
  latest_kind: string;
  latest_text: string;
};

const findBrainInFlight = (state: WatchState, nowMs: number = Date.now()): BrainInFlight | null => {
  const events = state.events ?? [];
  let invokedIdx = -1;
  // Walk newest-first to find the latest bridge_invoked, then check there's
  // no subsequent brain_dispatch_closed for the same task.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind === "bridge_invoked") { invokedIdx = i; break; }
  }
  if (invokedIdx === -1) return null;
  const invoked = events[invokedIdx]!;
  // Any brain_dispatch_closed or bridge_completed AFTER the invoked event
  // for the same task = closed; suppress the panel.
  for (let i = invokedIdx + 1; i < events.length; i++) {
    const ev = events[i]!;
    if ((ev.kind === "brain_dispatch_closed" || ev.kind === "bridge_completed" || ev.kind === "bridge_failed") &&
        (ev.task_id === invoked.task_id || !ev.task_id)) {
      return null;
    }
  }
  const startedMs = Date.parse(invoked.ts);
  const elapsed = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0;
  // Find the latest narrative line for this task to surface in the panel.
  let latestKind = "";
  let latestText = "";
  let intent = "";
  for (let i = events.length - 1; i >= invokedIdx; i--) {
    const ev = events[i]!;
    if (ev.task_id !== invoked.task_id) continue;
    if (!latestKind && (
      ev.kind === "brain_message_emitted" ||
      ev.kind === "brain_reasoning_recorded" ||
      ev.kind === "bridge_frame_received"
    )) {
      const p = asObject(ev.payload);
      latestKind = ev.kind;
      latestText = asString(p.text, asString(p.message, asString(p.summary, formatPayloadPreview(ev.payload, 180))));
    }
    if (!intent && ev.kind === "action_predicted") {
      const p = asObject(ev.payload);
      intent = asString(p.intent, "");
    }
    if (latestKind && intent) break;
  }
  return {
    task_id: invoked.task_id ?? "(no task)",
    directive_id: invoked.directive_id ?? "(no directive)",
    started_ts: invoked.ts,
    elapsed_ms: elapsed,
    intent: intent || "(no action_predicted yet)",
    latest_kind: latestKind || "bridge_invoked",
    latest_text: latestText || "(waiting for first frame)",
  };
};

const flattenDag = (nodes: DagNode[]): ListItem[] => {
  const out: ListItem[] = [];
  const walk = (n: DagNode): void => {
    const edge = n.edgeKind && n.edgeKind !== "contains" ? `${n.edgeKind} ` : "";
    const glyph = n.rowKind === "directive" ? "D" : n.rowKind === "task" ? "T" : n.rowKind === "fold" ? "F" : "E";
    out.push({
      id: n.id,
      title: `${"  ".repeat(n.depth)}${edge}${glyph} ${n.title}`,
      meta: n.meta,
      body: n.body,
      status: n.status,
      kind: n.eventKind,
      raw: n.raw ?? n,
    });
    for (const child of n.children) walk(child);
  };
  for (const root of nodes) walk(root);
  return out;
};

const groupEvents = (events: EventRow[]): EventRow[] => {
  const grouped: EventRow[] = [];
  for (const ev of events) {
    const prev = grouped[grouped.length - 1];
    if (prev && prev.kind === ev.kind && HEARTBEAT_KINDS.has(ev.kind)) {
      const prevPayload = asObject(prev.payload);
      prev.payload = { ...prevPayload, grouped_count: asNumber(prevPayload.grouped_count, 1) + 1, latest_ts: ev.ts };
      prev.ts = ev.ts;
      continue;
    }
    grouped.push({ ...ev });
  }
  return grouped;
};

const itemsForView = (state: WatchState, view: ViewKey): ListItem[] => {
  if (view === "dag") return flattenDag(buildDagNodes(state));
  if (view === "directives") {
    return deriveDirectives(state).map((d) => ({
      id: d.directive_id,
      title: d.text,
      meta: `${d.lifecycle} ${d.status ?? ""} ${d.urgency ?? ""}`.trim(),
      body: `directive_id=${d.directive_id}\nopened=${d.opened_ts}\nlifecycle=${d.lifecycle}\nurgency=${d.urgency ?? "normal"}\n\n${d.text}`,
      status: d.status ?? d.lifecycle,
      raw: d,
    }));
  }
  if (view === "tasks") {
    return deriveTasks(state).map((t) => ({
      id: t.task_id,
      title: t.goal,
      meta: `${t.status ?? "ready"} dir=${shortId(t.directive_id)} depth=${t.depth ?? 0}`,
      body: `task_id=${t.task_id}\ndirective_id=${t.directive_id}\nstatus=${t.status ?? "ready"}\ndepth=${t.depth ?? 0}\n\n${t.goal}`,
      status: t.status ?? "ready",
      raw: t,
    }));
  }
  if (view === "events") {
    // Newest-first: reverse the chronological group so items[0] is the most
    // recent event. Pre-fix the list grew downward, so new events landed below
    // the fold and the user had to scroll. Now the live tail is always at the
    // top of the visible window.
    return groupEvents(state.events ?? []).reverse().map((e) => {
      const p = asObject(e.payload);
      const count = asNumber(p.grouped_count, 1);
      return {
        id: e.event_id,
        title: `${e.kind}${count > 1 ? ` x${count}` : ""}`,
        meta: `${e.ts.slice(11, 19)} dir=${shortId(e.directive_id)} task=${shortId(e.task_id)}`,
        // body holds the full untrimmed payload - Enter opens the full-screen
        // viewer; the side-pane preview also no longer caps at 2000 chars.
        body: `event_id=${e.event_id}\nts=${e.ts}\nkind=${e.kind}\ndirective_id=${e.directive_id ?? ""}\ntask_id=${e.task_id ?? ""}\n\npayload=${formatPayloadFull(e.payload)}`,
        kind: e.kind,
        status: e.kind,
        raw: e,
      };
    });
  }
  if (view === "artifacts") {
    return (state.artifacts ?? []).map((a) => {
      const v = a.view_row ?? {};
      const sandbox = formatPayloadFull(v.declared_sandbox);
      const codeBody = asString(v.body, "");
      const alpha = asNumber(v.posterior_alpha, 0);
      const beta = asNumber(v.posterior_beta, 0);
      const residualMean = asNumber(v.recent_residual_mean, 0);
      const killCount = asNumber(v.recent_kill_count, 0);
      const stateRoot = asString(v.state_root, "");
      const fixtureExp = asNumber(v.fixture_expected_residual, NaN);
      const createdAt = asString(v.created_at, "");
      const updatedAt = asString(v.updated_at, "");
      // Brain dataflow audit bxdhdkm9e #3 (2026-05-15): provenance columns
      // that previously didn't surface. Operator can now SEE the artifact's
      // intent, summary, target files, source candidate, owner gate.
      const intent = asString(v.intent, "");
      const summary = asString(v.summary, "");
      const targetFilesRaw = v.target_files;
      const targetFiles = (typeof targetFilesRaw === "string" && targetFilesRaw)
        ? (() => { try { return JSON.parse(targetFilesRaw) as string[]; } catch { return []; } })()
        : [];
      const targetResourcesRaw = v.target_resources;
      const targetResources = (typeof targetResourcesRaw === "string" && targetResourcesRaw)
        ? (() => { try { return JSON.parse(targetResourcesRaw) as string[]; } catch { return []; } })()
        : [];
      const sourceCandidate = asString(v.source_candidate_id, "");
      const ownerGate = asString(v.owner_gate_verdict, "");
      const rich = [
        `artifact_id=${a.id}`,
        `name=${a.name ?? ""}`,
        `runtime=${a.runtime}`,
        `score=${a.score.toFixed(3)}  alpha=${alpha.toFixed(2)}  beta=${beta.toFixed(2)}`,
        `confidence=${(a.confidence ?? 0).toFixed(3)}`,
        `status=${a.status}`,
        `recent_residual_mean=${Number.isFinite(residualMean) ? residualMean.toFixed(3) : "-"}  recent_kill_count=${killCount}`,
        `state_root=${stateRoot}`,
        Number.isFinite(fixtureExp) ? `fixture_expected_residual=${fixtureExp.toFixed(3)}` : "",
        createdAt ? `created_at=${createdAt}` : "",
        updatedAt ? `updated_at=${updatedAt}` : "",
        ownerGate ? `owner_gate_verdict=${ownerGate}` : "",
        sourceCandidate ? `source_candidate_id=${sourceCandidate}` : "",
        intent ? `\n--- intent ---\n${intent}` : "",
        summary ? `\n--- summary ---\n${summary}` : "",
        targetResources.length > 0 ? `\n--- target_resources ---\n${targetResources.join("\n")}` : "",
        targetResources.length > 0 ? `\n--- target_resources ---\n${targetResources.join("\n")}` : "",
        "",
        "--- declared_sandbox ---",
        sandbox,
        "",
        "--- body ---",
        codeBody || "(no body)",
      ].filter((s) => s !== "").join("\n");
      return {
        id: a.id,
        title: a.name ?? a.id,
        meta: `${a.runtime} score=${a.score.toFixed(2)} conf=${(a.confidence ?? 0).toFixed(2)} ${a.status}`,
        body: rich,
        score: a.score,
        status: a.status,
        raw: a,
      };
    });
  }
  if (view === "recipes") {
    return deriveRecipes(state).map((r) => {
      const v = r.view_row ?? {};
      const goalShape = asString(v.goal_shape, r.goal_shape ?? "");
      const topology = asString(v.topology_signature, "");
      const ts = asString(v.ts, "");
      const trajectory = formatPayloadFull(v.payload);
      const rich = [
        `recipe_id=${r.id}`,
        `name=${r.name}`,
        `confidence=${r.confidence.toFixed(3)}`,
        `status=${r.status ?? ""}`,
        `goal_shape=${goalShape}`,
        topology ? `topology_signature=${topology}` : "",
        ts ? `ts=${ts}` : "",
        "",
        "--- payload / trajectory ---",
        trajectory,
      ].filter((s) => s !== "").join("\n");
      return {
        id: r.id,
        title: r.name,
        meta: `confidence=${r.confidence.toFixed(2)} ${r.status ?? ""}`,
        body: rich,
        score: r.confidence,
        status: r.status,
        raw: r,
      };
    });
  }
  if (view === "lessons") {
    return deriveLessons(state).map((l) => {
      const v = l.view_row ?? {};
      const rich = [
        `id=${l.id}`,
        l.ts ? `ts=${l.ts}` : "",
        `kind=${l.kind}`,
        l.target ? `target=${l.target}` : "",
        "",
        l.summary,
        "",
        "--- substrate row ---",
        formatPayloadFull(v),
      ].filter((s) => s !== "").join("\n");
      return {
        id: l.id,
        title: l.summary,
        meta: `${l.kind} ${l.target ?? ""}`.trim(),
        body: rich,
        kind: l.kind,
        status: l.kind,
        raw: l,
      };
    });
  }
  if (view === "interventions") {
    // Use the dedicated supervisor buffer (populated by readKindBuffer
    // with SUPERVISOR_EVENT_KINDS). Falls back to scanning state.events
    // when the buffer hasn't loaded yet (e.g. very first frame after
    // boot) so the panel never goes silent during the half-second
    // before refreshAll completes.
    const source = (state.supervisorEvents && state.supervisorEvents.length > 0)
      ? state.supervisorEvents
      : (state.events ?? []).filter((e) => SUPERVISOR_EVENT_KINDS.includes(e.kind));
    // Newest-first; full payload (no trim).
    return [...source].reverse().map((e) => ({
      id: e.event_id,
      title: e.kind,
      meta: `${e.ts.slice(11, 19)} dir=${shortId(e.directive_id)} task=${shortId(e.task_id)}`,
      body: `event_id=${e.event_id}\nts=${e.ts}\nkind=${e.kind}\n\n${formatPayloadFull(e.payload)}`,
      kind: e.kind,
      status: e.kind,
      raw: e,
    }));
  }
  return deriveKnowledge(state).map((k) => {
    const v = k.view_row ?? {};
    const ts = asString(v.ts, "");
    const candidateId = asString(v.candidate_id, "");
    const directiveId = asString(v.directive_id, "");
    const tags = formatPayloadFull(v.tags);
    const refs = formatPayloadFull(v.context_refs);
    const rich = [
      `knowledge_id=${k.id}`,
      `score=${k.score.toFixed(3)}`,
      `confidence=${asNumber(v.confidence, 0).toFixed(3)}`,
      `status=${k.status ?? ""}`,
      `origin=${k.origin ?? ""}`,
      ts ? `ts=${ts}` : "",
      candidateId ? `candidate_id=${candidateId}` : "",
      directiveId ? `directive_id=${directiveId}` : "",
      "",
      k.text,
      "",
      tags !== "{}" && tags !== "" ? `--- tags ---\n${tags}` : "",
      refs !== "[]" && refs !== "" ? `--- context_refs ---\n${refs}` : "",
    ].filter((s) => s !== "").join("\n");
    return {
      id: k.id,
      title: k.text,
      meta: `score=${k.score.toFixed(2)} ${k.status ?? ""} ${k.origin ?? ""}`.trim(),
      body: rich,
      score: k.score,
      status: k.status,
      raw: k,
    };
  });
};

// Scoped filter grammar (brain audit bs00e26fx, 2026-05-15):
//   kind:foo        - match item.kind/status substring
//   directive:abc   - body must include directive_id=abc (substring)
//   task:abc        - body must include task_id=abc (substring)
//   edge:refines    - title must include edge prefix (refines/requires/blocks)
//   plain term      - full-text substring across id+title+meta+body
// Multiple space-separated terms are ANDed.
const matchesScopedFilter = (item: ListItem, rawQuery: string): boolean => {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const hay = `${item.id} ${item.title} ${item.meta} ${item.body}`.toLowerCase();
  return q.split(/\s+/).every((term) => {
    if (term.startsWith("kind:")) return (item.kind ?? item.status ?? "").toLowerCase().includes(term.slice(5));
    if (term.startsWith("directive:")) return item.body.toLowerCase().includes(`directive_id=${term.slice(10)}`) || hay.includes(term.slice(10));
    if (term.startsWith("task:")) return item.body.toLowerCase().includes(`task_id=${term.slice(5)}`) || hay.includes(term.slice(5));
    if (term.startsWith("edge:")) return item.title.toLowerCase().includes(term.slice(5));
    return hay.includes(term);
  });
};

const filteredItems = (state: WatchState, view: ViewKey): ListItem[] => {
  return itemsForView(state, view).filter((item) => matchesScopedFilter(item, state.filter ?? ""));
};

const wrapLines = (text: string, width: number, maxLines: number): string[] => {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw;
    if (line.length === 0) { out.push(""); continue; }
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
      if (out.length >= maxLines) return out;
    }
    out.push(line);
    if (out.length >= maxLines) return out;
  }
  return out;
};

const healthLabel = (h: DaemonHealth): string => {
  if (h.status) return h.status;
  if (h.pid || h.ok) return "ALIVE";
  return "UNKNOWN";
};

export const renderPanelLines = (state: WatchState, view: ViewKey, cols: number): string[] => {
  const w = Math.max(40, cols);
  const lines: string[] = [];
  const H = (s: string) => `${BOLD}${s}${RESET}`;
  if (view === "trust") {
    const t = state.trust;
    if (!t) return ["(no trust metrics yet - daemon DB unreachable or empty)"];
    const cr = t.closure_residual_7d, am = t.amendments_7d;
    lines.push(`${H("autonomy_score")}: ${t.autonomy_score.toFixed(2)}`, "");
    lines.push(`${H("recipes")}  extracted=${t.recipes_extracted}  replayed_success=${t.recipes_replayed_success}  replayed_aborted=${t.recipes_replayed_aborted}`);
    lines.push(`${H("knowledge (7d)")}  promoted=${t.knowledge_promoted_7d}  demoted=${t.knowledge_demoted_7d}`);
    lines.push(`${H("closure_residual (7d)")}  avg=${cr.avg.toFixed(3)}  min=${cr.min.toFixed(3)}  max=${cr.max.toFixed(3)}  n=${cr.count}`);
    lines.push(`${H("amendments (7d)")}  applied=${am.applied}  failed=${am.failed}  refused=${am.refused}`, "", H("recent artifact promotions"));
    if (t.artifacts_promoted_recent.length === 0) lines.push("  (none)");
    for (const a of t.artifacts_promoted_recent) lines.push(`  ${a.ts.slice(0, 19)}  ${a.artifact_id.slice(0, 24).padEnd(24)}  ${truncate(a.summary, w - 50)}`);
    lines.push("", `${H("recommendation")}: ${t.recommendation}`);
    return lines;
  }
  if (view === "decisions") {
    const d = state.decisions ?? [];
    lines.push(`${H("Pending owner decisions")}  (${d.length})  sorted by age DESC`, "");
    if (d.length === 0) { lines.push("  (no pending owner_input_required / hidl_action_required / owner-gated amendments)"); return lines; }
    lines.push(`  ${"id".padEnd(9)}  ${"kind".padEnd(28)}  ${"target".padEnd(34)}  ${"anchor".padEnd(30)}  age`);
    for (const r of d) lines.push(`  ${shortId(r.event_id, 8).padEnd(9)}  ${YELLOW}${r.kind.slice(0, 28).padEnd(28)}${RESET}  ${r.target.slice(0, 34).padEnd(34)}  ${DIM}${r.anchor.slice(0, 30).padEnd(30)}${RESET}  ${formatAge(r.age_ms)}`);
    return lines;
  }
  if (view === "health") {
    const h = state.health ?? {}; const hr = h.hotreload ?? null;
    lines.push(`${H("Daemon health")}  ${healthLabel(h)}`);
    lines.push(`  pid=${h.pid ?? "?"}  uptime_ms=${h.uptime_ms ?? 0}  events_count=${h.events_count ?? 0}  mcp_port=${h.mcp_port ?? "?"}  aux_port=${h.aux_port ?? "?"}`);
    if (h.stuck_workers && h.stuck_workers.length > 0) {
      lines.push("", `${H("stuck workers")}  (${h.stuck_workers.length})`);
      for (const s of h.stuck_workers) lines.push(`  ${RED}${s.worker}${RESET}  last_tick_ms_ago=${s.last_tick_ms_ago ?? "?"}`);
    }
    lines.push("", H("hotreload"));
    if (!hr) lines.push("  (no hotreload state in /health payload)");
    else {
      lines.push(`  watched=${hr.watched_module_count ?? 0}  reload_total=${hr.reload_total ?? 0}  failure_total=${hr.failure_total ?? 0}  last_module=${hr.last_reload_module ?? "(none)"}`);
      if (hr.last_failure) {
        lines.push(`  ${RED}last_failure${RESET}  ts=${hr.last_failure.ts}  module=${hr.last_failure.module}`);
        lines.push(`               reason=${truncate(hr.last_failure.reason, w - 22)}`);
      } else lines.push(`  last_failure=(none)`);
    }
    if (typeof h.activation_listener_count === "number" || typeof h.brain_failed_recent_count === "number") {
      lines.push("", H("organism pulse"));
      if (typeof h.activation_listener_count === "number") lines.push(`  activation_listeners=${h.activation_listener_count}`);
      if (typeof h.pathology_budget_debited_recent_count === "number") lines.push(`  pathology_debits=${h.pathology_budget_debited_recent_count}  exhausted=${h.pathology_budget_exhausted_recent_count ?? 0}`);
      if (typeof h.brain_failed_recent_count === "number") lines.push(`  brain_failed_recent=${h.brain_failed_recent_count}`);
    }
    return lines;
  }
  // view === "drift"
  const rows = state.drift ?? [];
  lines.push(`${H("Verify drift")}  (${rows.length} directives)  sorted by drift+missing DESC`, "");
  if (rows.length === 0) { lines.push("  (no recent directives - empty ledger?)"); return lines; }
  lines.push(`  ${"directive".padEnd(9)}  ${"status".padEnd(11)}  ${"appl".padEnd(4)}  ${"fail".padEnd(4)}  ${"refu".padEnd(4)}  ${"stra".padEnd(4)}  ${"drift".padEnd(5)}  ${"miss".padEnd(4)}`);
  for (const r of rows) {
    const color = (r.drift + r.missing) > 0 ? RED : r.status === "committed" ? GREEN : r.status === "failed" ? RED : WHITE;
    lines.push(`  ${color}${shortId(r.directive_id, 8).padEnd(9)}${RESET}  ${r.status.padEnd(11)}  ${String(r.applied).padEnd(4)}  ${String(r.failed).padEnd(4)}  ${String(r.refused).padEnd(4)}  ${String(r.stranded).padEnd(4)}  ${String(r.drift).padEnd(5)}  ${String(r.missing).padEnd(4)}`);
  }
  return lines;
};

const renderPanelFrame = (state: WatchState, cols: number, rows: number, view: ViewKey): string => {
  const safeCols = Math.max(60, cols);
  const safeRows = Math.max(20, rows);
  const parts: string[] = [CLEAR_SCREEN, HOME, moveTo(1, 1),
    `${BOLD}${CYAN}acc watch - operator dashboard${RESET} ${DIM}t trust  d decisions  h health  v drift  1-8 lists  ? help  r refresh  q quit${RESET}`,
    moveTo(2, 1)];
  const tabs: Array<[ViewKey, string]> = [["trust", "t:Trust"], ["decisions", "d:Decisions"], ["health", "h:Health"], ["drift", "v:Drift"]];
  let col = 1;
  for (const [k, label] of tabs) {
    parts.push(moveTo(2, col), k === view ? `${INVERT}${label}${RESET}` : `${DIM}${label}${RESET}`);
    col += label.length + 2;
  }
  const lines = renderPanelLines(state, view, safeCols);
  const bodyRows = safeRows - 5;
  for (let i = 0; i < bodyRows; i++) { parts.push(moveTo(4 + i, 1), pad(lines[i] ?? "", safeCols)); }
  const h = state.health ?? {};
  const decisionsN = (state.decisions ?? []).length;
  const driftN = (state.drift ?? []).reduce((acc, r) => acc + r.drift + r.missing, 0);
  const trustWord = firstWord(state.trust?.recommendation ?? "-");
  parts.push(moveTo(safeRows - 1, 1), `${BOLD}Status${RESET} daemon=${healthLabel(h)} events=${h.events_count ?? state.events.length} decisions=${decisionsN} drift=${driftN} trust=${trustWord}`);
  parts.push(moveTo(safeRows, 1), truncate(`Daemon pid=${h.pid ?? "?"} uptime_ms=${h.uptime_ms ?? 0} mcp=${h.mcp_port ?? "?"} aux=${h.aux_port ?? "?"}`, safeCols));
  return parts.join("");
};

export const renderFrame = (state: WatchState, cols: number, rows: number): string => {
  const safeCols = Math.max(60, cols);
  const safeRows = Math.max(20, rows);
  const view = state.view ?? "dag";
  // Operator-dashboard panels render as a single full-pane text block.
  if (PANEL_VIEWS.has(view)) return renderPanelFrame(state, safeCols, safeRows, view);
  const items = filteredItems(state, view);
  const selectedMap = state.selected ?? {};
  // Newest-first ordering: items[0] is the most recent row across every view,
  // so the default selection is always the top of the list.
  const selected = clamp(selectedMap[view] ?? 0, 0, Math.max(0, items.length - 1));
  const detail = items[selected];

  // Full-screen detail viewer (Enter to enter, Esc/Enter to exit). Renders
  // the entire body of the selected row with whitespace preserved and no
  // truncation - operator can read every byte of any event payload.
  if (state.expanded && detail) {
    const ePartsViewer = [CLEAR_SCREEN, HOME];
    ePartsViewer.push(moveTo(1, 1));
    ePartsViewer.push(`${BOLD}${CYAN}acc watch - full payload${RESET} ${DIM}j/k scroll  Enter/Esc back  q quit${RESET}`);
    ePartsViewer.push(moveTo(2, 1));
    ePartsViewer.push(`${BOLD}${labelForView(view)}${RESET} ${DIM}${shortId(detail.id, 24)} ${detail.title}${RESET}`);
    const viewerRows = safeRows - 3;
    const lines = wrapLines(detail.body, safeCols, Number.MAX_SAFE_INTEGER);
    const scrollY = clamp(state.detailScrollY ?? 0, 0, Math.max(0, lines.length - viewerRows));
    for (let i = 0; i < viewerRows; i++) {
      ePartsViewer.push(moveTo(4 + i, 1));
      ePartsViewer.push(pad(lines[scrollY + i] ?? "", safeCols));
    }
    ePartsViewer.push(moveTo(safeRows, 1));
    ePartsViewer.push(`${DIM}line ${Math.min(scrollY + 1, lines.length)}/${lines.length}${RESET}`);
    return ePartsViewer.join("");
  }

  const listWidth = Math.max(34, Math.floor(safeCols * 0.48));
  const detailWidth = safeCols - listWidth - 3;
  const brainFlight = findBrainInFlight(state);
  // When a brain dispatch is in flight, reserve 2 rows above the status
  // footer for the BRAIN panel so the operator sees what's running right
  // now without leaving the view.
  const brainPanelRows = brainFlight ? 2 : 0;
  const listRows = safeRows - 6 - brainPanelRows;
  const start = clamp(selected - Math.floor(listRows / 2), 0, Math.max(0, items.length - listRows));
  const parts: string[] = [CLEAR_SCREEN, HOME];

  parts.push(moveTo(1, 1));
  parts.push(`${BOLD}${CYAN}acc watch${RESET} ${DIM}substrate live: what decided, what is ready, what needs owner input  1-8 tabs  j/k move  Enter detail  / filter  ? keys  r refresh  q quit${RESET}`);

  parts.push(moveTo(2, 1));
  let col = 1;
  for (let i = 0; i < VIEWS.length; i++) {
    const v = VIEWS[i]!;
    const text = `${i + 1}:${v.label}`;
    const styled = v.key === view ? `${INVERT}${text}${RESET}` : `${DIM}${text}${RESET}`;
    parts.push(moveTo(2, col));
    parts.push(styled);
    col += text.length + 2;
    if (col > safeCols - 10) break;
  }

  parts.push(moveTo(4, 1));
  const sectionLabel = view === "dag" ? "Task DAG" : labelForView(view);
  const sectionSub = view === "dag" ? "directives → tasks → structural events" : "";
  parts.push(`${BOLD}${sectionLabel}${RESET} ${DIM}(${items.length})${sectionSub ? ` ${sectionSub}` : ""}${RESET}`);
  parts.push(moveTo(4, listWidth + 3));
  parts.push(`${BOLD}Detail${RESET} ${DIM}${detail ? shortId(detail.id, 18) : "no selection"}${RESET}`);

  for (let i = 0; i < listRows; i++) {
    const row = 5 + i;
    const item = items[start + i];
    parts.push(moveTo(row, 1));
    if (!item) {
      parts.push(pad("", listWidth));
      continue;
    }
    const marker = start + i === selected ? ">" : " ";
    const color = item.kind ? eventColor(item.kind) : statusColor(item.status, item.score);
    const id = shortId(item.id, 9).padEnd(9);
    const titleWidth = Math.max(8, listWidth - 31);
    const line = `${marker} ${color}${id}${RESET} ${truncate(item.title, titleWidth)} ${DIM}${truncate(item.meta, 16)}${RESET}`;
    parts.push(pad(line, listWidth));
  }

  const detailLines = detail
    ? wrapLines(detail.body, detailWidth, listRows)
    : [`No ${labelForView(view).toLowerCase()} rows match the current filter.`];
  for (let i = 0; i < listRows; i++) {
    parts.push(moveTo(5 + i, listWidth + 3));
    parts.push(pad(detailLines[i] ?? "", detailWidth));
  }

  if (state.showHelp) {
    const helpTop = Math.max(6, Math.floor(safeRows / 2) - 4);
    const helpLeft = Math.max(2, Math.floor(safeCols / 2) - 28);
    const help = [
      "Help",
      "1-8 or Tab: switch list views",
      "t: trust panel  d: decisions  h: health  v: verify drift",
      "j/k or arrows: move selection",
      "Enter: keep focus on selected detail",
      "/: type live filter, Esc clears filter mode",
      "r: refresh substrate snapshots, q: quit",
    ];
    for (let i = 0; i < help.length; i++) {
      parts.push(moveTo(helpTop + i, helpLeft));
      parts.push(`${INVERT}${pad(help[i]!, 56)}${RESET}`);
    }
  }

  // Brain in-flight panel: 2 rows above the status footer. Row 1 shows
  // task + directive + elapsed; row 2 shows the latest narrative kind +
  // text (truncated to the line width). Reuses the YELLOW colour so
  // "active brain" is visible at a glance.
  if (brainFlight) {
    const elapsedS = (brainFlight.elapsed_ms / 1000).toFixed(0);
    const head = `${BOLD}${YELLOW}BRAIN ⚡${RESET} ${DIM}task=${shortId(brainFlight.task_id, 12)} dir=${shortId(brainFlight.directive_id, 10)} elapsed=${elapsedS}s${RESET} intent=${truncate(brainFlight.intent, Math.max(20, safeCols - 60))}`;
    const tail = `  ${DIM}${brainFlight.latest_kind}${RESET}: ${truncate(brainFlight.latest_text, safeCols - brainFlight.latest_kind.length - 4)}`;
    parts.push(moveTo(safeRows - 3, 1));
    parts.push(truncate(head, safeCols));
    parts.push(moveTo(safeRows - 2, 1));
    parts.push(truncate(tail, safeCols));
  }

  const statusRow = safeRows - 1;
  const h = state.health ?? {};
  const filter = state.filter ? `/${state.filter}` : "none";
  parts.push(moveTo(statusRow, 1));
  const decisionsN = (state.decisions ?? []).length;
  const driftN = (state.drift ?? []).reduce((acc, r) => acc + r.drift + r.missing, 0);
  const trustWord = firstWord(state.trust?.recommendation ?? "-");
  parts.push(`${BOLD}Status${RESET} view=${labelForView(view)} items=${items.length} selected=${items.length ? selected + 1 : 0} filter=${filter} daemon=${healthLabel(h)} decisions=${decisionsN} drift=${driftN} trust=${trustWord}`);
  parts.push(moveTo(statusRow + 1, 1));
  // Brain TUI rewrite axis F (2026-05-15): always-visible organism pulse.
  // /health now surfaces activation listeners, pathology counts,
  // brain-failure rate, hotreload state - render them on the footer so
  // operators see the substrate's vitals without leaving the view.
  const stuckSummary = (h.stuck_workers && h.stuck_workers.length > 0)
    ? ` stuck=${h.stuck_workers.length}`
    : "";
  const pulseFragments: string[] = [];
  if (typeof h.activation_listener_count === "number") pulseFragments.push(`act=${h.activation_listener_count}`);
  if (typeof h.pathology_budget_exhausted_recent_count === "number" && h.pathology_budget_exhausted_recent_count > 0) {
    pulseFragments.push(`pathology=${h.pathology_budget_exhausted_recent_count}/${h.pathology_budget_debited_recent_count ?? 0}`);
  } else if (typeof h.pathology_budget_debited_recent_count === "number" && h.pathology_budget_debited_recent_count > 0) {
    pulseFragments.push(`debits=${h.pathology_budget_debited_recent_count}`);
  }
  if (typeof h.brain_failed_recent_count === "number" && h.brain_failed_recent_count > 0) {
    pulseFragments.push(`brain_failed=${h.brain_failed_recent_count}`);
  }
  if (h.hotreload && typeof h.hotreload.reload_total === "number" && h.hotreload.reload_total > 0) {
    pulseFragments.push(`reloads=${h.hotreload.reload_total}/${h.hotreload.failure_total ?? 0}`);
  } else if (h.hotreload && typeof h.hotreload.watched_module_count === "number") {
    pulseFragments.push(`watched=${h.hotreload.watched_module_count}`);
  }
  const pulse = pulseFragments.length > 0 ? ` ${pulseFragments.join(" ")}` : "";
  const healthLine = `Daemon pid=${h.pid ?? "?"} uptime_ms=${h.uptime_ms ?? 0} events=${h.events_count ?? state.events.length} mcp=${h.mcp_port ?? "?"} aux=${h.aux_port ?? "?"}${stuckSummary}${pulse}`;
  parts.push(truncate(healthLine, safeCols));

  return parts.join("");
};

export type RunWatchOpts = {
  durationMs?: number;
  writer?: (s: string) => void;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  disableSse?: boolean;
};

// Panel refresh cadences (trust+drift are heavy, decisions is light).
const refreshPanels = (state: WatchState, force = false): void => {
  const db = panelDb();
  if (!db) return;
  const now = Date.now();
  const due = (last?: number, ms = 30_000) => force || !last || now - last > ms;
  if (due(state.trust_refreshed_ms, 30_000)) {
    try { state.trust = gatherTrustMetrics(db); state.trust_refreshed_ms = now; } catch { /* keep stale */ }
  }
  if (due(state.decisions_refreshed_ms, 5_000)) {
    try { state.decisions = readPendingDecisions(db, now); state.decisions_refreshed_ms = now; } catch { /* keep stale */ }
  }
  if (due(state.drift_refreshed_ms, 30_000)) {
    try { state.drift = readDriftSummaries(db, resolvePath(process.cwd()), 10); state.drift_refreshed_ms = now; } catch { /* keep stale */ }
  }
};

const refreshAll = async (state: WatchState): Promise<void> => {
  const [active, ready, artifacts, recipes, knowledge, health, events, lessonEvents, supervisorEvents] = await Promise.all([
    readActiveDirectives(),
    readReadyTasks(),
    readArtifactLeaderboard(),
    readRecipes(),
    readKnowledge(),
    readHealth(),
    state.events.length === 0 ? readRecentEvents() : Promise.resolve(state.events),
    readKindBuffer(LESSON_EVENT_KINDS),
    readKindBuffer(SUPERVISOR_EVENT_KINDS),
  ]);
  state.active = active;
  state.ready = ready;
  state.artifacts = artifacts;
  state.recipes = recipes;
  state.knowledge = knowledge;
  state.events = events;
  state.lessonEvents = lessonEvents;
  state.supervisorEvents = supervisorEvents;
  state.lessons = deriveLessons(state);
  state.health = health;
  refreshPanels(state, true);
};

const refreshSnapshots = async (state: WatchState): Promise<void> => {
  const [active, ready, artifacts, recipes, knowledge, health, lessonEvents, supervisorEvents] = await Promise.all([
    readActiveDirectives(),
    readReadyTasks(),
    readArtifactLeaderboard(),
    readRecipes(),
    readKnowledge(),
    readHealth(),
    readKindBuffer(LESSON_EVENT_KINDS),
    readKindBuffer(SUPERVISOR_EVENT_KINDS),
  ]);
  state.active = active;
  state.ready = ready;
  state.artifacts = artifacts;
  state.recipes = recipes;
  state.knowledge = knowledge;
  state.lessonEvents = lessonEvents;
  state.supervisorEvents = supervisorEvents;
  state.lessons = deriveLessons(state);
  state.health = health;
  refreshPanels(state);
};

const appendEvent = (state: WatchState, ev: SseEvent): void => {
  state.events.push({
    event_id: ev.event_id,
    ts: ev.ts,
    kind: ev.kind,
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    payload: ev.payload,
  });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  // Anchor the cursor on the row the user was reading. Events render
  // newest-first, so each arrival inserts a new row at items[0] and
  // shifts every following row down by one. If the user has scrolled
  // (selected > 0), bump selected by 1 to keep them on the same event.
  // Selected==0 means "follow the live tail" - leave it alone so the
  // top of the list always shows the newest arrival.
  const view = state.view ?? "dag";
  if ((view === "dag" || view === "events" || view === "interventions")) {
    const sel = state.selected?.[view] ?? 0;
    if (sel > 0) {
      state.selected = { ...(state.selected ?? {}), [view]: Math.min(sel + 1, MAX_EVENTS - 1) };
    }
  }
  state.lessons = deriveLessons(state);
};

const screenDims = (): { cols: number; rows: number } => ({
  cols: (process.stdout as { columns?: number }).columns ?? 120,
  rows: (process.stdout as { rows?: number }).rows ?? 40,
});

const nextView = (view: ViewKey): ViewKey => VIEWS[(VIEWS.findIndex((v) => v.key === view) + 1) % VIEWS.length]!.key;

export const runWatch = async (argv: string[], opts: RunWatchOpts = {}): Promise<number> => {
  void argv;
  const writer = opts.writer ?? ((s: string) => { process.stdout.write(s); });
  const pollMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const state = emptyState();
  const isInteractive = !opts.writer && !!process.stdout.isTTY;
  let filtering = false;

  await refreshAll(state);
  if (isInteractive) writer(ALT_ENTER + HIDE_CURSOR);
  writer(renderFrame(state, screenDims().cols, screenDims().rows));

  const sseAbort = new AbortController();
  const onAbort = () => sseAbort.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const renderTick = (): void => writer(renderFrame(state, screenDims().cols, screenDims().rows));
  const adjustSelection = (delta: number): void => {
    const view = state.view ?? "dag";
    const count = filteredItems(state, view).length;
    const selected = state.selected ?? {};
    selected[view] = clamp((selected[view] ?? 0) + delta, 0, Math.max(0, count - 1));
    state.selected = selected;
  };
  const setView = (view: ViewKey): void => {
    state.view = view;
    const selected = state.selected ?? {};
    selected[view] = clamp(selected[view] ?? 0, 0, Math.max(0, filteredItems(state, view).length - 1));
    state.selected = selected;
  };

  const ssePromise = (async () => {
    if (opts.disableSse) return;
    try {
      for await (const ev of sseConnect({ signal: sseAbort.signal })) {
        appendEvent(state, ev);
        renderTick();
      }
    } catch { /* disconnects are non-fatal for the TUI */ }
  })();

  const pollTimer = setInterval(() => {
    void refreshSnapshots(state).then(renderTick).catch(() => { /* keep stale data */ });
  }, pollMs);

  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (b: boolean) => void };
  const wasRaw = stdin.isRaw;
  const keyResolver: { resolve: ((v: void) => void) | null } = { resolve: null };
  const keyPromise = new Promise<void>((resolve) => { keyResolver.resolve = resolve; });
  let keyHandler: ((chunk: Buffer | string) => void) | null = null;

  if (isInteractive && typeof stdin.setRawMode === "function") {
    stdin.setRawMode(true);
    stdin.resume();
    keyHandler = (chunk: Buffer | string) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (str === "\u0003" || (!filtering && (str === "q" || str === "Q"))) { keyResolver.resolve?.(); return; }
      if (filtering) {
        if (str === "\r" || str === "\n" || str === "\x1b") filtering = false;
        else if (str === "\x7f") state.filter = (state.filter ?? "").slice(0, -1);
        else if (/^[ -~]$/.test(str)) state.filter = `${state.filter ?? ""}${str}`;
        renderTick();
        return;
      }
      // Esc: exit expanded mode first; otherwise close the help overlay.
      if (str === "\x1b") {
        if (state.expanded) { state.expanded = false; state.detailScrollY = 0; renderTick(); return; }
        if (state.showHelp) { state.showHelp = false; renderTick(); return; }
        return;
      }
      // Enter: toggle the full-screen detail viewer. Inside it Enter exits.
      if (str === "\r" || str === "\n") {
        state.expanded = !state.expanded;
        if (!state.expanded) state.detailScrollY = 0;
        renderTick();
        return;
      }
      // j/k inside the expanded viewer scroll within the body; outside, they
      // move the list cursor.
      if (str === "j" || str === "J" || str === "\x1b[B") {
        if (state.expanded) { state.detailScrollY = (state.detailScrollY ?? 0) + 1; }
        else { adjustSelection(1); }
        renderTick();
        return;
      }
      if (str === "k" || str === "K" || str === "\x1b[A") {
        if (state.expanded) { state.detailScrollY = Math.max(0, (state.detailScrollY ?? 0) - 1); }
        else { adjustSelection(-1); }
        renderTick();
        return;
      }
      if (str === "/") { filtering = true; state.filter = ""; renderTick(); return; }
      if (str === "?") { state.showHelp = !state.showHelp; renderTick(); return; }
      if (str === "\t") { setView(nextView(state.view ?? "dag")); renderTick(); return; }
      if (/^[1-8]$/.test(str)) { setView(VIEWS[Number(str) - 1]!.key); renderTick(); return; }
      // Operator-dashboard panel shortcuts (brain audit V7FBAW...): t/d/h/v.
      if (str === "t" || str === "d" || str === "h" || str === "v") {
        const map: Record<string, ViewKey> = { t: "trust", d: "decisions", h: "health", v: "drift" };
        refreshPanels(state, true); setView(map[str]!); renderTick(); return;
      }
      if (str === "r" || str === "R") { void refreshAll(state).then(renderTick).catch(() => { /* stale is better than blank */ }); return; }
    };
    stdin.on("data", keyHandler);
  }

  const durationPromise = opts.durationMs
    ? new Promise<void>((resolve) => { setTimeout(resolve, opts.durationMs); })
    : new Promise<void>(() => { /* never */ });
  const signalPromise = new Promise<void>((resolve) => {
    if (opts.signal?.aborted) { resolve(); return; }
    opts.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  const sigintHandler = (): void => { keyResolver.resolve?.(); };
  if (isInteractive) process.once("SIGINT", sigintHandler);

  try {
    await Promise.race([keyPromise, durationPromise, signalPromise]);
  } finally {
    clearInterval(pollTimer);
    sseAbort.abort();
    if (keyHandler) stdin.off("data", keyHandler);
    if (isInteractive && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(!!wasRaw);
      stdin.pause();
    }
    if (isInteractive) {
      writer(SHOW_CURSOR + ALT_EXIT + RESET);
      try { process.off("SIGINT", sigintHandler); } catch { /* ignore */ }
    }
    opts.signal?.removeEventListener("abort", onAbort);
    try { await ssePromise; } catch { /* ignore */ }
  }
  return 0;
};

if (import.meta.main) {
  void runWatch(process.argv.slice(2)).then((code) => process.exit(code));
}
