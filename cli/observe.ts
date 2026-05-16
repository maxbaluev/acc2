#!/usr/bin/env bun
// `acc events` / `acc tail` / `acc graph` / `acc inspect` — operator-side
// observability surface. Replaces the inline `bun -e 'import {mcpCall}…'`
// boilerplate every diagnostic session used to need.
//
// All subcommands route through the daemon's MCP server (`mcpCall`) — never
// open SQLite directly — so multi-process safety, schema migration, and
// embedding-index hygiene are the daemon's problem, not the CLI's.
//
// Output shape: one event per line, formatter pinned per-kind so a downstream
// consumer (Claude Code background-task stream, log aggregator, grep) can
// parse the structured prefix. Format:
//   <ts> <kind-glyph> <task-id-or-->  <key=val key=val …>
//
// `acc task --follow` reuses `tailEvents` to stream brain progress as
// Claude-native background-task stdout: every emit becomes a notification.

import { mcpCall, sseConnect } from "./rpc";
import { EVENT_KINDS, MIRROR_INLINE_EVENT_TYPES } from "../substrate/event_kinds";

// ── panel-friendly format invariants ───────────────────────────────
//
// The Claude Code background_tasks shell-details panel shows the last ~5
// lines of stdout. During the first ~minute of an `acc task` dispatch the
// brain hasn't emitted anything yet, so the panel was eaten by the long
// directive_opened prompt echo. Three load-bearing constants now govern
// the panel UX:
//
//  - MAX_EVENT_LINE_CHARS — every narrative renderer collapses to ONE line
//    ≤120 chars. Tail any multi-line payload to `→ id=<event_short>` so
//    `--verbose` / `acc inspect <id>` can pull the full detail.
//  - FOLLOW_HEARTBEAT_MS — heartbeat cadence (5s). Fires while no new
//    narrative event has arrived for ≥5s.
//  - FOLLOW_HEARTBEAT_WINDOW_MS — drop the heartbeat after this much idle
//    time (60s). After a minute of silence the brain is likely wedged; the
//    operator should switch to `acc events --verbose` or `acc doctor`.
//
// Crucially, the heartbeat clock starts at DISPATCH START — not at the
// first event — so the trailing-5-line window has brain-progress signal
// during the pre-event window. That is the structural fix for the
// "panel shows stale prompt echo for the entire first minute" bug.
export const MAX_EVENT_LINE_CHARS = 120;
export const FOLLOW_HEARTBEAT_MS = 5_000;
export const FOLLOW_HEARTBEAT_WINDOW_MS = 60_000;

// ── one-line formatter per event kind ──────────────────────────────

type EventLike = {
  id?: string;
  event_id?: string;  // runtime.recent_events returns `event_id` (the canonical row id renamed at the API edge); we accept both.
  ts?: string;
  kind?: string;
  directive_id?: string;
  task_id?: string;
  substrate_origin?: string;
  failure_kind?: string;
  payload?: unknown;
};

const eventId = (e: EventLike): string | undefined => e.event_id ?? e.id;

const TERMINAL_KINDS = new Set([
  "task_committed", "task_failed", "dispatcher_violation",
]);

const FRAME_KINDS = new Set([
  "bridge_frame_received",
]);

/** Strategic-narrative event kinds — the ones an operator needs to
 *  understand WHAT the brain is doing, not HOW the substrate is running it.
 *  `acc tail` defaults to this filter so the chat doesn't drown in
 *  bridge_frame_received / runtime_subprocess_started / embedding_computed
 *  chatter. `--verbose` opts out and shows every kind.
 *
 *  Inclusion rule: changes the operator's MODEL of progress. If two reads
 *  ten minutes apart would look identical without this kind, suppress it.
 *  Anything substrate-internal (admission, scoring, score-update, embedding,
 *  Father heartbeats, daemon lifecycle, candidate confirm/contradict, sub-
 *  process spawn lifecycle, gate-decision audit rows, prompt budget) is
 *  noise from the operator's perspective. Bridge handshake / frames /
 *  subprocess detail are diagnostic surfaces, not narrative.
 *
 *  Derived from the canonical EVENT_KINDS registry's `narrative: true` flag
 *  so the operator-stream filter cannot drift from the kind registry. To
 *  add a kind to the narrative surface, set `narrative: true` on its entry
 *  in `substrate/event_kinds.ts` — there is no parallel hand-maintained
 *  list to update. */
export const NARRATIVE_KINDS = new Set(
  Object.entries(EVENT_KINDS).filter(([, meta]) => meta.narrative).map(([kind]) => kind),
);

const trunc = (s: string | undefined, n: number): string => {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};

const idPrefix = (id: string | undefined, n = 8): string => {
  if (!id) return "—";
  return id.length > n ? id.slice(0, n) : id;
};

const parsePayload = (p: unknown): Record<string, unknown> => {
  if (!p) return {};
  if (typeof p === "string") {
    try { return JSON.parse(p) as Record<string, unknown>; } catch { return {}; }
  }
  if (typeof p === "object") return p as Record<string, unknown>;
  return {};
};

