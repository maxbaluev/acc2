// acc2 substrate views — pure SQL view definitions per docs/v2-design.md §4.2.
// Each view is a CREATE VIEW over the events + act_artifact
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
//
// L4.1 (2026-05-17, 7+ converging brain emissions including
// 75RZN1N5D13CHABTT172KQGKF4, FX95XAGQ2S6B50Y4SX2E60H6C0,
// MKVAS1YKSX58VEE1NCMRBHXH18, FZDM3PT70N6HF70QYQ601PQS5W): the terminal
// CTE used to only suppress task_committed/task_failed/task_abandoned,
// missing task_committed_superseded (emitted by amendment_handler when
// an amendment supersedes a prior task) and task_blocked (registered
// runtime kind). Without those, the scheduler re-dispatched superseded
// or blocked work as if it were still ready. Ready rows also exposed
// only event_id/ts/directive_id/task_id/payload — no parent_task_id,
// no incoming-edge metadata — so Claude-side claim logic could not
// reason about which lane (claude_inline, brain, replay) fit a given
// leaf without a separate query. Both gaps now closed in one SQL change.
const VIEW_READY_TASKS = `
CREATE VIEW IF NOT EXISTS ready_tasks_view AS
  WITH nodes AS (
    SELECT id AS event_id, ts, directive_id, task_id, parent_task_id, payload
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
  -- L4.1 fix (2026-05-17): the terminal vocabulary now includes
  -- task_committed_superseded (amendment_handler.ts:85 emits this when a
  -- contract amendment replaces a prior task; pre-fix the superseded
  -- task could re-appear in ready_tasks_view and be re-dispatched as if
  -- still live) and task_blocked (registered in event_kinds.ts:74; once
  -- emitted, the task should be suppressed from readiness regardless of
  -- its requires-edge state). runtime/task_topology.ts computeStatus()
  -- mirrors this same vocabulary so SQL view and runtime helper agree.
  terminal AS (
    SELECT task_id FROM events
    WHERE kind IN (
      'task_committed', 'task_failed', 'task_abandoned',
      'task_committed_superseded', 'task_blocked'
    )
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
  SELECT
    n.event_id, n.ts, n.directive_id, n.task_id, n.parent_task_id, n.payload,
    -- L4.1 fix: surface incoming-edge provenance so scheduler + claim
    -- logic can decide which dispatch lane / strategy fits the leaf
    -- without re-querying. Empty JSON arrays when no incoming edges of
    -- that kind exist on this task.
    (
      SELECT COALESCE(json_group_array(from_task), '[]')
      FROM edges
      WHERE to_task = n.task_id AND edge_kind = 'requires'
    ) AS incoming_requires_from,
    (
      SELECT COALESCE(json_group_array(from_task), '[]')
      FROM edges
      WHERE to_task = n.task_id AND edge_kind = 'refines'
    ) AS incoming_refines_from
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

// act_artifact_registry_view — admitted or promoted artifacts ordered by
// score DESC. This is what retrieval and the prompt composer read.
// Brain dataflow audit bxdhdkm9e #3 (2026-05-15): the registry view now
// exposes the provenance/intent columns the brain emits on
// act_artifact_candidate (intent, summary, target_files /
// target_resources, source candidate id, owner_gate_verdict). Pre-fix the admission path persisted these
// fields on the events ledger but the view dropped them — the operator
// could not tell WHY an artifact existed or WHICH owner gate (if any)
// approved it.
const VIEW_ACT_ARTIFACT_REGISTRY = `
DROP VIEW IF EXISTS code_artifact_registry_view;
DROP VIEW IF EXISTS act_artifact_registry_view;
CREATE VIEW IF NOT EXISTS act_artifact_registry_view AS
  SELECT
    id, runtime, body, declared_sandbox, state_root, kind,
    posterior_alpha, posterior_beta, score, confidence,
    recent_residual_mean, recent_kill_count, status, name,
    fixture_input, fixture_expected_residual,
    intent, summary, target_files, target_resources, source_candidate_id, owner_gate_verdict,
    created_at, updated_at
  FROM act_artifact
  WHERE status IN ('admitted', 'promoted')
  ORDER BY score DESC, confidence DESC;
`;

// artifact_routing_view — same registry, ranked by score*(1-residual_mean).
// (cosine × posterior reranker is Phase F; this is a placeholder ordering.)
// Path A (2026-05-20, contract A0DQT211JH): routing implies executable
// invocation; data-class rows (runtime IS NULL) cannot be invoked and
// must be excluded from the routing view.
const VIEW_ARTIFACT_ROUTING = `
CREATE VIEW IF NOT EXISTS artifact_routing_view AS
  SELECT
    id, runtime, body, declared_sandbox, score, confidence,
    recent_residual_mean, status, name,
    (score * (1.0 - recent_residual_mean)) AS routing_score
  FROM act_artifact
  WHERE status IN ('admitted', 'promoted')
    AND runtime IS NOT NULL
  ORDER BY routing_score DESC;
`;

// embedding_index_view — events plus active data-class artifacts with embedding BLOBs.
// The daemon rebuilds its vector metadata from this view at boot.
const VIEW_EMBEDDING_INDEX = `
CREATE VIEW IF NOT EXISTS embedding_index_view AS
  SELECT
    id, kind, ts, directive_id, task_id, embedding, embedding_version, substrate_origin, payload,
    COALESCE(json_extract(payload, '$.retrieval_aspects'), json_extract(payload, '$.aspect_vectors')) AS retrieval_aspects,
    COALESCE(
      json_extract(payload, '$.retrieval_domains'),
      json_extract(payload, '$.domain_vector'),
      json_extract(payload, '$.domain_weights')
    ) AS retrieval_domains
  FROM events
  WHERE embedding IS NOT NULL
  UNION ALL
  SELECT
    id, 'act_artifact' AS kind, COALESCE(updated_at, created_at) AS ts, '' AS directive_id, '' AS task_id, embedding, 'v1' AS embedding_version, 'act_artifact' AS substrate_origin,
    json_object('artifact_id', id, 'artifact_kind', kind, 'body', body, 'summary', COALESCE(summary, ''), 'intent', COALESCE(intent, ''), 'name', COALESCE(name, '')) AS payload,
    json_object('body', body, 'summary', COALESCE(summary, ''), 'intent', COALESCE(intent, ''), 'name', COALESCE(name, ''), 'artifact_kind', kind) AS retrieval_aspects,
    NULL AS retrieval_domains
  FROM act_artifact
  WHERE runtime IS NULL AND superseded_by IS NULL AND status IN ('admitted', 'promoted') AND embedding IS NOT NULL AND length(embedding) > 0;
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
// Includes owner_profile_recorded + owner_insight_candidate so a single
// view surfaces every owner-touching event the prompt composer + UI care
// about (UX dispatch b71pfyddv knowledge_candidate 540ZQYN3, 2026-05-15).
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
  WHERE kind IN (
    'owner_input_received',
    'owner_decision_recorded',
    'owner_profile_recorded',
    'owner_insight_candidate'
  )
  ORDER BY ts ASC;
`;

// owner_profile_view — the latest substrate-promoted owner profile row.
// Stable preferences (language, tone, working hours, boundaries)
// accumulate slowly as the substrate (Model D) merges owner_insight_candidate
// observations from BOTH Claude and the brain. The prompt composer reads
// this view to surface persistent owner context that outlives the rolling
// 8-row OWNER CONTEXT window.
const VIEW_OWNER_PROFILE = `
CREATE VIEW IF NOT EXISTS owner_profile_view AS
  SELECT id AS event_id, ts, payload, substrate_origin
  FROM events
  WHERE kind = 'owner_profile_recorded'
  ORDER BY ts DESC
  LIMIT 1;
`;

// owner_rendering_policy_view — the runtime input every owner-facing
// renderer reads BEFORE emitting a primary surface string (brain contract
// Q471RAN88X0H513V8BC3BTW0AW, 2026-05-17). One row, latest profile +
// recent feedback summary. Producers ask "what language / abstraction /
// initiative / review behavior do I owe the owner right now?" — the view
// answers without each producer having to assemble owner_profile_view +
// recent owner_rendering_feedback_recorded rows on its own. Open-ended
// fields (preferred_terms, avoided_terms, declined_concepts,
// understood_concepts, manual_review_patterns, things_to_never_do) flow
// through from the profile payload verbatim; the view adds aggregated
// feedback signal (recent_correction_count, recent_decline_count,
// recent_satisfaction_count) over the last 14 days.
const VIEW_OWNER_RENDERING_POLICY = `
CREATE VIEW IF NOT EXISTS owner_rendering_policy_view AS
  WITH profile AS (
    SELECT id AS profile_event_id, ts AS profile_ts, payload AS profile_payload
    FROM events
    WHERE kind = 'owner_profile_recorded'
    ORDER BY ts DESC
    LIMIT 1
  ),
  feedback_window AS (
    SELECT
      json_extract(payload, '$.feedback_kind') AS feedback_kind,
      COUNT(*) AS n
    FROM events
    WHERE kind = 'owner_rendering_feedback_recorded'
      AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
    GROUP BY feedback_kind
  )
  SELECT
    (SELECT profile_event_id FROM profile) AS profile_event_id,
    (SELECT profile_ts FROM profile) AS profile_ts,
    (SELECT profile_payload FROM profile) AS profile_payload,
    -- Preferred / avoided language pulled out for fast access; full
    -- payload preserved for renderers that need arbitrary keys.
    (SELECT json_extract(profile_payload, '$.preferred_terms') FROM profile) AS preferred_terms,
    (SELECT json_extract(profile_payload, '$.avoided_terms') FROM profile) AS avoided_terms,
    (SELECT json_extract(profile_payload, '$.declined_concepts') FROM profile) AS declined_concepts,
    (SELECT json_extract(profile_payload, '$.understood_concepts') FROM profile) AS understood_concepts,
    (SELECT json_extract(profile_payload, '$.exposed_concepts') FROM profile) AS exposed_concepts,
    (SELECT json_extract(profile_payload, '$.things_to_never_do') FROM profile) AS things_to_never_do,
    (SELECT json_extract(profile_payload, '$.manual_review_patterns') FROM profile) AS manual_review_patterns,
    (SELECT json_extract(profile_payload, '$.autonomy_score') FROM profile) AS autonomy_score,
    (SELECT json_extract(profile_payload, '$.autonomy_scope') FROM profile) AS autonomy_scope,
    (SELECT json_extract(profile_payload, '$.detected_language') FROM profile) AS detected_language,
    -- Feedback window aggregates: correction-class counts as a quick read
    -- for "is the current policy working?" — full breakdown comes from
    -- owner_rendering_effectiveness_view.
    (SELECT COALESCE(SUM(n), 0) FROM feedback_window WHERE feedback_kind IN ('correction','correction_explicit','correction_implicit')) AS recent_correction_count,
    (SELECT COALESCE(SUM(n), 0) FROM feedback_window WHERE feedback_kind IN ('decline','declined','rejected')) AS recent_decline_count,
    (SELECT COALESCE(SUM(n), 0) FROM feedback_window WHERE feedback_kind IN ('ignored_ask','ignored','silent')) AS recent_ignored_count,
    (SELECT COALESCE(SUM(n), 0) FROM feedback_window WHERE feedback_kind IN ('confirmation','approved','satisfaction','positive')) AS recent_satisfaction_count,
    (SELECT COALESCE(SUM(n), 0) FROM feedback_window WHERE feedback_kind IN ('repeated_clarification','clarification_loop')) AS recent_clarification_count,
    (SELECT COALESCE(SUM(n), 0) FROM feedback_window WHERE feedback_kind IN ('manual_override','operator_override','override')) AS recent_override_count,
    -- Aggregate "did something go wrong recently?" signal — any non-zero
    -- correction/decline/ignored/override count surfaces as policy_health
    -- below 1.0 so consumers can route to a more careful render mode
    -- without computing it themselves.
    MAX(0.0, MIN(1.0,
      1.0 - 0.15 * (
        (SELECT COALESCE(SUM(n), 0) FROM feedback_window WHERE feedback_kind IN ('correction','correction_explicit','correction_implicit'))
        + (SELECT COALESCE(SUM(n), 0) FROM feedback_window WHERE feedback_kind IN ('decline','declined','rejected'))
        + (SELECT COALESCE(SUM(n), 0) FROM feedback_window WHERE feedback_kind IN ('ignored_ask','ignored','silent'))
        + (SELECT COALESCE(SUM(n), 0) FROM feedback_window WHERE feedback_kind IN ('manual_override','operator_override','override'))
      )
    )) AS policy_health;
`;

// owner_rendering_effectiveness_view — per-policy-snapshot aggregation.
// Joins rendered_owner_message_recorded × owner_rendering_feedback_recorded
// (the feedback row's source_rendered_event_id points back at the render)
// and groups by owner_profile_hash so the substrate can ask "which profile
// snapshots produced corrections vs satisfactions?" This is the scoring
// surface the brain reads when proposing policy refinements.
const VIEW_OWNER_RENDERING_EFFECTIVENESS = `
CREATE VIEW IF NOT EXISTS owner_rendering_effectiveness_view AS
  WITH renders AS (
    SELECT
      id AS rendered_event_id,
      ts AS rendered_ts,
      directive_id,
      task_id,
      json_extract(payload, '$.owner_profile_hash') AS owner_profile_hash,
      json_extract(payload, '$.audience') AS audience,
      json_extract(payload, '$.surface') AS surface,
      json_extract(payload, '$.renderer') AS renderer,
      json_extract(payload, '$.intended_owner_action') AS intended_owner_action,
      json_extract(payload, '$.est_attention_cost') AS est_attention_cost,
      payload AS rendered_payload
    FROM events
    WHERE kind = 'rendered_owner_message_recorded'
  ),
  feedbacks AS (
    SELECT
      json_extract(payload, '$.source_rendered_event_id') AS rendered_event_id,
      json_extract(payload, '$.feedback_kind') AS feedback_kind,
      residual AS feedback_residual,
      payload AS feedback_payload,
      ts AS feedback_ts
    FROM events
    WHERE kind = 'owner_rendering_feedback_recorded'
  )
  SELECT
    r.rendered_event_id,
    r.rendered_ts,
    r.directive_id,
    r.task_id,
    r.owner_profile_hash,
    r.audience,
    r.surface,
    r.renderer,
    r.intended_owner_action,
    r.est_attention_cost,
    f.feedback_kind,
    f.feedback_residual,
    f.feedback_ts,
    -- A render with no feedback row yet shows feedback_kind=NULL; that's
    -- itself a learnable signal (silent_ignore distinct from explicit
    -- ignored_ask) once a freshness window passes. Consumers project
    -- silent_ignore by filtering r.rendered_ts < now - cutoff and
    -- f.feedback_kind IS NULL.
    CASE
      WHEN f.feedback_kind IN ('correction','correction_explicit','correction_implicit','decline','declined','rejected','auto_verifier') THEN 'negative'
      WHEN f.feedback_kind IN ('confirmation','approved','satisfaction','positive','auto_verifier_clean') THEN 'positive'
      WHEN f.feedback_kind IN ('manual_override','operator_override','override','ignored_ask','ignored','silent','repeated_clarification','clarification_loop','auto_verifier_skipped') THEN 'mixed'
      WHEN f.feedback_kind IS NULL THEN 'pending'
      ELSE 'other'
    END AS effectiveness_band
  FROM renders r
  LEFT JOIN feedbacks f ON f.rendered_event_id = r.rendered_event_id
  ORDER BY r.rendered_ts DESC;
`;

// owner_state_belief_view — the substrate's current best guess about
// the owner's latent state. Brain contract CY7E62DSNX1DZ1BTD56845D994
// (2026-05-18): acc2 was retrieval-augmented Bayesian event memory but
// had NO dynamic owner-state estimator. This view aggregates the latest
// owner_state_hypothesis_recorded row (current belief) with the
// 14-day rolling prediction-error per axis (how wrong recent
// hypotheses have been).
//
// Shape: one row (latest belief). Fields:
//   - hypothesis_event_id, hypothesis_ts            (provenance)
//   - latent_state_payload                          (the full latent_state JSON
//                                                    from the hypothesis — open-ended)
//   - confidence                                    (Record<string,number> JSON)
//   - decay_after_iso, uncertainty
//   - observation_refs                              (the event ids that grounded the belief)
//   - recent_prediction_error_count                 (14-day window)
//   - recent_avg_prediction_error                   (mean of payload prediction_error
//                                                    aggregate score; falls back to
//                                                    the row's residual column)
//   - belief_age_ms                                 (now - hypothesis_ts)
//   - is_stale                                      (1 if decay_after_iso < now)
//
// Consumers: prompt_composer (OWNER STATE BELIEF section in next layer),
// TUI plain-status drilldown, the brain when proposing alignment actions.
const VIEW_OWNER_STATE_BELIEF = `
CREATE VIEW IF NOT EXISTS owner_state_belief_view AS
  WITH latest_hyp AS (
    SELECT
      id           AS hypothesis_event_id,
      ts           AS hypothesis_ts,
      payload      AS hypothesis_payload,
      substrate_origin AS hypothesis_origin
    FROM events
    WHERE kind = 'owner_state_hypothesis_recorded'
    ORDER BY ts DESC
    LIMIT 1
  ),
  recent_evidence AS (
    SELECT
      id,
      ts,
      kind,
      CASE
        WHEN kind = 'owner_input_received' THEN 'owner_input'
        WHEN kind = 'owner_decision_recorded' THEN 'decision'
        WHEN kind = 'owner_observed_outcome_recorded' THEN 'observed_outcome'
        WHEN kind = 'owner_rendering_feedback_recorded'
          AND json_extract(payload, '$.feedback_kind') IN ('correction','correction_explicit','correction_implicit') THEN 'correction'
        WHEN kind = 'owner_rendering_feedback_recorded'
          AND json_extract(payload, '$.feedback_kind') IN ('decline','declined','rejected','refusal','manual_override') THEN 'refusal'
        WHEN kind = 'owner_rendering_feedback_recorded' THEN 'rendering_feedback'
        WHEN kind IN ('task_deferred_for_interference','task_blocked') THEN 'task_delay'
        WHEN kind IN ('owner_input_required','hidl_action_required') THEN 'clarification_or_gate'
        WHEN kind IN ('task_failed','dispatcher_violation')
          AND (failure_kind LIKE '%refus%' OR json_extract(payload, '$.reason') LIKE '%refus%') THEN 'refusal'
        ELSE 'other'
      END AS evidence_class
    FROM events
    WHERE kind IN (
      'owner_input_received','owner_decision_recorded','owner_observed_outcome_recorded',
      'owner_rendering_feedback_recorded','task_deferred_for_interference','task_blocked',
      'owner_input_required','hidl_action_required','task_failed','dispatcher_violation'
    )
      AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
  ),
  evidence_agg AS (
    SELECT
      COUNT(*) AS evidence_count,
      MAX(ts) AS latest_evidence_ts,
      COALESCE((SELECT json_group_array(id) FROM (SELECT id FROM recent_evidence ORDER BY ts DESC LIMIT 24)), '[]') AS evidence_refs,
      json_object(
        'owner_input', COALESCE(SUM(CASE WHEN evidence_class = 'owner_input' THEN 1 ELSE 0 END), 0),
        'decision', COALESCE(SUM(CASE WHEN evidence_class = 'decision' THEN 1 ELSE 0 END), 0),
        'observed_outcome', COALESCE(SUM(CASE WHEN evidence_class = 'observed_outcome' THEN 1 ELSE 0 END), 0),
        'rendering_feedback', COALESCE(SUM(CASE WHEN evidence_class = 'rendering_feedback' THEN 1 ELSE 0 END), 0),
        'correction', COALESCE(SUM(CASE WHEN evidence_class = 'correction' THEN 1 ELSE 0 END), 0),
        'task_delay', COALESCE(SUM(CASE WHEN evidence_class = 'task_delay' THEN 1 ELSE 0 END), 0),
        'refusal', COALESCE(SUM(CASE WHEN evidence_class = 'refusal' THEN 1 ELSE 0 END), 0),
        'clarification_or_gate', COALESCE(SUM(CASE WHEN evidence_class = 'clarification_or_gate' THEN 1 ELSE 0 END), 0)
      ) AS evidence_counts
    FROM recent_evidence
  ),
  recent_err AS (
    SELECT
      COUNT(*) AS recent_prediction_error_count,
      AVG(COALESCE(
        residual,
        json_extract(payload, '$.prediction_error.aggregate'),
        json_extract(payload, '$.prediction_error_aggregate')
      )) AS recent_avg_prediction_error
    FROM events
    WHERE kind = 'owner_state_prediction_error_recorded'
      AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
  ),
  base AS (
    SELECT
      h.*,
      a.evidence_count,
      a.latest_evidence_ts,
      a.evidence_refs,
      a.evidence_counts,
      COALESCE(h.hypothesis_ts, a.latest_evidence_ts) AS belief_ts,
      CASE WHEN h.hypothesis_event_id IS NULL THEN 'evidence_synthesized' ELSE 'explicit_hypothesis' END AS belief_source
    FROM evidence_agg a
    LEFT JOIN latest_hyp h ON 1 = 1
  )
  SELECT
    b.hypothesis_event_id,
    b.hypothesis_ts,
    b.hypothesis_origin,
    b.belief_source,
    CASE
      WHEN b.hypothesis_payload IS NOT NULL THEN json_extract(b.hypothesis_payload, '$.latent_state')
      WHEN b.evidence_count > 0 THEN json_object('evidence_summary', 'recent owner evidence present; explicit latent-state hypothesis not recorded yet')
      ELSE NULL
    END AS latent_state_payload,
    CASE
      WHEN b.hypothesis_payload IS NOT NULL THEN json_extract(b.hypothesis_payload, '$.confidence')
      WHEN b.evidence_count > 0 THEN json_object('evidence_summary', MIN(0.6, 0.2 + (b.evidence_count * 0.05)))
      ELSE NULL
    END AS confidence,
    COALESCE(json_extract(b.hypothesis_payload, '$.observation_refs'), b.evidence_refs, '[]') AS observation_refs,
    b.evidence_refs,
    b.evidence_counts,
    b.evidence_count,
    json_extract(b.hypothesis_payload, '$.decay_after_iso') AS decay_after_iso,
    CAST(COALESCE(json_extract(b.hypothesis_payload, '$.uncertainty'), CASE WHEN b.evidence_count > 0 THEN 0.75 ELSE 0.5 END) AS REAL) AS uncertainty,
    e.recent_prediction_error_count,
    e.recent_avg_prediction_error,
    CAST((julianday('now') - julianday(b.belief_ts)) * 86400.0 * 1000.0 AS INTEGER) AS belief_age_ms,
    MAX(0.0, MIN(1.0, 1.0 - ((julianday('now') - julianday(b.belief_ts)) / 14.0))) AS temporal_decay_factor,
    MIN(1.0, CAST(COALESCE(json_extract(b.hypothesis_payload, '$.uncertainty'), CASE WHEN b.evidence_count > 0 THEN 0.75 ELSE 0.5 END) AS REAL) + ((1.0 - MAX(0.0, MIN(1.0, 1.0 - ((julianday('now') - julianday(b.belief_ts)) / 14.0)))) * 0.5)) AS decayed_uncertainty,
    CASE
      WHEN json_extract(b.hypothesis_payload, '$.decay_after_iso') IS NOT NULL
        AND datetime(json_extract(b.hypothesis_payload, '$.decay_after_iso')) < datetime('now')
      THEN 1
      WHEN b.belief_ts IS NOT NULL AND datetime(b.belief_ts) < datetime('now', '-14 days')
      THEN 1
      ELSE 0
    END AS is_stale
  FROM base b
  LEFT JOIN recent_err e
  WHERE b.hypothesis_event_id IS NOT NULL OR b.evidence_count > 0;
`;

// owner_alignment_action_policy_view — recent alignment_action_selected
// rows × paired owner_state_prediction_error_recorded × the action's
// origin belief snapshot. Brain contract CY7E62DSNX1DZ1BTD56845D994
// Phase H5 (2026-05-18). The brain reads this to answer "given current
// belief, which actions tend to work?" without re-querying three views.
//
// Shape: newest-first rows of recent alignment actions. Fields:
//   - action_event_id, action_ts, directive_id, task_id
//   - action_kind, rationale, hypothesis_event_id, cited_artifact_ids
//   - belief_emotional_register, belief_attention_budget,
//     belief_decision_style  (3 most-decision-relevant axes inline)
//   - prediction_error_event_id, prediction_error_aggregate
//   - effectiveness_band  ('positive' | 'negative' | 'mixed' | 'pending')
const VIEW_OWNER_ALIGNMENT_ACTION_POLICY = `
CREATE VIEW IF NOT EXISTS owner_alignment_action_policy_view AS
  WITH actions AS (
    SELECT
      a.id AS action_event_id,
      a.ts AS action_ts,
      a.directive_id,
      a.task_id,
      json_extract(a.payload, '$.action_kind')        AS action_kind,
      json_extract(a.payload, '$.rationale')          AS rationale,
      json_extract(a.payload, '$.hypothesis_event_id') AS hypothesis_event_id,
      json_extract(a.payload, '$.cited_artifact_ids') AS cited_artifact_ids
    FROM events a
    WHERE a.kind = 'alignment_action_selected'
  ),
  paired_errors AS (
    SELECT
      json_extract(p.payload, '$.hypothesis_event_id') AS hypothesis_event_id,
      json_extract(p.payload, '$.interaction_event_id') AS action_event_id,
      p.id AS prediction_error_event_id,
      p.ts AS prediction_error_ts,
      COALESCE(
        p.residual,
        json_extract(p.payload, '$.prediction_error.aggregate'),
        json_extract(p.payload, '$.prediction_error_aggregate')
      ) AS prediction_error_aggregate,
      ROW_NUMBER() OVER (
        PARTITION BY json_extract(p.payload, '$.interaction_event_id')
        ORDER BY p.ts DESC
      ) AS rn
    FROM events p
    WHERE p.kind = 'owner_state_prediction_error_recorded'
  ),
  latest_err AS (
    SELECT * FROM paired_errors WHERE rn = 1
  )
  SELECT
    a.action_event_id,
    a.action_ts,
    a.directive_id,
    a.task_id,
    a.action_kind,
    a.rationale,
    a.hypothesis_event_id,
    a.cited_artifact_ids,
    json_extract(h.payload, '$.latent_state.emotional_register') AS belief_emotional_register,
    json_extract(h.payload, '$.latent_state.attention_budget')   AS belief_attention_budget,
    json_extract(h.payload, '$.latent_state.decision_style')     AS belief_decision_style,
    json_extract(h.payload, '$.uncertainty')                     AS belief_uncertainty,
    err.prediction_error_event_id,
    err.prediction_error_aggregate,
    CASE
      WHEN err.prediction_error_aggregate IS NULL THEN 'pending'
      WHEN err.prediction_error_aggregate < 0.15 THEN 'positive'
      WHEN err.prediction_error_aggregate < 0.30 THEN 'mixed'
      ELSE 'negative'
    END AS effectiveness_band
  FROM actions a
  LEFT JOIN events h ON h.id = a.hypothesis_event_id AND h.kind = 'owner_state_hypothesis_recorded'
  LEFT JOIN latest_err err ON err.action_event_id = a.action_event_id
  ORDER BY a.action_ts DESC;
