// acc2 substrate views — pure SQL view definitions per docs/v2-design.md §4.2.
// Each view is a CREATE VIEW IF NOT EXISTS over the events + code_artifact
// tables already declared in schema.sql. Accessor functions are thin: one
// query, parse JSON columns, return rows. Heavier projections (semantic
// merger, recipe extraction) live in extractors.ts because they emit new
// events, which a view cannot do.
//
// runViews(db) is idempotent — every statement is CREATE VIEW IF NOT EXISTS.
// We do NOT call it from openDb so Phase B1's db.test.ts contracts are
// untouched; the daemon (Phase B3) and any test that uses views must
// invoke runViews(db) explicitly. Documented choice (per task brief).

import type { Database } from "bun:sqlite";

// ── View DDL (one statement per view; runViews runs them all) ───────

// task_graph_view — joins task_node_opened + task_edge_recorded events.
// Each row is either a node (kind='node') or an edge (kind='edge'); the
// caller groups by directive_id to assemble a DAG topology. node payload
// carries the task_id/goal; edge payload carries from/to/edge_kind.
const VIEW_TASK_GRAPH = `
CREATE VIEW IF NOT EXISTS task_graph_view AS
  SELECT
    e.id              AS event_id,
    e.ts              AS ts,
    e.directive_id    AS directive_id,
    e.task_id         AS task_id,
    e.parent_task_id  AS parent_task_id,
    'node'            AS row_kind,
    e.payload         AS payload
  FROM events e
  WHERE e.kind = 'task_node_opened'
  UNION ALL
  SELECT
    e.id              AS event_id,
    e.ts              AS ts,
    e.directive_id    AS directive_id,
    e.task_id         AS task_id,
    e.parent_task_id  AS parent_task_id,
    'edge'            AS row_kind,
    e.payload         AS payload
  FROM events e
  WHERE e.kind = 'task_edge_recorded';
`;

// ready_tasks_view — task_node_opened rows whose every upstream 'requires'
// edge has a corresponding task_committed event on the from-task. Tasks
// with NO incoming edges are also ready. Refinement edges ('refines') do
// not block readiness (the new refinement target is its own ready node).
const VIEW_READY_TASKS = `
CREATE VIEW IF NOT EXISTS ready_tasks_view AS
  WITH nodes AS (
    SELECT id AS event_id, ts, directive_id, task_id, payload
    FROM events
    WHERE kind = 'task_node_opened'
  ),
  edges AS (
    SELECT
      directive_id,
      json_extract(payload, '$.from') AS from_task,
      json_extract(payload, '$.to')   AS to_task,
      json_extract(payload, '$.kind') AS edge_kind
    FROM events
    WHERE kind = 'task_edge_recorded'
  ),
  committed AS (
    SELECT task_id FROM events WHERE kind = 'task_committed' GROUP BY task_id
  ),
  -- Convention: edge.from is the upstream (must commit before edge.to is ready).
  -- A task is blocked iff it has any 'requires' edge whose 'from' task is not committed.
  blocked AS (
    SELECT DISTINCT e.to_task AS task_id
    FROM edges e
    WHERE e.edge_kind = 'requires'
      AND e.from_task NOT IN (SELECT task_id FROM committed)
  )
  SELECT n.event_id, n.ts, n.directive_id, n.task_id, n.payload
  FROM nodes n
  WHERE n.task_id NOT IN (SELECT task_id FROM blocked)
    AND n.task_id NOT IN (SELECT task_id FROM committed);
`;

// failure_view — task_failed rows grouped by failure_kind. The aggregate
// is computed in SQL so the brain can see the failure landscape in one
// scan without per-row JSON parsing.
const VIEW_FAILURE = `
CREATE VIEW IF NOT EXISTS failure_view AS
  SELECT
    failure_kind,
    COUNT(*)       AS count,
    MAX(ts)        AS latest_ts,
    MIN(ts)        AS earliest_ts
  FROM events
  WHERE kind = 'task_failed' AND failure_kind IS NOT NULL
  GROUP BY failure_kind;
`;