/** Kind → short glyph for visual scanning. */
const GLYPHS: Record<string, string> = {
  directive_opened: "📨",
  directive_amended: "✎",
  task_node_opened: "▸",
  task_edge_recorded: "→",
  brain_dispatched: "🧠↑",
  brain_dispatch_closed: "🧠↓",
  bridge_invoked: "B↑",
  bridge_mcp_connected: "🤝",
  bridge_frame_received: "·",
  bridge_completed: "B✓",
  bridge_failed: "B✗",
  bridge_stuck: "B⏸",
  action_predicted: "⚡",
  artifact_invoked: "▶",
  artifact_observed: "👁",
  runtime_subprocess_started: "+",
  runtime_subprocess_completed: "✓",
  runtime_subprocess_soft_terminated: "⊘",
  runtime_subprocess_hard_killed: "✗",
  action_scored: "Σ",
  task_committed: "✅",
  task_failed: "❌",
  dispatcher_violation: "⚠️",
  knowledge_candidate: "📚",
  knowledge_promoted: "📚+",
  candidate_confirmed: "📚✓",
  candidate_contradicted: "📚✗",
  recipe_extracted: "🔁",
  code_artifact_admitted: "📦+",
  code_artifact_promoted: "📦⬆",
  code_artifact_admission_rejected: "📦✗",
  embedding_computed: "Ε",
  external_event_received: "🌐",
  daemon_started: "🟢",
  daemon_ready: "🟢✓",
  daemon_index_rebuilt: "Ι",
  daemon_stopped: "🔴",
  father_cycle_recorded: "👤",
  father_drift_detected: "👤⚠",
  task_deferred_for_interference: "⏸",
  constitutional_gate_decision: "⚖",
  prompt_truncated: "✂",
  integrity_check_completed: "🩺",
  sandbox_unenforced_warning: "🛡⚠",
  task_closure_audited: "🎓",
  lesson_extracted: "💡",
  contract_amendment_proposed: "📝",
  lesson_apply_requested: "Δ?",
  applied_change_committed: "Δ✓",
  // Brain convergence axis D (2026-05-15): brain observability glyphs.
  // NOT added to NARRATIVE_KINDS — too chatty for the default surface;
  // visible via `acc events --kind brain_message_emitted` or `--verbose`.
  brain_prompt_composed: "🧠📝",
  brain_message_emitted: "🧠💬",
  brain_reasoning_recorded: "🧠💭",
  // Pathology budget (axis B/H): debits + exhausted.
  pathology_budget_debited: "⚠️-",
  pathology_budget_exhausted: "⚠️✗",
  // Hot-reload telemetry.
  daemon_hotreload_triggered: "♻︎↑",
  daemon_hotreload_completed: "♻︎✓",
  daemon_hotreload_failed: "♻︎✗",
  // Prompt cache telemetry.
  prompt_composition_cache_hit: "💾✓",
  prompt_composition_cache_miss: "💾·",
  // Worker tick liveness.
  worker_tick_completed: "·",
  lesson_applied: "💡✓",
  contract_amendment_applied: "📝✓",
  hidl_action_required: "🔐",
  owner_profile_recorded: "👤✓",
  auto_apply_signaled: "Δ!",
  applied_change_failed: "Δ✗",
};

