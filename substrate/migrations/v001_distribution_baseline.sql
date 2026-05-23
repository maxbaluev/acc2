-- v001_distribution_baseline — substrate/migrations registry baseline.
--
-- Per brain dispatch VJDMME8JD961SE6F amendment 4AV2NPJW2H1HV0XQ3MR2ZV78KC
-- (docs/Architecture.md): substrate/migrations is the ONLY path for
-- state.db schema changes going forward. This v001 is the BASELINE
-- migration — it records that the organism has joined the migration
-- registry. All future schema changes get a v0NN migration file.
--
-- This migration is intentionally idempotent + a no-op against
-- substrate/schema.sql; the daemon's existing schema_apply path is
-- the canonical source of truth for the initial schema. The migration
-- here exists so the schema_migration_applied event ledger trace
-- starts at v001 — every future installation has a verifiable
-- migration history from this baseline forward.

-- Index intentionally idempotent.
CREATE INDEX IF NOT EXISTS idx_events_act_artifact_aliased
  ON events (kind, ts)
  WHERE kind = 'act_artifact_aliased';

-- Index intentionally idempotent.
CREATE INDEX IF NOT EXISTS idx_events_schema_migration_applied
  ON events (kind, ts)
  WHERE kind = 'schema_migration_applied';