`;

// owner_plain_status_view — projects directive/task state into PLAIN
// language cards for non-technical owners. The TUI primary surface reads
// from this view directly so it never has to assemble {ids, residuals,
// view names} into English itself.
//
// One row per ACTIVE directive (lifecycle != closed/archived). Fields:
//   - directive_id              (hidden in primary; carried for drilldown)
//   - opened_text               ("what the owner asked")
//   - latest_state              ("what's happening now" plain words)
//   - latest_state_kind         (one of: in_progress, awaiting_owner,
//                                completed, failed, paused, idle)
//   - next_owner_action         ("what the owner could do next", null when
//                                nothing is pending from the owner)
//   - risk_note                 (plain explanation when an irreversible
//                                effect or owner_input_required is in play)
//   - residual_optional         (numeric; consumers MAY surface it as a
//                                detail-drawer field; primary surfaces hide)
//   - detail_refs               (event ids the operator can open if asked)
//   - last_event_ts             (for sorting)
// top_laws_view — auto-compiled list of the substrate's highest-scoring
// promoted knowledge. Brain contract from dispatch 3NWCD7PW315W
// (CLAUDE.md auto-compiled Top Laws piece): the legacy system/CLAUDE.md
// has 'Top Laws (auto-compiled from scored knowledge)' as a section
// header but acc2's CLAUDE.md never had the mechanism. This view IS
// that mechanism — it surfaces the top promoted-knowledge rows by
// posterior score, so the orchestrator and brain can read the
// organism's current ranked principles at session start without
// hard-coding them into text-on-disk.
//
// Shape (newest-first within score bucket; tie-break by ts):
//   - event_id, ts, substrate_origin, candidate_id, directive_id
//   - score, confidence              (the Beta posterior at promotion)
//   - text                           (the claim itself; never NULL —
//                                     '(no text)' fallback applied)
//   - tags                           (open-ended classifier tags)
//   - law_rank                       (1-indexed by score DESC)
//
// View returns ALL promoted_knowledge rows ranked by Beta posterior;
// the canonical Top Laws threshold (score >= 0.75) is applied at the
// accessor (substrate/views.ts topLaws) so callers can both narrow
// (higher floor) AND widen (lower floor for debugging) without
// re-issuing different SQL.
const VIEW_TOP_LAWS = `
CREATE VIEW IF NOT EXISTS top_laws_view AS
  SELECT
    event_id,
    ts,
    substrate_origin,
    candidate_id,
    directive_id,
    score,
    confidence,
    COALESCE(text, '(no text)') AS text,
    tags,
    context_refs,
    ROW_NUMBER() OVER (ORDER BY score DESC, confidence DESC, ts DESC) AS law_rank
  FROM promoted_knowledge_view
  WHERE score IS NOT NULL
  ORDER BY score DESC, confidence DESC, ts DESC;
`;

// retrieval_credit_view — for each retrieval_binding emitted in the
// last 14 days, surface how many action_scored rows cited it and the
// average residual of those scores. Brain task FX9PZDQ3W932
// (RLM_RETRIEVAL_ACTS_MIN_LEAP, 2026-05-18). This is the contraction-
// first observability layer for retrieval credit; learned retrieval +
// rejection policy can build on top of it once the data exists.
//
// Shape (one row per retrieval_binding):
//   - retrieval_binding_event_id
//   - retrieval_ts, source_event_id, knowledge_source_kind
//   - query, binding_surface, rank
//   - times_cited                   — count of action_scored rows that
//                                     reference this binding via context_refs
//   - avg_cited_residual            — mean residual across those scores
//                                     (NULL if 0 cites)
//   - times_rejected                — count of retrieval_rejected rows
//   - effectiveness_band            — open-ended classification:
//       'unused'    (0 cites, no rejection)
//       'rejected'  (0 cites + 1+ rejections — LM read but declined)
//       'positive'  (1+ cites, avg residual < 0.2)
//       'mixed'     (1+ cites, avg residual 0.2..0.4)
//       'negative'  (1+ cites, avg residual >= 0.4)
//   - credit_attributed_count       — count of retrieval_credit_attributed
//                                     rows for this binding (substrate's
//                                     own attributions for closure)
const VIEW_RETRIEVAL_CREDIT = `
CREATE VIEW IF NOT EXISTS retrieval_credit_view AS
  WITH bindings AS (
    SELECT
      id AS retrieval_binding_event_id,
      ts AS retrieval_ts,
      directive_id,
      task_id,
      json_extract(payload, '$.query')              AS query,
      json_extract(payload, '$.source_event_id')    AS source_event_id,
      json_extract(payload, '$.binding_surface')    AS binding_surface,
      json_extract(payload, '$.rank')               AS rank,
      json_extract(payload, '$.rerank_score')       AS rerank_score
    FROM events
    WHERE kind = 'retrieval_binding'
      AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
  ),
  scored_cites AS (
    SELECT
      b.retrieval_binding_event_id AS retrieval_binding_event_id,
      s.id AS action_scored_event_id,
      s.residual,
      s.ts AS scored_ts
    FROM bindings b
    JOIN events s
      ON s.kind = 'action_scored'
     AND s.context_refs IS NOT NULL
     AND json_valid(s.context_refs) = 1
     AND EXISTS (
       SELECT 1 FROM json_each(s.context_refs)
       WHERE value = b.retrieval_binding_event_id
     )
  ),
  cite_agg AS (
    SELECT
      retrieval_binding_event_id,
      COUNT(*) AS times_cited,
      AVG(residual) AS avg_cited_residual
    FROM scored_cites
    GROUP BY retrieval_binding_event_id
  ),
  reject_agg AS (
    SELECT
      json_extract(payload, '$.retrieval_binding_event_id') AS retrieval_binding_event_id,
      COUNT(*) AS times_rejected
    FROM events
    WHERE kind = 'retrieval_rejected'
    GROUP BY json_extract(payload, '$.retrieval_binding_event_id')
  ),
  credit_agg AS (
    SELECT
      json_extract(payload, '$.retrieval_binding_event_id') AS retrieval_binding_event_id,
      COUNT(*) AS credit_attributed_count
    FROM events
    WHERE kind = 'retrieval_credit_attributed'
    GROUP BY json_extract(payload, '$.retrieval_binding_event_id')
  ),
  source_kind AS (
    SELECT
      b.retrieval_binding_event_id,
      src.kind AS knowledge_source_kind
    FROM bindings b
    LEFT JOIN events src ON src.id = b.source_event_id
  )
  SELECT
    b.retrieval_binding_event_id,
    b.retrieval_ts,
    b.directive_id,
    b.task_id,
    b.source_event_id,
    sk.knowledge_source_kind,
    b.query,
    b.binding_surface,
    b.rank,
    b.rerank_score,
    COALESCE(c.times_cited, 0)             AS times_cited,
    c.avg_cited_residual,
    COALESCE(r.times_rejected, 0)          AS times_rejected,
    COALESCE(cr.credit_attributed_count, 0) AS credit_attributed_count,
    CASE
      WHEN COALESCE(c.times_cited, 0) = 0 AND COALESCE(r.times_rejected, 0) = 0 THEN 'unused'
      WHEN COALESCE(c.times_cited, 0) = 0 AND COALESCE(r.times_rejected, 0) > 0 THEN 'rejected'
      WHEN c.avg_cited_residual < 0.2 THEN 'positive'
      WHEN c.avg_cited_residual < 0.4 THEN 'mixed'
      ELSE 'negative'
    END AS effectiveness_band
  FROM bindings b
  LEFT JOIN cite_agg c    ON c.retrieval_binding_event_id    = b.retrieval_binding_event_id
  LEFT JOIN reject_agg r  ON r.retrieval_binding_event_id    = b.retrieval_binding_event_id
  LEFT JOIN credit_agg cr ON cr.retrieval_binding_event_id   = b.retrieval_binding_event_id
  LEFT JOIN source_kind sk ON sk.retrieval_binding_event_id  = b.retrieval_binding_event_id
  ORDER BY b.retrieval_ts DESC;
`;

const VIEW_OWNER_PLAIN_STATUS = `
CREATE VIEW IF NOT EXISTS owner_plain_status_view AS
  WITH directives AS (
    SELECT
      directive_id,
      MAX(ts) AS latest_ts
    FROM events
    WHERE directive_id IS NOT NULL
      AND kind IN ('directive_opened','directive_amended','owner_input_received','task_node_opened','task_committed','task_failed','dispatcher_violation','owner_input_required','hidl_action_required','task_closure_audited','directive_closed','directive_archived_by_operator','directive_archived_missed_reviews')
    GROUP BY directive_id
  ),
  opened AS (
    SELECT
      e.directive_id,
      json_extract(e.payload, '$.directive_text') AS opened_text,
      e.ts AS opened_ts
    FROM events e
    WHERE e.kind = 'directive_opened'
  ),
  closed AS (
    SELECT directive_id, MIN(ts) AS closed_ts
    FROM events
    WHERE kind IN ('directive_closed','directive_archived_by_operator','directive_archived_missed_reviews')
    GROUP BY directive_id
  ),
  awaiting AS (
    SELECT
      e.directive_id,
      e.id AS req_event_id,
      json_extract(e.payload, '$.summary') AS summary,
      json_extract(e.payload, '$.suggested_action') AS suggested_action,
      json_extract(e.payload, '$.reason') AS reason,
      e.kind AS req_kind,
      e.ts AS req_ts,
      ROW_NUMBER() OVER (PARTITION BY e.directive_id ORDER BY e.ts DESC) AS rn
    FROM events e
    WHERE e.kind IN ('owner_input_required','hidl_action_required')
  ),
  awaiting_latest AS (
    SELECT directive_id, req_event_id, summary, suggested_action, reason, req_kind, req_ts
    FROM awaiting WHERE rn = 1
  ),
  last_terminal AS (
    SELECT
      e.directive_id,
      e.id AS terminal_event_id,
      e.kind AS terminal_kind,
      e.ts AS terminal_ts,
      e.residual AS terminal_residual,
      json_extract(e.payload, '$.summary') AS terminal_summary,
      json_extract(e.payload, '$.failure_kind') AS terminal_failure_kind,
      ROW_NUMBER() OVER (PARTITION BY e.directive_id ORDER BY e.ts DESC) AS rn
    FROM events e
    WHERE e.kind IN ('task_committed','task_failed','task_closure_audited')
  ),
  last_terminal_latest AS (
    SELECT * FROM last_terminal WHERE rn = 1
  ),
  open_tasks AS (
    SELECT
      e.directive_id,
      COUNT(*) AS n
    FROM events e
    WHERE e.kind = 'task_node_opened'
      AND NOT EXISTS (
        SELECT 1 FROM events x
        WHERE x.task_id = e.task_id
          AND x.kind IN ('task_committed','task_failed')
      )
    GROUP BY e.directive_id
  ),
  irreversible AS (
    SELECT
      e.directive_id,
      json_extract(e.payload, '$.description') AS description,
      ROW_NUMBER() OVER (PARTITION BY e.directive_id ORDER BY e.ts DESC) AS rn
    FROM events e
    WHERE e.kind = 'irreversible_effect_recorded'
  ),
  irreversible_latest AS (
    SELECT directive_id, description FROM irreversible WHERE rn = 1
  )
  SELECT
    d.directive_id,
    o.opened_text,
    o.opened_ts,
    -- latest_state: a single plain-words string. Precedence:
    --   (1) closed -> "Completed and closed."
    --   (2) awaiting_owner -> the request summary
    --   (3) last failed -> "Something went wrong while working on this."
    --   (4) last committed + no open tasks -> "Completed for this cycle."
    --   (5) open tasks -> "Working on it now."
    --   (6) fallback -> "Idle — waiting for the next signal."
    CASE
      WHEN c.directive_id IS NOT NULL THEN 'Completed and closed.'
      WHEN aw.req_event_id IS NOT NULL THEN
        COALESCE(aw.summary, aw.reason, 'Waiting for your input.')
      WHEN ltl.terminal_kind = 'task_failed' THEN
        COALESCE('Something did not work — ' || ltl.terminal_failure_kind, 'Something did not work.')
      WHEN ltl.terminal_kind IN ('task_committed','task_closure_audited') AND COALESCE(ot.n, 0) = 0 THEN
        COALESCE(ltl.terminal_summary, 'Completed for this cycle.')
      WHEN COALESCE(ot.n, 0) > 0 THEN 'Working on it now.'
      ELSE 'Idle — waiting for the next signal.'
    END AS latest_state,
    CASE
      WHEN c.directive_id IS NOT NULL THEN 'completed'
      WHEN aw.req_event_id IS NOT NULL THEN 'awaiting_owner'
      WHEN ltl.terminal_kind = 'task_failed' THEN 'failed'
      WHEN ltl.terminal_kind IN ('task_committed','task_closure_audited') AND COALESCE(ot.n, 0) = 0 THEN 'completed'
      WHEN COALESCE(ot.n, 0) > 0 THEN 'in_progress'
      ELSE 'idle'
    END AS latest_state_kind,
    CASE
      WHEN aw.req_event_id IS NOT NULL THEN COALESCE(aw.suggested_action, 'Reply when ready.')
      ELSE NULL
    END AS next_owner_action,
    irr.description AS risk_note,
    ltl.terminal_residual AS residual_optional,
    -- detail_refs: small JSON array of the most useful drilldown event_ids
    -- (directive_opened, latest awaiting request, latest terminal).
    json_array(
      (SELECT id FROM events WHERE directive_id = d.directive_id AND kind = 'directive_opened' ORDER BY ts ASC LIMIT 1),
      aw.req_event_id,
      ltl.terminal_event_id
    ) AS detail_refs,
    d.latest_ts AS last_event_ts
  FROM directives d
  LEFT JOIN opened o                ON o.directive_id = d.directive_id
  LEFT JOIN closed c                ON c.directive_id = d.directive_id
  LEFT JOIN awaiting_latest aw      ON aw.directive_id = d.directive_id
  LEFT JOIN last_terminal_latest ltl ON ltl.directive_id = d.directive_id
  LEFT JOIN open_tasks ot           ON ot.directive_id = d.directive_id
  LEFT JOIN irreversible_latest irr  ON irr.directive_id = d.directive_id
  ORDER BY d.latest_ts DESC;
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

// entity_relationship_view — normalized entity edges projected from existing
// stakeholder declarations and cross-directive interference rows. Relationship
// details stay open-ended in payload.relationship / declared_utility; the view
// only standardizes graph columns so research tasks can query companies,
// suppliers, customers, regulators, and competitors without a fixed taxonomy.
const VIEW_ENTITY_RELATIONSHIPS = `
CREATE VIEW IF NOT EXISTS entity_relationship_view AS
  SELECT
    event_id,
    ts,
    directive_id,
    stakeholder_id                                      AS from_entity,
    json_extract(declared_utility, '$.entity')          AS to_entity,
    json_extract(declared_utility, '$.relationship')    AS relationship,
    declared_utility                                    AS relationship_payload,
    payload,
    'stakeholder_state_recorded'                        AS source_kind
  FROM stakeholder_state_view
  UNION ALL
  SELECT
    event_id,
    ts,
    directive_id,
    from_directive                                      AS from_entity,
    to_directive                                        AS to_entity,
    interaction                                         AS relationship,
    payload                                             AS relationship_payload,
    payload,
    'directive_interference_edge'                       AS source_kind
  FROM directive_conflicts_view;
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
// recipe-shape knowledge row per (goal_shape, topology_signature). The recipe
// event family was absorbed into knowledge_* under universality proposal
// A12CR1QCDN0SS51CM95K39T45M; recipe_shape.enabled distinguishes recipe-shape
// knowledge rows from regular knowledge rows. Updates are append-only
// knowledge_candidate / knowledge_promoted rows, so callers need the freshest
// row for each composite recipe key rather than a raw history scan.
// Recipe payloads should grow toward explicit preconditions, effects, replay_feedback,
// and validation fields so Tier-0 replay learns skill boundaries instead of matching
// only on goal_shape × topology_signature (per SCALAR skill-library SOTA, brain
// dispatch FNJJPAC55H69379F562DMQK1FM 2026-05-16).
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
    WHERE e.kind IN ('knowledge_candidate', 'knowledge_promoted')
      AND COALESCE(
        json_extract(e.payload, '$.recipe_shape.enabled'),
        json_extract(e.payload, '$.recipe.enabled'),
        json_extract(e.payload, '$.is_recipe'),
        0
      ) IN (1, 'true')
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

// recipes_latest_view — materialized recipe matcher index keyed by
// (goal_shape, topology_signature). Where recipe_registry_view picks the
// freshest row per key, this view picks the HIGHEST-CONFIDENCE row per key
// (ties broken by ts DESC, rowid DESC). It exists so runtime/recipe_replay.ts
// can do an O(1) keyed lookup at dispatch time instead of a full linear scan
// over recipe-shape knowledge history. Closes the fast-axis gap from brain
// audit QQEHAW97GS0AX7TEQ717Y3P174 (2026-05-15). After universality proposal
// A12CR1QCDN0SS51CM95K39T45M the source rows are knowledge_candidate /
// knowledge_promoted carrying recipe_shape.enabled.
const VIEW_RECIPES_LATEST = `
CREATE VIEW IF NOT EXISTS recipes_latest_view AS
  WITH recipes AS (
    SELECT
      e.rowid                                                        AS event_rowid,
      e.id                                                           AS id,
      e.ts                                                           AS ts,
      CAST(COALESCE(json_extract(e.payload, '$.confidence'), 0) AS REAL) AS confidence,
      json_extract(e.payload, '$.goal_shape')                        AS goal_shape,
      json_extract(e.payload, '$.topology_signature')                AS topology_signature,
      e.payload                                                      AS payload
    FROM events e
    WHERE e.kind IN ('knowledge_candidate', 'knowledge_promoted')
      AND COALESCE(
        json_extract(e.payload, '$.recipe_shape.enabled'),
        json_extract(e.payload, '$.recipe.enabled'),
        json_extract(e.payload, '$.is_recipe'),
        0
      ) IN (1, 'true')
  )
  SELECT
    id,
    ts,
    confidence,
    goal_shape,
    topology_signature,
    payload
  FROM recipes r
  WHERE NOT EXISTS (
    SELECT 1
    FROM recipes better
    -- Same NULL-preserving key match as recipe_registry_view: NULL matches
    -- NULL exactly, '' matches '' exactly, never crosswise.
    WHERE ((better.goal_shape = r.goal_shape) OR (better.goal_shape IS NULL AND r.goal_shape IS NULL))
      AND ((better.topology_signature = r.topology_signature) OR (better.topology_signature IS NULL AND r.topology_signature IS NULL))
      AND (
        better.confidence > r.confidence
        OR (better.confidence = r.confidence AND better.ts > r.ts)
        OR (better.confidence = r.confidence AND better.ts = r.ts AND better.event_rowid > r.event_rowid)
      )
  );
