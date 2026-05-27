import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import {
  _resetTaskTopologyCacheForTests,
  readDagForDirective,
  readDagForDirectiveReplay,
  readyTasks,
  refinementDepth,
} from "./task_topology";
import { newId } from "./ids";

afterAll(() => closeDb());
beforeEach(() => {
  closeDb();
  _resetTaskTopologyCacheForTests();
});

describe("task_topology", () => {
  test("readDagForDirective round-trips nodes + edges", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const a = newId();
    const b = newId();
    emitEvent(db, {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: a,
      payload: { goal: "A" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: b,
      payload: { goal: "B" },
    });
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: a,
      payload: { from_task: a, to_task: b, kind: "requires" },
    });
    const dag = readDagForDirective(db, directiveId);
    expect(dag.nodes).toHaveLength(2);
    expect(dag.edges).toHaveLength(1);
    expect(dag.edges[0]!.kind).toBe("requires");
    expect(dag.edges[0]!.from_task).toBe(a);
    expect(dag.edges[0]!.to_task).toBe(b);
  });

  test("readyTasks excludes nodes whose required upstreams aren't committed", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const a = newId();
    const b = newId();
    emitEvent(db, { kind: "task_node_opened", directive_id: directiveId, task_id: a, payload: { goal: "A" } });
    emitEvent(db, { kind: "task_node_opened", directive_id: directiveId, task_id: b, payload: { goal: "B" } });
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: b,
      payload: { from_task: a, to_task: b, kind: "requires" },
    });
    // Both are ready-shape, but B requires A which hasn't committed.
    const ready1 = readyTasks(db, directiveId);
    expect(ready1.map((n) => n.id)).toContain(a);
    expect(ready1.map((n) => n.id)).not.toContain(b);

    // Commit A.
    emitEvent(db, {
      kind: "task_committed",
      directive_id: directiveId,
      task_id: a,
      outcome: "succeeded",
      payload: {},
    });
    const ready2 = readyTasks(db, directiveId);
    expect(ready2.map((n) => n.id)).toContain(b);
  });

  test("refinementDepth walks the refines chain upward", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const root = newId();
    const r1 = newId();
    const r2 = newId();
    emitEvent(db, { kind: "task_node_opened", directive_id: directiveId, task_id: root, payload: { goal: "root" } });
    emitEvent(db, { kind: "task_node_opened", directive_id: directiveId, task_id: r1, payload: { goal: "r1" } });
    emitEvent(db, { kind: "task_node_opened", directive_id: directiveId, task_id: r2, payload: { goal: "r2" } });
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: r1,
      payload: { from_task: root, to_task: r1, kind: "refines" },
    });
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: r2,
      payload: { from_task: r1, to_task: r2, kind: "refines" },
    });
    expect(refinementDepth(db, root)).toBe(0);
    expect(refinementDepth(db, r1)).toBe(1);
    expect(refinementDepth(db, r2)).toBe(2);
  });

  // COMPOUNDING SPEEDUP (2026-05-22): the incremental event-cursor cache MUST
  // return a DAG identical to the pure full-replay path, both initially and
  // after new events are appended. A wrong ready-set breaks the scheduler, so
  // this is the load-bearing correctness proof for the cache.
  test("incremental readDagForDirective == full replay across appended events", () => {
    const db = openDb(":memory:");
    // Build a multi-directive, multi-edge fixture so the cache is exercised
    // per-directive (one directive's events must not invalidate another's).
    const dirA = newId();
    const dirB = newId();
    const a1 = newId();
    const a2 = newId();
    const a3 = newId();
    const b1 = newId();
    const b2 = newId();

    // Directive A: a1 → a2 (requires), a1 → a3 (refines).
    emitEvent(db, { kind: "task_node_opened", directive_id: dirA, task_id: a1, payload: { goal: "a1" } });
    emitEvent(db, { kind: "task_node_opened", directive_id: dirA, task_id: a2, payload: { goal: "a2" } });
    emitEvent(db, { kind: "task_node_opened", directive_id: dirA, task_id: a3, payload: { goal: "a3" } });
    emitEvent(db, { kind: "task_edge_recorded", directive_id: dirA, task_id: a2, payload: { from_task: a1, to_task: a2, kind: "requires" } });
    emitEvent(db, { kind: "task_edge_recorded", directive_id: dirA, task_id: a3, payload: { from_task: a1, to_task: a3, kind: "refines" } });
    // Directive B: b1 → b2 (requires).
    emitEvent(db, { kind: "task_node_opened", directive_id: dirB, task_id: b1, payload: { goal: "b1" } });
    emitEvent(db, { kind: "task_node_opened", directive_id: dirB, task_id: b2, payload: { goal: "b2" } });
    emitEvent(db, { kind: "task_edge_recorded", directive_id: dirB, task_id: b2, payload: { from_task: b1, to_task: b2, kind: "requires" } });

    const assertParity = (label: string): void => {
      for (const d of [dirA, dirB]) {
        // Compute the pure replay independently, then the (possibly cached)
        // incremental result. They must be deep-equal.
        const replay = readDagForDirectiveReplay(db, d);
        const incremental = readDagForDirective(db, d);
        expect(incremental).toEqual(replay);
        // Calling again (now guaranteed cache hit) stays identical.
        expect(readDagForDirective(db, d)).toEqual(replay);
      }
      // Ready-set semantics must match the full-replay-derived expectation too.
      // (label kept for failure-message clarity.)
      void label;
    };

    // 1) Initial parity (first call populates the cache).
    assertParity("initial");
    // Warm the cache, then assert ready-set is identical to a from-scratch
    // recompute against the same ledger state.
    const ready1 = readyTasks(db).map((n) => n.id).sort();
    _resetTaskTopologyCacheForTests();
    const ready1Cold = readyTasks(db).map((n) => n.id).sort();
    expect(ready1).toEqual(ready1Cold);
    // a1 ready (no requires), a3 ready (refines isn't a blocker), b1 ready;
    // a2 blocked by a1, b2 blocked by b1.
    expect(ready1).toEqual([a1, a3, b1].sort());

    // 2) Append a new event for dirA only — its cache must invalidate while
    //    dirB's stays valid, and parity must hold.
    emitEvent(db, { kind: "task_committed", directive_id: dirA, task_id: a1, outcome: "succeeded", payload: {} });
    assertParity("after dirA commit");
    const ready2 = readyTasks(db).map((n) => n.id).sort();
    // a1 now committed → a2 unblocked; a3 still ready; b1 ready.
    expect(ready2).toEqual([a2, a3, b1].sort());
    // Cross-check against a fully cold recompute.
    _resetTaskTopologyCacheForTests();
    expect(readyTasks(db).map((n) => n.id).sort()).toEqual(ready2);

    // 3) Append to dirB and re-verify both directives.
    emitEvent(db, { kind: "task_committed", directive_id: dirB, task_id: b1, outcome: "succeeded", payload: {} });
    assertParity("after dirB commit");
    const ready3 = readyTasks(db).map((n) => n.id).sort();
    expect(ready3).toEqual([a2, a3, b2].sort());
    _resetTaskTopologyCacheForTests();
    expect(readyTasks(db).map((n) => n.id).sort()).toEqual(ready3);
  });

  test("cache hit returns the SAME instance until the directive cursor advances", () => {
    const db = openDb(":memory:");
    const dir = newId();
    const t = newId();
    emitEvent(db, { kind: "task_node_opened", directive_id: dir, task_id: t, payload: { goal: "t" } });
    const first = readDagForDirective(db, dir);
    const second = readDagForDirective(db, dir);
    expect(second).toBe(first); // same reference — proves no recompute on hit
    // New event for the directive advances the cursor → fresh instance.
    emitEvent(db, { kind: "task_committed", directive_id: dir, task_id: t, outcome: "succeeded", payload: {} });
    const third = readDagForDirective(db, dir);
    expect(third).not.toBe(first);
    expect(third).toEqual(readDagForDirectiveReplay(db, dir));
  });

  // ARCHIVE-AWARE (credit spine): once DAG rows (task_node_opened /
  // task_edge_recorded) age into a cold `state-archive-YYYY-MM.db` (which the
  // narrowed ALWAYS_KEEP now permits), a hot-only read would return an EMPTY
  // DAG → dense closure credit finds no contributors. The DAG build must UNION
  // hot events with every attached cold archive so the DAG survives archival.
  test("DAG includes nodes + edges that live in an attached cold archive", () => {
    // File-backed DB so a sibling state-archive-*.db can be ATTACHed on open.
    const tmp = mkdtempSync(join(tmpdir(), "acc2-tasktopo-archive-"));
    const dbPath = join(tmp, "state.db");
    try {
      const db = openDb(dbPath);
      const dir = newId();
      const a = newId();
      const b = newId();
      const opened = emitEvent(db, { kind: "task_node_opened", directive_id: dir, task_id: a, payload: { goal: "A" } });
      const openedB = emitEvent(db, { kind: "task_node_opened", directive_id: dir, task_id: b, payload: { goal: "B" } });
      const edge = emitEvent(db, {
        kind: "task_edge_recorded",
        directive_id: dir,
        task_id: b,
        payload: { from_task: a, to_task: b, kind: "requires" },
      });

      // Move the DAG rows into a cold archive sibling and delete from hot.
      const archivePath = join(tmp, "state-archive-2026-01.db");
      const arch = new Sqlite(archivePath, { create: true, strict: true });
      const archiveRowAndDeleteHot = (id: string): void => {
        const row = db.query("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown>;
        const cols = Object.keys(row);
        arch.exec(`CREATE TABLE IF NOT EXISTS events (${cols.map((c) => `${c} ${c === "id" ? "TEXT PRIMARY KEY" : "TEXT"}`).join(", ")})`);
        arch.query(`INSERT INTO events (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c] as never));
        db.run("DELETE FROM events WHERE id = ?", [id]);
      };
      archiveRowAndDeleteHot(opened.id);
      archiveRowAndDeleteHot(openedB.id);
      archiveRowAndDeleteHot(edge.id);
      arch.close();

      // Reopen so attachArchives picks up the new sibling, and clear the memo.
      closeDb(dbPath);
      const db2 = openDb(dbPath);
      _resetTaskTopologyCacheForTests();

      // Hot `events` now holds NONE of the DAG rows — the tier-spanning union
      // must still recover the two nodes and the requires edge from cold.
      const dag = readDagForDirective(db2, dir);
      expect(dag.nodes.map((n) => n.id).sort()).toEqual([a, b].sort());
      expect(dag.edges).toHaveLength(1);
      expect(dag.edges[0]!.kind).toBe("requires");
      expect(dag.edges[0]!.from_task).toBe(a);
      expect(dag.edges[0]!.to_task).toBe(b);

      // readyTasks (no directive arg) must also see the archived directive via
      // its tier-spanning DISTINCT directive_id scan, and refinementDepth's
      // cold edge scan must observe the archived requires edge (depth 0 here).
      const ready = readyTasks(db2).map((n) => n.id);
      expect(ready).toContain(a); // a has no requires upstream
      expect(ready).not.toContain(b); // b requires a, not yet committed
      expect(refinementDepth(db2, a)).toBe(0);
    } finally {
      closeDb(dbPath);
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
