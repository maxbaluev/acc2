// acc2 archival worker tests — verify hot/cold archival sweep
// behavior: monthly bucketing, idempotency, integrity rollback on
// verify failure, and cold-archive listing/union surfaces.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import {
  runArchivalSweep,
  runTelemetryEvictionSweep,
  retainedEvictedCount,
  curationModeForKind,
  evaluateLedgerCurationPressure,
  _listArchivesForDir,
} from "./archival_worker";
import { listArchives, openColdDb, searchAcrossArchives } from "../substrate/cold_db";
import { setSqlPool, clearSqlPool } from "./sql_pool_singleton";

const eventsCount = (db: Database, kind?: string): number => {
  if (kind) {
    return (
      db.query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM events WHERE kind = ?").get(kind)
        ?.c ?? 0
    );
  }
  return db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events").get()?.c ?? 0;
};

const eventsByKind = (db: Database, kind: string): Array<Record<string, unknown>> =>
  db.query("SELECT * FROM events WHERE kind = ? ORDER BY ts ASC").all(kind) as Array<
    Record<string, unknown>
  >;

const seedEventAtTs = (db: Database, tsIso: string, idx: number): string => {
  const ev = emitEvent(db, {
    kind: "directive_opened",
    payload: { directive_text: `seed-${idx}`, idx },
  });
  // Rewrite ts on the row so we can synthesize "old" events without
  // relying on Date.now() — the worker reads `ts` for cutoff.
  db.run("UPDATE events SET ts = ? WHERE id = ?", [tsIso, ev.id]);
  return ev.id;
};

describe("runArchivalSweep — basic monthly archival", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;
  const NOW = Date.parse("2026-05-15T12:00:00.000Z");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-archival-"));
    dbPath = join(tmpDir, "state.db");
    db = openDb(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("100 events, 50 within retention + 50 across two old months → 50 archived, hot drops to 50", async () => {
    // 50 "recent" events within retention (5 days ago).
    for (let i = 0; i < 50; i++) {
      const ts = new Date(NOW - 5 * 24 * 60 * 60 * 1000 + i * 1000).toISOString();
      seedEventAtTs(db, ts, i);
    }
    // 25 events in 2026-02 (older than 30-day retention).
    for (let i = 0; i < 25; i++) {
      const ts = new Date(Date.parse("2026-02-10T00:00:00.000Z") + i * 1000).toISOString();
      seedEventAtTs(db, ts, 100 + i);
    }
    // 25 events in 2026-03 (also older than 30-day retention).
    for (let i = 0; i < 25; i++) {
      const ts = new Date(Date.parse("2026-03-12T00:00:00.000Z") + i * 1000).toISOString();
      seedEventAtTs(db, ts, 200 + i);
    }

    const hotBefore = eventsCount(db);
    expect(hotBefore).toBe(100);

    const summary = await runArchivalSweep(db, {
      stateDbPath: dbPath,
      nowMs: NOW,
      retentionDays: 30,
    });

    expect(summary.scanned).toBe(50);
    expect(summary.deleted).toBe(50);
    expect(summary.errors).toBe(0);
    expect(summary.archived_by_month["2026-02"]).toBe(25);
    expect(summary.archived_by_month["2026-03"]).toBe(25);
    expect(summary.retention_days).toBe(30);

    // 50 recent rows remain + 1 archival_sweep_completed self-emit.
    const hotAfter = eventsCount(db);
    expect(hotAfter).toBe(50 + 1);

    // Two archive files exist with the right per-month counts.
    const feb = join(tmpDir, "state-archive-2026-02.db");
    const mar = join(tmpDir, "state-archive-2026-03.db");
    expect(existsSync(feb)).toBe(true);
    expect(existsSync(mar)).toBe(true);

    const febDb = new Database(feb, { readonly: true });
    expect(eventsCount(febDb)).toBe(25);
    febDb.close();

    const marDb = new Database(mar, { readonly: true });
    expect(eventsCount(marDb)).toBe(25);
    marDb.close();

    // archival_sweep_completed event landed with the right payload.
    const completed = eventsByKind(db, "archival_sweep_completed");
    expect(completed.length).toBe(1);
    const payload = JSON.parse(completed[0].payload as string) as Record<string, unknown>;
    expect(payload.deleted).toBe(50);
    expect((payload.archived_by_month as Record<string, number>)["2026-02"]).toBe(25);
  });

  test("re-run is idempotent — no additional archived rows, no double-credit", async () => {
    // 10 events in 2026-02.
    for (let i = 0; i < 10; i++) {
      const ts = new Date(Date.parse("2026-02-10T00:00:00.000Z") + i * 1000).toISOString();
      seedEventAtTs(db, ts, i);
    }

    const first = await runArchivalSweep(db, {
      stateDbPath: dbPath,
      nowMs: NOW,
      retentionDays: 30,
    });
    expect(first.deleted).toBe(10);
    expect(first.archived_by_month["2026-02"]).toBe(10);

    // Second sweep: nothing left to scan, archived map empty, no
    // additional archive rows.
    const archivePath = join(tmpDir, "state-archive-2026-02.db");
    const archiveBefore = new Database(archivePath, { readonly: true });
    const archCountBefore = eventsCount(archiveBefore);
    archiveBefore.close();
    expect(archCountBefore).toBe(10);

    const second = await runArchivalSweep(db, {
      stateDbPath: dbPath,
      nowMs: NOW,
      retentionDays: 30,
    });
    expect(second.scanned).toBe(0);
    expect(second.deleted).toBe(0);
    expect(Object.keys(second.archived_by_month).length).toBe(0);

    const archiveAfter = new Database(archivePath, { readonly: true });
    expect(eventsCount(archiveAfter)).toBe(10);
    archiveAfter.close();
  });

  test("uses threshold registry default when retentionDays not passed", async () => {
    // Seed an old event well past any retention window.
    seedEventAtTs(db, "2026-01-05T00:00:00.000Z", 1);
    // No threshold seeded → retuned default of 7 days applies via getThreshold
    // (amendment J9SJZDKA shrank the no-pressure default from 30 to 7).
    const summary = await runArchivalSweep(db, { stateDbPath: dbPath, nowMs: NOW });
    expect(summary.retention_days).toBe(7);
    expect(summary.deleted).toBe(1);
  });
});

