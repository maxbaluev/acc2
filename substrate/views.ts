// acc2 substrate views — pure SQL view definitions per docs/v2-design.md §4.2.
// Each view is a CREATE VIEW over the events + code_artifact
// tables already declared in schema.sql. Accessor functions are thin: one
// query, parse JSON columns, return rows. Heavier projections (semantic
// merger, recipe extraction) live in extractors.ts because they emit new
// events, which a view cannot do.
//
// runViews(db) is idempotent — it replaces view definitions so warm daemon
// DBs pick up projection changes instead of keeping stale CREATE VIEW SQL.
// We do NOT call it from openDb so Phase B1's db.test.ts contracts are
// untouched; the daemon (Phase B3) and any test that uses views must
// invoke runViews(db) explicitly. Documented choice (per task brief).

import type { Database } from "bun:sqlite";
import { lessonApplyTargetPolicyValuesSql } from "./lesson_apply_policy";

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
    -- Brain audit A1 (2026-05-15): runtime emitters carry edge endpoints
    -- as payload.from_task / payload.to_task; this CTE used to only read
    -- payload.$.from / payload.$.to and silently dropped requires edges
    -- with the canonical keys. COALESCE both shapes so the SQL view
    -- agrees with runtime/task_topology.ts on readiness.
    SELECT
      directive_id,
      COALESCE(json_extract(payload, '$.from_task'), json_extract(payload, '$.from')) AS from_task,
      COALESCE(json_extract(payload, '$.to_task'),   json_extract(payload, '$.to'))   AS to_task,
      json_extract(payload, '$.kind') AS edge_kind
    FROM events
    WHERE kind = 'task_edge_recorded'
  ),
  committed AS (
    SELECT task_id FROM events WHERE kind = 'task_committed' GROUP BY task_id
  ),
  -- Terminal task events that should ALSO suppress re-dispatch. Pre-Batch-2
  -- this was committed-only; we widened to task_failed / task_abandoned to
  -- match the Batch-1 monotone terminal-state contract in computeStatus.
  terminal AS (
    SELECT task_id FROM events
    WHERE kind IN ('task_committed', 'task_failed', 'task_abandoned')
    GROUP BY task_id
  ),
  -- Closed/archived directives: Batch-2 directive_closed event + the
  -- pre-existing archival events. readyTasks() in task_topology.ts mirrors
  -- this exclusion so both the SQL view and the in-process helper agree.
  closed_directives AS (
    SELECT DISTINCT directive_id FROM events
    WHERE kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
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
    AND n.task_id NOT IN (SELECT task_id FROM terminal)
    AND n.directive_id NOT IN (SELECT directive_id FROM closed_directives);
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
// Brain dataflow audit bxdhdkm9e #3 (2026-05-15): the registry view now
// exposes the provenance/intent columns the brain emits on
// code_artifact_candidate (intent, summary, target_files, source candidate
// id, owner_gate_verdict). Pre-fix the admission path persisted these
// fields on the events ledger but the view dropped them — the operator
// could not tell WHY an artifact existed or WHICH owner gate (if any)
// approved it.
const VIEW_CODE_ARTIFACT_REGISTRY = `
DROP VIEW IF EXISTS code_artifact_registry_view;
CREATE VIEW IF NOT EXISTS code_artifact_registry_view AS
  SELECT
    id, runtime, body, declared_sandbox, state_root,
    posterior_alpha, posterior_beta, score, confidence,
    recent_residual_mean, recent_kill_count, status, name,
    fixture_input, fixture_expected_residual,
    intent, summary, target_files, source_candidate_id, owner_gate_verdict,
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
  -- promotion_ratio is NULL (not 1.0) when there is no signal — candidate
  -- count = 0 means "we have no evidence yet", not "this origin promotes
  -- perfectly". Callers (retrieval.ts) treat NULL the same way they treat
  -- a missing row: fall back to neutral bias. Brain dataflow audit
  -- bxdhdkm9e #4 (2026-05-15) called the 1.0 fallback an opaque
  -- placeholder that masked absence as perfection.
  SELECT
    COALESCE(c.substrate_origin, p.substrate_origin)            AS substrate_origin,
    COALESCE(c.cand_count, 0)                                   AS candidate_count,
    COALESCE(p.prom_count, 0)                                   AS promoted_count,
    CASE
      WHEN COALESCE(c.cand_count, 0) = 0 THEN NULL
      ELSE CAST(COALESCE(p.prom_count, 0) AS REAL) / CAST(c.cand_count AS REAL)
    END                                                          AS promotion_ratio
  FROM candidates c
  LEFT JOIN promotions p ON c.substrate_origin = p.substrate_origin
  UNION
  SELECT
    p.substrate_origin                                          AS substrate_origin,
    0                                                            AS candidate_count,
    p.prom_count                                                 AS promoted_count,
    NULL                                                         AS promotion_ratio
  FROM promotions p
  WHERE p.substrate_origin NOT IN (SELECT substrate_origin FROM candidates);
`;

// origin_promotion_by_directive_view — Phase DAG follow-up. Same shape as
// `origin_promotion_view` but bucketed per (substrate_origin, directive_id)
// so the per-(origin × goal_shape) ranking can be computed in TypeScript
// (pure SQL cannot invoke goalShape(); the accessor maps directive_id →
// shape via the hash function passed in). One row per
// (substrate_origin, directive_id) with a non-zero candidate or promotion
// count; rows where only promotions exist (candidate was GC'd or never
// emitted) carry `candidate_count = 0`.
const VIEW_ORIGIN_PROMOTION_BY_DIRECTIVE = `
CREATE VIEW IF NOT EXISTS origin_promotion_by_directive_view AS
  WITH candidates AS (
    SELECT substrate_origin, directive_id, COUNT(*) AS cand_count
    FROM events
    WHERE kind = 'knowledge_candidate'
    GROUP BY substrate_origin, directive_id
  ),
  promotions AS (
    SELECT substrate_origin, directive_id, COUNT(*) AS prom_count
    FROM events
    WHERE kind = 'knowledge_promoted'
    GROUP BY substrate_origin, directive_id
  )
  SELECT
    COALESCE(c.substrate_origin, p.substrate_origin)        AS substrate_origin,
    COALESCE(c.directive_id, p.directive_id)                AS directive_id,
    COALESCE(c.cand_count, 0)                                AS candidate_count,
    COALESCE(p.prom_count, 0)                                AS promoted_count
  FROM candidates c
  LEFT JOIN promotions p
    ON c.substrate_origin = p.substrate_origin AND c.directive_id = p.directive_id
  UNION
  SELECT
    p.substrate_origin                                      AS substrate_origin,
    p.directive_id                                          AS directive_id,
    0                                                        AS candidate_count,
    p.prom_count                                             AS promoted_count
  FROM promotions p
  WHERE NOT EXISTS (
    SELECT 1 FROM candidates c
    WHERE c.substrate_origin = p.substrate_origin AND c.directive_id = p.directive_id
  );
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

// rolling_review_due_view — every rolling_active directive with its latest
// next_review_due, plus a past_due boolean. We project from the LATEST
// directive_opened (or directive_amended) event per directive_id, reading
// lifecycle + next_review_due from its payload.
//
// Phase DAG follow-up: the view used to filter to only `next_review_due ≤ now`
// rows; that prevented operators (and downstream views) from inspecting
// rolling directives whose review is still in the future. The widened shape
// returns ALL rolling_active rows with `past_due` carrying the cutoff
// decision so callers like `readRollingReviewsDue` (TS-side filter on
// `next_review_due <= cutoff`) and the new `rollingReviewDue` accessor both
// stay correct.
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
    CASE
      WHEN json_extract(payload, '$.next_review_due') IS NULL THEN 0
      WHEN json_extract(payload, '$.next_review_due')
           <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 1
      ELSE 0
    END                                                     AS past_due,
    payload                                                 AS payload
  FROM current
  WHERE json_extract(payload, '$.lifecycle') = 'rolling_active'
    AND json_extract(payload, '$.next_review_due') IS NOT NULL;
`;

// watch_edge_observations_view — for every `task_edge_recorded { kind:"watches",
// from_task: A, to_task: T }`, surface the most-recent visible event emitted on
// the upstream task A. The brain (and prompt composer) read this so a
// downstream task T sees what its watched upstreams have produced mid-flight.
// "Visible" kinds are the ones snapshotWatchedOutputs surfaces:
// task_committed / action_scored / artifact_observed / task_ready /
// task_node_opened. We keep the MOST-RECENT row per (downstream, upstream,
// event_kind) — this matches `snapshot_now` consistency at the view level; the
// TS helper (`runtime/watch_edges.ts:snapshotWatchedOutputs`) still owns the
// per-edge consistency-mode dispatch when callers need monotonic history.
//
// Columns:
//   downstream_task_id  — the watching task (edge.to_task).
//   upstream_task_id    — the watched task   (edge.from_task).
//   event_kind          — the observed event kind on upstream.
//   observed_at         — ts of the observation.
//   payload             — the observation payload (TEXT JSON; caller parses).
//   consistency_mode    — declared on the edge (`monotonic` / `snapshot_now` /
//                         `read_your_writes`); the view stamps the literal so
//                         the caller can route deeper if needed.
const VIEW_WATCH_EDGE_OBSERVATIONS = `
CREATE VIEW IF NOT EXISTS watch_edge_observations_view AS
  WITH watch_edges AS (
    SELECT
      json_extract(payload, '$.from_task')                     AS upstream_task_id,
      json_extract(payload, '$.to_task')                       AS downstream_task_id,
      COALESCE(
        json_extract(payload, '$.consistency_mode'),
        'monotonic'
      )                                                         AS consistency_mode
    FROM events
    WHERE kind = 'task_edge_recorded'
      AND json_extract(payload, '$.kind') = 'watches'
      AND json_extract(payload, '$.from_task') IS NOT NULL
      AND json_extract(payload, '$.to_task')   IS NOT NULL
  ),
  upstream_events AS (
    SELECT
      e.task_id    AS upstream_task_id,
      e.ts         AS ts,
      e.kind       AS event_kind,
      e.payload    AS payload,
      e.id         AS event_id
    FROM events e
    WHERE e.kind IN (
      'task_committed',
      'action_scored',
      'artifact_observed',
      'task_ready',
      'task_node_opened'
    )
  ),
  joined AS (
    SELECT
      w.downstream_task_id                                       AS downstream_task_id,
      w.upstream_task_id                                         AS upstream_task_id,
      w.consistency_mode                                         AS consistency_mode,
      u.event_kind                                               AS event_kind,
      u.ts                                                       AS observed_at,
      u.payload                                                  AS payload,
      u.event_id                                                 AS event_id,
      ROW_NUMBER() OVER (
        PARTITION BY w.downstream_task_id, w.upstream_task_id, u.event_kind
        ORDER BY u.ts DESC, u.event_id DESC
      ) AS rn
    FROM watch_edges w
    JOIN upstream_events u
      ON u.upstream_task_id = w.upstream_task_id
  )
  SELECT downstream_task_id, upstream_task_id, consistency_mode,
         event_kind, observed_at, payload, event_id
  FROM joined
  WHERE rn = 1;
`;

// directive_conflicts_view — cross-directive interference edges projected to
// (from_directive, to_directive, interaction). The `interaction` column
// reads payload.interaction first (v2-design.md §3.4 canonical naming) and
// falls back to payload.kind (Phase I emitter still uses this) so the view
// surfaces edges from both eras of the codebase. `payload` is retained for
// callers that need the full row.
const VIEW_DIRECTIVE_CONFLICTS = `
CREATE VIEW IF NOT EXISTS directive_conflicts_view AS
  SELECT
    id                                                       AS event_id,
    ts,
    directive_id,
    json_extract(payload, '$.from_directive')                AS from_directive,
    json_extract(payload, '$.to_directive')                  AS to_directive,
    COALESCE(
      json_extract(payload, '$.interaction'),
      json_extract(payload, '$.kind')
    )                                                         AS interaction,
    payload,
    context_refs
  FROM events
  WHERE kind = 'directive_interference_edge'
  ORDER BY ts DESC;
`;

// stakeholder_state_view — latest stakeholder_state_recorded row per
// (directive_id, stakeholder_id). Older rows stay in events for audit but
// the view projects only the freshest declaration. Phase I (§3.3, §4.2).
//
// Tie-break: when two events share `ts` (sub-millisecond inserts in tests
// or under load), `id` is not monotonic (newId() is UUID-derived, not ULID
// time-prefixed). We use the SQLite implicit `rowid` (insertion order) as
// the secondary key — that is always monotonic and matches the actual
// append order in the event log. This closes the Phase Audit stakeholder
// flake (millisecond ts tie-break).
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
        ORDER BY e.ts DESC, e.rowid DESC
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
  -- Brain audit A2 (2026-05-15): pre-fix the terminal CTE only included
  -- goal_committed / goal_abandoned and ignored the substrate's own
  -- directive_closed (emitted by maybeCloseFinishedDirective when every
  -- task in a finite directive reaches a terminal state). Father saw
  -- already-closed finite directives as active objectives. Also include
  -- directive_archived_by_operator — owner-initiated archives are
  -- terminal for the active-objectives projection.
  terminal AS (
    SELECT DISTINCT directive_id
    FROM events
    WHERE kind IN ('goal_committed', 'goal_abandoned', 'directive_closed', 'directive_archived_by_operator')
  ),
  -- A directive marked archived via missed reviews is also off the
  -- active list; this CTE existed pre-A2 and is kept separate to
  -- preserve test fixtures that rely on the archived kind alone.
  archived AS (
    SELECT DISTINCT directive_id
    FROM events
    WHERE kind = 'directive_archived_missed_reviews'
  ),
  -- A directive can be resumed AFTER an archive/close event; the latest
  -- archive/resume row determines liveness (mirrors closedDirectiveIds
  -- in runtime/directive_closure.ts). Without this CTE a directive
  -- archived once-and-then-resumed would stay off active_objectives_view
  -- forever even though the operator explicitly resumed it.
  latest_lifecycle AS (
    SELECT e.directive_id, e.kind
    FROM events e
    JOIN (
      SELECT directive_id, MAX(ts) AS max_ts
      FROM events
      WHERE kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews', 'directive_resumed')
      GROUP BY directive_id
    ) latest ON latest.directive_id = e.directive_id AND latest.max_ts = e.ts
    WHERE e.kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews', 'directive_resumed')
  )
  SELECT
    d.directive_id,
    d.opened_ts,
    d.payload
  FROM directives d
  WHERE d.directive_id NOT IN (SELECT directive_id FROM terminal)
    AND d.directive_id NOT IN (SELECT directive_id FROM archived)
    AND d.directive_id NOT IN (
      SELECT directive_id FROM latest_lifecycle WHERE kind != 'directive_resumed'
    );
`;

// low_risk_inline_patterns_view — Phase Audit (§3.6 dispatch decider).
// Surfaces `knowledge_promoted` rows tagged `low_risk_inline_pattern` whose
// score AND confidence cross the inline lane thresholds. The dispatch
// decider reads this view to decide if a directive's target files match a
// promoted pattern; when the array is empty (default until Phase H+ seeds
// some), the inline lane is fail-closed (see runtime/dispatch_decider.ts).
//
// The view emits one row per promoted pattern carrying:
//   - cited_id       (the knowledge_promoted event id; passed to
//                     recordLowRiskInlineOutcome for credit)
//   - pattern_kind   ('extension' | 'prefix' | 'exact' | 'glob')
//   - pattern        (the literal pattern body)
//   - score / confidence
// Origins promoting "advisory" knowledge that lack the required tag are
// excluded entirely; the view is the single source of truth for the
// inline lane.
const VIEW_LOW_RISK_INLINE_PATTERNS = `
CREATE VIEW IF NOT EXISTS low_risk_inline_patterns_view AS
  SELECT
    id                                                  AS cited_id,
    ts                                                  AS ts,
    substrate_origin                                    AS substrate_origin,
    json_extract(payload, '$.pattern_kind')             AS pattern_kind,
    json_extract(payload, '$.pattern')                  AS pattern,
    json_extract(payload, '$.score')                    AS score,
    json_extract(payload, '$.confidence')               AS confidence,
    payload                                              AS payload
  FROM events
  WHERE kind = 'knowledge_promoted'
    AND EXISTS (
      SELECT 1
      FROM json_each(coalesce(json_extract(payload, '$.tags'), '[]'))
      WHERE json_each.value = 'low_risk_inline_pattern'
    )
    AND CAST(json_extract(payload, '$.score') AS REAL) >= 0.7
    AND CAST(json_extract(payload, '$.confidence') AS REAL) >= 0.6;
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

// promoted_knowledge_view — Batch 3.ADMIN. Operator-facing inspection
// surface used by `acc admin inspect-knowledge`. Joins each
// `knowledge_promoted` event back to its source `knowledge_candidate`
// (via the first context_ref → candidate_id) so the row carries the
// canonical text + tags alongside the merger's score/confidence stamp.
//
// Columns:
//   event_id         — knowledge_promoted event id (stable handle).
//   ts               — promotion ts.
//   substrate_origin — which agent first emitted the candidate.
//   candidate_id     — the originating knowledge_candidate row id.
//   directive_id     — directive under which the candidate was born.
//   score            — Beta(α,β) mean at promotion time.
//   confidence       — 1 − 1/√(α+β+1) at promotion time.
//   text             — verbatim candidate text (NULL when the candidate
//                      row has been GC'd or its payload lacks `text`).
//   tags             — JSON array (TEXT) — empty array when absent.
//   context_refs     — citation chain at promotion time (TEXT).
//
// The candidate join is LEFT so promotion rows whose candidate has been
// pruned still surface (text + tags fall back to NULL / '[]'). The view
// itself is read-only; the inspect-knowledge CLI applies filters
// (--origin, --since, --limit) at the query site.
const VIEW_PROMOTED_KNOWLEDGE = `
CREATE VIEW IF NOT EXISTS promoted_knowledge_view AS
  SELECT
    p.id                                                          AS event_id,
    p.ts                                                          AS ts,
    p.substrate_origin                                            AS substrate_origin,
    COALESCE(
      json_extract(p.payload, '$.candidate_id'),
      json_extract(p.context_refs, '$[0]')
    )                                                              AS candidate_id,
    p.directive_id                                                AS directive_id,
    -- Organism-alignment audit b3qc9ryzj finding #7 (2026-05-15):
    -- absent score/confidence/tags shouldn't masquerade as
    -- "explicit zero / empty tags". Preserve NULL semantics so
    -- callers can distinguish "producer omitted the field" from
    -- "producer wrote 0".
    CAST(json_extract(p.payload, '$.score') AS REAL)               AS score,
    CAST(json_extract(p.payload, '$.confidence') AS REAL)          AS confidence,
    -- Brain knowledge audit bc5vdkrik finding #2 (2026-05-15): the
    -- candidate payload can carry the truth-bearing text under any of
    -- {text, claim, summary, insight}. The synthesized variant lives
    -- on the promotion payload as synthesized_text. Walk the canonical
    -- fallback chain so the view returns a useful string instead of
    -- '(no text)' for valid promotions with non-text-keyed candidates.
    COALESCE(
      json_extract(c.payload, '$.text'),
      json_extract(c.payload, '$.claim'),
      json_extract(c.payload, '$.summary'),
      json_extract(c.payload, '$.insight'),
      json_extract(p.payload, '$.synthesized_text')
    )                                                              AS text,
    json_extract(c.payload, '$.tags')                              AS tags,
    p.context_refs                                                 AS context_refs
  FROM events p
  LEFT JOIN events c
    ON c.kind = 'knowledge_candidate'
   AND c.id = COALESCE(
         json_extract(p.payload, '$.candidate_id'),
         json_extract(p.context_refs, '$[0]')
       )
  WHERE p.kind = 'knowledge_promoted';
`;

// recipe_registry_view — operator-facing projection of the latest
// recipe_extracted row per (goal_shape, topology_signature). Recipe updates are
// append-only recipe_extracted rows, so callers need the freshest row for each
// composite recipe key rather than a raw history scan.
const VIEW_RECIPE_REGISTRY = `
CREATE VIEW IF NOT EXISTS recipe_registry_view AS
  WITH recipes AS (
    SELECT
      e.rowid                                                        AS event_rowid,
      e.id                                                           AS recipe_id,
      e.id                                                           AS id,
      e.ts                                                           AS ts,
      e.directive_id                                                 AS directive_id,
      e.task_id                                                      AS task_id,
      CAST(COALESCE(json_extract(e.payload, '$.confidence'), 0) AS REAL) AS confidence,
      json_extract(e.payload, '$.goal_shape')                        AS goal_shape,
      -- Topology / status: preserve NULL semantics so callers can
      -- distinguish "absent" from "explicit empty string" / "explicit
      -- 'extracted'". Brain dataflow audit bxdhdkm9e #4 (2026-05-15) —
      -- the prior COALESCE-to-empty / COALESCE-to-'extracted' fallback
      -- hid absence under a default value.
      json_extract(e.payload, '$.topology_signature')                AS topology_signature,
      json_extract(e.payload, '$.seeded_by')                         AS status,
      e.payload                                                      AS payload,
      e.context_refs                                                 AS context_refs
    FROM events e
    WHERE e.kind = 'recipe_extracted'
  )
  SELECT
    recipe_id,
    id,
    ts,
    directive_id,
    task_id,
    confidence,
    goal_shape,
    topology_signature,
    status,
    payload,
    context_refs
  FROM recipes r
  WHERE NOT EXISTS (
    SELECT 1
    FROM recipes newer
    -- Organism-alignment audit b3qc9ryzj #6 (2026-05-15): distinguish
    -- absent (NULL) from explicit empty string. Pre-fix COALESCE(...,'')
    -- merged NULL goal_shape with '' goal_shape, collapsing two
    -- structurally-distinct recipe keys into one. Now NULL matches
    -- NULL exactly and '' matches '' exactly, never crosswise.
    WHERE ((newer.goal_shape = r.goal_shape) OR (newer.goal_shape IS NULL AND r.goal_shape IS NULL))
      AND ((newer.topology_signature = r.topology_signature) OR (newer.topology_signature IS NULL AND r.topology_signature IS NULL))
      AND (newer.ts > r.ts OR (newer.ts = r.ts AND newer.event_rowid > r.event_rowid))
  );
`;

// lesson_implementer_queue_view — derived inbox for the lesson-implementer
// flywheel. It projects lesson_extracted / contract_amendment_proposed rows
// that have not reached applied_change_committed. Owner gating is derived
// from target path + owner_decision_recorded rows; auto-apply eligibility is
// derived from structured proposed_behavior/proposed_action and absence of
// trajectory hazards. The gates are target/shape based, not lesson-kind based.
// No posterior or queue table is stored; the ledger remains the source.
const VIEW_LESSON_IMPLEMENTER_QUEUE = `
CREATE VIEW IF NOT EXISTS lesson_implementer_queue_view AS
  WITH apply_target_policy AS (
    ${lessonApplyTargetPolicyValuesSql()}
  ),
  proposals AS (
    SELECT
      e.id            AS source_event_id,
      e.ts            AS ts,
      e.kind          AS source_kind,
      e.directive_id  AS directive_id,
      e.task_id       AS task_id,
      e.payload       AS payload,
      e.context_refs  AS context_refs,
      json_extract(e.payload, '$.lesson_kind')       AS lesson_kind,
      COALESCE(
        json_extract(e.payload, '$.target'),
        json_extract(e.payload, '$.proposed_behavior.file_path'),
        json_extract(e.payload, '$.proposed_action.file_path')
      )                                             AS target,
      json_extract(e.payload, '$.anchor')            AS anchor,
      json_extract(e.payload, '$.proposed_behavior') AS proposed_behavior,
      json_extract(e.payload, '$.proposed_action')   AS proposed_action,
      COALESCE(
        json_extract(e.payload, '$.target'),
        json_extract(e.payload, '$.proposed_behavior.file_path'),
        json_extract(e.payload, '$.proposed_action.file_path')
      )                                             AS candidate_target,
      COALESCE(
        json_extract(e.payload, '$.anchor'),
        json_extract(e.payload, '$.proposed_behavior.anchor'),
        json_extract(e.payload, '$.proposed_action.anchor')
      )                                             AS candidate_anchor,
      COALESCE(
        json_extract(e.payload, '$.proposed_behavior.diff'),
        json_extract(e.payload, '$.proposed_action.diff')
      )                                             AS candidate_diff,
      json_object(
        'source_event_id', e.id,
        'source_kind', e.kind,
        'lesson_kind', json_extract(e.payload, '$.lesson_kind'),
        'target', COALESCE(
          json_extract(e.payload, '$.target'),
          json_extract(e.payload, '$.proposed_behavior.file_path'),
          json_extract(e.payload, '$.proposed_action.file_path')
        ),
        'anchor', COALESCE(
          json_extract(e.payload, '$.anchor'),
          json_extract(e.payload, '$.proposed_behavior.anchor'),
          json_extract(e.payload, '$.proposed_action.anchor')
        ),
        'diff', COALESCE(
          json_extract(e.payload, '$.proposed_behavior.diff'),
          json_extract(e.payload, '$.proposed_action.diff')
        )
      )                                             AS apply_candidate
    FROM events e
    WHERE e.kind IN ('lesson_extracted', 'contract_amendment_proposed')
  ),
  target_candidates AS (
    SELECT source_event_id, trim(target) AS target
    FROM proposals
    WHERE target IS NOT NULL AND length(trim(target)) > 0
    UNION
    SELECT source_event_id, trim(json_extract(payload, '$.proposed_behavior.file_path')) AS target
    FROM proposals
    WHERE json_type(payload, '$.proposed_behavior') = 'object'
      AND json_extract(payload, '$.proposed_behavior.file_path') IS NOT NULL
      AND length(trim(json_extract(payload, '$.proposed_behavior.file_path'))) > 0
    UNION
    SELECT source_event_id, trim(json_extract(payload, '$.proposed_action.file_path')) AS target
    FROM proposals
    WHERE json_type(payload, '$.proposed_action') = 'object'
      AND json_extract(payload, '$.proposed_action.file_path') IS NOT NULL
      AND length(trim(json_extract(payload, '$.proposed_action.file_path'))) > 0
  ),
  authorized_requests AS (
    SELECT
      json_extract(payload, '$.source_event_id') AS source_event_id,
      id AS request_event_id,
      ts AS requested_at
    FROM events
    WHERE kind = 'lesson_apply_requested'
      AND json_extract(payload, '$.authorization_status') = 'approved'
  ),
  passed_scores AS (
    SELECT
      COALESCE(json_extract(payload, '$.source_event_id'), json_extract(context_refs, '$[0]')) AS source_event_id,
      COALESCE(json_extract(payload, '$.request_event_id'), json_extract(payload, '$.authorization_event_id')) AS request_event_id,
      ts AS scored_at
    FROM events
    WHERE kind = 'action_scored'
      AND CAST(COALESCE(residual, json_extract(payload, '$.residual'), 1) AS REAL) < 0.3
  ),
  committed AS (
    SELECT DISTINCT json_extract(payload, '$.source_event_id') AS source_event_id
    FROM events
    WHERE kind = 'applied_change_committed'
      AND json_extract(payload, '$.status') = 'applied'
      AND CAST(COALESCE(residual, json_extract(payload, '$.residual'), 1) AS REAL) < 0.3
      AND EXISTS (
        SELECT 1 FROM authorized_requests ar
        JOIN passed_scores ps
          ON ps.source_event_id = ar.source_event_id
         AND ps.request_event_id = ar.request_event_id
         AND ps.scored_at <= events.ts
        WHERE ar.source_event_id = json_extract(events.payload, '$.source_event_id')
          AND ar.requested_at <= events.ts
          AND (
            json_extract(events.payload, '$.request_event_id') = ar.request_event_id
            OR json_extract(events.payload, '$.authorization_event_id') = ar.request_event_id
            OR EXISTS (SELECT 1 FROM json_each(events.context_refs) WHERE value = ar.request_event_id)
          )
      )
  ),
  latest_apply AS (
    SELECT
      json_extract(payload, '$.source_event_id') AS source_event_id,
      id AS apply_event_id,
      kind AS apply_kind,
      json_extract(payload, '$.status') AS apply_status,
      ts AS apply_ts,
      ROW_NUMBER() OVER (
        PARTITION BY json_extract(payload, '$.source_event_id')
        ORDER BY ts DESC, rowid DESC
      ) AS rn
    FROM events
    WHERE kind IN ('lesson_applied', 'contract_amendment_applied')
  ),
  owner_approvals AS (
    SELECT DISTINCT COALESCE(
      json_extract(payload, '$.source_event_id'),
      json_extract(context_refs, '$[0]')
    ) AS source_event_id
    FROM events
    WHERE kind = 'owner_decision_recorded'
      AND json_extract(payload, '$.decision') IN ('approved', 'approve', 'yes')
  ),
  hazards AS (
    SELECT directive_id, COUNT(*) AS hazard_count
    FROM events
    WHERE kind IN ('dispatcher_violation', 'irreversible_effect_recorded')
    GROUP BY directive_id
  ),
  shaped AS (
    SELECT
      p.*,
      CASE
        WHEN json_type(p.payload, '$.proposed_behavior') = 'object'
         AND json_extract(p.payload, '$.proposed_behavior.file_path') = p.target
         AND length(trim(COALESCE(json_extract(p.payload, '$.proposed_behavior.anchor'), ''))) > 0
         AND length(trim(COALESCE(json_extract(p.payload, '$.proposed_behavior.diff'), ''))) > 0
        THEN 1
        WHEN json_type(p.payload, '$.proposed_action') = 'object'
         AND json_extract(p.payload, '$.proposed_action.file_path') = p.target
         AND length(trim(COALESCE(json_extract(p.payload, '$.proposed_action.anchor'), ''))) > 0
         AND length(trim(COALESCE(json_extract(p.payload, '$.proposed_action.diff'), ''))) > 0
        THEN 1
        ELSE 0
      END AS structured_change
    FROM proposals p
  ),
  target_policy AS (
    SELECT
      s.*,
      CASE WHEN EXISTS (
        SELECT 1 FROM apply_target_policy r
        JOIN target_candidates tc ON tc.source_event_id = s.source_event_id
        WHERE r.effect = 'owner_consent_required'
          AND (
            (r.match = 'exact' AND tc.target = r.pattern)
            OR (r.match = 'prefix' AND tc.target LIKE r.pattern || '%')
          )
      ) THEN 1 ELSE 0 END AS owner_gate_required,
      CASE WHEN EXISTS (
        SELECT 1 FROM target_candidates tc
        WHERE tc.source_event_id = s.source_event_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM target_candidates tc
        WHERE tc.source_event_id = s.source_event_id
          AND NOT EXISTS (
            SELECT 1 FROM apply_target_policy r
            WHERE r.effect = 'safe_auto_apply_candidate'
              AND (
                (r.match = 'exact' AND tc.target = r.pattern)
                OR (r.match = 'prefix' AND tc.target LIKE r.pattern || '%')
              )
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM apply_target_policy r
        JOIN target_candidates tc ON tc.source_event_id = s.source_event_id
        WHERE r.effect = 'owner_consent_required'
          AND (
            (r.match = 'exact' AND tc.target = r.pattern)
            OR (r.match = 'prefix' AND tc.target LIKE r.pattern || '%')
          )
      ) THEN 1 ELSE 0 END AS auto_apply_target
    FROM shaped s
  )
  SELECT
    p.source_event_id,
    p.ts,
    p.source_kind,
    p.directive_id,
    p.task_id,
    p.lesson_kind,
    p.target,
    p.anchor,
    p.proposed_behavior,
    p.proposed_action,
    p.candidate_target,
    p.candidate_anchor,
    p.candidate_diff,
    p.apply_candidate,
    p.owner_gate_required,
    CASE WHEN oa.source_event_id IS NULL THEN 0 ELSE 1 END AS owner_approved,
    CASE
      WHEN p.owner_gate_required = 1 AND oa.source_event_id IS NULL
      THEN 'owner_consent_required'
      WHEN p.owner_gate_required = 1
      THEN 'owner_consent_approved'
      ELSE 'owner_consent_not_required'
    END AS owner_gate_verdict,
    p.auto_apply_target,
    p.structured_change,
    COALESCE(h.hazard_count, 0) AS trajectory_hazard_count,
    CASE
      WHEN p.auto_apply_target = 1
       AND p.structured_change = 1
       AND COALESCE(h.hazard_count, 0) = 0
      THEN 1 ELSE 0
    END AS auto_apply_eligible,
    CASE
      WHEN p.owner_gate_required = 1
      THEN 'not_auto_apply_owner_gated'
      WHEN p.auto_apply_target = 0
      THEN 'not_auto_apply_target'
      WHEN COALESCE(h.hazard_count, 0) > 0
      THEN 'blocked_trajectory_hazard'
      WHEN p.structured_change = 0
      THEN 'blocked_unstructured_proposal'
      ELSE 'auto_apply_eligible'
    END AS auto_apply_gate_verdict,
    CASE
      WHEN p.owner_gate_required = 1 AND oa.source_event_id IS NULL
      THEN 'blocked_owner_consent'
      WHEN p.auto_apply_target = 1
       AND COALESCE(h.hazard_count, 0) > 0
      THEN 'blocked_trajectory_hazard'
      WHEN p.auto_apply_target = 1
       AND p.structured_change = 0
      THEN 'blocked_unstructured_proposal'
      WHEN p.owner_gate_required = 1
      THEN 'authorized_owner'
      WHEN p.auto_apply_target = 1
      THEN 'authorized_auto'
      ELSE 'manual_review'
    END AS apply_gate_status,
    CASE
      WHEN p.owner_gate_required = 1 AND oa.source_event_id IS NULL
      THEN 'owner_consent_missing'
      WHEN p.auto_apply_target = 1
       AND COALESCE(h.hazard_count, 0) > 0
      THEN 'trajectory_hazard_present'
      WHEN p.auto_apply_target = 1
       AND p.structured_change = 0
      THEN 'structured_proposed_behavior_required'
      ELSE NULL
    END AS apply_gate_reason,
     la.apply_event_id,
    la.apply_kind,
    la.apply_status,
    la.apply_ts,
    p.payload,
    p.context_refs
  FROM target_policy p
  LEFT JOIN committed c ON c.source_event_id = p.source_event_id
  LEFT JOIN latest_apply la ON la.source_event_id = p.source_event_id AND la.rn = 1
  LEFT JOIN owner_approvals oa ON oa.source_event_id = p.source_event_id
  LEFT JOIN hazards h ON h.directive_id = p.directive_id
  WHERE c.source_event_id IS NULL;
`;

// lesson_implementation_status_view — one row per proposal with its latest
// authorization request, action_predicted row, verifier residual (via
// action_scored citing the proposal), apply event, and terminal
// applied_change_committed event. Executor prediction and terminal commit are
// only projected when they cite a prior approved authorization request, so the
// observable state machine cannot skip the owner/auto gate.
const VIEW_LESSON_IMPLEMENTATION_STATUS = `
CREATE VIEW IF NOT EXISTS lesson_implementation_status_view AS
  WITH proposals AS (
    SELECT
      id AS source_event_id,
      ts,
      kind AS source_kind,
      directive_id,
      task_id,
      json_object(
        'source_event_id', id,
        'source_kind', kind,
        'lesson_kind', json_extract(payload, '$.lesson_kind'),
        'target', COALESCE(
          json_extract(payload, '$.target'),
          json_extract(payload, '$.proposed_behavior.file_path'),
          json_extract(payload, '$.proposed_action.file_path')
        ),
        'anchor', COALESCE(
          json_extract(payload, '$.anchor'),
          json_extract(payload, '$.proposed_behavior.anchor'),
          json_extract(payload, '$.proposed_action.anchor')
        ),
        'diff', COALESCE(
          json_extract(payload, '$.proposed_behavior.diff'),
          json_extract(payload, '$.proposed_action.diff')
        )
      ) AS apply_candidate,
      payload,
      context_refs
    FROM events
    WHERE kind IN ('lesson_extracted', 'contract_amendment_proposed')
  ),
  latest_request AS (
    SELECT
      json_extract(payload, '$.source_event_id') AS source_event_id,
      id AS request_event_id,
      ts AS requested_at,
      json_extract(payload, '$.authorization_status') AS authorization_status,
      ROW_NUMBER() OVER (
        PARTITION BY json_extract(payload, '$.source_event_id')
        ORDER BY ts DESC, rowid DESC
      ) AS rn
    FROM events
    WHERE kind = 'lesson_apply_requested'
  ),
  authorized_requests AS (
    SELECT
      json_extract(payload, '$.source_event_id') AS source_event_id,
      id AS request_event_id,
      ts AS requested_at
    FROM events
    WHERE kind = 'lesson_apply_requested'
      AND json_extract(payload, '$.authorization_status') = 'approved'
  ),
  latest_action AS (
    SELECT
      COALESCE(json_extract(payload, '$.source_event_id'), json_extract(context_refs, '$[0]')) AS source_event_id,
      id AS action_event_id,
      ts AS predicted_at,
      action_artifact_id,
      verifier_artifact_id,
      predicted_residual,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(json_extract(payload, '$.source_event_id'), json_extract(context_refs, '$[0]'))
        ORDER BY ts DESC, rowid DESC
      ) AS rn
    FROM events
    WHERE kind = 'action_predicted'
      AND EXISTS (
        SELECT 1 FROM authorized_requests ar
        WHERE ar.source_event_id = COALESCE(json_extract(events.payload, '$.source_event_id'), json_extract(events.context_refs, '$[0]'))
          AND ar.requested_at <= events.ts
          AND (
            json_extract(events.payload, '$.request_event_id') = ar.request_event_id
            OR json_extract(events.payload, '$.authorization_event_id') = ar.request_event_id
            OR EXISTS (SELECT 1 FROM json_each(events.context_refs) WHERE value = ar.request_event_id)
          )
      )
  ),
  latest_scored AS (
    SELECT
      COALESCE(json_extract(payload, '$.source_event_id'), json_extract(context_refs, '$[0]')) AS source_event_id,
      id AS scored_event_id,
      ts AS scored_at,
      residual AS verifier_residual,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(json_extract(payload, '$.source_event_id'), json_extract(context_refs, '$[0]'))
        ORDER BY ts DESC, rowid DESC
      ) AS rn
    FROM events
    WHERE kind = 'action_scored'
      AND EXISTS (
        SELECT 1 FROM authorized_requests ar
        WHERE ar.source_event_id = COALESCE(json_extract(events.payload, '$.source_event_id'), json_extract(events.context_refs, '$[0]'))
          AND ar.requested_at <= events.ts
          AND (
            json_extract(events.payload, '$.request_event_id') = ar.request_event_id
            OR json_extract(events.payload, '$.authorization_event_id') = ar.request_event_id
            OR EXISTS (SELECT 1 FROM json_each(events.context_refs) WHERE value = ar.request_event_id)
          )
      )
  ),
  latest_apply AS (
    SELECT
      json_extract(payload, '$.source_event_id') AS source_event_id,
      id AS apply_event_id,
      kind AS apply_kind,
      json_extract(payload, '$.status') AS apply_status,
      json_extract(payload, '$.commit_sha') AS commit_sha,
      ts AS applied_at,
      ROW_NUMBER() OVER (
        PARTITION BY json_extract(payload, '$.source_event_id')
        ORDER BY ts DESC, rowid DESC
      ) AS rn
    FROM events
    WHERE kind IN ('lesson_applied', 'contract_amendment_applied')
  ),
  terminal AS (
    SELECT
      json_extract(payload, '$.source_event_id') AS source_event_id,
      id AS committed_event_id,
      ts AS committed_at,
      ROW_NUMBER() OVER (
        PARTITION BY json_extract(payload, '$.source_event_id')
        ORDER BY ts DESC, rowid DESC
      ) AS rn
    FROM events
    WHERE kind = 'applied_change_committed'
      AND json_extract(payload, '$.status') = 'applied'
      AND CAST(COALESCE(residual, json_extract(payload, '$.residual'), 1) AS REAL) < 0.3
      AND EXISTS (
        SELECT 1 FROM authorized_requests ar
        JOIN events s
          ON s.kind = 'action_scored'
         AND COALESCE(json_extract(s.payload, '$.source_event_id'), json_extract(s.context_refs, '$[0]')) = ar.source_event_id
         AND CAST(COALESCE(s.residual, json_extract(s.payload, '$.residual'), 1) AS REAL) < 0.3
         AND s.ts <= events.ts
         AND (
           json_extract(s.payload, '$.request_event_id') = ar.request_event_id
           OR json_extract(s.payload, '$.authorization_event_id') = ar.request_event_id
           OR EXISTS (SELECT 1 FROM json_each(s.context_refs) WHERE value = ar.request_event_id)
         )
        WHERE ar.source_event_id = json_extract(events.payload, '$.source_event_id')
          AND ar.requested_at <= events.ts
          AND (
            json_extract(events.payload, '$.request_event_id') = ar.request_event_id
            OR json_extract(events.payload, '$.authorization_event_id') = ar.request_event_id
            OR EXISTS (SELECT 1 FROM json_each(events.context_refs) WHERE value = ar.request_event_id)
          )
      )
  )
  SELECT
    p.source_event_id,
    p.ts,
    p.source_kind,
    p.directive_id,
    p.task_id,
    lr.request_event_id,
    lr.requested_at,
    laction.action_event_id,
    laction.predicted_at,
    laction.action_artifact_id,
    laction.verifier_artifact_id,
    laction.predicted_residual,
    ls.scored_event_id,
    ls.scored_at,
    ls.verifier_residual,
    CASE WHEN ls.verifier_residual IS NOT NULL AND CAST(ls.verifier_residual AS REAL) < 0.3 THEN 1 ELSE 0 END AS verifier_passed,
    la.apply_event_id,
    la.apply_kind,
    la.apply_status,
    la.commit_sha,
    la.applied_at,
    t.committed_event_id,
    t.committed_at,
    CASE
      WHEN t.committed_event_id IS NOT NULL THEN 'committed'
      WHEN la.apply_status IS NOT NULL THEN la.apply_status
      WHEN ls.verifier_residual IS NOT NULL THEN 'verified'
      WHEN laction.action_event_id IS NOT NULL THEN 'predicted'
      WHEN lr.request_event_id IS NOT NULL THEN 'requested'
      ELSE 'proposed'
    END AS flywheel_status,
    p.apply_candidate,
    p.payload,
    p.context_refs
  FROM proposals p
  LEFT JOIN latest_request lr ON lr.source_event_id = p.source_event_id AND lr.rn = 1
  LEFT JOIN latest_action laction ON laction.source_event_id = p.source_event_id AND laction.rn = 1
  LEFT JOIN latest_scored ls ON ls.source_event_id = p.source_event_id AND ls.rn = 1
  LEFT JOIN latest_apply la ON la.source_event_id = p.source_event_id AND la.rn = 1
  LEFT JOIN terminal t ON t.source_event_id = p.source_event_id AND t.rn = 1;
`;

// applied_lesson_effectiveness_view — feedback signal for compounding. It is
// entirely derived from event citations: a future trajectory must cite the
// original lesson/amendment source_event_id for the cheaper-next signal to
// accrue. Signals are lower verifier residual, fewer DAG nodes, or Tier-0
// recipe replay; no separate posterior table is necessary because the normal
// action_scored credit path updates cited entities.
const VIEW_APPLIED_LESSON_EFFECTIVENESS = `
CREATE VIEW IF NOT EXISTS applied_lesson_effectiveness_view AS
  WITH committed AS (
    SELECT
      json_extract(payload, '$.source_event_id') AS source_event_id,
      id AS applied_change_event_id,
      directive_id AS source_directive_id,
      task_id AS source_task_id,
      ts AS committed_at,
      CAST(COALESCE(residual, json_extract(payload, '$.residual'), 1) AS REAL) AS apply_residual,
      payload AS applied_payload,
      context_refs AS applied_context_refs
    FROM events
    WHERE kind = 'applied_change_committed'
      AND json_extract(payload, '$.status') = 'applied'
      AND CAST(COALESCE(residual, json_extract(payload, '$.residual'), 1) AS REAL) < 0.3
      AND EXISTS (
        SELECT 1 FROM events ar
        JOIN events s
          ON s.kind = 'action_scored'
         AND COALESCE(json_extract(s.payload, '$.source_event_id'), json_extract(s.context_refs, '$[0]')) = json_extract(ar.payload, '$.source_event_id')
         AND CAST(COALESCE(s.residual, json_extract(s.payload, '$.residual'), 1) AS REAL) < 0.3
         AND s.ts <= events.ts
         AND (
           json_extract(s.payload, '$.request_event_id') = ar.id
           OR json_extract(s.payload, '$.authorization_event_id') = ar.id
           OR EXISTS (SELECT 1 FROM json_each(s.context_refs) WHERE value = ar.id)
         )
        WHERE ar.kind = 'lesson_apply_requested'
          AND json_extract(ar.payload, '$.authorization_status') = 'approved'
          AND json_extract(ar.payload, '$.source_event_id') = json_extract(events.payload, '$.source_event_id')
          AND ar.ts <= events.ts
          AND (
            json_extract(events.payload, '$.request_event_id') = ar.id
            OR json_extract(events.payload, '$.authorization_event_id') = ar.id
            OR EXISTS (SELECT 1 FROM json_each(events.context_refs) WHERE value = ar.id)
          )
      )
  ),
  source_cost AS (
    SELECT
      c.source_event_id,
      COUNT(DISTINCT n.task_id) AS source_dag_nodes,
      MIN(CAST(s.residual AS REAL)) AS source_best_residual
    FROM committed c
    LEFT JOIN events n
      ON n.directive_id = c.source_directive_id
     AND n.kind = 'task_node_opened'
    LEFT JOIN events s
      ON s.directive_id = c.source_directive_id
     AND s.kind = 'action_scored'
     AND s.residual IS NOT NULL
    GROUP BY c.source_event_id
  ),
  future_scored AS (
    SELECT
      c.source_event_id,
      s.id AS next_scored_event_id,
      s.directive_id AS next_directive_id,
      s.task_id AS next_task_id,
      s.ts AS next_scored_at,
      CAST(s.residual AS REAL) AS next_residual,
      ROW_NUMBER() OVER (
        PARTITION BY c.source_event_id
        ORDER BY s.ts ASC, s.rowid ASC
      ) AS rn
    FROM committed c
    JOIN events s
      ON s.kind = 'action_scored'
     AND s.ts > c.committed_at
     AND (
       json_extract(s.payload, '$.source_event_id') = c.source_event_id
       OR EXISTS (
         SELECT 1 FROM json_each(COALESCE(s.context_refs, '[]'))
         WHERE value = c.source_event_id
       )
     )
  ),
  next_cost AS (
    SELECT
      fs.source_event_id,
      fs.next_scored_event_id,
      fs.next_directive_id,
      fs.next_task_id,
      fs.next_scored_at,
      fs.next_residual,
      COUNT(DISTINCT n.task_id) AS next_dag_nodes
    FROM future_scored fs
    LEFT JOIN events n
      ON n.directive_id = fs.next_directive_id
     AND n.kind = 'task_node_opened'
    WHERE fs.rn = 1
    GROUP BY fs.source_event_id
  ),
  future_recipe AS (
    SELECT
      c.source_event_id,
      r.id AS recipe_replay_event_id,
      r.ts AS recipe_replayed_at,
      ROW_NUMBER() OVER (
        PARTITION BY c.source_event_id
        ORDER BY r.ts ASC, r.rowid ASC
      ) AS rn
    FROM committed c
    JOIN events r
      ON r.ts > c.committed_at
     AND r.kind IN ('recipe_invoked', 'action_predicted', 'action_scored', 'task_committed')
     AND (
       json_extract(r.payload, '$.recipe_replayed') = 1
       OR json_extract(r.payload, '$.recipe_replayed') = 'true'
       OR json_extract(r.payload, '$.route') = 'substrate_replay'
       OR r.kind = 'recipe_invoked'
     )
     AND (
       json_extract(r.payload, '$.source_event_id') = c.source_event_id
       OR EXISTS (
         SELECT 1 FROM json_each(COALESCE(r.context_refs, '[]'))
         WHERE value = c.source_event_id
       )
     )
  )
  SELECT
    c.source_event_id,
    c.applied_change_event_id,
    c.source_directive_id,
    c.source_task_id,
    c.committed_at,
    c.apply_residual,
    COALESCE(sc.source_dag_nodes, 0) AS source_dag_nodes,
    sc.source_best_residual,
    nc.next_scored_event_id,
    nc.next_directive_id,
    nc.next_task_id,
    nc.next_scored_at,
    nc.next_residual,
    COALESCE(nc.next_dag_nodes, 0) AS next_dag_nodes,
    fr.recipe_replay_event_id,
    fr.recipe_replayed_at,
    CASE
      WHEN nc.next_residual IS NOT NULL AND sc.source_best_residual IS NOT NULL
      THEN sc.source_best_residual - nc.next_residual
      ELSE NULL
    END AS residual_delta,
    CASE
      WHEN nc.next_scored_event_id IS NOT NULL
      THEN COALESCE(sc.source_dag_nodes, 0) - COALESCE(nc.next_dag_nodes, 0)
      ELSE NULL
    END AS dag_node_delta,
    CASE WHEN fr.recipe_replay_event_id IS NULL THEN 0 ELSE 1 END AS tier0_replay_hit,
    CASE
      WHEN fr.recipe_replay_event_id IS NOT NULL THEN 1
      WHEN nc.next_residual IS NOT NULL AND sc.source_best_residual IS NOT NULL AND nc.next_residual < sc.source_best_residual THEN 1
      WHEN nc.next_scored_event_id IS NOT NULL AND COALESCE(nc.next_dag_nodes, 0) < COALESCE(sc.source_dag_nodes, 0) THEN 1
      ELSE 0
    END AS compounded,
    c.applied_payload,
    c.applied_context_refs
  FROM committed c
  LEFT JOIN source_cost sc ON sc.source_event_id = c.source_event_id
  LEFT JOIN next_cost nc ON nc.source_event_id = c.source_event_id
  LEFT JOIN future_recipe fr ON fr.source_event_id = c.source_event_id AND fr.rn = 1;
`;

// lesson_apply_candidate_view — normalized apply-candidate shape for every
// lesson/amendment proposal. This is intentionally derived from the queue,
// status, and effectiveness views instead of adding a table: source proposal,
// gate state, verifier residual, trajectory health, and compounding signal are
// all ledger facts. The projection is kind-agnostic: recipe_candidate,
// verifier_gap, and contract_amendment_proposed differ only in patch_or_recipe.
const VIEW_LESSON_APPLY_CANDIDATE = `
CREATE VIEW IF NOT EXISTS lesson_apply_candidate_view AS
  SELECT
    s.source_event_id,
    COALESCE(
      q.target,
      json_extract(s.payload, '$.target'),
      json_extract(s.payload, '$.proposed_behavior.file_path'),
      json_extract(s.payload, '$.proposed_action.file_path')
    ) AS target,
    COALESCE(
      q.anchor,
      json_extract(s.payload, '$.anchor'),
      json_extract(s.payload, '$.proposed_behavior.anchor'),
      json_extract(s.payload, '$.proposed_action.anchor')
    ) AS anchor,
    CASE
      WHEN json_extract(s.payload, '$.lesson_kind') = 'recipe_candidate'
      THEN COALESCE(
        json_extract(s.payload, '$.proposed_action.recipe'),
        json_extract(s.payload, '$.proposed_action'),
        json_extract(s.payload, '$.patch_or_recipe'),
        json_extract(s.payload, '$.recipe')
      )
      ELSE COALESCE(
        json_extract(s.payload, '$.proposed_behavior'),
        json_extract(s.payload, '$.proposed_action'),
        json_extract(s.payload, '$.patch_or_recipe')
      )
    END AS patch_or_recipe,
    s.verifier_residual,
    json_object(
      'required', COALESCE(q.owner_gate_required, 0),
      'approved', COALESCE(q.owner_approved, CASE WHEN s.flywheel_status = 'committed' THEN 1 ELSE 0 END),
      'status', COALESCE(q.apply_gate_status, s.flywheel_status),
      'reason', q.apply_gate_reason
    ) AS owner_gate,
    json_object(
      'hazard_count', COALESCE(q.trajectory_hazard_count, 0),
      'healthy', CASE WHEN COALESCE(q.trajectory_hazard_count, 0) = 0 THEN 1 ELSE 0 END
    ) AS trajectory_health,
    json_object(
      'compounded', COALESCE(e.compounded, 0),
      'tier0_replay_hit', COALESCE(e.tier0_replay_hit, 0),
      'residual_delta', e.residual_delta,
      'dag_node_delta', e.dag_node_delta,
      'next_scored_event_id', e.next_scored_event_id,
      'recipe_replay_event_id', e.recipe_replay_event_id
    ) AS compounding_metric,
    s.source_kind,
    json_extract(s.payload, '$.lesson_kind') AS lesson_kind,
    s.directive_id,
    s.task_id,
    s.flywheel_status,
    s.payload,
    s.context_refs
  FROM lesson_implementation_status_view s
  LEFT JOIN lesson_implementer_queue_view q ON q.source_event_id = s.source_event_id
  LEFT JOIN applied_lesson_effectiveness_view e ON e.source_event_id = s.source_event_id;
`;

// ── Public entrypoint ──────────────────────────────────────────────

const VIEW_NAMES = [
  "lesson_apply_candidate_view",
  "applied_lesson_effectiveness_view",
  "lesson_implementation_status_view",
  "lesson_implementer_queue_view",
  "recipe_registry_view",
  "promoted_knowledge_view",
  "irreversible_effects_view",
  "low_risk_inline_patterns_view",
  "active_objectives_view",
  "stakeholder_state_view",
  "directive_conflicts_view",
  "watch_edge_observations_view",
  "rolling_review_due_view",
  "owner_conversation_view",
  "contradictory_candidates_view",
  "origin_promotion_by_directive_view",
  "origin_promotion_view",
  "embedding_index_view",
  "artifact_routing_view",
  "code_artifact_registry_view",
  "failure_view",
  "ready_tasks_view",
  "task_graph_view",
] as const;

/** Create every substrate view. Idempotent — existing views are dropped in
 *  reverse dependency order first so changed projection SQL reaches warm DBs.
 *  Daemon callers should run this once at boot AFTER runSchema. Tests
 *  that touch views must call this explicitly. */
export const runViews = (db: Database): void => {
  for (const viewName of VIEW_NAMES) db.exec(`DROP VIEW IF EXISTS ${viewName}`);
  db.exec(VIEW_TASK_GRAPH);
  db.exec(VIEW_READY_TASKS);
  db.exec(VIEW_FAILURE);
  db.exec(VIEW_CODE_ARTIFACT_REGISTRY);
  db.exec(VIEW_ARTIFACT_ROUTING);
  db.exec(VIEW_EMBEDDING_INDEX);
  db.exec(VIEW_ORIGIN_PROMOTION);
  db.exec(VIEW_ORIGIN_PROMOTION_BY_DIRECTIVE);
  db.exec(VIEW_CONTRADICTORY);
  db.exec(VIEW_OWNER_CONVERSATION);
  db.exec(VIEW_ROLLING_REVIEW_DUE);
  db.exec(VIEW_WATCH_EDGE_OBSERVATIONS);
  db.exec(VIEW_DIRECTIVE_CONFLICTS);
  db.exec(VIEW_STAKEHOLDER_STATE);
  db.exec(VIEW_ACTIVE_OBJECTIVES);
  db.exec(VIEW_IRREVERSIBLE_EFFECTS);
  db.exec(VIEW_LOW_RISK_INLINE_PATTERNS);
  db.exec(VIEW_PROMOTED_KNOWLEDGE);
  db.exec(VIEW_RECIPE_REGISTRY);
  db.exec(VIEW_LESSON_IMPLEMENTER_QUEUE);
  db.exec(VIEW_LESSON_IMPLEMENTATION_STATUS);
  db.exec(VIEW_APPLIED_LESSON_EFFECTIVENESS);
  db.exec(VIEW_LESSON_APPLY_CANDIDATE);
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
  /** NULL when there is no signal (candidate_count = 0) or when the row
   *  came from the promotions-only UNION branch. Callers MUST treat null
   *  as "no bias data" — do not coerce to 1.0 (that masks absence as
   *  perfection). Brain dataflow audit bxdhdkm9e #4. */
  promotion_ratio: number | null;
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
  past_due: boolean;
  payload: Record<string, unknown>;
};

export type WatchEdgeObservationRow = {
  downstream_task_id: string;
  upstream_task_id: string;
  consistency_mode: "monotonic" | "snapshot_now" | "read_your_writes";
  event_kind: string;
  observed_at: string;
  payload: Record<string, unknown>;
  event_id: string;
};

export type DirectiveConflictRow = {
  event_id: string;
  ts: string;
  directive_id: string;
  from_directive: string | null;
  to_directive: string | null;
  interaction: string | null;
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

export type LessonImplementerQueueRow = {
  source_event_id: string;
  ts: string;
  source_kind: "lesson_extracted" | "contract_amendment_proposed";
  directive_id: string;
  task_id: string;
  lesson_kind: string | null;
  target: string | null;
  anchor: string | null;
  proposed_behavior: unknown;
  proposed_action: unknown;
  candidate_target: string | null;
  candidate_anchor: string | null;
  candidate_diff: string | null;
  apply_candidate: Record<string, unknown>;
  owner_gate_required: boolean;
  owner_approved: boolean;
  owner_gate_verdict: string;
  auto_apply_target: boolean;
  structured_change: boolean;
  trajectory_hazard_count: number;
  auto_apply_eligible: boolean;
  auto_apply_gate_verdict: string;
  apply_gate_status: string;
  apply_gate_reason: string | null;
  apply_event_id: string | null;
  apply_kind: string | null;
  apply_status: string | null;
  apply_ts: string | null;
  payload: Record<string, unknown>;
  context_refs: string[];
};

export type LessonImplementationStatusRow = {
  source_event_id: string;
  ts: string;
  source_kind: "lesson_extracted" | "contract_amendment_proposed";
  directive_id: string;
  task_id: string;
  request_event_id: string | null;
  requested_at: string | null;
  action_event_id: string | null;
  predicted_at: string | null;
  action_artifact_id: string | null;
  verifier_artifact_id: string | null;
  predicted_residual: number | null;
  scored_event_id: string | null;
  scored_at: string | null;
  verifier_residual: number | null;
  verifier_passed: boolean;
  apply_event_id: string | null;
  apply_kind: string | null;
  apply_status: string | null;
  commit_sha: string | null;
  applied_at: string | null;
  committed_event_id: string | null;
  committed_at: string | null;
  flywheel_status: "proposed" | "requested" | "predicted" | "verified" | "applied" | "failed" | "refused" | "committed" | string;
  apply_candidate: Record<string, unknown>;
  payload: Record<string, unknown>;
  context_refs: string[];
};

export type AppliedLessonEffectivenessRow = {
  source_event_id: string;
  applied_change_event_id: string;
  source_directive_id: string;
  source_task_id: string;
  committed_at: string;
  apply_residual: number;
  source_dag_nodes: number;
  source_best_residual: number | null;
  next_scored_event_id: string | null;
  next_directive_id: string | null;
  next_task_id: string | null;
  next_scored_at: string | null;
  next_residual: number | null;
  next_dag_nodes: number;
  recipe_replay_event_id: string | null;
  recipe_replayed_at: string | null;
  residual_delta: number | null;
  dag_node_delta: number | null;
  tier0_replay_hit: boolean;
  compounded: boolean;
  applied_payload: Record<string, unknown>;
  applied_context_refs: string[];
};

export type LessonApplyCandidateRow = {
  source_event_id: string;
  target: string | null;
  anchor: string | null;
  patch_or_recipe: unknown;
  verifier_residual: number | null;
  owner_gate: Record<string, unknown>;
  trajectory_health: Record<string, unknown>;
  compounding_metric: Record<string, unknown>;
  source_kind: "lesson_extracted" | "contract_amendment_proposed";
  lesson_kind: string | null;
  directive_id: string;
  task_id: string;
  flywheel_status: string;
  payload: Record<string, unknown>;
  context_refs: string[];
};

const parseJson = <T>(s: unknown): T => {
  if (typeof s !== "string") return s as T;
  return JSON.parse(s) as T;
};

const parseMaybeJson = (s: unknown): unknown => {
  if (typeof s !== "string") return s;
  try { return JSON.parse(s) as unknown; } catch { return s; }
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

/** Every rolling_active directive with its latest next_review_due and a
 *  `past_due` boolean (true when next_review_due ≤ now-at-query-time). The
 *  pre-Phase-DAG shape filtered the view to only past-due rows; the new
 *  shape projects every rolling_active row so operators can inspect future
 *  reviews and TS-side callers (rolling_reviewer.ts) still filter on
 *  next_review_due as they did before. */
export const rollingReviewDue = (db: Database): RollingReviewDueRow[] => {
  const rows = db
    .query("SELECT * FROM rolling_review_due_view")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    directive_id: r.directive_id as string,
    latest_ts: r.latest_ts as string,
    lifecycle: r.lifecycle as string,
    next_review_due: r.next_review_due as string,
    past_due: ((r.past_due as number) ?? 0) === 1,
    payload: parseJson<Record<string, unknown>>(r.payload),
  }));
};