const formatPayload = (kind: string, p: Record<string, unknown>): string => {
  // Per-kind structured rendering. Returns a "key=value key=value" suffix.
  switch (kind) {
    case "directive_opened": {
      const lifecycle = p.lifecycle as string | undefined;
      const urgency = p.urgency as string | undefined;
      return [
        "opened",
        lifecycle ? `lifecycle=${lifecycle}` : "",
        urgency && urgency !== "normal" ? `urgency=${urgency}` : "",
      ].filter(Boolean).join(" ");
    }
    case "task_node_opened": {
      const goal = p.goal as string | undefined;
      const rank = p.rank;
      const urgency = p.urgency as string | undefined;
      return [
        rank !== undefined ? `rank=${rank}` : "",
        urgency && urgency !== "normal" ? `urgency=${urgency}` : "",
        goal ? `goal=${JSON.stringify(trunc(goal, 56))}` : "",
      ].filter(Boolean).join(" ");
    }
    case "task_edge_recorded": {
      const edgeKind = (p.kind as string) ?? "?";
      const from = idPrefix((p.from_task as string) ?? (p.from as string), 16);
      const to = idPrefix((p.to_task as string) ?? (p.to as string), 16);
      return `kind=${edgeKind} ${from}→${to}`;
    }
    case "bridge_mcp_connected": {
      const tool = p.first_tool as string | undefined;
      return tool ? `first_tool=${tool}` : "";
    }
    case "bridge_failed": {
      const reason = (p.reason as string) ?? "?";
      const hint = p.hint as string | undefined;
      return `reason=${reason}${hint ? ` hint=${JSON.stringify(trunc(hint, 80))}` : ""}`;
    }
    case "bridge_stuck": {
      const reason = (p.reason as string) ?? "?";
      const elapsed = p.elapsed_ms as number | undefined;
      return `reason=${reason}${elapsed ? ` elapsed_ms=${elapsed}` : ""}`;
    }
    case "action_predicted": {
      const action = idPrefix(p.action_artifact_id as string, 12);
      const verifier = idPrefix(p.verifier_artifact_id as string, 12);
      const residual = p.predicted_residual;
      const intent = p.intent as string | undefined;
      return [
        `action=${action} verifier=${verifier}`,
        residual !== undefined ? `predicted_residual=${residual}` : "",
        intent ? `intent=${JSON.stringify(trunc(intent, 42))}` : "",
      ].filter(Boolean).join(" ");
    }
    case "artifact_invoked":
    case "artifact_observed":
      return `artifact=${idPrefix(p.artifact_id as string, 12)}${p.runtime ? ` runtime=${p.runtime}` : ""}`;
    case "action_scored": {
      const residual = p.residual ?? p.observed_residual;
      return `residual=${residual}`;
    }
    case "task_committed": {
      const ec = p.events_count;
      return ec !== undefined ? `events_count=${ec}` : "";
    }
    case "task_failed":
    case "dispatcher_violation": {
      const ownerSummary = p.owner_summary as string | undefined;
      const suggested = p.suggested_action as string | undefined;
      if (ownerSummary) {
        return `${trunc(ownerSummary, 120)}${suggested ? ` → ${trunc(suggested, 80)}` : ""}`;
      }
      const reason = (p.reason as string) ?? "?";
      return `reason=${reason}`;
    }
    case "knowledge_candidate":
    case "knowledge_promoted": {
      const claim = (p.claim as string) ?? (p.text as string) ?? "";
      const score = p.score;
      const learnedFromOwner = p.learned_from_owner as string | undefined;
      const ownerTag = learnedFromOwner ? ` ← owner: ${JSON.stringify(trunc(learnedFromOwner, 80))}` : "";
      return `${claim ? `claim=${JSON.stringify(trunc(claim, 54))}` : ""}${score !== undefined ? ` score=${score}` : ""}${ownerTag}`.trim();
    }
    case "recipe_extracted": {
      const confidence = p.confidence;
      const goalShape = (p.goal_shape as string) ?? "";
      return `confidence=${confidence} goal_shape=${trunc(goalShape, 60)}`;
    }
    case "code_artifact_admitted": {
      const runtime = (p.runtime as string) ?? "?";
      const intent = (p.intent as string) ?? (p.slug as string) ?? "";
      return `runtime=${runtime}${intent ? ` intent=${JSON.stringify(trunc(intent, 80))}` : ""}`;
    }
    case "father_cycle_recorded": {
      const action = (p.action as string) ?? "?";
      const detail = p.detail as Record<string, unknown> | undefined;
      const directive = idPrefix(detail?.directive_id as string, 16);
      return `action=${action}${directive !== "—" ? ` directive=${directive}` : ""}`;
    }
    case "constitutional_gate_decision": {
      const gate = (p.gate as string) ?? "?";
      const reason = p.reason as string | undefined;
      return `gate=${gate}${reason ? ` reason=${trunc(reason, 60)}` : ""}`;
    }
    case "sandbox_unenforced_warning": {
      const runtime = p.runtime as string | undefined;
      const warning = (p.warning as string) ?? "";
      return `${runtime ? `runtime=${runtime} ` : ""}${trunc(warning, 100)}`;
    }
    case "task_closure_audited": {
      const residual = p.closure_residual;
      const uncovered = (p.uncovered_aspects as unknown[] | undefined)?.length ?? 0;
      const covered = (p.covered_sub_tasks as unknown[] | undefined)?.length ?? 0;
      return `closure_residual=${residual} covered=${covered} uncovered=${uncovered}`;
    }
    case "hidl_action_required": {
      const reason = (p.reason as string) ?? "owner action required";
      const summary = p.summary as string | undefined;
      const action = p.suggested_action as string | undefined;
      return `reason=${reason}${summary ? ` summary=${JSON.stringify(trunc(summary, 80))}` : ""}${action ? ` action=${JSON.stringify(trunc(action, 80))}` : ""}`;
    }
    case "owner_profile_recorded": {
      const lang = p.detected_language as string | undefined;
      const score = typeof p.autonomy_score === "number" ? p.autonomy_score : undefined;
      const sigs = p.rendering_signals as Record<string, number> | undefined;
      const sigSummary = sigs && Object.keys(sigs).length > 0
        ? `signals=${Object.entries(sigs).map(([k, v]) => `${k}:${(v as number).toFixed(2)}`).join(",")}`
        : "";
      return [
        lang ? `language=${lang}` : "",
        score !== undefined ? `autonomy_score=${score.toFixed(2)}` : "",
        sigSummary,
      ].filter(Boolean).join(" ");
    }
    case "auto_apply_signaled": {
      const src = p.source_event_id as string | undefined;
      const target = p.target as string | undefined;
      const next = p.next_action as string | undefined;
      return `${src ? `source=${idPrefix(src, 12)} ` : ""}${target ? `target=${target} ` : ""}${next ? `next=${JSON.stringify(trunc(next, 100))}` : ""}`.trim();
    }
    case "applied_change_failed": {
      const src = p.source_event_id as string | undefined;
      const target = p.target as string | undefined;
      const reason = (p.reason as string) ?? "unknown";
      return `${src ? `source=${idPrefix(src, 12)} ` : ""}${target ? `target=${target} ` : ""}reason=${JSON.stringify(trunc(reason, 80))}`.trim();
    }
    case "lesson_extracted": {
      const kind = p.lesson_kind as string | undefined;
      const summary = p.summary as string | undefined;
      return `lesson_kind=${kind ?? "?"} ${summary ? `summary=${JSON.stringify(trunc(summary, 54))}` : ""}`;
    }
    case "contract_amendment_proposed": {
      const target = p.target as string | undefined;
      const anchor = p.anchor as string | undefined;
      const proposed = (p.proposed_behavior as string) ?? (p.summary as string) ?? "";
      return `target=${target ?? "?"}${anchor ? ` anchor=${JSON.stringify(trunc(anchor, 60))}` : ""}${proposed ? ` → ${JSON.stringify(trunc(proposed, 100))}` : ""}`;
    }
    case "lesson_apply_requested": {
      const src = p.source_event_id as string | undefined;
      const status = (p.status as string) ?? "requested";
      return `${src ? `source=${idPrefix(src, 12)} ` : ""}status=${status}`;
    }
    case "applied_change_committed":
    case "lesson_applied":
    case "contract_amendment_applied": {
      const src = p.source_event_id as string | undefined;
      const status = (p.status as string) ?? "applied";
      const commit = p.commit_sha as string | undefined;
      const residual = typeof p.residual === "number" ? p.residual : undefined;
      const subagentId = p.subagent_task_id as string | undefined;
      const summary = p.summary as string | undefined;
      return [
        status !== "applied" ? `status=${status}` : "applied",
        src ? `source=${idPrefix(src, 12)}` : "",
        commit ? `commit=${commit.slice(0, 10)}` : "",
        residual !== undefined ? `residual=${residual}` : "",
        subagentId ? `subagent=${idPrefix(subagentId, 10)}` : "",
        summary ? `summary=${JSON.stringify(trunc(summary, 100))}` : "",
      ].filter(Boolean).join(" ");
    }
    default:
      return "";
  }
};

