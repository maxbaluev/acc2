// acc2 auto-apply worker tests — eligibility scan + signal idempotence.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import {
  collectAutoApplyEligible,
  emitAutoApplySignal,
  runAutoApplyWorkerTick,
} from "./auto_apply_worker";

const emitProposal = (
  db: Database,
  opts: { target: string; anchor: string; diff: string; directive?: string },
): string => {
  return emitEvent(db, {
    kind: "contract_amendment_proposed",
    substrate_origin: "opencode",
    directive_id: opts.directive ?? "d_auto_apply_test",
    task_id: "t_auto_apply_test",
    payload: {
      target: opts.target,
      anchor: opts.anchor,
      current_behavior: "old text",
      proposed_behavior: {
        file_path: opts.target,
        anchor: opts.anchor,
        diff: opts.diff,
      },
      evidence_event_ids: [],
    },
  }).id;
};

describe("auto_apply_worker", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-auto-apply-"));
    dbPath = join(tmpDir, "state.db");
    db = openDb(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("collectAutoApplyEligible returns rows whose auto_apply_eligible=1", () => {
    // Eligible: runtime/* target + structured shape + no hazards.
    emitProposal(db, {
      target: "runtime/foo.ts",
      anchor: "section anchor",
      diff: "new replacement text",
    });
    // Ineligible: missing structured shape.
    emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "d_auto_apply_test",
      task_id: "t_auto_apply_test",
      payload: { target: "runtime/bar.ts", anchor: "x", proposed_behavior: "freeform prose" },
    });
    // Ineligible: owner-gated target (CLAUDE.md).
    emitProposal(db, { target: "CLAUDE.md", anchor: "x", diff: "y" });

    const rows = collectAutoApplyEligible(db);
    expect(rows.length).toBe(1);
    expect(rows[0]?.target).toBe("runtime/foo.ts");
    expect(rows[0]?.structured_change).toBe(1);
  });

  test("runAutoApplyWorkerTick signals each eligible row exactly once", () => {
    const id1 = emitProposal(db, {
      target: "runtime/foo.ts",
      anchor: "first anchor",
      diff: "first replacement",
    });
    const id2 = emitProposal(db, {
      target: "cli/bar.ts",
      anchor: "second anchor",
      diff: "second replacement",
    });

    const first = runAutoApplyWorkerTick(db);
    expect(first.signaled.sort()).toEqual([id1, id2].sort());

    // Second tick: nothing left to signal (idempotence via existing
    // auto_apply_signaled events).
    const second = runAutoApplyWorkerTick(db);
    expect(second.signaled).toEqual([]);

    // Verify the signal rows landed.
    const signals = db
      .query("SELECT id, payload FROM events WHERE kind = 'auto_apply_signaled' ORDER BY ts ASC")
      .all() as Array<{ id: string; payload: string }>;
    expect(signals.length).toBe(2);
    const payloads = signals.map((s) => JSON.parse(s.payload) as Record<string, unknown>);
    expect(payloads[0]?.source_event_id).toBe(id1);
    expect(payloads[1]?.source_event_id).toBe(id2);
    expect(payloads[0]?.stage).toBe("stage_1_signal_only");
  });

  test("emitAutoApplySignal payload carries mirror_inline=true for observers", () => {
    emitProposal(db, {
      target: "runtime/foo.ts",
      anchor: "x",
      diff: "y",
    });
    const rows = collectAutoApplyEligible(db);
    expect(rows.length).toBe(1);
    const signalId = emitAutoApplySignal(db, rows[0]!, Date.now());
    expect(signalId).not.toBeNull();
    const row = db
      .query("SELECT payload FROM events WHERE id = ?")
      .get(signalId!) as { payload: string };
    const payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
    expect(payload.mirror_inline).toBe(true);
  });

  test("worker skips rows already signaled in a previous tick", () => {
    const id = emitProposal(db, {
      target: "runtime/foo.ts",
      anchor: "x",
      diff: "y",
    });
    const first = runAutoApplyWorkerTick(db);
    expect(first.signaled).toEqual([id]);

    // Add a SECOND eligible row, then re-tick. Only the new row signals.
    const id2 = emitProposal(db, {
      target: "runtime/baz.ts",
      anchor: "x2",
      diff: "y2",
    });
    const second = runAutoApplyWorkerTick(db);
    expect(second.signaled).toEqual([id2]);
  });
});
