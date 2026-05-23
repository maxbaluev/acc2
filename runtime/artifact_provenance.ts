// acc2 artifact provenance — graph walk + non-destructive supersede.
//
// Contract C5 (HJJS1665H961B2SRYHC5J85D14, directive
// QHTRBV6PFX2JVBMHDNDA4B03GC, 2026-05-18). External-asset provenance
// (Google Drive doc) must be queryable and non-destructive by default.
// Pre-fix: three Lakeland v4/v5/v6 Drive docs were trashed in-session
// with no substrate-level supersedes chain.
//
// Schema: three additive columns on `act_artifact`:
//   - supersedes         TEXT NULL    — prior artifact_id this row replaces
//   - superseded_by      TEXT NULL    — successor artifact_id (mutated when a
//                                       new artifact admits with supersedes=this)
//   - lost_version_count INT  NOT NULL — annotation on partial-backfill
//                                       placeholders whose external resource was
//                                       trashed before the chain was recorded
//
// Public surface:
//   - getProvenanceChain(db, artifactId) → ancestors[] + descendants[] + lost_version_count
//   - markSuperseded(db, supersededId, newId, emit) → flips prior row's
//     superseded_by + emits `act_artifact_superseded`. Idempotent: a
//     second call with the same pair is a no-op (no duplicate event).

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import type { EmitEventInput } from "./events";
import { getArtifact, type ActArtifactRow } from "./artifact_store";
import { nowIso } from "./ids";

/** A single hop in the provenance chain — projection of act_artifact for
 *  the graph-walk surface. The CLI render and JSON output both consume
 *  this shape. */
export type ProvenanceNode = {
  artifact_id: string;
  name: string | null;
  kind: string;
  supersedes: string | null;
  superseded_by: string | null;
  lost_version_count: number;
  target_resources: string[] | null;
  created_at: string;
  /** Depth from the queried artifact: ancestors get +1, +2, …; descendants
   *  get the same but on the other side. Useful for tree indentation. */
  depth: number;
};

export type ProvenanceChain = {
  head: ProvenanceNode;
  ancestors: ProvenanceNode[];   // ordered oldest → most-recent-ancestor (immediate parent last)
  descendants: ProvenanceNode[]; // ordered nearest descendant → newest tip
  lost_version_count: number;    // sum across head + ancestors + descendants
};

const rowToProvenanceNode = (row: ActArtifactRow, depth: number): ProvenanceNode => ({
  artifact_id: row.id,
  name: row.name,
  kind: (row as unknown as { kind?: string }).kind ?? "code_artifact",
  supersedes: row.supersedes,
  superseded_by: row.supersededBy,
  lost_version_count: row.lostVersionCount,
  target_resources: row.targetResources ? row.targetResources.map((r) => r.uri) : null,
  created_at: row.createdAt,
  depth,
});

const MAX_CHAIN_DEPTH = 256;

/** Walk the supersedes chain from `artifactId` toward older versions
 *  (supersedes pointer) and newer versions (superseded_by pointer).
 *  Returns the head node + ordered ancestor / descendant lists. Cycles
 *  and runaway chains are bounded at MAX_CHAIN_DEPTH (defensive — the
 *  substrate has no enforcement against authoring a cycle yet). */
export const getProvenanceChain = (
  db: Database,
  artifactId: string,
): ProvenanceChain | null => {
  const head = getArtifact(db, artifactId);
  if (!head) return null;
  const headNode = rowToProvenanceNode(head, 0);

  const ancestors: ProvenanceNode[] = [];
  const seenA = new Set<string>([head.id]);
  let cursorA = head.supersedes;
  let depthA = 1;
  while (cursorA && depthA <= MAX_CHAIN_DEPTH && !seenA.has(cursorA)) {
    seenA.add(cursorA);
    const row = getArtifact(db, cursorA);
    if (!row) break;
    ancestors.push(rowToProvenanceNode(row, depthA));
    cursorA = row.supersedes;
    depthA++;
  }
  // Reverse so caller sees oldest → most-recent-ancestor.
  ancestors.reverse();

  const descendants: ProvenanceNode[] = [];
  const seenD = new Set<string>([head.id]);
  let cursorD = head.supersededBy;
  let depthD = 1;
  while (cursorD && depthD <= MAX_CHAIN_DEPTH && !seenD.has(cursorD)) {
    seenD.add(cursorD);
    const row = getArtifact(db, cursorD);
    if (!row) break;
    descendants.push(rowToProvenanceNode(row, depthD));
    cursorD = row.supersededBy;
    depthD++;
  }

  const lost_version_count =
    headNode.lost_version_count +
    ancestors.reduce((a, n) => a + n.lost_version_count, 0) +
    descendants.reduce((a, n) => a + n.lost_version_count, 0);

  return { head: headNode, ancestors, descendants, lost_version_count };
};

/** Flip the prior row's `superseded_by` to point at the new artifact and
 *  emit `act_artifact_superseded`. Idempotent: if the prior row already
 *  points to the new artifact this is a no-op (no duplicate event).
 *  Returns true on transition, false on no-op or missing prior row.
 *
 *  Contract TJGFQC72 (2026-05-18): when `predicateResult` is supplied
 *  with residual ≥ 0.3, refuse the chain extension, emit
 *  `lane_routing_refused`, and return false. Existing callers that do
 *  not pass the parameter are unchanged. */
export const markSuperseded = (
  db: Database,
  supersededId: string,
  newId: string,
  emit: (event: EmitEventInput) => void,
  predicateResult?: { residual: number },
): boolean => {
  if (!supersededId || !newId || supersededId === newId) return false;
  if (predicateResult && predicateResult.residual >= 0.3) {
    emit({
      kind: "lane_routing_refused",
      substrate_origin: "substrate_auto",
      action_artifact_id: supersededId,
      payload: {
        reason: "predicate_residual_too_high",
        refused_kind: "supersedes_chain_extension",
        directive_id: "",
        observed_intent_class: null,
        residual: predicateResult.residual,
        prior_artifact_id: supersededId,
        new_artifact_id: newId,
      } as JsonValue,
    });
    return false;
  }
  const prior = getArtifact(db, supersededId);
  if (!prior) return false;
  if (prior.supersededBy === newId) return false;     // idempotent no-op
  const ts = nowIso();
  db.run(
    "UPDATE act_artifact SET superseded_by = ?, updated_at = ? WHERE id = ?",
    [newId, ts, supersededId],
  );
  const next = getArtifact(db, newId);
  emit({
    kind: "act_artifact_superseded",
    substrate_origin: "substrate_auto",
    action_artifact_id: supersededId,
    payload: {
      prior_artifact_id: supersededId,
      new_artifact_id: newId,
      kind: (next as unknown as { kind?: string } | null)?.kind ?? null,
      target_resources: next?.targetResources?.map((r) => r.uri) ?? null,
    } as JsonValue,
  });
  return true;
};

