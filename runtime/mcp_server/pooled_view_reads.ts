// acc2 substrate.read — pooled (off-loop) variants of the hot view helpers.
//
// WHY: handleRead in substrate_tools.ts runs `db.query(sql).all(...)`
// SYNCHRONOUSLY on the daemon's single event loop for every substrate.read.
// On a 400k-event ledger the hot, orchestrator/TUI-polled views (ready_tasks,
// task_graph, artifact_routing, substrate_narrative_recent, the artifact
// registry) materialize large scans/joins that block the loop 0.5-5s each.
// At 10-50 reads/sec that saturates the loop → 4-12s read stalls. This is the
// #1 reactivity offender (deep profiling).
//
// THE FIX: route the SELECT through the SQL worker-thread pool (off the main
// loop, on worker_threads each owning a readonly bun:sqlite connection) when
// the daemon installed one; fall back to the synchronous db.query path when no
// pool (tests, ACC2_DISABLE_SQL_POOL). Same SQL, same ordering, same row shape
// — only the execution thread differs. Reads are idempotent; off-loading them
// is safe. WRITES are NEVER routed here (single-writer invariant).
//
// These pooled variants live in runtime/mcp_server/ (the MCP read path's own
// scope) rather than substrate/views.ts, and import ONLY the public exported
// row TYPES + EVENT_KINDS registry from substrate/views — so the byte-identical
// SQL and mapping are reproduced here with zero behavioral drift from the
// synchronous helpers. The existing `dispatchResolvedPooled` (in views.ts)
// establishes the same sql+map-shared pattern.

import type { Database } from "bun:sqlite";
import { EVENT_KINDS } from "../../substrate/event_kinds";
import type {
  ReadyTaskRow,
  TaskGraphRow,
  ActArtifactRow,
  ArtifactRoutingRow,
  SubstrateNarrativeRow,
  SubstrateNarrativeFilter,
} from "../../substrate/views";

/** Injected off-loop read router (substrate_tools.poolQuery). Routes the
 *  SELECT through the SQL worker pool when present, sync `db.query` otherwise.
 *  Same signature both surfaces use. */
export type PoolQuery = <T>(db: Database, sql: string, params: unknown[]) => Promise<T[]>;

/** parseJson — byte-identical to substrate/views.ts's module-private helper
 *  (which is not exported). JSON-parse with a typed fallback so a malformed /
 *  null column never throws out of the read path. */
const parseJson = <T>(s: unknown): T => {
  if (typeof s !== "string" || s.length === 0) return {} as T;
  try {
    return JSON.parse(s) as T;
  } catch {
    return {} as T;
  }
};

/** Narrative-kind allowlist — derived identically to substrate/views.ts's
 *  module-private NARRATIVE_KIND_LIST (single source of truth = EVENT_KINDS,
 *  no drift). The narrative surface defaults to narrative-flagged kinds so
 *  health_metric/diagnostic chatter never leaks into the TUI. */
const NARRATIVE_KIND_LIST: string[] = Object.entries(EVENT_KINDS)
  .filter(([, meta]) => (meta as { narrative?: boolean }).narrative)
  .map(([kind]) => kind);

// ── ready_tasks_view ────────────────────────────────────────────────
// Mirrors substrate/views.ts:readyTasks. Tasks whose every 'requires'
// upstream has committed. Optional cap.
export const readyTasksPooled = async (
  db: Database,
  poolQuery: PoolQuery,
  limit?: number,
): Promise<ReadyTaskRow[]> => {
  const sql = limit
    ? "SELECT * FROM ready_tasks_view ORDER BY ts ASC LIMIT ?"
    : "SELECT * FROM ready_tasks_view ORDER BY ts ASC";
  const rows = await poolQuery<Record<string, unknown>>(db, sql, limit ? [limit] : []);
  return rows.map((r) => ({
    event_id: r.event_id as string,
    ts: r.ts as string,
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    parent_task_id: (r.parent_task_id as string | null) ?? null,
    payload: parseJson<Record<string, unknown>>(r.payload),
    incoming_requires_from: parseJson<string[]>(r.incoming_requires_from ?? "[]"),
    incoming_refines_from: parseJson<string[]>(r.incoming_refines_from ?? "[]"),
  }));
};