describe("runArchivalSweep — integrity failure rollback", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;
  const NOW = Date.parse("2026-05-15T12:00:00.000Z");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-archival-integrity-"));
    dbPath = join(tmpDir, "state.db");
    db = openDb(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("pre-existing archive in path blocked from writing → archival_integrity_failed + hot untouched", async () => {
    // Seed 5 old events that would otherwise archive.
    for (let i = 0; i < 5; i++) {
      const ts = new Date(Date.parse("2026-02-10T00:00:00.000Z") + i * 1000).toISOString();
      seedEventAtTs(db, ts, i);
    }
    const hotBefore = eventsCount(db);

    // Create a pre-existing archive file containing an INCOMPATIBLE
    // events table — TEXT id column is shared, but we'll insert a
    // dummy row with one of the soon-to-be-archived ids so INSERT OR
    // IGNORE keeps the existing dummy and the sample-verification
    // count still matches. To force a verify mismatch instead, we
    // pre-populate the archive's events table with a rowcount-only
    // sentinel that does NOT match any candidate id, then we delete
    // the archive's table mid-flight via a chmod-style replacement.
    //
    // Simpler approach: mock by passing a tiny bucket, pre-deleting
    // a row, then catching the verify mismatch. We achieve a
    // realistic failure path by directly corrupting the archive
    // post-open: hook in a beforeEach style by writing a SQL file
    // that pre-creates the events table with an extra UNIQUE
    // constraint on `ts` so the second row INSERT IGNOREs but the
    // verify count is short.
    const archivePath = join(tmpDir, "state-archive-2026-02.db");
    const seed = new Database(archivePath);
    seed.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL UNIQUE,
        directive_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        parent_task_id TEXT,
        loop_id TEXT NOT NULL,
        substrate_origin TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        context_refs TEXT NOT NULL DEFAULT '[]',
        predicted_residual REAL,
        action_artifact_id TEXT,
        verifier_artifact_id TEXT,
        outcome TEXT,
        residual REAL,
        embedding BLOB,
        embedding_version TEXT,
        payload_hash TEXT,
        blob_ref TEXT,
        failure_kind TEXT,
        invoker TEXT
      );
    `);
    // Pre-insert a row whose ts collides with one of the candidates.
    const collidingTs = new Date(Date.parse("2026-02-10T00:00:00.000Z") + 0 * 1000).toISOString();
    seed.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload)
       VALUES ('pre_existing_decoy', ?, 'd', 't', 'l', 'substrate_auto', 'directive_opened', '{}')`,
      [collidingTs],
    );
    seed.close();

    const summary = await runArchivalSweep(db, {
      stateDbPath: dbPath,
      nowMs: NOW,
      retentionDays: 30,
    });

    // Either: (a) the UNIQUE(ts) constraint surfaced as an exception
    // and rolled back, or (b) the INSERT OR IGNORE silently dropped
    // the colliding row and verify_count_mismatch fired. Both
    // outcomes are integrity failures.
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect(summary.deleted).toBe(0);

    // Hot row count unchanged (sweep + 1 archival_sweep_completed
    // self-emit + 1 archival_integrity_failed).
    expect(eventsCount(db, "directive_opened")).toBe(hotBefore);
    expect(eventsByKind(db, "archival_integrity_failed").length).toBeGreaterThanOrEqual(1);
  });
});

