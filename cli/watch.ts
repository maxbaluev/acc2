#!/usr/bin/env bun
// `acc watch` - ANSI TUI for the substrate event stream. The public test
// surface is intentionally small: keep runWatch(argv, opts?) and
// renderFrame(state, columns, rows) stable and side-effect free.

import { mcpCall, sseConnect, type SseEvent, requireAux, rpcGet } from "./rpc";

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

type ArtifactRow = {
  id: string;
  runtime: string;
  score: number;
  status: string;
  name: string | null;
  confidence?: number;
};

type RecipeRow = {
  id: string;
  name: string;
  confidence: number;
  goal_shape?: string;
  status?: string;
};

type LessonRow = {
  id: string;
  kind: string;
  summary: string;
  target?: string;
  ts?: string;
};

type KnowledgeRow = {
  id: string;
  text: string;
  score: number;
  status?: string;
  origin?: string;
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

type ViewKey = "directives" | "tasks" | "events" | "artifacts" | "recipes" | "lessons" | "interventions" | "knowledge";

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
  // by default) and supervisor / lesson rows can be hours old — they drop
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
  { key: "directives", label: "Directives" },
  { key: "tasks", label: "Tasks" },
  { key: "events", label: "Recent Events" },
  { key: "artifacts", label: "Code Artifacts" },
  { key: "recipes", label: "Recipes" },
  { key: "lessons", label: "Lessons" },
  { key: "interventions", label: "Supervisor" },
  { key: "knowledge", label: "Knowledge" },
];
// Brain TUI rewrite proposal (btqner8jn axis B, 2026-05-15): treat noisy
// heartbeat events as semantic folds — keep them in the buffer but
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
  view: "events",
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
  if (s !== plain) return plain.slice(0, Math.max(0, max - 1)) + "…";
  return s.slice(0, Math.max(0, max - 1)) + "…";
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
    } catch { /* malformed JSON — fall through to {} */ }
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
  }));
};

const readHealth = async (): Promise<DaemonHealth> => {
  try {
    const base = requireAux();
    return await rpcGet<DaemonHealth>(`${base}/health`);
  } catch { return {}; }
};

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
// post-fetch render contract stay aligned — the same canonical kind list
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
  "redispatch_storm_detected",
  "dag_explosion_detected",
  "dispatch_budget_exceeded",
  "crisis_postmortem",
  "owner_input_required",
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
    return groupEvents(state.events ?? []).map((e) => {
      const p = asObject(e.payload);
      const count = asNumber(p.grouped_count, 1);
      return {
        id: e.event_id,
        title: `${e.kind}${count > 1 ? ` x${count}` : ""}`,
        meta: `${e.ts.slice(11, 19)} dir=${shortId(e.directive_id)} task=${shortId(e.task_id)}`,
        body: `event_id=${e.event_id}\nts=${e.ts}\nkind=${e.kind}\ndirective_id=${e.directive_id ?? ""}\ntask_id=${e.task_id ?? ""}\n\npayload=${formatPayloadPreview(e.payload, 2000)}`,
        kind: e.kind,
        status: e.kind,
        raw: e,
      };
    });
  }
  if (view === "artifacts") {
    return (state.artifacts ?? []).map((a) => ({
      id: a.id,
      title: a.name ?? a.id,
      meta: `${a.runtime} score=${a.score.toFixed(2)} conf=${(a.confidence ?? 0).toFixed(2)} ${a.status}`,
      body: `artifact_id=${a.id}\nname=${a.name ?? ""}\nruntime=${a.runtime}\nscore=${a.score.toFixed(3)}\nconfidence=${(a.confidence ?? 0).toFixed(3)}\nstatus=${a.status}`,
      score: a.score,
      status: a.status,
      raw: a,
    }));
  }
  if (view === "recipes") {
    return deriveRecipes(state).map((r) => ({
      id: r.id,
      title: r.name,
      meta: `confidence=${r.confidence.toFixed(2)} ${r.status ?? ""}`,
      body: `recipe_id=${r.id}\nname=${r.name}\nconfidence=${r.confidence.toFixed(3)}\nstatus=${r.status ?? ""}\ngoal_shape=${r.goal_shape ?? ""}`,
      score: r.confidence,
      status: r.status,
      raw: r,
    }));
  }
  if (view === "lessons") {
    return deriveLessons(state).map((l) => ({
      id: l.id,
      title: l.summary,
      meta: `${l.kind} ${l.target ?? ""}`.trim(),
      body: `id=${l.id}\nts=${l.ts ?? ""}\nkind=${l.kind}\ntarget=${l.target ?? ""}\n\n${l.summary}`,
      kind: l.kind,
      status: l.kind,
      raw: l,
    }));
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
    return source.map((e) => ({
      id: e.event_id,
      title: e.kind,
      meta: `${e.ts.slice(11, 19)} dir=${shortId(e.directive_id)} task=${shortId(e.task_id)}`,
      body: `event_id=${e.event_id}\nts=${e.ts}\nkind=${e.kind}\n\n${formatPayloadPreview(e.payload, 2000)}`,
      kind: e.kind,
      status: e.kind,
      raw: e,
    }));
  }
  return deriveKnowledge(state).map((k) => ({
    id: k.id,
    title: k.text,
    meta: `score=${k.score.toFixed(2)} ${k.status ?? ""} ${k.origin ?? ""}`.trim(),
    body: `knowledge_id=${k.id}\nscore=${k.score.toFixed(3)}\nstatus=${k.status ?? ""}\norigin=${k.origin ?? ""}\n\n${k.text}`,
    score: k.score,
    status: k.status,
    raw: k,
  }));
};

