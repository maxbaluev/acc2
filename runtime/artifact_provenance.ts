// acc2 artifact provenance — graph walk + non-destructive supersede.
//
// Contract C5 (HJJS1665H961B2SRYHC5J85D14, directive
// QHTRBV6PFX2JVBMHDNDA4B03GC, 2026-05-18). External-asset provenance
// (Google Drive doc) must be queryable and non-destructive by default.
// Pre-fix: three Lakeland v4/v5/v6 Drive docs were trashed in-session
// with no substrate-level supersedes chain.
//
// Schema: three additive columns on `code_artifact`:
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
//     superseded_by + emits `code_artifact_superseded`. Idempotent: a
//     second call with the same pair is a no-op (no duplicate event).

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import type { EmitEventInput } from "./events";
import { getArtifact, type CodeArtifactRow } from "./artifact_store";
import { nowIso } from "./ids";

/** A single hop in the provenance chain — projection of code_artifact for
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

const rowToProvenanceNode = (row: CodeArtifactRow, depth: number): ProvenanceNode => ({
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
 *  emit `code_artifact_superseded`. Idempotent: if the prior row already
 *  points to the new artifact this is a no-op (no duplicate event).
 *  Returns true on transition, false on no-op or missing prior row. */
export const markSuperseded = (
  db: Database,
  supersededId: string,
  newId: string,
  emit: (event: EmitEventInput) => void,
): boolean => {
  if (!supersededId || !newId || supersededId === newId) return false;
  const prior = getArtifact(db, supersededId);
  if (!prior) return false;
  if (prior.supersededBy === newId) return false;     // idempotent no-op
  const ts = nowIso();
  db.run(
    "UPDATE code_artifact SET superseded_by = ?, updated_at = ? WHERE id = ?",
    [newId, ts, supersededId],
  );
  const next = getArtifact(db, newId);
  emit({
    kind: "code_artifact_superseded",
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

/** Backfill helper — used by seed.ts to register a partial-provenance
 *  placeholder for a Drive doc that was trashed before the substrate
 *  recorded a chain. Inserts the row at admit priors with
 *  lost_version_count=1 (placeholder) and the supplied supersedes
 *  pointer if any. Returns the inserted artifact_id. Lives here (not
 *  in artifact_store.ts) so the seed call site is co-located with the
 *  provenance vocabulary and stays out of the hot CRUD surface. */
export type BackfillProvenanceInput = {
  artifactId: string;
  driveDocId: string;
  name: string;
  supersedes?: string | null;
  trashed: boolean;
  createdAt?: string;
};

export const backfillProvenancePlaceholder = (
  db: Database,
  input: BackfillProvenanceInput,
): void => {
  const driveUri = `drive://document/${input.driveDocId}`;
  const targetResources = JSON.stringify([driveUri]);
  const ts = input.createdAt ?? nowIso();
  const lostVersionCount = input.trashed ? 1 : 0;
  const declaredSandbox = JSON.stringify({
    runtime: "bun",
    cpu_ms: 1000,
    wall_ms: 5000,
    memory_mb: 64,
  });
  // INSERT OR IGNORE so re-running the seed does not duplicate the
  // placeholder row. The fields below match the schema NOT NULL
  // constraints; the body is a self-documenting comment so the
  // placeholder is honest about its synthetic provenance.
  db.run(
    `INSERT OR IGNORE INTO code_artifact (
       id, runtime, body, declared_sandbox, state_root,
       posterior_alpha, posterior_beta, score, confidence,
       recent_residual_mean, recent_kill_count, status, name,
       fixture_input, fixture_expected_residual,
       intent, summary, target_files, target_resources, source_candidate_id, owner_gate_verdict,
       supersedes, superseded_by, lost_version_count,
       kind,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.artifactId,
      "bun",
      `// C5 provenance backfill placeholder for ${driveUri}\n// Original artifact body lost (external doc trashed=${input.trashed}).`,
      declaredSandbox,
      "drive/provenance",
      1.0, 1.0, 0.5, 0.3,
      0, 0,
      "admitted",
      input.name,
      JSON.stringify(null),
      0.2,
      "c5_backfill_placeholder",
      `Backfill placeholder for trashed Drive doc ${input.driveDocId}; chain reconstructed post-hoc.`,
      null,                                  // target_files
      targetResources,                       // target_resources (drive:// URI)
      null,                                  // source_candidate_id
      "auto",                                // owner_gate_verdict
      input.supersedes ?? null,              // supersedes
      null,                                  // superseded_by (linked by caller in second pass)
      lostVersionCount,
      "published_drive_doc",                 // kind
      ts, ts,
    ],
  );
  // If supersedes is set, wire the prior row's superseded_by → this one
  // (idempotent — only updates rows that don't already point here).
  if (input.supersedes) {
    db.run(
      "UPDATE code_artifact SET superseded_by = ?, updated_at = ? WHERE id = ? AND (superseded_by IS NULL OR superseded_by = ?)",
      [input.artifactId, ts, input.supersedes, input.artifactId],
    );
  }
};
