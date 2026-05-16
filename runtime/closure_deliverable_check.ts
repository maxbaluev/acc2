// acc2 closure deliverable check — substrate-side helper for the
// WORKFLOW_TEXT step-7 closure verifier. Resolves the verifier_gap lesson
// from brain audit QQEHAW97GS0AX7TEQ717Y3P174: the closure audit previously
// only verified subtree STRUCTURE (task_node_opened + task_edge_recorded
// presence). Deliverable-shaped leaves could close without ever emitting
// concrete artifacts (code_artifact_candidate / contract_amendment_proposed
// / lesson_extracted{proposed_action}). Symptom: dispatch CBKDWYRN
// closure_residual=0.05 while B3-style leaves "expose a concise growth
// report..." committed empty.
//
// This helper mirrors the deliverable-check semantics of
// runtime/proposal_grounding.ts (same imperative-verb set, same subtree
// algorithm) but applies at CLOSURE time over the WHOLE subtree and ONLY
// the DEEPEST tasks (leaves with no refines children). Structural
// (non-leaf) tasks are exempt — their concrete output is the children.
//
// Wiring into the closure_audited emit path is a follow-on amendment;
// this commit establishes the verifiable helper.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";

export interface ClosureDeliverableResult {
  ok: boolean;
  uncovered_leaves: string[]; // task_ids whose goal verb implied a deliverable but none was emitted
}

// Same imperative-verb set as runtime/proposal_grounding.ts so the
// grounding gate (admission) and the closure gate (post-trajectory)
// use one predicate. Keep these two lists in lockstep.
const DELIVERABLE_VERBS = [
  "expose",
  "add",
  "wire",
  "implement",
  "build",
  "create",
  "propose",
  "emit",
  "audit",
  "diagnose",
  "measure",
  "rank",
];

const parsePayload = (raw: string): Record<string, JsonValue> => {
  try { return JSON.parse(raw ?? "{}") as Record<string, JsonValue>; } catch { return {}; }
};

const isDeliverableGoal = (goal: string): boolean => {
  const lower = goal.toLowerCase();
  return DELIVERABLE_VERBS.some((v) => new RegExp(`\\b${v}\\b`).test(lower));
};

// Walk the refines DAG starting from rootTaskId. Mirrors
// proposal_grounding.collectSubtreeTaskIds. Returns:
//   - subtree: every task_id in the refines closure (including root)
//   - children: parent-task_id → list of child task_ids (refines edges only)
const collectSubtree = (
  db: Database,
  rootTaskId: string,
): { subtree: Set<string>; children: Map<string, string[]> } => {
  const subtree = new Set<string>([rootTaskId]);
  const edgeRows = db
    .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded'")
    .all() as Array<{ payload: string }>;
  const children = new Map<string, string[]>();
  for (const e of edgeRows) {
    const p = parsePayload(e.payload);
    if ((p.kind as string) !== "refines") continue;
    const from = p.from_task as string | undefined;
    const to = p.to_task as string | undefined;
    if (!from || !to) continue;
    const list = children.get(from) ?? [];
    list.push(to);
    children.set(from, list);
  }
  const queue = [rootTaskId];
  while (queue.length > 0) {
    const next = queue.shift()!;
    for (const child of children.get(next) ?? []) {
      if (subtree.has(child)) continue;
      subtree.add(child);
      queue.push(child);
    }
  }
  return { subtree, children };
};

const eventsForTasks = (
  db: Database,
  taskIds: Set<string>,
  kind: string,
): Array<{ task_id: string; payload: Record<string, JsonValue> }> => {
  if (taskIds.size === 0) return [];
  const placeholders = Array.from(taskIds).map(() => "?").join(",");
  const rows = db
    .query(`SELECT task_id, payload FROM events WHERE kind = ? AND task_id IN (${placeholders})`)
    .all(kind, ...Array.from(taskIds)) as Array<{ task_id: string; payload: string }>;
  return rows.map((r) => ({ task_id: r.task_id, payload: parsePayload(r.payload) }));
};

export const checkClosureDeliverables = (
  db: Database,
  rootTaskId: string,
  _directiveId?: string,
): ClosureDeliverableResult => {
  const { subtree, children } = collectSubtree(db, rootTaskId);

  const nodes = eventsForTasks(db, subtree, "task_node_opened");
  const artifacts = eventsForTasks(db, subtree, "code_artifact_candidate");
  const amendments = eventsForTasks(db, subtree, "contract_amendment_proposed");
  const lessons = eventsForTasks(db, subtree, "lesson_extracted");

  const uncovered: string[] = [];
  for (const n of nodes) {
    // Leaf-only check: a task with refines children is structural; its
    // deliverable is the children themselves, not a direct artifact.
    const kids = children.get(n.task_id) ?? [];
    if (kids.length > 0) continue;

    const goal = (n.payload.goal as string) ?? "";
    if (!isDeliverableGoal(goal)) continue;

    const has = artifacts.some((a) => a.task_id === n.task_id)
      || amendments.some((a) => a.task_id === n.task_id)
      || lessons.some((l) => l.task_id === n.task_id && Boolean(l.payload.proposed_action));
    if (!has) uncovered.push(n.task_id);
  }

  return { ok: uncovered.length === 0, uncovered_leaves: uncovered };
};