`;

// lesson_implementer_queue_view — derived inbox for the lesson-implementer
// flywheel. It projects lesson_extracted / contract_amendment_proposed rows
// that have not reached applied_change_committed. Owner gating is derived
// from dynamic owner_profile policy at apply time. Auto-apply remains fail-closed
// until an action_scored auto_apply_gate verifier reports low residual across
// freshness, duplicate, behavioral novelty, necessity, and adversarial axes.
// No posterior or queue table is stored; the ledger remains the source.
//
// Audit T3AUDVIEWMERGE8K (directive ZCC1T43JQN3CH3PS, 2026-05-16) flagged this
// view + lesson_implementation_status_view as "overlapping post-3208a41
// collapse" and proposed merging or deleting one. The claim was REFUSED on
// inspection. Rationale:
//   1. FILTER SEMANTICS DIVERGE. This view's terminal WHERE clause excludes
//      committed proposals (`WHERE c.source_event_id IS NULL`) — it is the
//      orchestrator's NOT-YET-APPLIED inbox. status_view projects EVERY
//      proposal including committed ones — it is the AUDIT TIMELINE. Merging
//      would force one consumer class to filter what the other relies on as
//      a pre-filter (prompt_composer.ts depends on this exclusion).
//   2. COLUMN OVERLAP ≈ 27% / 48%. Shared columns are bookkeeping
//      (source_event_id, ts, directive_id, task_id, payload, context_refs)
//      plus the latest_apply tuple. queue exposes ~25 gate-decision columns
//      (owner_gate_required, owner_approved, auto_apply_target, auto_apply_
//      eligible, 5-axis residual breakdown, apply_gate_status/reason,
//      trajectory_hazard_count, structured_change, candidate_target/anchor/
//      diff, proposed_behavior, proposed_action, lesson_kind). status_view
//      exposes ~15 lifecycle columns (request_event_id, requested_at, action_
//      event_id, predicted_at, action_artifact_id, verifier_artifact_id,
//      predicted_residual, scored_event_id, scored_at, verifier_residual,
//      verifier_passed, commit_sha, applied_at, committed_event_id,
//      committed_at, flywheel_status). The disjoint columns drive disjoint
//      consumers — well below the merge threshold.
//   3. CONSUMERS ARE DISJOINT BY COLUMN.
//        - cli/apply.ts:166 reads queue-only gate columns.
//        - prompt_composer.ts:239 reads queue-only columns AND relies on the
//          NOT-YET-COMMITTED pre-filter.
//        - cli/apply.test.ts mostly reads status-only lifecycle columns; the
//          one queue read at line 399 verifies queue exposes post-apply state.
//        - lesson_apply_candidate_view (views.ts:1822-1824) JOINs both —
//          needs status's verifier_residual/flywheel_status AND queue's
//          owner_gate_*/trajectory_hazard_count/apply_gate_status.
//   4. CTE OVERLAP IS NOT VIEW OVERLAP. Both views compute authorized_requests
//      + latest_apply because both need to honour the
//      lesson_apply_requested → action_scored → applied_change_committed
//      authorization chain. That auth chain is a substrate invariant, not a
//      duplication. If CTE deduplication becomes worthwhile, the right
//      refactor is extracting the chain into a shared CTE — not collapsing
//      semantically-distinct views. Per commit b41cfdd ("DO NOT OVER-ENGINEER")
//      that refactor is premature with only two consumers.
// Conclusion: the views are complementary projections of the same proposal
// stream — orchestrator-gate inbox vs audit-timeline — and stay separate.
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
        json_extract(e.payload, '$.target_resource'),
        json_extract(e.payload, '$.resource_uri'),
        json_extract(e.payload, '$.target'),
        json_extract(e.payload, '$.proposed_behavior.target_resource'),
        json_extract(e.payload, '$.proposed_behavior.resource_uri'),
        json_extract(e.payload, '$.proposed_action.target_resource'),
        json_extract(e.payload, '$.proposed_action.resource_uri'),
        CASE WHEN json_extract(e.payload, '$.proposed_behavior.file_path') IS NOT NULL THEN 'repo:' || json_extract(e.payload, '$.proposed_behavior.file_path') END,
        CASE WHEN json_extract(e.payload, '$.proposed_action.file_path') IS NOT NULL THEN 'repo:' || json_extract(e.payload, '$.proposed_action.file_path') END
      )                                             AS target,
      json_extract(e.payload, '$.anchor')            AS anchor,
      json_extract(e.payload, '$.proposed_behavior') AS proposed_behavior,
      json_extract(e.payload, '$.proposed_action')   AS proposed_action,
      COALESCE(
        json_extract(e.payload, '$.target_resource'),
        json_extract(e.payload, '$.resource_uri'),
        json_extract(e.payload, '$.target'),
        json_extract(e.payload, '$.proposed_behavior.target_resource'),
        json_extract(e.payload, '$.proposed_behavior.resource_uri'),
        json_extract(e.payload, '$.proposed_action.target_resource'),
        json_extract(e.payload, '$.proposed_action.resource_uri'),
        CASE WHEN json_extract(e.payload, '$.proposed_behavior.file_path') IS NOT NULL THEN 'repo:' || json_extract(e.payload, '$.proposed_behavior.file_path') END,
        CASE WHEN json_extract(e.payload, '$.proposed_action.file_path') IS NOT NULL THEN 'repo:' || json_extract(e.payload, '$.proposed_action.file_path') END
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
        'target_resource', COALESCE(
          json_extract(e.payload, '$.target_resource'),
          json_extract(e.payload, '$.resource_uri'),
          json_extract(e.payload, '$.target'),
          json_extract(e.payload, '$.proposed_behavior.target_resource'),
          json_extract(e.payload, '$.proposed_behavior.resource_uri'),
          json_extract(e.payload, '$.proposed_action.target_resource'),
          json_extract(e.payload, '$.proposed_action.resource_uri'),
          CASE WHEN json_extract(e.payload, '$.proposed_behavior.file_path') IS NOT NULL THEN 'repo:' || json_extract(e.payload, '$.proposed_behavior.file_path') END,
          CASE WHEN json_extract(e.payload, '$.proposed_action.file_path') IS NOT NULL THEN 'repo:' || json_extract(e.payload, '$.proposed_action.file_path') END
        ),
        'target', COALESCE(
          json_extract(e.payload, '$.target_resource'),
          json_extract(e.payload, '$.resource_uri'),
          json_extract(e.payload, '$.target'),
          json_extract(e.payload, '$.proposed_behavior.target_resource'),
          json_extract(e.payload, '$.proposed_behavior.resource_uri'),
          json_extract(e.payload, '$.proposed_action.target_resource'),
          json_extract(e.payload, '$.proposed_action.resource_uri'),
          CASE WHEN json_extract(e.payload, '$.proposed_behavior.file_path') IS NOT NULL THEN 'repo:' || json_extract(e.payload, '$.proposed_behavior.file_path') END,
          CASE WHEN json_extract(e.payload, '$.proposed_action.file_path') IS NOT NULL THEN 'repo:' || json_extract(e.payload, '$.proposed_action.file_path') END
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
       OR (e.kind = 'knowledge_candidate' AND json_extract(e.payload, '$.is_lesson') IN (1, 'true'))
  ),
  target_candidates AS (
    SELECT source_event_id, trim(target) AS target
    FROM proposals
    WHERE target IS NOT NULL AND length(trim(target)) > 0
    UNION
    SELECT source_event_id, trim(json_extract(payload, '$.target_resource')) AS target
    FROM proposals
    WHERE json_extract(payload, '$.target_resource') IS NOT NULL
      AND length(trim(json_extract(payload, '$.target_resource'))) > 0
    UNION
    SELECT source_event_id, trim(json_extract(payload, '$.resource_uri')) AS target
    FROM proposals
    WHERE json_extract(payload, '$.resource_uri') IS NOT NULL
      AND length(trim(json_extract(payload, '$.resource_uri'))) > 0
    UNION
    SELECT source_event_id, trim(json_extract(payload, '$.proposed_behavior.target_resource')) AS target
    FROM proposals
    WHERE json_type(payload, '$.proposed_behavior') = 'object'
      AND json_extract(payload, '$.proposed_behavior.target_resource') IS NOT NULL
      AND length(trim(json_extract(payload, '$.proposed_behavior.target_resource'))) > 0
    UNION
    SELECT source_event_id, trim(json_extract(payload, '$.proposed_behavior.resource_uri')) AS target
    FROM proposals
    WHERE json_type(payload, '$.proposed_behavior') = 'object'
      AND json_extract(payload, '$.proposed_behavior.resource_uri') IS NOT NULL
      AND length(trim(json_extract(payload, '$.proposed_behavior.resource_uri'))) > 0
    UNION
    SELECT source_event_id, trim(json_extract(payload, '$.proposed_action.target_resource')) AS target
    FROM proposals
    WHERE json_type(payload, '$.proposed_action') = 'object'
      AND json_extract(payload, '$.proposed_action.target_resource') IS NOT NULL
      AND length(trim(json_extract(payload, '$.proposed_action.target_resource'))) > 0
    UNION
    SELECT source_event_id, trim(json_extract(payload, '$.proposed_action.resource_uri')) AS target
    FROM proposals
    WHERE json_type(payload, '$.proposed_action') = 'object'
      AND json_extract(payload, '$.proposed_action.resource_uri') IS NOT NULL
      AND length(trim(json_extract(payload, '$.proposed_action.resource_uri'))) > 0
    UNION
    SELECT source_event_id, 'repo:' || trim(json_extract(payload, '$.proposed_behavior.file_path')) AS target
    FROM proposals
    WHERE json_type(payload, '$.proposed_behavior') = 'object'
      AND json_extract(payload, '$.proposed_behavior.file_path') IS NOT NULL
      AND length(trim(json_extract(payload, '$.proposed_behavior.file_path'))) > 0
    UNION
    SELECT source_event_id, 'repo:' || trim(json_extract(payload, '$.proposed_action.file_path')) AS target
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
    -- Audit #3 collapse (owner-approved 2026-05-16): applied_change_committed
    -- now subsumes lesson_applied + contract_amendment_applied; status lives in
    -- payload.status (applied/failed/refused), source_kind in payload.source_kind.
    -- Authorization gate (mirrors terminal CTE): only count applied_change_committed
    -- whose source has a matching lesson_apply_requested + action_scored linkage,
    -- so "unauthorized" + "unscored" apply rows stay invisible to the flywheel
    -- view (same invariants as the pre-collapse *_applied path).
    WHERE kind = 'applied_change_committed'
      AND EXISTS (
        SELECT 1 FROM authorized_requests ar
        JOIN events s
          ON s.kind = 'action_scored'
         AND COALESCE(json_extract(s.payload, '$.source_event_id'), json_extract(s.context_refs, '$[0]')) = ar.source_event_id
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
  ),
  owner_approvals AS (
    SELECT DISTINCT COALESCE(
      json_extract(payload, '$.source_event_id'),
      json_extract(context_refs, '$[0]'),
      json_extract(payload, '$.directive_id'),
      directive_id
    ) AS approval_scope
    FROM events
    WHERE kind = 'owner_decision_recorded'
      AND (
        json_extract(payload, '$.decision') IN ('approved', 'approve', 'yes')
        OR json_extract(payload, '$.outcome') = 'approved'
      )
  ),
  hazards AS (
    SELECT directive_id, COUNT(*) AS hazard_count
    FROM events
    WHERE kind IN ('dispatcher_violation', 'irreversible_effect_recorded')
    GROUP BY directive_id
  ),
  latest_auto_apply_gate_score AS (
    SELECT * FROM (
      SELECT
        COALESCE(
          json_extract(payload, '$.source_event_id'),
          json_extract(payload, '$.auto_apply_gate.source_event_id'),
          json_extract(context_refs, '$[0]')
        ) AS source_event_id,
        id AS auto_apply_gate_event_id,
        CAST(COALESCE(
          json_extract(payload, '$.auto_apply_gate.residual'),
          json_extract(payload, '$.residual'),
          residual,
          1
        ) AS REAL) AS auto_apply_gate_residual,
        CAST(COALESCE(
          json_extract(payload, '$.auto_apply_gate.breakdown.freshness'),
          json_extract(payload, '$.auto_apply_gate.breakdown.anchor_freshness'),
          json_extract(payload, '$.breakdown.freshness'),
          json_extract(payload, '$.breakdown.anchor_freshness'),
          1
        ) AS REAL) AS freshness_residual,
        CAST(COALESCE(
          json_extract(payload, '$.auto_apply_gate.breakdown.semantic_duplicate'),
          json_extract(payload, '$.auto_apply_gate.breakdown.duplicate'),
          json_extract(payload, '$.breakdown.semantic_duplicate'),
          json_extract(payload, '$.breakdown.duplicate'),
          1
        ) AS REAL) AS semantic_duplicate_residual,
        CAST(COALESCE(
          json_extract(payload, '$.auto_apply_gate.breakdown.behavioral_novelty'),
          json_extract(payload, '$.auto_apply_gate.breakdown.novelty'),
          json_extract(payload, '$.breakdown.behavioral_novelty'),
          json_extract(payload, '$.breakdown.novelty'),
          1
        ) AS REAL) AS behavioral_novelty_residual,
        CAST(COALESCE(
          json_extract(payload, '$.auto_apply_gate.breakdown.necessity'),
          json_extract(payload, '$.breakdown.necessity'),
          1
        ) AS REAL) AS necessity_residual,
        CAST(COALESCE(
          json_extract(payload, '$.auto_apply_gate.breakdown.adversarial'),
          json_extract(payload, '$.auto_apply_gate.breakdown.adversarial_review'),
          json_extract(payload, '$.breakdown.adversarial'),
          json_extract(payload, '$.breakdown.adversarial_review'),
          1
        ) AS REAL) AS adversarial_residual,
        COALESCE(
          json_extract(payload, '$.auto_apply_gate.breakdown'),
          json_extract(payload, '$.breakdown'),
          json_object()
        ) AS auto_apply_gate_breakdown,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(
            json_extract(payload, '$.source_event_id'),
            json_extract(payload, '$.auto_apply_gate.source_event_id'),
            json_extract(context_refs, '$[0]')
          )
          ORDER BY ts DESC, rowid DESC
        ) AS rn
      FROM events
      WHERE kind = 'action_scored'
        AND (
          json_extract(payload, '$.gate_kind') = 'auto_apply_gate'
          OR json_extract(payload, '$.verifier_kind') = 'auto_apply_gate'
          OR json_type(payload, '$.auto_apply_gate') = 'object'
        )
    )
    WHERE rn = 1
  ),
  shaped AS (
    SELECT
      p.*,
      CASE
        WHEN json_type(p.payload, '$.proposed_behavior') = 'object'
         AND (
           json_extract(p.payload, '$.proposed_behavior.target_resource') = p.target
           OR json_extract(p.payload, '$.proposed_behavior.resource_uri') = p.target
           OR json_extract(p.payload, '$.proposed_behavior.target') = p.target
           OR json_extract(p.payload, '$.proposed_behavior.file_path') = p.target
           OR 'repo:' || json_extract(p.payload, '$.proposed_behavior.file_path') = p.target
         )
         AND length(trim(COALESCE(json_extract(p.payload, '$.proposed_behavior.anchor'), ''))) > 0
         AND (
           (json_type(p.payload, '$.proposed_behavior.diff') = 'text'
             AND length(trim(COALESCE(json_extract(p.payload, '$.proposed_behavior.diff'), ''))) > 0)
           OR (json_type(p.payload, '$.proposed_behavior.diff') = 'object'
             AND json_extract(p.payload, '$.proposed_behavior.diff.kind') = 'anchored_replace_v1'
             AND length(COALESCE(json_extract(p.payload, '$.proposed_behavior.diff.before'), '')) > 0
             AND json_type(p.payload, '$.proposed_behavior.diff.after') = 'text')
         )
        THEN 1
        WHEN json_type(p.payload, '$.proposed_action') = 'object'
         AND (
           json_extract(p.payload, '$.proposed_action.target_resource') = p.target
           OR json_extract(p.payload, '$.proposed_action.resource_uri') = p.target
           OR json_extract(p.payload, '$.proposed_action.target') = p.target
           OR json_extract(p.payload, '$.proposed_action.file_path') = p.target
           OR 'repo:' || json_extract(p.payload, '$.proposed_action.file_path') = p.target
         )
         AND length(trim(COALESCE(json_extract(p.payload, '$.proposed_action.anchor'), ''))) > 0
         AND (
           (json_type(p.payload, '$.proposed_action.diff') = 'text'
             AND length(trim(COALESCE(json_extract(p.payload, '$.proposed_action.diff'), ''))) > 0)
           OR (json_type(p.payload, '$.proposed_action.diff') = 'object'
             AND json_extract(p.payload, '$.proposed_action.diff.kind') = 'anchored_replace_v1'
             AND length(COALESCE(json_extract(p.payload, '$.proposed_action.diff.before'), '')) > 0
             AND json_type(p.payload, '$.proposed_action.diff.after') = 'text')
         )
        THEN 1
        ELSE 0
      END AS structured_change
    FROM proposals p
  ),
  target_policy AS (
    SELECT
      s.*,
      -- Owner gate is structural: no path-pattern enumeration. The
      -- payload's explicit owner_consent_required flag is the dynamic
      -- signal a producer (brain or orchestrator) sets when the proposal
      -- hits owner_profile.things_to_never_do or any other dynamic policy
      -- the apply-side decided requires consent. Absent that explicit
      -- flag the queue treats the proposal as not-owner-gated and lets
      -- the apply-time structural axes (residual, trajectory, diff
      -- shape) carry the decision.
      CASE
        WHEN json_extract(s.payload, '$.owner_consent_required') = 1
          OR json_extract(s.payload, '$.owner_consent_required') = 'true'
        THEN 1
        ELSE 0
      END AS owner_gate_required,
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
                (r.match = 'exact' AND (CASE WHEN tc.target LIKE 'repo:%' THEN substr(tc.target, 6) ELSE tc.target END) = r.pattern)
                OR (r.match = 'prefix' AND (CASE WHEN tc.target LIKE 'repo:%' THEN substr(tc.target, 6) ELSE tc.target END) LIKE r.pattern || '%')
              )
          )
      )
      THEN 1 ELSE 0 END AS auto_apply_target
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
    CASE WHEN oa.approval_scope IS NULL THEN 0 ELSE 1 END AS owner_approved,
    CASE
      WHEN p.owner_gate_required = 1 AND oa.approval_scope IS NULL
      THEN 'owner_consent_required'
      WHEN p.owner_gate_required = 1
      THEN 'owner_consent_approved'
      ELSE 'owner_consent_not_required'
    END AS owner_gate_verdict,
    p.auto_apply_target,
    p.structured_change,
    COALESCE(h.hazard_count, 0) AS trajectory_hazard_count,
    gs.auto_apply_gate_event_id,
    gs.auto_apply_gate_residual,
    gs.freshness_residual,
    gs.semantic_duplicate_residual,
    gs.behavioral_novelty_residual,
    gs.necessity_residual,
    gs.adversarial_residual,
    gs.auto_apply_gate_breakdown,
    CASE
      WHEN p.auto_apply_target = 1
       AND p.structured_change = 1
       AND COALESCE(h.hazard_count, 0) = 0
       AND gs.auto_apply_gate_event_id IS NOT NULL
       AND gs.auto_apply_gate_residual < 0.3
       AND gs.freshness_residual < 0.3
       AND gs.semantic_duplicate_residual < 0.3
       AND gs.behavioral_novelty_residual < 0.3
       AND gs.necessity_residual < 0.3
       AND gs.adversarial_residual < 0.3
      THEN 1 ELSE 0
    END AS auto_apply_eligible,
    CASE
      WHEN p.auto_apply_target = 0
      THEN 'not_auto_apply_target'
      WHEN COALESCE(h.hazard_count, 0) > 0
      THEN 'blocked_trajectory_hazard'
      WHEN p.structured_change = 0
      THEN 'blocked_unstructured_proposal'
      WHEN gs.auto_apply_gate_event_id IS NULL
      THEN 'blocked_auto_apply_gate_missing'
      WHEN gs.auto_apply_gate_residual >= 0.3
      THEN 'blocked_auto_apply_gate_residual'
      WHEN gs.freshness_residual >= 0.3
        OR gs.semantic_duplicate_residual >= 0.3
        OR gs.behavioral_novelty_residual >= 0.3
        OR gs.necessity_residual >= 0.3
        OR gs.adversarial_residual >= 0.3
      THEN 'blocked_auto_apply_gate_axis'
      ELSE 'auto_apply_eligible'
    END AS auto_apply_gate_verdict,
    CASE
      WHEN p.auto_apply_target = 1
       AND COALESCE(h.hazard_count, 0) > 0
      THEN 'blocked_trajectory_hazard'
      WHEN p.auto_apply_target = 1
       AND p.structured_change = 0
      THEN 'blocked_unstructured_proposal'
      WHEN p.auto_apply_target = 1
       AND gs.auto_apply_gate_event_id IS NULL
      THEN 'blocked_auto_apply_gate_missing'
      WHEN p.auto_apply_target = 1
       AND (gs.auto_apply_gate_residual >= 0.3
        OR gs.freshness_residual >= 0.3
        OR gs.semantic_duplicate_residual >= 0.3
        OR gs.behavioral_novelty_residual >= 0.3
        OR gs.necessity_residual >= 0.3
        OR gs.adversarial_residual >= 0.3)
      THEN 'blocked_auto_apply_gate_residual'
      WHEN p.auto_apply_target = 1
      THEN 'authorized_auto'
      ELSE 'manual_review'
    END AS apply_gate_status,
    CASE
      WHEN p.auto_apply_target = 1
       AND COALESCE(h.hazard_count, 0) > 0
      THEN 'trajectory_hazard_present'
      WHEN p.auto_apply_target = 1
       AND p.structured_change = 0
      THEN 'structured_proposed_behavior_required'
      WHEN p.auto_apply_target = 1
       AND gs.auto_apply_gate_event_id IS NULL
      THEN 'auto_apply_gate_score_missing'
      WHEN p.auto_apply_target = 1
       AND gs.auto_apply_gate_residual >= 0.3
      THEN 'auto_apply_gate_residual_high'
      WHEN p.auto_apply_target = 1
       AND gs.freshness_residual >= 0.3
      THEN 'freshness_residual_high'
      WHEN p.auto_apply_target = 1
       AND gs.semantic_duplicate_residual >= 0.3
      THEN 'semantic_duplicate_residual_high'
      WHEN p.auto_apply_target = 1
       AND gs.behavioral_novelty_residual >= 0.3
      THEN 'behavioral_novelty_residual_high'
      WHEN p.auto_apply_target = 1
       AND gs.necessity_residual >= 0.3
      THEN 'necessity_residual_high'
      WHEN p.auto_apply_target = 1
       AND gs.adversarial_residual >= 0.3
      THEN 'adversarial_residual_high'
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
  LEFT JOIN latest_auto_apply_gate_score gs ON gs.source_event_id = p.source_event_id
  LEFT JOIN owner_approvals oa ON oa.approval_scope = p.source_event_id OR oa.approval_scope = p.directive_id
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
          json_extract(payload, '$.target_resource'),
          json_extract(payload, '$.resource_uri'),
          json_extract(payload, '$.target'),
          json_extract(payload, '$.proposed_behavior.target_resource'),
          json_extract(payload, '$.proposed_behavior.resource_uri'),
          json_extract(payload, '$.proposed_action.target_resource'),
          json_extract(payload, '$.proposed_action.resource_uri'),
          CASE WHEN json_extract(payload, '$.proposed_behavior.file_path') IS NOT NULL THEN 'repo:' || json_extract(payload, '$.proposed_behavior.file_path') END,
          CASE WHEN json_extract(payload, '$.proposed_action.file_path') IS NOT NULL THEN 'repo:' || json_extract(payload, '$.proposed_action.file_path') END
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
       OR (kind = 'knowledge_candidate' AND json_extract(payload, '$.is_lesson') IN (1, 'true'))
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
    -- Audit #3 collapse (owner-approved 2026-05-16): applied_change_committed
    -- now subsumes lesson_applied + contract_amendment_applied; status lives in
    -- payload.status (applied/failed/refused), source_kind in payload.source_kind.
    -- Authorization gate (mirrors terminal CTE): only count applied_change_committed
    -- whose source has a matching lesson_apply_requested + action_scored linkage,
    -- so "unauthorized" + "unscored" apply rows stay invisible to the flywheel
    -- view (same invariants as the pre-collapse *_applied path).
    WHERE kind = 'applied_change_committed'
      AND EXISTS (
        SELECT 1 FROM authorized_requests ar
        JOIN events s
          ON s.kind = 'action_scored'
         AND COALESCE(json_extract(s.payload, '$.source_event_id'), json_extract(s.context_refs, '$[0]')) = ar.source_event_id
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
     AND r.kind IN ('dispatch_decided', 'action_predicted', 'action_scored', 'task_committed')
     AND (
       json_extract(r.payload, '$.recipe_replayed') = 1
       OR json_extract(r.payload, '$.recipe_replayed') = 'true'
       OR json_extract(r.payload, '$.route') = 'substrate_replay'
       OR json_extract(r.payload, '$.reusable_trajectory_replay_selected') = 1
       OR json_extract(r.payload, '$.reusable_trajectory_replay_selected') = 'true'
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
      json_extract(s.payload, '$.target_resource'),
      json_extract(s.payload, '$.resource_uri'),
      json_extract(s.payload, '$.target'),
      json_extract(s.payload, '$.proposed_behavior.target_resource'),
      json_extract(s.payload, '$.proposed_behavior.resource_uri'),
      json_extract(s.payload, '$.proposed_action.target_resource'),
      json_extract(s.payload, '$.proposed_action.resource_uri'),
      CASE WHEN json_extract(s.payload, '$.proposed_behavior.file_path') IS NOT NULL THEN 'repo:' || json_extract(s.payload, '$.proposed_behavior.file_path') END,
      CASE WHEN json_extract(s.payload, '$.proposed_action.file_path') IS NOT NULL THEN 'repo:' || json_extract(s.payload, '$.proposed_action.file_path') END
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

// dispatch_resolved_view — authoritative lifecycle projection for
// orchestrator polling. One row per (directive_id, root_task_id), rolling up
// signals from every task in that root's subtree. Status values are:
// completed, failed, queued_at_cap, zombie, and live.
const VIEW_DISPATCH_RESOLVED = `
CREATE VIEW IF NOT EXISTS dispatch_resolved_view AS
WITH RECURSIVE explicit_roots AS (
  SELECT
    e.directive_id,
    e.task_id AS root_task_id,
    e.ts AS root_opened_ts
  FROM events e
  WHERE e.kind = 'task_node_opened'
    AND (e.parent_task_id IS NULL OR e.parent_task_id = '')
),
inferred_roots AS (
  -- 2026-05-17 Bug fix: constitutional_gate_decision alone is NOT a
  -- task — it's a gate signal that can fire on synthetic owner-profile
  -- flows (owner_insight_candidate / action_scored / owner_profile_recorded
  -- chains) without a task_node ever opening. Pre-fix 62 production
  -- task_ids appeared in dispatch_resolved_view as orphan_node solely
  -- because they had a constitutional_gate_decision row; the reaper
  -- correctly skipped them (no task_node_opened) but the operator
  -- surface flagged them as orphans. Require at least one DISPATCH or
  -- TERMINAL kind for inferred-root status; constitutional_gate_decision
  -- on its own is informational only.
  SELECT
    e.directive_id,
    e.task_id AS root_task_id,
    MIN(e.ts) AS root_opened_ts
  FROM events e
  WHERE e.kind IN (
    'brain_dispatched',
    'brain_dispatch_closed',
    'task_committed',
    'task_failed',
    'dispatcher_violation'
  )
    AND e.task_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM events root
      WHERE root.kind = 'task_node_opened'
        AND root.directive_id = e.directive_id
        AND root.task_id = e.task_id
    )
  GROUP BY e.directive_id, e.task_id
),
roots AS (
  SELECT directive_id, root_task_id, root_opened_ts FROM explicit_roots
  UNION ALL
  SELECT directive_id, root_task_id, root_opened_ts FROM inferred_roots
),
tree AS (
  SELECT
    r.directive_id,
    r.root_task_id,
    r.root_task_id AS task_id,
    r.root_opened_ts
  FROM roots r
  UNION ALL
  SELECT
    t.directive_id,
    t.root_task_id,
    child.task_id,
    t.root_opened_ts
  FROM tree t
  JOIN events child
    ON child.kind = 'task_node_opened'
   AND child.directive_id = t.directive_id
   AND child.parent_task_id = t.task_id
),
dispatches AS (
  SELECT
    t.directive_id,
    t.root_task_id,
    d.task_id,
    d.id AS dispatch_event_id,
    d.ts AS dispatch_ts,
    json_extract(d.payload, '$.dispatch_id') AS dispatch_id
  FROM tree t
  JOIN events d
    ON d.directive_id = t.directive_id
   AND d.task_id = t.task_id
   AND d.kind = 'brain_dispatched'
),
closes AS (
  -- Explicit brain_dispatch_closed events: matched against a specific dispatch_id.
  SELECT
    t.directive_id,
    t.root_task_id,
    c.task_id,
    c.id AS close_event_id,
    c.ts AS close_ts,
    json_extract(c.payload, '$.dispatch_id') AS dispatch_id
  FROM tree t
  JOIN events c
    ON c.directive_id = t.directive_id
   AND c.task_id = t.task_id
   AND c.kind = 'brain_dispatch_closed'
  UNION ALL
  -- Implicit close: a terminal event on a task closes any open dispatches on
  -- that same task (the brain may commit/fail without emitting an explicit
  -- brain_dispatch_closed). dispatch_id IS NULL so the predicate below
  -- matches against any dispatch on the task.
  SELECT
    t.directive_id,
    t.root_task_id,
    c.task_id,
    c.id AS close_event_id,
    c.ts AS close_ts,
    NULL AS dispatch_id
  FROM tree t
  JOIN events c
    ON c.directive_id = t.directive_id
   AND c.task_id = t.task_id
   AND c.kind IN ('task_committed', 'task_failed', 'dispatcher_violation')
),
dispatch_summary AS (
  SELECT
    d.directive_id,
    d.root_task_id,
    COUNT(*) AS dispatched_count,
    MAX(d.dispatch_event_id) AS dispatch_event_id,
    MAX(d.dispatch_id) AS dispatch_id,
    SUM(CASE WHEN NOT EXISTS (
      SELECT 1 FROM closes c
      WHERE c.directive_id = d.directive_id
        AND c.root_task_id = d.root_task_id
        AND c.task_id = d.task_id
        AND (c.dispatch_id IS NULL OR COALESCE(c.dispatch_id, '') = COALESCE(d.dispatch_id, ''))
        AND c.close_ts >= d.dispatch_ts
    ) THEN 1 ELSE 0 END) AS open_dispatch_count,
    MAX(d.dispatch_ts) AS latest_dispatched_at,
    MIN(CASE WHEN NOT EXISTS (
      SELECT 1 FROM closes c
      WHERE c.directive_id = d.directive_id
        AND c.root_task_id = d.root_task_id
        AND c.task_id = d.task_id
        AND (c.dispatch_id IS NULL OR COALESCE(c.dispatch_id, '') = COALESCE(d.dispatch_id, ''))
        AND c.close_ts >= d.dispatch_ts
    ) THEN d.dispatch_ts ELSE NULL END) AS oldest_open_dispatched_at
  FROM dispatches d
  GROUP BY d.directive_id, d.root_task_id
),
close_summary AS (
  SELECT
    directive_id,
    root_task_id,
    MAX(close_ts) AS latest_closed_at,
    MAX(close_event_id) AS close_event_id
  FROM closes
  GROUP BY directive_id, root_task_id
),
terminal_ranked AS (
  SELECT
    t.directive_id,
    t.root_task_id,
    e.id AS terminal_event_id,
    e.ts AS terminal_at,
    e.kind AS terminal_kind,
    e.failure_kind,
    -- 2026-05-17 Bug A extension: brain-emitted task_committed rows
    -- carry the residual inside payload (e.g. {"summary":"…","residual":0.18}),
    -- not on the events.residual column. Pre-fix terminal CTE only read
    -- the column, so 'completed' rows in the TUI showed r=— even when
    -- the brain explicitly named a closure_residual. COALESCE the
    -- two surfaces and the payload-shape variants (residual,
    -- closure_residual, observed_residual) so any documented residual
    -- semantics surface to the dispatch projection.
    COALESCE(
      e.residual,
      CAST(json_extract(e.payload, '$.residual') AS REAL),
      CAST(json_extract(e.payload, '$.closure_residual') AS REAL),
      CAST(json_extract(e.payload, '$.observed_residual') AS REAL)
    ) AS residual,
    ROW_NUMBER() OVER (PARTITION BY t.directive_id, t.root_task_id ORDER BY e.ts DESC, CASE WHEN e.kind = 'task_committed' THEN 0 ELSE 1 END, e.id DESC) AS rn
  FROM tree t
  JOIN events e
    ON e.directive_id = t.directive_id
   AND e.task_id = t.task_id
   -- 2026-05-21: task_abandoned added. The pre-dispatch-orphan reaper
   -- (reconcilePreDispatchOrphans) emits task_abandoned for directives that
   -- opened but never dispatched before a restart. Without it here, those
   -- reaped tasks had terminal_kind=NULL → fell through to the open-dispatch
   -- / orphan logic → showed as 'zombie' FOREVER in acc watch despite being
   -- terminally abandoned (owner saw a 2m-old reaped task still 'zombie').
   AND e.kind IN ('task_committed', 'task_failed', 'dispatcher_violation', 'task_abandoned')
),
terminal AS (
  SELECT * FROM terminal_ranked WHERE rn = 1
),
cap_gate_ranked AS (
  SELECT
    t.directive_id,
    t.root_task_id,
    g.id AS latest_cap_gate_event_id,
    g.ts AS latest_cap_gate_at,
    json_extract(g.payload, '$.reason') AS queued_reason,
    CAST(json_extract(g.payload, '$.cap') AS INTEGER) AS cap,
    CAST(json_extract(g.payload, '$.in_flight_brain') AS INTEGER) AS in_flight_brain,
    ROW_NUMBER() OVER (PARTITION BY t.directive_id, t.root_task_id ORDER BY g.ts DESC) AS rn
  FROM tree t
  JOIN events g
    ON g.directive_id = t.directive_id
   AND g.task_id = t.task_id
   AND g.kind = 'constitutional_gate_decision'
   AND json_extract(g.payload, '$.gate') IN (
     'brain_concurrency_cap',
     'bridge_health_degraded',
     'scheduler_global_concurrency_cap',
     'scheduler_per_directive_concurrency_cap',
     'scheduler_draining',
     'scheduler_interference_deferred',
     'directive_blocked_deferred'
   )
),
cap_gate AS (
  SELECT * FROM cap_gate_ranked WHERE rn = 1
),
ready_ranked AS (
  SELECT
    t.directive_id,
    t.root_task_id,
    r.event_id AS ready_event_id,
    r.ts AS ready_since,
    ROW_NUMBER() OVER (PARTITION BY t.directive_id, t.root_task_id ORDER BY r.ts ASC) AS rn
  FROM tree t
  JOIN ready_tasks_view r
    ON r.directive_id = t.directive_id
   AND r.task_id = t.task_id
),
ready AS (
  SELECT directive_id, root_task_id, ready_event_id, ready_since
  FROM ready_ranked
  WHERE rn = 1
),
signals AS (
  SELECT directive_id, root_task_id, NULL AS event_id, root_opened_ts AS ts, 'root_opened' AS reason
  FROM roots
  UNION ALL
  SELECT directive_id, root_task_id, dispatch_event_id, latest_dispatched_at, 'brain_dispatched'
  FROM dispatch_summary
  WHERE latest_dispatched_at IS NOT NULL
  UNION ALL
  SELECT directive_id, root_task_id, close_event_id, latest_closed_at, 'brain_dispatch_closed'
  FROM close_summary
  WHERE latest_closed_at IS NOT NULL
  UNION ALL
  SELECT directive_id, root_task_id, terminal_event_id, terminal_at, terminal_kind
  FROM terminal
  WHERE terminal_at IS NOT NULL
  UNION ALL
  SELECT directive_id, root_task_id, latest_cap_gate_event_id, latest_cap_gate_at, COALESCE(queued_reason, 'queued_at_cap')
  FROM cap_gate
  WHERE latest_cap_gate_at IS NOT NULL
  UNION ALL
  SELECT directive_id, root_task_id, ready_event_id, ready_since, 'ready'
  FROM ready
  WHERE ready_since IS NOT NULL
),
signal_ranked AS (
  SELECT
    directive_id,
    root_task_id,
    event_id,
    ts,
    reason,
    ROW_NUMBER() OVER (PARTITION BY directive_id, root_task_id ORDER BY ts DESC, COALESCE(event_id, '') DESC) AS rn
  FROM signals
),
latest_signal AS (
  SELECT directive_id, root_task_id, event_id AS latest_event_id, ts AS latest_ts, reason AS latest_signal_reason
  FROM signal_ranked
  WHERE rn = 1
)
SELECT
  r.directive_id,
  r.root_task_id,
  CASE
    -- Closed-directive stragglers (2026-05-17 Bug B extension): when
    -- the parent directive is closed/archived, undispatched tasks
    -- under it are correctly abandoned, not orphan. They get their own
    -- 'abandoned' bucket so the operator surface can group + ignore
    -- them without false-positive orphan alerts. This must run BEFORE
    -- every other classification — including 'failed' / 'zombie' —
    -- because terminal events on a closed-directive task are equally
    -- "the DAG is over, this task's outcome no longer matters".
    WHEN term.terminal_kind IS NULL
         AND r.directive_id IN (
           SELECT directive_id FROM events
           WHERE kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
         )
      THEN 'abandoned'
    -- Bug C fix (2026-05-17): hard-failure terminals (task_failed,
    -- dispatcher_violation) MUST win over any open-dispatch zombie
    -- heuristic. Pre-fix a dispatcher_violation row whose
    -- brain_dispatched lacked a matching brain_dispatch_closed (common
    -- when the brain crashes mid-flight) was projected as 'zombie'
    -- instead of 'failed' — wrong classification, masks the failure.
    -- 'completed' still allows post-commit refinement to render as
    -- 'live' or 'zombie' (child task may be running after root commit).
    WHEN term.terminal_kind IN ('task_failed', 'dispatcher_violation', 'task_abandoned') THEN 'failed'
    -- 2026-05-18 foundational fix (matches lifecycle_status logic below):
    -- root committed + open children = 'live_amended', honestly distinct
    -- from a fresh 'live' (no terminal yet).
    WHEN term.terminal_kind = 'task_committed'
         AND COALESCE(ds.open_dispatch_count, 0) > 0
      THEN 'live_amended'
    -- In-flight dispatch ANYWHERE under the root wins over a stale terminal:
    -- a child task may be running a refinement cycle after the root committed.
    -- 2026-05-21 false-zombie fix: age alone (oldest open dispatch > 5min)
    -- is NOT zombie evidence. A legit brain dispatch routinely runs 10-13min,
    -- emitting events (brain_reasoning_recorded, contract_amendment_proposed,
    -- bridge_frame_received) every few seconds the whole time. The pure
    -- age-based rule flagged every long-but-healthy dispatch as 'zombie' at
    -- the 5min mark (observed: continual_owner_state actively emitting 4
    -- amendments + reasoning, shown 'zombie' in acc watch). Add a
    -- recent-activity guard: only zombie when there's been NO event for the
    -- directive in the last 3min (genuinely stalled), not merely old. ISO-vs-
    -- ISO strftime cutoff (index-friendly, no datetime() space-format trap).
    WHEN COALESCE(ds.open_dispatch_count, 0) > 0
         AND ds.oldest_open_dispatched_at IS NOT NULL
         AND CAST((julianday('now') - julianday(ds.oldest_open_dispatched_at)) * 86400000 AS INTEGER) > 300000
         AND NOT EXISTS (
           SELECT 1 FROM events e_act
           WHERE e_act.directive_id = r.directive_id
             AND e_act.ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 minutes')
         )
      THEN 'zombie'
    WHEN COALESCE(ds.open_dispatch_count, 0) > 0 THEN 'live'
    WHEN cg.latest_cap_gate_at IS NOT NULL
         AND COALESCE(ds.open_dispatch_count, 0) = 0
         AND ready.ready_since IS NOT NULL
      THEN 'queued_at_cap'
    WHEN term.terminal_kind = 'task_committed' THEN 'completed'
    -- Bug B partial fix (2026-05-17): widen the orphan_node threshold
    -- from 5 min to 1 hour so a brief scheduler/restart gap during
    -- normal operation does NOT immediately bucket a root as orphan.
    -- Past-session roots aged > 2 days still classify; the new
    -- threshold separates "actively-orphaned" from "transient gap".
    -- Bug B extension (2026-05-17): also exclude rows whose directive
    -- is already closed/archived. Live-substrate evidence: 268 orphan
    -- rows all had closed parent directives (74 via "all_tasks_terminal",
    -- 34 via owner archive). Those tasks are correctly-abandoned
    -- stragglers from a closed DAG; classifying them as 'orphan' is
    -- a misleading alert. They'll fall through to whatever the
    -- baseline ELSE branch produces (typically 'live' for the closed
    -- snapshot — still imperfect but no longer alarming).
    WHEN term.terminal_kind IS NULL
         AND COALESCE(ds.dispatched_count, 0) = 0
         AND COALESCE(ds.open_dispatch_count, 0) = 0
         AND cg.latest_cap_gate_at IS NULL
         AND r.root_opened_ts IS NOT NULL
         AND CAST((julianday('now') - julianday(r.root_opened_ts)) * 86400000 AS INTEGER) > 3600000
         AND r.directive_id NOT IN (
           SELECT directive_id FROM events
           WHERE kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
         )
      THEN 'orphan_node'
    WHEN COALESCE(ds.dispatched_count, 0) > 0 THEN 'live'
    ELSE 'live'
  END AS status,
  CASE
    WHEN term.terminal_kind IS NULL
         AND r.directive_id IN (
           SELECT directive_id FROM events
           WHERE kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
         )
      THEN 'abandoned'
    WHEN term.terminal_kind IN ('task_failed', 'dispatcher_violation', 'task_abandoned') THEN 'failed'
    -- 2026-05-18 foundational fix: when the brain emits task_committed AND
    -- subsequently directive_amended that opens new child task_node_opened
    -- rows, the substrate had open_dispatch_count > 0 on the SAME directive
    -- while terminal_kind was already task_committed. The view returned
    -- live (or zombie once the oldest child crossed 5min) — both lie
    -- about the directive state. The operator TUI showed
    -- task_committed 5m ago plus live r=0.27 simultaneously, which is
    -- contradictory and erodes trust in the substrate.
    -- New band 'live_amended': root committed, more work in flight under
    -- the same directive_id. Renderers can choose to show
    -- "continuing" vs "fresh start"; consumers reading for closure can
    -- still detect it via terminal_kind='task_committed'.
    WHEN term.terminal_kind = 'task_committed'
         AND COALESCE(ds.open_dispatch_count, 0) > 0
      THEN 'live_amended'
    -- 2026-05-21 false-zombie fix: age alone (oldest open dispatch > 5min)
    -- is NOT zombie evidence. A legit brain dispatch routinely runs 10-13min,
    -- emitting events (brain_reasoning_recorded, contract_amendment_proposed,
    -- bridge_frame_received) every few seconds the whole time. The pure
    -- age-based rule flagged every long-but-healthy dispatch as 'zombie' at
    -- the 5min mark (observed: continual_owner_state actively emitting 4
    -- amendments + reasoning, shown 'zombie' in acc watch). Add a
    -- recent-activity guard: only zombie when there's been NO event for the
    -- directive in the last 3min (genuinely stalled), not merely old. ISO-vs-
    -- ISO strftime cutoff (index-friendly, no datetime() space-format trap).
    WHEN COALESCE(ds.open_dispatch_count, 0) > 0
         AND ds.oldest_open_dispatched_at IS NOT NULL
         AND CAST((julianday('now') - julianday(ds.oldest_open_dispatched_at)) * 86400000 AS INTEGER) > 300000
         AND NOT EXISTS (
           SELECT 1 FROM events e_act
           WHERE e_act.directive_id = r.directive_id
             AND e_act.ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 minutes')
         )
      THEN 'zombie'
    WHEN COALESCE(ds.open_dispatch_count, 0) > 0 THEN 'live'
    WHEN cg.latest_cap_gate_at IS NOT NULL
         AND COALESCE(ds.open_dispatch_count, 0) = 0
         AND ready.ready_since IS NOT NULL
      THEN 'queued_at_cap'
    WHEN term.terminal_kind = 'task_committed' THEN 'completed'
    WHEN term.terminal_kind IS NULL
         AND COALESCE(ds.dispatched_count, 0) = 0
         AND COALESCE(ds.open_dispatch_count, 0) = 0
         AND cg.latest_cap_gate_at IS NULL
         AND r.root_opened_ts IS NOT NULL
         AND CAST((julianday('now') - julianday(r.root_opened_ts)) * 86400000 AS INTEGER) > 3600000
         AND r.directive_id NOT IN (
           SELECT directive_id FROM events
           WHERE kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
         )
      THEN 'orphan_node'
    WHEN COALESCE(ds.dispatched_count, 0) > 0 THEN 'live'
    ELSE 'live'
  END AS lifecycle_status,
  COALESCE(ds.dispatched_count, 0) AS dispatched_count,
  COALESCE(ds.open_dispatch_count, 0) AS open_dispatch_count,
  ds.dispatch_id,
  ds.dispatch_event_id,
  ds.latest_dispatched_at,
  ds.oldest_open_dispatched_at,
  cs.latest_closed_at,
  cs.close_event_id,
  term.terminal_event_id,
  term.terminal_at,
  term.terminal_kind,
  term.failure_kind,
  -- Bug A fix (2026-05-17): hard-failure terminals carry residual=NULL
  -- because task_failed emitters (e.g. silent_dispatch_quarantine) don't
  -- score a residual; payload.residual is also NULL. Substrate convention
  -- (foundational law from seed.ts: "Verifier code artifacts return a
  -- scalar residual in [0,1]. 0 = goal met; 1 = goal missed.") says a
  -- failed terminal IS residual=1.0. COALESCE so the TUI never shows '?'
  -- for a row whose failure semantics already imply maximal residual.
  -- Soft signals (live/queued/orphan with no terminal) still surface
  -- NULL — the verifier hasn't scored them yet, and 1.0 would be wrong.
  COALESCE(
    term.residual,
    CASE WHEN term.terminal_kind IN ('task_failed', 'dispatcher_violation') THEN 1.0 ELSE NULL END
  ) AS residual,
  cg.latest_cap_gate_at,
  cg.latest_cap_gate_event_id,
  cg.queued_reason,
  cg.cap,
  cg.in_flight_brain,
  ready.ready_since,
  ls.latest_ts AS latest_signal_at,
  ls.latest_ts,
  CAST((julianday('now') - julianday(ls.latest_ts)) * 86400000 AS INTEGER) AS age_ms,
  CASE
    -- Closed-directive straggler parity (2026-05-17 Bug B ext).
    WHEN term.terminal_kind IS NULL
         AND r.directive_id IN (
           SELECT directive_id FROM events
           WHERE kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
         )
      THEN 'directive_closed_straggler'
    -- Bug C parity (2026-05-17): hard-failure terminals win — the
    -- status_reason should name the terminal failure, not the
    -- lingering open dispatch. Pre-fix a task_failed row whose
    -- brain_dispatched lacked a matching close emitted
    -- 'open_dispatch_zombie' as status_reason while lifecycle_status
    -- was 'failed' — internally inconsistent.
    WHEN term.terminal_kind IN ('task_failed', 'dispatcher_violation') THEN term.terminal_kind
    -- In-flight reasons win over a stale terminal: name the running cycle.
    WHEN COALESCE(ds.open_dispatch_count, 0) > 0
         AND ds.oldest_open_dispatched_at IS NOT NULL
         AND CAST((julianday('now') - julianday(ds.oldest_open_dispatched_at)) * 86400000 AS INTEGER) > 300000
      THEN 'open_dispatch_zombie'
    WHEN COALESCE(ds.open_dispatch_count, 0) > 0
         AND term.terminal_kind IS NOT NULL
      THEN 'refinement_dispatch_open'
    WHEN COALESCE(ds.open_dispatch_count, 0) > 0 THEN 'brain_dispatch_open'
    WHEN cg.latest_cap_gate_at IS NOT NULL
         AND COALESCE(ds.open_dispatch_count, 0) = 0
         AND ready.ready_since IS NOT NULL
      THEN COALESCE(cg.queued_reason, 'queued_at_cap')
    WHEN term.terminal_kind IS NOT NULL THEN term.terminal_kind
    -- Bug B parity (2026-05-17): orphan threshold widened to 1h +
    -- closed-directive exclusion (mirrors the status/lifecycle CASEs).
    WHEN term.terminal_kind IS NULL
         AND COALESCE(ds.dispatched_count, 0) = 0
         AND COALESCE(ds.open_dispatch_count, 0) = 0
         AND cg.latest_cap_gate_at IS NULL
         AND r.root_opened_ts IS NOT NULL
         AND CAST((julianday('now') - julianday(r.root_opened_ts)) * 86400000 AS INTEGER) > 3600000
         AND r.directive_id NOT IN (
           SELECT directive_id FROM events
           WHERE kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
         )
      THEN 'orphan_root_no_dispatch'
    WHEN ready.ready_since IS NOT NULL THEN 'ready'
    ELSE COALESCE(ls.latest_signal_reason, 'root_opened')
  END AS status_reason,
  ls.latest_event_id
FROM roots r
LEFT JOIN dispatch_summary ds ON ds.directive_id = r.directive_id AND ds.root_task_id = r.root_task_id
LEFT JOIN close_summary cs ON cs.directive_id = r.directive_id AND cs.root_task_id = r.root_task_id
LEFT JOIN terminal term ON term.directive_id = r.directive_id AND term.root_task_id = r.root_task_id
LEFT JOIN cap_gate cg ON cg.directive_id = r.directive_id AND cg.root_task_id = r.root_task_id
LEFT JOIN ready ON ready.directive_id = r.directive_id AND ready.root_task_id = r.root_task_id
LEFT JOIN latest_signal ls ON ls.directive_id = r.directive_id AND ls.root_task_id = r.root_task_id;
`;

// pending_owner_decision_queue_view — ranked, de-duplicated projection
// of owner-gated proposals the substrate is still waiting on. Sources
// from lesson_implementer_queue_view but applies four corrections that
// the raw queue lacked (see brain design KHA109RW5972D2BZMYQ63HX0F4):
//
//  1. Filter out any source_event_id that has ANY owner_decision_recorded
//     (approve OR decline). The lesson view only tracks approves, so
//     declines silently stayed visible — exactly the bug today.
//  2. Group by (normalized_target, anchor) so 16 variants of the same
//     idea collapse to one ranked row with duplicate_count.
//  3. Score open-ended axes (target_risk / shape_quality / staleness /
//     duplicate weight) and compute decision_rank for ordering.
//  4. Mark malformed proposals (anchor missing / empty after-text /
//     missing diff) with decline_candidate_reason so the operator
//     surface can auto-decline them in one stroke.
const VIEW_PENDING_OWNER_DECISION_QUEUE = `
CREATE VIEW IF NOT EXISTS pending_owner_decision_queue_view AS
WITH base AS (
  SELECT
    q.source_event_id,
    q.ts,
    q.source_kind,
    q.directive_id,
    q.task_id,
    q.target,
    q.anchor,
    q.candidate_diff,
    q.owner_gate_required,
    q.owner_gate_verdict,
    -- 2026-05-17 (k_88ESCTN8XN6J: amendment flywheel doesn't drain).
    -- Live evidence: 1909 lesson_implementer_queue rows, ZERO with
    -- owner_gate_required=1, 975 stuck at apply_gate_status='manual_review'.
    -- The brain never sets owner_consent_required, so the explicit gate
    -- always reads 0; meanwhile auto-apply also refuses these rows
    -- (not_auto_apply_target / blocked_*). They piled up invisible.
    -- Widening the filter to include manual_review surfaces ~173 dedup'd
    -- groups for the operator without touching producer code.
    q.apply_gate_status,
    q.apply_status,
    CASE
      WHEN q.owner_gate_required = 1 THEN 'owner_consent_explicit'
      WHEN q.apply_gate_status = 'manual_review' THEN 'manual_review_implicit'
      ELSE NULL
    END AS gate_source,
    CASE WHEN q.target LIKE 'repo:%' THEN substr(q.target, 6) ELSE q.target END AS normalized_target
  FROM lesson_implementer_queue_view q
  WHERE (q.owner_gate_required = 1 OR q.apply_gate_status = 'manual_review')
    -- Exclude rows that have already produced an apply outcome via any
    -- channel (auto-apply success, refusal, apply_record). The view is
    -- meant for waiting-on-decision rows only.
    AND (q.apply_status IS NULL)
    -- Pre-existing latent bug exposed by the 2026-05-17 widening:
    -- production substrates accumulate occasional candidate_diff
    -- columns that are not strict JSON (legacy seeds, truncated
    -- bridge frames, brain emissions with diff fields containing
    -- raw code). The shape CTE's json_extract(candidate_diff,...)
    -- chains throw "malformed JSON" on those rows and the entire
    -- view errors out — which surfaced in production as the
    -- defensive fallback in pendingOwnerDecisionQueue() (helper
    -- line 3486) returning an empty result. Filter at the source
    -- so the shape CTE never sees a bad candidate_diff. The
    -- excluded rows fall back to "no diff" semantics for
    -- decline_candidate_reason classification — safer than a hard
    -- view failure.
    AND (q.candidate_diff IS NULL OR json_valid(q.candidate_diff) = 1)
    AND NOT EXISTS (
      SELECT 1 FROM events odr
      WHERE odr.kind = 'owner_decision_recorded'
        AND (
          json_extract(odr.payload, '$.source_event_id') = q.source_event_id
          OR EXISTS (SELECT 1 FROM json_each(COALESCE(odr.context_refs, '[]')) WHERE value = q.source_event_id)
        )
    )
),
shape AS (
  SELECT
    b.*,
    CASE
      WHEN b.anchor IS NULL OR length(trim(b.anchor)) = 0 THEN 'anchor_missing'
      WHEN b.candidate_diff IS NULL THEN 'diff_missing'
      WHEN json_extract(b.candidate_diff, '$.kind') = 'anchored_replace_v1'
        AND length(COALESCE(json_extract(b.candidate_diff, '$.after'), '')) = 0 THEN 'empty_after'
      WHEN json_extract(b.candidate_diff, '$.kind') = 'anchored_replace_v1'
        AND length(COALESCE(json_extract(b.candidate_diff, '$.before'), '')) = 0 THEN 'empty_before'
      ELSE NULL
    END AS decline_candidate_reason,
    CASE
      WHEN b.anchor IS NULL OR length(trim(b.anchor)) = 0 THEN 0.0
      WHEN b.candidate_diff IS NULL THEN 0.2
      WHEN json_extract(b.candidate_diff, '$.kind') = 'anchored_replace_v1'
        AND length(COALESCE(json_extract(b.candidate_diff, '$.before'), '')) > 0
        AND length(COALESCE(json_extract(b.candidate_diff, '$.after'), '')) > 0 THEN 1.0
      ELSE 0.5
    END AS shape_quality_score,
    CASE
      WHEN b.normalized_target LIKE '%CLAUDE.md' THEN 1.0
      WHEN b.normalized_target LIKE '%.claude/rules/%' THEN 1.0
      WHEN b.normalized_target = 'docs/v2-design.md' THEN 0.95
      WHEN b.normalized_target = 'docs/operator-install.md' THEN 0.85
      WHEN b.normalized_target = 'docs/ops-guide.md' THEN 0.85
      WHEN b.normalized_target LIKE 'docs/%' THEN 0.65
      WHEN b.normalized_target LIKE 'substrate/%' OR b.normalized_target LIKE 'runtime/%' THEN 0.55
      WHEN b.normalized_target LIKE 'cli/%' THEN 0.5
      ELSE 0.3
    END AS target_risk_score,
    MIN(1.0, MAX(0.0, CAST((julianday('now') - julianday(b.ts)) AS REAL) / 7.0)) AS staleness_score,
    (COALESCE(b.normalized_target, '?') || '|' || COALESCE(b.anchor, '')) AS group_key
  FROM base b
)
SELECT
  s.group_key,
  s.normalized_target AS target,
  s.anchor,
  COUNT(*) AS duplicate_count,
  -- 2026-05-17 widening: surface which path put the row in the queue
  -- (explicit owner gate vs. apply-gate-said-manual-review). The TUI
  -- can render this so the operator sees the provenance at a glance.
  -- If a group has BOTH, prefer 'owner_consent_explicit' as the
  -- stronger signal.
  CASE WHEN SUM(CASE WHEN s.gate_source = 'owner_consent_explicit' THEN 1 ELSE 0 END) > 0
       THEN 'owner_consent_explicit'
       ELSE 'manual_review_implicit'
  END AS gate_source,
  (SELECT s2.source_event_id FROM shape s2
   WHERE s2.group_key = s.group_key
   ORDER BY s2.shape_quality_score DESC, s2.ts DESC
   LIMIT 1) AS representative_event_id,
  MIN(s.ts) AS oldest_ts,
  MAX(s.ts) AS newest_ts,
  MAX(s.shape_quality_score) AS shape_quality_score,
  MAX(s.target_risk_score) AS target_risk_score,
  MAX(s.staleness_score) AS staleness_score,
  CASE WHEN SUM(CASE WHEN s.decline_candidate_reason IS NULL THEN 1 ELSE 0 END) = 0
    THEN MIN(s.decline_candidate_reason)
    ELSE NULL END AS group_decline_reason,
  (MAX(s.target_risk_score) * 0.5
   + MAX(s.shape_quality_score) * 0.3
   + MAX(s.staleness_score) * 0.1
   + MIN(1.0, COUNT(*) * 0.05)) AS decision_rank
FROM shape s
GROUP BY s.group_key, s.normalized_target, s.anchor
ORDER BY decision_rank DESC, MAX(s.ts) DESC;
`;

// pending_owner_decision_queue_live_view — the operator-facing surface.
// 2026-05-19 (KCs YKJYRGVJJX21XAMQS042PMK7JG +
// G3CBVAGY2S5QN5XDC1GR7GJP0G): the historical view above kept piling
// up noise (40+ rows including test-file targets the brain should never
// have routed for owner review, anchor-missing candidates whose diffs
// can't apply, and amendments older than the staleness threshold that
// nobody is going to action). Brain validation REFUSED full removal of
// the historical view (the audit trail for failed amendments still
// matters) and recommended Option B+: keep the historical surface for
// audit, project the operator-facing CLI through this LIVE view that
// EXCLUDES every source_event_id retired by the
// pending_decision_retire_worker (runtime/pending_decision_retire_worker.ts).
//
// The view is otherwise identical to pending_owner_decision_queue_view
// — same ranking, same group key, same dedup. The only difference is the
// exclusion clause for retired source ids. We re-group (rather than
// filtering the outer rows) because a group can have N members, some
// retired and some not; retired members should not contribute to
// duplicate_count, oldest_ts, shape_quality_score, or decision_rank.
const VIEW_PENDING_OWNER_DECISION_QUEUE_LIVE = `
CREATE VIEW IF NOT EXISTS pending_owner_decision_queue_live_view AS
WITH base AS (
  SELECT
    q.source_event_id,
    q.ts,
    q.source_kind,
    q.directive_id,
    q.task_id,
    q.target,
    q.anchor,
    q.candidate_diff,
    q.owner_gate_required,
    q.owner_gate_verdict,
    q.apply_gate_status,
    q.apply_status,
    CASE
      WHEN q.owner_gate_required = 1 THEN 'owner_consent_explicit'
      WHEN q.apply_gate_status = 'manual_review' THEN 'manual_review_implicit'
      ELSE NULL
    END AS gate_source,
    CASE WHEN q.target LIKE 'repo:%' THEN substr(q.target, 6) ELSE q.target END AS normalized_target
  FROM lesson_implementer_queue_view q
  WHERE (q.owner_gate_required = 1 OR q.apply_gate_status = 'manual_review')
    AND (q.apply_status IS NULL)
    AND (q.candidate_diff IS NULL OR json_valid(q.candidate_diff) = 1)
    AND NOT EXISTS (
      SELECT 1 FROM events odr
      WHERE odr.kind = 'owner_decision_recorded'
        AND (
          json_extract(odr.payload, '$.source_event_id') = q.source_event_id
          OR EXISTS (SELECT 1 FROM json_each(COALESCE(odr.context_refs, '[]')) WHERE value = q.source_event_id)
        )
    )
    -- LIVE-view exclusion: drop rows that pending_decision_retire_worker
    -- already retired. The retired source_event_id stays in
    -- pending_owner_decision_queue_view (historical audit) but
    -- disappears from the operator-facing surface here.
    AND NOT EXISTS (
      SELECT 1 FROM events ret
      WHERE ret.kind = 'pending_decision_retired'
        AND json_extract(ret.payload, '$.amendment_event_id') = q.source_event_id
    )
),
shape AS (
  SELECT
    b.*,
    CASE
      WHEN b.anchor IS NULL OR length(trim(b.anchor)) = 0 THEN 'anchor_missing'
      WHEN b.candidate_diff IS NULL THEN 'diff_missing'
      WHEN json_extract(b.candidate_diff, '$.kind') = 'anchored_replace_v1'
        AND length(COALESCE(json_extract(b.candidate_diff, '$.after'), '')) = 0 THEN 'empty_after'
      WHEN json_extract(b.candidate_diff, '$.kind') = 'anchored_replace_v1'
        AND length(COALESCE(json_extract(b.candidate_diff, '$.before'), '')) = 0 THEN 'empty_before'
      ELSE NULL
    END AS decline_candidate_reason,
    CASE
      WHEN b.anchor IS NULL OR length(trim(b.anchor)) = 0 THEN 0.0
      WHEN b.candidate_diff IS NULL THEN 0.2
      WHEN json_extract(b.candidate_diff, '$.kind') = 'anchored_replace_v1'
        AND length(COALESCE(json_extract(b.candidate_diff, '$.before'), '')) > 0
        AND length(COALESCE(json_extract(b.candidate_diff, '$.after'), '')) > 0 THEN 1.0
      ELSE 0.5
    END AS shape_quality_score,
    CASE
      WHEN b.normalized_target LIKE '%CLAUDE.md' THEN 1.0
      WHEN b.normalized_target LIKE '%.claude/rules/%' THEN 1.0
      WHEN b.normalized_target = 'docs/v2-design.md' THEN 0.95
      WHEN b.normalized_target = 'docs/operator-install.md' THEN 0.85
      WHEN b.normalized_target = 'docs/ops-guide.md' THEN 0.85
      WHEN b.normalized_target LIKE 'docs/%' THEN 0.65
      WHEN b.normalized_target LIKE 'substrate/%' OR b.normalized_target LIKE 'runtime/%' THEN 0.55
      WHEN b.normalized_target LIKE 'cli/%' THEN 0.5
      ELSE 0.3
    END AS target_risk_score,
    MIN(1.0, MAX(0.0, CAST((julianday('now') - julianday(b.ts)) AS REAL) / 7.0)) AS staleness_score,
    (COALESCE(b.normalized_target, '?') || '|' || COALESCE(b.anchor, '')) AS group_key
  FROM base b
)
SELECT
  s.group_key,
  s.normalized_target AS target,
  s.anchor,
  COUNT(*) AS duplicate_count,
  CASE WHEN SUM(CASE WHEN s.gate_source = 'owner_consent_explicit' THEN 1 ELSE 0 END) > 0
       THEN 'owner_consent_explicit'
       ELSE 'manual_review_implicit'
  END AS gate_source,
  (SELECT s2.source_event_id FROM shape s2
   WHERE s2.group_key = s.group_key
   ORDER BY s2.shape_quality_score DESC, s2.ts DESC
   LIMIT 1) AS representative_event_id,
  MIN(s.ts) AS oldest_ts,
  MAX(s.ts) AS newest_ts,
  MAX(s.shape_quality_score) AS shape_quality_score,
  MAX(s.target_risk_score) AS target_risk_score,
  MAX(s.staleness_score) AS staleness_score,
  CASE WHEN SUM(CASE WHEN s.decline_candidate_reason IS NULL THEN 1 ELSE 0 END) = 0
    THEN MIN(s.decline_candidate_reason)
    ELSE NULL END AS group_decline_reason,
  (MAX(s.target_risk_score) * 0.5
   + MAX(s.shape_quality_score) * 0.3
   + MAX(s.staleness_score) * 0.1
   + MIN(1.0, COUNT(*) * 0.05)) AS decision_rank
FROM shape s
GROUP BY s.group_key, s.normalized_target, s.anchor
ORDER BY decision_rank DESC, MAX(s.ts) DESC;
`;


// act_projection_observability_view — compact per-source-act projection over
// substrate-derived lifecycle, retrieval, owner outcome, and credit rows.
// Derived rows identify their source act through payload.source_act_id,
// payload.projection.source_act_id, payload.act_tuple.source_act_id, or a
// context_refs citation of the source act id so older projection shapes remain
// observable while idempotency keys converge.
const VIEW_ACT_PROJECTION_OBSERVABILITY = `
CREATE VIEW IF NOT EXISTS act_projection_observability_view AS
  WITH source_ids AS (
    SELECT id AS source_act_id FROM events WHERE kind = 'act_tuple_recorded'
    UNION
    SELECT json_extract(payload, '$.source_act_id') AS source_act_id
    FROM events
    WHERE kind IN ('action_predicted', 'action_scored', 'applied_change_committed', 'owner_observed_outcome_recorded', 'retrieval_binding', 'candidate_confirmed', 'candidate_contradicted', 'act_artifact_score_updated', 'code_artifact_score_updated')
      AND json_extract(payload, '$.source_act_id') IS NOT NULL
    UNION
    SELECT json_extract(payload, '$.projection.source_act_id') AS source_act_id
    FROM events
    WHERE kind IN ('action_predicted', 'action_scored', 'applied_change_committed', 'owner_observed_outcome_recorded', 'retrieval_binding', 'candidate_confirmed', 'candidate_contradicted', 'act_artifact_score_updated', 'code_artifact_score_updated')
      AND json_extract(payload, '$.projection.source_act_id') IS NOT NULL
    UNION
    SELECT json_extract(payload, '$.act_tuple.source_act_id') AS source_act_id
    FROM events
    WHERE kind IN ('action_predicted', 'action_scored', 'applied_change_committed', 'owner_observed_outcome_recorded', 'retrieval_binding', 'candidate_confirmed', 'candidate_contradicted', 'act_artifact_score_updated', 'code_artifact_score_updated')
      AND json_extract(payload, '$.act_tuple.source_act_id') IS NOT NULL
  ),
  src AS (
    SELECT s.source_act_id, a.id AS source_event_id, a.ts AS source_ts,
           a.directive_id, a.task_id, a.payload AS source_payload, a.residual AS source_residual
    FROM source_ids s
    LEFT JOIN events a ON a.id = s.source_act_id AND a.kind = 'act_tuple_recorded'
    WHERE s.source_act_id IS NOT NULL
  )
  SELECT
    s.source_act_id,
    s.source_event_id,
    s.source_ts,
    s.directive_id,
    s.task_id,
    COALESCE((SELECT json_group_array(id) FROM (SELECT e.id FROM events e WHERE e.kind = 'action_predicted' AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id)) ORDER BY e.ts ASC)), '[]') AS action_predicted_event_ids,
    COALESCE((SELECT json_group_array(id) FROM (SELECT e.id FROM events e WHERE e.kind = 'action_scored' AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id)) ORDER BY e.ts ASC)), '[]') AS action_scored_event_ids,
    COALESCE((SELECT json_group_array(id) FROM (SELECT e.id FROM events e WHERE e.kind = 'applied_change_committed' AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id)) ORDER BY e.ts ASC)), '[]') AS applied_change_committed_event_ids,
    COALESCE((SELECT json_group_array(id) FROM (SELECT e.id FROM events e WHERE e.kind = 'owner_observed_outcome_recorded' AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id)) ORDER BY e.ts ASC)), '[]') AS owner_observed_outcome_recorded_event_ids,
    COALESCE((SELECT json_group_array(id) FROM (SELECT e.id FROM events e WHERE e.kind = 'retrieval_binding' AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id)) ORDER BY e.ts ASC)), '[]') AS retrieval_binding_event_ids,
    COALESCE((SELECT json_group_array(id) FROM (SELECT e.id FROM events e WHERE e.kind IN ('candidate_confirmed', 'candidate_contradicted', 'act_artifact_score_updated', 'code_artifact_score_updated') AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id)) ORDER BY e.ts ASC)), '[]') AS credit_projection_event_ids,
    COALESCE(
      (SELECT e.residual FROM events e WHERE e.kind = 'owner_observed_outcome_recorded' AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id)) ORDER BY e.ts DESC LIMIT 1),
      (SELECT e.residual FROM events e WHERE e.kind = 'action_scored' AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id)) ORDER BY e.ts DESC LIMIT 1),
      s.source_residual
    ) AS projection_residual,
    COALESCE(
      (SELECT e.id FROM events e WHERE e.kind = 'owner_observed_outcome_recorded' AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id)) ORDER BY e.ts DESC LIMIT 1),
      (SELECT e.id FROM events e WHERE e.kind = 'action_scored' AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id)) ORDER BY e.ts DESC LIMIT 1),
      CASE WHEN s.source_residual IS NOT NULL THEN s.source_event_id ELSE NULL END
    ) AS projection_residual_event_id,
    COALESCE(
      (SELECT e.kind FROM events e WHERE e.kind = 'owner_observed_outcome_recorded' AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id)) ORDER BY e.ts DESC LIMIT 1),
      (SELECT e.kind FROM events e WHERE e.kind = 'action_scored' AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id)) ORDER BY e.ts DESC LIMIT 1),
      CASE WHEN s.source_residual IS NOT NULL THEN 'act_tuple_recorded' ELSE NULL END
    ) AS projection_residual_kind,
    CASE
      WHEN s.source_event_id IS NULL THEN 'orphaned'
      WHEN EXISTS (SELECT 1 FROM events e WHERE e.kind = 'applied_change_committed' AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id)))
        AND EXISTS (SELECT 1 FROM events e WHERE e.kind = 'action_scored' AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id))) THEN 'completed'
      WHEN EXISTS (SELECT 1 FROM events e WHERE e.kind IN ('action_predicted', 'action_scored', 'applied_change_committed', 'owner_observed_outcome_recorded', 'retrieval_binding', 'candidate_confirmed', 'candidate_contradicted', 'act_artifact_score_updated', 'code_artifact_score_updated') AND (json_extract(e.payload, '$.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.projection.source_act_id') = s.source_act_id OR json_extract(e.payload, '$.act_tuple.source_act_id') = s.source_act_id OR EXISTS (SELECT 1 FROM json_each(e.context_refs) WHERE value = s.source_act_id))) THEN 'partial'
      ELSE 'recorded'
    END AS projection_status
  FROM src s;
