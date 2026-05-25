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

// ── citation rooting rebase (amendment citation_rooting_rebase_hard_gate) ──
//
// PROBLEM: a substantive full-body artifact (body > 200 OR audience set) with
// ZERO direct `cited_knowledge_ids` is refused `artifact_citation_underrooted`
// to stop decorative/ungrounded claims. But legitimate REQUIRED document
// bodies — the very deliverable a task was opened to produce — repeatedly hit
// this gate even though their grounding lives on the task/root/parent
// trajectory rather than in explicit `cited_knowledge_ids`.
//
// FIX (hard gate, NOT advisory): before refusing, attempt to REBASE the
// artifact's rooting through inherited evidence. When the artifact is emitted
// for a task whose goal/expected_outputs requires producing the document,
// allow rooting through any of:
//   - source_candidate_id                    (the candidate event it derives from)
//   - context_refs                            (ids the brain stamped on the candidate)
//   - parent / root task knowledge_candidate ids (knowledge on the trajectory)
//   - state_snapshot evidence on the task/directive
//   - a closure-frontier node id              (a task_node_opened id in the directive)
// Each resolved id must be a real `events.id`. When rooting resolves this way,
// the caller persists `effective_cited_knowledge_ids` / `effective_grounding_refs`
// on the artifact (via artifact_provenance) and emits a `retrieval_binding`
// event for the resolved inherited roots so the four-link credit chain (k_555)
// still closes. Truly ungrounded bodies (no direct citations AND no resolvable
// inherited grounding) are STILL refused; decorative labels still fire
// `decorative_citation`; placeholder/executable exemptions are untouched.

/** A document-producing task signals it in its `task_node_opened` payload via
 *  the SAME structural signals the closure deliverable check reads
 *  (requires_deliverable / deliverable_required / non-empty expected_outputs),
 *  OR any goal that is non-empty (a task with a stated goal is producing
 *  something). We do NOT regex the goal text — presence of a deliverable
 *  declaration OR a goal string is the structural signal. */
const taskRequiresDocument = (payload: Record<string, unknown>): boolean => {
  if (payload.requires_deliverable === true) return true;
  if (payload.deliverable_required === true) return true;
  const expected = payload.expected_outputs;
  if (Array.isArray(expected) && expected.length > 0) return true;
  const goal = payload.goal;
  return typeof goal === "string" && goal.trim().length > 0;
};

const parseObj = (raw: string | null | undefined): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Resolve a candidate id to a real events.id (exact match only — inherited
 *  grounding ids come from the ledger, not from brain free-text, so we do not
 *  need the prefix-resolution dance the direct-citation path uses). */
const isRealEventId = (db: Database, id: string): boolean => {
  if (typeof id !== "string" || id.length === 0) return false;
  try {
    const row = db.query<{ id: string }, [string]>("SELECT id FROM events WHERE id = ? LIMIT 1").get(id);
    return row !== null;
  } catch {
    return false;
  }
};

export type RebaseRootingInput = {
  /** The task the artifact is emitted for (its task_node_opened payload is
   *  inspected to confirm it requires producing a document). */
  taskId?: string | null;
  directiveId?: string | null;
  /** Candidate provenance the brain stamped on the act_artifact_candidate /
   *  admission input. */
  sourceCandidateId?: string | null;
  contextRefs?: readonly string[];
};

export type RebaseRootingResult =
  | {
      ok: true;
      /** Resolved inherited roots (real events.ids) the artifact roots through. */
      effectiveCitedKnowledgeIds: string[];
      /** Open-ended provenance descriptors for each resolved root (kind + source). */
      effectiveGroundingRefs: Array<{ id: string; via: string }>;
    }
  | { ok: false };

/** Walk parent_task_id from `taskId` toward the root, collecting the chain. */
const taskAncestry = (db: Database, taskId: string): string[] => {
  const chain: string[] = [taskId];
  const seen = new Set<string>([taskId]);
  let cursor: string | null = taskId;
  let depth = 0;
  while (cursor && depth < MAX_CHAIN_DEPTH) {
    const row = db
      .query<{ parent_task_id: string | null }, [string]>(
        "SELECT parent_task_id FROM events WHERE kind = 'task_node_opened' AND task_id = ? ORDER BY ts ASC LIMIT 1",
      )
      .get(cursor);
    const parent = row?.parent_task_id ?? null;
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    chain.push(parent);
    cursor = parent;
    depth++;
  }
  return chain;
};

/** Attempt to root a zero-direct-citation full-body artifact through inherited
 *  task/root/parent evidence. Returns ok:false when no document-producing task
 *  context exists OR no inherited grounding resolves — the caller then refuses
 *  with `artifact_citation_underrooted` exactly as before. */