/** Latest visible observation per (downstream, upstream, event_kind). When
 *  `downstreamTaskId` is supplied the result is scoped to that watcher; when
 *  omitted, every watch edge's observation row is returned (useful for
 *  audit / TUI). The TS helper `snapshotWatchedOutputs` in
 *  `runtime/watch_edges.ts` owns the per-edge consistency-mode dispatch when
 *  the caller needs `monotonic` (full history) or `read_your_writes`
 *  semantics; this view is the `snapshot_now`-equivalent SQL projection. */
export const watchEdgeObservations = (
  db: Database,
  downstreamTaskId?: string,
): WatchEdgeObservationRow[] => {
  const rows = (downstreamTaskId
    ? db
        .query(
          "SELECT * FROM watch_edge_observations_view WHERE downstream_task_id = ? ORDER BY upstream_task_id ASC, event_kind ASC",
        )
        .all(downstreamTaskId)
    : db
        .query(
          "SELECT * FROM watch_edge_observations_view ORDER BY downstream_task_id ASC, upstream_task_id ASC, event_kind ASC",
        )
        .all()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    downstream_task_id: r.downstream_task_id as string,
    upstream_task_id: r.upstream_task_id as string,
    consistency_mode: (r.consistency_mode as WatchEdgeObservationRow["consistency_mode"]) ?? "monotonic",
    event_kind: r.event_kind as string,
    observed_at: r.observed_at as string,
    payload: parseJson<Record<string, unknown>>(r.payload),
    event_id: r.event_id as string,
  }));
};