// code_artifact_registry_view — admitted or promoted artifacts ordered by
// score DESC. This is what retrieval and the prompt composer read.
const VIEW_CODE_ARTIFACT_REGISTRY = `
CREATE VIEW IF NOT EXISTS code_artifact_registry_view AS
  SELECT
    id, runtime, body, declared_sandbox, state_root,
    posterior_alpha, posterior_beta, score, confidence,
    recent_residual_mean, recent_kill_count, status, name,
    fixture_input, fixture_expected_residual,
    created_at, updated_at
  FROM code_artifact
  WHERE status IN ('admitted', 'promoted')
  ORDER BY score DESC, confidence DESC;
`;

// artifact_routing_view — same registry, ranked by score*(1-residual_mean).
// (cosine × posterior reranker is Phase F; this is a placeholder ordering.)
const VIEW_ARTIFACT_ROUTING = `
CREATE VIEW IF NOT EXISTS artifact_routing_view AS
  SELECT
    id, runtime, body, declared_sandbox, score, confidence,
    recent_residual_mean, status, name,
    (score * (1.0 - recent_residual_mean)) AS routing_score
  FROM code_artifact
  WHERE status IN ('admitted', 'promoted')
  ORDER BY routing_score DESC;
`;

// embedding_index_view — events that carry an embedding BLOB. The daemon
// rebuilds its HNSW index from this view at boot.
const VIEW_EMBEDDING_INDEX = `
CREATE VIEW IF NOT EXISTS embedding_index_view AS
  SELECT id, kind, ts, directive_id, task_id, embedding, embedding_version, substrate_origin, payload
  FROM events
  WHERE embedding IS NOT NULL;
`;

// origin_promotion_view — per substrate_origin, summarise how often candidate
// events from that origin promoted to knowledge_promoted. Used by the
// reranker (retrieval.ts) to bias scoring per origin (§3.6.1 Rule 4).
// Phase H: still returns the GLOBAL per-origin aggregation here; the
// per-(origin, goal_shape) refinement is computed in TypeScript via
// `originPromotionByGoalShape` (substrate/views.ts) — pure SQL cannot
// invoke the goalShape() hash function. The reranker reads BOTH: the
// per-shape map first, falling back to the global ratio (this view) when
// no shape-specific data exists.
const VIEW_ORIGIN_PROMOTION = `
CREATE VIEW IF NOT EXISTS origin_promotion_view AS
  WITH candidates AS (
    SELECT substrate_origin, COUNT(*) AS cand_count
    FROM events
    WHERE kind = 'knowledge_candidate'
    GROUP BY substrate_origin
  ),
  promotions AS (
    SELECT substrate_origin, COUNT(*) AS prom_count
    FROM events
    WHERE kind = 'knowledge_promoted'
    GROUP BY substrate_origin
  )
  SELECT
    COALESCE(c.substrate_origin, p.substrate_origin)            AS substrate_origin,
    COALESCE(c.cand_count, 0)                                   AS candidate_count,
    COALESCE(p.prom_count, 0)                                   AS promoted_count,
    CASE
      WHEN COALESCE(c.cand_count, 0) = 0 THEN 1.0
      ELSE CAST(COALESCE(p.prom_count, 0) AS REAL) / CAST(c.cand_count AS REAL)
    END                                                          AS promotion_ratio
  FROM candidates c
  LEFT JOIN promotions p ON c.substrate_origin = p.substrate_origin
  UNION
  SELECT
    p.substrate_origin                                          AS substrate_origin,
    0                                                            AS candidate_count,
    p.prom_count                                                 AS promoted_count,
    1.0                                                          AS promotion_ratio
  FROM promotions p
  WHERE p.substrate_origin NOT IN (SELECT substrate_origin FROM candidates);
`;

// contradictory_candidates_view — Phase B2 placeholder. The semantic
// dedup extractor emits 'contradictory_candidates' events; once embeddings
// light up (Phase F), this view surfaces those pairs. Shape: one row per
// contradictory_candidates event with both candidate ids in payload.
const VIEW_CONTRADICTORY = `
CREATE VIEW IF NOT EXISTS contradictory_candidates_view AS
  SELECT
    id              AS event_id,
    ts,
    directive_id,
    payload,
    context_refs
  FROM events
  WHERE kind = 'contradictory_candidates';
`;