// ── task_graph_view ─────────────────────────────────────────────────
// Mirrors substrate/views.ts:taskGraphFor. Node/edge rows for one directive,
// ts-ordered.
export const taskGraphForPooled = async (
  db: Database,
  poolQuery: PoolQuery,
  directiveId: string,
): Promise<TaskGraphRow[]> => {
  const rows = await poolQuery<Record<string, unknown>>(
    db,
    "SELECT * FROM task_graph_view WHERE directive_id = ? ORDER BY ts ASC",
    [directiveId],
  );
  return rows.map((r) => ({
    event_id: r.event_id as string,
    ts: r.ts as string,
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    parent_task_id: (r.parent_task_id as string | null) ?? null,
    row_kind: r.row_kind as "node" | "edge",
    payload: parseJson<Record<string, unknown>>(r.payload),
    retrieval_aspects: parseJson<Record<string, unknown>>(r.retrieval_aspects ?? "{}"),
    retrieval_domains: parseJson<Record<string, number>>(r.retrieval_domains ?? "{}"),
  }));
};

// ── act_artifact_registry_view / artifact_routing_view ──────────────
// rowToActArtifact mirrors substrate/views.ts's module-private mapper.
const rowToActArtifact = (r: Record<string, unknown>): ActArtifactRow => ({
  id: r.id as string,
  runtime: r.runtime as string,
  body: r.body as string,
  declared_sandbox: parseJson<Record<string, unknown>>(r.declared_sandbox),
  state_root: r.state_root as string,
  posterior_alpha: r.posterior_alpha as number,
  posterior_beta: r.posterior_beta as number,
  score: r.score as number,
  confidence: r.confidence as number,
  recent_residual_mean: r.recent_residual_mean as number,
  recent_kill_count: r.recent_kill_count as number,
  status: r.status as string,
  name: (r.name as string | null) ?? null,
  fixture_input: parseJson<unknown>(r.fixture_input),
  fixture_expected_residual: r.fixture_expected_residual as number,
  created_at: r.created_at as string,
  updated_at: r.updated_at as string,
});

/** Mirrors substrate/views.ts:actArtifactRegistry. Admitted+promoted artifacts
 *  ordered by score DESC (the view's own ORDER BY); optional runtime filter. */
export const actArtifactRegistryPooled = async (
  db: Database,
  poolQuery: PoolQuery,
  runtime?: string,
): Promise<ActArtifactRow[]> => {
  const sql = runtime
    ? "SELECT * FROM act_artifact_registry_view WHERE runtime = ?"
    : "SELECT * FROM act_artifact_registry_view";
  const rows = await poolQuery<Record<string, unknown>>(db, sql, runtime ? [runtime] : []);
  return rows.map(rowToActArtifact);
};

/** Mirrors substrate/views.ts:artifactRouting. Routing ranking score × (1 -
 *  residual_mean), score DESC; optional runtime filter. */
export const artifactRoutingPooled = async (
  db: Database,
  poolQuery: PoolQuery,
  runtime?: string,
): Promise<ArtifactRoutingRow[]> => {
  const sql = runtime
    ? "SELECT ca.*, ar.routing_score FROM artifact_routing_view ar JOIN act_artifact ca ON ar.id = ca.id WHERE ca.runtime = ? ORDER BY ar.routing_score DESC"
    : "SELECT ca.*, ar.routing_score FROM artifact_routing_view ar JOIN act_artifact ca ON ar.id = ca.id ORDER BY ar.routing_score DESC";
  const rows = await poolQuery<Record<string, unknown>>(db, sql, runtime ? [runtime] : []);
  return rows.map((r) => ({ ...rowToActArtifact(r), routing_score: r.routing_score as number }));
};

