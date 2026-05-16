#!/usr/bin/env bun
// `acc watch` - six-pane operator TUI for AccInt v2.
// Public test surface: keep runWatch(argv, opts?), renderFrame(state, columns, rows),
// renderPanelLines(state, pane, cols), readPendingDecisions, and readDriftSummaries stable.

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
const CYAN = `${CSI}36m`;
const INVERT = `${CSI}7m`;

const moveTo = (row: number, col: number): string => `${CSI}${row};${col}H`;

type JsonRecord = Record<string, unknown>;

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

type ArtifactRow = {
  id: string;
  runtime: string;
  score: number;
  status: string;
  name: string | null;
  confidence?: number;
  view_row?: JsonRecord;
};

type KnowledgeRow = {
  id: string;
  text: string;
  score: number;
  status?: string;
  origin?: string;
  view_row?: JsonRecord;
};

type EventRow = {
  event_id: string;
  ts: string;
  kind: string;
  directive_id?: string;
  task_id?: string;
  payload?: unknown;
};

type DaemonHealth = {
  pid?: number;
  uptime_ms?: number;
  events_count?: number;
  mcp_port?: number;
  aux_port?: number;
  ok?: boolean;
  status?: string;
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

type OwnerProfile = {
  rendering_signals: Record<string, number>;
  preferred_terms: string[];
  avoided_terms: string[];
  detected_language?: { language?: string; confidence?: number };
  observation_count?: number;
};

type GraphRow = {
  event_id: string;
  ts: string;
  directive_id?: string;
  task_id?: string;
  parent_task_id?: string;
  row_kind: string;
  payload?: unknown;
};

export type ViewKey = "now" | "decisions" | "graph" | "evidence" | "health" | "diagnostics";

export type PendingDecision = { event_id: string; kind: string; target: string; anchor: string; age_ms: number };
export type DriftSummary = { directive_id: string; status: string; applied: number; failed: number; refused: number; stranded: number; drift: number; missing: number };

export type WatchState = {
  events: EventRow[];
  active: ActiveDirective[];
  ready: ReadyTask[];
  artifacts: ArtifactRow[];
  knowledge?: KnowledgeRow[];
  graphRows?: GraphRow[];
  directiveStatus?: JsonRecord[];
  rollingReviews?: JsonRecord[];
  stakeholders?: JsonRecord[];
  ownerProfile?: OwnerProfile;
  decisions?: PendingDecision[];
  trust?: TrustMetrics | null;
  drift?: DriftSummary[];
  health: DaemonHealth;
  focus?: ViewKey;
  filter?: string;
  showHelp?: boolean;
  selected?: Partial<Record<ViewKey, number>>;
  trust_refreshed_ms?: number;
  decisions_refreshed_ms?: number;
  drift_refreshed_ms?: number;
};

export type RunWatchOpts = {
  durationMs?: number;
  writer?: (s: string) => void;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  disableSse?: boolean;
};

const MAX_EVENTS = 300;
const MAX_INITIAL_EVENTS = 160;
const POLL_INTERVAL_MS = 2000;
const VIEWS: Array<{ key: ViewKey; label: string; hotkey: string }> = [
  { key: "now", label: "Now", hotkey: "1" },
  { key: "decisions", label: "Decisions", hotkey: "2" },
  { key: "graph", label: "Work Graph", hotkey: "3" },
  { key: "evidence", label: "Evidence", hotkey: "4" },
  { key: "health", label: "Health", hotkey: "5" },
  { key: "diagnostics", label: "Diagnostics", hotkey: "6" },
];

const NARRATIVE_KINDS = new Set([
  "directive_opened",
  "directive_amended",
  "task_node_opened",
  "task_edge_recorded",
  "action_predicted",
  "action_scored",
  "task_closure_audited",
  "task_committed",
  "task_failed",
  "task_abandoned",
  "knowledge_candidate",
  "knowledge_promoted",
  "knowledge_synthesized",
  "lesson_extracted",
  "contract_amendment_proposed",
  "owner_input_required",
  "hidl_action_required",
  "owner_decision_recorded",
  "dispatcher_violation",
  "bridge_failed",
  "auto_apply_signaled",
  "applied_change_committed",
  "applied_change_failed",
  "supervisor_intervention_recorded",
  "bridge_health_degraded",
  "bridge_health_recovered",
  "irreversible_effect_recorded",
  "pathology_budget_debited",
  "pathology_budget_exhausted",
]);

const DIAGNOSTIC_KINDS = [
  "dispatcher_violation",
  "bridge_failed",
  "bridge_stuck",
  "bridge_health_degraded",
  "bridge_health_recovered",
  "supervisor_intervention_recorded",
  "applied_change_failed",
  "irreversible_effect_recorded",
  "pathology_budget_debited",
  "pathology_budget_exhausted",
  "worker_tick_overrun",
  "daemon_hotreload_failed",
];

const emptyState = (): WatchState => ({
  events: [],
  active: [],
  ready: [],
  artifacts: [],
  knowledge: [],
  graphRows: [],
  directiveStatus: [],
  rollingReviews: [],
  stakeholders: [],
  decisions: [],
  drift: [],
  health: {},
  focus: "now",
  filter: "",
  selected: {},
});

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const visibleLength = (s: string): number => stripAnsi(s).length;
const shortId = (s: string | undefined, n = 10): string => s ? s.slice(0, n) : "-";
const asString = (v: unknown, fallback = ""): string => typeof v === "string" ? v : fallback;
const asNumber = (v: unknown, fallback = 0): number => typeof v === "number" && Number.isFinite(v) ? v : fallback;
const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

const truncate = (s: string, max: number): string => {
  if (max <= 0) return "";
  const plain = stripAnsi(String(s));
  if (plain.length <= max) return s;
  return plain.slice(0, Math.max(0, max - 3)) + "...";
};

const pad = (s: string, width: number): string => {
  const clipped = truncate(s, width);
  return clipped + " ".repeat(Math.max(0, width - visibleLength(clipped)));
};

const asObject = (v: unknown): JsonRecord => {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as JsonRecord;
  if (typeof v === "string" && v.length > 0 && (v[0] === "{" || v[0] === "[")) {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonRecord;
    } catch { /* opaque string */ }
  }
  return {};
};