// owner_conversation_view — owner-channel events ordered by ts.
const VIEW_OWNER_CONVERSATION = `
CREATE VIEW IF NOT EXISTS owner_conversation_view AS
  SELECT
    id              AS event_id,
    ts,
    directive_id,
    task_id,
    kind,
    payload,
    substrate_origin
  FROM events
  WHERE kind IN ('owner_input_received', 'owner_decision_recorded')
  ORDER BY ts ASC;
`;

// rolling_review_due_view — directives with lifecycle='rolling_active' and
// next_review_due ≤ now. We project from the LATEST directive_opened (or
// directive_amended) event per directive_id, reading lifecycle +
// next_review_due from its payload.
const VIEW_ROLLING_REVIEW_DUE = `
CREATE VIEW IF NOT EXISTS rolling_review_due_view AS
  WITH latest AS (
    SELECT directive_id, MAX(ts) AS max_ts
    FROM events
    WHERE kind IN ('directive_opened', 'directive_amended')
    GROUP BY directive_id
  ),
  current AS (
    SELECT e.directive_id, e.payload, e.ts
    FROM events e
    JOIN latest l
      ON e.directive_id = l.directive_id AND e.ts = l.max_ts
    WHERE e.kind IN ('directive_opened', 'directive_amended')
  )
  SELECT
    directive_id,
    ts                                                      AS latest_ts,
    json_extract(payload, '$.lifecycle')                    AS lifecycle,
    json_extract(payload, '$.next_review_due')              AS next_review_due,
    payload                                                 AS payload
  FROM current
  WHERE json_extract(payload, '$.lifecycle') = 'rolling_active'
    AND json_extract(payload, '$.next_review_due') IS NOT NULL
    AND json_extract(payload, '$.next_review_due') <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
`;

// directive_conflicts_view — cross-directive interference edges.
const VIEW_DIRECTIVE_CONFLICTS = `
CREATE VIEW IF NOT EXISTS directive_conflicts_view AS
  SELECT
    id              AS event_id,
    ts,
    directive_id,
    payload,
    context_refs
  FROM events
  WHERE kind = 'directive_interference_edge'
  ORDER BY ts DESC;
`;

// stakeholder_state_view — latest stakeholder_state_recorded row per
// (directive_id, stakeholder_id). Older rows stay in events for audit but
// the view projects only the freshest declaration. Phase I (§3.3, §4.2).
const VIEW_STAKEHOLDER_STATE = `
CREATE VIEW IF NOT EXISTS stakeholder_state_view AS
  WITH ranked AS (
    SELECT
      e.id                                                AS event_id,
      e.ts                                                AS ts,
      e.directive_id                                      AS directive_id,
      json_extract(e.payload, '$.stakeholder_id')         AS stakeholder_id,
      json_extract(e.payload, '$.declared_utility')       AS declared_utility,
      json_extract(e.payload, '$.inferred_constraints')   AS inferred_constraints,
      json_extract(e.payload, '$.information_visibility') AS information_visibility,
      e.payload                                            AS payload,
      ROW_NUMBER() OVER (
        PARTITION BY e.directive_id, json_extract(e.payload, '$.stakeholder_id')
        ORDER BY e.ts DESC, e.id DESC
      ) AS rn
    FROM events e
    WHERE e.kind = 'stakeholder_state_recorded'
  )
  SELECT event_id, ts, directive_id, stakeholder_id, declared_utility,
         inferred_constraints, information_visibility, payload
  FROM ranked
  WHERE rn = 1;
`;