`;

// claude_inline_ready_leaves_view — Claude's inbox of ready leaves
// routed to the claude_inline lane.
//
// L3 (2026-05-17 brain design 48SN4XF3WN4KBBCHHCANDRDQRW): "Strategy
// owns topology, not execution authority. It may open children and
// label leaf_affordances in task_node_opened payload, but
// ready_tasks_view remains the only claim surface. Claude_inline is
// still a lane selected by decideDispatch for a ready leaf;
// scheduler continues to emit dispatch_decided + leaves the task
// ready/claimable for Claude."
//
// Today's dispatcher routes some tasks to claude_inline via
// scoreRoutesFromAxes (low_risk_inline_patterns gate). The lane
// signal exists (dispatch_decided.payload.route='claude_inline')
// but there's no consolidated surface Claude can read to see its
// inbox. This view joins ready_tasks_view × dispatch_decided so
// Claude (this terminal) gets a clean list of "tasks the substrate
// expects me to claim and act on" without polling raw events.
//
// Columns:
//   event_id (the dispatch_decided event)
//   ts (dispatch_decided ts)
//   directive_id, task_id, parent_task_id (from ready_tasks_view)
//   goal (from task_node_opened payload)
//   cited_artifact_ids (which low-risk-inline-pattern matched)
//   strategy_shadow_top (top strategy from shadow ranker, if any)
//   routing_axes (the axes the decider used)
//
// Filter: only ROWS THAT ARE STILL READY. A task with a terminal
// event drops from ready_tasks_view via the L4.1 fix, so this view
// also drops it. A task already claimed (task_claimed event) stays
// in the view by design — Claude can see "what's in flight" to
// avoid double-claiming.
const VIEW_CLAUDE_INLINE_READY_LEAVES = `
CREATE VIEW IF NOT EXISTS claude_inline_ready_leaves_view AS
  WITH inline_dispatches AS (
    SELECT
      e.id AS event_id,
      e.ts,
      e.directive_id,
      e.task_id,
      json_extract(e.payload, '$.cited_artifact_ids') AS cited_artifact_ids,
      json_extract(e.payload, '$.routing_axes') AS routing_axes,
      json_extract(e.payload, '$.strategy_shadow_ranks[0].name') AS strategy_shadow_top,
      json_extract(e.payload, '$.strategy_shadow_ranks[0].shadow_score') AS strategy_shadow_top_score,
      ROW_NUMBER() OVER (PARTITION BY e.task_id ORDER BY e.ts DESC) AS rn
    FROM events e
    WHERE e.kind = 'dispatch_decided'
      AND json_extract(e.payload, '$.route') = 'claude_inline'
  ),
  latest_inline AS (
    SELECT * FROM inline_dispatches WHERE rn = 1
  )
  SELECT
    li.event_id AS dispatch_event_id,
    li.ts AS dispatch_ts,
    li.directive_id,
    li.task_id,
    r.parent_task_id,
    json_extract(r.payload, '$.goal') AS goal,
    li.cited_artifact_ids,
    li.routing_axes,
    li.strategy_shadow_top,
    li.strategy_shadow_top_score,
    -- Was the task already claimed by Claude? task_claimed event
    -- (if it exists) marks acquisition. NULL = still claimable.
    (SELECT MAX(c.ts) FROM events c WHERE c.task_id = li.task_id AND c.kind = 'task_claimed') AS claimed_at
  FROM latest_inline li
  JOIN ready_tasks_view r ON r.task_id = li.task_id AND r.directive_id = li.directive_id
  ORDER BY li.ts DESC;