describe("substrate/cold_db.ts — list + open + union", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;
  const NOW = Date.parse("2026-05-15T12:00:00.000Z");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-cold-"));
    dbPath = join(tmpDir, "state.db");
    db = openDb(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("listArchives returns sorted paths", async () => {
    // Seed events across three months and archive them.
    for (const [yyyymm, base] of [
      ["2026-01", "2026-01-05T00:00:00.000Z"],
      ["2026-02", "2026-02-10T00:00:00.000Z"],
      ["2026-03", "2026-03-12T00:00:00.000Z"],
    ] as Array<[string, string]>) {
      for (let i = 0; i < 3; i++) {
        const ts = new Date(Date.parse(base) + i * 1000).toISOString();
        seedEventAtTs(db, ts, base.charCodeAt(0) + i);
      }
      // suppress unused yyyymm lint
      void yyyymm;
    }
    await runArchivalSweep(db, { stateDbPath: dbPath, nowMs: NOW, retentionDays: 30 });

    const arches = listArchives(dbPath);
    expect(arches.length).toBe(3);
    expect(arches[0].endsWith("state-archive-2026-01.db")).toBe(true);
    expect(arches[2].endsWith("state-archive-2026-03.db")).toBe(true);

    // _listArchivesForDir helper agrees.
    expect(_listArchivesForDir(dbPath)).toEqual(arches);
  });

  test("openColdDb is readonly — INSERT throws", async () => {
    seedEventAtTs(db, "2026-02-10T00:00:00.000Z", 1);
    await runArchivalSweep(db, { stateDbPath: dbPath, nowMs: NOW, retentionDays: 30 });

    const arches = listArchives(dbPath);
    expect(arches.length).toBe(1);
    const cold = openColdDb(arches[0]);
    try {
      expect(() => {
        cold.run(
          "INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload) VALUES ('x','y','d','t','l','substrate_auto','directive_opened','{}')",
        );
      }).toThrow();
    } finally {
      cold.close();
    }
  });

  test("searchAcrossArchives unions hot + cold rows", async () => {
    // 2 cold events in 2026-02.
    for (let i = 0; i < 2; i++) {
      const ts = new Date(Date.parse("2026-02-10T00:00:00.000Z") + i * 1000).toISOString();
      seedEventAtTs(db, ts, 10 + i);
    }
    // 3 hot events within retention.
    for (let i = 0; i < 3; i++) {
      const ts = new Date(NOW - 1 * 24 * 60 * 60 * 1000 + i * 1000).toISOString();
      seedEventAtTs(db, ts, 20 + i);
    }
    await runArchivalSweep(db, { stateDbPath: dbPath, nowMs: NOW, retentionDays: 30 });

    // Hot has 3 directive_opened rows + the sweep summary event.
    const onlyDirective = "SELECT id FROM events WHERE kind = 'directive_opened'";
    const unioned = await searchAcrossArchives<{ id: string }>(db, dbPath, onlyDirective, []);
    // 3 hot + 2 cold = 5.
    expect(unioned.length).toBe(5);

    const ids = unioned.map((r) => r.id);
    // All distinct (verify-then-delete makes cross-source duplicates
    // structurally impossible).
    expect(new Set(ids).size).toBe(5);
  });

  test("searchAcrossArchives respects includeCold=false", async () => {
    for (let i = 0; i < 2; i++) {
      const ts = new Date(Date.parse("2026-02-10T00:00:00.000Z") + i * 1000).toISOString();
      seedEventAtTs(db, ts, 30 + i);
    }
    for (let i = 0; i < 3; i++) {
      const ts = new Date(NOW - 1 * 24 * 60 * 60 * 1000 + i * 1000).toISOString();
      seedEventAtTs(db, ts, 40 + i);
    }
    await runArchivalSweep(db, { stateDbPath: dbPath, nowMs: NOW, retentionDays: 30 });

    const hotOnly = await searchAcrossArchives<{ id: string }>(
      db,
      dbPath,
      "SELECT id FROM events WHERE kind = 'directive_opened'",
      [],
      { includeCold: false },
    );
    expect(hotOnly.length).toBe(3);
  });
});