/** directive_interference_edge events projected to
 *  (from_directive, to_directive, interaction). When `directiveId` is
 *  supplied, only edges where it appears on either side are returned. The
 *  pre-Phase-DAG shape returned just (event_id, ts, directive_id, payload);
 *  callers that read `payload.from_directive` etc. continue to work via the
 *  retained `payload` field. */
export const directiveConflicts = (
  db: Database,
  directiveId?: string,
): DirectiveConflictRow[] => {
  const rows = (directiveId
    ? db
        .query(
          `SELECT * FROM directive_conflicts_view
           WHERE from_directive = ? OR to_directive = ?`,
        )
        .all(directiveId, directiveId)
    : db.query("SELECT * FROM directive_conflicts_view").all()) as Array<
      Record<string, unknown>
    >;
  return rows.map((r) => ({
    event_id: r.event_id as string,
    ts: r.ts as string,
    directive_id: r.directive_id as string,
    from_directive: (r.from_directive as string | null) ?? null,
    to_directive: (r.to_directive as string | null) ?? null,
    interaction: (r.interaction as string | null) ?? null,
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

/** Pending lesson/amendment proposals with owner-gate and auto-apply flags
 *  derived entirely from events. This is the orchestrator's apply inbox. */
export const lessonImplementerQueue = (db: Database): LessonImplementerQueueRow[] => {
  const rows = db
    .query("SELECT * FROM lesson_implementer_queue_view ORDER BY ts ASC")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    source_event_id: r.source_event_id as string,
    ts: r.ts as string,
    source_kind: r.source_kind as LessonImplementerQueueRow["source_kind"],
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    lesson_kind: (r.lesson_kind as string | null) ?? null,
    target: (r.target as string | null) ?? null,
    anchor: (r.anchor as string | null) ?? null,
    proposed_behavior: parseMaybeJson(r.proposed_behavior),
    proposed_action: parseMaybeJson(r.proposed_action),
    candidate_target: (r.candidate_target as string | null) ?? null,
    candidate_anchor: (r.candidate_anchor as string | null) ?? null,
    candidate_diff: (r.candidate_diff as string | null) ?? null,
    apply_candidate: parseJson<Record<string, unknown>>(r.apply_candidate),
    owner_gate_required: ((r.owner_gate_required as number) ?? 0) === 1,
    owner_approved: ((r.owner_approved as number) ?? 0) === 1,
    owner_gate_verdict: r.owner_gate_verdict as string,
    auto_apply_target: ((r.auto_apply_target as number) ?? 0) === 1,
    structured_change: ((r.structured_change as number) ?? 0) === 1,
    trajectory_hazard_count: (r.trajectory_hazard_count as number) ?? 0,
    auto_apply_eligible: ((r.auto_apply_eligible as number) ?? 0) === 1,
    auto_apply_gate_verdict: r.auto_apply_gate_verdict as string,
    apply_gate_status: r.apply_gate_status as string,
    apply_gate_reason: (r.apply_gate_reason as string | null) ?? null,
    apply_event_id: (r.apply_event_id as string | null) ?? null,
    apply_kind: (r.apply_kind as string | null) ?? null,
    apply_status: (r.apply_status as string | null) ?? null,
    apply_ts: (r.apply_ts as string | null) ?? null,
    payload: parseJson<Record<string, unknown>>(r.payload),
    context_refs: parseJson<string[]>(r.context_refs ?? "[]"),
  }));
};

/** Observable state machine for each proposal in the lesson-implementer
 *  flywheel: proposed → requested → predicted → verified → applied → committed. */
export const lessonImplementationStatus = (db: Database): LessonImplementationStatusRow[] => {
  const rows = db
    .query("SELECT * FROM lesson_implementation_status_view ORDER BY ts ASC")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    source_event_id: r.source_event_id as string,
    ts: r.ts as string,
    source_kind: r.source_kind as LessonImplementationStatusRow["source_kind"],
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    request_event_id: (r.request_event_id as string | null) ?? null,
    requested_at: (r.requested_at as string | null) ?? null,
    action_event_id: (r.action_event_id as string | null) ?? null,
    predicted_at: (r.predicted_at as string | null) ?? null,
    action_artifact_id: (r.action_artifact_id as string | null) ?? null,
    verifier_artifact_id: (r.verifier_artifact_id as string | null) ?? null,
    predicted_residual: (r.predicted_residual as number | null) ?? null,
    scored_event_id: (r.scored_event_id as string | null) ?? null,
    scored_at: (r.scored_at as string | null) ?? null,
    verifier_residual: (r.verifier_residual as number | null) ?? null,
    verifier_passed: ((r.verifier_passed as number) ?? 0) === 1,
    apply_event_id: (r.apply_event_id as string | null) ?? null,
    apply_kind: (r.apply_kind as string | null) ?? null,
    apply_status: (r.apply_status as string | null) ?? null,
    commit_sha: (r.commit_sha as string | null) ?? null,
    applied_at: (r.applied_at as string | null) ?? null,
    committed_event_id: (r.committed_event_id as string | null) ?? null,
    committed_at: (r.committed_at as string | null) ?? null,
    flywheel_status: r.flywheel_status as LessonImplementationStatusRow["flywheel_status"],
    apply_candidate: parseJson<Record<string, unknown>>(r.apply_candidate),
    payload: parseJson<Record<string, unknown>>(r.payload),
    context_refs: parseJson<string[]>(r.context_refs ?? "[]"),
  }));
};

