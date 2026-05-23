// acc2 rolling-active reviewer — Phase I (Architecture.md).
//
// Rolling-active directives never close. They emit `directive_review_due` on
// cadence; Father (Phase K) picks them up and opens a review subtask each
// time. Architecture defines four cadences (daily, weekly, monthly,
// quarterly, annually).
//
// This module:
//   1. Reads the rolling_review_due_view via the public accessor.
//   2. For each due directive, emits a `directive_review_due` event and opens
//      a fresh review task (`task_node_opened`).
//   3. Tracks applied state in `meta` so re-running the worker doesn't
//      duplicate the same review.
//   4. Auto-archives any directive that missed N consecutive reviews
//      (default N=3 — see §19 risk 19).
//
// Cadence advancement is deterministic (no LLM call). next_review_due is
// shifted by the period; daily → +1d, weekly → +7d, monthly → ~+30d,
// quarterly → ~+90d, annually → +365d. Calendar-month precision is good
// enough for the rolling cadence — the next pass picks up whatever drift.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { newId, nowIso } from "./ids";
import { rollingReviewDue, type RollingReviewDueRow } from "../substrate/views";
import { poolQuery } from "./sql_pool_singleton";

const META_REVIEW_PREFIX = "rolling_review_opened_";
const DEFAULT_MAX_MISSED_REVIEWS = 3;

export type RollingCadence = "daily" | "weekly" | "monthly" | "quarterly" | "annually";

export type RollingDirective = {
  directive_id: string;
  lifecycle: {
    kind: "rolling_active";
    review_cadence: RollingCadence;
    partial_commit_checkpoints: string[];
    next_review_due: string;
  };
  last_review_ts: string | null;
  missed_review_count: number;
};

const cadenceMs: Record<RollingCadence, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  quarterly: 90 * 24 * 60 * 60 * 1000,
  annually: 365 * 24 * 60 * 60 * 1000,
};

const parseCadence = (value: unknown): RollingCadence => {
  if (value === "daily" || value === "weekly" || value === "monthly" || value === "quarterly" || value === "annually") {
    return value;
  }
  return "weekly";
};

const isoFromMs = (ms: number): string => new Date(ms).toISOString();

const wasReviewApplied = (db: Database, directiveId: string, dueTs: string): boolean => {
  const row = db
    .query("SELECT value FROM meta WHERE key = ?")
    .get(`${META_REVIEW_PREFIX}${directiveId}_${dueTs}`) as { value: string } | null;
  return !!row;
};

const markReviewApplied = (db: Database, directiveId: string, dueTs: string): void => {
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [
    `${META_REVIEW_PREFIX}${directiveId}_${dueTs}`,
    nowIso(),
  ]);
};

