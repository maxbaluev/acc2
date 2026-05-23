// acc2 cycle-1 enforcement gate — shared structural guard for both the mock
// and real opencode bridges (Architecture.md cycle-1-only).
//
// Why a separate module: the design says cycle-1-only is structural. Before
// this gate existed, the mock bridge path's cycle-1 enforcement lived in
// `task_dispatcher.ts` (post-bridge event scan) and the real bridge path had
// its OWN inline kill switch inside `spawnRealOpencode`. Two enforcement
// surfaces is one too many: the moment the design's two forbidden event
// kinds (`brain_cycle_2_started`, `continue_cycle_requested`) drift, one
// surface forgets and the law becomes advisory. This module pulls the set
// of forbidden event kinds into a single canonical export both paths
// reference.
//
// The dispatcher-side post-bridge scan also routes through `isCycleViolation`
// so the predicate is one function, not two near-identical literals.

import type { EventKind } from "../substrate/types";

/** The canonical forbidden self-iteration event kinds the brain MUST NOT
 *  emit. Both the mock bridge's event-stream scan and the real subprocess
 *  bridge's stdout JSON scan reference this set. Extending the set requires
 *  one edit here; no surface can disagree with another. */
export const CYCLE_ONE_FORBIDDEN_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "brain_cycle_2_started",
  "continue_cycle_requested",
]);

/** Pure predicate: is `kind` a cycle-1-only violation? Both `task_dispatcher`
 *  and `spawnRealOpencode` use this — adding a new forbidden kind to the
 *  set above immediately tightens both lanes. */
export const isCycleViolation = (kind: string | null | undefined): boolean => {
  if (!kind) return false;
  return CYCLE_ONE_FORBIDDEN_KINDS.has(kind as EventKind);
};
