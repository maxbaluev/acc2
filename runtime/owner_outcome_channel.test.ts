import { afterEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { classifyOwnerOutcomeSignal, recordOwnerObservedOutcome, recordOwnerObservedOutcomeViaMcp } from "./owner_outcome_channel";

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

  // Regression (2026-05-23 isolation-hygiene audit): `runtime.recent_events`
  // projects each row with the field name `event_id` (NOT `id`). The MCP
  // outcome path read `applied.id` and `e.id` directly, so every lookup
  // resolved to undefined: the recorded outcome carried
  // source_applied_change_event_id=undefined and a context_refs array missing
  // the applied-change id — the four-link credit chain silently broke. This
  // pins that the MCP path resolves the applied change id from `event_id` and
  // links it into the emitted outcome.
  test("MCP path resolves applied-change id from event_id field (four-link credit chain)", async () => {
    const recentEvents = [
      // runtime.recent_events returns ts-ASCENDING rows keyed by `event_id`.
      {
        event_id: "ev_action_scored_1",
        kind: "action_scored",
        directive_id: "d_mcp",
        task_id: "t_mcp",
        residual: 0.12,
        payload: { source_act_id: "act_mcp", residual: 0.12 },
      },
      {
        event_id: "ev_applied_1",
        kind: "applied_change_committed",
        directive_id: "d_mcp",
        task_id: "t_mcp",
        residual: 0.12,
        payload: {
          status: "applied",
          source_act_id: "act_mcp",
          source_act_event_id: "act_tuple_mcp",
          action_scored_event_id: "ev_action_scored_1",
        },
      },
    ];

    let emittedArgs: Record<string, unknown> | null = null;
    const mcpCall = async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === "runtime.recent_events") {
        return { ok: true, result: { events: recentEvents } as unknown as Record<string, unknown> };
      }
      if (toolName === "substrate.emit") {
        emittedArgs = args;
        return { ok: true, result: { id: "ev_outcome_1", ts: "2026-05-23T00:00:00.000Z" } };
      }
      return { ok: false, error: `unexpected tool ${toolName}` };
    };

    const result = await recordOwnerObservedOutcomeViaMcp(mcpCall, {
      signal: "worked",
      text: "this worked",
      owner_input_event_id: "owner_input_mcp",
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe("ev_outcome_1");
    expect(emittedArgs).not.toBeNull();
    const args = emittedArgs as unknown as { context_refs: string[]; payload: Record<string, unknown>; directive_id: string };
    // The applied-change id (from event_id) must resolve, not be undefined.
    expect(args.payload.source_applied_change_event_id).toBe("ev_applied_1");
    expect(args.payload.action_scored_event_id).toBe("ev_action_scored_1");
    expect(args.payload.source_act_id).toBe("act_mcp");
    expect(args.payload.previous_residual).toBe(0.12);
    // context_refs binds the owner verdict to the applied change + the scored act.
    expect(args.context_refs).toContain("ev_applied_1");
    expect(args.context_refs).toContain("ev_action_scored_1");
    expect(args.context_refs).toContain("owner_input_mcp");
    expect(args.directive_id).toBe("d_mcp");
  });
});