/** Feedback signal for whether an applied lesson made the next cited similar
 *  trajectory cheaper: lower residual, shorter DAG, or Tier-0 replay. */
export const appliedLessonEffectiveness = (db: Database): AppliedLessonEffectivenessRow[] => {
  const rows = db
    .query("SELECT * FROM applied_lesson_effectiveness_view ORDER BY committed_at ASC")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    source_event_id: r.source_event_id as string,
    applied_change_event_id: r.applied_change_event_id as string,
    source_directive_id: r.source_directive_id as string,
    source_task_id: r.source_task_id as string,
    committed_at: r.committed_at as string,
    apply_residual: (r.apply_residual as number) ?? 1,
    source_dag_nodes: (r.source_dag_nodes as number) ?? 0,
    source_best_residual: (r.source_best_residual as number | null) ?? null,
    next_scored_event_id: (r.next_scored_event_id as string | null) ?? null,
    next_directive_id: (r.next_directive_id as string | null) ?? null,
    next_task_id: (r.next_task_id as string | null) ?? null,
    next_scored_at: (r.next_scored_at as string | null) ?? null,
    next_residual: (r.next_residual as number | null) ?? null,
    next_dag_nodes: (r.next_dag_nodes as number) ?? 0,
    recipe_replay_event_id: (r.recipe_replay_event_id as string | null) ?? null,
    recipe_replayed_at: (r.recipe_replayed_at as string | null) ?? null,
    residual_delta: (r.residual_delta as number | null) ?? null,
    dag_node_delta: (r.dag_node_delta as number | null) ?? null,
    tier0_replay_hit: ((r.tier0_replay_hit as number) ?? 0) === 1,
    compounded: ((r.compounded as number) ?? 0) === 1,
    applied_payload: parseJson<Record<string, unknown>>(r.applied_payload),
    applied_context_refs: parseJson<string[]>(r.applied_context_refs ?? "[]"),
  }));
};

