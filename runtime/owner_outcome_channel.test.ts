import { afterEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { classifyOwnerOutcomeSignal, recordOwnerObservedOutcome } from "./owner_outcome_channel";

afterEach(() => closeDb());

describe("owner_outcome_channel", () => {
  test("classifies common owner outcome language", () => {
    expect(classifyOwnerOutcomeSignal("this worked" )).toBe("worked");
    expect(classifyOwnerOutcomeSignal("still broken" )).toBe("broke");
    expect(classifyOwnerOutcomeSignal("not what I meant" )).toBe("not_what_i_meant");
    expect(classifyOwnerOutcomeSignal("this is closer but needs changes" )).toBe("partial");
    expect(classifyOwnerOutcomeSignal("please implement the next thing" )).toBeNull();
  });

  test("records linked owner-observed outcome with residual adjustment", () => {
    const db = openDb();
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "directive_owner_outcome",
      task_id: "task_owner_outcome",
      residual: 0.12,
      outcome: "succeeded",
      context_refs: ["act_owner_outcome"],
      payload: {
        source_act_id: "act_owner_outcome",
        residual: 0.12,
        verifier_kind: "deterministic_code",
      },
    });
    const applied = emitEvent(db, {
      kind: "applied_change_committed",
      substrate_origin: "claude_root",
      directive_id: "directive_owner_outcome",
      task_id: "task_owner_outcome",
      residual: 0.12,
      outcome: "succeeded",
      context_refs: ["act_owner_outcome", scored.id],
      payload: {
        status: "applied",
        source_act_id: "act_owner_outcome",
        source_act_event_id: "act_tuple_owner_outcome",
        action_scored_event_id: scored.id,
        affected_resources: ["runtime/example.ts"],
      },
    });

    const emitted = recordOwnerObservedOutcome(db, {
      signal: "broke",
      text: "still broken",
      owner_input_event_id: "owner_input_owner_outcome",
      target: { source_applied_change_event_id: applied.id },
    });

    expect(emitted).not.toBeNull();
    const row = db.query<{ payload: string; context_refs: string; residual: number | null; outcome: string | null }, [string]>(
      `SELECT payload, context_refs, residual, outcome FROM events WHERE id = ?`,
    ).get(emitted!.id);
    expect(row).not.toBeNull();
    const payload = JSON.parse(row!.payload) as Record<string, unknown>;
    const refs = JSON.parse(row!.context_refs) as string[];
    expect(row!.residual).toBe(0.95);
    expect(row!.outcome).toBe("failed");
    expect(refs).toContain(applied.id);
    expect(refs).toContain(scored.id);
    expect(refs).toContain("act_owner_outcome");
    expect(payload.source_applied_change_event_id).toBe(applied.id);
    expect(payload.action_scored_event_id).toBe(scored.id);
    expect(payload.source_act_id).toBe("act_owner_outcome");
    expect(payload.previous_residual).toBe(0.12);
    expect(payload.residual_delta).toBeCloseTo(0.83);
    expect((payload.residual_adjustment as Record<string, unknown>).to).toBe(0.95);
    expect(payload.signal_class).toBe("negative_strong");
  });
});
