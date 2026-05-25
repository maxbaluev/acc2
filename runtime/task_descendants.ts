// acc2 task descendants — the single, shared definition of a task's
// DECOMPOSITION descendants for closure / root-commit gating.
//
// Why this module exists: the descendant walk was previously inlined in BOTH
// runtime/events.ts (the root-commit block) and runtime/directive_closure.ts
// (the closure audit) "to avoid an import cycle" — and the two copies DRIFTED
// (a fix had to be applied to both). This pure module (it imports only the
// Database type, nothing from events/directive_closure) is the cycle-free home
// they both import, so the definition can never diverge again.
//
// Decomposition only (parent_task_id chain). `requires` is a downstream
// dependency — blocking a task's commit on a `requires` dependent DEADLOCKS
// (the dependent cannot start until the task commits, but the task cannot
// commit until the dependent is terminal). `refines` is a checkpoint
// continuation — blocking on it forbids the commit-cycle-then-continue
// pattern. Neither is a decomposition descendant, so neither gates commit.

import type { Database } from "bun:sqlite";

/** Transitive decomposition descendants of `rootTaskId` (task_node_opened rows
 *  whose parent_task_id chains up to it). Excludes the root itself. Pure. */
export const decompositionDescendantTaskIds = (db: Database, rootTaskId: string): string[] => {
  const out = new Set<string>();
  const queue: string[] = [rootTaskId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const children = db
      .query("SELECT task_id AS child_id FROM events WHERE kind = 'task_node_opened' AND parent_task_id = ?")
      .all(cur) as Array<{ child_id: string | null }>;
    for (const child of children) {
      if (!child.child_id || child.child_id === rootTaskId || out.has(child.child_id)) continue;
      out.add(child.child_id);
      queue.push(child.child_id);
    }
  }
  return [...out];
};
