// F9 SQL pool tests. Five cases:
//   (a) pool init applies the WAL + writer pragmas (autocheckpoint=1000,
//       busy_timeout=5000, journal_mode=wal, synchronous=NORMAL, mmap=256MB).
//   (b) concurrent reads share pool connections (acquireReader twice within
//       maxReaders does not queue).
//   (c) concurrent writes serialize through the single writer slot in
//       enqueue order.
//   (d) close drains pending operations (queued readers reject;
//       accepted writers settle).
//   (e) getPoolStats / pool.stats() returns the expected fields and counters.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDbPool, closeDbPool, getPoolStats, getAllPoolStats } from "../substrate/db";

const tmpPath = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `acc2-pool-${label}-`));
  return join(dir, `${label}.db`);
};

const openPaths: string[] = [];

afterEach(async () => {
  for (const p of openPaths) {
    try { await closeDbPool(p); } catch { /* tolerate */ }
  }
  openPaths.length = 0;
});

const openTrackedPool = (label: string, maxReaders = 2): { pool: ReturnType<typeof openDbPool>; path: string } => {
  const path = tmpPath(label);
  openPaths.push(path);
  return { pool: openDbPool(path, { maxReaders }), path };
};

describe("F9 SqliteDbPool", () => {
  test("(a) pool init applies WAL + writer pragmas", async () => {
    const { pool } = openTrackedPool("pragmas");
    const pragmas = await pool.withWriter((db) => {
      return {
        journal_mode: (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
        synchronous: (db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous,
        autocheckpoint: (db.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number }).wal_autocheckpoint,
        busy_timeout: (db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
        mmap_size: (db.query("PRAGMA mmap_size").get() as { mmap_size: number }).mmap_size,
      };
    });
    expect(pragmas.journal_mode).toBe("wal");
    expect(pragmas.synchronous).toBe(1); // NORMAL
    expect(pragmas.autocheckpoint).toBe(1000);
    expect(pragmas.busy_timeout).toBe(5000);
    // 2026-05-21 tuning bump: applyWalPragmas (substrate/db.ts) raised
    // mmap_size to 1GB for the writer connection so frequently-queried
    // views stay hot on the 800MB+ production DB. The reader pool
    // still uses 256MB (applyReaderPragmas). Writer-mmap value follows
    // the bump.
    expect(pragmas.mmap_size).toBe(1073741824);
  });

  test("(b) concurrent reads share pool connections (no queue when under maxReaders)", async () => {
    const { pool } = openTrackedPool("concurrent-reads", 2);
    const r1 = await pool.acquireReader();
    const r2 = await pool.acquireReader();
    // Both leases granted immediately because maxReaders=2.
    expect(r1.db).toBeDefined();
    expect(r2.db).toBeDefined();
    // The two leases hold different bun:sqlite Database instances —
    // the pool maintains N connections, not one shared.
    expect(r1.db).not.toBe(r2.db);
    r1.release();
    r2.release();
  });

  test("(c) concurrent writes serialize through writer slot in enqueue order", async () => {
    const { pool } = openTrackedPool("writer-serialize");
    const order: number[] = [];
    await Promise.all([
      pool.withWriter(async () => { await Bun.sleep(10); order.push(1); }),
      pool.withWriter(async () => { await Bun.sleep(5); order.push(2); }),
      pool.withWriter(async () => { order.push(3); }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("(d) close drains accepted writers and rejects queued readers", async () => {
    const { pool, path } = openTrackedPool("close-drain", 1);
    const r1 = await pool.acquireReader();
    const queuedReader = pool.acquireReader();
    let releaseWriter!: () => void;
    const writer = pool.withWriter(async () => {
      await new Promise<void>((resolve) => { releaseWriter = resolve; });
    });
    const closePromise = closeDbPool(path);
    await expect(queuedReader).rejects.toThrow("sqlite_pool_closed");
    releaseWriter();
    r1.release();
    await writer;
    await closePromise;
    expect(pool.stats().closed).toBe(true);
  });

  test("(e) getPoolStats reflects accurate state across operations", async () => {
    const { pool, path } = openTrackedPool("stats");
    // Initial state — no work has run yet.
    const initial = getPoolStats(pool);
    expect(initial.connections_total).toBeGreaterThanOrEqual(1); // writer
    expect(initial.connections_idle).toBe(0);
    expect(initial.connections_busy).toBe(0);
    expect(initial.write_queue_depth).toBe(0);
    expect(initial.total_reads).toBe(0);
    expect(initial.total_writes).toBe(0);
    expect(initial.closed).toBe(false);
    expect(initial.db_path).toBe(path);

    // Lease a reader, then write — counters should increment.
    const lease = await pool.acquireReader();
    expect(getPoolStats(pool).connections_busy).toBe(1);
    lease.release();
    await pool.withWriter(() => undefined);
    const after = getPoolStats(pool);
    expect(after.total_reads).toBe(1);
    expect(after.total_writes).toBe(1);
    expect(after.connections_busy).toBe(0);

    // getAllPoolStats should include this pool's entry.
    const all = getAllPoolStats();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.some((s) => s.db_path === path)).toBe(true);
  });
});
