import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { verifyHealWorkerTick } from "./verify_heal";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const HOURS = 60 * 60 * 1000;
const ISO_25H_AGO = new Date(Date.now() - 25 * HOURS).toISOString();
const ISO_NOW = new Date().toISOString();

describe("verify_heal worker tick", () => {
  test("opens a corrective directive for an old drift contradiction", () => {
    const db = openDb(":memory:");
    const proposalEv = emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "d_orig",
      task_id: "t_orig",
      payload: { target: "runtime/foo.ts", anchor: "// old", proposed_behavior: "// new" },
    });
    const contradiction = db.query(`INSERT INTO events
      (id, ts, kind, directive_id, task_id, parent_task_id, loop_id, substrate_origin, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(
        "contradiction_event_id_x",
        ISO_25H_AGO,
        "knowledge_contradiction_observed",
        "d_orig",
        "t_orig",
        null,
        "loop_x",
        "claude_root",
        JSON.stringify({
          knowledge_id: proposalEv.id,
          commit_sha: "abc1234567890",
          verdict: "drift",
          weight: 0.5,
          reason: "test",
        }),
      ) as { id: string };
    expect(contradiction.id).toBe("contradiction_event_id_x");
    const result = verifyHealWorkerTick(db);
    expect(result.scanned).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(result.too_recent).toBe(0);
    const directiveRows = db.query(`SELECT payload FROM events WHERE kind='directive_opened' AND substrate_origin='substrate_auto'`).all() as Array<{ payload: string }>;
    expect(directiveRows.length).toBe(1);
    const dp = JSON.parse(directiveRows[0]!.payload);
    expect(dp.corrective_for_proposal_id).toBe(proposalEv.id);
    expect(dp.corrective_for_contradiction_event_id).toBe("contradiction_event_id_x");
  });

  test("skips fresh contradictions (< ageThresholdMs)", () => {
    const db = openDb(":memory:");
    const proposalEv = emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "d_fresh",
      task_id: "t_fresh",
      payload: { target: "x", anchor: "y", proposed_behavior: "z" },
    });
    db.run(`INSERT INTO events
      (id, ts, kind, directive_id, task_id, parent_task_id, loop_id, substrate_origin, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "fresh_contradiction",
        ISO_NOW,
        "knowledge_contradiction_observed",
        "d_fresh",
        "t_fresh",
        null,
        "loop_f",
        "claude_root",
        JSON.stringify({ knowledge_id: proposalEv.id, commit_sha: "deadbeef00", verdict: "drift" }),
      ],
    );
    const result = verifyHealWorkerTick(db);
    expect(result.scanned).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(result.too_recent).toBe(1);
  });

  test("idempotent — second tick on same drift does not double-dispatch", () => {
    const db = openDb(":memory:");
    const proposalEv = emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "d_idem",
      task_id: "t_idem",
      payload: { target: "x", anchor: "y", proposed_behavior: "z" },
    });
    db.run(`INSERT INTO events
      (id, ts, kind, directive_id, task_id, parent_task_id, loop_id, substrate_origin, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "idem_contradiction",
        ISO_25H_AGO,
        "knowledge_contradiction_observed",
        "d_idem",
        "t_idem",
        null,
        "loop_i",
        "claude_root",
        JSON.stringify({ knowledge_id: proposalEv.id, commit_sha: "feedface00", verdict: "drift" }),
      ],
    );
    const r1 = verifyHealWorkerTick(db);
    expect(r1.dispatched).toBe(1);
    const r2 = verifyHealWorkerTick(db);
    expect(r2.dispatched).toBe(0);
    expect(r2.already_dispatched).toBe(1);
  });

  test("respects dispatchLimitPerTick", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 7; i++) {
      const proposalEv = emitEvent(db, {
        kind: "contract_amendment_proposed",
        substrate_origin: "opencode",
        directive_id: `d_${i}`,
        task_id: `t_${i}`,
        payload: { target: `f${i}.ts`, anchor: "y", proposed_behavior: "z" },
      });
      db.run(`INSERT INTO events
        (id, ts, kind, directive_id, task_id, parent_task_id, loop_id, substrate_origin, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `contradiction_${i}`,
          ISO_25H_AGO,
          "knowledge_contradiction_observed",
          `d_${i}`,
          `t_${i}`,
          null,
          `loop_${i}`,
          "claude_root",
          JSON.stringify({ knowledge_id: proposalEv.id, commit_sha: `commit_${i}`, verdict: "drift" }),
        ],
      );
    }
    const r = verifyHealWorkerTick(db, { dispatchLimitPerTick: 3 });
    expect(r.scanned).toBeGreaterThanOrEqual(3);
    expect(r.dispatched).toBe(3);
  });
});
