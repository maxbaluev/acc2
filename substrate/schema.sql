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
-- embedding is a raw float32 BLOB so sqlite-vec virtual tables can read
-- it back without a copy.
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
  payload_hash          TEXT,
  blob_ref              TEXT,
  failure_kind          TEXT,
  invoker               TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_kind         ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_directive_id ON events(directive_id);
CREATE INDEX IF NOT EXISTS idx_events_task_id      ON events(task_id);
CREATE INDEX IF NOT EXISTS idx_events_ts           ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_action_aid   ON events(action_artifact_id);

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
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_code_artifact_runtime ON code_artifact(runtime);
CREATE INDEX IF NOT EXISTS idx_code_artifact_status  ON code_artifact(status);
CREATE INDEX IF NOT EXISTS idx_code_artifact_score   ON code_artifact(score DESC);