`;

// F11 (2026-05-18, contract 2AMJKN0GTX32790173EPYH6YT4): pending contract
// amendment projection consumed by runtime/contract_amendment_consumer.ts
// and prompt_composer's OUTSTANDING CONTRACT AMENDMENTS section.
//
// A proposal is UNSETTLED when no terminator event cites it. Terminator
// kinds: closure_complete, closure_obsolete, closure_owner_required (the
// lifecycle_closure_sweep verdicts) and applied_change_committed (the
// flywheel completion signal). The view exposes the columns the consumer
// uses to decide route_to_implementation / route_to_clarification /
// supersession / redundancy, plus the latest closure verdict that the
// consumer or brain may already have emitted in a prior tick.
//
// supersession_state values:
//   'live'         — no newer contract_amendment_proposed on the same
//                    target_resource exists.
//   'superseded_by'— a newer proposal exists for the same
//                    target_resource (newer_proposal_id is set).
const VIEW_PENDING_CONTRACT_AMENDMENTS = `
CREATE VIEW IF NOT EXISTS pending_contract_amendments_view AS
  WITH proposals AS (
    SELECT
      e.id            AS proposal_id,
      e.ts            AS ts,
      e.directive_id  AS directive_id,
      e.task_id       AS task_id,
      e.payload       AS payload,
      e.context_refs  AS context_refs,
      COALESCE(
        json_extract(e.payload, '$.target_resource'),
        json_extract(e.payload, '$.resource_uri'),
        json_extract(e.payload, '$.proposed_behavior.target_resource'),
        json_extract(e.payload, '$.proposed_behavior.resource_uri')
      ) AS target_resource,
      json_extract(e.payload, '$.proposed_behavior.predicate')   AS predicate,
      json_extract(e.payload, '$.proposed_behavior.target_files') AS target_files,
      json_extract(e.payload, '$.proposed_behavior.dependencies') AS dependencies
    FROM events e
    WHERE e.kind = 'contract_amendment_proposed'
  ),
  supersession AS (
    SELECT
      p.proposal_id,
      (
        SELECT q.proposal_id FROM proposals q
        WHERE q.target_resource = p.target_resource
          AND q.target_resource IS NOT NULL
          AND length(trim(q.target_resource)) > 0
          AND q.ts > p.ts
          -- 2026-05-21 supersession-scope fix: supersession is per-DIRECTIVE,
          -- not global per target_resource. Pre-fix, when two DIFFERENT
          -- directives proposed amendments to the SAME file (routine — many
          -- S0 sub-predicates each edit cli/apply.ts / substrate/seed.ts),
          -- the later directive's amendment falsely marked the earlier
          -- directive's as 'superseded_by'. The earlier directive's
          -- legitimate, independent edit then looked stale ('file does not
          -- exist' / skipped) even though it targeted its own concern. A
          -- newer proposal only supersedes a prior one when it is the SAME
          -- directive re-emitting (brain refinement rounds) for the SAME
          -- target — that is the true supersession. Cross-directive edits to
          -- a shared file are INDEPENDENT, not supersessions.
          AND q.directive_id = p.directive_id
        ORDER BY q.ts ASC
        LIMIT 1
      ) AS newer_proposal_id
    FROM proposals p
  ),
  dependency_items AS (
    SELECT
      p.proposal_id,
      d.key AS dependency_key,
      CASE
        WHEN d.type = 'text' THEN d.value
        WHEN d.type = 'object' THEN json_extract(d.value, '$.event_id')
        ELSE NULL
      END AS dependency_event_id
    FROM proposals p
    LEFT JOIN json_each(
      CASE
        WHEN p.dependencies IS NOT NULL AND json_valid(p.dependencies) THEN p.dependencies
        ELSE '[]'
      END
    ) d
  ),
  dependency_status AS (
    SELECT
      p.proposal_id,
      COALESCE(COUNT(di.dependency_key), 0) AS dependency_count,
      COALESCE(SUM(
        CASE
          WHEN di.dependency_key IS NULL THEN 0
          WHEN di.dependency_event_id IS NULL THEN 1
          WHEN EXISTS (
            SELECT 1 FROM events c
            WHERE c.kind IN ('closure_complete', 'applied_change_committed')
              AND (c.id = di.dependency_event_id OR c.context_refs LIKE '%' || di.dependency_event_id || '%')
          ) THEN 0
          ELSE 1
        END
      ), 0) AS open_dependency_count
    FROM proposals p
    LEFT JOIN dependency_items di ON di.proposal_id = p.proposal_id
    GROUP BY p.proposal_id
  ),
  latest_verdict AS (
    SELECT
      p.proposal_id,
      (
        SELECT t.kind FROM events t
        WHERE t.kind IN ('closure_complete', 'closure_obsolete', 'closure_owner_required')
          AND t.context_refs LIKE '%' || p.proposal_id || '%'
        ORDER BY t.ts DESC
        LIMIT 1
      ) AS latest_closure_verdict,
      (
        SELECT t.id FROM events t
        WHERE t.kind IN ('closure_complete', 'closure_obsolete', 'closure_owner_required')
          AND t.context_refs LIKE '%' || p.proposal_id || '%'
        ORDER BY t.ts DESC
        LIMIT 1
      ) AS latest_closure_event_id,
      EXISTS (
        SELECT 1 FROM events a
        WHERE a.kind = 'applied_change_committed'
          AND a.context_refs LIKE '%' || p.proposal_id || '%'
      ) AS has_applied_change
    FROM proposals p
  ),
  enriched AS (
    SELECT
      p.proposal_id,
      p.ts,
      p.directive_id,
      p.task_id,
      p.target_resource,
      p.predicate,
      p.target_files,
      p.dependencies,
      p.payload,
      p.context_refs,
      CAST((julianday('now') - julianday(p.ts)) * 86400000 AS INTEGER) AS age_ms,
      CASE
        WHEN s.newer_proposal_id IS NOT NULL THEN 'superseded_by'
        ELSE 'live'
      END AS supersession_state,
      s.newer_proposal_id,
      ds.dependency_count,
      ds.open_dependency_count,
      CASE
        WHEN p.predicate IS NULL OR length(trim(p.predicate)) = 0 THEN 1
        ELSE 0
      END AS missing_predicate,
      CASE
        WHEN p.target_files IS NULL OR NOT json_valid(p.target_files) OR json_array_length(p.target_files) = 0 THEN 1
        ELSE 0
      END AS missing_target_files,
      lv.latest_closure_verdict,
      lv.latest_closure_event_id,
      lv.has_applied_change,
      (
        SELECT s.id FROM events s
        WHERE s.kind = 'action_scored'
          AND s.context_refs LIKE '%' || p.proposal_id || '%'
          AND json_extract(s.payload, '$.residual') IS NOT NULL
        ORDER BY s.ts DESC
        LIMIT 1
      ) AS latest_action_scored_event_id,
      (
        SELECT CAST(json_extract(s.payload, '$.residual') AS REAL) FROM events s
        WHERE s.kind = 'action_scored'
          AND s.context_refs LIKE '%' || p.proposal_id || '%'
          AND json_extract(s.payload, '$.residual') IS NOT NULL
        ORDER BY s.ts DESC
        LIMIT 1
      ) AS latest_action_residual
    FROM proposals p
    JOIN supersession s ON s.proposal_id = p.proposal_id
    JOIN dependency_status ds ON ds.proposal_id = p.proposal_id
    JOIN latest_verdict lv ON lv.proposal_id = p.proposal_id
    WHERE lv.latest_closure_verdict IS NULL
      AND lv.has_applied_change = 0
  ),
  triaged AS (
    SELECT
      e.*,
      '[]' AS missing_fields,
      CASE
        WHEN e.supersession_state = 'superseded_by' THEN 'closure_obsolete_supersession'
        WHEN e.open_dependency_count > 0 THEN 'blocked_by_dependencies'
        WHEN e.latest_action_residual IS NULL THEN 'unscored'
        WHEN e.latest_action_residual < 0.3 THEN 'ready_for_implementation'
        ELSE 'blocked_by_residual'
      END AS triage_state,
      CASE
        WHEN e.supersession_state = 'superseded_by' THEN 'newer proposal exists for same target_resource'
        WHEN e.open_dependency_count > 0 THEN 'declared dependencies are not yet closed'
        WHEN e.latest_action_residual IS NULL THEN 'proposal has not yet been scored by action_scored residual evidence'
        WHEN e.latest_action_residual < 0.3 THEN 'latest verifier residual is below implementation threshold'
        ELSE 'latest verifier residual is too high for implementation'
      END AS triage_reason,
      CASE
        WHEN e.supersession_state = 'superseded_by' THEN 90
        WHEN e.open_dependency_count = 0 AND e.latest_action_residual IS NOT NULL AND e.latest_action_residual < 0.3 THEN 100
        WHEN e.latest_action_residual IS NULL THEN 55
        WHEN e.open_dependency_count > 0 THEN 40
        ELSE 30
      END AS selection_priority
    FROM enriched e
  )
  SELECT
    t.proposal_id,
    t.ts,
    t.directive_id,
    t.task_id,
    t.target_resource,
    t.predicate,
    t.target_files,
    t.dependencies,
    t.payload,
    t.context_refs,
    t.age_ms,
    t.supersession_state,
    t.newer_proposal_id,
    t.dependency_count,
    t.open_dependency_count,
    CASE WHEN t.open_dependency_count = 0 THEN 1 ELSE 0 END AS dependencies_closed,
    t.missing_fields,
    t.triage_state,
    t.triage_reason,
    t.selection_priority,
    ROW_NUMBER() OVER (ORDER BY t.selection_priority DESC, t.ts ASC, t.proposal_id ASC) AS selection_rank,
    t.latest_closure_verdict,
    t.latest_closure_event_id,
    t.has_applied_change,
    t.latest_action_scored_event_id,
    t.latest_action_residual
  FROM triaged t
  ORDER BY selection_rank ASC;
`;

// substrate_narrative_recent_view — the TUI's load-bearing primitive.
//
// Brain design D9TBCHADS97DHAMNBC686HE3P0 (residual 0.16, 2026-05-17):
// "substrate_narrative_recent_view: event_id, ts, kind, directive_id,
//  task_id, importance, lane, one-line human_summary, detail_text,
//  primary_content, residual, lifecycle_status, route, cited_refs, raw
//  payload pointer." Replaces the IDs-only display problem named in the
//  owner frustration text (XR3REA7Q7X197AASRH3QXNFF84): "we see a lot
//  of IDs without actual knowledge what happened, we need dramatically
//  better understanding of SUBSTRATE in realtime without complexity,
//  we need content and whats happened and how."
//
// Per-kind content extraction maps each event to its canonical
// operator-readable text. The vocabulary IS the EVENT_KINDS registry's
// content fields:
//   knowledge_candidate         → payload.claim
//   lesson_extracted            → payload.summary
//   claude_reasoning_recorded   → payload.summary
//   directive_opened            → payload.directive_text
//   directive_amended           → payload.amendment_text / .summary
//   owner_input_received        → payload.text
//   owner_observed_outcome_recorded → payload.text / .observed_residual
//   task_node_opened            → payload.goal
//   task_committed              → payload.summary
//   task_failed                 → payload.reason / failure_kind
//   act_tuple_recorded          → payload.intent
//   contract_amendment_proposed → payload.current_behavior → proposed_behavior
//   pre_apply_adjudication_recorded → payload.verdict + payload.reason
//   dispatch_decided            → payload.route + payload.reason
//   bridge_failed               → payload.reason + payload.hint
//   runtime_self_diagnostic_recorded → payload.runtime + .fault_kind + .repair_hint
//   brain_message_emitted       → payload.text (truncated)
//   owner_decision_recorded     → payload.decision + .target_event_id
//   constitutional_gate_decision → payload.gate + .reason
//
// Anything not in the map gets a fallback shape (kind + a short payload
// preview). The view ALWAYS returns the raw payload too so the
// drilldown surface can show the full record without a second query.
//
// importance: derived from event_kind metadata + payload signal:
//   'critical' — task_failed, bridge_failed, dispatcher_violation,
//                 owner_input_required, hidl_action_required
//   'high'     — task_committed, directive_opened, contract_amendment_proposed,
//                 pre_apply_adjudication_recorded, owner_observed_outcome_recorded
//   'medium'   — knowledge_candidate, lesson_extracted, dispatch_decided,
//                 act_tuple_recorded, runtime_self_diagnostic_recorded
//   'low'      — everything else (heartbeats, projections, edges)
const VIEW_SUBSTRATE_NARRATIVE_RECENT = `
CREATE VIEW IF NOT EXISTS substrate_narrative_recent_view AS
  SELECT
    e.id           AS event_id,
    e.ts           AS ts,
    e.kind         AS kind,
    e.directive_id AS directive_id,
    e.task_id      AS task_id,
    e.substrate_origin AS substrate_origin,
    CASE
      -- Hot-reload failures are operational, not safety-critical. The
      -- reason 'full_restart_required' is a NORMAL signal (manifest
      -- correctly classified the module as needing restart, not a
      -- failure). Historical evidence: 131 of 153 daemon_hotreload_failed
      -- rows in production had this reason — they were emitted by the
      -- pre-2026-05-17 worker before the dedicated restart_pending
      -- event existed. Classify them as 'medium' so they're discoverable
      -- but don't dominate the TUI's critical badge.
      WHEN e.kind = 'daemon_hotreload_failed'
           AND json_extract(e.payload, '$.reason') = 'full_restart_required' THEN 'medium'
      WHEN e.kind = 'daemon_hotreload_failed' THEN 'high'
      WHEN e.kind IN ('task_failed','bridge_failed','dispatcher_violation','owner_input_required','hidl_action_required','brain_failed','daemon_hotreload_rejected') THEN 'critical'
      WHEN e.kind IN ('task_committed','directive_opened','directive_amended','contract_amendment_proposed','pre_apply_adjudication_recorded','owner_observed_outcome_recorded','applied_change_committed','applied_change_failed','task_closure_audited','owner_decision_recorded') THEN 'high'
      WHEN e.kind IN ('knowledge_candidate','lesson_extracted','claude_reasoning_recorded','dispatch_decided','act_tuple_recorded','runtime_self_diagnostic_recorded','owner_insight_candidate','brain_message_emitted','knowledge_promoted','act_artifact_promoted', 'code_artifact_promoted') THEN 'medium'
      ELSE 'low'
    END AS importance,
    -- One-line human-readable summary per kind. The CASE order matters:
    -- earlier branches take precedence when a kind matches multiple
    -- content fields (rare; see fallback at the end).
    CASE
      WHEN e.kind = 'knowledge_candidate'         THEN json_extract(e.payload, '$.claim')
      WHEN e.kind = 'lesson_extracted'            THEN json_extract(e.payload, '$.summary')
      WHEN e.kind = 'claude_reasoning_recorded'   THEN json_extract(e.payload, '$.summary')
      WHEN e.kind = 'directive_opened'            THEN json_extract(e.payload, '$.directive_text')
      WHEN e.kind = 'directive_amended'           THEN COALESCE(json_extract(e.payload, '$.amendment_text'), json_extract(e.payload, '$.summary'))
      WHEN e.kind = 'owner_input_received'        THEN json_extract(e.payload, '$.text')
      WHEN e.kind = 'owner_observed_outcome_recorded' THEN COALESCE(json_extract(e.payload, '$.text'), json_extract(e.payload, '$.observation'))
      WHEN e.kind = 'task_node_opened'            THEN json_extract(e.payload, '$.goal')
      WHEN e.kind = 'task_committed'              THEN json_extract(e.payload, '$.summary')
      WHEN e.kind = 'task_failed'                 THEN COALESCE(json_extract(e.payload, '$.reason'), e.failure_kind)
      -- dispatcher_violation events carry their content under
      -- 'failure_kind' + 'failed_checks' (not 'reason'). Pre-fix the
      -- narrative line was blank for the 13 production rows.
      WHEN e.kind = 'dispatcher_violation' THEN COALESCE(
        json_extract(e.payload, '$.failure_kind'),
        json_extract(e.payload, '$.reason'),
        e.failure_kind,
        'dispatcher_violation'
      )
      WHEN e.kind = 'act_tuple_recorded'          THEN json_extract(e.payload, '$.intent')
      WHEN e.kind = 'contract_amendment_proposed' THEN json_extract(e.payload, '$.current_behavior')
      WHEN e.kind = 'pre_apply_adjudication_recorded' THEN json_extract(e.payload, '$.verdict')
      WHEN e.kind = 'dispatch_decided'            THEN ('route=' || json_extract(e.payload, '$.route') || '; ' || COALESCE(json_extract(e.payload, '$.reason'), ''))
      WHEN e.kind = 'bridge_failed'               THEN ('reason=' || COALESCE(json_extract(e.payload, '$.reason'), '?') || '; ' || COALESCE(json_extract(e.payload, '$.hint'), ''))
      WHEN e.kind = 'runtime_self_diagnostic_recorded' THEN (json_extract(e.payload, '$.runtime') || ' ' || json_extract(e.payload, '$.fault_kind') || COALESCE('; ' || json_extract(e.payload, '$.repair_hint'), ''))
      WHEN e.kind = 'daemon_hotreload_failed' THEN ('module=' || COALESCE(json_extract(e.payload, '$.module'), '?') || '; file=' || COALESCE(json_extract(e.payload, '$.file_path'), '?') || '; reason=' || COALESCE(json_extract(e.payload, '$.reason'), '?'))
      WHEN e.kind = 'daemon_hotreload_rejected' THEN ('module=' || COALESCE(json_extract(e.payload, '$.module'), '?') || '; reason=' || COALESCE(json_extract(e.payload, '$.reason'), '?'))
      WHEN e.kind = 'daemon_hotreload_unmapped' THEN ('file=' || COALESCE(json_extract(e.payload, '$.file_path'), '?') || '; ' || COALESCE(json_extract(e.payload, '$.hint'), 'add manifest entry'))
      WHEN e.kind = 'brain_message_emitted'       THEN json_extract(e.payload, '$.text')
      WHEN e.kind = 'owner_decision_recorded'     THEN ('decision=' || COALESCE(json_extract(e.payload, '$.decision'), '?') || ' on ' || COALESCE(json_extract(e.payload, '$.target_event_id'), json_extract(e.payload, '$.source_event_id'), '?') || COALESCE(' [' || json_extract(e.payload, '$.reason') || ']', ''))
      WHEN e.kind = 'constitutional_gate_decision' THEN ('gate=' || COALESCE(json_extract(e.payload, '$.gate'), '?') || '; ' || COALESCE(json_extract(e.payload, '$.reason'), ''))
      WHEN e.kind = 'task_closure_audited'        THEN ('closure_residual=' || COALESCE(json_extract(e.payload, '$.closure_residual'), '?') || '; ' || COALESCE(json_extract(e.payload, '$.summary'), ''))
      WHEN e.kind = 'applied_change_committed'    THEN COALESCE(json_extract(e.payload, '$.summary'), 'applied change')
      WHEN e.kind = 'applied_change_failed'       THEN ('reason=' || COALESCE(json_extract(e.payload, '$.reason'), '?'))
      WHEN e.kind = 'owner_input_required'        THEN COALESCE(json_extract(e.payload, '$.prompt'), json_extract(e.payload, '$.question'))
      WHEN e.kind = 'hidl_action_required'        THEN COALESCE(json_extract(e.payload, '$.action'), json_extract(e.payload, '$.prompt'))
      -- 2026-05-17 owner-visible rendering loop (brain contract
      -- Q471RAN88X0H513V8BC3BTW0AW). Show the actual rendered owner-visible
      -- text in the narrative stream; feedback rows display the feedback_kind
      -- + observed_behavior so the operator can audit whether the policy is
      -- learning the right signals.
      WHEN e.kind = 'rendered_owner_message_recorded' THEN COALESCE(
        '[' || COALESCE(json_extract(e.payload, '$.audience'), 'primary') || '/' || COALESCE(json_extract(e.payload, '$.surface'), '?') || '] ' || json_extract(e.payload, '$.rendered_text'),
        json_extract(e.payload, '$.rendered_text')
      )
      WHEN e.kind = 'owner_rendering_feedback_recorded' THEN (
        'feedback=' || COALESCE(json_extract(e.payload, '$.feedback_kind'), '?')
        || COALESCE(' on=' || json_extract(e.payload, '$.source_rendered_event_id'), '')
        || COALESCE(' — ' || json_extract(e.payload, '$.observed_behavior'), '')
        || COALESCE(' (' || json_extract(e.payload, '$.evidence') || ')', '')
      )
      -- 2026-05-18 owner world-model evidence layer (brain contract
      -- CY7E62DSNX1DZ1BTD56845D994). Surface the most decision-relevant
      -- axes (emotional register + attention + larger goal) inline; the
      -- full latent_state is in the drilldown payload.
      WHEN e.kind = 'owner_state_hypothesis_recorded' THEN (
        'belief: '
        || COALESCE(json_extract(e.payload, '$.latent_state.emotional_register'), '?reg')
        || ' / '
        || COALESCE(json_extract(e.payload, '$.latent_state.attention_budget'), '?att')
        || COALESCE(' / goal=' || json_extract(e.payload, '$.latent_state.latent_larger_goal'), '')
        || COALESCE(' (uncertainty=' || json_extract(e.payload, '$.uncertainty') || ')', '')
      )
      WHEN e.kind = 'owner_state_prediction_error_recorded' THEN (
        'prediction_error on hypothesis=' || COALESCE(json_extract(e.payload, '$.hypothesis_event_id'), '?')
        || COALESCE(': ' || json_extract(e.payload, '$.observed_signal'), '')
      )
      WHEN e.kind = 'alignment_action_selected' THEN (
        'action=' || COALESCE(json_extract(e.payload, '$.action_kind'), '?')
        || COALESCE(' — ' || json_extract(e.payload, '$.rationale'), '')
      )
      ELSE NULL
    END AS human_summary,
    -- residual is most useful for ranked entries (action_scored,
    -- task_closure_audited, owner_observed_outcome_recorded). Surface
    -- both the row's own residual column AND any payload-embedded
    -- residual; consumers read whichever is non-null.
    COALESCE(
      e.residual,
      CAST(json_extract(e.payload, '$.residual') AS REAL),
      CAST(json_extract(e.payload, '$.closure_residual') AS REAL),
      CAST(json_extract(e.payload, '$.observed_residual') AS REAL),
      CAST(json_extract(e.payload, '$.predicted_residual') AS REAL)
    ) AS residual,
    -- Lane (dispatch route) is informational metadata for dispatch_decided rows.
    json_extract(e.payload, '$.route') AS route,
    -- Cited refs for the drilldown.
    e.context_refs AS cited_refs,
    -- Raw payload pointer so the drilldown surface can render the full
    -- record without a second query. The TUI should truncate to a
    -- reasonable display size client-side.
    e.payload AS payload
  FROM events e
  ORDER BY e.ts DESC;
`;

// directive_view — per-directive top-level synthesis per v2-design.md §4.2
// line 589: "root + status + lifecycle + urgency." One row per
// `directive_opened` event, joined with the root task's terminal event
// (task_committed / task_failed / task_abandoned) to expose status.
// `status` is NULL when the directive is still live; otherwise the
// terminal kind. Lifecycle + urgency are read from the opening payload
// (defaults: lifecycle='finite', urgency='normal').
const VIEW_DIRECTIVE = `
CREATE VIEW IF NOT EXISTS directive_view AS
  WITH directive_opens AS (
    SELECT
      directive_id,
      id                                                              AS directive_event_id,
      ts                                                              AS opened_ts,
      json_extract(payload, '$.directive_text')                       AS directive_text,
      COALESCE(json_extract(payload, '$.lifecycle'),       'finite')  AS lifecycle,
      COALESCE(json_extract(payload, '$.urgency'),         'normal')  AS urgency
    FROM events
    WHERE kind = 'directive_opened'
  ),
  roots AS (
    SELECT
      directive_id,
      task_id                                                         AS root_task_id,
      MIN(ts)                                                         AS root_opened_ts
    FROM events
    WHERE kind = 'task_node_opened'
      AND (parent_task_id IS NULL OR parent_task_id = '')
    GROUP BY directive_id, task_id
  ),
  root_terminals AS (
    -- Terminal kinds match the canonical ready_tasks_view list (line ~100):
    -- task_committed_superseded fires when amendment_handler supersedes a
    -- task; task_blocked fires when the brain emits a hard-block. Both
    -- must be treated as terminal so directive_view doesn't show
    -- effectively-terminal roots as still-live. Per KC TPRM3KAH8H57.
    SELECT
      directive_id,
      task_id,
      kind                                                            AS terminal_kind,
      ts                                                              AS terminal_ts
    FROM events
    WHERE kind IN (
      'task_committed', 'task_failed', 'task_abandoned',
      'task_committed_superseded', 'task_blocked'
    )
  )
  SELECT
    d.directive_id,
    d.directive_event_id,
    d.opened_ts,
    d.directive_text,
    d.lifecycle,
    d.urgency,
    r.root_task_id,
    r.root_opened_ts,
    t.terminal_kind                                                   AS status,
    t.terminal_ts                                                     AS status_ts
  FROM directive_opens d
  LEFT JOIN roots r          ON r.directive_id = d.directive_id
  LEFT JOIN root_terminals t ON t.directive_id = d.directive_id AND t.task_id = r.root_task_id;
`;

// task_critical_path_view — per-directive longest dependency chain
// through `requires` edges per v2-design.md §4.2 line 592. The chain is
// computed by walking edges backward from each task_node_opened (depth
// 0 = task with no outgoing 'requires' edge depending on it). Returns
// one row per directive carrying the max depth and the path string
// `taskA->taskB->...->root`. Refinement edges (kind='refines') are NOT
// part of the critical path — they represent re-decomposition, not
// causal dependency.
const VIEW_TASK_CRITICAL_PATH = `
CREATE VIEW IF NOT EXISTS task_critical_path_view AS
  WITH RECURSIVE edges AS (
    SELECT
      directive_id,
      COALESCE(json_extract(payload, '$.from_task'), json_extract(payload, '$.from')) AS from_task,
      COALESCE(json_extract(payload, '$.to_task'),   json_extract(payload, '$.to'))   AS to_task,
      json_extract(payload, '$.kind')                                                  AS edge_kind
    FROM events
    WHERE kind = 'task_edge_recorded'
  ),
  -- Leaf tasks: opened tasks that are NOT the from_task of any
  -- requires edge (i.e., nothing depends on them).
  leaves AS (
    SELECT n.directive_id, n.task_id
    FROM events n
    WHERE n.kind = 'task_node_opened'
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE e.edge_kind = 'requires'
          AND e.from_task = n.task_id
          AND e.directive_id = n.directive_id
      )
  ),
  chain(directive_id, task_id, depth, path) AS (
    SELECT directive_id, task_id, 0, task_id FROM leaves
    UNION ALL
    SELECT
      e.directive_id,
      e.from_task                       AS task_id,
      c.depth + 1                       AS depth,
      e.from_task || '->' || c.path     AS path
    FROM edges e
    JOIN chain c ON e.to_task = c.task_id AND e.edge_kind = 'requires' AND e.directive_id = c.directive_id
    WHERE c.depth < 50  -- defensive cycle/runaway guard
  ),
  ranked AS (
    SELECT directive_id, depth, path,
           ROW_NUMBER() OVER (PARTITION BY directive_id ORDER BY depth DESC, length(path) DESC) AS rk
    FROM chain
  )
  SELECT directive_id, depth AS critical_path_length, path
  FROM ranked
  WHERE rk = 1;