/** Format one event as a single line suitable for piped consumption.
 *  Returns "" when the event should be suppressed:
 *    - bridge_frame_received always (unless --verbose explicit)
 *    - everything outside NARRATIVE_KINDS unless --verbose
 *  --verbose is the diagnostic dump; default is the narrative an operator
 *  needs to understand WHAT the brain is doing. */
export const formatEvent = (ev: EventLike, opts: { verbose?: boolean } = {}): string => {
  const k = ev.kind ?? "";
  if (!opts.verbose) {
    if (FRAME_KINDS.has(k)) return "";
    if (!NARRATIVE_KINDS.has(k)) return "";
  }
  const ts = (ev.ts ?? "").slice(11, 19);
  const kind = ev.kind ?? "?";
  const glyph = GLYPHS[kind] ?? " ";
  const task = idPrefix(ev.task_id, 16);
  const payload = parsePayload(ev.payload);
  const suffix = formatPayload(kind, payload);
  const failureKind = ev.failure_kind ? ` failure_kind=${ev.failure_kind}` : "";
  const line = `${ts} ${glyph.padEnd(3)} ${kind.padEnd(28)} task=${task.padEnd(16)} ${suffix}${failureKind}`.trimEnd();
  return trunc(line, MAX_EVENT_LINE_CHARS);
};

// Heartbeat formatter — produces the panel-friendly "waiting on brain" line.
// Pre-event window: `[t+<s>s] waiting on brain · cycle <c>/<max> · <e> events · <n> nodes · <p> proposals`.
// Post-event window: append ` · last <kind> <age>s ago`.
// Capped at MAX_EVENT_LINE_CHARS so the trailing-5-line background_tasks panel
// stays readable.
export type HeartbeatCounters = {
  events: number;
  nodes: number;
  proposals: number;
  cycle: number;
  maxCycles: number;
  lastKind?: string;
  lastEventAt?: number;
};
export const formatFollowHeartbeat = (
  startedAt: number,
  counters: HeartbeatCounters,
  now: number = Date.now(),
): string => {
  const ageS = Math.max(0, Math.floor((now - startedAt) / 1000));
  const cycle = counters.cycle > 0 ? counters.cycle : 1;
  const max = counters.maxCycles > 0 ? counters.maxCycles : 1;
  const base = `[t+${ageS}s] waiting on brain · cycle ${cycle}/${max} · ${counters.events} events · ${counters.nodes} nodes · ${counters.proposals} proposals`;
  let line = base;
  if (counters.lastKind && counters.lastEventAt) {
    const lastAgeS = Math.max(0, Math.floor((now - counters.lastEventAt) / 1000));
    line = `${base} · last ${counters.lastKind} ${lastAgeS}s ago`;
  }
  return trunc(line, MAX_EVENT_LINE_CHARS);
};

// ── acc events ─────────────────────────────────────────────────────

export type EventsOpts = {
  limit?: number;
  task?: string;      // task_id prefix filter
  directive?: string; // directive_id prefix filter
  kind?: string;      // event kind filter (exact, single)
  /** Multi-kind filter — when set, kind is ignored. Used by `acc notify`
   *  to subscribe to the entire mirror-inline set in one call instead
   *  of running N parallel tails. The MCP `runtime.recent_events` API
   *  already accepts an array on the `kinds` argument; the client-side
   *  filter passes the union through. */
  kinds?: string[];
  verbose?: boolean;
};