// active_objectives_view — directives that are NOT terminal (not goal_committed
// / goal_abandoned) AND not archived via directive_archived_missed_reviews.
// Used by Father (§14) to pick its next work surface. Phase I (§3.1).
const VIEW_ACTIVE_OBJECTIVES = `
CREATE VIEW IF NOT EXISTS active_objectives_view AS
  WITH directives AS (
    SELECT directive_id, MAX(ts) AS opened_ts, payload
    FROM events
    WHERE kind = 'directive_opened'
    GROUP BY directive_id
  ),
  terminal AS (
    SELECT DISTINCT directive_id
    FROM events
    WHERE kind IN ('goal_committed', 'goal_abandoned')
  ),
  archived AS (
    SELECT DISTINCT directive_id
    FROM events
    WHERE kind = 'directive_archived_missed_reviews'
  )
  SELECT
    d.directive_id,
    d.opened_ts,
    d.payload
  FROM directives d
  WHERE d.directive_id NOT IN (SELECT directive_id FROM terminal)
    AND d.directive_id NOT IN (SELECT directive_id FROM archived);
`;

// irreversible_effects_view — physical-world side effects per directive.
const VIEW_IRREVERSIBLE_EFFECTS = `
CREATE VIEW IF NOT EXISTS irreversible_effects_view AS
  SELECT
    directive_id,
    COUNT(*)        AS effect_count,
    MAX(ts)         AS latest_ts,
    MIN(ts)         AS earliest_ts
  FROM events
  WHERE kind = 'irreversible_effect_recorded'
  GROUP BY directive_id;
`;

// ── Public entrypoint ──────────────────────────────────────────────

/** Create every substrate view. Idempotent — every statement is
 *  CREATE VIEW IF NOT EXISTS so running this on a warm db is a no-op.
 *  Daemon callers should run this once at boot AFTER runSchema. Tests
 *  that touch views must call this explicitly. */
export const runViews = (db: Database): void => {
  // SQL line-comments using `--` were inadvertently rendered with `--`
  // outside of string literals above; strip them before exec to keep
  // sqlite happy. (The TypeScript // comments are fine; the embedded
  // -- comments inside the SQL strings parse natively.)
  db.exec(VIEW_TASK_GRAPH);
  db.exec(VIEW_READY_TASKS);
  db.exec(VIEW_FAILURE);
  db.exec(VIEW_CODE_ARTIFACT_REGISTRY);
  db.exec(VIEW_ARTIFACT_ROUTING);
  db.exec(VIEW_EMBEDDING_INDEX);
  db.exec(VIEW_ORIGIN_PROMOTION);
  db.exec(VIEW_CONTRADICTORY);
  db.exec(VIEW_OWNER_CONVERSATION);
  db.exec(VIEW_ROLLING_REVIEW_DUE);
  db.exec(VIEW_DIRECTIVE_CONFLICTS);
  db.exec(VIEW_STAKEHOLDER_STATE);
  db.exec(VIEW_ACTIVE_OBJECTIVES);
  db.exec(VIEW_IRREVERSIBLE_EFFECTS);
};

// ── Accessor types + functions ─────────────────────────────────────

export type TaskGraphRow = {
  event_id: string;
  ts: string;
  directive_id: string;
  task_id: string;
  parent_task_id: string | null;
  row_kind: "node" | "edge";
  payload: Record<string, unknown>;
};

export type ReadyTaskRow = {
  event_id: string;
  ts: string;
  directive_id: string;
  task_id: string;
  payload: Record<string, unknown>;
};

export type FailureRow = {
  failure_kind: string;
  count: number;
  latest_ts: string;
  earliest_ts: string;
};

export type CodeArtifactRow = {
  id: string;
  runtime: string;
  body: string;
  declared_sandbox: Record<string, unknown>;
  state_root: string;
  posterior_alpha: number;
  posterior_beta: number;
  score: number;
  confidence: number;
  recent_residual_mean: number;
  recent_kill_count: number;
  status: string;
  name: string | null;
  fixture_input: unknown;
  fixture_expected_residual: number;
  created_at: string;
  updated_at: string;
};

export type ArtifactRoutingRow = CodeArtifactRow & { routing_score: number };

export type EmbeddingIndexRow = {
  id: string;
  kind: string;
  ts: string;
  directive_id: string;
  task_id: string;
  embedding: Uint8Array;
  embedding_version: string | null;
  substrate_origin: string;
  payload: Record<string, unknown>;
};