/** Kind-agnostic normalized candidate shape consumed by the lesson applier.
 *  The first eight fields are the stable flywheel contract requested by the
 *  brain; trailing fields preserve audit context for operators. */
export const lessonApplyCandidates = (db: Database): LessonApplyCandidateRow[] => {
  const rows = db
    .query("SELECT * FROM lesson_apply_candidate_view ORDER BY source_event_id ASC")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    source_event_id: r.source_event_id as string,
    target: (r.target as string | null) ?? null,
    anchor: (r.anchor as string | null) ?? null,
    patch_or_recipe: parseMaybeJson(r.patch_or_recipe),
    verifier_residual: (r.verifier_residual as number | null) ?? null,
    owner_gate: parseJson<Record<string, unknown>>(r.owner_gate),
    trajectory_health: parseJson<Record<string, unknown>>(r.trajectory_health),
    compounding_metric: parseJson<Record<string, unknown>>(r.compounding_metric),
    source_kind: r.source_kind as LessonApplyCandidateRow["source_kind"],
    lesson_kind: (r.lesson_kind as string | null) ?? null,
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    flywheel_status: r.flywheel_status as string,
    payload: parseJson<Record<string, unknown>>(r.payload),
    context_refs: parseJson<string[]>(r.context_refs ?? "[]"),
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
    promotion_ratio: r.promotion_ratio === null ? null : (r.promotion_ratio as number),
  }));
};