const payloadText = (payload: unknown, max = 120): string => {
  if (payload === null || payload === undefined) return "";
  try {
    const s = typeof payload === "string" ? payload : JSON.stringify(payload);
    return truncate(s.replace(/\s+/g, " "), max);
  } catch { return String(payload); }
};

const formatAge = (ms: number): string =>
  ms < 60_000 ? `${Math.floor(ms / 1000)}s`
  : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m`
  : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h`
  : `${Math.floor(ms / 86_400_000)}d`;

const healthLabel = (h: DaemonHealth): string => {
  if (h.status) return h.status;
  if (h.pid || h.ok) return "ALIVE";
  return "UNKNOWN";
};

const signalValue = (profile: OwnerProfile | undefined, key: string, fallback = 0): number => {
  const n = profile?.rendering_signals?.[key];
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};

const technicalMode = (state: WatchState): boolean => {
  const p = state.ownerProfile;
  return signalValue(p, "code_density", 0.5) >= 0.65 || signalValue(p, "ops_vocabulary", 0.5) >= 0.65;
};

const row = (label: string, value: string, cols: number): string => `${DIM}${pad(label, 15)}${RESET}${truncate(value, Math.max(5, cols - 15))}`;

const readGenericView = async (view_name: string, args?: JsonRecord): Promise<JsonRecord[]> => {
  try {
    const env = await mcpCall("substrate.read", { view_name, ...(args ? { args } : {}) });
    if (!env.ok || !Array.isArray(env.result)) return [];
    return env.result as JsonRecord[];
  } catch { return []; }
};

const readActiveDirectives = async (): Promise<ActiveDirective[]> => {
  const rows = await readGenericView("active_objectives_view");
  return rows.slice(0, 60).map((r) => {
    const p = asObject(r.payload);
    return {
      directive_id: asString(r.directive_id, asString(r.id, "unknown")),
      opened_ts: asString(r.opened_ts, asString(r.ts, "")),
      text: asString(p.text, asString(p.directive_text, asString(p.goal, "(no directive text)"))),
      lifecycle: asString(p.lifecycle, asString(r.lifecycle, "finite")),
      status: asString(r.status, asString(p.status, "active")),
      urgency: asString(p.urgency, asString(r.urgency, "normal")),
    };
  });
};

