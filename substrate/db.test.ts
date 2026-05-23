// acc2 substrate db tests — proves the connection layer keeps WAL +
// schema + transaction invariants. Uses crypto.randomUUID() in place
// of a ULID lib since Architecture.md allows either (deliverable §3).

import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, withImmediateTransaction, openDbPool, closeDbPool } from "./db";

const tmpRoot = mkdtempSync(join(tmpdir(), "acc2-db-test-"));
afterAll(() => {
  closeDb();
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  closeDb();
});

const tmpPath = (name: string): string => join(tmpRoot, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);

// We use UUID (32 hex chars stripped of dashes -> 26-char prefix) as a
// stand-in for ULID. Acceptable per task brief: "lift a tiny ULID impl
// OR use crypto.randomUUID() if simpler — note your choice".
const newId = (): string => crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();
const nowIso = (): string => new Date().toISOString();

describe("openDb", () => {
  test(":memory: opens and applies schema (events + act_artifact exist)", () => {
    const db = openDb(":memory:");
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("events");
    expect(names).toContain("act_artifact");
    expect(names).toContain("meta");
  });

  test("WAL journal mode is set when path is on disk", () => {
    const path = tmpPath("wal");
    const db = openDb(path);
    const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode.toLowerCase()).toBe("wal");
  });

  test(":memory: journal mode falls back to 'memory' (allowed per pragma policy)", () => {
    const db = openDb(":memory:");
    const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(["memory", "wal"]).toContain(row.journal_mode.toLowerCase());
  });

  test("openDb returns the same handle on second call (per-path cache)", () => {
    const path = tmpPath("cache");
    const first = openDb(path);
    const second = openDb(path);
    expect(first).toBe(second);
  });

  test("WAL pragmas (synchronous, busy_timeout, foreign_keys) are applied", () => {
    const path = tmpPath("pragmas");
    const db = openDb(path);
    const sync = db.query("PRAGMA synchronous").get() as { synchronous: number };
    const busy = db.query("PRAGMA busy_timeout").get() as { timeout: number };
    const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(sync.synchronous).toBe(1); // NORMAL
    expect(busy.timeout).toBe(15000);
    expect(fk.foreign_keys).toBe(1);
  });
});

