-- v002_act_artifact_data_class_nullable
-- Path A: allow non-executing data-class act_artifact rows by making executable-only columns nullable.
-- NOTE: migration_runner already wraps each .sql file in BEGIN/COMMIT, so this
-- file MUST NOT contain explicit transaction control (nested BEGIN throws
-- "cannot start a transaction within a transaction" on SQLite).
DROP VIEW IF EXISTS act_artifact_registry_view;
DROP VIEW IF EXISTS artifact_routing_view;
DROP VIEW IF EXISTS code_artifact_registry_view;
ALTER TABLE act_artifact RENAME TO act_artifact_v001;
CREATE TABLE act_artifact (
  id TEXT PRIMARY KEY,
  runtime TEXT,
  body TEXT NOT NULL,
  declared_sandbox TEXT,
  state_root TEXT,
  kind TEXT NOT NULL DEFAULT 'runtime_action',
  posterior_alpha REAL NOT NULL DEFAULT 1.0,
  posterior_beta REAL NOT NULL DEFAULT 1.0,
  score REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.3,
  embedding BLOB,
  recent_residual_mean REAL NOT NULL DEFAULT 0.0,
  recent_kill_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'admitted',
  name TEXT,
  fixture_input TEXT,
  fixture_expected_residual REAL,
  intent TEXT,
  summary TEXT,
  target_files TEXT,
  target_resources TEXT,
  source_candidate_id TEXT,
  owner_gate_verdict TEXT,
  supersedes TEXT,
  superseded_by TEXT,
  lost_version_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO act_artifact (
  id, runtime, body, declared_sandbox, state_root, kind,
  posterior_alpha, posterior_beta, score, confidence, embedding,
  recent_residual_mean, recent_kill_count, status, name,
  fixture_input, fixture_expected_residual,
  intent, summary, target_files, target_resources, source_candidate_id, owner_gate_verdict,
  supersedes, superseded_by, lost_version_count, created_at, updated_at
)
SELECT
  id, runtime, body, declared_sandbox, state_root, kind,
  posterior_alpha, posterior_beta, score, confidence, embedding,
  recent_residual_mean, recent_kill_count, status, name,
  fixture_input, fixture_expected_residual,
  intent, summary, target_files, target_resources, source_candidate_id, owner_gate_verdict,
  supersedes, superseded_by, lost_version_count, created_at, updated_at
FROM act_artifact_v001;
DROP TABLE act_artifact_v001;
CREATE INDEX IF NOT EXISTS idx_act_artifact_runtime ON act_artifact(runtime);
CREATE INDEX IF NOT EXISTS idx_act_artifact_status ON act_artifact(status);
CREATE INDEX IF NOT EXISTS idx_act_artifact_score ON act_artifact(score DESC);
CREATE INDEX IF NOT EXISTS idx_act_artifact_kind ON act_artifact(kind);
CREATE INDEX IF NOT EXISTS idx_act_artifact_supersedes ON act_artifact(supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_act_artifact_superseded_by ON act_artifact(superseded_by) WHERE superseded_by IS NOT NULL;