export type OriginGoalShapeRow = {
  substrate_origin: string;
  goal_shape: string;
  candidate_count: number;
  promoted_count: number;
  promotion_ratio: number;
};

export type LowRiskInlinePatternRow = {
  cited_id: string;
  ts: string;
  substrate_origin: string;
  pattern_kind: "extension" | "prefix" | "exact" | "glob";
  pattern: string;
  score: number;
  confidence: number;
};

/** Promoted knowledge entries tagged `low_risk_inline_pattern` with
 *  score ≥ 0.7 AND confidence ≥ 0.6. The dispatch decider reads this view
 *  to decide whether a directive can take the Claude inline lane. Fail-
 *  closed: empty result → no inline lane (§3.6). */
export const lowRiskInlinePatterns = (db: Database): LowRiskInlinePatternRow[] => {
  const rows = db
    .query("SELECT * FROM low_risk_inline_patterns_view ORDER BY ts DESC")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    cited_id: r.cited_id as string,
    ts: r.ts as string,
    substrate_origin: r.substrate_origin as string,
    pattern_kind: ((r.pattern_kind as string) ?? "exact") as LowRiskInlinePatternRow["pattern_kind"],
    pattern: (r.pattern as string) ?? "",
    score: (r.score as number) ?? 0,
    confidence: (r.confidence as number) ?? 0,
  }));
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