const readReadyTasks = async (): Promise<ReadyTask[]> => {
  const rows = await readGenericView("ready_tasks_view", { limit: 120 });
  return rows.slice(0, 120).map((r) => {
    const p = asObject(r.payload);
    return {
      task_id: asString(r.task_id, asString(r.id, "unknown")),
      directive_id: asString(r.directive_id, ""),
      goal: asString(p.goal, asString(r.goal, "(no goal)")),
      status: asString(r.status, asString(p.status, "ready")),
      depth: asNumber(r.depth, asNumber(p.depth, 0)),
    };
  });
};

const readArtifacts = async (): Promise<ArtifactRow[]> => {
  const rows = await readGenericView("code_artifact_registry_view");
  return rows.slice(0, 80).map((r) => ({
    id: asString(r.id, asString(r.artifact_id, "unknown")),
    runtime: asString(r.runtime, "?"),
    score: asNumber(r.score, asNumber(r.posterior, 0)),
    status: asString(r.status, "unknown"),
    name: asString(r.name, "") || null,
    confidence: asNumber(r.confidence, 0),
    view_row: r,
  }));
};

const readKnowledge = async (): Promise<KnowledgeRow[]> => {
  const rows = await readGenericView("promoted_knowledge_view");
  return rows.slice(0, 100).map((r) => ({
    id: asString(r.id, asString(r.knowledge_id, asString(r.event_id, asString(r.candidate_id, "unknown")))),
    text: asString(r.text, asString(r.summary, asString(r.content, "(no text)"))),
    score: asNumber(r.score, asNumber(r.posterior, 0)),
    status: asString(r.status, "promoted"),
    origin: asString(r.substrate_origin, asString(r.origin, "")),
    view_row: r,
  }));
};

const readOwnerProfileView = async (): Promise<OwnerProfile | undefined> => {
  const rows = await readGenericView("owner_profile_view");
  const p = asObject(rows[0]?.payload);
  if (!rows[0] && Object.keys(p).length === 0) return undefined;
  const signals = asObject(p.rendering_signals) as Record<string, number>;
  const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    rendering_signals: signals,
    preferred_terms: arr(p.preferred_terms),
    avoided_terms: arr(p.avoided_terms),
    detected_language: asObject(p.detected_language) as OwnerProfile["detected_language"],
    observation_count: asNumber(p.observation_count, 0),
  };
};

const readHealth = async (): Promise<DaemonHealth> => {
  try { return await rpcGet<DaemonHealth>(`${requireAux()}/health`); } catch { return {}; }
};