export type OriginPromotionRow = {
  substrate_origin: string;
  candidate_count: number;
  promoted_count: number;
  promotion_ratio: number;
};

export type OwnerConversationRow = {
  event_id: string;
  ts: string;
  directive_id: string;
  task_id: string;
  kind: "owner_input_received" | "owner_decision_recorded";
  payload: Record<string, unknown>;
  substrate_origin: string;
};

export type RollingReviewDueRow = {
  directive_id: string;
  latest_ts: string;
  lifecycle: string;
  next_review_due: string;
  payload: Record<string, unknown>;
};

export type DirectiveConflictRow = {
  event_id: string;
  ts: string;
  directive_id: string;
  payload: Record<string, unknown>;
  context_refs: string[];
};

export type IrreversibleEffectRow = {
  directive_id: string;
  effect_count: number;
  latest_ts: string;
  earliest_ts: string;
};

export type StakeholderStateRow = {
  event_id: string;
  ts: string;
  directive_id: string;
  stakeholder_id: string;
  declared_utility: unknown;
  inferred_constraints: unknown;
  information_visibility: string;
  payload: Record<string, unknown>;
};

export type ActiveObjectiveRow = {
  directive_id: string;
  opened_ts: string;
  payload: Record<string, unknown>;
};

const parseJson = <T>(s: unknown): T => {
  if (typeof s !== "string") return s as T;
  return JSON.parse(s) as T;
};

/** Return every task_graph_view row for one directive, ts-ascending. */
export const taskGraphFor = (db: Database, directiveId: string): TaskGraphRow[] => {
  const rows = db
    .query("SELECT * FROM task_graph_view WHERE directive_id = ? ORDER BY ts ASC")
    .all(directiveId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    event_id: r.event_id as string,
    ts: r.ts as string,
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    parent_task_id: (r.parent_task_id as string | null) ?? null,
    row_kind: r.row_kind as "node" | "edge",
    payload: parseJson<Record<string, unknown>>(r.payload),
  }));
};

/** Tasks whose every 'requires' upstream has committed. Optional cap. */
export const readyTasks = (db: Database, limit?: number): ReadyTaskRow[] => {
  const sql = limit
    ? "SELECT * FROM ready_tasks_view ORDER BY ts ASC LIMIT ?"
    : "SELECT * FROM ready_tasks_view ORDER BY ts ASC";
  const rows = (limit
    ? db.query(sql).all(limit)
    : db.query(sql).all()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    event_id: r.event_id as string,
    ts: r.ts as string,
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    payload: parseJson<Record<string, unknown>>(r.payload),
  }));
};

/** Per-failure_kind tallies of task_failed events. */
export const failureCounts = (db: Database): FailureRow[] => {
  const rows = db.query("SELECT * FROM failure_view ORDER BY count DESC").all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    failure_kind: r.failure_kind as string,
    count: r.count as number,
    latest_ts: r.latest_ts as string,
    earliest_ts: r.earliest_ts as string,
  }));
};

const rowToCodeArtifact = (r: Record<string, unknown>): CodeArtifactRow => ({
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

/** Admitted + promoted code artifacts ordered by score DESC. Optional runtime filter. */
export const codeArtifactRegistry = (db: Database, runtime?: string): CodeArtifactRow[] => {
  const rows = (runtime
    ? db.query("SELECT * FROM code_artifact_registry_view WHERE runtime = ?").all(runtime)
    : db.query("SELECT * FROM code_artifact_registry_view").all()) as Array<Record<string, unknown>>;
  return rows.map(rowToCodeArtifact);
};

/** Routing ranking — score × (1 - residual_mean). Phase B+ adds cosine. */
export const artifactRouting = (db: Database, runtime?: string): ArtifactRoutingRow[] => {
  const rows = (runtime
    ? db
        .query(
          "SELECT ca.*, ar.routing_score FROM artifact_routing_view ar JOIN code_artifact ca ON ar.id = ca.id WHERE ca.runtime = ? ORDER BY ar.routing_score DESC",
        )
        .all(runtime)
    : db
        .query(
          "SELECT ca.*, ar.routing_score FROM artifact_routing_view ar JOIN code_artifact ca ON ar.id = ca.id ORDER BY ar.routing_score DESC",
        )
        .all()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ ...rowToCodeArtifact(r), routing_score: r.routing_score as number }));
};

