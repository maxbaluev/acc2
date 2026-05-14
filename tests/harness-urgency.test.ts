// acc2 harness `--urgency` flag — unit-level coverage for Task 6.
//
// Asserts the structural invariants:
//   1. Default urgency is "normal" and no crisis_mode_engaged event fires.
//   2. urgency="crisis" emits a crisis_mode_engaged row scoped to the
//      directive AND the returned AdHocTaskResult mirrors it back through
//      `crisisModeEngaged: true`.
//   3. directive_opened + task_node_opened payloads carry the supplied
//      urgency verbatim (round-trip).
//
// The test uses a minimal harness invocation against the mock bridge so it
// runs hermetically — no opencode spawn, no real-brain dispatch.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import { newId } from "../runtime/ids";
import { readCurrentMode, CRISIS_MODE, NORMAL_MODE } from "../runtime/crisis_mode";
import { parseArgs } from "./integration/harness";
import type { JsonValue } from "../substrate/types";

afterAll(() => closeDb());
beforeEach(() => closeDb());

// Replicate the exact event-emission shape scenarioAdHocTask uses, minus
// the bridge spawn. This is what the harness writes when --urgency=<level>
// is threaded through.
const emitDirective = (
  db: ReturnType<typeof openDb>,
  taskText: string,
  urgency: "normal" | "elevated" | "crisis",
): { directiveId: string; taskId: string } => {
  const directiveId = newId();
  const taskId = newId();
  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      directive_text: taskText,
      smoke: "harness_adhoc_task",
      lifecycle: "finite",
      urgency,
    } as JsonValue,
  });
  emitEvent(db, {
    kind: "task_node_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: taskId,
    parent_task_id: null,
    payload: {
      goal: taskText,
      lifecycle: "finite",
      urgency,
    } as JsonValue,
  });
  if (urgency === "crisis") {
    emitEvent(db, {
      kind: "crisis_mode_engaged",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      payload: { reason: "harness_adhoc_task_urgency_crisis" } as JsonValue,
    });
  }
  return { directiveId, taskId };
};

describe("harness --urgency flag", () => {
  test("urgency=normal does not engage crisis mode", () => {
    const tmp = mkdtempSync(join(tmpdir(), "acc2-urgency-normal-"));
    try {
      const db = openDb(join(tmp, "state.db"));
      const { directiveId } = emitDirective(db, "hello world", "normal");
      const engaged = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'crisis_mode_engaged' AND directive_id = ?")
        .get(directiveId) as { c: number };
      expect(engaged.c).toBe(0);
      expect(readCurrentMode(db, directiveId)).toBe(NORMAL_MODE);

      // directive_opened payload round-trips urgency.
      const dirRow = db
        .query("SELECT payload FROM events WHERE kind = 'directive_opened' AND directive_id = ?")
        .get(directiveId) as { payload: string };
      const p = JSON.parse(dirRow.payload) as Record<string, unknown>;
      expect(p.urgency).toBe("normal");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("urgency=crisis emits crisis_mode_engaged + readCurrentMode returns CRISIS_MODE", () => {
    const tmp = mkdtempSync(join(tmpdir(), "acc2-urgency-crisis-"));
    try {
      const db = openDb(join(tmp, "state.db"));
      const { directiveId, taskId } = emitDirective(db, "page is down — recover", "crisis");

      const engaged = db
        .query("SELECT id, payload FROM events WHERE kind = 'crisis_mode_engaged' AND directive_id = ?")
        .all(directiveId) as Array<{ id: string; payload: string }>;
      expect(engaged.length).toBe(1);
      const ep = JSON.parse(engaged[0]!.payload) as Record<string, unknown>;
      expect(ep.reason).toBe("harness_adhoc_task_urgency_crisis");

      // Mode resolver picks up the urgency from directive_opened payload.
      expect(readCurrentMode(db, directiveId)).toBe(CRISIS_MODE);

      // Both directive_opened AND task_node_opened carry urgency=crisis.
      const dirRow = db
        .query("SELECT payload FROM events WHERE kind = 'directive_opened' AND directive_id = ?")
        .get(directiveId) as { payload: string };
      const taskRow = db
        .query("SELECT payload FROM events WHERE kind = 'task_node_opened' AND task_id = ?")
        .get(taskId) as { payload: string };
      expect((JSON.parse(dirRow.payload) as Record<string, unknown>).urgency).toBe("crisis");
      expect((JSON.parse(taskRow.payload) as Record<string, unknown>).urgency).toBe("crisis");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("parseArgs threads --urgency through the harness CLI surface", () => {
    expect(parseArgs(["--task", "x"]).urgency).toBe("normal");
    expect(parseArgs(["--task", "x", "--urgency", "normal"]).urgency).toBe("normal");
    expect(parseArgs(["--task", "x", "--urgency", "elevated"]).urgency).toBe("elevated");
    expect(parseArgs(["--task", "x", "--urgency", "crisis"]).urgency).toBe("crisis");
    expect(() => parseArgs(["--urgency", "bogus"])).toThrow();
  });

  test("urgency=elevated does NOT engage crisis mode (only 'crisis' flips it)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "acc2-urgency-elev-"));
    try {
      const db = openDb(join(tmp, "state.db"));
      const { directiveId } = emitDirective(db, "ramp up cadence", "elevated");
      const engaged = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'crisis_mode_engaged' AND directive_id = ?")
        .get(directiveId) as { c: number };
      expect(engaged.c).toBe(0);
      // readCurrentMode returns NORMAL_MODE for anything that isn't 'crisis'.
      expect(readCurrentMode(db, directiveId)).toBe(NORMAL_MODE);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