export const runEvents = async (opts: EventsOpts): Promise<number> => {
  const k = Math.min(200, opts.limit ?? 30);  // server caps at 200
  let env;
  try {
    // runtime.recent_events takes `k` (count, ≤200) and optional `kinds` (string[]
    // filter). When `--kind` or `--kinds` is set, pass it to the server so we
    // don't burn the window on irrelevant rows. `kinds[]` takes precedence
    // over `kind` when both are provided.
    const args: Record<string, unknown> = { k };
    if (opts.kinds && opts.kinds.length > 0) args.kinds = opts.kinds;
    else if (opts.kind) args.kinds = [opts.kind];
    env = await mcpCall("runtime.recent_events", args);
  } catch (err) {
    console.error(`acc events: ${(err as Error).message}`);
    return 1;
  }
  if (!env.ok) {
    console.error(`acc events: ${env.error}`);
    return 1;
  }
  const evs = ((env.result as { events?: EventLike[] })?.events ?? []) as EventLike[];
  // Server already returns ts-ascending; no reverse needed.
  let shown = 0;
  for (const e of evs) {
    if (opts.task && !(e.task_id ?? "").startsWith(opts.task)) continue;
    if (opts.directive && !(e.directive_id ?? "").startsWith(opts.directive)) continue;
    // kind/kinds already server-filtered when set; double-check (no-op when filtered server-side)
    if (opts.kinds && opts.kinds.length > 0) {
      if (!opts.kinds.includes(e.kind ?? "")) continue;
    } else if (opts.kind && e.kind !== opts.kind) continue;
    const line = formatEvent(e, { verbose: opts.verbose });
    if (line) {
      console.log(line);
      shown++;
    }
  }
  if (shown === 0 && evs.length > 0) {
    console.error(`acc events: no events matched filters (saw ${evs.length} in window)`);
  }
  return 0;
};

// ── acc tail ───────────────────────────────────────────────────────
//
// Poll runtime.recent_events on an interval, dedupe by event id, emit each
// new event as one structured line. Exit when a terminal event lands for the
// scoped directive/task (or never, when no scope is given — operator can Ctrl-C).

export type TailOpts = EventsOpts & {
  pollMs?: number;
  /** Stop after the FIRST terminal event matching task/directive scope.
   *  Default true when scope is specified, false otherwise. */
  exitOnTerminal?: boolean;
  /** Absolute deadline (Date.now() + ms). When exceeded, exit non-zero. */
  deadlineMs?: number;
  /** Use SSE push (canonical, ~realtime) instead of polling. Default true —
   *  SSE eliminates the 2s poll lag and the missed-events-between-polls window.
   *  Polling is the fallback used only when SSE cannot connect. */
  stream?: boolean;
  /** When the caller follows a whole directive subtree but still wants to
   *  exit only on the ROOT task's terminal event (not the first sub-task
   *  to commit), pass the root task id here. Terminal events for
   *  non-root tasks are still printed but do not end the follow. */
  rootTaskId?: string;
  /** Emit a `[t+Ns] waiting on brain · …` line every FOLLOW_HEARTBEAT_MS
   *  starting at t+5s after follow-start (NOT after first event), capped at
   *  FOLLOW_HEARTBEAT_WINDOW_MS. The flag is opt-in because operators tailing
   *  for grep / pipelines don't want the synthetic lines; the dispatch
   *  follow tail (the panel surface that needs them) sets it explicitly. */
  heartbeat?: boolean;
};