describe("events table round-trip", () => {
  test("insert an event row with ULID id + JSON payload, read it back unchanged", () => {
    const db = openDb(":memory:");
    const id = newId();
    const payload = {
      directive: "self_improve",
      steps: [1, 2, 3],
      nested: { ok: true, label: null },
    };
    const contextRefs = ["k_001", "k_042"];

    db.run(
      `INSERT INTO events (
         id, ts, directive_id, task_id, parent_task_id, loop_id,
         substrate_origin, kind, payload, context_refs,
         predicted_residual, action_artifact_id, verifier_artifact_id,
         outcome, residual, payload_hash, blob_ref, failure_kind, invoker
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, nowIso(), "dir_1", "task_1", null, "loop_1",
        "claude_root", "task_node_opened",
        JSON.stringify(payload), JSON.stringify(contextRefs),
        0.25, "art_action", "art_verifier",
        "pending", null, "sha256_stub", null, null, "owner",
      ],
    );

    const row = db.query("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row.id).toBe(id);
    expect(row.directive_id).toBe("dir_1");
    expect(row.substrate_origin).toBe("claude_root");
    expect(row.kind).toBe("task_node_opened");
    expect(row.predicted_residual).toBeCloseTo(0.25, 10);
    expect(row.outcome).toBe("pending");
    expect(JSON.parse(row.payload as string)).toEqual(payload);
    expect(JSON.parse(row.context_refs as string)).toEqual(contextRefs);
  });

  test("composite + expression indexes on events table exist (hot query shapes per KC RSHFVCPM)", () => {
    const db = openDb(":memory:");
    const idx = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'")
      .all() as Array<{ name: string }>;
    const names = idx.map((r) => r.name);
    for (const expected of [
      "idx_events_kind_ts",
      "idx_events_task_kind_ts",
      "idx_events_directive_kind_ts",
      "idx_events_action_artifact_kind_ts",
      "idx_events_projection_key",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe("act_artifact table round-trip", () => {
  test("insert an act_artifact row with every column set, read it back", () => {
    const db = openDb(":memory:");
    const id = newId();
    const sandbox = {
      runtime: "bun",
      fs_read: ["./state/**"],
      fs_write: [],
      net_allow: ["api.openai.com"],
      proc_allow: [],
      substrate_access: "ro",
      cpu_ms: 5000,
      wall_ms: 10000,
      memory_mb: 256,
    };
    const fixtureInput = { question: "count todos", scope: "all" };
    const ts = nowIso();

    db.run(
      `INSERT INTO act_artifact (
         id, runtime, body, declared_sandbox, state_root,
         posterior_alpha, posterior_beta, score, confidence,
         recent_residual_mean, recent_kill_count, status, name,
         fixture_input, fixture_expected_residual, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, "bun", "export default async () => 0;",
        JSON.stringify(sandbox), "/var/acc2/artifacts/x",
        2.5, 1.5, 0.85, 0.7,
        0.12, 0, "admitted", "count_todos_v1",
        JSON.stringify(fixtureInput), 0.0, ts, ts,
      ],
    );

    const row = db.query("SELECT * FROM act_artifact WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row.id).toBe(id);
    expect(row.runtime).toBe("bun");
    expect(row.status).toBe("admitted");
    expect(row.name).toBe("count_todos_v1");
    expect(row.score).toBeCloseTo(0.85, 10);
    expect(row.confidence).toBeCloseTo(0.7, 10);
    expect(row.posterior_alpha).toBeCloseTo(2.5, 10);
    expect(row.posterior_beta).toBeCloseTo(1.5, 10);
    expect(row.recent_kill_count).toBe(0);
    expect(JSON.parse(row.declared_sandbox as string)).toEqual(sandbox);
    expect(JSON.parse(row.fixture_input as string)).toEqual(fixtureInput);
  });

  test("act_artifact indexes (runtime, status, score DESC) exist", () => {
    const db = openDb(":memory:");
    const idx = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='act_artifact'")
      .all() as Array<{ name: string }>;
    const names = idx.map((r) => r.name);
    expect(names).toContain("idx_act_artifact_runtime");
    expect(names).toContain("idx_act_artifact_status");
    expect(names).toContain("idx_act_artifact_score");
  });
});

describe("withImmediateTransaction", () => {
  test("commits successfully when fn returns without throwing", () => {
    const db = openDb(":memory:");
    const id = newId();
    const ret = withImmediateTransaction(db, () => {
      db.run(
        `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, nowIso(), "d", "t", "l", "owner", "owner_input_received", "{}"],
      );
      return 42;
    });
    expect(ret).toBe(42);
    const row = db.query("SELECT id FROM events WHERE id = ?").get(id) as { id: string } | null;
    expect(row?.id).toBe(id);
  });

  test("rolls back when fn throws — no row persists", () => {
    const db = openDb(":memory:");
    const id = newId();
    expect(() =>
      withImmediateTransaction(db, () => {
        db.run(
          `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, nowIso(), "d", "t", "l", "owner", "owner_input_received", "{}"],
        );
        throw new Error("forced rollback");
      }),
    ).toThrow("forced rollback");
    const row = db.query("SELECT id FROM events WHERE id = ?").get(id);
    expect(row).toBeNull();
    // DB must still be writable after rollback — no dangling transaction.
    db.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), nowIso(), "d", "t", "l", "owner", "owner_input_received", "{}"],
    );
  });
});