describe("runTelemetryEvictionSweep — event-class tiering", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;
  const NOW = Date.parse("2026-05-23T12:00:00.000Z");

  // Emit an event of any kind, then rewrite its ts so we can synthesize
  // "old" / "recent" rows deterministically (mock test mode permits
  // unregistered kinds like the defunct recipe_promotion_deferred).
  const seedKindAtTs = (kind: string, tsIso: string, idx: number): string => {
    // Mock test mode permits unregistered/defunct kind strings (e.g.
    // recipe_promotion_deferred); cast to satisfy the EventKind union type
    // the same way other emit-arbitrary-kind tests do.
    const ev = emitEvent(db, { kind: kind as Parameters<typeof emitEvent>[1]["kind"], payload: { idx } });
    db.run("UPDATE events SET ts = ? WHERE id = ?", [tsIso, ev.id]);
    return ev.id;
  };
  const hoursAgo = (h: number): string => new Date(NOW - h * 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-evict-"));
    dbPath = join(tmpDir, "state.db");
    db = openDb(dbPath);
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("evicts an old ephemeral-telemetry row, keeps a recent one and a non-telemetry row", async () => {
    // Old ephemeral telemetry (3h ago, past the 1h TTL) — should be evicted.
    seedKindAtTs("recipe_promotion_deferred", hoursAgo(3), 1);
    seedKindAtTs("artifact_kind_inference_uncertain", hoursAgo(3), 2);
    // Recent ephemeral telemetry (10min ago, inside TTL) — must NOT be evicted.
    seedKindAtTs("artifact_kind_inference_uncertain", hoursAgo(1 / 6), 3);
    // Non-telemetry durable row, also old — must NEVER be evicted.
    seedKindAtTs("knowledge_promoted", hoursAgo(3), 4);

    const summary = await runTelemetryEvictionSweep(db, { retentionHours: 1, nowMs: NOW });

    expect(summary.evicted).toBe(2);
    expect(summary.by_kind.recipe_promotion_deferred).toBe(1);
    expect(summary.by_kind.artifact_kind_inference_uncertain).toBe(1);

    // Old telemetry gone; recent telemetry + durable knowledge survive.
    expect(eventsCount(db, "recipe_promotion_deferred")).toBe(0);
    expect(eventsCount(db, "artifact_kind_inference_uncertain")).toBe(1); // the recent one
    expect(eventsCount(db, "knowledge_promoted")).toBe(1);

    // One telemetry_evicted audit event emitted.
    expect(eventsCount(db, "telemetry_evicted")).toBe(1);
  });

  test("health counter is preserved: live rows + retained evicted count == lifetime total", async () => {
    // Lifetime total of artifact_kind_inference_uncertain = 5 (3 old, 2 recent).
    for (let i = 0; i < 3; i++) seedKindAtTs("artifact_kind_inference_uncertain", hoursAgo(5), i);
    for (let i = 0; i < 2; i++)
      seedKindAtTs("artifact_kind_inference_uncertain", hoursAgo(1 / 6), 10 + i);

    await runTelemetryEvictionSweep(db, { retentionHours: 1, nowMs: NOW });

    const live = eventsCount(db, "artifact_kind_inference_uncertain");
    const retained = retainedEvictedCount(db, "artifact_kind_inference_uncertain");
    expect(live).toBe(2); // recent rows kept
    expect(retained).toBe(3); // old rows preserved as a counter
    // The health-counter consumer (admin_substrate_status) reads live + retained.
    expect(live + retained).toBe(5);
  });

  test("retained count is cumulative across sweeps and 0 for non-evicted kinds", async () => {
    seedKindAtTs("recipe_promotion_deferred", hoursAgo(3), 1);
    await runTelemetryEvictionSweep(db, { retentionHours: 1, nowMs: NOW });
    seedKindAtTs("recipe_promotion_deferred", hoursAgo(3), 2);
    await runTelemetryEvictionSweep(db, { retentionHours: 1, nowMs: NOW });
    expect(retainedEvictedCount(db, "recipe_promotion_deferred")).toBe(2);
    // A kind never evicted has no retained counter.
    expect(retainedEvictedCount(db, "knowledge_promoted")).toBe(0);
  });

  test("telemetry eviction writes summary before delete and keeps causal-spine/substrate-memory hot", async () => {
    const oldTs = hoursAgo(3);
    seedKindAtTs("artifact_kind_inference_uncertain", oldTs, 1);
    seedKindAtTs("task_committed", oldTs, 2);
    seedKindAtTs("knowledge_promoted", oldTs, 3);
    seedKindAtTs("act_artifact_admitted", oldTs, 4);

    const summary = await runTelemetryEvictionSweep(db, { retentionHours: 1, nowMs: NOW });

    expect(summary.evicted).toBe(1);
    expect(eventsCount(db, "artifact_kind_inference_uncertain")).toBe(0);
    expect(eventsCount(db, "task_committed")).toBe(1);
    expect(eventsCount(db, "knowledge_promoted")).toBe(1);
    expect(eventsCount(db, "act_artifact_admitted")).toBe(1);
    const archiveSummary = db
      .query<{ count: number; kind: string; reason: string }, []>(
        "SELECT count, kind, reason FROM event_archive_summary WHERE kind = 'artifact_kind_inference_uncertain' LIMIT 1",
      )
      .get();
    expect(archiveSummary).toEqual({ count: 1, kind: "artifact_kind_inference_uncertain", reason: "telemetry_eviction" });
    const rollup = db
      .query<{ live_count: number; total_count: number }, []>(
        "SELECT live_count, total_count FROM event_kind_rollup WHERE kind = 'artifact_kind_inference_uncertain'",
      )
      .get();
    expect(rollup).toEqual({ live_count: 0, total_count: 1 });
  });

  test("curationModeForKind classifies ephemeral telemetry as 'evict', durable kinds as not-evict", () => {
    expect(curationModeForKind("recipe_promotion_deferred")).toBe("evict");
    expect(curationModeForKind("artifact_kind_inference_uncertain")).toBe("evict");
    expect(curationModeForKind("brain_reasoning_recorded")).toBe("evict");
    expect(curationModeForKind("origin_calibration_recorded")).toBe("evict");
    expect(curationModeForKind("knowledge_promoted")).not.toBe("evict");
    expect(curationModeForKind("act_artifact_promoted")).not.toBe("evict");
    expect(curationModeForKind("retrieval_binding")).not.toBe("evict");
  });

  test("origin calibration eviction retains count, sums, and histogram buckets", async () => {
    const old = hoursAgo(4);
    const ev1 = emitEvent(db, {
      kind: "origin_calibration_recorded",
      payload: { origin: "brain", role: "cited_knowledge", predicted_confidence: 0.84, observed_success_probability: 1, calibration_error: 0.16 },
    });
    const ev2 = emitEvent(db, {
      kind: "origin_calibration_recorded",
      payload: { origin: "brain", role: "cited_knowledge", predicted_confidence: 0.81, observed_success_probability: 1, calibration_error: 0.19 },
    });
    db.run("UPDATE events SET ts = ? WHERE id IN (?, ?)", [old, ev1.id, ev2.id]);

    const summary = await runTelemetryEvictionSweep(db, { retentionHours: 1, nowMs: NOW });

    expect(summary.by_kind.origin_calibration_recorded).toBe(2);
    expect(retainedEvictedCount(db, "origin_calibration_recorded")).toBe(2);
    expect(eventsCount(db, "origin_calibration_recorded")).toBe(0);
    const rollup = db
      .query<{ count: number; predicted_confidence_sum: number; observed_success_probability_sum: number; calibration_error_sum: number; predicted_bucket: string; observed_bucket: string; error_bucket: string }, []>(
        "SELECT count, predicted_confidence_sum, observed_success_probability_sum, calibration_error_sum, predicted_bucket, observed_bucket, error_bucket FROM telemetry_origin_calibration_rollup WHERE origin='brain' AND role='cited_knowledge'",
      )
      .get();
    expect(rollup).toEqual({
      count: 2,
      predicted_confidence_sum: 1.65,
      observed_success_probability_sum: 2,
      calibration_error_sum: 0.35,
      predicted_bucket: "0.8-0.9",
      observed_bucket: "1.0",
      error_bucket: "0.1-0.2",
    });
  });

  test("empty sweep is a no-op and emits no telemetry_evicted", async () => {
    seedKindAtTs("artifact_kind_inference_uncertain", hoursAgo(1 / 6), 1); // recent only
    const summary = await runTelemetryEvictionSweep(db, { retentionHours: 1, nowMs: NOW });
    expect(summary.evicted).toBe(0);
    expect(eventsCount(db, "telemetry_evicted")).toBe(0);
    expect(eventsCount(db, "artifact_kind_inference_uncertain")).toBe(1);
  });
});

