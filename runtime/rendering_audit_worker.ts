// rendering_audit_worker.ts — periodic auditor for the owner-rendering loop.
//
// Closes the gap named in lesson 88ESCTN8XN6J (the flywheel is persisted
// and exposed but not consumed by an always-on runtime worker). Without
// this tick, every rendered_owner_message_recorded row sits in
// owner_rendering_effectiveness_view as `pending` indefinitely — the
// substrate never learns whether its own renderer is leaking IDs,
// jargon, or owner-declined concepts unless the owner happens to react.
//
// What the tick does, every interval:
//   1. SELECT recent rendered_owner_message_recorded rows that do NOT
//      already have an owner_rendering_feedback_recorded child.
//   2. Read the current owner_rendering_policy_view snapshot (single
//      row; cheap).
//   3. For each render, call verifyRendering(rendered_text, audience,
//      policy). When residual ≥ RENDERING_RESIDUAL_THRESHOLD, emit
//      owner_rendering_feedback_recorded with feedback_kind="auto_verifier"
//      + the residual + breakdown.
//   4. When residual is clean (0), also emit a feedback row but with
//      feedback_kind="auto_verifier_clean" so the policy posterior
//      credits the renderer for matching the contract.
//
// Open-ended feedback_kind (per k_201 universal-kind): the auto-verifier
// uses two free strings that mean nothing special to the substrate
// schema — just like correction/decline/satisfaction, the merger
// discovers semantics from outcome correlation.
//
// Cite: 88ESCTN8XN6J (flywheel unconsumed by worker → fix here),
// 7JE565S6016T (closure stop-functions must be timestamp-aware; we use
// strict `ts >` so re-runs don't double-credit the same row).

import type { Database } from "bun:sqlite";
import { emitEvent } from "./events";
import { ownerRenderingPolicy } from "../substrate/views";
import { verifyRendering, RENDERING_RESIDUAL_THRESHOLD } from "./rendering_verifier";

export type RenderingAuditResult = {
  scanned: number;
  audited: number;
  flagged: number;
  cleaned: number;
  skipped_existing_feedback: number;
};

/** Default scan window: last 24 hours. Tests can pass a shorter window
 *  for determinism. */
export const DEFAULT_RENDERING_AUDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Max rows per tick — bounded so a flood of renders doesn't starve other
 *  workers. */
export const RENDERING_AUDIT_BATCH_LIMIT = 200;

/** One tick of the rendering-audit worker. Returns a summary the daemon
 *  can log. Idempotent: rows that already carry feedback are skipped
 *  (we look at any owner_rendering_feedback_recorded with matching
 *  source_rendered_event_id). */
export const renderingAuditWorkerTick = (
  db: Database,
  opts: { windowMs?: number; batchLimit?: number } = {},
): RenderingAuditResult => {
  const windowMs = opts.windowMs ?? DEFAULT_RENDERING_AUDIT_WINDOW_MS;
  const batchLimit = opts.batchLimit ?? RENDERING_AUDIT_BATCH_LIMIT;
  const sinceIso = new Date(Date.now() - windowMs).toISOString();

  // Strict `ts >` per 7JE565S6016T: we never re-audit the same row,
  // and the existence-check (NOT EXISTS feedback) keeps us idempotent
  // across daemon restarts even if `since` widens unexpectedly.
  const rows = db
    .query(
      `SELECT id, ts, payload, directive_id, task_id
       FROM events
       WHERE kind = 'rendered_owner_message_recorded'
         AND ts > ?
         AND NOT EXISTS (
           SELECT 1 FROM events f
           WHERE f.kind = 'owner_rendering_feedback_recorded'
             AND json_extract(f.payload, '$.source_rendered_event_id') = events.id
         )
       ORDER BY ts ASC
       LIMIT ?`,
    )
    .all(sinceIso, batchLimit) as Array<{
      id: string;
      ts: string;
      payload: string;
      directive_id: string | null;
      task_id: string | null;
    }>;

  const result: RenderingAuditResult = {
    scanned: rows.length,
    audited: 0,
    flagged: 0,
    cleaned: 0,
    skipped_existing_feedback: 0,
  };
  if (rows.length === 0) return result;

  const policy = ownerRenderingPolicy(db);

  for (const row of rows) {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* keep empty */ }
    const renderedText = typeof payload.rendered_text === "string" ? payload.rendered_text : "";
    const audience = typeof payload.audience === "string" ? payload.audience : "primary";
    if (!renderedText) {
      // No text to score — emit a heartbeat so the row gets out of the
      // pending band but doesn't pollute the residual signal.
      emitEvent(db, {
        kind: "owner_rendering_feedback_recorded",
        substrate_origin: "substrate_auto",
        directive_id: row.directive_id ?? undefined,
        task_id: row.task_id ?? undefined,
        payload: {
          source_rendered_event_id: row.id,
          feedback_kind: "auto_verifier_skipped",
          evidence: "rendered_text was empty / non-string; verifier cannot score",
        },
        context_refs: [row.id],
      });
      result.skipped_existing_feedback += 1;
      continue;
    }

    const verdict = verifyRendering({ rendered_text: renderedText, audience, policy });
    const flagged = verdict.residual >= RENDERING_RESIDUAL_THRESHOLD;
    emitEvent(db, {
      kind: "owner_rendering_feedback_recorded",
      substrate_origin: "substrate_auto",
      directive_id: row.directive_id ?? undefined,
      task_id: row.task_id ?? undefined,
      payload: {
        source_rendered_event_id: row.id,
        feedback_kind: flagged ? "auto_verifier" : "auto_verifier_clean",
        feedback_residual: verdict.residual,
        observed_behavior: flagged
          ? `auto-verifier flagged: ${verdict.violations.length} axis hit(s)`
          : "auto-verifier clean",
        evidence: JSON.stringify({
          breakdown: verdict.breakdown,
          violations: verdict.violations.slice(0, 8), // cap to avoid bloating payload
        }),
      },
      context_refs: [row.id],
      residual: verdict.residual,
    });
    result.audited += 1;
    if (flagged) result.flagged += 1;
    else result.cleaned += 1;
  }

  return result;
};