// ── origin_promotion_by_directive_view accessor (Phase DAG follow-up) ─

export type OriginPromotionRankingRow = {
  substrate_origin: string;
  promoted_count: number;
};

/** Rank substrate_origins by how often candidates from each origin promoted
 *  to `knowledge_promoted` under a given goal_shape. The SQL view buckets per
 *  (substrate_origin, directive_id); this accessor maps every directive_id
 *  to its goal_shape via the caller-supplied hash (matches §3.6.1 Rule 4 —
 *  origin reranker bias is per-shape, not global).
 *
 *  Returns rows in promoted_count DESC order; rows with promoted_count = 0
 *  are dropped (an origin that never promoted under this shape has nothing
 *  to rank). When no candidate or promotion exists for the shape, returns
 *  an empty array — the reranker falls back to the global per-origin ratio
 *  in `origin_promotion_view`. */
export const originPromotionRanking = (
  db: Database,
  goalShape: (text: string) => string,
  targetShape?: string,
): OriginPromotionRankingRow[] => {
  // Pull directive_id → goal text → shape, then bucket the by-directive view.
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
      const p = JSON.parse(d.payload) as { goal?: unknown; intent?: unknown; directive_text?: unknown };
      goal = String((p.goal ?? p.intent ?? p.directive_text ?? "") as string);
    } catch { /* malformed payload — empty shape */ }
    directiveToShape.set(d.directive_id, goalShape(goal));
  }

  const rows = db
    .query("SELECT * FROM origin_promotion_by_directive_view")
    .all() as Array<{
      substrate_origin: string;
      directive_id: string;
      candidate_count: number;
      promoted_count: number;
    }>;

  // When the caller doesn't pin a target shape, return the per-origin
  // aggregate across every shape (a degenerate ranking — still useful for
  // operator inspection). Otherwise filter to rows whose directive shares
  // the target shape, then aggregate per origin.
  const aggregate = new Map<string, number>();
  for (const r of rows) {
    if (targetShape !== undefined) {
      const shape = directiveToShape.get(r.directive_id);
      if (shape !== targetShape) continue;
    }
    aggregate.set(
      r.substrate_origin,
      (aggregate.get(r.substrate_origin) ?? 0) + r.promoted_count,
    );
  }

  return Array.from(aggregate.entries())
    .filter(([, c]) => c > 0)
    .map(([substrate_origin, promoted_count]) => ({ substrate_origin, promoted_count }))
    .sort((a, b) => b.promoted_count - a.promoted_count);
};