describe("runArchivalSweep — heavy READ scan routes through SQL worker pool", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;
  const NOW = Date.parse("2026-05-15T12:00:00.000Z");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-archival-pool-"));
    dbPath = join(tmpDir, "state.db");
    db = openDb(dbPath);
  });

  afterEach(() => {
    clearSqlPool();
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("candidate scan goes through the pool when one is installed (sync fallback when absent)", async () => {
    // Seed two old months so the candidate scan returns rows.
    for (let i = 0; i < 10; i++) {
      seedEventAtTs(db, new Date(Date.parse("2026-02-10T00:00:00.000Z") + i * 1000).toISOString(), 100 + i);
    }

    // Fake pool: same idiom as embedder.readUnembedded — delegates to the same
    // db synchronously (correct: identical rows/order) and records each call
    // so the test proves the scan was off-loaded, not run on the main thread.
    const calls: string[] = [];
    const fakePool = {
      query: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
        calls.push(sql);
        return db.query(sql).all(...(params as never[])) as T[];
      },
    };
    setSqlPool(fakePool as unknown as Parameters<typeof setSqlPool>[0]);

    const summary = await runArchivalSweep(db, { stateDbPath: dbPath, nowMs: NOW, retentionDays: 30 });
    expect(summary.scanned).toBe(10);
    expect(summary.deleted).toBe(10);
    // The heavy candidate scan was routed through the pool.
    expect(calls.some((s) => s.includes("FROM events") && s.includes("ORDER BY ts ASC"))).toBe(true);
  });

  test("sync fallback when no pool — identical result", async () => {
    clearSqlPool();
    for (let i = 0; i < 10; i++) {
      seedEventAtTs(db, new Date(Date.parse("2026-02-10T00:00:00.000Z") + i * 1000).toISOString(), 200 + i);
    }
    const summary = await runArchivalSweep(db, { stateDbPath: dbPath, nowMs: NOW, retentionDays: 30 });
    expect(summary.scanned).toBe(10);
    expect(summary.deleted).toBe(10);
  });
});