const readRecentEvents = async (k = MAX_INITIAL_EVENTS, kinds?: string[]): Promise<EventRow[]> => {
  try {
    const env = await mcpCall("runtime.recent_events", { k, ...(kinds ? { kinds } : {}) });
    if (!env.ok) return [];
    const data = env.result as { events?: JsonRecord[] };
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

const parseJsonSafe = (s: unknown): JsonRecord => {
  if (s && typeof s === "object" && !Array.isArray(s)) return s as JsonRecord;
  try { return JSON.parse(String(s ?? "{}")) as JsonRecord; } catch { return {}; }
};

const ageOf = (ts: string, now: number): number => {
  const t = Date.parse(ts || "");
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
};

export const readPendingDecisions = (db: Database, nowMs: number): PendingDecision[] => {
  type R = { id: string; ts: string; payload: string };
  const out: PendingDecision[] = [];
  const isResolved = (id: string, kinds: string) =>
    !!db.query(`SELECT 1 FROM events WHERE kind IN (${kinds}) AND context_refs LIKE ? LIMIT 1`).get(`%${id}%`);
  for (const r of db.query("SELECT id, ts, payload FROM events WHERE kind='owner_input_required' ORDER BY ts DESC LIMIT 200").all() as R[]) {
    if (isResolved(r.id, "'owner_decision_recorded'")) continue;
    const p = parseJsonSafe(r.payload);
    out.push({ event_id: r.id, kind: "owner_input_required", target: String(p.target ?? p.question ?? p.summary ?? "-").slice(0, 80), anchor: String(p.anchor ?? p.summary ?? p.question ?? "").slice(0, 50), age_ms: ageOf(r.ts, nowMs) });
  }
  for (const r of db.query("SELECT id, ts, payload FROM events WHERE kind='hidl_action_required' ORDER BY ts DESC LIMIT 200").all() as R[]) {
    if (isResolved(r.id, "'hidl_action_resolved','owner_decision_recorded'")) continue;
    const p = parseJsonSafe(r.payload);
    out.push({ event_id: r.id, kind: "hidl_action_required", target: String(p.target ?? p.action ?? p.suggested_action ?? p.summary ?? "-").slice(0, 80), anchor: String(p.anchor ?? p.reason ?? p.summary ?? "").slice(0, 50), age_ms: ageOf(r.ts, nowMs) });
  }
  for (const r of db.query("SELECT id, ts, payload FROM events WHERE kind='contract_amendment_proposed' ORDER BY ts DESC LIMIT 400").all() as R[]) {
    const p = parseJsonSafe(r.payload);
    const target = String(p.target ?? p.target_resource ?? p.resource_uri ?? "");
    if (!target || !OWNER_GATED_PATH_PATTERNS.some(({ regex }) => regex.test(target.replace(/^repo:/, "")))) continue;
    if (db.query("SELECT 1 FROM events WHERE kind='contract_amendment_applied' AND (context_refs LIKE ? OR json_extract(payload,'$.source_event_id')=?) LIMIT 1").get(`%${r.id}%`, r.id)) continue;
    out.push({ event_id: r.id, kind: "contract_amendment_proposed", target: target.slice(0, 80), anchor: String(p.anchor ?? "").slice(0, 50), age_ms: ageOf(r.ts, nowMs) });
  }
  out.sort((a, b) => b.age_ms - a.age_ms);
  return out;
};

export const readDriftSummaries = (db: Database, repoRoot: string, n = 10): DriftSummary[] => {
  const ids = (db.query("SELECT directive_id FROM events WHERE kind='directive_opened' GROUP BY directive_id ORDER BY MAX(ts) DESC LIMIT ?").all(n) as Array<{ directive_id: string }>).map((r) => r.directive_id).filter(Boolean);
  const out: DriftSummary[] = [];
  for (const directive_id of ids) {
    try {
      const agg = aggregateVerify(db, directive_id, repoRoot);
      const term = db.query("SELECT kind FROM events WHERE directive_id=? AND kind IN ('task_committed','task_failed') ORDER BY ts DESC LIMIT 1").get(directive_id) as { kind?: string } | null;
      const status = term?.kind === "task_committed" ? "committed" : term?.kind === "task_failed" ? "failed" : "in-flight";
      out.push({ directive_id, status, applied: agg.applied, failed: agg.failed, refused: agg.refused, stranded: agg.stranded.length, drift: agg.drift, missing: agg.missing });
    } catch { /* skip directives we cannot verify */ }
  }
  out.sort((a, b) => (b.drift + b.missing) - (a.drift + a.missing));
  return out;
};

let panelDbCache: Database | null = null;
const panelDb = (): Database | null => {
  if (panelDbCache) return panelDbCache;
  try { panelDbCache = openDb(resolveDbPath()); } catch { panelDbCache = null; }
  return panelDbCache;
};

const refreshPanels = (state: WatchState, force = false): void => {
  const db = panelDb();
  if (!db) return;
  const now = Date.now();
  const due = (last?: number, ms = 30_000) => force || !last || now - last > ms;
  if (due(state.trust_refreshed_ms, 30_000)) {
    try { state.trust = gatherTrustMetrics(db); state.trust_refreshed_ms = now; } catch { /* stale */ }
  }
  if (due(state.decisions_refreshed_ms, 5_000)) {
    try { state.decisions = readPendingDecisions(db, now); state.decisions_refreshed_ms = now; } catch { /* stale */ }
  }
  if (due(state.drift_refreshed_ms, 30_000)) {
    try { state.drift = readDriftSummaries(db, resolvePath(process.cwd()), 10); state.drift_refreshed_ms = now; } catch { /* stale */ }
  }
};

const graphRowsFromEvents = (events: EventRow[]): GraphRow[] => events
  .filter((e) => e.kind === "task_node_opened" || e.kind === "task_edge_recorded")
  .map((e) => ({ event_id: e.event_id, ts: e.ts, directive_id: e.directive_id, task_id: e.task_id, row_kind: e.kind === "task_node_opened" ? "node" : "edge", payload: e.payload }));

const latestNarrative = (state: WatchState): EventRow[] => [...state.events].filter((e) => NARRATIVE_KINDS.has(e.kind)).slice(-30).reverse();
const latestActivity = (state: WatchState): EventRow[] => {
  const narrative = latestNarrative(state);
  return narrative.length > 0 ? narrative : [...state.events].slice(-30).reverse();
};

const findBrainInFlight = (state: WatchState, nowMs = Date.now()): { task_id: string; directive_id: string; elapsed_ms: number; intent: string; latest: string } | null => {
  const events = state.events;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind !== "bridge_invoked") continue;
    const closed = events.slice(i + 1).some((x) => ["brain_dispatch_closed", "bridge_completed", "bridge_failed"].includes(x.kind) && (!x.task_id || x.task_id === ev.task_id));
    if (closed) return null;
    const started = Date.parse(ev.ts);
    let intent = "waiting for action_predicted";
    let latest = "bridge invoked";
    for (let j = events.length - 1; j >= i; j--) {
      const x = events[j]!;
      if (x.task_id !== ev.task_id) continue;
      const p = asObject(x.payload);
      if (x.kind === "action_predicted") intent = asString(p.intent, intent);
      if (["brain_message_emitted", "brain_reasoning_recorded", "bridge_frame_received"].includes(x.kind)) latest = asString(p.text, asString(p.message, payloadText(x.payload, 160)));
    }
    return { task_id: ev.task_id ?? "-", directive_id: ev.directive_id ?? "-", elapsed_ms: Number.isFinite(started) ? Math.max(0, nowMs - started) : 0, intent, latest };
  }
  return null;
};