// SSE-backed live stream — the canonical Claude-native observation path.
// Each event arrives via the daemon's `/events/stream` push transport (no
// polling lag), is filtered + formatted into one structured line, and is
// written to stdout. When this command runs as a Claude Code background
// task, each line becomes a notification automatically.
const runTailStream = async (opts: TailOpts): Promise<number> => {
  const exitOnTerminal = opts.exitOnTerminal ?? Boolean(opts.task || opts.directive);
  const deadlineMs = opts.deadlineMs;
  const ac = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  if (deadlineMs) {
    const ms = deadlineMs - Date.now();
    if (ms <= 0) {
      console.error("acc tail: deadline already exceeded");
      return 2;
    }
    deadlineTimer = setTimeout(() => ac.abort(), ms);
  }
  let sawTerminal = false;
  const startedAt = Date.now();
  // Heartbeat counters surfaced into every `[t+Ns] waiting on brain …` line.
  // `events` = scoped events seen on the SSE stream; `nodes` = task_node_opened
  // events (so the operator sees DAG growth without verbose); `proposals` =
  // contract_amendment_proposed / lesson_extracted (so the operator sees what
  // owner-gated decisions are accumulating). `cycle` / `maxCycles` are pulled
  // from any brain_dispatched payload that arrives.
  const counters: HeartbeatCounters = { events: 0, nodes: 0, proposals: 0, cycle: 1, maxCycles: 1 };
  const heartbeatEnabled = opts.heartbeat ?? Boolean(opts.task || opts.directive || opts.rootTaskId);
  // First heartbeat fires at t+FOLLOW_HEARTBEAT_MS (i.e. t+5s), NOT
  // immediately at t+0. That preserves the directive_opened line as the
  // FIRST visible row in the trailing-5-line panel, and ensures the
  // heartbeat fires DURING the pre-event window before any brain emit lands.
  const fireHeartbeat = () => {
    if (heartbeatEnabled && Date.now() - startedAt <= FOLLOW_HEARTBEAT_WINDOW_MS) {
      console.log(formatFollowHeartbeat(startedAt, counters));
    }
  };
  const heartbeatTimer = heartbeatEnabled ? setInterval(fireHeartbeat, FOLLOW_HEARTBEAT_MS) : null;
  heartbeatTimer?.unref?.();
  // Also wire process-signal abort so SIGTERM/SIGINT triggers abort cleanly
  // and the exit-code path below reports an honest "didn't see terminal".
  const onSig = () => ac.abort();
  process.once("SIGTERM", onSig);
  process.once("SIGINT", onSig);
  try {
    for await (const ev of sseConnect({ signal: ac.signal, reconnect: true })) {
      // SseEvent shape: { event_id, kind, ts, directive_id?, task_id?, substrate_origin?, payload? }
      // matches EventLike directly — no .data unwrap.
      const e = ev as unknown as EventLike;
      if (opts.task && !(e.task_id ?? "").startsWith(opts.task)) continue;
      if (opts.directive && !(e.directive_id ?? "").startsWith(opts.directive)) continue;
      counters.events++;
      counters.lastKind = e.kind;
      counters.lastEventAt = Date.now();
      if (e.kind === "task_node_opened") counters.nodes++;
      if (e.kind === "contract_amendment_proposed" || e.kind === "lesson_extracted") counters.proposals++;
      if (e.kind === "brain_dispatched") {
        const p = parsePayload(e.payload);
        if (typeof p.cycle === "number") counters.cycle = p.cycle as number;
        if (typeof p.max_cycles === "number") counters.maxCycles = p.max_cycles as number;
      }
      if (opts.kinds && opts.kinds.length > 0) {
        if (!opts.kinds.includes(e.kind ?? "")) continue;
      } else if (opts.kind && e.kind !== opts.kind) continue;
      const line = formatEvent(e, { verbose: opts.verbose });
      if (line) console.log(line);
      if (TERMINAL_KINDS.has(e.kind ?? "")) {
        // When a rootTaskId is specified (typical for `acc task` which
        // follows the whole directive subtree but should exit only on
        // the ROOT task's terminal), accept terminal events from
        // sub-tasks as informational and continue. Only the root task's
        // terminal closes the stream.
        const isRootTerminal = !opts.rootTaskId || (e.task_id === opts.rootTaskId);
        if (isRootTerminal) {
          sawTerminal = true;
          if (exitOnTerminal) {
            ac.abort();
            return 0;
          }
        }
      }
    }
  } catch (err) {
    if (ac.signal.aborted) {
      if (sawTerminal) return 0;
      if (deadlineMs) {
        console.error("acc tail: deadline exceeded (no terminal event)");
        return 2;
      }
      // Aborted (likely SIGTERM/SIGINT) before any terminal event landed.
      // Report this honestly — exit code 0 would imply "directive completed"
      // and confuse callers (live evidence: bd80w5fsx + bj6umku93 reported
      // exit 0 when actually killed mid-flight by the operator).
      console.error("acc tail: aborted before any terminal event (directive may still be in-flight)");
      return 3;
    }
    console.error(`acc tail: ${(err as Error).message}`);
    return 1;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    process.off("SIGTERM", onSig);
    process.off("SIGINT", onSig);
  }
  // SSE generator returned gracefully without abort — only happens when
  // reconnect=false and a fatal error occurs OR when signal aborts during
  // a backoff sleep. With reconnect=true the generator should not exhaust.
  if (sawTerminal) return 0;
  console.error("acc tail: SSE stream closed before any terminal event (daemon may have stopped)");
  return 3;
};

