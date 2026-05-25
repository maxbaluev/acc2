// acc2 crisis_mode tests — Phase I (Architecture.md).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { newId } from "./ids";
import {
  NORMAL_MODE,
  CRISIS_MODE,
  readCurrentMode,
  applyModeAdjustments,
  openCrisisPostmortem,
  openCrisisDirective,
  isLatmAuthoringSuspended,
  emitLatmSuspended,
} from "./crisis_mode";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const openDirective = (
  db: ReturnType<typeof openDb>,
  urgency: "normal" | "elevated" | "crisis",
): string => {
  const id = newId();
  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: id,
    task_id: id,
    payload: { directive_text: "x", lifecycle: "finite", urgency },
  });
  return id;
};

describe("crisis_mode", () => {
  test("constants have expected shape: crisis raises concurrency + halves timeout", () => {
    expect(CRISIS_MODE.max_concurrent).toBeGreaterThan(NORMAL_MODE.max_concurrent);
    expect(CRISIS_MODE.verification_timeout_multiplier).toBeLessThan(
      NORMAL_MODE.verification_timeout_multiplier,
    );
    expect(CRISIS_MODE.latm_authoring_suspended).toBe(true);
    expect(NORMAL_MODE.latm_authoring_suspended).toBe(false);
    expect(CRISIS_MODE.owner_autonomy_interval_ms).toBeLessThan(NORMAL_MODE.owner_autonomy_interval_ms);
    expect(CRISIS_MODE.recipe_confidence_threshold).toBeLessThan(
      NORMAL_MODE.recipe_confidence_threshold,
    );
  });

  test("readCurrentMode returns CRISIS_MODE for urgency=crisis", () => {
    const db = openDb(":memory:");
    const id = openDirective(db, "crisis");
    expect(readCurrentMode(db, id)).toBe(CRISIS_MODE);
  });

  test("readCurrentMode returns NORMAL_MODE for urgency=normal", () => {
    const db = openDb(":memory:");
    const id = openDirective(db, "normal");
    expect(readCurrentMode(db, id)).toBe(NORMAL_MODE);
  });

  test("readCurrentMode reads the LATEST amendment (crisis downgrade)", () => {
    const db = openDb(":memory:");
    const id = openDirective(db, "crisis");
    expect(readCurrentMode(db, id)).toBe(CRISIS_MODE);
    emitEvent(db, {
      kind: "directive_amended",
      substrate_origin: "owner",
      directive_id: id,
      payload: { urgency: "normal", lifecycle: "finite" },
    });
    expect(readCurrentMode(db, id)).toBe(NORMAL_MODE);
  });

  test("applyModeAdjustments raises maxConcurrent under crisis", () => {
    const result = applyModeAdjustments({ maxConcurrent: 5 }, CRISIS_MODE);
    expect(result.maxConcurrent).toBe(20);
  });

  test("applyModeAdjustments leaves normal-mode opts intact", () => {
    const result = applyModeAdjustments({ maxConcurrent: 5 }, NORMAL_MODE);
    expect(result.maxConcurrent).toBe(5);
  });

  test("openCrisisDirective opens directive + crisis_mode_engaged + task", () => {
    const db = openDb(":memory:");
    const { directive_id, task_id } = openCrisisDirective(db, {
      directive_text: "medical emergency",
      initial_task_goal: "triage",
    });
    expect(typeof directive_id).toBe("string");
    expect(typeof task_id).toBe("string");

    const engaged = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'crisis_mode_engaged' AND directive_id = ?")
      .get(directive_id) as { c: number };
    expect(engaged.c).toBe(1);
    expect(readCurrentMode(db, directive_id)).toBe(CRISIS_MODE);
  });

  test("openCrisisPostmortem creates a new directive citing the crisis's irreversible effects", async () => {
    const db = openDb(":memory:");
    const { directive_id: crisisId } = openCrisisDirective(db, {
      directive_text: "fire response",
    });
    emitEvent(db, {
      kind: "irreversible_effect_recorded",
      substrate_origin: "substrate_auto",
      directive_id: crisisId,
      payload: { kind: "evacuation", description: "evacuated building 3" },
    });
    emitEvent(db, {
      kind: "irreversible_effect_recorded",
      substrate_origin: "substrate_auto",
      directive_id: crisisId,
      payload: { kind: "water_damage", description: "level 2 flooded" },
    });

    const result = await openCrisisPostmortem(db, crisisId);
    expect(typeof result.postmortem_directive_id).toBe("string");
    expect(result.postmortem_directive_id).not.toBe(crisisId);

    const opened = db
      .query("SELECT payload FROM events WHERE kind = 'directive_opened' AND directive_id = ?")
      .get(result.postmortem_directive_id) as { payload: string };
    const payload = JSON.parse(opened.payload);
    expect(payload.postmortem_for).toBe(crisisId);
    expect(Array.isArray(payload.effects)).toBe(true);
    expect(payload.effects.length).toBe(2);

    const opens = db
      .query(
        "SELECT COUNT(*) as c FROM events WHERE kind = 'crisis_postmortem_opened' AND directive_id = ?",
      )
      .get(result.postmortem_directive_id) as { c: number };
    expect(opens.c).toBe(1);
  });

  test("isLatmAuthoringSuspended honors mode", () => {
    const db = openDb(":memory:");
    const crisisId = openDirective(db, "crisis");
    const normalId = openDirective(db, "normal");
    expect(isLatmAuthoringSuspended(db, crisisId)).toBe(true);
    expect(isLatmAuthoringSuspended(db, normalId)).toBe(false);
  });

  test("emitLatmSuspended records a latm_suspended_in_crisis event", () => {
    const db = openDb(":memory:");
    const id = openDirective(db, "crisis");
    emitLatmSuspended(db, id, "task_x", "candidate_emission_blocked");
    const rows = db
      .query("SELECT payload FROM events WHERE kind = 'latm_suspended_in_crisis'")
      .all() as Array<{ payload: string }>;
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!.payload).reason).toBe("candidate_emission_blocked");
  });
});