// ── open_directive idempotent-dedup lookup ──────────────────────────
// Mirrors substrate_tools.ts:findOpenDirectiveByText. The json_extract scan
// over directive_opened rows + the NOT IN closure/archive subquery is a full
// events-table scan that runs synchronously inside handleOpenDirective —
// measured at ~5s during a brain dispatch (substrate.open_directive). Route
// the READ off the daemon loop; the directive-open WRITES stay on the
// single-writer main thread. Byte-identical SQL + params + result selection.
const FIND_OPEN_DIRECTIVE_BY_TEXT_SQL =
  `SELECT directive_id FROM events
       WHERE kind = 'directive_opened'
         AND json_extract(payload, '$.directive_text') = ?
         AND directive_id NOT IN (
           SELECT directive_id FROM events
           WHERE kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
         )
       ORDER BY ts ASC LIMIT 1`;

export const findOpenDirectiveByTextPooled = async (
  db: Database,
  poolQuery: PoolQuery,
  text: string,
): Promise<string | null> => {
  const rows = await poolQuery<{ directive_id: string }>(
    db,
    FIND_OPEN_DIRECTIVE_BY_TEXT_SQL,
    [text],
  );
  return rows[0]?.directive_id ?? null;
};

// ── substrate.search recency stand-in scan ──────────────────────────
// Mirrors the recency stand-in branch of handleSearch (the no-index /
// query-embedding-unavailable fallback): a `SELECT … FROM events ORDER BY ts
// DESC LIMIT ?` full-table scan. Route off the daemon loop so the fallback
// never blocks the event loop. Byte-identical SQL + LIMIT param + row shape.
export const recentEventsForSearchPooled = async (
  db: Database,
  poolQuery: PoolQuery,
  k: number,
): Promise<Array<Record<string, unknown>>> => {
  return poolQuery<Record<string, unknown>>(
    db,
    "SELECT id, ts, kind, directive_id, task_id, substrate_origin, payload " +
      "FROM events ORDER BY ts DESC LIMIT ?",
    [k],
  );
};

// ── substrate_narrative_recent_view ─────────────────────────────────
// Mirrors substrate/views.ts:substrateNarrativeRecent. Content-first TUI
// primitive; newest-first, narrative-kind default, optional filters.
export const substrateNarrativeRecentPooled = async (
  db: Database,
  poolQuery: PoolQuery,
  filter: SubstrateNarrativeFilter = {},
): Promise<SubstrateNarrativeRow[]> => {
  const wheres: string[] = [];
  const params: Array<string | number> = [];
  if (filter.directive_id) {
    wheres.push("directive_id = ?");
    params.push(filter.directive_id);
  }
  if (filter.importance_in && filter.importance_in.length > 0) {
    const placeholders = filter.importance_in.map(() => "?").join(", ");
    wheres.push(`importance IN (${placeholders})`);
    params.push(...filter.importance_in);
  }
  if (filter.kinds_in && filter.kinds_in.length > 0) {
    const placeholders = filter.kinds_in.map(() => "?").join(", ");
    wheres.push(`kind IN (${placeholders})`);
    params.push(...filter.kinds_in);
  } else {
    const placeholders = NARRATIVE_KIND_LIST.map(() => "?").join(", ");
    wheres.push(`kind IN (${placeholders})`);
    params.push(...NARRATIVE_KIND_LIST);
  }
  const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = typeof filter.limit === "number" && filter.limit > 0 ? filter.limit : 200;
  params.push(limit);
  const sql = `SELECT * FROM substrate_narrative_recent_view ${whereClause} LIMIT ?`;
  const rows = await poolQuery<Record<string, unknown>>(db, sql, params);
  return rows.map((r) => ({
    event_id: r.event_id as string,
    ts: r.ts as string,
    kind: r.kind as string,
    directive_id: (r.directive_id as string | null) ?? null,
    task_id: (r.task_id as string | null) ?? null,
    substrate_origin: (r.substrate_origin as string | null) ?? null,
    importance: r.importance as SubstrateNarrativeRow["importance"],
    human_summary: (r.human_summary as string | null) ?? null,
    residual: r.residual == null ? null : Number(r.residual),
    route: (r.route as string | null) ?? null,
    cited_refs: parseJson<string[]>((r.cited_refs as string | null) ?? "[]"),
    payload: parseJson<Record<string, unknown>>((r.payload as string | null) ?? "{}"),
  }));
};
