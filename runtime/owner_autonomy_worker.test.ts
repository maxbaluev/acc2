import { describe, expect, test } from "bun:test";
import { openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { ownerAutonomyWorkerTick } from "./owner_autonomy_worker";

const now = new Date("2026-05-25T12:00:00.000Z");
const openTestDb = () => openDb(`/tmp/acc2-owner-autonomy-${crypto.randomUUID()}.db`);

describe("owner_autonomy_worker", () => {
  test("yields while the owner is active", () => {
    const db = openTestDb();
    emitEvent(db, { kind: "owner_input_received", substrate_origin: "owner", payload: { text: "working" } });
    const summary = ownerAutonomyWorkerTick(db, { now, ownerActiveWindowMs: 10 * 60_000 });
    expect(summary.owner_active).toBe(true);
    expect(summary.emitted_count).toBe(0);
  });

  test("yields while an owner-direct directive is in flight", () => {
    const db = openTestDb();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: "D_OWNER",
      task_id: "T_OWNER",
      payload: { directive_text: "owner work", lifecycle: "finite" },
    });
    const summary = ownerAutonomyWorkerTick(db, { now: new Date("2030-01-01T00:00:00.000Z") });
    expect(summary.owner_directives_in_flight).toBe(1);
    expect(summary.emitted_count).toBe(0);
  });

  test("emits one brain invocation request when idle and profile-grounded", () => {
    const db = openTestDb();
    const profile = emitEvent(db, {
      kind: "owner_profile_recorded",
      substrate_origin: "substrate_auto",
      payload: { autonomy_score: 0.5, preferred_terms: ["owner"] },
    });
    const summary = ownerAutonomyWorkerTick(db, { now: new Date("2030-01-01T00:00:00.000Z") });
    expect(summary.owner_active).toBe(false);
    expect(summary.owner_directives_in_flight).toBe(0);
    expect(summary.profile_event_id).toBe(profile.id);
    expect(summary.emitted_count).toBe(1);

    const row = db.query("SELECT kind, context_refs, payload FROM events WHERE id = ?").get(summary.emitted_event_ids[0]) as { kind: string; context_refs: string; payload: string };
    expect(row.kind).toBe("brain_invocation_request");
    expect(JSON.parse(row.context_refs)).toEqual([profile.id]);
    expect(JSON.parse(row.payload).reason).toBe("owner_autonomy_idle");
  });
});