const filteredItems = (state: WatchState, view: ViewKey): ListItem[] => {
  const q = (state.filter ?? "").trim().toLowerCase();
  const items = itemsForView(state, view);
  if (!q) return items;
  return items.filter((item) => `${item.id} ${item.title} ${item.meta} ${item.body}`.toLowerCase().includes(q));
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

export const renderFrame = (state: WatchState, cols: number, rows: number): string => {
  const safeCols = Math.max(60, cols);
  const safeRows = Math.max(20, rows);
  const view = state.view ?? "events";
  const items = filteredItems(state, view);
  const selectedMap = state.selected ?? {};
  const defaultSelected = view === "events" ? Math.max(0, items.length - 1) : 0;
  const selected = clamp(selectedMap[view] ?? defaultSelected, 0, Math.max(0, items.length - 1));
  const detail = items[selected];
  const listWidth = Math.max(34, Math.floor(safeCols * 0.48));
  const detailWidth = safeCols - listWidth - 3;
  const listRows = safeRows - 6;
  const start = clamp(selected - Math.floor(listRows / 2), 0, Math.max(0, items.length - listRows));
  const parts: string[] = [CLEAR_SCREEN, HOME];

  parts.push(moveTo(1, 1));
  parts.push(`${BOLD}${CYAN}acc watch${RESET} ${DIM}Tab/1-8 view  j/k move  Enter detail  / filter  ? help  r refresh  q quit${RESET}`);

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
  parts.push(`${BOLD}${labelForView(view)}${RESET} ${DIM}(${items.length})${RESET}`);
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
      "1-8 or Tab: switch views",
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

  const statusRow = safeRows - 1;
  const h = state.health ?? {};
  const filter = state.filter ? `/${state.filter}` : "none";
  parts.push(moveTo(statusRow, 1));
  parts.push(`${BOLD}Status${RESET} view=${labelForView(view)} items=${items.length} selected=${items.length ? selected + 1 : 0} filter=${filter} daemon=${healthLabel(h)}`);
  parts.push(moveTo(statusRow + 1, 1));
  // Brain TUI rewrite axis F (2026-05-15): always-visible organism pulse.
  // /health now surfaces activation listeners, pathology counts,
  // brain-failure rate, hotreload state — render them on the footer so
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
    const view = state.view ?? "events";
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
      if (str === "/") { filtering = true; state.filter = ""; renderTick(); return; }
      if (str === "?") { state.showHelp = !state.showHelp; renderTick(); return; }
      if (str === "\t") { setView(nextView(state.view ?? "events")); renderTick(); return; }
      if (/^[1-8]$/.test(str)) { setView(VIEWS[Number(str) - 1]!.key); renderTick(); return; }
      if (str === "j" || str === "J" || str === "\x1b[B") { adjustSelection(1); renderTick(); return; }
      if (str === "k" || str === "K" || str === "\x1b[A") { adjustSelection(-1); renderTick(); return; }
      if (str === "r" || str === "R") { void refreshAll(state).then(renderTick).catch(() => { /* stale is better than blank */ }); return; }
      if (str === "\r" || str === "\n") { renderTick(); return; }
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
