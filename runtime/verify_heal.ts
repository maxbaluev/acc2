// acc2 verify-heal worker — Layer 3 of the self-healing chain
// (owner-approved 2026-05-16, option d). When `acc verify` finds drift
// and Layer 2 emits knowledge_contradiction_observed, the brain's
// posterior updates but no commit is corrected. This worker periodically
// scans for drift cases older than a threshold AND without an
// already-opened corrective directive, and opens a new directive that
// asks the brain to design a corrective amendment. Normal apply loop
// completes the heal — brain proposes, Claude applies, substrate
// verifies (Layer 1 now refuses on mismatch).

import type { Database } from "bun:sqlite";
import { emitEvent } from "./events";

const HOURS = 60 * 60 * 1000;

export interface VerifyHealResult {
  /** drift cases scanned this tick */
  scanned: number;
  /** corrective directives opened this tick */
  dispatched: number;
  /** drift cases skipped because a corrective directive already exists */
  already_dispatched: number;
  /** drift cases skipped because they're younger than the threshold */
  too_recent: number;
}

/** Scan recent knowledge_contradiction_observed events (Layer 2 signal),
 *  filter by drift age threshold, dedupe against existing corrective
 *  directives, open a new directive per unhealed case. Idempotent within
 *  the same tick AND across ticks via a payload marker on the
 *  directive_opened row (corrective_for_contradiction_event_id). */
export const verifyHealWorkerTick = (
  db: Database,
  opts: { ageThresholdMs?: number; dispatchLimitPerTick?: number } = {},
): VerifyHealResult => {
  const ageThresholdMs = opts.ageThresholdMs ?? 24 * HOURS;
  const dispatchLimit = opts.dispatchLimitPerTick ?? 5;
  const result: VerifyHealResult = {
    scanned: 0,
    dispatched: 0,
    already_dispatched: 0,
    too_recent: 0,
  };

  const rows = db.query(
    `SELECT id, ts, directive_id, payload FROM events
     WHERE kind = 'knowledge_contradiction_observed'
       AND json_extract(payload, '$.verdict') IN ('drift', 'missing')
     ORDER BY ts DESC LIMIT 200`,
  ).all() as Array<{ id: string; ts: string; directive_id: string | null; payload: string }>;

  const nowMs = Date.now();
  for (const row of rows) {
    result.scanned += 1;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payload ?? "{}"); } catch { continue; }
    const proposalId = payload.knowledge_id as string | undefined;
    const commitSha = payload.commit_sha as string | undefined;
    const verdict = payload.verdict as string | undefined;
    if (!proposalId || !verdict) continue;

    const tsMs = Date.parse(row.ts);
    if (Number.isFinite(tsMs) && nowMs - tsMs < ageThresholdMs) {
      result.too_recent += 1;
      continue;
    }

    const existing = db.query(
      `SELECT 1 FROM events
       WHERE kind = 'directive_opened'
         AND json_extract(payload, '$.corrective_for_contradiction_event_id') = ?
       LIMIT 1`,
    ).get(row.id);
    if (existing) {
      result.already_dispatched += 1;
      continue;
    }

    if (result.dispatched >= dispatchLimit) break;

    const directiveText =
      `Self-heal a drifted contract amendment.\n\n` +
      `Source proposal: ${proposalId}\n` +
      `Apply was recorded as status=applied at commit ${commitSha ?? "(unknown)"} but `+
      `diff verification classified the apply as ${verdict} — the commit either ` +
      `does not exist, does not touch the proposed target, or its patch text does ` +
      `not contain the proposed before/after markers.\n\n` +
      `Read the original contract_amendment_proposed event (${proposalId}) via ` +
      `substrate.get_event, inspect the current source state of its target, and ` +
      `emit a NEW contract_amendment_proposed with anchored_replace_v1 diff that ` +
      `produces the intended end state. The original proposal's posterior has ` +
      `already been demoted via knowledge_contradiction_observed (event ${row.id}); ` +
      `the new proposal will close the heal loop. Apply isolation gate (cli/apply.ts) ` +
      `now refuses applies whose commit does not match the diff — corrective applies ` +
      `must produce a fresh commit whose diff cleanly matches the new proposal.`;

    const newDirectiveId = `corrective_${proposalId.slice(0, 12)}`;
    const directiveEv = emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "substrate_auto",
      directive_id: newDirectiveId,
      payload: {
        directive_text: directiveText,
        lifecycle: "finite",
        corrective_for_proposal_id: proposalId,
        corrective_for_contradiction_event_id: row.id,
        source_directive_id: row.directive_id,
        original_commit_sha: commitSha,
      },
    });

    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "substrate_auto",
      directive_id: newDirectiveId,
      task_id: `${newDirectiveId}_root`,
      payload: {
        goal: `Design corrective amendment for drifted proposal ${proposalId.slice(0, 12)}`,
        lifecycle: "finite",
        corrective_for_proposal_id: proposalId,
      },
      context_refs: [directiveEv.id, row.id, proposalId],
    });

    result.dispatched += 1;
  }

  return result;
};
