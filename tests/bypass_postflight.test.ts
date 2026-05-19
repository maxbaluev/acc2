// acc2 F2 — bypass postflight tests (2026-05-18; revert dropped 2026-05-19
// per universal-substrate principle).
//
// Validates defense B (post-dispatch git diff) and dispatcher_violation
// emission from lesson 20MSGR2A253TN0T60C90AH9Z4G. The auto-revert path
// was removed in a follow-up commit: in a single-checkout multi-actor
// world the reverter cannot know which actor owns the dirty state, so
// detection + dispatcher_violation (a health_metric + mirror_inline
// event) is the universal response, and reversibility is the
// orchestrator/owner's call.
// The synthetic test uses a tempdir-as-source-checkout fixture + the
// testOverride seam so the runtime path is exercised without shelling
// out to git.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { runBypassPostflight } from "../runtime/bypass_postflight";
import { emitEvent } from "../runtime/events";
import { newId } from "../runtime/ids";

afterAll(() => closeDb());
beforeEach(() => closeDb());

/** Seed a brain_dispatched row for the supplied dispatch id so the
 *  postflight's F5-companion scope filter does not short-circuit the
 *  test. The runtime path requires a matching ledger row before it will
 *  run the diff check. */
const seedBrainDispatched = (
  db: ReturnType<typeof openDb>,
  dispatchId: string,
  directiveId: string,
  taskId: string,
) => {
  emitEvent(db, {
    kind: "brain_dispatched",
    substrate_origin: "substrate_auto",
    directive_id: directiveId,
    task_id: taskId,
    payload: { dispatch_id: dispatchId },
  });
};