// ── Pressure-triggered bounded-ledger curation (amendment
// CS4WFHZM7H4TN425GRSW39ZVMG) ─────────────────────────────────────────
describe("evaluateLedgerCurationPressure — pressure-triggered retention", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;
  const NOW = Date.parse("2026-05-26T12:00:00.000Z");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-pressure-"));
    dbPath = join(tmpDir, "state.db");
    db = openDb(dbPath);
    clearSqlPool();
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("no pressure → short default window; row-count above hard cap → floor", () => {
    // Amendment J9SJZDKA retuned the no-pressure default window to 7 days
    // (was 30) so the hot ledger stays continuously bounded under sustained
    // ~36k/day production. Tiny caps below keep pressure at 0 so we observe
    // the unpressured default.
    const low = evaluateLedgerCurationPressure(
      db,
      { stateDbPath: dbPath, rowCountSoftCap: 1_000_000, rowCountHardCap: 2_000_000, dbSizeSoftCapBytes: 1e12, dbSizeHardCapBytes: 2e12, minRetentionDays: 2 },
      NOW,
    );
    expect(low.pressure).toBe(0);
    expect(low.hot_retention_days).toBe(7);
    expect(low.pressure_source).toBe("none");

    // Seed a few rows so the real row count exceeds the tiny hard cap, then
    // assert the policy compresses to the floor under max pressure.
    for (let i = 0; i < 5; i++) seedEventAtTs(db, new Date(NOW - 1000 * i).toISOString(), i);
    const high = evaluateLedgerCurationPressure(
      db,
      { stateDbPath: dbPath, rowCountSoftCap: 0, rowCountHardCap: 1, dbSizeSoftCapBytes: 1e12, dbSizeHardCapBytes: 2e12, minRetentionDays: 2 },
      NOW,
    );
    expect(high.pressure).toBe(1);
    expect(high.pressure_source).toBe("row_count");
    expect(high.hot_retention_days).toBe(2);
  });

  test("PROOF: archival fires on rows YOUNGER than the default window when row-count pressure is high", async () => {
    // Seed 40 events all dated 3 days ago — within the retuned 7-day default
    // window (amendment J9SJZDKA), so age-only archival would archive NONE.
    for (let i = 0; i < 40; i++) {
      const ts = new Date(NOW - 3 * 24 * 60 * 60 * 1000 + i * 1000).toISOString();
      seedEventAtTs(db, ts, i);
    }

    // Baseline: default policy (no pressure caps crossed) archives nothing —
    // these rows are only 3 days old (inside the 7-day default window).
    const baseline = await runArchivalSweep(db, {
      stateDbPath: dbPath,
      nowMs: NOW,
      rowCountSoftCap: 1_000_000,
      rowCountHardCap: 2_000_000,
      dbSizeSoftCapBytes: 1e12,
      dbSizeHardCapBytes: 2e12,
    });
    expect(baseline.retention_days).toBe(7);
    expect(baseline.deleted).toBe(0);

    // Under HIGH row-count pressure (tiny caps), the window compresses to the
    // 2-day floor → the 5-day-old rows now fall PAST the cutoff and archive.
    const pressured = await runArchivalSweep(db, {
      stateDbPath: dbPath,
      nowMs: NOW,
      rowCountSoftCap: 0,
      rowCountHardCap: 1,
      dbSizeSoftCapBytes: 1e12,
      dbSizeHardCapBytes: 2e12,
      minRetentionDays: 2,
    });
    expect(pressured.pressure).toBe(1);
    expect(pressured.retention_days).toBe(2);
    expect(pressured.deleted).toBeGreaterThan(0);
    expect(pressured.archived_by_month["2026-05"]).toBeGreaterThan(0);
  });

  test("SAFETY: candidate_confirmed and origin_calibration_recorded are NEVER lost under max pressure", async () => {
    // Seed credit-spine + calibration rows 5 days ago (young, but pressure
    // compresses the window to 2 days — so a naive policy could touch them).
    const fiveDaysAgo = new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString();
    const ccIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const ev = emitEvent(db, { kind: "candidate_confirmed" as Parameters<typeof emitEvent>[1]["kind"], payload: { idx: i } });
      db.run("UPDATE events SET ts = ? WHERE id = ?", [fiveDaysAgo, ev.id]);
      ccIds.push(ev.id);
    }
    for (let i = 0; i < 3; i++) {
      const ev = emitEvent(db, {
        kind: "origin_calibration_recorded" as Parameters<typeof emitEvent>[1]["kind"],
        payload: { origin: "brain", role: "designer", predicted_confidence: 0.7, observed_success_probability: 0.6, calibration_error: 0.1 },
      });
      db.run("UPDATE events SET ts = ? WHERE id = ?", [fiveDaysAgo, ev.id]);
    }
    // Plus ordinary archivable rows so the sweep actually runs.
    for (let i = 0; i < 10; i++) {
      seedEventAtTs(db, new Date(NOW - 5 * 24 * 60 * 60 * 1000 + i * 1000).toISOString(), 500 + i);
    }

    const ccBefore = eventsCount(db, "candidate_confirmed");
    const ocBefore = eventsCount(db, "origin_calibration_recorded");
    expect(ccBefore).toBe(5);
    expect(ocBefore).toBe(3);

    // Maximum pressure → 2-day window → 5-day-old rows are past the cutoff.
    await runArchivalSweep(db, {
      stateDbPath: dbPath,
      nowMs: NOW,
      rowCountSoftCap: 0,
      rowCountHardCap: 1,
      dbSizeSoftCapBytes: 1e12,
      dbSizeHardCapBytes: 2e12,
      minRetentionDays: 2,
    });

    // candidate_confirmed is ALWAYS_KEEP — never archived/deleted by the
    // pressure-compressed sweep (it is excluded from the candidate scan).
    expect(eventsCount(db, "candidate_confirmed")).toBe(5);
    // origin_calibration_recorded is excluded from the archival move-to-cold
    // (it is rolled up + evicted on the telemetry path, not the archival
    // path) — the archival sweep must leave every row in place.
    expect(eventsCount(db, "origin_calibration_recorded")).toBe(3);
  });
});