// ── promoted_knowledge_view accessor (Batch 3.ADMIN) ────────────────

export type PromotedKnowledgeRow = {
  event_id: string;
  ts: string;
  substrate_origin: string;
  candidate_id: string | null;
  directive_id: string;
  score: number;
  confidence: number;
  text: string | null;
  tags: string[];
  context_refs: string[];
};

export type PromotedKnowledgeFilter = {
  /** Filter rows to a specific substrate_origin (e.g. `opencode`, `claude_root`). */
  origin?: string;
  /** Only rows with ts > since (ISO-8601 string, inclusive of equal-ts). */
  since?: string;
  /** Cap on rows returned. */
  limit?: number;
};

export type RecipeRegistryRow = {
  recipe_id: string;
  id: string;
  ts: string;
  directive_id: string;
  task_id: string;
  confidence: number;
  goal_shape: string | null;
  topology_signature: string;
  status: string;
  payload: Record<string, unknown>;
  context_refs: string[];
};

/** Promoted-knowledge rows for `acc admin inspect-knowledge`. The view
 *  itself returns every promotion; filters compose at the query site so a
 *  scoped read stays a single SQL pass.  Rows whose canonical candidate
 *  has been pruned still surface with `text=null` / `tags=[]`. */
export const promotedKnowledge = (
  db: Database,
  filter: PromotedKnowledgeFilter = {},
): PromotedKnowledgeRow[] => {
  const wheres: string[] = [];
  const params: unknown[] = [];
  if (filter.origin) { wheres.push("substrate_origin = ?"); params.push(filter.origin); }
  if (filter.since) { wheres.push("ts >= ?"); params.push(filter.since); }
  const whereSql = wheres.length === 0 ? "" : `WHERE ${wheres.join(" AND ")}`;
  const limitSql = filter.limit && filter.limit > 0 ? `LIMIT ${Math.floor(filter.limit)}` : "";
  const rows = db
    .query(
      `SELECT event_id, ts, substrate_origin, candidate_id, directive_id,
              score, confidence, text, tags, context_refs
       FROM promoted_knowledge_view
       ${whereSql}
       ORDER BY ts DESC
       ${limitSql}`,
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    event_id: r.event_id as string,
    ts: r.ts as string,
    substrate_origin: r.substrate_origin as string,
    candidate_id: (r.candidate_id as string | null) ?? null,
    directive_id: r.directive_id as string,
    score: (r.score as number) ?? 0,
    confidence: (r.confidence as number) ?? 0,
    text: (r.text as string | null) ?? null,
    tags: parseJson<string[]>(r.tags ?? "[]"),
    context_refs: parseJson<string[]>(r.context_refs ?? "[]"),
  }));
};

/** Latest recipe_extracted row per recipe key, ordered newest first. */
export const recipeRegistry = (db: Database, limit?: number): RecipeRegistryRow[] => {
  const limitSql = limit && limit > 0 ? `LIMIT ${Math.floor(limit)}` : "";
  const rows = db
    .query(
      `SELECT recipe_id, id, ts, directive_id, task_id, confidence,
              goal_shape, topology_signature, status, payload, context_refs
       FROM recipe_registry_view
       ORDER BY ts DESC
       ${limitSql}`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    recipe_id: r.recipe_id as string,
    id: r.id as string,
    ts: r.ts as string,
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    confidence: (r.confidence as number) ?? 0,
    goal_shape: (r.goal_shape as string | null) ?? null,
    topology_signature: (r.topology_signature as string | null) ?? "",
    status: (r.status as string | null) ?? "available",
    payload: parseJson<Record<string, unknown>>(r.payload ?? "{}"),
    context_refs: parseJson<string[]>(r.context_refs ?? "[]"),
  }));
};
