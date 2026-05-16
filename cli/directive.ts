// acc directive — single-directive inspection + lifecycle operator commands.

import type { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { resolveDbPath } from "../runtime/state_paths";
import { emitEvent } from "../runtime/events";
import {
  directiveConflicts,
  dispatchResolved,
  irreversibleEffects,
  readyTasks,
  rollingReviewDue,
  runViews,
  stakeholderStateRows,
  taskGraphFor,
} from "../substrate/views";
import { formatEvent, NARRATIVE_KINDS } from "./observe";

type DirectiveEnv = {
  out: (s: string) => void;
  err: (s: string) => void;
  stateDbPath?: string;
  openSubstrate?: (path?: string) => Database;
};

type EventRow = {
  id: string;
  event_id: string;
  ts: string;
  kind: string;
  directive_id: string;
  task_id: string;
  parent_task_id: string | null;
  substrate_origin: string;
  payload: Record<string, unknown>;
  context_refs: string[];
  predicted_residual: number | null;
  action_artifact_id: string | null;
  verifier_artifact_id: string | null;
  outcome: string | null;
  residual: number | null;
  failure_kind: string | null;
};

type DirectiveInspection = {
  directive_id: string;
  directive: EventRow | null;
  dispatch: ReturnType<typeof dispatchResolved>;
  ready_tasks: ReturnType<typeof readyTasks>;
  task_graph: {
    nodes: ReturnType<typeof taskGraphFor>;
    edges: ReturnType<typeof taskGraphFor>;
    refinement_edges: ReturnType<typeof taskGraphFor>;
  };
  amendments: EventRow[];
  stakeholders: ReturnType<typeof stakeholderStateRows>;
  conflicts: {
    interference: ReturnType<typeof directiveConflicts>;
    stakeholder_events: EventRow[];
  };
  rolling_reviews: {
    schedule: ReturnType<typeof rollingReviewDue>;
    events: EventRow[];
  };
  closure_audits: EventRow[];
  applied_changes: EventRow[];
  irreversible_effects: {
    summary: ReturnType<typeof irreversibleEffects>[number] | null;
    events: EventRow[];
  };
  recent_narrative_events: EventRow[];
};

const defaultEnv = (): DirectiveEnv => ({ out: (s) => console.log(s), err: (s) => console.error(s) });
const shortId = (id: string | null | undefined, n = 16): string => id ? (id.length > n ? id.slice(0, n) : id) : "-";
const flat = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}...` : one;
};
const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== "string") return raw as T;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};
const eventText = (event: EventRow): string => {
  for (const key of ["directive_text", "text", "goal", "summary", "reason", "claim", "target_resource", "target"]) {
    const value = event.payload[key];
    if (typeof value === "string" && value.trim()) return flat(value, 96);
  }
  return "";
};
const edgeKind = (payload: Record<string, unknown>): string => String(payload.kind ?? payload.edge_kind ?? "?");
const edgeFrom = (payload: Record<string, unknown>): string => String(payload.from_task ?? payload.from ?? "?");
const edgeTo = (payload: Record<string, unknown>): string => String(payload.to_task ?? payload.to ?? "?");
const goalOf = (payload: Record<string, unknown>): string => String(payload.goal ?? payload.text ?? "");

const mapEvent = (row: Record<string, unknown>): EventRow => ({
  id: row.id as string,
  event_id: row.id as string,
  ts: row.ts as string,
  kind: row.kind as string,
  directive_id: row.directive_id as string,
  task_id: row.task_id as string,
  parent_task_id: (row.parent_task_id as string | null) ?? null,
  substrate_origin: row.substrate_origin as string,
  payload: parseJson<Record<string, unknown>>(row.payload, {}),
  context_refs: parseJson<string[]>(row.context_refs, []),
  predicted_residual: row.predicted_residual == null ? null : Number(row.predicted_residual),
  action_artifact_id: (row.action_artifact_id as string | null) ?? null,
  verifier_artifact_id: (row.verifier_artifact_id as string | null) ?? null,
  outcome: (row.outcome as string | null) ?? null,
  residual: row.residual == null ? null : Number(row.residual),
  failure_kind: (row.failure_kind as string | null) ?? null,
});

const eventsFor = (db: Database, directiveId: string, kinds?: string[], limit?: number): EventRow[] => {
  const params: Array<string | number> = [directiveId];
  const kindSql = kinds && kinds.length > 0 ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
  if (kinds) params.push(...kinds);
  const limitSql = limit ? ` LIMIT ${Math.max(1, Math.floor(limit))}` : "";
  const rows = db.query(`SELECT * FROM events WHERE directive_id = ?${kindSql} ORDER BY ts DESC${limitSql}`).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapEvent).reverse();
};

export const inspectDirective = (db: Database, directiveId: string, opts: { narrativeLimit?: number } = {}): DirectiveInspection => {
  runViews(db);
  const narrativeLimit = Math.max(1, Math.floor(opts.narrativeLimit ?? 30));
  const allEvents = eventsFor(db, directiveId);
  const graph = taskGraphFor(db, directiveId);
  const rolling = rollingReviewDue(db).filter((r) => r.directive_id === directiveId);
  const effects = irreversibleEffects(db).find((r) => r.directive_id === directiveId) ?? null;
  const narrative = allEvents.filter((e) => NARRATIVE_KINDS.has(e.kind)).slice(-narrativeLimit);
  return {
    directive_id: directiveId,
    directive: allEvents.find((e) => e.kind === "directive_opened") ?? null,
    dispatch: dispatchResolved(db, { directiveId }),
    ready_tasks: readyTasks(db).filter((r) => r.directive_id === directiveId),
    task_graph: {
      nodes: graph.filter((r) => r.row_kind === "node"),
      edges: graph.filter((r) => r.row_kind === "edge"),
      refinement_edges: graph.filter((r) => r.row_kind === "edge" && edgeKind(r.payload) === "refines"),
    },
    amendments: allEvents.filter((e) => e.kind === "directive_amended" || e.kind === "contract_amendment_proposed"),
    stakeholders: stakeholderStateRows(db, directiveId),
    conflicts: {
      interference: directiveConflicts(db, directiveId),
      stakeholder_events: allEvents.filter((e) => e.kind === "stakeholder_conflict"),
    },
    rolling_reviews: {
      schedule: rolling,
      events: allEvents.filter((e) => e.kind === "directive_review_due"),
    },
    closure_audits: allEvents.filter((e) => e.kind === "task_closure_audited"),
    applied_changes: allEvents.filter((e) => e.kind === "applied_change_committed"),
    irreversible_effects: {
      summary: effects,
      events: allEvents.filter((e) => e.kind === "irreversible_effect_recorded"),
    },
    recent_narrative_events: narrative,
  };
};

const renderListEmpty = (out: (s: string) => void): void => out("  (none)");

const renderHuman = (inspection: DirectiveInspection, out: (s: string) => void): void => {
  out(`acc directive ${inspection.directive_id}`);
  if (inspection.directive) out(`opened: ${inspection.directive.ts} ${eventText(inspection.directive)}`.trim());
  out("");

  out("dispatch status (dispatch_resolved_view):");
  if (inspection.dispatch.length === 0) renderListEmpty(out);
  for (const r of inspection.dispatch) {
    const residual = r.residual !== null ? ` residual=${r.residual}` : "";
    const terminal = r.terminal_kind ? ` terminal=${r.terminal_kind}` : "";
    out(`  ${String(r.lifecycle_status).padEnd(13)} root=${shortId(r.root_task_id)} latest=${r.latest_signal_at ?? "-"}${terminal}${residual}`);
  }
  if (inspection.ready_tasks.length > 0) out(`  ready_tasks=${inspection.ready_tasks.map((r) => shortId(r.task_id)).join(",")}`);
  out("");

  out("task graph / refinement edges:");
  out(`  nodes=${inspection.task_graph.nodes.length} edges=${inspection.task_graph.edges.length} refinement_edges=${inspection.task_graph.refinement_edges.length}`);
  for (const n of inspection.task_graph.nodes) out(`  node ${shortId(n.task_id)} parent=${shortId(n.parent_task_id)} ${flat(goalOf(n.payload), 80)}`.trim());
  for (const e of inspection.task_graph.edges) out(`  edge ${edgeKind(e.payload)} ${shortId(edgeFrom(e.payload))} -> ${shortId(edgeTo(e.payload))}`);
  out("");

  out("amendments:");
  if (inspection.amendments.length === 0) renderListEmpty(out);
  for (const e of inspection.amendments) out(`  ${e.ts} ${e.kind} ${shortId(e.event_id)} ${eventText(e)}`.trim());
  out("");

  out("stakeholders / conflicts:");
  if (inspection.stakeholders.length === 0 && inspection.conflicts.interference.length === 0 && inspection.conflicts.stakeholder_events.length === 0) renderListEmpty(out);
  for (const s of inspection.stakeholders) out(`  stakeholder ${s.stakeholder_id} visibility=${s.information_visibility} event=${shortId(s.event_id)}`);
  for (const c of inspection.conflicts.interference) out(`  conflict ${c.interaction ?? "?"} ${shortId(c.from_directive)} -> ${shortId(c.to_directive)} event=${shortId(c.event_id)}`);
  for (const e of inspection.conflicts.stakeholder_events) out(`  stakeholder_conflict ${shortId(e.event_id)} ${eventText(e)}`.trim());
  out("");

  out("rolling reviews:");
  if (inspection.rolling_reviews.schedule.length === 0 && inspection.rolling_reviews.events.length === 0) renderListEmpty(out);
  for (const r of inspection.rolling_reviews.schedule) out(`  next_review_due=${r.next_review_due} past_due=${r.past_due} lifecycle=${r.lifecycle}`);
  for (const e of inspection.rolling_reviews.events) out(`  review_due ${e.ts} event=${shortId(e.event_id)} ${eventText(e)}`.trim());
  out("");

  out("closure audit residual:");
  if (inspection.closure_audits.length === 0) renderListEmpty(out);
  for (const e of inspection.closure_audits) {
    const residual = e.payload.closure_residual ?? e.residual ?? "?";
    out(`  ${e.ts} event=${shortId(e.event_id)} closure_residual=${residual}`);
  }
  out("");

  out("applied changes / irreversible effects:");
  if (inspection.applied_changes.length === 0 && !inspection.irreversible_effects.summary && inspection.irreversible_effects.events.length === 0) renderListEmpty(out);
  for (const e of inspection.applied_changes) out(`  applied ${e.ts} event=${shortId(e.event_id)} ${eventText(e)}`.trim());
  if (inspection.irreversible_effects.summary) out(`  irreversible_effects count=${inspection.irreversible_effects.summary.effect_count} latest=${inspection.irreversible_effects.summary.latest_ts}`);
  for (const e of inspection.irreversible_effects.events) out(`  irreversible ${e.ts} event=${shortId(e.event_id)} ${eventText(e)}`.trim());
  out("");

  out("recent narrative events:");
  if (inspection.recent_narrative_events.length === 0) renderListEmpty(out);
  for (const e of inspection.recent_narrative_events) {
    const rendered = formatEvent(e, { verbose: false });
    out(`  ${rendered || `${e.ts} ${e.kind} ${shortId(e.event_id)} ${eventText(e)}`.trim()}`);
  }
};

const usage = (): string => [
  "acc directive — single-directive inspection and lifecycle commands",
  "",
  "Usage:",
  "  acc directive <directive_id> [--json] [--limit N]",
  "    Inspect one directive: dispatch status, task graph/refinement edges,",
  "    amendments, stakeholders, conflicts, rolling reviews, closure residual,",
  "    applied changes, irreversible effects, and recent narrative events.",
  "",
  "  acc directive resume <directive_id>",
  "    Lift a supervisor-quarantine/archive by emitting directive_resumed.",
].join("\n");

const openSubstrate = (env: DirectiveEnv): Database | null => {
  const dbPath = env.stateDbPath ?? resolveDbPath();
  try { return (env.openSubstrate ?? ((p?: string) => openDb(p ?? resolveDbPath())))(dbPath); }
  catch (err) { env.err(`could not open substrate DB at ${dbPath}: ${(err as Error).message}`); return null; }
};

const runResume = (directiveId: string | undefined, env: DirectiveEnv): number => {
  if (!directiveId) { env.err("acc directive resume: missing <directive_id>"); return 1; }
  const db = openSubstrate(env);
  if (!db) return 1;
  const row = db.query(
    `SELECT kind FROM events
     WHERE directive_id = ?
       AND kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
     ORDER BY ts DESC LIMIT 1`,
  ).get(directiveId) as { kind: string } | null;
  if (!row) { env.err(`directive ${directiveId} is not currently archived/closed; nothing to resume.`); return 1; }
  emitEvent(db, {
    kind: "directive_resumed",
    substrate_origin: "owner",
    directive_id: directiveId,
    payload: { prior_state: row.kind, resumed_at: new Date().toISOString() },
  });
  env.out(`directive ${directiveId} resumed (prior state: ${row.kind}).`);
  env.out("its tasks are now eligible for dispatch on the next scheduler tick.");
  return 0;
};

const parseInspectArgs = (argv: string[]): { directiveId?: string; wantJson: boolean; limit?: number } => {
  let directiveId: string | undefined;
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") continue;
    if (arg === "--limit") {
      if (argv[i + 1]) limit = Number(argv[++i]);
      continue;
    }
    if (!arg.startsWith("--") && !directiveId) directiveId = arg;
  }
  return { directiveId, wantJson: argv.includes("--json"), limit };
};

export const runDirective = async (argv: string[], envOverride?: Partial<DirectiveEnv>): Promise<number> => {
  const env: DirectiveEnv = { ...defaultEnv(), ...(envOverride ?? {}) };
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") { env.out(usage()); return 0; }
  if (sub === "resume") return runResume(argv[1], env);

  const { directiveId, wantJson, limit } = parseInspectArgs(argv);
  if (!directiveId) { env.err("acc directive: missing <directive_id>"); return 1; }
  const db = openSubstrate(env);
  if (!db) return 1;
  const inspection = inspectDirective(db, directiveId, { narrativeLimit: limit });
  if (!inspection.directive && inspection.dispatch.length === 0 && inspection.task_graph.nodes.length === 0) {
    env.err(`acc directive: directive not found: ${directiveId}`);
    return 1;
  }
  if (wantJson) env.out(JSON.stringify(inspection, null, 2));
  else renderHuman(inspection, env.out);
  return 0;
};

if (import.meta.main) {
  void runDirective(process.argv.slice(2)).then((code) => process.exit(code));
}
