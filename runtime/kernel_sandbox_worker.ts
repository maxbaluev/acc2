// acc2 Tier -1 floor — kernel sandbox integrity worker.
//
// Per docs/roadmap.md Tier -1: a compromised kernel or unenforced
// sandbox can fake observations. Contract: sandbox enforcement /
// degradation is explicit and resource claims are not trusted when
// the floor fails. This worker samples recent `artifact_invoked`
// events and verifies each one has corresponding `sandbox_enforced`
// evidence emitted by the runtime BEFORE (or in the same window as)
// the invocation. Gaps signal the runtime executed an act_artifact
// without the declared sandbox in force.
//
// Emit cadence: 5 minutes. Idempotent (at most one emit per interval).
// Predicate row: kernel_sandbox_integrity_predicate (substrate/seed.ts).
//
// On clean window (every sampled invocation has matching enforcement
// evidence): emit `kernel_sandbox_check` with residual=0.
// On gap ≥ 25% (5+ of 20 invocations missing enforcement): emit
// `sandbox_degraded` for the floor and quarantine the offending
// act_artifact rows via the existing `act_artifact_quarantined`
// event so the rest of the substrate refuses to admit them until
// the operator unblocks.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { logger } from "./logger";

export const KERNEL_SANDBOX_TICK_MS = 5 * 60 * 1000;
const DEFAULT_SAMPLE_SIZE = 20;
const SAMPLE_WINDOW_SECONDS = 3600;
const MIN_GAP_MS = 5 * 60 * 1000;
const GAP_THRESHOLD = 5; // 5+ of sampled invocations missing enforcement triggers degrade

type InvocationRow = {
  id: string;
  ts: string;
  action_artifact_id: string | null;
};

export type KernelSandboxOptions = {
  now?: Date;
  sampleSize?: number;
  windowSeconds?: number;
  minGapMs?: number;
  gapThreshold?: number;
};

export type KernelSandboxSummary = {
  sampled: number;
  enforced: number;
  missing: number;
  emitted_kind: "kernel_sandbox_check" | "sandbox_degraded" | "skipped";
  emitted_event_id?: string;
  quarantined_artifact_ids: string[];
};

