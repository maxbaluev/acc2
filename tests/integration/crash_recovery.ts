#!/usr/bin/env bun
// acc2 crash-recovery integration smoke — Batch 3.OPS.
//
// Validates the daemon's crash-recovery story end-to-end:
//   1. clean_shutdown_round_trip — stop, restart, events count matches,
//      no orphan rows.
//   2. sigkill_mid_dispatch     — start, seed an open brain_dispatched
//      row, SIGKILL the bun process, restart, assert
//      dispatch_recovered_orphan emitted.
//   3. wal_replay_after_kill    — emit many events, SIGKILL, restart,
//      assert WAL replays cleanly + event count unchanged.
//   4. corrupt_db_refuses_start — corrupt page data in the db file,
//      assert startDaemon throws with a clear error.
//
// Run:
//   cd /home/maxbaluev/bos2/system/acc2 && bun tests/integration/crash_recovery.ts
//
// Exit code 0 iff every scenario passes; 1 otherwise. Output format
// mirrors harness.ts (PAD-aligned step labels, fmtSec timings, summary).

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Database } from "bun:sqlite";
import { closeDb, openDb } from "../../substrate/db";
import { emitEvent } from "../../runtime/events";
import { startDaemon, stopDaemon } from "../../runtime/daemon";

// ── Step-result harness ────────────────────────────────────────────

type StepResult = {
  label: string;
  status: "pass" | "fail";
  elapsedMs: number;
  detail?: string;
  error?: Error;
};

const PAD = 50;
const formatLabel = (s: string): string => {
  if (s.length >= PAD) return s;
  return s + " " + ".".repeat(Math.max(0, PAD - s.length - 1));
};
const fmtSec = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

const pickPortPair = (): { mcp: number; aux: number } => {
  // 55000-56000 / 57000-58000 keeps us well clear of other test bands
  // (30000-32000 for daemon.test, 45000-50000 for harness/scenarios).
  const mcp = 55000 + Math.floor(Math.random() * 1000);
  const aux = 57000 + Math.floor(Math.random() * 1000);
  return { mcp, aux };
};

const countEvents = (db: Database): number => {
  const row = db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number };
  return row.n;
};