// Polling fallback (kept for when SSE cannot connect — e.g. daemon down at
// start, restricted network). Server caps at k=200; we re-poll every pollMs.
const runTailPoll = async (opts: TailOpts): Promise<number> => {
  const pollMs = opts.pollMs ?? 2000;
  const exitOnTerminal = opts.exitOnTerminal ?? Boolean(opts.task || opts.directive);
  const deadlineMs = opts.deadlineMs;
  const seen = new Set<string>();
  const startedAt = Date.now();
  const counters: HeartbeatCounters = { events: 0, nodes: 0, proposals: 0, cycle: 1, maxCycles: 1 };
  // First heartbeat scheduled for t+FOLLOW_HEARTBEAT_MS — NOT t+0. Same
  // contract as the SSE path: panel sees directive_opened first, then a
  // running waiting-on-brain line every 5s.
  let nextHeartbeatAt = startedAt + FOLLOW_HEARTBEAT_MS;
  const heartbeatEnabled = opts.heartbeat ?? Boolean(opts.task || opts.directive || opts.rootTaskId);

  while (true) {
    if (heartbeatEnabled && Date.now() >= nextHeartbeatAt && Date.now() - startedAt <= FOLLOW_HEARTBEAT_WINDOW_MS) {
      console.log(formatFollowHeartbeat(startedAt, counters));
      nextHeartbeatAt = Date.now() + FOLLOW_HEARTBEAT_MS;
    }
    let env;
    try {
      const args: Record<string, unknown> = { k: Math.min(200, opts.limit ?? 60) };
      if (opts.kinds && opts.kinds.length > 0) args.kinds = opts.kinds;
      else if (opts.kind) args.kinds = [opts.kind];
      env = await mcpCall("runtime.recent_events", args);
    } catch (err) {
      console.error(`acc tail: ${(err as Error).message}`);
      return 1;
    }
    if (!env.ok) {
      console.error(`acc tail: ${env.error}`);
      return 1;
    }
    const evs = ((env.result as { events?: EventLike[] })?.events ?? []) as EventLike[];
    let sawTerminal: EventLike | null = null;
    for (const e of evs) {
      const id = eventId(e);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (opts.task && !(e.task_id ?? "").startsWith(opts.task)) continue;
      if (opts.directive && !(e.directive_id ?? "").startsWith(opts.directive)) continue;
      counters.events++;
      counters.lastKind = e.kind;
      counters.lastEventAt = Date.now();
      if (e.kind === "task_node_opened") counters.nodes++;
      if (e.kind === "contract_amendment_proposed" || e.kind === "lesson_extracted") counters.proposals++;
      if (e.kind === "brain_dispatched") {
        const p = parsePayload(e.payload);
        if (typeof p.cycle === "number") counters.cycle = p.cycle as number;
        if (typeof p.max_cycles === "number") counters.maxCycles = p.max_cycles as number;
      }
      if (opts.kinds && opts.kinds.length > 0) {
        if (!opts.kinds.includes(e.kind ?? "")) continue;
      } else if (opts.kind && e.kind !== opts.kind) continue;
      const line = formatEvent(e, { verbose: opts.verbose });
      if (line) console.log(line);
      if (TERMINAL_KINDS.has(e.kind ?? "")) {
        const isRootTerminal = !opts.rootTaskId || (e.task_id === opts.rootTaskId);
        if (isRootTerminal) sawTerminal = e;
      }
    }
    if (sawTerminal && exitOnTerminal) return 0;
    if (deadlineMs && Date.now() > deadlineMs) {
      console.error("acc tail: deadline exceeded (no terminal event)");
      return 2;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
};

export const runTail = async (opts: TailOpts): Promise<number> => {
  // Default to SSE — Claude-native push, no poll lag, no missed events.
  // Operator can force polling with --no-stream / stream=false.
  if (opts.stream === false) return runTailPoll(opts);
  return runTailStream(opts);
};

// ── acc graph ──────────────────────────────────────────────────────

export const runGraph = async (directiveId: string): Promise<number> => {
  let env;
  try {
    env = await mcpCall("substrate.read", {
      view_name: "task_graph_view",
      args: { directive_id: directiveId },
    });
  } catch (err) {
    console.error(`acc graph: ${(err as Error).message}`);
    return 1;
  }
  if (!env.ok) {
    console.error(`acc graph: ${env.error}`);
    return 1;
  }
  const rows = (env.result as Array<Record<string, unknown>>) ?? [];
  const nodes = rows
    .filter((r) => r.row_kind === "node")
    .map((r) => ({
      task_id: r.task_id as string,
      parent_task_id: r.parent_task_id as string | null,
      payload: parsePayload(r.payload),
    }))
    .sort((a, b) => (Number(a.payload.rank ?? 99) - Number(b.payload.rank ?? 99)));
  const edges = rows.filter((r) => r.row_kind === "edge");
  console.log(`directive ${directiveId}`);
  console.log(`nodes: ${nodes.length}  edges: ${edges.length}`);
  console.log();
  for (const n of nodes) {
    const rank = n.payload.rank !== undefined ? `rank=${n.payload.rank}` : "       ";
    const parent = n.parent_task_id ? ` parent=${idPrefix(n.parent_task_id, 16)}` : "";
    const goal = trunc(n.payload.goal as string, 140);
    console.log(`▸ ${n.task_id.padEnd(34)} ${rank}${parent}`);
    if (goal) console.log(`   ${goal}`);
    const docs = n.payload.docs_sections as string[] | undefined;
    if (docs?.length) console.log(`   cites: ${docs.join(" · ")}`);
    const recipes = n.payload.tier0_recipe_refs as string[] | undefined;
    if (recipes?.length) console.log(`   tier-0: ${recipes.slice(0, 4).map((x) => idPrefix(x, 12)).join(", ")}`);
    console.log();
  }
  if (edges.length > 0) {
    console.log("edges:");
    for (const e of edges) {
      const p = parsePayload(e.payload);
      const kind = (p.kind as string) ?? "?";
      const from = idPrefix((p.from_task as string) ?? (p.from as string), 18);
      const to = idPrefix((p.to_task as string) ?? (p.to as string), 18);
      console.log(`  ${kind.padEnd(10)} ${from} → ${to}`);
    }
  }
  return 0;
};

// ── acc inspect ────────────────────────────────────────────────────

export const runInspect = async (taskId: string): Promise<number> => {
  let env;
  try {
    env = await mcpCall("runtime.recent_events", { k: 200 });
  } catch (err) {
    console.error(`acc inspect: ${(err as Error).message}`);
    return 1;
  }
  if (!env.ok) {
    console.error(`acc inspect: ${env.error}`);
    return 1;
  }
  const evs = ((env.result as { events?: EventLike[] })?.events ?? []) as EventLike[];
  // Server returns ts-ascending; no reverse.
  const taskEvs = evs.filter((e) => (e.task_id ?? "").startsWith(taskId));
  if (taskEvs.length === 0) {
    console.error(`acc inspect: no events for task starting with ${taskId} (recent window)`);
    return 1;
  }
  console.log(`task ${taskEvs[0]!.task_id}`);
  const kinds: Record<string, number> = {};
  for (const e of taskEvs) kinds[e.kind ?? "?"] = (kinds[e.kind ?? "?"] ?? 0) + 1;
  console.log(`events: ${taskEvs.length}`);
  const counts = Object.entries(kinds).sort((a, b) => b[1] - a[1]);
  for (const [k, n] of counts) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log();
  console.log("chronological:");
  for (const e of taskEvs) {
    const line = formatEvent(e, { verbose: true });
    if (line) console.log("  " + line);
  }
  return 0;
};

// ── CLI dispatch ───────────────────────────────────────────────────

const parseFlags = (argv: string[]): Record<string, string | boolean> => {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out[a.slice(2)] = next;
          i++;
        } else {
          out[a.slice(2)] = true;
        }
      }
    }
  }
  return out;
};