const maybePlain = (state: WatchState, technical: string, plain: string): string => technicalMode(state) ? technical : plain;

export const renderPanelLines = (state: WatchState, view: ViewKey, cols: number): string[] => {
  const w = Math.max(30, cols);
  const tech = technicalMode(state);
  const lines: string[] = [];
  const H = (s: string) => `${BOLD}${s}${RESET}`;
  if (view === "now") {
    lines.push(H("Current substrate decision surface"));
    const brain = findBrainInFlight(state);
    if (brain) {
      lines.push(`${YELLOW}brain in flight${RESET} task=${shortId(brain.task_id)} dir=${shortId(brain.directive_id)} elapsed=${Math.floor(brain.elapsed_ms / 1000)}s`);
      lines.push(`intent: ${truncate(brain.intent, w - 8)}`);
      lines.push(`latest: ${truncate(brain.latest, w - 8)}`);
    }
    if (state.active.length === 0) lines.push("no active directives in active_objectives_view");
    for (const d of state.active.slice(0, 3)) lines.push(row(tech ? shortId(d.directive_id) : "goal", `${d.status ?? "active"} ${d.lifecycle} ${d.text}`, w));
    if (state.ready.length > 0) lines.push("", H("Ready work"));
    for (const t of state.ready.slice(0, 4)) lines.push(row(tech ? shortId(t.task_id) : "ready", `${t.status ?? "ready"} ${t.goal}`, w));
    lines.push("", H("Recent outcomes"));
    for (const e of latestActivity(state).slice(0, 5)) lines.push(`${tech ? `${shortId(e.event_id)} ` : ""}${e.kind}: ${truncate(payloadText(e.payload, 120), w - 18)}`);
    return lines;
  }
  if (view === "decisions") {
    const d = state.decisions ?? [];
    lines.push(`${H("Pending owner decisions")} (${d.length})`);
    if (d.length === 0) return [...lines, "no owner_input_required, hidl_action_required, or owner-gated amendment is pending"];
    for (const r of d.slice(0, 10)) lines.push(`${YELLOW}${tech ? shortId(r.event_id, 8) : "choice"}${RESET} ${r.kind} ${truncate(r.target, w - 35)} age=${formatAge(r.age_ms)}`);
    return lines;
  }
  if (view === "graph") {
    lines.push(`${H("Work Graph")} ready_tasks_view + task_graph_view`);
    const graph = (state.graphRows && state.graphRows.length > 0) ? state.graphRows : graphRowsFromEvents(state.events);
    if (graph.length === 0) lines.push("no task graph rows yet");
    for (const g of graph.slice(-12).reverse()) {
      const p = asObject(g.payload);
      const label = g.row_kind === "edge" ? `${asString(p.kind, "edge")} ${shortId(asString(p.from_task, asString(p.from, "")), 6)}->${shortId(asString(p.to_task, asString(p.to, "")), 6)}` : asString(p.goal, "task");
      lines.push(`${g.row_kind.padEnd(4)} ${tech ? `${shortId(g.task_id)} ` : ""}${truncate(label, w - 12)}`);
    }
    return lines;
  }
  if (view === "evidence") {
    lines.push(`${H("Evidence")} promoted knowledge + artifact registry + lessons`);
    for (const k of (state.knowledge ?? []).slice(0, 5)) lines.push(`${GREEN}${tech ? shortId(k.id) : "knowledge"}${RESET} score=${k.score.toFixed(2)} ${truncate(k.text, w - 24)}`);
    for (const a of (state.artifacts ?? []).slice(0, 4)) lines.push(`${CYAN}${tech ? shortId(a.id) : "artifact"}${RESET} ${a.runtime} score=${a.score.toFixed(2)} ${truncate(a.name ?? a.id, w - 24)}`);
    for (const e of latestNarrative(state).filter((e) => e.kind === "lesson_extracted" || e.kind === "contract_amendment_proposed").slice(0, 4)) lines.push(`${YELLOW}${e.kind}${RESET} ${truncate(payloadText(e.payload, 140), w - 18)}`);
    if (lines.length === 1) lines.push("no promoted knowledge, artifacts, or lessons visible yet");
    return lines;
  }
  if (view === "health") {
    const h = state.health ?? {};
    lines.push(`${H("Daemon")} ${healthLabel(h)} pid=${h.pid ?? "?"} uptime_ms=${h.uptime_ms ?? 0} events=${h.events_count ?? state.events.length}`);
    lines.push(`mcp=${h.mcp_port ?? "?"} aux=${h.aux_port ?? "?"} activation_listeners=${h.activation_listener_count ?? "?"}`);
    if (h.stuck_workers && h.stuck_workers.length > 0) for (const s of h.stuck_workers) lines.push(`${RED}stuck worker${RESET} ${s.worker} last_tick_ms_ago=${s.last_tick_ms_ago ?? "?"}`);
    const hr = h.hotreload;
    if (hr) {
      lines.push(`${H("hotreload")} watched=${hr.watched_module_count ?? 0} reload_total=${hr.reload_total ?? 0} failure_total=${hr.failure_total ?? 0}`);
      if (hr.last_failure) lines.push(`${RED}last_failure${RESET} ${hr.last_failure.module}: ${truncate(hr.last_failure.reason, w - 28)}`);
    }
    const t = state.trust;
    if (t) lines.push(`${H("trust")} autonomy_score=${t.autonomy_score.toFixed(2)} closure_residual_avg=${t.closure_residual_7d.avg.toFixed(3)} recipes=${t.recipes_extracted}/${t.recipes_replayed_success}`);
    if ((state.rollingReviews ?? []).length > 0) lines.push(`rolling reviews due=${(state.rollingReviews ?? []).filter((r) => Number(r.past_due) === 1).length}/${state.rollingReviews?.length ?? 0}`);
    if ((state.stakeholders ?? []).length > 0) lines.push(`stakeholder_state_view rows=${state.stakeholders?.length ?? 0}`);
    return lines;
  }
  lines.push(`${H("Diagnostics")} failures, drift, and noisy substrate signals`);
  const driftTotal = (state.drift ?? []).reduce((acc, r) => acc + r.drift + r.missing, 0);
  lines.push(`verify drift total=${driftTotal} directives=${state.drift?.length ?? 0}`);
  for (const r of (state.drift ?? []).slice(0, 4)) lines.push(`${(r.drift + r.missing) > 0 ? RED : GREEN}${shortId(r.directive_id, 8)}${RESET} ${r.status} applied=${r.applied} failed=${r.failed} drift=${r.drift} missing=${r.missing}`);
  const diag = [...state.events].filter((e) => DIAGNOSTIC_KINDS.includes(e.kind)).slice(-8).reverse();
  for (const e of diag) lines.push(`${RED}${e.kind}${RESET} ${tech ? shortId(e.event_id) + " " : ""}${truncate(payloadText(e.payload, 140), w - 22)}`);
  if (diag.length === 0 && driftTotal === 0) lines.push("no diagnostic events in the local buffer");
  return lines;
};