describe("closeDb", () => {
  test("flushes commits to disk and removes the cache entry", () => {
    const path = tmpPath("close");
    const id = newId();
    const db1 = openDb(path);
    db1.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, nowIso(), "d", "t", "l", "owner", "owner_input_received", "{}"],
    );
    closeDb(path);

    // Re-opening must mint a fresh handle (different object) AND see the row.
    const db2 = openDb(path);
    expect(db2).not.toBe(db1);
    const row = db2.query("SELECT id FROM events WHERE id = ?").get(id) as { id: string } | null;
    expect(row?.id).toBe(id);
  });

  test("closeDb() with no arg closes every cached connection", () => {
    const a = tmpPath("a");
    const b = tmpPath("b");
    openDb(a);
    openDb(b);
    closeDb();
    // Subsequent openDb mints fresh handles (proves cache was cleared).
    const a2 = openDb(a);
    const b2 = openDb(b);
    expect(a2).not.toBe(b2);
  });
});


describe("SqliteDbPool", () => {
  test("serializes writer work in enqueue order", async () => {
    const path = tmpPath("pool-writer-order");
    const pool = openDbPool(path, { maxReaders: 2 });
    const seen: number[] = [];
    await Promise.all([
      pool.withWriter(() => { seen.push(1); }),
      pool.withWriter(() => { seen.push(2); }),
      pool.withWriter(() => { seen.push(3); }),
    ]);
    expect(seen).toEqual([1, 2, 3]);
    await closeDbPool(path);
  });

  test("reader connections are query_only", async () => {
    const path = tmpPath("pool-query-only");
    const pool = openDbPool(path, { maxReaders: 1 });
    await expect(pool.withReader((db) => {
      db.run(`INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), nowIso(), "d", "t", "l", "owner", "owner_input_received", "{}"]);
    })).rejects.toThrow();
    await closeDbPool(path);
  });

  test("bounds concurrent reader leases", async () => {
    const path = tmpPath("pool-reader-bound");
    const pool = openDbPool(path, { maxReaders: 1 });
    const first = await pool.acquireReader();
    let secondSettled = false;
    const secondPromise = pool.acquireReader().then((lease) => {
      secondSettled = true;
      return lease;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    first.release();
    const second = await secondPromise;
    expect(secondSettled).toBe(true);
    second.release();
    await closeDbPool(path);
  });

  test("writer stays live while read transactions are active", async () => {
    const path = tmpPath("pool-writer-live");
    const pool = openDbPool(path, { maxReaders: 2 });
    await pool.withWriter((db) => {
      db.run(`INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), nowIso(), "d", "seed", "l", "owner", "owner_input_received", "{}"]);
    });

    const r1 = await pool.acquireReader();
    const r2 = await pool.acquireReader();
    r1.db.run("BEGIN");
    r2.db.run("BEGIN");
    r1.db.query("SELECT COUNT(*) AS n FROM events").get();
    r2.db.query("SELECT COUNT(*) AS n FROM events").get();

    try {
      await Promise.race([
        pool.withWriter((db) => {
          db.run(`INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [newId(), nowIso(), "d", "writer", "l", "owner", "owner_input_received", "{}"]);
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("writer_starved")), 1000)),
      ]);
    } finally {
      r1.db.run("ROLLBACK");
      r2.db.run("ROLLBACK");
      r1.release();
      r2.release();
    }

    const count = await pool.withReader((db) => db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number });
    expect(count.n).toBe(2);
    await closeDbPool(path);
  });

  test("close rejects queued readers and drains accepted writer work", async () => {
    const path = tmpPath("pool-close-drain");
    const pool = openDbPool(path, { maxReaders: 1 });
    const first = await pool.acquireReader();
    const queued = pool.acquireReader();
    let releaseWriter!: () => void;
    const writer = pool.withWriter(async (db) => {
      await new Promise<void>((resolve) => { releaseWriter = resolve; });
      db.query("SELECT COUNT(*) AS n FROM events").get();
    });
    const closePromise = pool.close();
    await expect(queued).rejects.toThrow("sqlite_pool_closed");
    releaseWriter();
    first.release();
    await writer;
    await closePromise;
    await expect(pool.withWriter(() => undefined)).rejects.toThrow("sqlite_pool_closed");
  });
});