/** Mirror-inline event kind set — every event the orchestrator MUST
 *  surface to the operator inline per .claude/rules/orchestrator-runtime.md
 *  "Background command observability". `acc notify` is the CLI surface
 *  that subscribes to exactly this set. Sourced from the canonical
 *  registry's `mirror_inline: true` flag so the two cannot drift.
 *  (Imported alongside EVENT_KINDS at the top of this module.) */

/** `acc notify` — Claude Code chat-friendly event stream. Thin alias
 *  over `runTail` with the mirror-inline kind set pre-filled. Defaults
 *  to `--follow` (SSE stream) when invoked without args, since the
 *  whole point is to watch for HIDL / apply / dispatcher-violation
 *  events in real time. Without --follow, prints the most recent N
 *  matching rows and exits. */
export const runNotify = async (argv: string[]): Promise<number> => {
  const flags = parseFlags(argv);
  const kinds = Array.from(MIRROR_INLINE_EVENT_TYPES);
  if (kinds.length === 0) {
    // No kinds registered yet — guidance instead of silent no-op.
    console.error("acc notify: no event kinds are registered with mirror_inline=true. " +
      "Either you're on a very old build (the HIDL kind landed 2026-05-15) or the registry is empty. " +
      "Try `acc events --kind hidl_action_required` to inspect manually.");
    return 1;
  }
  // --no-follow → one-shot; default is follow (the canonical Claude
  // Code chat-stream use). `acc notify --no-follow --limit N` prints
  // the most recent matching rows and exits 0.
  const noFollow = Boolean(flags["no-follow"]);
  if (noFollow) {
    return runEvents({
      kinds,
      limit: flags.limit ? Number(flags.limit) : undefined,
      verbose: Boolean(flags.verbose),
    });
  }
  return runTail({
    kinds,
    limit: flags.limit ? Number(flags.limit) : undefined,
    pollMs: flags["poll-ms"] ? Number(flags["poll-ms"]) : undefined,
    deadlineMs: flags.timeout
      ? Date.now() + Number(flags.timeout) * 1000
      : undefined,
    stream: flags["no-stream"] ? false : (flags.stream !== false),
    verbose: Boolean(flags.verbose),
  });
};

export const runObserve = async (cmd: string, argv: string[]): Promise<number> => {
  const flags = parseFlags(argv);
  switch (cmd) {
    case "events":
      return runEvents({
        limit: flags.limit ? Number(flags.limit) : undefined,
        task: typeof flags.task === "string" ? flags.task : undefined,
        directive: typeof flags.directive === "string" ? flags.directive : undefined,
        kind: typeof flags.kind === "string" ? flags.kind : undefined,
        verbose: Boolean(flags.verbose),
      });
    case "tail":
      return runTail({
        limit: flags.limit ? Number(flags.limit) : undefined,
        task: typeof flags.task === "string" ? flags.task : undefined,
        directive: typeof flags.directive === "string" ? flags.directive : undefined,
        kind: typeof flags.kind === "string" ? flags.kind : undefined,
        verbose: Boolean(flags.verbose),
        pollMs: flags["poll-ms"] ? Number(flags["poll-ms"]) : undefined,
        deadlineMs: flags.timeout
          ? Date.now() + Number(flags.timeout) * 1000
          : undefined,
        // Default = SSE stream. `--no-stream` forces polling fallback.
        stream: flags["no-stream"] ? false : (flags.stream !== false),
      });
    case "graph": {
      const did = argv.find((a) => !a.startsWith("--"));
      if (!did) {
        console.error("acc graph: requires <directive_id>");
        return 1;
      }
      return runGraph(did);
    }
    case "inspect": {
      const tid = argv.find((a) => !a.startsWith("--"));
      if (!tid) {
        console.error("acc inspect: requires <task_id>");
        return 1;
      }
      return runInspect(tid);
    }
    default:
      console.error(`acc observe: unknown subcommand '${cmd}'`);
      return 1;
  }
};

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "";
  void runObserve(cmd, argv.slice(1)).then((code) => process.exit(code));
}