/** Owner-channel events in ts order. */
export const ownerConversation = (db: Database, directiveId?: string): OwnerConversationRow[] => {
  const rows = (directiveId
    ? db.query("SELECT * FROM owner_conversation_view WHERE directive_id = ?").all(directiveId)
    : db.query("SELECT * FROM owner_conversation_view").all()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    event_id: r.event_id as string,
    ts: r.ts as string,
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    kind: r.kind as OwnerConversationRow["kind"],
    payload: parseJson<Record<string, unknown>>(r.payload),
    substrate_origin: r.substrate_origin as string,
  }));
};

/** Directives whose next_review_due ≤ now and lifecycle='rolling_active'. */
export const rollingReviewDue = (db: Database): RollingReviewDueRow[] => {
  const rows = db
    .query("SELECT * FROM rolling_review_due_view")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    directive_id: r.directive_id as string,
    latest_ts: r.latest_ts as string,
    lifecycle: r.lifecycle as string,
    next_review_due: r.next_review_due as string,
    payload: parseJson<Record<string, unknown>>(r.payload),
  }));
};

/** directive_interference_edge events, newest first. */
export const directiveConflicts = (db: Database): DirectiveConflictRow[] => {
  const rows = db
    .query("SELECT * FROM directive_conflicts_view")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    event_id: r.event_id as string,
    ts: r.ts as string,
    directive_id: r.directive_id as string,
    payload: parseJson<Record<string, unknown>>(r.payload),
    context_refs: parseJson<string[]>(r.context_refs),
  }));
};

/** Latest stakeholder_state_recorded per (directive_id, stakeholder_id). */
export const stakeholderStateRows = (db: Database, directiveId?: string): StakeholderStateRow[] => {
  const rows = (directiveId
    ? db.query("SELECT * FROM stakeholder_state_view WHERE directive_id = ?").all(directiveId)
    : db.query("SELECT * FROM stakeholder_state_view").all()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    event_id: r.event_id as string,
    ts: r.ts as string,
    directive_id: r.directive_id as string,
    stakeholder_id: r.stakeholder_id as string,
    declared_utility: typeof r.declared_utility === "string" ? parseJson(r.declared_utility) : r.declared_utility,
    inferred_constraints:
      typeof r.inferred_constraints === "string" ? parseJson(r.inferred_constraints) : r.inferred_constraints,
    information_visibility: r.information_visibility as string,
    payload: parseJson<Record<string, unknown>>(r.payload),
  }));
};

/** Non-terminal, non-archived directives. Father reads this. */
export const activeObjectives = (db: Database): ActiveObjectiveRow[] => {
  const rows = db
    .query("SELECT * FROM active_objectives_view ORDER BY opened_ts ASC")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    directive_id: r.directive_id as string,
    opened_ts: r.opened_ts as string,
    payload: parseJson<Record<string, unknown>>(r.payload),
  }));
};

/** Tally of irreversible_effect_recorded events per directive. */
export const irreversibleEffects = (db: Database): IrreversibleEffectRow[] => {
  const rows = db
    .query("SELECT * FROM irreversible_effects_view")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    directive_id: r.directive_id as string,
    effect_count: r.effect_count as number,
    latest_ts: r.latest_ts as string,
    earliest_ts: r.earliest_ts as string,
  }));
};

/** Events with an embedding BLOB — daemon rebuilds in-memory index from this. */
export const embeddingIndex = (db: Database): EmbeddingIndexRow[] => {
  const rows = db.query("SELECT * FROM embedding_index_view").all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    ts: r.ts as string,
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    embedding: r.embedding as Uint8Array,
    embedding_version: (r.embedding_version as string | null) ?? null,
    substrate_origin: r.substrate_origin as string,
    payload: parseJson<Record<string, unknown>>(r.payload),
  }));
};

