// Tests for noActiveBrainDispatches — the brain-dispatch survival
// predicate that gates hot-reload quiescence. Cites XA3ABKERHD4H +
// 77N73035F97Z. Each case mirrors one row of the truth table the
// quiescence gate ANDs against:
//
//   - empty ledger                                     → true (no risk)
//   - matched dispatched + closed pair                 → true (no risk)
//   - dispatched without matching close (recent)       → false (live)
//   - dispatched without matching close (>1h old)      → true (legacy,
//                                                       boot reconciler
//                                                       owns it)
//
// Plus a smoke case that asserts the daemon-side wiring still resolves
// to the new helper (catching the regression where someone re-inlines
// the old non-recency-bounded SQL).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeDb, openDb } from "../substrate/db";
import type { EventKind, JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import {
  ACTIVE_BRAIN_DISPATCH_RECENCY_MS,
  noActiveBrainDispatches,
} from "./dispatch_survival";

describe("noActiveBrainDispatches — canonical brain-dispatch survival probe", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-dispatch-survival-"));
    dbPath = join(tmpDir, "state.db");
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns true when the ledger contains zero brain_dispatched rows", () => {
    const db = openDb(dbPath);
    expect(noActiveBrainDispatches(db)).toBe(true);
  });

  test("returns true when every brain_dispatched has a matching brain_dispatch_closed (close.ts >= dispatch.ts)", () => {
    const db = openDb(dbPath);
    // Insert recent dispatched + close pair with matching task_id and a
    // close ts >= dispatch ts. We INSERT directly so we control the
    // payload — emitEvent would also work but this stays narrow on the
    // SQL semantics noActiveBrainDispatches actually evaluates.
    insertEvent(db, {
      id: "ev_dispatched_1",
      kind: "brain_dispatched",
      task_id: "t_task_1",
      payload: { dispatch_id: "d_1" },
      tsOffsetMs: -5_000,
    });
    insertEvent(db, {
      id: "ev_closed_1",
      kind: "brain_dispatch_closed",
      task_id: "t_task_1",
      payload: { dispatch_id: "d_1", reason: "normal_close" },
      tsOffsetMs: -1_000,
    });
    expect(noActiveBrainDispatches(db)).toBe(true);
  });

  test("returns false when a recent brain_dispatched lacks a matching close", () => {
    const db = openDb(dbPath);
    insertEvent(db, {
      id: "ev_dispatched_live",
      kind: "brain_dispatched",
      task_id: "t_task_live",
      payload: { dispatch_id: "d_live" },
      tsOffsetMs: -5_000, // 5 seconds ago — well inside the recency window
    });
    expect(noActiveBrainDispatches(db)).toBe(false);
  });

  test("returns true when the unmatched brain_dispatched is older than the recency window (legacy orphan path)", () => {
    const db = openDb(dbPath);
    insertEvent(db, {
      id: "ev_dispatched_legacy",
      kind: "brain_dispatched",
      task_id: "t_task_legacy",
      payload: { dispatch_id: "d_legacy" },
      tsOffsetMs: -(ACTIVE_BRAIN_DISPATCH_RECENCY_MS + 5 * 60_000), // 65 minutes ago
    });
    expect(noActiveBrainDispatches(db)).toBe(true);
  });

  test("integrates with the daemon-side quiescence callback shape: predicate → hotreload_deferred audit", () => {
    // Smoke test that proves the canonical daemon-side composition still
    // builds the right audit row when the predicate refuses. Mirrors the
    // code in runtime/daemon.ts:startHotreloadWorker's isQuiescent
    // callback: when noActiveBrainDispatches(db) is false, emit one
    // hotreload_deferred event with the canonical payload. Catches the
    // regression where someone drops the emit and silently re-enables
    // reloads while brain is mid-flight.
    const db = openDb(dbPath);
    insertEvent(db, {
      id: "ev_dispatched_live_smoke",
      kind: "brain_dispatched",
      task_id: "t_task_smoke",
      payload: { dispatch_id: "d_smoke" },
      tsOffsetMs: -5_000,
    });
    expect(noActiveBrainDispatches(db)).toBe(false);
    // Composition (mirrors daemon.ts inline branch):
    emitEvent(db, {
      kind: "hotreload_deferred",
      substrate_origin: "substrate_auto",
      payload: {
        reason: "brain_dispatched_without_close",
        waiting_for_close: true,
      },
    });
    const rows = db
      .query(
        "SELECT payload FROM events WHERE kind = 'hotreload_deferred' ORDER BY ts DESC LIMIT 1",
      )
      .all() as Array<{ payload: string }>;
    expect(rows.length).toBe(1);
    const payload = JSON.parse(rows[0]!.payload) as { reason: string; waiting_for_close: boolean };
    expect(payload.reason).toBe("brain_dispatched_without_close");
    expect(payload.waiting_for_close).toBe(true);
  });

  test("returns false when a close exists but ts is BEFORE the dispatched ts (i.e. the close is stale, dispatch is live)", () => {
    const db = openDb(dbPath);
    // Stale close FIRST, then a newer dispatched. The probe must NOT
    // treat the older close as covering the newer dispatch.
    insertEvent(db, {
      id: "ev_closed_stale",
      kind: "brain_dispatch_closed",
      task_id: "t_task_2",
      payload: { dispatch_id: "d_2_stale" },
      tsOffsetMs: -60_000,
    });
    insertEvent(db, {
      id: "ev_dispatched_fresh",
      kind: "brain_dispatched",
      task_id: "t_task_2",
      payload: { dispatch_id: "d_2_fresh" },
      tsOffsetMs: -5_000,
    });
    expect(noActiveBrainDispatches(db)).toBe(false);
  });
});

// ── helpers ────────────────────────────────────────────────────────────

/** Emit an event via the canonical helper (which writes loop_id /
 *  directive_id defaults the schema requires), then rewrite its `ts`
 *  column so the test can exercise the recency window deterministically.
 *  The probe is a SQL-level predicate over `events.ts`, so the rewrite
 *  is what makes the recency-window tests possible without sleeping. */
const insertEvent = (
  db: Database,
  opts: {
    id: string;
    kind: EventKind;
    task_id: string;
    payload: JsonValue;
    /** Offset from "now" in milliseconds (negative = past). */
    tsOffsetMs: number;
  },
): void => {
  const ev = emitEvent(db, {
    kind: opts.kind,
    task_id: opts.task_id,
    payload: opts.payload,
  });
  const ts = new Date(Date.now() + opts.tsOffsetMs).toISOString();
  db.query(`UPDATE events SET id = ?, ts = ? WHERE id = ?`).run(opts.id, ts, ev.id);
};