describe("bounded hot ledger under sustained load (amendment J9SJZDKA, guarantee B)", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;
  const NOW = Date.parse("2026-05-26T12:00:00.000Z");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-bounded-hot-"));
    dbPath = join(tmpDir, "state.db");
    db = openDb(dbPath);
    clearSqlPool();
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("repeated pressure-aware sweeps keep the hot row count bounded as production continues", async () => {
    // Simulate sustained production: a backlog of archivable rows spread
    // across the last several days, far exceeding a small soft/hard cap.
    // With age-only 30-day retention NONE of these (all < 30d old) would
    // ever archive — the hot table would grow without bound. The retuned
    // pressure-aware policy compresses the retention window to the floor
    // once the row count crosses the cap, so move-to-cold fires on these
    // recent rows and the hot ledger stays bounded.
    const TOTAL = 300;
    for (let i = 0; i < TOTAL; i++) {
      // Spread ages 2..6 days old (all inside the 7-day default window, so
      // ONLY pressure can trigger archival of them).
      const ageDays = 2 + (i % 5);
      const ts = new Date(NOW - ageDays * 24 * 60 * 60 * 1000 + i * 1000).toISOString();
      seedEventAtTs(db, ts, i);
    }

    const HOT_CAP = 100; // small explicit caps so the test is deterministic + fast
    const hotCount = (): number =>
      (db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events WHERE kind = 'directive_opened'").get()!).c;

    expect(hotCount()).toBe(TOTAL); // unbounded before any sweep

    // Run several pressure-aware sweeps (each row-capped). Under high
    // row-count pressure (count >> hard cap) the window compresses to the
    // 1-day floor, so the 2..6-day-old rows fall past the cutoff and move
    // to cold. minRetentionDays: 1 lets the floor archive 2-day-old rows.
    let lastPressure = 0;
    for (let sweep = 0; sweep < 6; sweep++) {
      const summary = await runArchivalSweep(db, {
        stateDbPath: dbPath,
        nowMs: NOW,
        rowCountSoftCap: HOT_CAP,
        rowCountHardCap: HOT_CAP * 2,
        dbSizeSoftCapBytes: 1e12,
        dbSizeHardCapBytes: 2e12,
        minRetentionDays: 1,
        sweepLimit: 1000,
      });
      lastPressure = summary.pressure ?? 0;
      if (hotCount() <= HOT_CAP) break;
    }

    // BOUNDED: after pressure-aware curation the hot ledger sits at/below the
    // cap — the move-to-cold sweep shrank it on YOUNGER-than-default rows
    // driven by row-count pressure, NOT by a fixed 30-day age.
    expect(hotCount()).toBeLessThanOrEqual(HOT_CAP);
    // And the archived rows are recoverable from the cold sibling (guarantee
    // A) — they were moved, not lost.
    const archives = listArchives(dbPath);
    expect(archives.length).toBeGreaterThan(0);
  });
});
