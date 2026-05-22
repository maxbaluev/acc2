import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import {
  claimDispatchLease,
  releaseDispatchLease,
  reconcileExpiredLeases,
  dispatchLeaseHolder,
  ensureDispatchLeaseTable,
  DISPATCH_LEASE_TTL_MS,
} from "./dispatch_leases";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("dispatch_leases — durable cross-process brain-dispatch claim", () => {
  test("runMigrations creates the dispatch_leases table (openDb path)", () => {
    const db = openDb(":memory:");
    const cols = db
      .query("PRAGMA table_info(dispatch_leases)")
      .all() as Array<{ name: string; pk: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["expires_at", "holder", "leased_at", "task_id"]);
    // task_id is the primary key (single-row atomic upsert).
    expect(cols.find((c) => c.name === "task_id")?.pk).toBe(1);
  });

  test("NO DOUBLE-CLAIM: a second holder cannot claim an unexpired lease", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-05-22T00:00:00.000Z");
    const first = claimDispatchLease(db, "task-A", "holder-1", { nowMs: now });
    expect(first.status).toBe("claimed");

    // Second holder, well within TTL → must be told it's held by holder-1.
    const second = claimDispatchLease(db, "task-A", "holder-2", { nowMs: now + 1000 });
    expect(second.status).toBe("held");
    if (second.status === "held") expect(second.holder).toBe("holder-1");

    // The authoritative row still belongs to holder-1 (no double-dispatch).
    expect(dispatchLeaseHolder(db, "task-A", { nowMs: now + 1000 })?.holder).toBe("holder-1");
  });

  test("renewal: the SAME holder may re-claim (idempotent, extends expiry)", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-05-22T00:00:00.000Z");
    const a = claimDispatchLease(db, "task-R", "holder-1", { nowMs: now, ttlMs: 10_000 });
    expect(a.status).toBe("claimed");
    const b = claimDispatchLease(db, "task-R", "holder-1", { nowMs: now + 5_000, ttlMs: 10_000 });
    expect(b.status).toBe("claimed");
    if (a.status === "claimed" && b.status === "claimed") {
      // Renewal pushed expiry later.
      expect(Date.parse(b.expires_at)).toBeGreaterThan(Date.parse(a.expires_at));
    }
  });

  test("NO PERMANENT BLOCK: an expired lease is reclaimable by anyone", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-05-22T00:00:00.000Z");
    const first = claimDispatchLease(db, "task-E", "holder-1", { nowMs: now, ttlMs: 1_000 });
    expect(first.status).toBe("claimed");

    // After TTL elapses, a DIFFERENT holder reclaims via the atomic upsert.
    const reclaim = claimDispatchLease(db, "task-E", "holder-2", { nowMs: now + 5_000, ttlMs: 1_000 });
    expect(reclaim.status).toBe("claimed");
    if (reclaim.status === "claimed") expect(reclaim.holder).toBe("holder-2");
    expect(dispatchLeaseHolder(db, "task-E", { nowMs: now + 5_000 })?.holder).toBe("holder-2");
  });

  test("RELEASE re-claimable: after release a fresh holder may claim", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-05-22T00:00:00.000Z");
    expect(claimDispatchLease(db, "task-X", "holder-1", { nowMs: now }).status).toBe("claimed");
    // While unexpired, holder-2 is blocked…
    expect(claimDispatchLease(db, "task-X", "holder-2", { nowMs: now + 10 }).status).toBe("held");
    // …until holder-1 releases.
    expect(releaseDispatchLease(db, "task-X")).toBe(true);
    const after = claimDispatchLease(db, "task-X", "holder-2", { nowMs: now + 20 });
    expect(after.status).toBe("claimed");
  });

  test("RELEASE is idempotent: releasing an absent lease is a harmless no-op", () => {
    const db = openDb(":memory:");
    expect(releaseDispatchLease(db, "never-leased")).toBe(false);
    const now = Date.parse("2026-05-22T00:00:00.000Z");
    claimDispatchLease(db, "task-I", "holder-1", { nowMs: now });
    expect(releaseDispatchLease(db, "task-I")).toBe(true);
    // Second release: no row, no throw, returns false.
    expect(releaseDispatchLease(db, "task-I")).toBe(false);
  });

  test("BOOT RECONCILE clears expired leases but leaves live ones", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-05-22T00:00:00.000Z");
    // Stale (crashed-holder) lease — short TTL, already expired at sweep time.
    claimDispatchLease(db, "task-stale", "dead-daemon", { nowMs: now, ttlMs: 1_000 });
    // Live lease — long TTL, still valid at sweep time.
    claimDispatchLease(db, "task-live", "live-daemon", { nowMs: now, ttlMs: 1_000_000 });

    const released = reconcileExpiredLeases(db, { nowMs: now + 5_000 });
    expect(released).toEqual(["task-stale"]);
    // The live lease survives (another worker daemon may still own it).
    expect(dispatchLeaseHolder(db, "task-live", { nowMs: now + 5_000 })?.holder).toBe("live-daemon");
    // The stale slot is now free → reclaimable.
    expect(claimDispatchLease(db, "task-stale", "fresh-daemon", { nowMs: now + 5_000 }).status).toBe("claimed");
  });

  test("FAIL OPEN: a lease-table write failure returns error (caller degrades to in-memory, never stalls)", () => {
    const db = openDb(":memory:");
    // Simulate a lease-table fault by dropping the table out from under the
    // claim. The claim must report `error` (not throw), so the scheduler can
    // fall through to the in-memory IN_FLIGHT_BRAIN dedup rather than wedging.
    db.run("DROP TABLE dispatch_leases");
    const res = claimDispatchLease(db, "task-F", "holder-1");
    expect(res.status).toBe("error");
    // Release must also be fault-tolerant (no throw) when the table is gone.
    expect(() => releaseDispatchLease(db, "task-F")).not.toThrow();
    // And boot reconcile fails open to [] rather than throwing.
    expect(reconcileExpiredLeases(db)).toEqual([]);
  });

  test("ensureDispatchLeaseTable is idempotent (safe to re-run)", () => {
    const db = openDb(":memory:");
    expect(() => {
      ensureDispatchLeaseTable(db);
      ensureDispatchLeaseTable(db);
    }).not.toThrow();
  });

  test("default TTL pads above the brain wall timeout (no expiry under a healthy run)", () => {
    // A lease must not expire WHILE a healthy brain dispatch is still running,
    // or a peer daemon could double-dispatch. TTL therefore exceeds the brain
    // wall timeout.
    expect(DISPATCH_LEASE_TTL_MS).toBeGreaterThan(1_500_000);
  });
});
