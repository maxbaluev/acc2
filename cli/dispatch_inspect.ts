// acc dispatch <directive_id> — canonical substrate-truth dispatch inspector.
//
// Replaces the ad-hoc `/tmp/check_*.ts` scripts the orchestrator wrote ~12
// times this session to inspect dispatch state. Per
// `.claude/rules/orchestrator-runtime.md` "Dispatch Observation Protocol"
// the Claude Code Bash background-task panel is NOT authoritative — the
// substrate event ledger is. This command is the one canonical surface the
// operator/orchestrator reaches for when answering "what happened on this
// dispatch?". Cites retrievals 6AKGJNZRB17D / CWHW11YRJH6A / 293XPEQVCH7B.
//
// Surface:
//   acc dispatch <id_prefix>         pretty terminal report (ANSI badges)
//   acc dispatch <id_prefix> --json  structured JSON for orchestrator consumption
//
// Prefix resolution: directive_id may be passed as a prefix as short as 6
// chars. Ambiguous prefix → list candidates + exit 1. Missing → exit 1.

import type { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { resolveDbPath } from "../runtime/state_paths";
import {
  dispatchResolved,
  runViews,
  taskGraphFor,
  type DispatchResolvedRow,
} from "../substrate/views";

type DispatchInspectEnv = {
  out: (s: string) => void;
  err: (s: string) => void;
  stateDbPath?: string;
  openSubstrate?: (path?: string) => Database;
  color?: boolean;
};

const defaultEnv = (): DispatchInspectEnv => ({
  out: (s) => console.log(s),
  err: (s) => console.error(s),
  color: !!process.stdout.isTTY,
});

// ── Types (the structured shape the JSON renderer + tests consume) ─────

export type TaskNode = {
  task_id: string;
  parent_task_id: string | null;
  goal: string;
  opened_ts: string;
  terminal_kind: "task_committed" | "task_failed" | null;
  terminal_ts: string | null;
  /** Computed by inspectDispatch from terminal events + DAG context. */
  status: "committed" | "failed" | "live" | "pending";
};

export type KCSummary = {
  event_id: string;
  ts: string;
  task_id: string;
  claim: string;
  payload_preview: string;
};

export type ArtifactSummary = {
  event_id: string;
  ts: string;
  task_id: string;
  kind: string;
  name: string;
  body_len: number;
};

export type RefinementEdge = {
  event_id: string;
  ts: string;
  task_id: string;
  edge_kind: string;
  from_task: string;
  to_task: string;
};

export type ContractAmendment = {
  event_id: string;
  ts: string;
  task_id: string;
  current_behavior: string;
  proposed_behavior: string;
};

export type ClosureAudit = {
  event_id: string;
  ts: string;
  task_id: string;
  closure_residual: number | null;
  status: string | null;
  verdict: string | null;
};

export type DispatchInspection = {
  directive: {
    id: string;
    root_task_id: string | null;
    owner_input: string;
    opened_ts: string;
    status: "completed" | "failed" | "live" | "queued_at_cap" | "zombie" | "unknown";
    evidence_event_id: string | null;
    dispatch_row: DispatchResolvedRow | null;
  };
  tasks: TaskNode[];
  kcs_by_task: Record<string, KCSummary[]>;
  artifacts_by_task: Record<string, ArtifactSummary[]>;
  refinement_edges: RefinementEdge[];
  contract_amendments: ContractAmendment[];
  closure_audits: ClosureAudit[];
};

// ── Errors ─────────────────────────────────────────────────────────────

export class AmbiguousPrefixError extends Error {
  candidates: string[];
  constructor(prefix: string, candidates: string[]) {
    super(`acc dispatch: ambiguous directive prefix '${prefix}' matches ${candidates.length} directives`);
    this.candidates = candidates;
    this.name = "AmbiguousPrefixError";
  }
}

export class DirectiveNotFoundError extends Error {
  constructor(public readonly prefix: string) {
    super(`acc dispatch: no directive found matching '${prefix}'`);
    this.name = "DirectiveNotFoundError";
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== "string") return raw as T;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

const flat = (s: string, n: number): string => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const shortId = (id: string | null | undefined, n = 8): string =>
  id ? (id.length > n ? id.slice(0, n) : id) : "-";

/** Resolve a directive prefix (>= 6 chars, or full id) to one canonical
 *  directive_id. Throws AmbiguousPrefixError when > 1 row matches, and
 *  DirectiveNotFoundError when 0 rows match. */
export const resolveDirectivePrefix = (db: Database, prefix: string): string => {
  if (!prefix) throw new DirectiveNotFoundError(prefix);
  // Exact-id fast path (cheap and avoids prefix-length policy).
  const exact = db.query("SELECT directive_id FROM events WHERE kind='directive_opened' AND directive_id=? LIMIT 1").get(prefix) as { directive_id: string } | null;
  if (exact) return exact.directive_id;
  if (prefix.length < 6) {
    // Refuse short non-exact prefixes — too many spurious matches under high event counts.
    throw new DirectiveNotFoundError(prefix);
  }
  const rows = db
    .query("SELECT DISTINCT directive_id FROM events WHERE kind='directive_opened' AND directive_id LIKE ? ORDER BY directive_id LIMIT 5")
    .all(`${prefix}%`) as Array<{ directive_id: string }>;
  if (rows.length === 0) throw new DirectiveNotFoundError(prefix);
  if (rows.length > 1) throw new AmbiguousPrefixError(prefix, rows.map((r) => r.directive_id));
  return rows[0]!.directive_id;
};

const ownerInputFor = (payload: Record<string, unknown>): string => {
  for (const key of ["directive_text", "text", "owner_input", "goal", "summary"]) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
};

const lifecycleStatus = (row: DispatchResolvedRow | null): DispatchInspection["directive"]["status"] => {
  if (!row) return "unknown";
  const s = row.lifecycle_status ?? row.status;
  if (s === "completed") return "completed";
  if (s === "failed") return "failed";
  if (s === "queued_at_cap") return "queued_at_cap";
  if (s === "zombie") return "zombie";
  if (s === "live" || s === "live_amended") return "live";
  return "unknown";
};

// ── Core projection ────────────────────────────────────────────────────

export const inspectDispatch = (db: Database, directiveIdOrPrefix: string): DispatchInspection => {
  runViews(db);
  const directiveId = resolveDirectivePrefix(db, directiveIdOrPrefix);

  // directive_opened (canonical event)
  const directiveRow = db.query(
    "SELECT id, ts, task_id, payload FROM events WHERE kind='directive_opened' AND directive_id=? ORDER BY ts ASC LIMIT 1",
  ).get(directiveId) as { id: string; ts: string; task_id: string; payload: string } | null;
  if (!directiveRow) throw new DirectiveNotFoundError(directiveIdOrPrefix);
  const directivePayload = parseJson<Record<string, unknown>>(directiveRow.payload, {});

  // Dispatch resolution row (canonical lifecycle source).
  const dispatch = dispatchResolved(db, { directiveId });
  // dispatchResolved orders by latest_signal_at DESC; root row may not be
  // first. Prefer the row matching the directive's root task_id.
  const rootRow = dispatch.find((r) => r.root_task_id === directiveRow.task_id) ?? dispatch[0] ?? null;

  // Task DAG (nodes only — refinement edges fetched separately).
  const graph = taskGraphFor(db, directiveId);
  const nodes = graph.filter((g) => g.row_kind === "node");

  // Terminal events per task.
  const terminals = db.query(
    `SELECT id, ts, task_id, kind FROM events
     WHERE directive_id=? AND kind IN ('task_committed','task_failed')
     ORDER BY ts ASC`,
  ).all(directiveId) as Array<{ id: string; ts: string; task_id: string; kind: string }>;
  const terminalByTask = new Map<string, { kind: string; ts: string; id: string }>();
  for (const t of terminals) {
    // Keep the FIRST terminal for each task (later supersedes/duplicates ignored).
    if (!terminalByTask.has(t.task_id)) terminalByTask.set(t.task_id, t);
  }
  // brain_dispatched per task → live signal when no terminal recorded.
  const dispatchedTasks = new Set(
    (db.query(
      `SELECT DISTINCT task_id FROM events WHERE directive_id=? AND kind='brain_dispatched'`,
    ).all(directiveId) as Array<{ task_id: string }>).map((r) => r.task_id),
  );

  const tasks: TaskNode[] = nodes.map((n) => {
    const term = terminalByTask.get(n.task_id);
    const terminal_kind = term ? (term.kind as "task_committed" | "task_failed") : null;
    let status: TaskNode["status"];
    if (terminal_kind === "task_committed") status = "committed";
    else if (terminal_kind === "task_failed") status = "failed";
    else if (dispatchedTasks.has(n.task_id)) status = "live";
    else status = "pending";
    const goal = String(n.payload.goal ?? n.payload.text ?? n.payload.summary ?? "").trim();
    return {
      task_id: n.task_id,
      parent_task_id: n.parent_task_id,
      goal,
      opened_ts: n.ts,
      terminal_kind,
      terminal_ts: term ? term.ts : null,
      status,
    };
  });

  // Topological-ish order: roots first (parent_task_id null), then by opened_ts.
  // For acyclic DAGs that v2's task_dispatcher emits, this is enough; full
  // toposort would require an extra dependency edge query.
  tasks.sort((a, b) => {
    const ra = a.parent_task_id === null ? 0 : 1;
    const rb = b.parent_task_id === null ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return a.opened_ts.localeCompare(b.opened_ts);
  });

  // KCs grouped by task.
  const kcRows = db.query(
    `SELECT id, ts, task_id, payload FROM events
     WHERE directive_id=? AND kind='knowledge_candidate'
     ORDER BY ts ASC`,
  ).all(directiveId) as Array<{ id: string; ts: string; task_id: string; payload: string }>;
  const kcs_by_task: Record<string, KCSummary[]> = {};
  for (const r of kcRows) {
    const payload = parseJson<Record<string, unknown>>(r.payload, {});
    const claim = String(payload.claim ?? payload.text ?? "").trim();
    const preview = claim || flat(JSON.stringify(payload), 200);
    const bucket = kcs_by_task[r.task_id] ?? (kcs_by_task[r.task_id] = []);
    bucket.push({
      event_id: r.id,
      ts: r.ts,
      task_id: r.task_id,
      claim: flat(claim, 200),
      payload_preview: flat(preview, 200),
    });
  }

  // code_artifact_candidate grouped by task.
  const artifactRows = db.query(
    `SELECT id, ts, task_id, payload FROM events
     WHERE directive_id=? AND kind='code_artifact_candidate'
     ORDER BY ts ASC`,
  ).all(directiveId) as Array<{ id: string; ts: string; task_id: string; payload: string }>;
  const artifacts_by_task: Record<string, ArtifactSummary[]> = {};
  for (const r of artifactRows) {
    const payload = parseJson<Record<string, unknown>>(r.payload, {});
    const body = String(payload.body ?? payload.code ?? "");
    const kind = String(payload.kind ?? payload.runtime ?? "code_artifact");
    const name = String(payload.name ?? payload.id ?? payload.artifact_id ?? "");
    const bucket = artifacts_by_task[r.task_id] ?? (artifacts_by_task[r.task_id] = []);
    bucket.push({
      event_id: r.id,
      ts: r.ts,
      task_id: r.task_id,
      kind,
      name: flat(name, 80),
      body_len: body.length,
    });
  }

  // refinement_edges (task_edge_recorded rows with kind=refines).
  const edgeRows = db.query(
    `SELECT id, ts, task_id, payload FROM events
     WHERE directive_id=? AND kind='task_edge_recorded'
     ORDER BY ts ASC`,
  ).all(directiveId) as Array<{ id: string; ts: string; task_id: string; payload: string }>;
  const refinement_edges: RefinementEdge[] = edgeRows.map((r) => {
    const p = parseJson<Record<string, unknown>>(r.payload, {});
    return {
      event_id: r.id,
      ts: r.ts,
      task_id: r.task_id,
      // Live ledger emits `edge_kind` (see brain emit + extractors); the
      // older `kind` payload alias is kept as a fallback for events
      // produced before the rename. `from_task_id`/`to_task_id` is the
      // canonical schema; `from_task`/`to_task` aliases survive in older
      // refinement edge payloads.
      edge_kind: String(p.edge_kind ?? p.kind ?? "?"),
      from_task: String(p.from_task_id ?? p.from_task ?? p.from ?? ""),
      to_task: String(p.to_task_id ?? p.to_task ?? p.to ?? ""),
    };
  });

  // contract_amendment_proposed.
  const amendRows = db.query(
    `SELECT id, ts, task_id, payload FROM events
     WHERE directive_id=? AND kind='contract_amendment_proposed'
     ORDER BY ts ASC`,
  ).all(directiveId) as Array<{ id: string; ts: string; task_id: string; payload: string }>;
  const contract_amendments: ContractAmendment[] = amendRows.map((r) => {
    const p = parseJson<Record<string, unknown>>(r.payload, {});
    return {
      event_id: r.id,
      ts: r.ts,
      task_id: r.task_id,
      current_behavior: flat(String(p.current_behavior ?? p.from ?? ""), 200),
      proposed_behavior: flat(String(p.proposed_behavior ?? p.to ?? ""), 200),
    };
  });

  // task_closure_audited.
  const closureRows = db.query(
    `SELECT id, ts, task_id, residual, payload FROM events
     WHERE directive_id=? AND kind='task_closure_audited'
     ORDER BY ts ASC`,
  ).all(directiveId) as Array<{ id: string; ts: string; task_id: string; residual: number | null; payload: string }>;
  const closure_audits: ClosureAudit[] = closureRows.map((r) => {
    const p = parseJson<Record<string, unknown>>(r.payload, {});
    const residualPayload = p.closure_residual;
    const residual = typeof residualPayload === "number" ? residualPayload : (r.residual ?? null);
    return {
      event_id: r.id,
      ts: r.ts,
      task_id: r.task_id,
      closure_residual: residual,
      status: typeof p.status === "string" ? p.status : null,
      verdict: typeof p.verdict === "string" ? p.verdict : null,
    };
  });

  return {
    directive: {
      id: directiveId,
      root_task_id: directiveRow.task_id ?? null,
      owner_input: ownerInputFor(directivePayload),
      opened_ts: directiveRow.ts,
      status: lifecycleStatus(rootRow),
      evidence_event_id: rootRow?.terminal_event_id ?? rootRow?.latest_event_id ?? null,
      dispatch_row: rootRow,
    },
    tasks,
    kcs_by_task,
    artifacts_by_task,
    refinement_edges,
    contract_amendments,
    closure_audits,
  };
};

// ── Pretty renderer ────────────────────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const STATUS_BADGE = (
  status: string,
  color: boolean,
): string => {
  const label = status.toUpperCase().padEnd(9);
  if (!color) return `[${label}]`;
  if (status === "completed" || status === "committed") return `${ANSI.green}[${label}]${ANSI.reset}`;
  if (status === "failed") return `${ANSI.red}[${label}]${ANSI.reset}`;
  if (status === "live" || status === "live_amended") return `${ANSI.yellow}[${label}]${ANSI.reset}`;
  if (status === "queued_at_cap") return `${ANSI.cyan}[${label}]${ANSI.reset}`;
  if (status === "zombie") return `${ANSI.red}[${label}]${ANSI.reset}`;
  return `${ANSI.gray}[${label}]${ANSI.reset}`;
};

const renderPretty = (
  inspection: DispatchInspection,
  out: (s: string) => void,
  color: boolean,
): void => {
  const d = inspection.directive;
  const bold = (s: string) => (color ? `${ANSI.bold}${s}${ANSI.reset}` : s);
  const dim = (s: string) => (color ? `${ANSI.dim}${s}${ANSI.reset}` : s);

  out(bold(`acc dispatch — substrate-truth inspection`));
  out(`directive_id : ${d.id}`);
  out(`root_task_id : ${d.root_task_id ?? "-"}`);
  out(`opened_ts    : ${d.opened_ts}`);
  out(`status       : ${STATUS_BADGE(d.status, color)}`);
  if (d.evidence_event_id) out(`evidence     : ${d.evidence_event_id}`);
  if (d.owner_input) out(`owner_input  : ${flat(d.owner_input, 200)}`);
  out("");

  // ── Task DAG ─────────────────────────────────────────────────────
  out(bold(`task DAG (${inspection.tasks.length} node${inspection.tasks.length === 1 ? "" : "s"}):`));
  if (inspection.tasks.length === 0) out(dim("  (none)"));
  // Build child map for indented rendering.
  const childMap = new Map<string | null, TaskNode[]>();
  for (const t of inspection.tasks) {
    const k = t.parent_task_id;
    const bucket = childMap.get(k) ?? [];
    bucket.push(t);
    childMap.set(k, bucket);
  }
  const seen = new Set<string>();
  const renderTask = (t: TaskNode, indent: number): void => {
    if (seen.has(t.task_id)) return;
    seen.add(t.task_id);
    const pad = "  " + "  ".repeat(indent);
    const badge = STATUS_BADGE(t.status, color);
    const ts = t.terminal_ts ?? t.opened_ts;
    out(`${pad}${badge} ${shortId(t.task_id, 10)} ${flat(t.goal, 96)} ${dim(ts)}`);
    const children = childMap.get(t.task_id) ?? [];
    for (const c of children) renderTask(c, indent + 1);
  };
  for (const root of (childMap.get(null) ?? [])) renderTask(root, 0);
  // Render any orphan tasks (parents not in DAG) at the root level.
  for (const t of inspection.tasks) if (!seen.has(t.task_id)) renderTask(t, 0);
  out("");

  // ── KCs ──────────────────────────────────────────────────────────
  const kcCount = Object.values(inspection.kcs_by_task).reduce((a, b) => a + b.length, 0);
  out(bold(`knowledge_candidate (${kcCount}):`));
  if (kcCount === 0) out(dim("  (none)"));
  for (const t of inspection.tasks) {
    const kcs = inspection.kcs_by_task[t.task_id];
    if (!kcs || kcs.length === 0) continue;
    out(`  ${shortId(t.task_id, 10)} (${kcs.length}):`);
    for (const kc of kcs) out(`    - ${flat(kc.claim || kc.payload_preview, 160)} ${dim(shortId(kc.event_id, 10))}`);
  }
  out("");

  // ── Artifacts ────────────────────────────────────────────────────
  const artCount = Object.values(inspection.artifacts_by_task).reduce((a, b) => a + b.length, 0);
  out(bold(`code_artifact_candidate (${artCount}):`));
  if (artCount === 0) out(dim("  (none)"));
  for (const t of inspection.tasks) {
    const arts = inspection.artifacts_by_task[t.task_id];
    if (!arts || arts.length === 0) continue;
    out(`  ${shortId(t.task_id, 10)} (${arts.length}):`);
    for (const a of arts) out(`    - kind=${a.kind} name=${a.name || "?"} body_len=${a.body_len} ${dim(shortId(a.event_id, 10))}`);
  }
  out("");

  // ── Refinement edges ─────────────────────────────────────────────
  out(bold(`refinement_edges (${inspection.refinement_edges.length}):`));
  if (inspection.refinement_edges.length === 0) out(dim("  (none)"));
  for (const e of inspection.refinement_edges) {
    out(`  ${e.edge_kind} ${shortId(e.from_task, 10)} → ${shortId(e.to_task, 10)} ${dim(e.ts)}`);
  }
  out("");

  // ── Contract amendments ──────────────────────────────────────────
  out(bold(`contract_amendment_proposed (${inspection.contract_amendments.length}):`));
  if (inspection.contract_amendments.length === 0) out(dim("  (none)"));
  for (const a of inspection.contract_amendments) {
    out(`  ${shortId(a.event_id, 10)} ${dim(a.ts)}`);
    if (a.current_behavior) out(`    from: ${a.current_behavior}`);
    if (a.proposed_behavior) out(`    to:   ${a.proposed_behavior}`);
  }
  out("");

  // ── Closure audits ───────────────────────────────────────────────
  out(bold(`task_closure_audited (${inspection.closure_audits.length}):`));
  if (inspection.closure_audits.length === 0) out(dim("  (none)"));
  for (const c of inspection.closure_audits) {
    const residual = c.closure_residual !== null ? c.closure_residual.toFixed(3) : "?";
    const verdict = c.verdict ? ` verdict=${c.verdict}` : "";
    const status = c.status ? ` status=${c.status}` : "";
    out(`  ${shortId(c.task_id, 10)} closure_residual=${residual}${verdict}${status} ${dim(shortId(c.event_id, 10))}`);
  }
  out("");

  // ── Final resolution line ────────────────────────────────────────
  const badge = STATUS_BADGE(d.status, color);
  const evidence = d.evidence_event_id ? ` evidence=${d.evidence_event_id}` : "";
  out(`${bold("dispatch resolution:")} ${badge} ${d.id}${evidence}`);
};

// ── Command entrypoint ─────────────────────────────────────────────────

const usage = (): string => [
  "acc dispatch — inspect a directive's full dispatch trajectory from the event ledger",
  "",
  "Usage:",
  "  acc dispatch <directive_id_or_prefix> [--json] [--no-color]",
  "",
  "Surfaces directive metadata, the task DAG, terminal status per task,",
  "knowledge_candidate + code_artifact_candidate emissions grouped by task,",
  "refinement edges, contract amendments, and closure audit residuals.",
  "Replaces the ad-hoc /tmp/check_*.ts inspection scripts the orchestrator",
  "used to write — one canonical substrate-truth surface per",
  ".claude/rules/orchestrator-runtime.md.",
  "",
  "Prefix resolution: accepts the full 26-char directive_id or any prefix",
  ">= 6 chars. Ambiguous prefixes are rejected with the candidate list.",
].join("\n");

export const runDispatchInspect = async (
  argv: string[],
  envOverride?: Partial<DispatchInspectEnv>,
): Promise<number> => {
  const env: DispatchInspectEnv = { ...defaultEnv(), ...(envOverride ?? {}) };
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    env.out(usage());
    return argv.length === 0 ? 1 : 0;
  }
  const wantJson = argv.includes("--json");
  const noColor = argv.includes("--no-color");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const directiveArg = positional[0];
  if (!directiveArg) {
    env.err("acc dispatch: missing <directive_id_or_prefix>");
    env.out(usage());
    return 1;
  }

  const path = env.stateDbPath ?? resolveDbPath();
  let db: Database;
  try {
    db = (env.openSubstrate ?? ((p?: string) => openDb(p ?? resolveDbPath())))(path);
  } catch (err) {
    env.err(`acc dispatch: failed to open substrate: ${(err as Error).message}`);
    return 1;
  }

  let inspection: DispatchInspection;
  try {
    inspection = inspectDispatch(db, directiveArg);
  } catch (err) {
    if (err instanceof AmbiguousPrefixError) {
      env.err(`acc dispatch: prefix '${directiveArg}' is ambiguous (${err.candidates.length} matches):`);
      for (const c of err.candidates) env.err(`  ${c}`);
      return 1;
    }
    if (err instanceof DirectiveNotFoundError) {
      env.err(`acc dispatch: directive not found for '${directiveArg}'`);
      return 1;
    }
    env.err(`acc dispatch: ${(err as Error).message}`);
    return 1;
  }

  if (wantJson) {
    env.out(JSON.stringify(inspection, null, 2));
  } else {
    const color = env.color !== false && !noColor;
    renderPretty(inspection, env.out, color);
  }
  return 0;
};

if (import.meta.main) {
  void runDispatchInspect(process.argv.slice(2)).then((code) => process.exit(code));
}
