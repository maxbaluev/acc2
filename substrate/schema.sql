-- acc2 substrate schema — one events table, one act_artifact registry,
-- one meta key/value. Views and extractors are out of scope for Phase B1.
--
-- F4a (2026-05-18, roadmap WW7W1NZ8A10R52PB4E7EJE9YBW): the polymorphic
-- handle registry was historically named `code_artifact` because the first
-- inhabitants were bun/uv/camofox runtime scripts. The registry now holds
-- letters, prompts, verifiers, decompositions, asker patterns, research
-- patterns, recipes, observation patterns, goal predicates, and dispatch
-- strategies — every reusable scored handle. The table is therefore
-- `act_artifact`; CLAUDE.md design intent ("act_artifact (the renamed
-- code_artifact)") materializes here. Production DBs migrate via
-- runMigrations() in db.ts: ALTER TABLE code_artifact RENAME TO act_artifact
-- plus index/view rebuilds. Fresh installs land here directly.

-- ── meta ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ── events ─────────────────────────────────────────────────────────
-- Append-only immutable fact ledger. id is a ULID (TEXT). Every column
-- after the eight required ones is optional and lifted from Event in
-- substrate/types.ts. payload + context_refs are JSON-encoded TEXT.
-- embedding is a raw float32 BLOB.
--
-- DEPRECATED — events.embedding (and events.embedding_version):
-- Replaced by the vec_events virtual table at the bottom of this file
-- (sqlite-vec / vec0). The BLOB column stays for one cutover window
-- so we can compare new sqlite-vec retrieval results against the old
-- in-memory linear-scan during parity testing. A follow-up phase drops
-- the column entirely. New code should NOT read events.embedding for
-- retrieval — query vec_events instead.
CREATE TABLE IF NOT EXISTS events (
  id                    TEXT PRIMARY KEY,
  ts                    TEXT NOT NULL,
  directive_id          TEXT NOT NULL,
  task_id               TEXT NOT NULL,
  parent_task_id        TEXT,
  loop_id               TEXT NOT NULL,
  substrate_origin      TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  payload               TEXT NOT NULL,
  context_refs          TEXT NOT NULL DEFAULT '[]',
  predicted_residual    REAL,
  action_artifact_id    TEXT,
  verifier_artifact_id  TEXT,
  outcome               TEXT,
  residual              REAL,
  embedding             BLOB,
  embedding_version     TEXT,
  payload_hash          TEXT,
  blob_ref              TEXT,
  failure_kind          TEXT,
  invoker               TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_kind_ts                 ON events(kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts                      ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_task_kind_ts            ON events(task_id, kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_directive_kind_ts       ON events(directive_id, kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_action_artifact_kind_ts ON events(action_artifact_id, kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_projection_key          ON events(json_extract(payload, '$.projection_key'))
  WHERE json_extract(payload, '$.projection_key') IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_embedding_version       ON events(embedding_version);
-- Composite partial index for the embedder's "find next unembedded
-- embeddable rows" query (runtime/embedder.ts:readUnembedded). Without
-- this index, WHERE embedding IS NULL AND kind IN (10 kinds) ORDER BY ts
-- scans the full events table to find ~1543 matches in a 280K-row DB.
-- The partial index (only rows where embedding IS NULL) keeps it tiny:
-- once a row is embedded, it leaves the index. Cite FAWT1B3BT56S +
-- T6EQS07X6X0V (phantom-backlog diagnosis).
CREATE INDEX IF NOT EXISTS idx_events_unembedded_by_ts
  ON events(kind, ts)
  WHERE embedding IS NULL;
-- Composite index for the owner_autonomy autonomy loop's "recent events by this
-- origin" query (runtime/owner_autonomy.ts:857 — SELECT … WHERE substrate_origin = ?
-- ORDER BY ts DESC LIMIT N). Without it the planner satisfies the ORDER BY
-- via idx_events_ts and then row-filters substrate_origin, walking the bulk
-- of the table (substrate_auto is ~78% of rows) to collect N owner_autonomy rows.
-- EXPLAIN on the 374K-row live-DB copy: SCAN events USING INDEX idx_events_ts
-- → SEARCH events USING INDEX idx_events_origin_ts (substrate_origin=?),
-- 12.3ms → 0.16ms per call (~77x). The (substrate_origin, ts) order serves
-- both the equality filter and the ts-desc tiebreak as a single seek.
CREATE INDEX IF NOT EXISTS idx_events_origin_ts
  ON events(substrate_origin, ts);

-- trajectory_motif_extractor scans `WHERE ts > cutoff ORDER BY directive_id, ts,
-- rowid LIMIT 5000` per tick (the heaviest extractor tick). idx_events_ts serves
-- the ts filter but the directive_id-first sort order forced USE TEMP B-TREE FOR
-- ORDER BY over the whole 30d window. idx_events_directive_kind_ts puts `kind` in
-- the middle so it can't serve a (directive_id, ts) order. EXPLAIN on the 374K-row
-- live-DB copy: 186ms (SCAN + temp b-tree) → 14ms (SEARCH USING INDEX), ~13x,
-- byte-identical result set. The (directive_id, ts) order serves the sort directly.
CREATE INDEX IF NOT EXISTS idx_events_directive_ts
  ON events(directive_id, ts);

-- prompt_composer.readRecentFailures runs on EVERY dispatch:
-- `SELECT failure_kind, ts FROM events WHERE failure_kind IS NOT NULL ORDER BY ts DESC LIMIT 3`.
-- Pre-fix: SCAN events USING INDEX idx_events_ts (walk ts index backwards,
-- filter on the unindexed failure_kind column, reject ~374K rows). A partial
-- (failure_kind, ts) index (only ~322 non-null rows) makes it a covering SEARCH
-- seek. EXPLAIN on the 374K-row live-DB copy: 10.7ms → 0.16ms (~67x), identical
-- result set. Partial WHERE keeps the index tiny.
CREATE INDEX IF NOT EXISTS idx_events_failure_kind_ts
  ON events(failure_kind, ts) WHERE failure_kind IS NOT NULL;

-- open_directive dedup (findOpenDirectiveByText in
-- runtime/mcp_server/substrate_tools.ts) runs on EVERY directive open:
-- `SELECT directive_id FROM events WHERE kind='directive_opened'
--  AND json_extract(payload,'$.directive_text') = ? AND directive_id NOT IN (…)`.
-- Pre-fix the dedup leaned on idx_events_kind_ts (kind=?), seeking ALL
-- directive_opened rows and applying the json_extract(directive_text) equality
-- as a per-row filter — effectively a scan of every directive_opened row plus a
-- json parse each. On the 400K-row events table that hogged a SQL-worker-pool
-- slot for seconds; during a dispatch burst (find_recipe + vec0 KNN +
-- open_directive + brain reads on the 10-worker pool) it queued 50s+ (loop lag
-- stayed low → pool starvation, not an event-loop block; ACC2_PROFILE_LOOP=1
-- showed open_directive up to 56s). A partial expression index keyed on
-- (json_extract(...,'$.directive_text'), ts) restricted to directive_opened
-- rows turns the dedup into a point SEARCH on directive_text — the (expr, ts)
-- order also serves the ORDER BY ts ASC tiebreak so the planner prefers it over
-- idx_events_kind_ts (which would otherwise win by avoiding a temp sort). A bare
-- (expr) index loses that tie; including ts is what makes the planner pick it.
-- Partial WHERE keeps it tiny (only directive_opened rows). Transparent —
-- identical dedup results, just a point seek instead of a per-row filter.
-- EXPLAIN: SEARCH events USING INDEX idx_events_kind_ts (kind=?) →
-- SEARCH events USING INDEX idx_events_directive_text_opened (<expr>=?).
CREATE INDEX IF NOT EXISTS idx_events_directive_text_opened
  ON events(json_extract(payload, '$.directive_text'), ts)
  WHERE kind = 'directive_opened';

-- World-model projection hot paths. Storage deliberately reuses the append-only
-- event ledger: state_snapshot_recorded carries the current model, and
-- state_snapshot_diffed carries model deltas. These partial indexes are the
-- irreducible schema migration for first-class reads; no side table owns state.
CREATE INDEX IF NOT EXISTS idx_events_world_model_snapshot_task_ts
  ON events(task_id, ts)
  WHERE kind = 'state_snapshot_recorded'
    AND (json_extract(payload, '$.snapshot_kind') = 'world_model'
      OR json_type(payload, '$.world_model') IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_world_model_delta_task_ts
  ON events(task_id, ts)
  WHERE kind = 'state_snapshot_diffed'
    AND (json_extract(payload, '$.diff_kind') = 'world_model'
      OR json_type(payload, '$.world_model_delta') IS NOT NULL);

-- Writer-maintained rollups keep occurrence/health reads bounded while the hot
-- events ledger is compacted. total_count is lifetime; live_count tracks rows
-- still present in events after archive/telemetry deletion.
CREATE TABLE IF NOT EXISTS event_kind_rollup (
  kind        TEXT PRIMARY KEY,
  total_count INTEGER NOT NULL DEFAULT 0,
  live_count  INTEGER NOT NULL DEFAULT 0,
  first_ts    TEXT NOT NULL,
  last_ts     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_day_kind_rollup (
  day         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  live_count  INTEGER NOT NULL DEFAULT 0,
  first_ts    TEXT NOT NULL,
  last_ts     TEXT NOT NULL,
  PRIMARY KEY (day, kind)
);
CREATE TABLE IF NOT EXISTS event_kind_origin_rollup (
  kind             TEXT NOT NULL,
  substrate_origin TEXT NOT NULL,
  PRIMARY KEY (kind, substrate_origin)
);
CREATE TABLE IF NOT EXISTS event_archive_summary (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  bucket     TEXT NOT NULL,
  count      INTEGER NOT NULL,
  first_ts   TEXT NOT NULL,
  last_ts    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_archive_summary_kind_bucket
  ON event_archive_summary(kind, bucket);

-- Retained aggregate for origin_calibration_recorded rows evicted after their
-- short raw-debug TTL. Counts and sums preserve calibration signal; bucket
-- dimensions preserve histograms without retaining every raw telemetry row.
CREATE TABLE IF NOT EXISTS telemetry_origin_calibration_rollup (
  origin                              TEXT NOT NULL,
  role                                TEXT NOT NULL,
  predicted_bucket                    TEXT NOT NULL,
  observed_bucket                     TEXT NOT NULL,
  error_bucket                        TEXT NOT NULL,
  count                               INTEGER NOT NULL DEFAULT 0,
  predicted_confidence_sum            REAL NOT NULL DEFAULT 0,
  observed_success_probability_sum    REAL NOT NULL DEFAULT 0,
  calibration_error_sum               REAL NOT NULL DEFAULT 0,
  first_ts                            TEXT NOT NULL,
  last_ts                             TEXT NOT NULL,
  PRIMARY KEY (origin, role, predicted_bucket, observed_bucket, error_bucket)
);

-- ── act_artifact ───────────────────────────────────────────────────
-- Registry row per polymorphic artifact handle. declared_sandbox +
-- fixture_input are JSON-encoded TEXT (shape mirrors SandboxDecl /
-- JsonValue from substrate/types.ts). embedding is a raw float32 BLOB.
-- status starts at 'admitted' once the fixture passes; transitions to
-- 'quarantined' or 'promoted' via posterior thresholds (§11.5, §11.6).
CREATE TABLE IF NOT EXISTS act_artifact (
  id                          TEXT PRIMARY KEY,
  runtime                     TEXT,
  body                        TEXT NOT NULL,
  declared_sandbox            TEXT,
  state_root                  TEXT,
  -- L8 (2026-05-17, brain design 48SN4XF3WN4KBBCHHCANDRDQRW act_artifact
  -- registry rename): free-string discriminator for the row's purpose.
  -- Default 'runtime_action' for generic actions; typed rows declare
  -- their own (e.g. 'dispatch_strategy_v1' for the 6 seed strategy
  -- priors, 'published_drive_doc' for owner-visible artifacts).
  -- Historical rows admitted before F4a may carry the legacy
  -- 'code_artifact' default; the kind column is a string, not an enum,
  -- so both values coexist without migration of row data.
  kind                        TEXT NOT NULL DEFAULT 'runtime_action',
  posterior_alpha             REAL NOT NULL DEFAULT 1.0,
  posterior_beta              REAL NOT NULL DEFAULT 1.0,
  score                       REAL NOT NULL DEFAULT 0.5,
  confidence                  REAL NOT NULL DEFAULT 0.3,
  embedding                   BLOB,
  recent_residual_mean        REAL NOT NULL DEFAULT 0.0,
  recent_kill_count           INTEGER NOT NULL DEFAULT 0,
  status                      TEXT NOT NULL DEFAULT 'admitted',
  name                        TEXT,
  fixture_input               TEXT,
  fixture_expected_residual   REAL,
  -- Brain dataflow audit bxdhdkm9e #3 (2026-05-15): per-artifact
  -- provenance + intent metadata that the brain emits on
  -- act_artifact_candidate but the admission path used to drop.
  -- Operators can now see WHY an artifact exists, WHAT it touches,
  -- and WHICH owner gate (if any) approved it. NULL-allowed because
  -- legacy seeded artifacts pre-date these fields.
  intent                      TEXT,
  summary                     TEXT,
  target_files                TEXT,          -- JSON array of repo paths; kept for repo: parity
  target_resources            TEXT,          -- JSON array of ResourceUri strings
  source_candidate_id         TEXT,
  owner_gate_verdict          TEXT,          -- 'auto' | 'owner_approved' | 'owner_rejected' | NULL
  -- C5 (2026-05-18, contract HJJS1665H961B2SRYHC5J85D14):
  -- artifact provenance chain. supersedes / superseded_by point to a
  -- prior / successor artifact_id (both nullable). lost_version_count
  -- annotates artifacts whose external resource (e.g. Drive doc) was
  -- destructively trashed before the substrate could record a chain —
  -- partial provenance backfill placeholders. Non-destructive by
  -- default: new published_drive_doc admission only flips the prior
  -- artifact's superseded_by; trashing the external Drive doc remains
  -- an explicit owner action.
  supersedes                  TEXT,
  superseded_by               TEXT,
  lost_version_count          INTEGER NOT NULL DEFAULT 0,
  -- UNIVERSAL_ (2026-05-24, directive 3XETJCYT, kc BD86CJ6HQS): first-
  -- class, domain-NEUTRAL interface metadata so the substrate (and the
  -- brain) can UNDERSTAND what an artifact does, WHEN to use it, and HOW
  -- to call it — for ANY human goal, not just code. One nullable JSON
  -- column (a polymorphic payload field, per Architecture.md "add
  -- capability vocabulary by admitting rows/payload, not fixed enums")
  -- holding an open-ended descriptor: purpose, goal_shapes,
  -- usage_examples, preconditions, effects, cost_profile,
  -- reliability_profile, inputs_schema, outputs_schema. Every field is
  -- optional and domain-neutral — it describes a Telegram action, a
  -- browser flow, a calendar handle, a checklist, a contact, AND a
  -- script equally. NULL for legacy rows admitted before this column
  -- (backward-compatible: missing-metadata artifacts still admit + run).
  interface_metadata          TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_act_artifact_runtime ON act_artifact(runtime);
CREATE INDEX IF NOT EXISTS idx_act_artifact_status  ON act_artifact(status);
CREATE INDEX IF NOT EXISTS idx_act_artifact_score   ON act_artifact(score DESC);
CREATE INDEX IF NOT EXISTS idx_act_artifact_kind    ON act_artifact(kind);

-- ── artifact_kind_metadata ─────────────────────────────────────────
-- F4c (2026-05-18, contract 897XTN2GF11XB9D4N45N2R9W58). Posterior-
-- scored grounding gates per artifact kind. needs_strategic_grounding
-- > 0.5 forces the substrate to require a `_strategic_direction_chosen`
-- citation before admitting a candidate of this kind. Seeded with the
-- legacy `atms_report_v*` prefix kinds at high prior; everything else
-- starts absent and learns through owner-rejection feedback.
-- ensureArtifactKindMetadataTable in artifact_kind_metadata.ts also
-- creates and seeds this table at openDb time so DBs predating this
-- schema row get the same shape.
CREATE TABLE IF NOT EXISTS artifact_kind_metadata (
  artifact_kind             TEXT PRIMARY KEY,
  needs_strategic_grounding REAL NOT NULL DEFAULT 0.0,
  posterior_alpha           REAL NOT NULL DEFAULT 1.0,
  posterior_beta            REAL NOT NULL DEFAULT 1.0,
  last_updated_ts           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_kind_metadata_needs_strategic
  ON artifact_kind_metadata(needs_strategic_grounding);
-- C5 provenance indexes (idx_act_artifact_supersedes /
-- idx_act_artifact_superseded_by) live in db.ts EVENT_HOT_PATH_INDEXES,
-- which runs AFTER runMigrations adds the supersedes / superseded_by
-- columns to pre-C5 tables via ALTER TABLE. Keeping the indexes in
-- schema.sql would break openDb() on any DB that predates C5:
-- runSchema() executes BEFORE runMigrations(), so CREATE INDEX would
-- reference a column that doesn't exist yet. db.ts is the single
-- source of truth for these indexes — see substrate/db.ts:113-114.

-- ── sqlite-vec virtual table: canonical embedding index ────────────
-- Per Architecture.md Rule 1 (embedding-based candidate dedup) and
-- §5.1 / §13.1 (depth-1 retrieval). vec_events is the SOLE embedding
-- index in v2. The `events.embedding` BLOB column above is kept as a
-- TRANSITIONAL field for one cutover window so we can compare new
-- sqlite-vec results against the old in-memory linear-scan during
-- parity testing. A follow-up phase drops the BLOB column.
--
-- Columns:
--   event_id          — primary key, FK-shaped reference to events.id.
--   embedding         — float[1536] (text-embedding-3-small).
--   kind              — plain metadata column: indexable, filterable in
--                       the WHERE clause of a KNN query.
--   ts                — plain metadata column: indexable, filterable.
--   embedding_version — plain metadata column: lets the reranker filter
--                       out stale-model rows in one SQL pass instead of
--                       walking every entry post-scan.
--
-- Note on aux columns: sqlite-vec 0.1.9's `+name` "auxiliary" syntax
-- DOES NOT allow WHERE constraints in KNN queries (errors with "illegal
-- WHERE constraint on a vec0 auxiliary column"). We use plain metadata
-- columns instead — they participate in WHERE filters at KNN time.
CREATE VIRTUAL TABLE IF NOT EXISTS vec_events USING vec0(
  event_id          TEXT PRIMARY KEY,
  embedding         float[1536],
  kind              TEXT,
  ts                TEXT,
  embedding_version TEXT
);
