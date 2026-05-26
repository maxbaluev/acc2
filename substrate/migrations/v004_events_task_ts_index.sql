-- v004_events_task_ts_index
-- DAEMON STABILITY HARDENING (fix #1): add the symmetric (task_id, ts) index
-- so per-dispatch hot paths that filter task_id and order by ts WITHOUT a kind
-- filter (dispatch_continuation.ts, task_dispatcher.ts) stop forcing a TEMP
-- B-TREE FOR ORDER BY through idx_events_task_kind_ts (kind sits between
-- task_id and ts there). Mirror of the existing idx_events_directive_ts fix.
-- Idempotent; safe to re-apply. No data change — pure index addition.

CREATE INDEX IF NOT EXISTS idx_events_task_ts
  ON events(task_id, ts);