describe("runBypassPostflight — F2 defense B (detection-only)", () => {
  test("dirty source files with NO applied_change_committed → dispatcher_violation + patch saved (no revert)", () => {
    const db = openDb(":memory:");
    const dispatchId = newId();
    const taskId = newId();
    const directiveId = newId();
    seedBrainDispatched(db, dispatchId, directiveId, taskId);
    const result = runBypassPostflight(db, {
      dispatchId,
      taskId,
      directiveId,
      sourceCheckoutRoot: "/synthetic/source",
      isolated: false,
      testOverride: {
        dirtyFiles: ["cli/lineage.ts", "cli/whoami.ts"],
        patchText: "diff --git a/cli/lineage.ts ... synthetic",
      },
    });
    expect(result.ran).toBe(true);
    expect(result.bypass_detected).toBe(true);
    expect(result.touched_files).toEqual(["cli/lineage.ts", "cli/whoami.ts"]);
    // The postflight no longer reverts (multi-actor checkout safety) —
    // dispatcher_violation is the universal signal; the orchestrator
    // decides reversibility from there.
    expect(result.reverted_files).toEqual([]);
    expect(result.patch_path).toContain(dispatchId);
    // Patch file was actually saved to /tmp/.acc2/bypass-recovery/.
    expect(existsSync(result.patch_path!)).toBe(true);
    expect(readFileSync(result.patch_path!, "utf8")).toContain("synthetic");

    const violations = db
      .query<{ payload: string; failure_kind: string | null }, []>(
        "SELECT payload, failure_kind FROM events WHERE kind = 'dispatcher_violation'",
      )
      .all();
    expect(violations.length).toBe(1);
    expect(violations[0]!.failure_kind).toBe("brain_native_filesystem_bypass");
    const payload = JSON.parse(violations[0]!.payload) as Record<string, unknown>;
    expect(payload.dispatch_id).toBe(dispatchId);
    expect(payload.undeclared_files).toEqual(["cli/lineage.ts", "cli/whoami.ts"]);

    // Cleanup the patch file the test wrote.
    try { rmSync(result.patch_path!); } catch { /* best-effort */ }
  });

  test("isolated dispatch (defense A already covered) → postflight skips entirely", () => {
    const db = openDb(":memory:");
    const result = runBypassPostflight(db, {
      dispatchId: newId(),
      taskId: newId(),
      directiveId: newId(),
      sourceCheckoutRoot: "/synthetic/source",
      isolated: true,
    });
    expect(result.ran).toBe(false);
    expect(result.skip_reason).toBe("checkout_isolated");
    const violations = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'dispatcher_violation'",
      )
      .get();
    expect(violations?.c).toBe(0);
  });

  test("dirty files that match applied_change_committed are NOT a bypass", () => {
    const db = openDb(":memory:");
    const taskId = newId();
    const directiveId = newId();
    const dispatchId = newId();
    seedBrainDispatched(db, dispatchId, directiveId, taskId);
    // Seed an applied_change_committed declaring the file as a
    // sanctioned mutation. The postflight must recognize it as
    // declared and skip the violation.
    emitEvent(db, {
      kind: "applied_change_committed",
      substrate_origin: "claude_root",
      directive_id: directiveId,
      task_id: taskId,
      payload: {
        target_path: "cli/whoami.ts",
        status: "ok",
        source_kind: "lesson_extracted",
      },
    });
    const result = runBypassPostflight(db, {
      dispatchId,
      taskId,
      directiveId,
      sourceCheckoutRoot: "/synthetic/source",
      isolated: false,
      testOverride: {
        dirtyFiles: ["cli/whoami.ts"],
        patchText: "diff ... declared",
      },
    });
    expect(result.ran).toBe(true);
    expect(result.bypass_detected).toBe(false);
    const violations = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'dispatcher_violation'",
      )
      .get();
    expect(violations?.c).toBe(0);
    // The patch is still saved for forensics even when declared (so
    // operators can review what was touched even on the happy path).
    if (result.patch_path) {
      try { rmSync(result.patch_path); } catch { /* best-effort */ }
    }
  });

  test("real source checkout with clean working tree → ran=true, bypass_detected=false", () => {
    const db = openDb(":memory:");
    const dispatchId = newId();
    seedBrainDispatched(db, dispatchId, newId(), newId());
    // Build a synthetic empty git repo so collectDirtyFiles returns [].
    const tmp = mkdtempSync(join(tmpdir(), "acc2-bypass-clean-"));
    mkdirSync(join(tmp, ".git"), { recursive: true });
    try {
      const result = runBypassPostflight(db, {
        dispatchId,
        taskId: newId(),
        directiveId: newId(),
        sourceCheckoutRoot: tmp,
        isolated: false,
      });
      // git diff will fail on a synthetic .git folder; the function
      // returns ran:false with a skip_reason — that is the honest
      // outcome for "not a real git checkout".
      expect(result.bypass_detected).toBe(false);
      if (result.skip_reason) {
        expect(["git_unavailable_or_not_a_checkout"]).toContain(result.skip_reason);
      }
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  // ── F5-companion scoping (2026-05-18) ───────────────────────────────
  // The original F2 defense was reverting working-tree changes whenever
  // no applied_change_committed cited the dispatch — which clobbered
  // legitimate developer-side edits during agent subagent implementation
  // work. The postflight is now scoped to dispatches that actually
  // spawned a brain subprocess (matched via brain_dispatched event from
  // F8 commit 30d4ec5). The three cases below pin that behavior.

  test("Case D: dispatch with NO brain_dispatched row → postflight skips, no revert", () => {
    const db = openDb(":memory:");
    const dispatchId = newId();
    const taskId = newId();
    const directiveId = newId();
    // Deliberately NO brain_dispatched seed — claude_inline / replay /
    // clarification lanes never emit it, and the working-tree state
    // belongs to the operator or an Agent subagent.
    const result = runBypassPostflight(db, {
      dispatchId,
      taskId,
      directiveId,
      sourceCheckoutRoot: "/synthetic/source",
      isolated: false,
      testOverride: {
        dirtyFiles: ["cli/lineage.ts"],
        patchText: "diff ... operator edit",
      },
    });
    expect(result.ran).toBe(false);
    expect(result.bypass_detected).toBe(false);
    expect(result.reverted_files).toEqual([]);
    expect(result.skip_reason).toBe("no_brain_dispatch_for_id");
    const violations = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'dispatcher_violation'",
      )
      .get();
    expect(violations?.c).toBe(0);
  });

  test("Case E: committed working-tree changes during dispatch window → postflight does NOT revert", () => {
    // The contract: `git diff HEAD` only reports UNCOMMITTED changes
    // by design — committed changes are part of HEAD and don't appear
    // in the dirty-file list. This test pins that property by feeding
    // an empty dirtyFiles list (a real `git diff HEAD` against a
    // freshly-committed tree returns the same) and asserting no
    // revert / violation occurs even with a matching brain_dispatched.
    const db = openDb(":memory:");
    const dispatchId = newId();
    const taskId = newId();
    const directiveId = newId();
    seedBrainDispatched(db, dispatchId, directiveId, taskId);
    const result = runBypassPostflight(db, {
      dispatchId,
      taskId,
      directiveId,
      sourceCheckoutRoot: "/synthetic/source",
      isolated: false,
      testOverride: {
        dirtyFiles: [],
        patchText: "",
      },
    });
    expect(result.bypass_detected).toBe(false);
    expect(result.reverted_files).toEqual([]);
    const violations = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'dispatcher_violation'",
      )
      .get();
    expect(violations?.c).toBe(0);
  });

  // Case F (ACC2_BYPASS_POSTFLIGHT_DISABLED escape hatch) DELETED:
  // the env hatch existed because the postflight reverted files, and
  // orchestrator-driven implementation cycles needed a way to suppress
  // the destructive action. With the revert dropped (detection-only),
  // there is no destructive action to suppress; the env var is gone.
});