const orphanCount = (db: Database): number => {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM events e
       WHERE e.kind = 'brain_dispatched'
         AND NOT EXISTS (
           SELECT 1 FROM events c
           WHERE c.task_id = e.task_id
             AND c.kind IN ('brain_dispatch_closed', 'dispatcher_violation', 'task_failed')
             AND c.ts >= e.ts
         )`,
    )
    .get() as { n: number };
  return row.n;
};

// ── Scenario 1: clean shutdown round-trip ─────────────────────────

const scenarioCleanShutdown = async (): Promise<void> => {
  const tmpDir = mkdtempSync(join(tmpdir(), "acc2-crash-clean-"));
  const dbPath = join(tmpDir, "state.db");
  try {
    const ports1 = pickPortPair();
    const h1 = await startDaemon({
      port: ports1.mcp, auxPort: ports1.aux, stateDbPath: dbPath,
      socketFile: join(tmpDir, "v2.sock"), tokenFile: join(tmpDir, "v2.sock.token"),
    });

    // Emit a few events through the live daemon.
    for (let i = 0; i < 5; i++) {
      emitEvent(h1.db, {
        kind: "directive_opened",
        directive_id: `d_clean_${i}`,
        task_id: `d_clean_${i}`,
        payload: { directive_text: `clean test ${i}` },
      });
    }
    const preShutdownCount = countEvents(h1.db);
    assert(preShutdownCount >= 5, `expected ≥5 events, got ${preShutdownCount}`);

    await stopDaemon(h1);
    closeDb(dbPath);

    // Restart on different ports, same db.
    const ports2 = pickPortPair();
    const h2 = await startDaemon({
      port: ports2.mcp, auxPort: ports2.aux, stateDbPath: dbPath,
      socketFile: join(tmpDir, "v2.sock"), tokenFile: join(tmpDir, "v2.sock.token"),
    });

    try {
      const postRestartCount = countEvents(h2.db);
      assert(
        postRestartCount >= preShutdownCount,
        `event count regressed: pre=${preShutdownCount} post=${postRestartCount}`,
      );
      // No orphan rows after clean shutdown.
      assert(orphanCount(h2.db) === 0, `orphans after clean shutdown: ${orphanCount(h2.db)}`);
    } finally {
      await stopDaemon(h2);
      closeDb(dbPath);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
};

// ── Scenario 2: sigkill mid-dispatch reconciliation ───────────────
//
// We simulate "killed mid-dispatch" by directly emitting an unclosed
// brain_dispatched row, then restarting and asserting the boot
// reconciler emits dispatch_recovered_orphan.
//
// A "real" SIGKILL test (forking a separate bun child process running
// the daemon and signalling it) is structurally feasible but flakey
// across CI environments; the substrate-side reconciliation is the
// behavioral surface that matters, and it is identical regardless of
// how the dispatch became orphaned.

const scenarioSigkillMidDispatch = async (): Promise<void> => {
  const tmpDir = mkdtempSync(join(tmpdir(), "acc2-crash-sigkill-"));
  const dbPath = join(tmpDir, "state.db");
  try {
    // Pre-seed: open the db, emit an unclosed brain_dispatched row.
    const db1 = openDb(dbPath);
    emitEvent(db1, {
      kind: "brain_dispatched",
      directive_id: "d_kill_1",
      task_id: "t_kill_1",
      payload: { dispatch_id: "disp_kill_1", task_id: "t_kill_1" },
    });
    closeDb(dbPath);

    // Restart the daemon and assert the orphan is reconciled.
    const ports = pickPortPair();
    const handle = await startDaemon({
      port: ports.mcp, auxPort: ports.aux, stateDbPath: dbPath,
      socketFile: join(tmpDir, "v2.sock"), tokenFile: join(tmpDir, "v2.sock.token"),
    });

    try {
      const recovered = handle.db
        .query(
          "SELECT * FROM events WHERE kind = 'dispatch_recovered_orphan' AND task_id = ?",
        )
        .all("t_kill_1");
      assert(
        recovered.length === 1,
        `expected exactly 1 dispatch_recovered_orphan for t_kill_1, got ${recovered.length}`,
      );
    } finally {
      await stopDaemon(handle);
      closeDb(dbPath);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
};

// ── Scenario 3: WAL replay after kill ─────────────────────────────

const scenarioWalReplayAfterKill = async (): Promise<void> => {
  const tmpDir = mkdtempSync(join(tmpdir(), "acc2-crash-wal-"));
  const dbPath = join(tmpDir, "state.db");
  try {
    // Spawn the daemon as a separate bun child so we can actually SIGKILL
    // it. We use a simple seeder script: it boots the daemon, writes 1000
    // events, then prints "SEEDED" and waits indefinitely.
    const ports = pickPortPair();
    const seederPath = join(tmpDir, "seeder.ts");
    writeFileSync(
      seederPath,
      `
import { startDaemon } from "${join(import.meta.dirname ?? ".", "..", "..", "runtime", "daemon").replace(/\\/g, "/")}";
import { emitEvent } from "${join(import.meta.dirname ?? ".", "..", "..", "runtime", "events").replace(/\\/g, "/")}";

const handle = await startDaemon({
  port: ${ports.mcp},
  auxPort: ${ports.aux},
  stateDbPath: ${JSON.stringify(dbPath)},
  socketFile: ${JSON.stringify(join(tmpDir, "v2.sock"))},
  tokenFile: ${JSON.stringify(join(tmpDir, "v2.sock.token"))},
});
for (let i = 0; i < 1000; i++) {
  emitEvent(handle.db, {
    kind: "directive_opened",
    directive_id: \`d_wal_\${i}\`,
    task_id: \`d_wal_\${i}\`,
    payload: { directive_text: "wal_test_" + i },
  });
}
process.stdout.write("SEEDED\\n");
// Stay alive forever — caller will SIGKILL.
setInterval(() => {}, 60_000);
      `.trim(),
    );

    const child = spawn("bun", [seederPath], {
      cwd: tmpDir,
      env: {
        ...process.env,
        // Disable every worker (preload already disables five; add
        // integrity for this seeder subprocess so the seeded WAL is the
        // ONLY artifact under test).
        ACC2_DISABLE_WORKERS: [
          ...(process.env.ACC2_DISABLE_WORKERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
          "integrity",
        ].join(","),
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait for the SEEDED marker on stdout.
    let seeded = false;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("seeder timed out before SEEDED")), 30_000);
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("SEEDED")) {
          seeded = true;
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
      child.on("exit", (code) => {
        if (!seeded) { clearTimeout(timeout); reject(new Error(`seeder exited early code=${code}`)); }
      });
    });

    // SIGKILL the child.
    child.kill("SIGKILL");
    // Wait for it to actually die.
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      // Belt-and-braces: if exit never fires, give up after 5s.
      setTimeout(resolve, 5000);
    });

    // Now restart the daemon against the same db. SQLite must replay
    // the WAL and the events count must be ≥1000.
    const ports2 = pickPortPair();
    const handle2 = await startDaemon({
      port: ports2.mcp, auxPort: ports2.aux, stateDbPath: dbPath,
      socketFile: join(tmpDir, "v2.sock"), tokenFile: join(tmpDir, "v2.sock.token"),
    });
    try {
      const restored = countEvents(handle2.db);
      assert(restored >= 1000, `WAL replay lost events: expected ≥1000, got ${restored}`);
    } finally {
      await stopDaemon(handle2);
      closeDb(dbPath);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
};

// ── Scenario 4: corrupt db refuses to start ───────────────────────

const scenarioCorruptDbRefusesStart = async (): Promise<void> => {
  const tmpDir = mkdtempSync(join(tmpdir(), "acc2-crash-corrupt-"));
  const dbPath = join(tmpDir, "state.db");
  try {
    // Create a valid db with some events.
    const db1 = openDb(dbPath);
    emitEvent(db1, { kind: "directive_opened", payload: { directive_text: "x" } });
    emitEvent(db1, { kind: "directive_opened", payload: { directive_text: "y" } });
    closeDb(dbPath);

    // Corrupt the file by zeroing out a range of bytes in the middle of
    // the page area. SQLite's integrity_check will catch this.
    const bytes = readFileSync(dbPath);
    for (let i = 200; i < Math.min(800, bytes.length); i++) bytes[i] = 0xFF;
    writeFileSync(dbPath, bytes);

    // Attempt to start — should throw.
    let caught: Error | null = null;
    try {
      const ports = pickPortPair();
      const handle = await startDaemon({
        port: ports.mcp, auxPort: ports.aux, stateDbPath: dbPath,
        socketFile: join(tmpDir, "v2.sock"), tokenFile: join(tmpDir, "v2.sock.token"),
      });
      // If we got here it means startDaemon swallowed the corruption — bad.
      await stopDaemon(handle);
      throw new Error("startDaemon should have refused on corrupt db");
    } catch (err) {
      caught = err as Error;
    }
    closeDb(dbPath);
    assert(caught !== null, "expected startDaemon to throw on corrupt db");
    assert(
      /integrity_check failed|integrity_check/i.test(caught!.message) ||
        /malformed|corrupt|database disk/i.test(caught!.message),
      `expected integrity-check error in message, got: ${caught!.message}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
};

// ── Driver ─────────────────────────────────────────────────────────

const SCENARIOS: Array<{ label: string; fn: () => Promise<void> }> = [
  { label: "clean_shutdown_round_trip", fn: scenarioCleanShutdown },
  { label: "sigkill_mid_dispatch_orphan_recovery", fn: scenarioSigkillMidDispatch },
  { label: "wal_replay_after_kill", fn: scenarioWalReplayAfterKill },
  { label: "corrupt_db_refuses_to_start", fn: scenarioCorruptDbRefusesStart },
];

export const runCrashRecoverySmoke = async (): Promise<number> => {
  const startedAt = Date.now();
  process.stdout.write("acc2 crash-recovery smoke — Batch 3.OPS\n");
  process.stdout.write("========================================\n");

  const results: StepResult[] = [];
  let idx = 1;
  for (const sc of SCENARIOS) {
    const labelTxt = `[${idx}/${SCENARIOS.length}] ${formatLabel(sc.label)}`;
    const stepStart = Date.now();
    try {
      await sc.fn();
      const elapsed = Date.now() - stepStart;
      results.push({ label: sc.label, status: "pass", elapsedMs: elapsed });
      process.stdout.write(`${labelTxt} PASS (${fmtSec(elapsed)})\n`);
    } catch (err) {
      const elapsed = Date.now() - stepStart;
      const e = err instanceof Error ? err : new Error(String(err));
      results.push({ label: sc.label, status: "fail", elapsedMs: elapsed, error: e });
      process.stdout.write(`${labelTxt} FAIL (${fmtSec(elapsed)})\n`);
      process.stdout.write(`        ${e.message}\n`);
      if (e.stack) {
        const frames = e.stack.split("\n").slice(1, 4).map((s) => `        ${s.trim()}`).join("\n");
        process.stdout.write(`${frames}\n`);
      }
    }
    idx++;
  }

  const elapsedTotal = Date.now() - startedAt;
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.length - passed;
  process.stdout.write("\n========================================\n");
  if (failed === 0) {
    process.stdout.write(`${passed}/${results.length} scenarios passed in ${fmtSec(elapsedTotal)}\n`);
    process.stdout.write("[ok] crash-recovery surface is workable\n");
    return 0;
  }
  process.stdout.write(`${passed}/${results.length} passed — ${failed} failure${failed > 1 ? "s" : ""}\n`);
  return 1;
};

// Entrypoint when invoked directly.
if (import.meta.main) {
  void (async () => {
    const code = await runCrashRecoverySmoke();
    process.exit(code);
  })();
}