const matchesFilter = (line: string, filter: string | undefined): boolean => {
  const q = (filter ?? "").trim().toLowerCase();
  if (!q) return true;
  return line.toLowerCase().includes(q);
};

const paneTitle = (state: WatchState, view: ViewKey): string => {
  const def = VIEWS.find((v) => v.key === view)!;
  return `${def.hotkey}:${def.label}${state.focus === view ? " *" : ""}`;
};

const renderBox = (title: string, lines: string[], left: number, top: number, width: number, height: number, focused: boolean): string[] => {
  const out: string[] = [];
  const head = `${focused ? INVERT : BOLD}${pad(` ${title} `, width)}${RESET}`;
  out.push(moveTo(top, left), head);
  for (let i = 0; i < height - 1; i++) {
    out.push(moveTo(top + 1 + i, left), pad(lines[i] ?? "", width));
  }
  return out;
};

export const renderFrame = (state: WatchState, cols: number, rows: number): string => {
  const safeCols = Math.max(80, cols);
  const safeRows = Math.max(24, rows);
  const focus = state.focus ?? "now";
  const technical = technicalMode(state);
  const parts: string[] = [CLEAR_SCREEN, HOME];
  const h = state.health ?? {};
  const profile = state.ownerProfile;
  const signalSummary = profile ? Object.entries(profile.rendering_signals ?? {}).slice(0, 3).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ") : "owner_profile_view empty";
  const headline = maybePlain(state,
    `acc watch | substrate-as-operator | focus=${focus} | daemon=${healthLabel(h)} | ${signalSummary}`,
    `acc watch | live view of what accint is doing | ${healthLabel(h)}`,
  );
  parts.push(moveTo(1, 1), `${BOLD}${CYAN}${truncate(headline, safeCols)}${RESET}`);
  parts.push(moveTo(2, 1), `${DIM}1 Now  2 Decisions  3 Work Graph  4 Evidence  5 Health  6 Diagnostics  Tab focus  / filter  r refresh  ? help  q quit${RESET}`);

  const bodyTop = 4;
  const bodyRows = safeRows - 7;
  const leftWidth = Math.floor((safeCols - 3) / 2);
  const rightWidth = safeCols - leftWidth - 3;
  const boxHeight = Math.max(5, Math.floor(bodyRows / 3));
  const panes: Array<[ViewKey, number, number, number, number]> = [
    ["now", 1, bodyTop, leftWidth, boxHeight],
    ["decisions", leftWidth + 3, bodyTop, rightWidth, boxHeight],
    ["graph", 1, bodyTop + boxHeight + 1, leftWidth, boxHeight],
    ["evidence", leftWidth + 3, bodyTop + boxHeight + 1, rightWidth, boxHeight],
    ["health", 1, bodyTop + (boxHeight + 1) * 2, leftWidth, boxHeight],
    ["diagnostics", leftWidth + 3, bodyTop + (boxHeight + 1) * 2, rightWidth, boxHeight],
  ];
  for (const [view, left, top, width, height] of panes) {
    const lines = renderPanelLines(state, view, width).filter((line) => matchesFilter(stripAnsi(line), state.filter));
    parts.push(...renderBox(paneTitle(state, view), lines, left, top, width, height, focus === view));
  }

  if (state.showHelp) {
    const help = [
      "Help",
      "Same six panes for non-technical and technical work.",
      "Owner profile changes wording density; it does not change the information shape.",
      "SSE fills recent events; MCP views ground tasks, graph, evidence, profile, and health.",
      "1-6 focus panes, Tab cycles, / filters visible lines, r refreshes snapshots, q quits.",
    ];
    const w = Math.min(74, safeCols - 4);
    const top = Math.max(5, Math.floor(safeRows / 2) - 3);
    const left = Math.max(2, Math.floor((safeCols - w) / 2));
    for (let i = 0; i < help.length; i++) parts.push(moveTo(top + i, left), `${INVERT}${pad(help[i]!, w)}${RESET}`);
  }

  const decisionsN = state.decisions?.length ?? 0;
  const driftN = (state.drift ?? []).reduce((acc, r) => acc + r.drift + r.missing, 0);
  const footer = `Status focus=${focus} filter=${state.filter || "none"} events=${state.events.length} active=${state.active.length} ready=${state.ready.length} decisions=${decisionsN} drift=${driftN} pid=${h.pid ?? "?"}`;
  parts.push(moveTo(safeRows - 1, 1), `${BOLD}${truncate(footer, safeCols)}${RESET}`);
  parts.push(moveTo(safeRows, 1), truncate(`Daemon pid=${h.pid ?? "?"} uptime_ms=${h.uptime_ms ?? 0} events_count=${h.events_count ?? state.events.length} mcp=${h.mcp_port ?? "?"} aux=${h.aux_port ?? "?"}`, safeCols));
  return parts.join("");
};