`;

// active_inference_view — residual statistics per substrate_origin and
// action_artifact_id per v2-design.md §4.2 line 595 ("residual stats
// per task-kind, substrate_origin"). Pulls residual from action_scored
// payloads; action_artifact_id stands in for "task-kind" (the
// open-vocabulary discriminator of what the act DID). The view is
// idempotent — repeated reads yield the same shape; no state mutation.
const VIEW_ACTIVE_INFERENCE = `
CREATE VIEW IF NOT EXISTS active_inference_view AS
  WITH scored AS (
    SELECT
      substrate_origin,
      COALESCE(action_artifact_id, json_extract(payload, '$.action_artifact_id')) AS action_artifact_id,
      CAST(COALESCE(json_extract(payload, '$.residual'), json_extract(payload, '$.observed_residual')) AS REAL) AS residual,
      ts
    FROM events
    WHERE kind = 'action_scored'
  )
  SELECT
    substrate_origin,
    action_artifact_id,
    COUNT(*)                                                          AS scored_count,
    AVG(residual)                                                      AS avg_residual,
    MIN(residual)                                                      AS min_residual,
    MAX(residual)                                                      AS max_residual,
    MAX(ts)                                                            AS latest_ts
  FROM scored
  WHERE residual IS NOT NULL
  GROUP BY substrate_origin, action_artifact_id;
`;

// artifact_warning_view — quarantined / retired act_artifact rows with
// rehabilitation eligibility per v2-design.md §4.2 line 597. The 14-day
// cooldown mirrors `runtime/recipe_inertia.ts` (RECIPE_INERTIA_DECAY_DAYS
// = 14); a quarantined artifact whose updated_at sits inside the cooldown
// is `cooldown` (rehab worker will skip it); past cooldown it becomes
// `eligible` (rehab worker may probe). Retired artifacts are
// permanently `retired_terminal` — no rehabilitation path exists for
// retired status (substrate-truth: retired is the only terminal status
// for chronically-failing artifacts).
const VIEW_ARTIFACT_WARNING = `
CREATE VIEW IF NOT EXISTS artifact_warning_view AS
  SELECT
    a.id                                                                AS artifact_id,
    a.runtime,
    a.kind                                                              AS artifact_kind,
    a.name,
    a.status,
    a.recent_kill_count,
    a.recent_residual_mean,
    a.score,
    a.confidence,
    a.updated_at                                                        AS status_at_ts,
    CASE
      WHEN a.status = 'quarantined' THEN datetime(a.updated_at, '+14 days')
      ELSE NULL
    END                                                                 AS rehabilitation_eligible_at,
    CASE
      WHEN a.status = 'retired'                                        THEN 'retired_terminal'
      WHEN a.status = 'quarantined'
        AND datetime('now') >= datetime(a.updated_at, '+14 days')      THEN 'eligible'
      WHEN a.status = 'quarantined'                                    THEN 'cooldown'
      ELSE                                                                  'na'
    END                                                                 AS eligibility_status
  FROM act_artifact a
  WHERE a.status IN ('quarantined', 'retired')
  ORDER BY a.updated_at DESC;
`;

// model_routing_view — brain-model dispatch outcome counts per
// (model, terminal_kind) per v2-design.md §4.2 line 598 ("{sub_task_kind,
// model} success rates"). The "sub_task_kind" axis here is the brain
// dispatch's terminal_kind (task_committed / task_failed / dispatcher_violation);
// "model" is read from brain_dispatched.payload.model (e.g., "openai/gpt-5.5").
// Rows where brain_dispatched fired but no terminal landed yet are
// summarised with terminal_kind = NULL so callers can compute open-rate
// vs success-rate separately.
const VIEW_MODEL_ROUTING = `
CREATE VIEW IF NOT EXISTS model_routing_view AS
  WITH dispatches AS (
    SELECT
      COALESCE(json_extract(payload, '$.model'), '<unknown>') AS model,
      directive_id,
      task_id,
      ts                                                       AS dispatched_ts
    FROM events
    WHERE kind = 'brain_dispatched'
      AND task_id IS NOT NULL
  ),
  outcomes AS (
    -- Brain-dispatch outcome view: include superseded+blocked terminal
    -- kinds (per KC TPRM3KAH8H57) so dashboards don't count
    -- effectively-terminal dispatches as "<open>" forever.
    SELECT
      directive_id,
      task_id,
      kind                                                     AS terminal_kind,
      MIN(ts)                                                  AS terminal_ts
    FROM events
    WHERE kind IN (
      'task_committed', 'task_failed', 'task_abandoned', 'dispatcher_violation',
      'task_committed_superseded', 'task_blocked'
    )
    GROUP BY directive_id, task_id, kind
  )
  SELECT
    d.model,
    COALESCE(o.terminal_kind, '<open>')                        AS terminal_kind,
    COUNT(*)                                                    AS n,
    MAX(d.dispatched_ts)                                        AS latest_dispatched_ts,
    MAX(o.terminal_ts)                                          AS latest_terminal_ts
  FROM dispatches d
  LEFT JOIN outcomes o ON o.directive_id = d.directive_id AND o.task_id = d.task_id
  GROUP BY d.model, COALESCE(o.terminal_kind, '<open>');
`;

// peer_registry_view — latest registered peer identity plus latest heartbeat.
// Tier U/U1 keeps spawning asymmetric (substrate can spawn opencode only) but
// participation symmetric: opencode brains, Claude terminals, and Claude
// background agents all register and appear in one depth-1 awareness surface.
const VIEW_PEER_REGISTRY = `
CREATE VIEW IF NOT EXISTS peer_registry_view AS
  WITH registration_rows AS (
    SELECT
      id                                                                 AS registration_event_id,
      ts                                                                 AS registered_ts,
      COALESCE(json_extract(payload, '$.peer_id'), json_extract(payload, '$.id')) AS peer_id,
      json_extract(payload, '$.kind')                                    AS peer_kind,
      json_extract(payload, '$.spawnability')                            AS spawnability,
      COALESCE(json_extract(payload, '$.scope'), '{}')                   AS scope,
      json_extract(payload, '$.git_head')                                AS git_head,
      COALESCE(directive_id, json_extract(payload, '$.directive_id'))     AS directive_id,
      COALESCE(task_id, json_extract(payload, '$.task_id'))               AS task_id,
      json_extract(payload, '$.current_act_id')                          AS current_act_id,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(json_extract(payload, '$.peer_id'), json_extract(payload, '$.id'))
        ORDER BY ts DESC, id DESC
      )                                                                  AS rn
    FROM events
    WHERE kind = 'peer_registered'
      AND COALESCE(json_extract(payload, '$.peer_id'), json_extract(payload, '$.id')) IS NOT NULL
  ),
  activity_rows AS (
    SELECT
      id                                                                 AS activity_event_id,
      ts                                                                 AS last_seen_ts,
      COALESCE(json_extract(payload, '$.peer_id'), json_extract(payload, '$.id')) AS peer_id,
      json_extract(payload, '$.kind')                                    AS peer_kind,
      json_extract(payload, '$.spawnability')                            AS spawnability,
      COALESCE(json_extract(payload, '$.scope'), '{}')                   AS scope,
      json_extract(payload, '$.git_head')                                AS git_head,
      COALESCE(directive_id, json_extract(payload, '$.directive_id'))     AS directive_id,
      COALESCE(task_id, json_extract(payload, '$.task_id'))               AS task_id,
      json_extract(payload, '$.current_act_id')                          AS current_act_id,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(json_extract(payload, '$.peer_id'), json_extract(payload, '$.id'))
        ORDER BY ts DESC, id DESC
      )                                                                  AS rn
    FROM events
    WHERE kind IN ('peer_registered', 'peer_liveness')
      AND COALESCE(json_extract(payload, '$.peer_id'), json_extract(payload, '$.id')) IS NOT NULL
  )
  SELECT
    r.peer_id                                                            AS peer_id,
    COALESCE(a.peer_kind, r.peer_kind)                                   AS kind,
    COALESCE(a.spawnability, r.spawnability)                             AS spawnability,
    COALESCE(a.directive_id, r.directive_id)                             AS directive_id,
    COALESCE(a.task_id, r.task_id)                                       AS task_id,
    COALESCE(a.current_act_id, r.current_act_id)                         AS current_act_id,
    COALESCE(a.scope, r.scope, '{}')                                     AS scope,
    COALESCE(a.git_head, r.git_head)                                     AS git_head,
    r.registered_ts                                                      AS registered_ts,
    COALESCE(a.last_seen_ts, r.registered_ts)                            AS last_seen_ts,
    CAST((julianday('now') - julianday(COALESCE(a.last_seen_ts, r.registered_ts))) * 86400 AS INTEGER)
                                                                         AS seconds_since_last_seen,
    CASE
      WHEN (julianday('now') - julianday(COALESCE(a.last_seen_ts, r.registered_ts))) * 86400 > 300
        THEN 'stale'
      ELSE 'live'
    END                                                                  AS liveness_verdict,
    r.registration_event_id                                              AS registration_event_id,
    COALESCE(a.activity_event_id, r.registration_event_id)               AS latest_activity_event_id
  FROM registration_rows r
  LEFT JOIN activity_rows a ON a.peer_id = r.peer_id AND a.rn = 1
  WHERE r.rn = 1
    AND datetime(COALESCE(a.last_seen_ts, r.registered_ts)) > datetime('now', '-24 hours')
  ORDER BY last_seen_ts DESC;
`;

// peer_activity_view — Tier U/U2 on-the-fly mutual awareness. Each live
// peer-registry row gets a depth-1 summary of that peer's in-flight acts,
// target resources, peer-LLM scores/reviews, and latest activity timestamp.
// This lets another peer check live collisions before acting on the same
// target_resource while preserving Tier U's symmetric participation model.
const VIEW_PEER_ACTIVITY = `
CREATE VIEW IF NOT EXISTS peer_activity_view AS
  WITH live_peers AS (
    SELECT
      p.*,
      CASE
        WHEN p.kind = 'opencode' THEN 'opencode'
        WHEN p.kind = 'claude_agent' THEN 'claude_agent'
        ELSE 'claude_root'
      END AS expected_origin
    FROM peer_registry_view p
    WHERE p.liveness_verdict = 'live'
  ),
  candidate_acts AS (
    SELECT
      p.peer_id,
      e.id AS act_event_id,
      e.ts AS act_ts,
      e.kind AS act_kind,
      e.directive_id,
      e.task_id,
      e.payload,
      COALESCE(
        json_extract(e.payload, '$.source_act_id'),
        json_extract(e.payload, '$.projection.source_act_id'),
        json_extract(e.payload, '$.act_tuple.source_act_id'),
        e.id
      ) AS source_act_id
    FROM live_peers p
    JOIN events e
      ON e.kind IN ('action_predicted', 'act_tuple_recorded')
     AND (
       e.id = p.current_act_id
       OR json_extract(e.payload, '$.source_act_id') = p.current_act_id
       OR json_extract(e.payload, '$.projection.source_act_id') = p.current_act_id
       OR json_extract(e.payload, '$.act_tuple.source_act_id') = p.current_act_id
       OR (
         p.directive_id IS NOT NULL
         AND p.task_id IS NOT NULL
         AND e.directive_id = p.directive_id
         AND e.task_id = p.task_id
         AND COALESCE(e.substrate_origin, '') = p.expected_origin
       )
     )
  ),
  inflight_acts AS (
    SELECT a.*
    FROM candidate_acts a
    WHERE NOT EXISTS (
      SELECT 1 FROM events s
      WHERE s.kind = 'action_scored'
        AND s.ts >= a.act_ts
        AND (
          json_extract(s.payload, '$.source_act_id') = a.source_act_id
          OR json_extract(s.payload, '$.projection.source_act_id') = a.source_act_id
          OR json_extract(s.payload, '$.act_tuple.source_act_id') = a.source_act_id
          OR EXISTS (SELECT 1 FROM json_each(s.context_refs) WHERE value IN (a.act_event_id, a.source_act_id))
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM events t
      WHERE t.kind IN ('task_committed', 'task_failed', 'task_abandoned', 'dispatcher_violation')
        AND t.directive_id = a.directive_id
        AND t.task_id = a.task_id
        AND t.ts >= a.act_ts
    )
  ),
  target_rows AS (
    SELECT act_event_id, value AS target_resource
    FROM inflight_acts, json_each(inflight_acts.payload, '$.target_resources')
    UNION
    SELECT act_event_id, value AS target_resource
    FROM inflight_acts, json_each(inflight_acts.payload, '$.affected_resources')
    UNION
    SELECT act_event_id, json_extract(payload, '$.target_resource') AS target_resource
    FROM inflight_acts
    WHERE json_extract(payload, '$.target_resource') IS NOT NULL
    UNION
    SELECT act_event_id, json_extract(payload, '$.proposed_behavior.target_resource') AS target_resource
    FROM inflight_acts
    WHERE json_extract(payload, '$.proposed_behavior.target_resource') IS NOT NULL
  ),
  peer_scores AS (
    SELECT
      p.peer_id,
      s.id AS score_event_id,
      s.ts AS score_ts,
      s.directive_id,
      s.task_id,
      COALESCE(json_extract(s.payload, '$.verifier_kind'), json_extract(s.payload, '$.verifier.kind')) AS verifier_kind,
      COALESCE(s.residual, CAST(json_extract(s.payload, '$.residual') AS REAL), CAST(json_extract(s.payload, '$.observed_residual') AS REAL)) AS residual,
      s.payload
    FROM live_peers p
    JOIN events s
      ON s.kind = 'action_scored'
     AND COALESCE(json_extract(s.payload, '$.verifier_kind'), json_extract(s.payload, '$.verifier.kind')) IN ('peer_llm_claude', 'peer_llm_opencode')
     AND s.ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
     AND (
       s.substrate_origin = p.expected_origin
       OR (p.directive_id IS NOT NULL AND s.directive_id = p.directive_id AND (p.task_id IS NULL OR s.task_id = p.task_id))
       OR EXISTS (SELECT 1 FROM json_each(s.context_refs) WHERE value = p.current_act_id)
     )
  )
  SELECT
    p.peer_id,
    p.kind,
    p.spawnability,
    p.directive_id,
    p.task_id,
    p.current_act_id,
    p.scope,
    p.git_head,
    p.registered_ts,
    p.last_seen_ts,
    p.seconds_since_last_seen,
    p.liveness_verdict,
    p.registration_event_id,
    p.latest_activity_event_id,
    COALESCE((SELECT json_group_array(json_object('event_id', a.act_event_id, 'kind', a.act_kind, 'ts', a.act_ts, 'directive_id', a.directive_id, 'task_id', a.task_id, 'source_act_id', a.source_act_id)) FROM inflight_acts a WHERE a.peer_id = p.peer_id), '[]') AS in_flight_acts,
    COALESCE((SELECT json_group_array(DISTINCT tr.target_resource) FROM target_rows tr JOIN inflight_acts a ON a.act_event_id = tr.act_event_id WHERE a.peer_id = p.peer_id AND tr.target_resource IS NOT NULL), '[]') AS target_resources,
    COALESCE((SELECT json_group_array(json_object('event_id', s.score_event_id, 'ts', s.score_ts, 'directive_id', s.directive_id, 'task_id', s.task_id, 'verifier_kind', s.verifier_kind, 'residual', s.residual)) FROM peer_scores s WHERE s.peer_id = p.peer_id), '[]') AS recent_peer_scores,
    COALESCE((SELECT json_group_array(s.score_event_id) FROM peer_scores s WHERE s.peer_id = p.peer_id), '[]') AS review_event_ids,
    MAX(
      p.last_seen_ts,
      COALESCE((SELECT MAX(a.act_ts) FROM inflight_acts a WHERE a.peer_id = p.peer_id), p.last_seen_ts),
      COALESCE((SELECT MAX(s.score_ts) FROM peer_scores s WHERE s.peer_id = p.peer_id), p.last_seen_ts)
    ) AS last_activity_ts
  FROM live_peers p
  ORDER BY last_activity_ts DESC;
`;

// claude_agent_job_queue_view — Tier U/U5 queue semantics. Requested jobs
// are pending until completed. A claimed job remains hidden only while its
// claimant peer is live in peer_registry_view; stale claimants fail open so
// another live Claude orchestrator can reclaim the job and no work is lost.
const VIEW_CLAUDE_AGENT_JOB_QUEUE = `
CREATE VIEW IF NOT EXISTS claude_agent_job_queue_view AS
  WITH requested AS (
    SELECT
      id AS request_event_id,
      ts AS requested_ts,
      directive_id,
      task_id,
      json_extract(payload, '$.job_id') AS job_id,
      json_extract(payload, '$.intent') AS intent,
      COALESCE(json_extract(payload, '$.target_files'), '[]') AS target_files,
      COALESCE(json_extract(payload, '$.acceptance_predicate'), '{}') AS acceptance_predicate,
      payload AS request_payload
    FROM events
    WHERE kind = 'claude_agent_job_requested'
      AND json_extract(payload, '$.job_id') IS NOT NULL
  ),
  latest_claim AS (
    SELECT * FROM (
      SELECT
        id AS claim_event_id,
        ts AS claimed_ts,
        json_extract(payload, '$.job_id') AS job_id,
        json_extract(payload, '$.claimant_peer_id') AS claimant_peer_id,
        payload AS claim_payload,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(payload, '$.job_id')
          ORDER BY ts DESC, id DESC
        ) AS rn
      FROM events
      WHERE kind = 'claude_agent_job_claimed'
        AND json_extract(payload, '$.job_id') IS NOT NULL
    ) WHERE rn = 1
  ),
  completed AS (
    SELECT
      json_extract(payload, '$.job_id') AS job_id,
      MAX(ts) AS completed_ts
    FROM events
    WHERE kind = 'claude_agent_job_completed'
      AND json_extract(payload, '$.job_id') IS NOT NULL
    GROUP BY json_extract(payload, '$.job_id')
  )
  SELECT
    r.job_id,
    r.directive_id,
    r.task_id,
    r.intent,
    r.target_files,
    r.acceptance_predicate,
    r.request_event_id,
    r.requested_ts,
    c.claim_event_id,
    c.claimed_ts,
    c.claimant_peer_id,
    p.kind AS claimant_kind,
    p.liveness_verdict AS claimant_liveness_verdict,
    CASE
      WHEN c.claim_event_id IS NULL THEN 'pending'
      WHEN p.peer_id IS NULL OR p.liveness_verdict != 'live' THEN 'stale_claim_requeued'
      ELSE 'claimed_live'
    END AS queue_status,
    r.request_payload,
    c.claim_payload
  FROM requested r
  LEFT JOIN latest_claim c ON c.job_id = r.job_id AND c.rn = 1
  LEFT JOIN peer_registry_view p ON p.peer_id = c.claimant_peer_id
  WHERE r.job_id NOT IN (SELECT job_id FROM completed WHERE job_id IS NOT NULL)
    AND (
      c.claim_event_id IS NULL
      OR p.peer_id IS NULL
      OR p.liveness_verdict != 'live'
    )
  ORDER BY r.requested_ts ASC;
