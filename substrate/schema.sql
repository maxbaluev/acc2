-- acc2 substrate schema — one events table, one code_artifact registry,
-- one meta key/value. Views and extractors are out of scope for Phase B1.

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
CREATE INDEX IF NOT EXISTS idx_events_task_kind_ts            ON events(task_id, kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_directive_kind_ts       ON events(directive_id, kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_action_artifact_kind_ts ON events(action_artifact_id, kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_projection_key          ON events(json_extract(payload, '$.projection_key'))
  WHERE json_extract(payload, '$.projection_key') IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_embedding_version       ON events(embedding_version);

-- ── code_artifact ──────────────────────────────────────────────────
-- Registry row per LATM/Voyager artifact. declared_sandbox + fixture_input
-- are JSON-encoded TEXT (shape mirrors SandboxDecl / JsonValue from
-- substrate/types.ts). embedding is a raw float32 BLOB. status starts at
-- 'admitted' once the fixture passes; transitions to 'quarantined' or
-- 'promoted' via posterior thresholds (§11.5, §11.6).
CREATE TABLE IF NOT EXISTS code_artifact (
  id                          TEXT PRIMARY KEY,
  runtime                     TEXT NOT NULL,
  body                        TEXT NOT NULL,
  declared_sandbox            TEXT NOT NULL,
  state_root                  TEXT NOT NULL,
  -- L8 (2026-05-17, brain design 48SN4XF3WN4KBBCHHCANDRDQRW act_artifact
  -- registry rename): free-string discriminator for the row's purpose.
  -- Default 'code_artifact' for legacy rows; new typed rows declare
  -- their own (e.g. 'dispatch_strategy_v1' for the 6 seed strategy
  -- priors). The full rename of the TABLE to act_artifact is deferred —
  -- adding the column first lets consumers transition incrementally
  -- (dispatch_strategy_ranker queries kind='dispatch_strategy_v1' AND
  -- state_root='dispatch/strategy' as overlapping discriminators; the
  -- state_root path can be retired later).
  kind                        TEXT NOT NULL DEFAULT 'code_artifact',
  posterior_alpha             REAL NOT NULL DEFAULT 1.0,
  posterior_beta              REAL NOT NULL DEFAULT 1.0,
  score                       REAL NOT NULL DEFAULT 0.5,
  confidence                  REAL NOT NULL DEFAULT 0.3,
  embedding                   BLOB,
  recent_residual_mean        REAL NOT NULL DEFAULT 0.0,
  recent_kill_count           INTEGER NOT NULL DEFAULT 0,
  status                      TEXT NOT NULL DEFAULT 'admitted',
  name                        TEXT,
  fixture_input               TEXT NOT NULL,
  fixture_expected_residual   REAL NOT NULL,
  -- Brain dataflow audit bxdhdkm9e #3 (2026-05-15): per-artifact
  -- provenance + intent metadata that the brain emits on
  -- code_artifact_candidate but the admission path used to drop.
  -- Operators can now see WHY an artifact exists, WHAT it touches,
  -- and WHICH owner gate (if any) approved it. NULL-allowed because
  -- legacy seeded artifacts pre-date these fields.
  intent                      TEXT,
  summary                     TEXT,
  target_files                TEXT,          -- JSON array of repo paths; kept for repo: parity
  target_resources            TEXT,          -- JSON array of ResourceUri strings
  source_candidate_id         TEXT,
  owner_gate_verdict          TEXT,          -- 'auto' | 'owner_approved' | 'owner_rejected' | NULL
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_code_artifact_runtime ON code_artifact(runtime);
CREATE INDEX IF NOT EXISTS idx_code_artifact_status  ON code_artifact(status);
CREATE INDEX IF NOT EXISTS idx_code_artifact_score   ON code_artifact(score DESC);
CREATE INDEX IF NOT EXISTS idx_code_artifact_kind    ON code_artifact(kind);

-- ── sqlite-vec virtual table: canonical embedding index ────────────
-- Per v2-design.md §3.6.1 Rule 1 (embedding-based candidate dedup) and
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