const refreshAll = async (state: WatchState): Promise<void> => {
  const [active, ready, artifacts, knowledge, graphRows, directiveStatus, rollingReviews, stakeholders, ownerProfile, health, events] = await Promise.all([
    readActiveDirectives(),
    readReadyTasks(),
    readArtifacts(),
    readKnowledge(),
    readGenericView("task_graph_view"),
    readGenericView("directive_status_view"),
    readGenericView("rolling_review_due_view"),
    readGenericView("stakeholder_state_view"),
    readOwnerProfileView(),
    readHealth(),
    state.events.length === 0 ? readRecentEvents() : Promise.resolve(state.events),
  ]);
  state.active = active;
  state.ready = ready;
  state.artifacts = artifacts;
  state.knowledge = knowledge;
  state.graphRows = graphRows as GraphRow[];
  state.directiveStatus = directiveStatus;
  state.rollingReviews = rollingReviews;
  state.stakeholders = stakeholders;
  state.ownerProfile = ownerProfile;
  state.health = health;
  state.events = events;
  refreshPanels(state, true);
};

const refreshSnapshots = async (state: WatchState): Promise<void> => {
  const [active, ready, artifacts, knowledge, graphRows, directiveStatus, rollingReviews, stakeholders, ownerProfile, health] = await Promise.all([
    readActiveDirectives(),
    readReadyTasks(),
    readArtifacts(),
    readKnowledge(),
    readGenericView("task_graph_view"),
    readGenericView("directive_status_view"),
    readGenericView("rolling_review_due_view"),
    readGenericView("stakeholder_state_view"),
    readOwnerProfileView(),
    readHealth(),
  ]);
  state.active = active;
  state.ready = ready;
  state.artifacts = artifacts;
  state.knowledge = knowledge;
  state.graphRows = graphRows as GraphRow[];
  state.directiveStatus = directiveStatus;
  state.rollingReviews = rollingReviews;
  state.stakeholders = stakeholders;
  state.ownerProfile = ownerProfile;
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
  if (ev.kind === "task_node_opened" || ev.kind === "task_edge_recorded") state.graphRows = graphRowsFromEvents(state.events);
};