`;

// ── Public entrypoint ──────────────────────────────────────────────

// recipes_latest_view and recipe_registry_view now project from
// knowledge_candidate/knowledge_promoted rows filtered by
// payload.recipe_shape.enabled (universality proposal
// A12CR1QCDN0SS51CM95K39T45M absorbed the recipe_* event family). They are
// still created by runViews() (the SQL is unchanged on the read side) but
// removed from the canonical VIEW_NAMES enumeration so the public surface
// reflects the post-absorption substrate.
export const VIEW_NAMES = [
  "lesson_apply_candidate_view",
  "applied_lesson_effectiveness_view",
  "lesson_implementation_status_view",
  "lesson_implementer_queue_view",
  "pending_owner_decision_queue_view",
  "pending_owner_decision_queue_live_view",
  "promoted_knowledge_view",
  "irreversible_effects_view",
  "low_risk_inline_patterns_view",
  "act_projection_observability_view",
  "active_objectives_view",
  "entity_relationship_view",
  "stakeholder_state_view",
  "directive_conflicts_view",
  "watch_edge_observations_view",
  "rolling_review_due_view",
  "owner_conversation_view",
  "owner_profile_view",
  "owner_rendering_policy_view",
  "owner_rendering_effectiveness_view",
  "owner_state_belief_view",
  "owner_alignment_action_policy_view",
  "owner_plain_status_view",
  "event_kind_occurrence_view",
  "worker_liveness_view",
  "peer_registry_view",
  "peer_activity_view",
  "claude_agent_job_queue_view",
  "stale_zero_score_knowledge_view",
  "retrieval_credit_view",
  "top_laws_view",
  "contradictory_candidates_view",
  "origin_promotion_by_directive_view",
  "origin_promotion_view",
  "embedding_index_view",
  "artifact_routing_view",
  "act_artifact_registry_view",
  "failure_view",
  "ready_tasks_view",
  "task_graph_view",
  "dispatch_resolved_view",
  "substrate_narrative_recent_view",
  "claude_inline_ready_leaves_view",
  "pending_contract_amendments_view",
  "directive_view",
  "task_critical_path_view",
  "active_inference_view",
  "artifact_warning_view",
  "model_routing_view",
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
  db.exec(VIEW_ACT_ARTIFACT_REGISTRY);
  db.exec(VIEW_ARTIFACT_ROUTING);
  db.exec(VIEW_EMBEDDING_INDEX);
  db.exec(VIEW_ORIGIN_PROMOTION);
  db.exec(VIEW_ORIGIN_PROMOTION_BY_DIRECTIVE);
  db.exec(VIEW_CONTRADICTORY);
  db.exec(VIEW_OWNER_CONVERSATION);
  db.exec(VIEW_OWNER_PROFILE);
  db.exec(VIEW_OWNER_RENDERING_POLICY);
  db.exec(VIEW_OWNER_RENDERING_EFFECTIVENESS);
  db.exec(VIEW_OWNER_STATE_BELIEF);
  db.exec(VIEW_OWNER_ALIGNMENT_ACTION_POLICY);
  db.exec(VIEW_OWNER_PLAIN_STATUS);
  db.exec(VIEW_RETRIEVAL_CREDIT);
  db.exec(VIEW_ROLLING_REVIEW_DUE);
  db.exec(VIEW_WATCH_EDGE_OBSERVATIONS);
  db.exec(VIEW_DIRECTIVE_CONFLICTS);
  db.exec(VIEW_STAKEHOLDER_STATE);
  db.exec(VIEW_ENTITY_RELATIONSHIPS);
  db.exec(VIEW_ACTIVE_OBJECTIVES);
  db.exec(VIEW_ACT_PROJECTION_OBSERVABILITY);
  db.exec(VIEW_IRREVERSIBLE_EFFECTS);
  db.exec(VIEW_LOW_RISK_INLINE_PATTERNS);
  db.exec(VIEW_PROMOTED_KNOWLEDGE);
  // top_laws_view depends on promoted_knowledge_view.
  db.exec(VIEW_TOP_LAWS);
  db.exec(VIEW_RECIPE_REGISTRY);
  db.exec(VIEW_RECIPES_LATEST);
  db.exec(VIEW_LESSON_IMPLEMENTER_QUEUE);
  db.exec(VIEW_LESSON_IMPLEMENTATION_STATUS);
  db.exec(VIEW_APPLIED_LESSON_EFFECTIVENESS);
  db.exec(VIEW_LESSON_APPLY_CANDIDATE);
  db.exec(VIEW_DISPATCH_RESOLVED);
  db.exec(VIEW_PENDING_OWNER_DECISION_QUEUE);
  db.exec(VIEW_PENDING_OWNER_DECISION_QUEUE_LIVE);
  db.exec(VIEW_SUBSTRATE_NARRATIVE_RECENT);
  db.exec(VIEW_CLAUDE_INLINE_READY_LEAVES);
  db.exec(VIEW_PENDING_CONTRACT_AMENDMENTS);
  db.exec(VIEW_DIRECTIVE);
  db.exec(VIEW_TASK_CRITICAL_PATH);
  db.exec(VIEW_ACTIVE_INFERENCE);
  db.exec(VIEW_ARTIFACT_WARNING);
  db.exec(VIEW_MODEL_ROUTING);
  db.exec(VIEW_PEER_REGISTRY);
  db.exec(VIEW_PEER_ACTIVITY);
  db.exec(VIEW_CLAUDE_AGENT_JOB_QUEUE);
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
  /** L4.1 (2026-05-17): parent in the DAG (null for roots / fresh
   *  refinement subtrees opened with no explicit parent_task_id on the
   *  event row). Surfaced so scheduler + claim logic can group ready
   *  leaves by their refinement chain without an extra query. */
  parent_task_id: string | null;
  payload: Record<string, unknown>;
  /** L4.1 (2026-05-17): from_task ids of incoming 'requires' edges on
   *  this task. Empty when the task has no requires-edges. The view
   *  already enforces that every from_task in this list has committed
   *  (otherwise the task would be in the blocked set), so consumers
   *  can treat this purely as provenance metadata. */
  incoming_requires_from: string[];
  /** L4.1 (2026-05-17): from_task ids of incoming 'refines' edges on
   *  this task. Refines edges do NOT block readiness — they document
   *  the refinement chain — so this list is informational. */
  incoming_refines_from: string[];
};

// Lifecycle tokens for dispatch_resolved_view.
//   live           — a brain_dispatched is open and within the 5-min cap.
//   live_amended   — root committed, brain subsequently amended the directive
//                    via directive_amended (or refinement task_node_opened)
//                    and the new children are still dispatching. Honestly
//                    distinct from 'live' (no terminal yet) so the operator
//                    surface can render "continuing" vs "fresh start".
//   queued_at_cap  — scheduler cap gate blocked dispatch; root waits.
//   completed      — terminal task_committed event recorded AND no open
//                    children (clean exit).
//   failed         — terminal task_failed or dispatcher_violation event.
//   zombie         — a brain dispatch IS open but has exceeded the 5-min
//                    cap with no terminal. (Real zombie.)
//   orphan_node    — task_node_opened fired but no brain_dispatched ever
//                    followed; >5min stale, no cap_gate excuse. The
//                    scheduler dropped a ready refinement-child on the
//                    floor. NOT a hung brain — a scheduler omission.
export type DispatchResolvedStatus =
  | "live"
  | "live_amended"
  | "completed"
  | "failed"
  | "queued_at_cap"
  | "zombie"
  | "orphan_node"
  // 2026-05-17 Bug B extension: undispatched task under a closed/archived
  // directive. The DAG is over; the task's outcome no longer matters.
  // Distinct from 'orphan_node' (open directive, expected to complete) so
  // the operator surface can group + ignore these without false-positive
  // alerts. 200+ stragglers from killed past sessions classify here.
  | "abandoned";

export type DispatchResolvedRow = {
  directive_id: string;
  root_task_id: string;
  status: DispatchResolvedStatus;
  lifecycle_status: DispatchResolvedStatus;
  status_reason: string | null;
  dispatch_id: string | null;
  dispatch_event_id: string | null;
  close_event_id: string | null;
  latest_event_id: string | null;
  latest_ts: string | null;
  age_ms: number | null;
  residual: number | null;
  queued_reason: string | null;
  cap: number | null;
  in_flight_brain: number | null;
  latest_cap_gate_event_id: string | null;
  dispatched_count: number;
  open_dispatch_count: number;
  latest_dispatched_at: string | null;
  oldest_open_dispatched_at: string | null;
  latest_closed_at: string | null;
  terminal_event_id: string | null;
  terminal_at: string | null;
  terminal_kind: string | null;
  failure_kind: string | null;
  latest_cap_gate_at: string | null;
  ready_since: string | null;
  latest_signal_at: string | null;
};


export type ActProjectionObservabilityRow = {
  source_act_id: string;
  source_event_id: string | null;
  source_ts: string | null;
  directive_id: string | null;
  task_id: string | null;
  action_predicted_event_ids: string[];
  action_scored_event_ids: string[];
  applied_change_committed_event_ids: string[];
  owner_observed_outcome_recorded_event_ids: string[];
  retrieval_binding_event_ids: string[];
  credit_projection_event_ids: string[];
  projection_residual: number | null;
  projection_residual_event_id: string | null;
  projection_residual_kind: string | null;
  projection_status: "recorded" | "partial" | "completed" | "orphaned";
};

export type FailureRow = {
  failure_kind: string;
  count: number;
  latest_ts: string;
  earliest_ts: string;
};

export type ActArtifactRow = {
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

export type ArtifactRoutingRow = ActArtifactRow & { routing_score: number };

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
  retrieval_aspects: Record<string, unknown>;
  retrieval_domains: Record<string, number>;
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

export type EntityRelationshipRow = {
  event_id: string;
  ts: string;
  directive_id: string;
  from_entity: string | null;
  to_entity: string | null;
  relationship: string | null;
  relationship_payload: unknown;
  payload: Record<string, unknown>;
  source_kind: string;
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
  auto_apply_gate_event_id: string | null;
  auto_apply_gate_residual: number | null;
  freshness_residual: number | null;
  semantic_duplicate_residual: number | null;
  behavioral_novelty_residual: number | null;
  necessity_residual: number | null;
  adversarial_residual: number | null;
  auto_apply_gate_breakdown: Record<string, unknown>;
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
    retrieval_aspects: parseJson<Record<string, unknown>>(r.retrieval_aspects ?? "{}"),
    retrieval_domains: parseJson<Record<string, number>>(r.retrieval_domains ?? "{}"),
  }));
};


/** Return act_tuple_recorded projection observability for one source act id. */
export const actProjectionObservability = (
  db: Database,
  sourceActId: string,
): ActProjectionObservabilityRow | null => {
  const row = db
    .query("SELECT * FROM act_projection_observability_view WHERE source_act_id = ?")
    .get(sourceActId) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    source_act_id: row.source_act_id as string,
    source_event_id: (row.source_event_id as string | null) ?? null,
    source_ts: (row.source_ts as string | null) ?? null,
    directive_id: (row.directive_id as string | null) ?? null,
    task_id: (row.task_id as string | null) ?? null,
    action_predicted_event_ids: parseJson<string[]>(row.action_predicted_event_ids ?? "[]"),
    action_scored_event_ids: parseJson<string[]>(row.action_scored_event_ids ?? "[]"),
    applied_change_committed_event_ids: parseJson<string[]>(row.applied_change_committed_event_ids ?? "[]"),
    owner_observed_outcome_recorded_event_ids: parseJson<string[]>(row.owner_observed_outcome_recorded_event_ids ?? "[]"),
    retrieval_binding_event_ids: parseJson<string[]>(row.retrieval_binding_event_ids ?? "[]"),
    credit_projection_event_ids: parseJson<string[]>(row.credit_projection_event_ids ?? "[]"),
    projection_residual: row.projection_residual == null ? null : Number(row.projection_residual),
    projection_residual_event_id: (row.projection_residual_event_id as string | null) ?? null,
    projection_residual_kind: (row.projection_residual_kind as string | null) ?? null,
    projection_status: row.projection_status as ActProjectionObservabilityRow["projection_status"],
  };
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
    parent_task_id: (r.parent_task_id as string | null) ?? null,
    payload: parseJson<Record<string, unknown>>(r.payload),
    incoming_requires_from: parseJson<string[]>(r.incoming_requires_from ?? "[]"),
    incoming_refines_from: parseJson<string[]>(r.incoming_refines_from ?? "[]"),
  }));
};

// ── claude_inline_ready_leaves_view helper ─────────────────────────

/** Row shape from claude_inline_ready_leaves_view. L3 inbox surface
 *  per brain design 48SN4XF3WN4KBBCHHCANDRDQRW. Every row is a task
 *  the substrate has routed to the claude_inline lane AND is
 *  currently ready (no blocking upstream). Claude (this terminal)
 *  reads this view to know what to claim. */
export type ClaudeInlineReadyLeafRow = {
  /** dispatch_decided event id — the lane-routing signal. */
  dispatch_event_id: string;
  dispatch_ts: string;
  directive_id: string;
  task_id: string;
  parent_task_id: string | null;
  goal: string | null;
  /** From dispatch_decided.payload.cited_artifact_ids — which
   *  low-risk-inline-pattern matched (so Claude knows the recipe
   *  context for crediting outcome). */
  cited_artifact_ids: string[];
  /** From dispatch_decided.payload.routing_axes — the axes the
   *  decider used. Surfaced so the inbox consumer can debug WHY
   *  a task was routed inline. */
  routing_axes: Record<string, number>;
  /** Top-ranked strategy artifact (if the shadow ranker had any
   *  data). NULL when no strategy ranking landed. */
  strategy_shadow_top: string | null;
  strategy_shadow_top_score: number | null;
  /** task_claimed event timestamp if Claude has already picked up
   *  this leaf. NULL = still claimable. Surfaced so the inbox UI
   *  can distinguish "todo" from "in flight". */
  claimed_at: string | null;
};

export const claudeInlineReadyLeaves = (
  db: Database,
  filter?: { directive_id?: string; limit?: number; only_unclaimed?: boolean },
): ClaudeInlineReadyLeafRow[] => {
  const wheres: string[] = [];
  const params: Array<string | number> = [];
  if (filter?.directive_id) {
    wheres.push("directive_id = ?");
    params.push(filter.directive_id);
  }
  if (filter?.only_unclaimed) {
    wheres.push("claimed_at IS NULL");
  }
  const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = typeof filter?.limit === "number" && filter.limit > 0 ? filter.limit : 50;
  params.push(limit);
  const sql = `SELECT * FROM claude_inline_ready_leaves_view ${whereClause} LIMIT ?`;
  const rows = db.query(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    dispatch_event_id: r.dispatch_event_id as string,
    dispatch_ts: r.dispatch_ts as string,
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    parent_task_id: (r.parent_task_id as string | null) ?? null,
    goal: (r.goal as string | null) ?? null,
    cited_artifact_ids: parseJson<string[]>((r.cited_artifact_ids as string | null) ?? "[]"),
    routing_axes: parseJson<Record<string, number>>((r.routing_axes as string | null) ?? "{}"),
    strategy_shadow_top: (r.strategy_shadow_top as string | null) ?? null,
    strategy_shadow_top_score: r.strategy_shadow_top_score == null ? null : Number(r.strategy_shadow_top_score),
    claimed_at: (r.claimed_at as string | null) ?? null,
  }));
};

// ── substrate_narrative_recent_view helper ─────────────────────────

/** Row shape from substrate_narrative_recent_view. Brain design
 *  D9TBCHADS97DHAMNBC686HE3P0 (2026-05-17): the load-bearing primitive
 *  for the content-first TUI. Every column has been deliberately
 *  designed so the TUI never needs a second query to render a row
 *  ("Enter for drilldown" reads `payload` directly). */
export type SubstrateNarrativeRow = {
  event_id: string;
  ts: string;
  kind: string;
  directive_id: string | null;
  task_id: string | null;
  substrate_origin: string | null;
  /** 'critical' | 'high' | 'medium' | 'low' — derived from the kind +
   *  failure metadata. Drives sort + colour in the TUI. */
  importance: "critical" | "high" | "medium" | "low";
  /** One-line content the operator reads. NULL when the kind has no
   *  canonical content field (heartbeat-shaped events); TUI should
   *  fall back to kind name in that case. */
  human_summary: string | null;
  /** From the row's residual column OR a payload-embedded residual
   *  field. Useful for sorting by failure intensity. */
  residual: number | null;
  /** Dispatch route metadata (only set on dispatch_decided rows). */
  route: string | null;
  /** Comma-joined context_refs from the events row — the cited
   *  evidence the drilldown surface chases back through. */
  cited_refs: string[];
  /** Raw payload as a record. TUI drilldown renders this verbatim
   *  (with width-aware truncation) so no second MCP call is needed. */
  payload: Record<string, unknown>;
};

export type SubstrateNarrativeFilter = {
  limit?: number;
  /** Restrict to a single directive — used by the per-directive view
   *  the TUI shows when the operator drills into one chain. */
  directive_id?: string;
  /** Restrict by importance band (e.g. ['critical','high','medium'] to
   *  suppress noise). Empty array = no filter. */
  importance_in?: Array<"critical" | "high" | "medium" | "low">;
  /** Restrict by kind set — used by the decision strip (filter to
   *  pending_*_required + contract_amendment_proposed). */
  kinds_in?: string[];
};

/** Read the substrate_narrative_recent_view with optional filters.
 *  Returns rows newest-first. Caller is responsible for any further
 *  truncation / formatting; this helper just types + parses JSON. */
export const substrateNarrativeRecent = (
  db: Database,
  filter: SubstrateNarrativeFilter = {},
): SubstrateNarrativeRow[] => {
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
  }
  const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = typeof filter.limit === "number" && filter.limit > 0 ? filter.limit : 200;
  params.push(limit);
  const sql = `SELECT * FROM substrate_narrative_recent_view ${whereClause} LIMIT ?`;
  const rows = db.query(sql).all(...params) as Array<Record<string, unknown>>;
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

// ── owner-rendering primitives (brain contract Q471RAN88X0H513V8BC3BTW0AW, 2026-05-17) ──

/** Row from owner_rendering_policy_view — the policy any renderer reads
 *  before emitting an owner-visible string. One row (latest profile + recent
 *  feedback window aggregates). */
export type OwnerRenderingPolicyRow = {
  profile_event_id: string | null;
  profile_ts: string | null;
  profile_payload: Record<string, unknown>;
  preferred_terms: string[];
  avoided_terms: string[];
  declined_concepts: string[];
  understood_concepts: string[];
  exposed_concepts: string[];
  things_to_never_do: string[];
  manual_review_patterns: string[];
  autonomy_score: number | null;
  autonomy_scope: string[];
  detected_language: string | null;
  recent_correction_count: number;
  recent_decline_count: number;
  recent_ignored_count: number;
  recent_satisfaction_count: number;
  recent_clarification_count: number;
  recent_override_count: number;
  /** Heuristic [0,1]: 1.0 = no recent negative feedback; falls as
   *  corrections/declines/ignored/overrides accumulate. Consumers
   *  may route to a more careful render mode when policy_health < 0.7. */
  policy_health: number;
};

const ensureArray = <T = unknown>(raw: string | null | undefined): T[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch { return []; }
};

/** Read the latest owner rendering policy. Returns null when no
 *  owner_profile_recorded row exists yet (cold install) — callers MUST
 *  handle that case (default render mode). */
export const ownerRenderingPolicy = (db: Database): OwnerRenderingPolicyRow | null => {
  const row = db
    .query("SELECT * FROM owner_rendering_policy_view")
    .get() as Record<string, unknown> | null;
  if (!row || row.profile_event_id == null) return null;
  return {
    profile_event_id: (row.profile_event_id as string | null) ?? null,
    profile_ts: (row.profile_ts as string | null) ?? null,
    profile_payload: parseJson<Record<string, unknown>>((row.profile_payload as string | null) ?? "{}"),
    preferred_terms: ensureArray<string>(row.preferred_terms as string | null),
    avoided_terms: ensureArray<string>(row.avoided_terms as string | null),
    declined_concepts: ensureArray<string>(row.declined_concepts as string | null),
    understood_concepts: ensureArray<string>(row.understood_concepts as string | null),
    exposed_concepts: ensureArray<string>(row.exposed_concepts as string | null),
    things_to_never_do: ensureArray<string>(row.things_to_never_do as string | null),
    manual_review_patterns: ensureArray<string>(row.manual_review_patterns as string | null),
    autonomy_score: row.autonomy_score == null ? null : Number(row.autonomy_score),
    autonomy_scope: ensureArray<string>(row.autonomy_scope as string | null),
    detected_language: (row.detected_language as string | null) ?? null,
    recent_correction_count: Number(row.recent_correction_count ?? 0),
    recent_decline_count: Number(row.recent_decline_count ?? 0),
    recent_ignored_count: Number(row.recent_ignored_count ?? 0),
    recent_satisfaction_count: Number(row.recent_satisfaction_count ?? 0),
    recent_clarification_count: Number(row.recent_clarification_count ?? 0),
    recent_override_count: Number(row.recent_override_count ?? 0),
    policy_health: Number(row.policy_health ?? 1.0),
  };
};

export type OwnerRenderingEffectivenessRow = {
  rendered_event_id: string;
  rendered_ts: string;
  directive_id: string | null;
  task_id: string | null;
  owner_profile_hash: string | null;
  audience: string | null;
  surface: string | null;
  renderer: string | null;
  intended_owner_action: string | null;
  est_attention_cost: number | null;
  feedback_kind: string | null;
  feedback_residual: number | null;
  feedback_ts: string | null;
  effectiveness_band: "positive" | "negative" | "mixed" | "pending" | "other";
};

/** Read effectiveness rows — newest first. Caller filters by audience or
 *  surface as needed. */
export const ownerRenderingEffectiveness = (
  db: Database,
  filter: { audience?: string; surface?: string; limit?: number } = {},
): OwnerRenderingEffectivenessRow[] => {
  const wheres: string[] = [];
  const params: Array<string | number> = [];
  if (filter.audience) { wheres.push("audience = ?"); params.push(filter.audience); }
  if (filter.surface) { wheres.push("surface = ?"); params.push(filter.surface); }
  const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = typeof filter.limit === "number" && filter.limit > 0 ? filter.limit : 100;
  params.push(limit);
  const sql = `SELECT * FROM owner_rendering_effectiveness_view ${whereClause} LIMIT ?`;
  const rows = db.query(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    rendered_event_id: r.rendered_event_id as string,
    rendered_ts: r.rendered_ts as string,
    directive_id: (r.directive_id as string | null) ?? null,
    task_id: (r.task_id as string | null) ?? null,
    owner_profile_hash: (r.owner_profile_hash as string | null) ?? null,
    audience: (r.audience as string | null) ?? null,
    surface: (r.surface as string | null) ?? null,
    renderer: (r.renderer as string | null) ?? null,
    intended_owner_action: (r.intended_owner_action as string | null) ?? null,
    est_attention_cost: r.est_attention_cost == null ? null : Number(r.est_attention_cost),
    feedback_kind: (r.feedback_kind as string | null) ?? null,
    feedback_residual: r.feedback_residual == null ? null : Number(r.feedback_residual),
    feedback_ts: (r.feedback_ts as string | null) ?? null,
    effectiveness_band: (r.effectiveness_band as OwnerRenderingEffectivenessRow["effectiveness_band"]) ?? "other",
  }));
};

export type OwnerPlainStatusRow = {
  directive_id: string;
  opened_text: string | null;
  opened_ts: string | null;
  latest_state: string;
  latest_state_kind: "completed" | "awaiting_owner" | "failed" | "in_progress" | "idle";
  next_owner_action: string | null;
  risk_note: string | null;
  residual_optional: number | null;
  detail_refs: string[];
  last_event_ts: string;
};

/** Read the owner-plain status cards. By default returns the 20 most
 *  recently-active directives newest-first. */
export const ownerPlainStatus = (
  db: Database,
  filter: { limit?: number; directive_id?: string } = {},
): OwnerPlainStatusRow[] => {
  const wheres: string[] = [];
  const params: Array<string | number> = [];
  if (filter.directive_id) { wheres.push("directive_id = ?"); params.push(filter.directive_id); }
  const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = typeof filter.limit === "number" && filter.limit > 0 ? filter.limit : 20;
  params.push(limit);
  const sql = `SELECT * FROM owner_plain_status_view ${whereClause} LIMIT ?`;
  const rows = db.query(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    directive_id: r.directive_id as string,
    opened_text: (r.opened_text as string | null) ?? null,
    opened_ts: (r.opened_ts as string | null) ?? null,
    latest_state: (r.latest_state as string) ?? "Idle — waiting for the next signal.",
    latest_state_kind: (r.latest_state_kind as OwnerPlainStatusRow["latest_state_kind"]) ?? "idle",
    next_owner_action: (r.next_owner_action as string | null) ?? null,
    risk_note: (r.risk_note as string | null) ?? null,
    residual_optional: r.residual_optional == null ? null : Number(r.residual_optional),
    detail_refs: ensureArray<string>(r.detail_refs as string | null).filter((s) => s != null),
    last_event_ts: r.last_event_ts as string,
  }));
};

// ── owner world-model evidence layer (brain contract CY7E62DSNX1DZ1BTD56845D994, 2026-05-18) ──

export type OwnerStateBeliefRow = {
  hypothesis_event_id: string | null;
  hypothesis_ts: string | null;
  hypothesis_origin: string | null;
  belief_source: "explicit_hypothesis" | "evidence_synthesized";
  /** Open-ended latent_state record; renderer/policy read whichever keys
   *  apply. Common keys: goal_intent, attention_budget, energy_budget,
   *  emotional_register, recent_disappointments, recent_satisfactions,
   *  working_memory_horizon, decision_style, skill_calibration,
   *  latent_larger_goal. */
  latent_state: Record<string, unknown>;
  confidence: Record<string, number>;
  observation_refs: string[];
  evidence_refs: string[];
  evidence_counts: Record<string, number>;
  evidence_count: number;
  decay_after_iso: string | null;
  /** Aggregate uncertainty ∈ [0,1]. 0.5 default when not specified. */
  uncertainty: number;
  /** [0,1] freshness multiplier: 1.0 fresh, approaching 0 after 14 days. */
  temporal_decay_factor: number;
  /** Uncertainty after temporal decay is applied. */
  decayed_uncertainty: number;
  recent_prediction_error_count: number;
  recent_avg_prediction_error: number | null;
  belief_age_ms: number;
  is_stale: boolean;
};

/** Read the substrate's current best guess about the owner's latent
 *  state. Returns null only when neither an explicit hypothesis nor
 *  recent owner-world-model evidence exists. */
export const ownerStateBelief = (db: Database): OwnerStateBeliefRow | null => {
  const row = db
    .query("SELECT * FROM owner_state_belief_view")
    .get() as Record<string, unknown> | null;
  if (!row || (row.hypothesis_event_id == null && Number(row.evidence_count ?? 0) === 0)) return null;
  return {
    hypothesis_event_id: (row.hypothesis_event_id as string | null) ?? null,
    hypothesis_ts: (row.hypothesis_ts as string | null) ?? null,
    hypothesis_origin: (row.hypothesis_origin as string | null) ?? null,
    belief_source: ((row.belief_source as string | null) ?? "explicit_hypothesis") as OwnerStateBeliefRow["belief_source"],
    latent_state: parseJson<Record<string, unknown>>((row.latent_state_payload as string | null) ?? "{}"),
    confidence: parseJson<Record<string, number>>((row.confidence as string | null) ?? "{}"),
    observation_refs: ensureArray<string>(row.observation_refs as string | null),
    evidence_refs: ensureArray<string>(row.evidence_refs as string | null),
    evidence_counts: parseJson<Record<string, number>>((row.evidence_counts as string | null) ?? "{}"),
    evidence_count: Number(row.evidence_count ?? 0),
    decay_after_iso: (row.decay_after_iso as string | null) ?? null,
    uncertainty: Number(row.uncertainty ?? 0.5),
    temporal_decay_factor: Number(row.temporal_decay_factor ?? 1),
    decayed_uncertainty: Number(row.decayed_uncertainty ?? row.uncertainty ?? 0.5),
    recent_prediction_error_count: Number(row.recent_prediction_error_count ?? 0),
    recent_avg_prediction_error: row.recent_avg_prediction_error == null ? null : Number(row.recent_avg_prediction_error),
    belief_age_ms: Number(row.belief_age_ms ?? 0),
    is_stale: Number(row.is_stale ?? 0) === 1,
  };
};

export type OwnerAlignmentActionPolicyRow = {
  action_event_id: string;
  action_ts: string;
  directive_id: string | null;
  task_id: string | null;
  action_kind: string | null;
  rationale: string | null;
  hypothesis_event_id: string | null;
  cited_artifact_ids: string[];
  belief_emotional_register: string | null;
  belief_attention_budget: string | null;
  belief_decision_style: string | null;
  belief_uncertainty: number | null;
  prediction_error_event_id: string | null;
  prediction_error_aggregate: number | null;
  effectiveness_band: "positive" | "negative" | "mixed" | "pending";
};

/** Read recent alignment_action_selected rows joined with their paired
 *  prediction error + belief axes. Returns newest first. */
export const ownerAlignmentActionPolicy = (
  db: Database,
  filter: { directive_id?: string; limit?: number; action_kind?: string } = {},
): OwnerAlignmentActionPolicyRow[] => {
  const wheres: string[] = [];
  const params: Array<string | number> = [];
  if (filter.directive_id) { wheres.push("directive_id = ?"); params.push(filter.directive_id); }
  if (filter.action_kind) { wheres.push("action_kind = ?"); params.push(filter.action_kind); }
  const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = typeof filter.limit === "number" && filter.limit > 0 ? filter.limit : 50;
  params.push(limit);
  const sql = `SELECT * FROM owner_alignment_action_policy_view ${whereClause} LIMIT ?`;
  const rows = db.query(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    action_event_id: r.action_event_id as string,
    action_ts: r.action_ts as string,
    directive_id: (r.directive_id as string | null) ?? null,
    task_id: (r.task_id as string | null) ?? null,
    action_kind: (r.action_kind as string | null) ?? null,
    rationale: (r.rationale as string | null) ?? null,
    hypothesis_event_id: (r.hypothesis_event_id as string | null) ?? null,
    cited_artifact_ids: ensureArray<string>(r.cited_artifact_ids as string | null),
    belief_emotional_register: (r.belief_emotional_register as string | null) ?? null,
    belief_attention_budget: (r.belief_attention_budget as string | null) ?? null,
    belief_decision_style: (r.belief_decision_style as string | null) ?? null,
    belief_uncertainty: r.belief_uncertainty == null ? null : Number(r.belief_uncertainty),
    prediction_error_event_id: (r.prediction_error_event_id as string | null) ?? null,
    prediction_error_aggregate: r.prediction_error_aggregate == null ? null : Number(r.prediction_error_aggregate),
    effectiveness_band: (r.effectiveness_band as OwnerAlignmentActionPolicyRow["effectiveness_band"]) ?? "pending",
  }));
};

// ── auto-compiled Top Laws (brain dispatch 3NWCD7PW315W, 2026-05-18) ──

export type TopLawRow = {
  event_id: string;
  ts: string;
  substrate_origin: string | null;
  candidate_id: string | null;
  directive_id: string | null;
  score: number;
  confidence: number | null;
  text: string;
  tags: string[];
  context_refs: string[];
  law_rank: number;
};

/** Read the substrate's current Top Laws — promoted knowledge rows
 *  scoring >= min_score, ranked by score DESC. Default min_score = 0.75
 *  (same bar as the legacy system/CLAUDE.md auto-compiled section). */
export const topLaws = (
  db: Database,
  filter: { min_score?: number; limit?: number } = {},
): TopLawRow[] => {
  const minScore = typeof filter.min_score === "number" && filter.min_score >= 0 ? filter.min_score : 0.75;
  const limit = typeof filter.limit === "number" && filter.limit > 0 ? filter.limit : 25;
  const rows = db
    .query(
      `SELECT * FROM top_laws_view WHERE score >= ? ORDER BY law_rank ASC LIMIT ?`,
    )
    .all(minScore, limit) as Array<Record<string, unknown>>;
  return rows.map((r, idx) => ({
    event_id: r.event_id as string,
    ts: r.ts as string,
    substrate_origin: (r.substrate_origin as string | null) ?? null,
    candidate_id: (r.candidate_id as string | null) ?? null,
    directive_id: (r.directive_id as string | null) ?? null,
    score: Number(r.score),
    confidence: r.confidence == null ? null : Number(r.confidence),
    text: (r.text as string) ?? "(no text)",
    tags: ensureArray<string>(r.tags as string | null),
    context_refs: ensureArray<string>(r.context_refs as string | null),
    law_rank: Number(r.law_rank ?? idx + 1),
  }));
};

// ── RLM credit loop accessor (brain task FX9PZDQ3W932, 2026-05-18) ──

export type RetrievalCreditRow = {
  retrieval_binding_event_id: string;
  retrieval_ts: string;
  directive_id: string | null;
  task_id: string | null;
  source_event_id: string | null;
  knowledge_source_kind: string | null;
  query: string | null;
  binding_surface: string | null;
  rank: number | null;
  rerank_score: number | null;
  times_cited: number;
  avg_cited_residual: number | null;
  times_rejected: number;
  credit_attributed_count: number;
  effectiveness_band: "unused" | "rejected" | "positive" | "mixed" | "negative";
};

/** Read retrieval_credit_view rows. Filter by directive_id or
 *  effectiveness_band; default returns the 100 newest rows. */
export const retrievalCredit = (
  db: Database,
  filter: { directive_id?: string; band?: RetrievalCreditRow["effectiveness_band"]; limit?: number } = {},
): RetrievalCreditRow[] => {
  const wheres: string[] = [];
  const params: Array<string | number> = [];
  if (filter.directive_id) { wheres.push("directive_id = ?"); params.push(filter.directive_id); }
  if (filter.band) { wheres.push("effectiveness_band = ?"); params.push(filter.band); }
  const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = typeof filter.limit === "number" && filter.limit > 0 ? filter.limit : 100;
  params.push(limit);
  const sql = `SELECT * FROM retrieval_credit_view ${whereClause} LIMIT ?`;
  const rows = db.query(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    retrieval_binding_event_id: r.retrieval_binding_event_id as string,
    retrieval_ts: r.retrieval_ts as string,
    directive_id: (r.directive_id as string | null) ?? null,
    task_id: (r.task_id as string | null) ?? null,
    source_event_id: (r.source_event_id as string | null) ?? null,
    knowledge_source_kind: (r.knowledge_source_kind as string | null) ?? null,
    query: (r.query as string | null) ?? null,
    binding_surface: (r.binding_surface as string | null) ?? null,
    rank: r.rank == null ? null : Number(r.rank),
    rerank_score: r.rerank_score == null ? null : Number(r.rerank_score),
    times_cited: Number(r.times_cited ?? 0),
    avg_cited_residual: r.avg_cited_residual == null ? null : Number(r.avg_cited_residual),
    times_rejected: Number(r.times_rejected ?? 0),
    credit_attributed_count: Number(r.credit_attributed_count ?? 0),
    effectiveness_band: (r.effectiveness_band as RetrievalCreditRow["effectiveness_band"]) ?? "unused",
  }));
};

/** Authoritative lifecycle projection per (directive_id, root_task_id).
 *
 *  Build the (sql, params) pair for a dispatch_resolved_view read. Shared by
 *  the synchronous `dispatchResolved` and the worker-pool `dispatchResolvedPooled`
 *  so both surfaces issue byte-identical SQL. */
const buildDispatchResolvedQuery = (
  filter: { directiveId?: string; rootTaskId?: string; limit?: number },
): { sql: string; params: Array<string | number> } => {
  const wheres: string[] = [];
  const params: Array<string | number> = [];
  if (filter.directiveId) { wheres.push("directive_id = ?"); params.push(filter.directiveId); }
  if (filter.rootTaskId) { wheres.push("root_task_id = ?"); params.push(filter.rootTaskId); }
  const whereSql = wheres.length === 0 ? "" : "WHERE " + wheres.join(" AND ");
  const limitSql = filter.limit ? ` LIMIT ${Math.max(1, Math.floor(filter.limit))}` : "";
  return {
    sql: `SELECT * FROM dispatch_resolved_view ${whereSql} ORDER BY latest_signal_at DESC, directive_id ASC, root_task_id ASC${limitSql}`,
    params,
  };
};

/** Map a raw dispatch_resolved_view row into the typed DispatchResolvedRow.
 *  Shared by the sync + pooled accessors so results are identical. */
const mapDispatchResolvedRow = (r: Record<string, unknown>): DispatchResolvedRow => ({
  directive_id: r.directive_id as string,
  root_task_id: r.root_task_id as string,
  status: (r.status ?? r.lifecycle_status) as DispatchResolvedStatus,
  lifecycle_status: (r.lifecycle_status ?? r.status) as DispatchResolvedStatus,
  status_reason: (r.status_reason as string | null) ?? null,
  dispatch_id: (r.dispatch_id as string | null) ?? null,
  dispatch_event_id: (r.dispatch_event_id as string | null) ?? null,
  close_event_id: (r.close_event_id as string | null) ?? null,
  latest_event_id: (r.latest_event_id as string | null) ?? null,
  latest_ts: (r.latest_ts as string | null) ?? null,
  age_ms: r.age_ms == null ? null : Number(r.age_ms),
  residual: r.residual == null ? null : Number(r.residual),
  queued_reason: (r.queued_reason as string | null) ?? null,
  cap: r.cap == null ? null : Number(r.cap),
  in_flight_brain: r.in_flight_brain == null ? null : Number(r.in_flight_brain),
  latest_cap_gate_event_id: (r.latest_cap_gate_event_id as string | null) ?? null,
  dispatched_count: Number(r.dispatched_count ?? 0),
  open_dispatch_count: Number(r.open_dispatch_count ?? 0),
  latest_dispatched_at: (r.latest_dispatched_at as string | null) ?? null,
  oldest_open_dispatched_at: (r.oldest_open_dispatched_at as string | null) ?? null,
  latest_closed_at: (r.latest_closed_at as string | null) ?? null,
  terminal_event_id: (r.terminal_event_id as string | null) ?? null,
  terminal_at: (r.terminal_at as string | null) ?? null,
  terminal_kind: (r.terminal_kind as string | null) ?? null,
  failure_kind: (r.failure_kind as string | null) ?? null,
  latest_cap_gate_at: (r.latest_cap_gate_at as string | null) ?? null,
  ready_since: (r.ready_since as string | null) ?? null,
  latest_signal_at: (r.latest_signal_at as string | null) ?? null,
});

export const dispatchResolved = (
  db: Database,
  filter: { directiveId?: string; rootTaskId?: string; limit?: number } = {},
): DispatchResolvedRow[] => {
  const { sql, params } = buildDispatchResolvedQuery(filter);
  const rows = db.query(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapDispatchResolvedRow);
};

/** Worker-pool variant of `dispatchResolved`. dispatch_resolved_view is the
 *  authoritative dispatch-truth surface the orchestrator polls every ~5s while
 *  an owner turn is live (.claude/rules/orchestrator-runtime.md "Dispatch
 *  Observation Protocol"). On the 374K-event live DB it materializes a
 *  full recursive task tree + per-task dispatch/close/cap CTEs across ALL
 *  directives before the outer WHERE filters to one — ~217ms even when scoped,
 *  because SQLite cannot push the outer predicate into the materialized CTEs.
 *  Under Bun's fake-async SQL that 217ms blocks the daemon's main loop,
 *  starving /health + concurrent MCP serving. Routing through the SQL
 *  worker-thread pool (when present) moves it off the main thread; the sync
 *  fallback (tests / ACC2_DISABLE_SQL_POOL) keeps identical results and
 *  ordering. Same SQL, same row shape — only the execution thread differs. */
export const dispatchResolvedPooled = async (
  db: Database,
  poolQuery: <T>(db: Database, sql: string, params: unknown[]) => Promise<T[]>,
  filter: { directiveId?: string; rootTaskId?: string; limit?: number } = {},
): Promise<DispatchResolvedRow[]> => {
  const { sql, params } = buildDispatchResolvedQuery(filter);
  const rows = await poolQuery<Record<string, unknown>>(db, sql, params);
  return rows.map(mapDispatchResolvedRow);
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

/** Admitted + promoted act artifacts ordered by score DESC. Optional runtime filter. */
export const actArtifactRegistry = (db: Database, runtime?: string): ActArtifactRow[] => {
  const rows = (runtime
    ? db.query("SELECT * FROM act_artifact_registry_view WHERE runtime = ?").all(runtime)
    : db.query("SELECT * FROM act_artifact_registry_view").all()) as Array<Record<string, unknown>>;
  return rows.map(rowToActArtifact);
};

/** Routing ranking — score × (1 - residual_mean). Phase B+ adds cosine. */
export const artifactRouting = (db: Database, runtime?: string): ArtifactRoutingRow[] => {
  const rows = (runtime
    ? db
        .query(
          "SELECT ca.*, ar.routing_score FROM artifact_routing_view ar JOIN act_artifact ca ON ar.id = ca.id WHERE ca.runtime = ? ORDER BY ar.routing_score DESC",
        )
        .all(runtime)
    : db
        .query(
          "SELECT ca.*, ar.routing_score FROM artifact_routing_view ar JOIN act_artifact ca ON ar.id = ca.id ORDER BY ar.routing_score DESC",
        )
        .all()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ ...rowToActArtifact(r), routing_score: r.routing_score as number }));
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
 *  `past_due` boolean (true when next_review_due ≤ now-at-query-time).
 *  Projects every rolling_active row so operators can inspect future
 *  reviews; TS-side callers (rolling_reviewer.ts) filter on next_review_due. */
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
 *  full event `payload` is retained so callers reading payload-shape fields
 *  (`from_directive`, etc.) work without extra projection plumbing. */
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

/** Normalized entity graph edges from stakeholder declarations and directive interference. */
export const entityRelationshipRows = (db: Database, directiveId?: string): EntityRelationshipRow[] => {
  const rows = (directiveId
    ? db.query("SELECT * FROM entity_relationship_view WHERE directive_id = ? ORDER BY ts DESC").all(directiveId)
    : db.query("SELECT * FROM entity_relationship_view ORDER BY ts DESC").all()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    event_id: r.event_id as string,
    ts: r.ts as string,
    directive_id: r.directive_id as string,
    from_entity: (r.from_entity as string | null) ?? null,
    to_entity: (r.to_entity as string | null) ?? null,
    relationship: (r.relationship as string | null) ?? null,
    relationship_payload: parseMaybeJson(r.relationship_payload),
    payload: parseJson<Record<string, unknown>>(r.payload),
    source_kind: r.source_kind as string,
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
    auto_apply_gate_event_id: (r.auto_apply_gate_event_id as string | null) ?? null,
    auto_apply_gate_residual: (r.auto_apply_gate_residual as number | null) ?? null,
    freshness_residual: (r.freshness_residual as number | null) ?? null,
    semantic_duplicate_residual: (r.semantic_duplicate_residual as number | null) ?? null,
    behavioral_novelty_residual: (r.behavioral_novelty_residual as number | null) ?? null,
    necessity_residual: (r.necessity_residual as number | null) ?? null,
    adversarial_residual: (r.adversarial_residual as number | null) ?? null,
    auto_apply_gate_breakdown: parseJson<Record<string, unknown>>(r.auto_apply_gate_breakdown ?? '{}'),
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

export type PendingOwnerDecisionRow = {
  group_key: string;
  target: string | null;
  anchor: string | null;
  duplicate_count: number;
  /** 2026-05-17 (k_88ESCTN8XN6J): provenance signal. Tells the TUI
   *  whether the brain explicitly demanded owner consent
   *  ('owner_consent_explicit') or whether the apply-gate classified
   *  the proposal as needing manual review ('manual_review_implicit').
   *  The latter is the much larger bucket — patches that match no
   *  safe-auto-apply policy, are unstructured, or have trajectory
   *  hazards. */
  gate_source: "owner_consent_explicit" | "manual_review_implicit";
  representative_event_id: string;
  oldest_ts: string;
  newest_ts: string;
  shape_quality_score: number;
  target_risk_score: number;
  staleness_score: number;
  group_decline_reason: string | null;
  decision_rank: number;
};

/** Ranked, de-duplicated owner-decision inbox — LIVE projection.
 *  2026-05-19 (KCs YKJYRGVJJX21XAMQS042PMK7JG +
 *  G3CBVAGY2S5QN5XDC1GR7GJP0G): excludes source_event_ids that the
 *  pending_decision_retire_worker has already retired
 *  (test_file_target, anchor_missing, stale). Operator-facing CLI
 *  (`acc admin pending-decisions`) projects through this. The
 *  historical pendingOwnerDecisionQueue() projection below stays
 *  for audit. */
export const pendingOwnerDecisionQueueLive = (db: Database): PendingOwnerDecisionRow[] => {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db
      .query("SELECT * FROM pending_owner_decision_queue_live_view")
      .all() as Array<Record<string, unknown>>;
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (!/malformed JSON/i.test(msg)) throw err;
    rows = db
      .query("SELECT * FROM pending_owner_decision_queue_live_view WHERE 1=0")
      .all() as Array<Record<string, unknown>>;
  }
  return rows.map((r) => ({
    group_key: r.group_key as string,
    target: (r.target as string | null) ?? null,
    anchor: (r.anchor as string | null) ?? null,
    duplicate_count: (r.duplicate_count as number) ?? 0,
    gate_source: ((r.gate_source as string | null) ?? "manual_review_implicit") as PendingOwnerDecisionRow["gate_source"],
    representative_event_id: r.representative_event_id as string,
    oldest_ts: r.oldest_ts as string,
    newest_ts: r.newest_ts as string,
    shape_quality_score: (r.shape_quality_score as number) ?? 0,
    target_risk_score: (r.target_risk_score as number) ?? 0,
    staleness_score: (r.staleness_score as number) ?? 0,
    group_decline_reason: (r.group_decline_reason as string | null) ?? null,
    decision_rank: (r.decision_rank as number) ?? 0,
  }));
};

/** Ranked, de-duplicated owner-decision inbox — HISTORICAL projection.
 *  Includes every pending row regardless of pending_decision_retired
 *  state, so audit tooling can reconstruct what the operator was
 *  presented with at the time. The CLI's `--include-retired` flag
 *  reaches for THIS function; the default surface uses the LIVE view
 *  above. Rows where every member is a decline candidate carry a
 *  non-null group_decline_reason so the CLI can offer a one-shot
 *  auto-decline. */
export const pendingOwnerDecisionQueue = (db: Database): PendingOwnerDecisionRow[] => {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db
      .query("SELECT * FROM pending_owner_decision_queue_view")
      .all() as Array<Record<string, unknown>>;
  } catch (err) {
    // Defensive fallback: production substrates accumulate occasional
    // events whose payload column isn't strict JSON (legacy seeds, truncated
    // bridge frames). The view's json_extract chains throw SQLITE
    // "malformed JSON" on those rows and that propagated up as the entire
    // query failing — which made the TUI's Inbox panel render zero rows
    // against a real queue. The SQL fix lives at the SOURCE CTE (filter
    // by json_valid(payload)); this helper is the runtime fallback so an
    // operator never sees a totally-blank inbox just because ONE event has
    // a bad payload.
    const msg = (err as Error).message ?? "";
    if (!/malformed JSON/i.test(msg)) throw err;
    rows = db
      .query("SELECT * FROM pending_owner_decision_queue_view WHERE 1=0")
      .all() as Array<Record<string, unknown>>;
  }
  return rows.map((r) => ({
    group_key: r.group_key as string,
    target: (r.target as string | null) ?? null,
    anchor: (r.anchor as string | null) ?? null,
    duplicate_count: (r.duplicate_count as number) ?? 0,
    gate_source: ((r.gate_source as string | null) ?? "manual_review_implicit") as PendingOwnerDecisionRow["gate_source"],
    representative_event_id: r.representative_event_id as string,
    oldest_ts: r.oldest_ts as string,
    newest_ts: r.newest_ts as string,
    shape_quality_score: (r.shape_quality_score as number) ?? 0,
    target_risk_score: (r.target_risk_score as number) ?? 0,
    staleness_score: (r.staleness_score as number) ?? 0,
    group_decline_reason: (r.group_decline_reason as string | null) ?? null,
    decision_rank: (r.decision_rank as number) ?? 0,
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
      const p = JSON.parse(d.payload) as { goal?: unknown; intent?: unknown; directive_text?: unknown };
      goal = String((p.goal ?? p.intent ?? p.directive_text ?? "") as string);
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

export type RecipesLatestRow = {
  id: string;
  goal_shape: string;
  topology_signature: string;
  confidence: number;
  payload: Record<string, unknown>;
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

/** Latest recipe-shape knowledge row (knowledge_candidate / knowledge_promoted
 *  carrying recipe_shape.enabled) per recipe key, ordered newest first. */
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

/** Highest-confidence recipe-shape knowledge row per
 *  (goal_shape, topology_signature) pair. Materialized index for
 *  runtime/recipe_replay.ts: replaces the dispatch-time linear scan over
 *  recipe-shape knowledge history with one keyed projection. Ties on
 *  confidence are broken by ts DESC then rowid DESC (most recent wins).
 *  Rows whose goal_shape or topology_signature is NULL are dropped — the
 *  matcher can't key off absent fields. Closes brain audit
 *  QQEHAW97GS0AX7TEQ717Y3P174 (2026-05-15). */
export const recipesLatestView = (db: Database): RecipesLatestRow[] => {
  const rows = db
    .query(
      `SELECT id, goal_shape, topology_signature, confidence, payload
       FROM recipes_latest_view
       WHERE goal_shape IS NOT NULL AND topology_signature IS NOT NULL
       ORDER BY goal_shape ASC, topology_signature ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    goal_shape: r.goal_shape as string,
    topology_signature: r.topology_signature as string,
    confidence: (r.confidence as number) ?? 0,
    payload: parseJson<Record<string, unknown>>(r.payload ?? "{}"),
  }));
};