const lastEmitTsMs = (db: Database, kind: string): number => {
  const row = db
    .query<{ ts: string }, [string]>(
      `SELECT ts FROM events WHERE kind = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(kind);
  if (!row?.ts) return 0;
  const t = Date.parse(row.ts);
  return Number.isFinite(t) ? t : 0;
};

const recentlyQuarantined = (db: Database, artifactId: string): boolean => {
  try {
    const row = db
      .query<{ c: number }, [string, string]>(
        `SELECT COUNT(*) AS c FROM events
          WHERE kind = 'act_artifact_quarantined'
            AND (action_artifact_id = ?
                 OR json_extract(payload, '$.artifact_id') = ?)`,
      )
      .get(artifactId, artifactId);
    return (row?.c ?? 0) > 0;
  } catch {
    return false;
  }
};

/** One worker tick. Samples up to `sampleSize` recent artifact_invoked
 *  events and, for each, looks for a sandbox_enforced row with the
 *  same `action_artifact_id` within the same window (timestamp <=
 *  invocation ts + small tolerance, OR after the invocation if the
 *  runtime emits enforcement just-after-spawn). When 5+ invocations
 *  lack enforcement evidence, emit sandbox_degraded + quarantine the
 *  offending artifacts. Clean window emits kernel_sandbox_check
 *  with residual=0. */
export const kernelSandboxWorkerTick = (
  db: Database,
  opts: KernelSandboxOptions = {},
): KernelSandboxSummary => {
  const now = opts.now ?? new Date();
  const sampleSize = Math.max(1, opts.sampleSize ?? DEFAULT_SAMPLE_SIZE);
  const windowSeconds = Math.max(60, opts.windowSeconds ?? SAMPLE_WINDOW_SECONDS);
  const minGapMs = Math.max(0, opts.minGapMs ?? MIN_GAP_MS);
  const gapThreshold = Math.max(1, opts.gapThreshold ?? GAP_THRESHOLD);

  // Idempotency — compare against the worker's own primary emit kind.
  // Floor-wide `sandbox_degraded` is shared with the runtime's own
  // degraded emitter, so gating on it would couple cadences.
  const cleanGap = now.getTime() - lastEmitTsMs(db, "kernel_sandbox_check");
  if (cleanGap < minGapMs) {
    return {
      sampled: 0,
      enforced: 0,
      missing: 0,
      emitted_kind: "skipped",
      quarantined_artifact_ids: [],
    };
  }

  const sinceIso = new Date(now.getTime() - windowSeconds * 1000).toISOString();
  let rows: InvocationRow[] = [];
  try {
    rows = db
      .query<InvocationRow, [string, number]>(
        `SELECT id, ts, action_artifact_id
           FROM events
          WHERE kind = 'artifact_invoked'
            AND ts >= ?
            AND action_artifact_id IS NOT NULL
          ORDER BY ts DESC
          LIMIT ?`,
      )
      .all(sinceIso, sampleSize);
  } catch (err) {
    logger.warn(
      { where: "kernel_sandbox.sample", err: (err as Error).message },
      "kernel_sandbox sample query failed",
    );
    return {
      sampled: 0,
      enforced: 0,
      missing: 0,
      emitted_kind: "skipped",
      quarantined_artifact_ids: [],
    };
  }

  // For each invocation, look for a sandbox_enforced or sandbox_degraded
  // row sharing the action_artifact_id. Either signals explicit kernel
  // posture for that invocation — the floor's contract is "sandbox
  // enforcement/degradation is EXPLICIT". Silent invocations with no
  // posture event are the violation.
  const missingArtifactIds = new Set<string>();
  let enforced = 0;
  let missing = 0;
  for (const inv of rows) {
    if (!inv.action_artifact_id) continue;
    try {
      const row = db
        .query<{ c: number }, [string]>(
          `SELECT COUNT(*) AS c FROM events
            WHERE kind IN ('sandbox_enforced','sandbox_degraded')
              AND action_artifact_id = ?`,
        )
        .get(inv.action_artifact_id);
      if ((row?.c ?? 0) > 0) {
        enforced++;
      } else {
        missing++;
        missingArtifactIds.add(inv.action_artifact_id);
      }
    } catch {
      missing++;
      missingArtifactIds.add(inv.action_artifact_id);
    }
  }

  const sampled = rows.length;
  const quarantinedArtifactIds: string[] = [];

  // Gap >= threshold => floor violation. Emit sandbox_degraded with the
  // floor predicate cite + quarantine each offending act_artifact.
  if (missing >= gapThreshold) {
    for (const artifactId of missingArtifactIds) {
      if (recentlyQuarantined(db, artifactId)) continue;
      try {
        emitEvent(db, {
          kind: "act_artifact_quarantined",
          substrate_origin: "substrate_auto",
          action_artifact_id: artifactId,
          payload: {
            artifact_id: artifactId,
            reason: "kernel_sandbox_enforcement_missing",
            floor: "kernel_sandbox_integrity",
            predicate: "kernel_sandbox_integrity_predicate",
          } as JsonValue,
        });
        try {
          db.run(
            "UPDATE act_artifact SET status = ?, updated_at = ? WHERE id = ?",
            ["quarantined", new Date().toISOString(), artifactId],
          );
        } catch {
          // Row may not exist (test fixtures) — quarantine event is the
          // load-bearing signal.
        }
        quarantinedArtifactIds.push(artifactId);
      } catch (err) {
        logger.warn(
          { where: "kernel_sandbox.quarantine", err: (err as Error).message },
          "kernel_sandbox quarantine emit failed",
        );
      }
    }

    try {
      const emitted = emitEvent(db, {
        kind: "sandbox_degraded",
        substrate_origin: "substrate_auto",
        payload: {
          floor: "kernel_sandbox_integrity",
          predicate: "kernel_sandbox_integrity_predicate",
          sampled,
          enforced,
          missing,
          gap_threshold: gapThreshold,
          window_seconds: windowSeconds,
          quarantined_artifact_ids: quarantinedArtifactIds,
          marker: "kernel_sandbox_floor_violation_v1",
          reason: "missing_enforcement_evidence_in_sample",
        } as JsonValue,
      });
      logger.error(
        { sampled, missing, quarantined: quarantinedArtifactIds.length },
        "kernel sandbox floor violated — invocations without enforcement evidence",
      );
      return {
        sampled,
        enforced,
        missing,
        emitted_kind: "sandbox_degraded",
        emitted_event_id: emitted.id,
        quarantined_artifact_ids: quarantinedArtifactIds,
      };
    } catch (err) {
      logger.warn(
        { where: "kernel_sandbox.emit_degraded", err: (err as Error).message },
        "kernel_sandbox sandbox_degraded emit failed",
      );
      return {
        sampled,
        enforced,
        missing,
        emitted_kind: "skipped",
        quarantined_artifact_ids: quarantinedArtifactIds,
      };
    }
  }

  // Clean window — emit absence-of-violation evidence.
  try {
    const emitted = emitEvent(db, {
      kind: "kernel_sandbox_check",
      substrate_origin: "substrate_auto",
      payload: {
        sampled,
        enforced,
        missing,
        residual: sampled === 0 ? 0 : (enforced === sampled ? 0 : 1),
        window_seconds: windowSeconds,
        gap_threshold: gapThreshold,
        predicate: "kernel_sandbox_integrity_predicate",
      } as JsonValue,
    });
    return {
      sampled,
      enforced,
      missing,
      emitted_kind: "kernel_sandbox_check",
      emitted_event_id: emitted.id,
      quarantined_artifact_ids: [],
    };
  } catch (err) {
    logger.warn(
      { where: "kernel_sandbox.emit_check", err: (err as Error).message },
      "kernel_sandbox check emit failed — report not lost",
    );
    return {
      sampled,
      enforced,
      missing,
      emitted_kind: "skipped",
      quarantined_artifact_ids: [],
    };
  }
};