const findLatestDirectiveEvent = (
  db: Database,
  directiveId: string,
): { ts: string; payload: Record<string, unknown> } | null => {
  const row = db
    .query(
      `SELECT ts, payload FROM events
       WHERE directive_id = ? AND kind IN ('directive_opened', 'directive_amended')
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(directiveId) as { ts: string; payload: string } | null;
  if (!row) return null;
  try {
    return { ts: row.ts, payload: JSON.parse(row.payload ?? "{}") as Record<string, unknown> };
  } catch {
    return null;
  }
};

const countMissedReviews = (db: Database, directiveId: string): number => {
  // Missed reviews = number of directive_review_due events emitted minus the
  // number of associated review tasks committed. We approximate by counting
  // unresolved directive_review_due rows where no subsequent
  // directive_milestone_recorded(milestone='review_completed') follows.
  const dueRows = db
    .query(
      "SELECT ts FROM events WHERE directive_id = ? AND kind = 'directive_review_due' ORDER BY ts ASC",
    )
    .all(directiveId) as Array<{ ts: string }>;
  if (dueRows.length === 0) return 0;
  const completedRows = db
    .query(
      `SELECT ts, payload FROM events
       WHERE directive_id = ? AND kind = 'directive_milestone_recorded' ORDER BY ts ASC`,
    )
    .all(directiveId) as Array<{ ts: string; payload: string }>;
  const completedTimes: string[] = [];
  for (const r of completedRows) {
    try {
      const p = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      if (p.milestone === "review_completed") completedTimes.push(r.ts);
    } catch { /* skip */ }
  }
  let missed = 0;
  for (const due of dueRows) {
    const resolved = completedTimes.some((c) => c >= due.ts);
    if (!resolved) missed += 1;
  }
  return missed;
};

const buildRollingDirective = (
  db: Database,
  row: RollingReviewDueRow,
): RollingDirective => {
  const payload = row.payload as Record<string, unknown>;
  const cadenceRaw =
    (payload.lifecycle_review_cadence as unknown) ??
    (payload.review_cadence as unknown) ??
    ((payload.lifecycle as Record<string, unknown> | undefined)?.review_cadence ?? "weekly");
  const partialRaw = (payload.partial_commit_checkpoints as unknown) ??
    ((payload.lifecycle as Record<string, unknown> | undefined)?.partial_commit_checkpoints ?? []);
  const partial = Array.isArray(partialRaw) ? (partialRaw as unknown[]).map(String) : [];
  return {
    directive_id: row.directive_id,
    lifecycle: {
      kind: "rolling_active",
      review_cadence: parseCadence(cadenceRaw),
      partial_commit_checkpoints: partial,
      next_review_due: row.next_review_due,
    },
    last_review_ts: row.latest_ts ?? null,
    missed_review_count: countMissedReviews(db, row.directive_id),
  };
};

/** Read every rolling_active directive whose next_review_due ≤ now. Reads
 *  through the SQL view defined in substrate/views.ts. */
export const readRollingReviewsDue = (
  db: Database,
  now?: string,
): RollingDirective[] => {
  const rows = rollingReviewDue(db);
  const cutoff = now ?? nowIso();
  return rows
    .filter((r) => r.next_review_due <= cutoff)
    .map((r) => buildRollingDirective(db, r));
};

/** For each due directive: emit `directive_review_due`, open a review subtask,
 *  advance next_review_due by one cadence period, mark the directive as
 *  reviewed in the meta table. Returns counts of work done. Idempotent — a
 *  second call with no new due dates is a no-op. */
export const processRollingReviews = async (
  db: Database,
  now?: string,
): Promise<{ reviews_opened: number; missed_advanced: number }> => {
  const directives = readRollingReviewsDue(db, now);
  let reviews_opened = 0;
  let missed_advanced = 0;

  for (const d of directives) {
    const dueTs = d.lifecycle.next_review_due;
    if (wasReviewApplied(db, d.directive_id, dueTs)) {
      missed_advanced += 1;
      continue;
    }
    // 1. Emit directive_review_due and request brain synthesis for the review debt.
    const dueEvent = emitEvent(db, {
      kind: "directive_review_due",
      substrate_origin: "substrate_auto",
      directive_id: d.directive_id,
      payload: {
        cadence: d.lifecycle.review_cadence,
        due_at: dueTs,
        missed_review_count: d.missed_review_count,
      } as JsonValue,
    });
    emitEvent(db, {
      kind: "brain_invocation_request",
      substrate_origin: "substrate_auto",
      directive_id: d.directive_id,
      context_refs: [dueEvent.id],
      payload: {
        request_reason: "rolling_review_due",
        topic_keywords: ["rolling_review", d.lifecycle.review_cadence, "autonomous_improvement"],
        triggering_event_ids: [dueEvent.id],
        cited_artifact_ids: [],
        cited_knowledge_ids: [],
        emitter_identity: "rolling_reviewer",
        urgency: d.missed_review_count > 0 ? "elevated" : "normal",
      } as JsonValue,
    });

    // 2. Open a review subtask. Father will pick it up via the scheduler.
    const reviewTaskId = newId();
    const latest = findLatestDirectiveEvent(db, d.directive_id);
    const directiveText =
      (latest?.payload.directive_text as string | undefined) ??
      (latest?.payload.goal as string | undefined) ??
      d.directive_id;
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "substrate_auto",
      directive_id: d.directive_id,
      task_id: reviewTaskId,
      parent_task_id: null,
      payload: {
        goal: `review progress through the same closure audit path: ${directiveText}`,
        lifecycle: "finite",
        urgency: "normal",
        review_for_directive: d.directive_id,
        cadence: d.lifecycle.review_cadence,
      } as JsonValue,
    });

    // 3. Advance next_review_due by emitting a directive_amended event so the
    //    rolling_review_due_view reflects the new schedule on next read.
    const periodMs = cadenceMs[d.lifecycle.review_cadence];
    const advancedTsMs = Math.max(
      Date.parse(dueTs) + periodMs,
      Date.parse(now ?? nowIso()) + periodMs,
    );
    const advancedTs = isoFromMs(advancedTsMs);
    emitEvent(db, {
      kind: "directive_amended",
      substrate_origin: "substrate_auto",
      directive_id: d.directive_id,
      payload: {
        original_directive_id: d.directive_id,
        amendment_text: `rolling-review cadence advanced to ${advancedTs}`,
        lifecycle: "rolling_active",
        review_cadence: d.lifecycle.review_cadence,
        partial_commit_checkpoints: d.lifecycle.partial_commit_checkpoints,
        next_review_due: advancedTs,
        amended_by: "substrate_auto",
        rolling_review_advancement: true,
      } as JsonValue,
    });
    markReviewApplied(db, d.directive_id, dueTs);
    reviews_opened += 1;
  }

  return { reviews_opened, missed_advanced };
};

/** Archive every rolling_active directive that has missed `maxMissedReviews`
 *  or more consecutive reviews. Emits `directive_archived_missed_reviews` and
 *  marks the directive so active_objectives_view excludes it. */
export const archiveStaleRollingDirectives = async (
  db: Database,
  opts?: { maxMissedReviews?: number },
): Promise<{ archived: string[] }> => {
  const max = opts?.maxMissedReviews ?? DEFAULT_MAX_MISSED_REVIEWS;

  // Find every directive_opened whose latest payload lifecycle is
  // 'rolling_active' AND that is not already archived. This is an UNBOUNDED
  // scan of every directive lifecycle event (no kind-restricting index helps
  // much at scale), re-run every rolling tick (60s). Route through the SQL
  // worker-thread pool when present so it runs off the main loop. NOT
  // watermarked: a fresh directive_amended on an OLD directive can flip its
  // lifecycle, so the latest-per-directive resolution genuinely needs the
  // full set each tick.
  const directives = (await poolQuery<{ directive_id: string; payload: string; ts: string }>(
    db,
    `SELECT directive_id, payload, ts FROM events
     WHERE kind IN ('directive_opened', 'directive_amended')
     ORDER BY ts ASC`,
  ));

  const latestByDirective = new Map<string, { lifecycle: string; ts: string }>();
  for (const r of directives) {
    try {
      const p = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      const lifecycle = (p.lifecycle as string | undefined) ?? "finite";
      latestByDirective.set(r.directive_id, { lifecycle, ts: r.ts });
    } catch { /* skip */ }
  }

  const alreadyArchivedRows = db
    .query("SELECT DISTINCT directive_id FROM events WHERE kind = 'directive_archived_missed_reviews'")
    .all() as Array<{ directive_id: string }>;
  const alreadyArchived = new Set(alreadyArchivedRows.map((r) => r.directive_id));

  const archived: string[] = [];
  for (const [directiveId, latest] of latestByDirective) {
    if (latest.lifecycle !== "rolling_active") continue;
    if (alreadyArchived.has(directiveId)) continue;
    const missed = countMissedReviews(db, directiveId);
    if (missed >= max) {
      emitEvent(db, {
        kind: "directive_archived_missed_reviews",
        substrate_origin: "substrate_auto",
        directive_id: directiveId,
        failure_kind: "rolling_directive_archived",
        payload: {
          missed_review_count: missed,
          cap: max,
        } as JsonValue,
      });
      archived.push(directiveId);
    }
  }
  return { archived };
};

/** Daemon worker tick — drains due reviews, archives stale rollings. Errors
 *  are caller-controlled; the daemon wraps this in try/catch. */
export const rollingReviewerWorkerTick = async (
  db: Database,
  opts?: { maxMissedReviews?: number; now?: string },
): Promise<{ reviews_opened: number; missed_advanced: number; archived: string[] }> => {
  const reviews = await processRollingReviews(db, opts?.now);
  const archived = await archiveStaleRollingDirectives(db, {
    maxMissedReviews: opts?.maxMissedReviews,
  });
  return { ...reviews, archived: archived.archived };
};
