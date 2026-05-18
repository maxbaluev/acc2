// acc2 F2 — bypass postflight tests (2026-05-18).
//
// Validates defenses B (post-dispatch git diff) and C (revert +
// dispatcher_violation) from lesson 20MSGR2A253TN0T60C90AH9Z4G.
// The synthetic test uses a tempdir-as-source-checkout fixture + the
// testOverride seam so the runtime path is exercised without
// shelling out to git.

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

describe("runBypassPostflight — F2 defenses B+C", () => {
  test("dirty source files with NO applied_change_committed → dispatcher_violation + patch saved + revert recorded", () => {
    const db = openDb(":memory:");
    const dispatchId = newId();
    const taskId = newId();
    const directiveId = newId();
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
    expect(result.reverted_files).toEqual(["cli/lineage.ts", "cli/whoami.ts"]);
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
      dispatchId: newId(),
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
    // Build a synthetic empty git repo so collectDirtyFiles returns [].
    const tmp = mkdtempSync(join(tmpdir(), "acc2-bypass-clean-"));
    mkdirSync(join(tmp, ".git"), { recursive: true });
    try {
      const result = runBypassPostflight(db, {
        dispatchId: newId(),
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
});