const screenDims = (): { cols: number; rows: number } => ({
  cols: (process.stdout as { columns?: number }).columns ?? 120,
  rows: (process.stdout as { rows?: number }).rows ?? 40,
});

const nextFocus = (view: ViewKey): ViewKey => VIEWS[(VIEWS.findIndex((v) => v.key === view) + 1) % VIEWS.length]!.key;

export const runWatch = async (argv: string[], opts: RunWatchOpts = {}): Promise<number> => {
  void argv;
  const writer = opts.writer ?? ((s: string) => { process.stdout.write(s); });
  const state = emptyState();
  const pollMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const isInteractive = !opts.writer && !!process.stdout.isTTY;
  let filtering = false;

  await refreshAll(state);
  if (isInteractive) writer(ALT_ENTER + HIDE_CURSOR);
  const renderTick = (): void => writer(renderFrame(state, screenDims().cols, screenDims().rows));
  renderTick();

  const sseAbort = new AbortController();
  const onAbort = () => sseAbort.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const ssePromise = (async () => {
    if (opts.disableSse) return;
    try {
      for await (const ev of sseConnect({ signal: sseAbort.signal })) {
        appendEvent(state, ev);
        renderTick();
      }
    } catch { /* disconnects are non-fatal */ }
  })();

  const pollTimer = setInterval(() => {
    void refreshSnapshots(state).then(renderTick).catch(() => { /* stale beats blank */ });
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
      if (str === "\x1b") { state.showHelp = false; renderTick(); return; }
      if (str === "?") { state.showHelp = !state.showHelp; renderTick(); return; }
      if (str === "/") { filtering = true; state.filter = ""; renderTick(); return; }
      if (str === "\t") { state.focus = nextFocus(state.focus ?? "now"); renderTick(); return; }
      if (/^[1-6]$/.test(str)) { state.focus = VIEWS[Number(str) - 1]!.key; renderTick(); return; }
      if (str === "r" || str === "R") { void refreshAll(state).then(renderTick).catch(() => { /* keep stale */ }); return; }
    };
    stdin.on("data", keyHandler);
  }

  const durationPromise = opts.durationMs ? new Promise<void>((resolve) => { setTimeout(resolve, opts.durationMs); }) : new Promise<void>(() => { /* never */ });
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
