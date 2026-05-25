-- v003_world_model_projection_indexes
-- First-class world models reuse existing state_snapshot_recorded and
-- state_snapshot_diffed events. The only schema addition is task-scoped
-- partial indexes for the projection view; the migration is idempotent.

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