/** Per-origin promotion ratio (knowledge_promoted / knowledge_candidate). The
 *  reranker reads this to bias scoring per substrate_origin (§3.6.1 Rule 4).
 *  Origins missing from this view default to 1.0 at the call site. */
export const originPromotion = (db: Database): OriginPromotionRow[] => {
  const rows = db.query("SELECT * FROM origin_promotion_view").all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    substrate_origin: r.substrate_origin as string,
    candidate_count: r.candidate_count as number,
    promoted_count: r.promoted_count as number,
    promotion_ratio: r.promotion_ratio as number,
  }));
};

export type OriginGoalShapeRow = {
  substrate_origin: string;
  goal_shape: string;
  candidate_count: number;
  promoted_count: number;
  promotion_ratio: number;
};

/** Per-(origin, goal_shape) promotion ratio — Phase H (§3.6.1 Rule 4,
 *  §18 cutover criterion 19). The goal_shape is computed by hashing each
 *  knowledge_candidate's owning directive's goal text via `goalShape(...)`
 *  in runtime/goal_shape.ts. The reranker reads this map first; when no
 *  shape-specific row exists it falls back to the global per-origin ratio
 *  in `origin_promotion_view`. */
export const originPromotionByGoalShape = (
  db: Database,
  goalShape: (text: string) => string,
): OriginGoalShapeRow[] => {
  // Step 1 — pull every directive's goal text once.
  const directives = db
    .query(
      `SELECT directive_id, payload FROM events
       WHERE kind = 'directive_opened'`,
    )
    .all() as Array<{ directive_id: string; payload: string }>;

  const directiveToShape = new Map<string, string>();
  for (const d of directives) {
    let goal = "";
    try {
      const p = JSON.parse(d.payload) as { goal?: unknown; intent?: unknown };
      goal = String((p.goal ?? p.intent ?? "") as string);
    } catch { /* malformed payload — empty shape */ }
    directiveToShape.set(d.directive_id, goalShape(goal));
  }

  // Step 2 — count candidates and promotions per (origin, directive_id).
  const candidates = db
    .query(
      `SELECT substrate_origin, directive_id, COUNT(*) AS c
       FROM events
       WHERE kind = 'knowledge_candidate'
       GROUP BY substrate_origin, directive_id`,
    )
    .all() as Array<{ substrate_origin: string; directive_id: string; c: number }>;

  const promotions = db
    .query(
      `SELECT substrate_origin, directive_id, COUNT(*) AS c
       FROM events
       WHERE kind = 'knowledge_promoted'
       GROUP BY substrate_origin, directive_id`,
    )
    .all() as Array<{ substrate_origin: string; directive_id: string; c: number }>;

  // Step 3 — aggregate per (origin, goal_shape).
  type Key = string;
  const candMap = new Map<Key, number>();
  const promMap = new Map<Key, number>();
  for (const c of candidates) {
    const shape = directiveToShape.get(c.directive_id) ?? goalShape("");
    const key = `${c.substrate_origin}::${shape}`;
    candMap.set(key, (candMap.get(key) ?? 0) + c.c);
  }
  for (const p of promotions) {
    const shape = directiveToShape.get(p.directive_id) ?? goalShape("");
    const key = `${p.substrate_origin}::${shape}`;
    promMap.set(key, (promMap.get(key) ?? 0) + p.c);
  }

  const out: OriginGoalShapeRow[] = [];
  const seenKeys = new Set<string>([...candMap.keys(), ...promMap.keys()]);
  for (const key of seenKeys) {
    const sep = key.indexOf("::");
    const origin = key.slice(0, sep);
    const shape = key.slice(sep + 2);
    const cand = candMap.get(key) ?? 0;
    const prom = promMap.get(key) ?? 0;
    const ratio = cand === 0 ? 1.0 : prom / cand;
    out.push({
      substrate_origin: origin,
      goal_shape: shape,
      candidate_count: cand,
      promoted_count: prom,
      promotion_ratio: ratio,
    });
  }
  return out;
};
