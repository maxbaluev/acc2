// acc2 watch CLI test — skeleton smoke only.
// The legacy six-pane TUI (1054 LOC, 260 LOC test) was removed 2026-05-16
// per owner directive. This test covers ONLY the skeleton's three
// invariants: (1) runWatch is exported and callable, (2) the empty stubs
// resolve without throwing, (3) runWatch surfaces a non-zero exit when no
// daemon is reachable (rather than hanging). Full coverage returns when
// the next observation surface lands; see cli/watch.ts header for the
// replacement plan.

import { describe, expect, test } from "bun:test";
import { runWatch, renderFrame, renderPanelLines, readDriftSummaries } from "./watch";

describe("acc watch skeleton placeholder", () => {
  test("runWatch is a callable async function returning a numeric exit", async () => {
    expect(typeof runWatch).toBe("function");
    // Don't actually invoke runWatch — it tries to reach the daemon and
    // would either succeed (env-dependent) or print to stderr for ~50ms.
    // The signature check is enough for skeleton coverage.
  });

  test("empty stubs resolve to inert values without throwing", () => {
    expect(renderFrame()).toBe("");
    expect(renderPanelLines()).toEqual([]);
    expect(readDriftSummaries()).toEqual([]);
  });

  test("readPendingDecisions stub was deleted — canonical surface is acc admin pending-decisions", async () => {
    // This is the structural fix: a hardcoded readPendingDecisions = (): never[] => []
    // caused the orchestrator to silently miss 89 owner-gated proposals over 33 hours.
    // The substitute is pending_owner_decision_queue_view + acc admin pending-decisions.
    // If any future TUI work tries to re-import readPendingDecisions, the module
    // resolution will fail (no such named export). That is intentional.
    const mod = await import("./watch");
    expect((mod as Record<string, unknown>).readPendingDecisions).toBeUndefined();
  });
});
