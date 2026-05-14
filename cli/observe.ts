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

import { mcpCall } from "./rpc";

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

const trunc = (s: string | undefined, n: number): string => {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
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
};

const formatPayload = (kind: string, p: Record<string, unknown>): string => {
  // Per-kind structured rendering. Returns a "key=value key=value" suffix.
  switch (kind) {
    case "directive_opened": {
      const text = (p.directive_text as string) ?? (p.text as string) ?? "";
      const lifecycle = p.lifecycle as string | undefined;
      return `text=${JSON.stringify(trunc(text, 100))}${lifecycle ? ` lifecycle=${lifecycle}` : ""}`;
    }
    case "task_node_opened": {
      const goal = p.goal as string | undefined;
      const rank = p.rank;
      const urgency = p.urgency as string | undefined;
      return [
        rank !== undefined ? `rank=${rank}` : "",
        urgency && urgency !== "normal" ? `urgency=${urgency}` : "",
        goal ? `goal=${JSON.stringify(trunc(goal, 140))}` : "",
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
        intent ? `intent=${JSON.stringify(trunc(intent, 80))}` : "",
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
      const reason = (p.reason as string) ?? "?";
      return `reason=${reason}`;
    }
    case "knowledge_candidate":
    case "knowledge_promoted": {
      const claim = (p.claim as string) ?? (p.text as string) ?? "";
      const score = p.score;
      return `${claim ? `claim=${JSON.stringify(trunc(claim, 100))}` : ""}${score !== undefined ? ` score=${score}` : ""}`.trim();
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
    default:
      return "";
  }
};

/** Format one event as a single line suitable for piped consumption.
 *  Returns "" when the event should be suppressed (frames in non-verbose mode). */
export const formatEvent = (ev: EventLike, opts: { verbose?: boolean } = {}): string => {
  if (!opts.verbose && FRAME_KINDS.has(ev.kind ?? "")) return "";
  const ts = (ev.ts ?? "").slice(11, 19);
  const kind = ev.kind ?? "?";
  const glyph = GLYPHS[kind] ?? " ";
  const task = idPrefix(ev.task_id, 16);
  const payload = parsePayload(ev.payload);
  const suffix = formatPayload(kind, payload);
  const failureKind = ev.failure_kind ? ` failure_kind=${ev.failure_kind}` : "";
  return `${ts} ${glyph.padEnd(3)} ${kind.padEnd(28)} task=${task.padEnd(16)} ${suffix}${failureKind}`.trimEnd();
};

// ── acc events ─────────────────────────────────────────────────────

export type EventsOpts = {
  limit?: number;
  task?: string;      // task_id prefix filter
  directive?: string; // directive_id prefix filter
  kind?: string;      // event kind filter (exact)
  verbose?: boolean;
};

export const runEvents = async (opts: EventsOpts): Promise<number> => {
  const k = Math.min(200, opts.limit ?? 30);  // server caps at 200
  let env;
  try {
    // runtime.recent_events takes `k` (count, ≤200) and optional `kinds` (string[]
    // filter). When `--kind` is set, pass it to the server so we don't burn the
    // window on irrelevant rows.
    const args: Record<string, unknown> = { k };
    if (opts.kind) args.kinds = [opts.kind];
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
    // kind already server-filtered when set; double-check (no-op when filtered server-side)
    if (opts.kind && e.kind !== opts.kind) continue;
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
};

export const runTail = async (opts: TailOpts): Promise<number> => {
  const pollMs = opts.pollMs ?? 2000;
  const exitOnTerminal = opts.exitOnTerminal ?? Boolean(opts.task || opts.directive);
  const deadlineMs = opts.deadlineMs;
  const seen = new Set<string>();

  while (true) {
    let env;
    try {
      const args: Record<string, unknown> = { k: Math.min(200, opts.limit ?? 60) };
      if (opts.kind) args.kinds = [opts.kind];
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
    // Server returns ts-ascending; emit only fresh ids.
    let sawTerminal: EventLike | null = null;
    for (const e of evs) {
      const id = eventId(e);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (opts.task && !(e.task_id ?? "").startsWith(opts.task)) continue;
      if (opts.directive && !(e.directive_id ?? "").startsWith(opts.directive)) continue;
      if (opts.kind && e.kind !== opts.kind) continue;
      const line = formatEvent(e, { verbose: opts.verbose });
      if (line) console.log(line);
      if (TERMINAL_KINDS.has(e.kind ?? "")) sawTerminal = e;
    }
    if (sawTerminal && exitOnTerminal) {
      return 0;
    }
    if (deadlineMs && Date.now() > deadlineMs) {
      console.error(`acc tail: deadline exceeded (no terminal event)`);
      return 2;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
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