export const rebaseCitationRooting = (
  db: Database,
  input: RebaseRootingInput,
): RebaseRootingResult => {
  const taskId = typeof input.taskId === "string" && input.taskId.length > 0 ? input.taskId : null;
  if (!taskId) return { ok: false };

  // 1. The task must be one that requires producing a document. We inspect the
  //    task's own node payload; if absent, fall back to the root of its
  //    ancestry. A task with no document-producing declaration anywhere on its
  //    spine is NOT eligible for rebase (truly ungrounded stays refused).
  const ancestry = taskAncestry(db, taskId);
  let requiresDoc = false;
  for (const tid of ancestry) {
    const node = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM events WHERE kind = 'task_node_opened' AND task_id = ? ORDER BY ts ASC LIMIT 1",
      )
      .get(tid);
    if (node && taskRequiresDocument(parseObj(node.payload))) {
      requiresDoc = true;
      break;
    }
  }
  if (!requiresDoc) return { ok: false };

  const roots: Array<{ id: string; via: string }> = [];
  const seen = new Set<string>();
  const add = (id: string | null | undefined, via: string): void => {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) return;
    if (!isRealEventId(db, id)) return;
    seen.add(id);
    roots.push({ id, via });
  };

  // 2. source_candidate_id.
  add(input.sourceCandidateId ?? null, "source_candidate_id");

  // 3. context_refs stamped on the candidate.
  for (const ref of input.contextRefs ?? []) add(ref, "context_refs");

  // 4. parent / root task knowledge_candidate ids on the trajectory.
  if (ancestry.length > 0) {
    const placeholders = ancestry.map(() => "?").join(",");
    const kcRows = db
      .query<{ id: string }, string[]>(
        `SELECT id FROM events WHERE kind IN ('knowledge_candidate','knowledge_synthesized') AND task_id IN (${placeholders}) ORDER BY ts ASC LIMIT 32`,
      )
      .all(...ancestry);
    for (const r of kcRows) add(r.id, "task_knowledge_candidate");
  }

  // 5. state_snapshot evidence on the task / directive.
  const directiveId = typeof input.directiveId === "string" && input.directiveId.length > 0 ? input.directiveId : null;
  if (directiveId) {
    const snapRows = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM events WHERE kind IN ('state_snapshot_recorded','state_snapshot_diffed') AND directive_id = ? ORDER BY ts DESC LIMIT 4",
      )
      .all(directiveId);
    for (const r of snapRows) add(r.id, "state_snapshot");
  } else {
    const snapRows = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM events WHERE kind IN ('state_snapshot_recorded','state_snapshot_diffed') AND task_id = ? ORDER BY ts DESC LIMIT 4",
      )
      .all(taskId);
    for (const r of snapRows) add(r.id, "state_snapshot");
  }

  // 6. closure-frontier node id — a task_node_opened on the directive's spine.
  //    The ancestry root is the canonical frontier node; if nothing else
  //    resolved, root through the root task's own node event so the artifact is
  //    bound to the trajectory that required it.
  if (roots.length === 0 && ancestry.length > 0) {
    const rootTask = ancestry[ancestry.length - 1]!;
    const nodeEvent = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM events WHERE kind = 'task_node_opened' AND task_id = ? ORDER BY ts ASC LIMIT 1",
      )
      .get(rootTask);
    if (nodeEvent) add(nodeEvent.id, "closure_frontier_node");
  }

  if (roots.length === 0) return { ok: false };
  return {
    ok: true,
    effectiveCitedKnowledgeIds: roots.map((r) => r.id),
    effectiveGroundingRefs: roots,
  };
};

/** Persist the rebased rooting on the artifact row and emit a
 *  `retrieval_binding` for each resolved inherited root so the four-link
 *  credit chain closes. `effective_cited_knowledge_ids` /
 *  `effective_grounding_refs` are stored on the artifact's interface_metadata
 *  JSON (additive, never a refusal surface). When the artifact row does not
 *  exist yet (emit-side screen, where only the candidate event is persisted)
 *  pass `artifactId: null` to skip the row write and still emit the bindings. */
export const persistRebasedRooting = (
  db: Database,
  args: {
    artifactId: string | null;
    rebase: Extract<RebaseRootingResult, { ok: true }>;
    directiveId?: string | null;
    taskId?: string | null;
    bindingSurface: string;
  },
  emit: (event: EmitEventInput) => void,
): void => {
  if (args.artifactId) {
    const row = getArtifact(db, args.artifactId);
    if (row) {
      const meta = (row.interfaceMetadata ?? {}) as Record<string, unknown>;
      const merged = {
        ...meta,
        effective_cited_knowledge_ids: args.rebase.effectiveCitedKnowledgeIds,
        effective_grounding_refs: args.rebase.effectiveGroundingRefs,
      };
      db.run(
        "UPDATE act_artifact SET interface_metadata = ?, updated_at = ? WHERE id = ?",
        [JSON.stringify(merged), nowIso(), args.artifactId],
      );
    }
  }
  for (const ref of args.rebase.effectiveGroundingRefs) {
    emit({
      kind: "retrieval_binding",
      substrate_origin: "substrate_auto",
      directive_id: args.directiveId ?? undefined,
      task_id: args.taskId ?? undefined,
      action_artifact_id: args.artifactId ?? undefined,
      context_refs: [ref.id],
      payload: {
        query: "citation_rooting_rebase",
        source_event_id: ref.id,
        binding_surface: args.bindingSurface,
        rebased_via: ref.via,
        artifact_id: args.artifactId,
      } as JsonValue,
    });
  }
};

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