// F11 (2026-05-18, contract 2AMJKN0GTX32790173EPYH6YT4): row shape returned
// by pending_contract_amendments_view. Consumed by
// runtime/contract_amendment_consumer.ts and the OUTSTANDING CONTRACT
// AMENDMENTS prompt_composer section.
export type PendingContractAmendmentRow = {
  proposal_id: string;
  ts: string;
  directive_id: string | null;
  task_id: string | null;
  target_resource: string | null;
  predicate: string | null;
  /** Parsed JSON array of target file paths. NULL when the proposal
   *  omitted proposed_behavior.target_files. */
  target_files: string[] | null;
  /** Parsed JSON array of dependency strings. NULL when omitted. */
  dependencies: unknown[] | null;
  payload: Record<string, unknown>;
  context_refs: string[];
  age_ms: number;
  supersession_state: "live" | "superseded_by";
  newer_proposal_id: string | null;
  latest_closure_verdict: string | null;
  latest_closure_event_id: string | null;
  has_applied_change: boolean;
  dependency_count: number;
  open_dependency_count: number;
  dependencies_closed: boolean;
  missing_fields: string[];
  triage_state: "ready_for_implementation" | "unscored" | "blocked_by_dependencies" | "blocked_by_residual" | "closure_obsolete_supersession" | string;
  triage_reason: string;
  selection_priority: number;
  selection_rank: number;
  latest_action_scored_event_id: string | null;
  latest_action_residual: number | null;
};

export const pendingContractAmendments = (
  db: Database,
  opts?: { limit?: number; directiveId?: string },
): PendingContractAmendmentRow[] => {
  const limit = opts?.limit ?? 200;
  const directiveId = opts?.directiveId;
  const rows = directiveId
    ? db
        .query(
          "SELECT * FROM pending_contract_amendments_view WHERE directive_id = ? ORDER BY selection_rank ASC LIMIT ?",
        )
        .all(directiveId, limit) as Array<Record<string, unknown>>
    : db
        .query("SELECT * FROM pending_contract_amendments_view ORDER BY selection_rank ASC LIMIT ?")
        .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    let targetFiles: string[] | null = null;
    const rawTf = r.target_files;
    if (typeof rawTf === "string" && rawTf.length > 0) {
      try {
        const parsed = JSON.parse(rawTf) as unknown;
        if (Array.isArray(parsed)) targetFiles = parsed.filter((x): x is string => typeof x === "string");
      } catch { /* malformed JSON → null */ }
    }
    let dependencies: unknown[] | null = null;
    const rawDeps = r.dependencies;
    if (typeof rawDeps === "string" && rawDeps.length > 0) {
      try {
        const parsed = JSON.parse(rawDeps) as unknown;
        if (Array.isArray(parsed)) dependencies = parsed;
      } catch { /* malformed JSON → null */ }
    }
    const missingFields = parseMaybeJson(r.missing_fields ?? "[]");
    return {
      proposal_id: r.proposal_id as string,
      ts: r.ts as string,
      directive_id: (r.directive_id as string | null) ?? null,
      task_id: (r.task_id as string | null) ?? null,
      target_resource: (r.target_resource as string | null) ?? null,
      predicate: (r.predicate as string | null) ?? null,
      target_files: targetFiles,
      dependencies,
      payload: parseJson<Record<string, unknown>>(r.payload ?? "{}"),
      context_refs: parseJson<string[]>(r.context_refs ?? "[]"),
      age_ms: (r.age_ms as number) ?? 0,
      supersession_state: (r.supersession_state as "live" | "superseded_by") ?? "live",
      newer_proposal_id: (r.newer_proposal_id as string | null) ?? null,
      latest_closure_verdict: (r.latest_closure_verdict as string | null) ?? null,
      latest_closure_event_id: (r.latest_closure_event_id as string | null) ?? null,
      has_applied_change: ((r.has_applied_change as number) ?? 0) === 1,
      dependency_count: (r.dependency_count as number) ?? 0,
      open_dependency_count: (r.open_dependency_count as number) ?? 0,
      dependencies_closed: ((r.dependencies_closed as number) ?? 0) === 1,
      missing_fields: Array.isArray(missingFields) ? missingFields.filter((x): x is string => typeof x === "string") : [],
      triage_state: (r.triage_state as PendingContractAmendmentRow["triage_state"]) ?? "unscored",
      triage_reason: (r.triage_reason as string | null) ?? "",
      selection_priority: (r.selection_priority as number) ?? 0,
      selection_rank: (r.selection_rank as number) ?? 0,
      latest_action_scored_event_id: (r.latest_action_scored_event_id as string | null) ?? null,
      latest_action_residual: typeof r.latest_action_residual === "number"
        ? (r.latest_action_residual as number)
        : (typeof r.latest_action_residual === "string" && r.latest_action_residual.length > 0
          ? Number.parseFloat(r.latest_action_residual)
          : null),
    };
  });
};

// ── directive_view accessor (v2-design §4.2 line 589) ─────────────

export type DirectiveRow = {
  directive_id: string;
  directive_event_id: string;
  opened_ts: string;
  directive_text: string | null;
  lifecycle: string;
  urgency: string;
  root_task_id: string | null;
  root_opened_ts: string | null;
  /** task_committed | task_failed | task_abandoned, or null while the
   *  root task is still live. */
  status: string | null;
  status_ts: string | null;
};

/** Read directive_view. When `directiveId` is supplied, returns at
 *  most one row for that directive; otherwise returns every directive
 *  ordered newest-first by opened_ts. */
export const directives = (db: Database, directiveId?: string): DirectiveRow[] => {
  const rows = (directiveId
    ? db.query("SELECT * FROM directive_view WHERE directive_id = ?").all(directiveId)
    : db.query("SELECT * FROM directive_view ORDER BY opened_ts DESC").all()
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    directive_id: r.directive_id as string,
    directive_event_id: r.directive_event_id as string,
    opened_ts: r.opened_ts as string,
    directive_text: (r.directive_text as string | null) ?? null,
    lifecycle: (r.lifecycle as string) ?? "finite",
    urgency: (r.urgency as string) ?? "normal",
    root_task_id: (r.root_task_id as string | null) ?? null,
    root_opened_ts: (r.root_opened_ts as string | null) ?? null,
    status: (r.status as string | null) ?? null,
    status_ts: (r.status_ts as string | null) ?? null,
  }));
};

// ── task_critical_path_view accessor (v2-design §4.2 line 592) ────

export type TaskCriticalPathRow = {
  directive_id: string;
  critical_path_length: number;
  /** Arrow-joined task_id chain from longest-leaf back to root,
   *  e.g. `taskA->taskB->taskRoot`. */
  path: string;
};

export const taskCriticalPaths = (db: Database, directiveId?: string): TaskCriticalPathRow[] => {
  const rows = (directiveId
    ? db.query("SELECT * FROM task_critical_path_view WHERE directive_id = ?").all(directiveId)
    : db.query("SELECT * FROM task_critical_path_view ORDER BY critical_path_length DESC").all()
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    directive_id: r.directive_id as string,
    critical_path_length: Number(r.critical_path_length ?? 0),
    path: (r.path as string) ?? "",
  }));
};

// ── active_inference_view accessor (v2-design §4.2 line 595) ──────

export type ActiveInferenceRow = {
  substrate_origin: string;
  action_artifact_id: string | null;
  scored_count: number;
  avg_residual: number | null;
  min_residual: number | null;
  max_residual: number | null;
  latest_ts: string | null;
};

export const activeInference = (db: Database): ActiveInferenceRow[] => {
  const rows = db
    .query("SELECT * FROM active_inference_view ORDER BY scored_count DESC")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    substrate_origin: r.substrate_origin as string,
    action_artifact_id: (r.action_artifact_id as string | null) ?? null,
    scored_count: Number(r.scored_count ?? 0),
    avg_residual: r.avg_residual == null ? null : Number(r.avg_residual),
    min_residual: r.min_residual == null ? null : Number(r.min_residual),
    max_residual: r.max_residual == null ? null : Number(r.max_residual),
    latest_ts: (r.latest_ts as string | null) ?? null,
  }));
};

// ── artifact_warning_view accessor (v2-design §4.2 line 597) ──────

export type ArtifactWarningRow = {
  artifact_id: string;
  runtime: string;
  artifact_kind: string;
  name: string | null;
  status: string;
  recent_kill_count: number;
  recent_residual_mean: number;
  score: number;
  confidence: number;
  status_at_ts: string;
  rehabilitation_eligible_at: string | null;
  /** retired_terminal | eligible | cooldown | na */
  eligibility_status: string;
};

export const artifactWarnings = (db: Database): ArtifactWarningRow[] => {
  const rows = db
    .query("SELECT * FROM artifact_warning_view")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    artifact_id: r.artifact_id as string,
    runtime: r.runtime as string,
    artifact_kind: (r.artifact_kind as string) ?? "act_artifact",
    name: (r.name as string | null) ?? null,
    status: r.status as string,
    recent_kill_count: Number(r.recent_kill_count ?? 0),
    recent_residual_mean: Number(r.recent_residual_mean ?? 0),
    score: Number(r.score ?? 0),
    confidence: Number(r.confidence ?? 0),
    status_at_ts: r.status_at_ts as string,
    rehabilitation_eligible_at: (r.rehabilitation_eligible_at as string | null) ?? null,
    eligibility_status: (r.eligibility_status as string) ?? "na",
  }));
};

// ── model_routing_view accessor (v2-design §4.2 line 598) ─────────

export type ModelRoutingRow = {
  model: string;
  /** task_committed | task_failed | task_abandoned | dispatcher_violation | <open> */
  terminal_kind: string;
  n: number;
  latest_dispatched_ts: string | null;
  latest_terminal_ts: string | null;
};

export const modelRouting = (db: Database): ModelRoutingRow[] => {
  const rows = db
    .query("SELECT * FROM model_routing_view ORDER BY model, n DESC")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    model: r.model as string,
    terminal_kind: r.terminal_kind as string,
    n: Number(r.n ?? 0),
    latest_dispatched_ts: (r.latest_dispatched_ts as string | null) ?? null,
    latest_terminal_ts: (r.latest_terminal_ts as string | null) ?? null,
  }));
};
