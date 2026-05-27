// runBudgetedSweep budget + atomic boot-intent-lock suites (split out of daemon.test.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { startDaemon, stopDaemon, isDaemonAlreadyRunningError, getBootIntegrityState, runBudgetedSweep, type DaemonHandle, type BudgetedStep } from "./daemon";
import { handleGetEvent, handleRead } from "./mcp_server/substrate_tools";
import { recordReadAttemptStart, recordReadSuccess, READ_PATH_LATENCY_MS } from "./readiness";
import { handleRecentEvents } from "./mcp_server/runtime_tools";
import { isSchedulerDraining } from "./task_scheduler";
import { getSqlPool, clearSqlPool } from "./sql_pool_singleton";
import { getFreePortPair, startDaemonOnFreePorts } from "../tests/free_port";
import { mkTmp, bootHandle, cleanup, pickPortPair, parsePayload, type Tmp } from "./daemon_test_helpers";
// ── DAEMON STABILITY HARDENING (fix #3): extractor-sweep wall-clock budget ──
//
// runBudgetedSweep bounds the whole extractor sweep so a slow tick on a
// 424k-row ledger can never run >10min. We test the budget semantics with an
// injected clock so there is no real wall-clock dependence and no daemon boot.
describe("runBudgetedSweep — per-tick wall-clock budget (fix #3)", () => {
  // A fake clock the test advances by side-effect inside each step.
  const makeClock = (start = 0) => {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  };

  test("the first step always runs even past the budget; subsequent steps are deferred once the budget is exceeded", async () => {
    const clock = makeClock();
    const ran: string[] = [];
    const steps: BudgetedStep[] = [
      // First step pushes elapsed past the 100ms budget — but it MUST still run.
      { name: "a", run: async () => { ran.push("a"); clock.advance(500); } },
      { name: "b", run: async () => { ran.push("b"); } },
      { name: "c", run: async () => { ran.push("c"); } },
    ];
    const res = await runBudgetedSweep(steps, { budgetMs: 100, now: clock.now });
    expect(ran).toEqual(["a"]);            // only the first ran
    expect(res.ran).toEqual(["a"]);
    expect(res.cutBeforeStep).toBe("b");   // budget cut before step b
  });

  test("a clean (under-budget) sweep runs every step and reports no cut", async () => {
    const clock = makeClock();
    const ran: string[] = [];
    const steps: BudgetedStep[] = [
      { name: "a", run: async () => { ran.push("a"); clock.advance(1); } },
      { name: "b", run: async () => { ran.push("b"); clock.advance(1); } },
      { name: "c", run: async () => { ran.push("c"); clock.advance(1); } },
    ];
    const res = await runBudgetedSweep(steps, { budgetMs: 10_000, now: clock.now });
    expect(ran).toEqual(["a", "b", "c"]);
    expect(res.cutBeforeStep).toBeNull();
    expect(res.ran).toEqual(["a", "b", "c"]);
  });

  test("a throwing step is caught (onError) and does NOT abort the sweep — only the budget defers steps", async () => {
    const clock = makeClock();
    const ran: string[] = [];
    const errors: string[] = [];
    const steps: BudgetedStep[] = [
      { name: "a", run: async () => { ran.push("a"); } },
      { name: "boom", run: async () => { throw new Error("kaboom"); } },
      { name: "c", run: async () => { ran.push("c"); } },
    ];
    const res = await runBudgetedSweep(steps, {
      budgetMs: 10_000,
      now: clock.now,
      onError: (name) => errors.push(name),
    });
    expect(ran).toEqual(["a", "c"]);        // c still ran after boom threw
    expect(errors).toEqual(["boom"]);
    expect(res.cutBeforeStep).toBeNull();   // a thrown step is not a budget cut
    expect(res.ran).toEqual(["a", "c"]);    // boom is not counted as "ran"
  });
});

// ---------------------------------------------------------------------------
// Atomic boot-intent lock (duplicate-daemon race fix).
//
// Root cause: the lock file was only WRITTEN at the END of boot (after ports
// bound) but the second-instance guard ran at the START. During the ~150s
// boot window the file did not exist, so two concurrent `daemon start` calls
// BOTH saw "no lock" and BOTH proceeded to bind the MCP port — one won, the
// other lingered as a duplicate/zombie. The fix exclusive-creates the lock
// (`wx` / O_EXCL) at the very start of startup, so a 2nd concurrent start
// reads the live-pid lock and refuses IMMEDIATELY, before paying boot cost.
//
// These tests inject the lock path so they never touch the real
// ~/.accint/v2.sock or the live daemon (constraint: do not touch live state).
// ---------------------------------------------------------------------------
describe("atomic boot-intent lock", () => {
  let tmp = mkTmp();
  beforeEach(() => { tmp = mkTmp(); });
  afterEach(() => { closeDb(); rmSync(tmp.dir, { recursive: true, force: true }); });

  test("2nd start while a LIVE-pid lock exists refuses immediately, before any boot/bind", async () => {
    // Pre-write a lock naming a LIVE pid (this test process). The exclusive
    // create must hit EEXIST, read the live pid, and refuse.
    writeFileSync(
      tmp.socketFile,
      JSON.stringify({ pid: process.pid, started_at_ms: Date.now(), phase: "booting", role: "all" }),
      { mode: 0o600 },
    );
    const other = pickPortPair();
    const startedAt = Date.now();
    let caught: unknown = null;
    try {
      await startDaemon({
        port: other.mcp, auxPort: other.aux,
        stateDbPath: join(tmp.dir, "should-never-open.db"),
        socketFile: tmp.socketFile, tokenFile: tmp.tokenFile,
      });
    } catch (err) { caught = err; }
    const elapsedMs = Date.now() - startedAt;

    // Refused as a distinguishable already-running error.
    expect(isDaemonAlreadyRunningError(caught)).toBe(true);
    expect((caught as Error).message).toContain(String(process.pid));
    // Refusal is FAST — no 150s boot. (Generous ceiling to avoid flake; the
    // point is it returned without binding a port or opening the DB.)
    expect(elapsedMs).toBeLessThan(3_000);
    // No 2nd boot: the supplied DB was never created, the supplied MCP port
    // was never bound, and the incumbent's lock is untouched.
    expect(existsSync(join(tmp.dir, "should-never-open.db"))).toBe(false);
    let portBound = false;
    try {
      const sock = await Bun.connect({ hostname: "127.0.0.1", port: other.mcp, socket: { data() {}, open() {}, close() {}, error() {} } });
      sock.end(); portBound = true;
    } catch { portBound = false; }
    expect(portBound).toBe(false);
    const lock = JSON.parse(readFileSync(tmp.socketFile, "utf8")) as { pid: number };
    expect(lock.pid).toBe(process.pid);
  });

  test("mcp bind failure releases the boot-intent lock so retry can proceed", async () => {
    // DAEMON_BOOT_LOCK brain amendment: acquireBootLock writes the
    // phase:"booting" lock BEFORE the port binds. If the bind then fails,
    // the catch handler must remove the lock — otherwise the failed boot
    // leaves a stale lock that blocks the next start until the dead-pid
    // reaper fires. Occupy the MCP port, confirm start fails, and assert
    // the lock file is gone.
    const occupied = pickPortPair();
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: occupied.mcp,
      fetch: () => new Response("occupied"),
    });
    try {
      let caught: unknown = null;
      try {
        await startDaemon({
          port: occupied.mcp,
          auxPort: occupied.aux,
          stateDbPath: tmp.dbPath,
          socketFile: tmp.socketFile,
          tokenFile: tmp.tokenFile,
        });
      } catch (err) { caught = err; }
      expect(String((caught as Error | null)?.message ?? caught)).toContain("failed to bind MCP port");
      // The boot-intent lock acquireBootLock wrote must be released.
      expect(existsSync(tmp.socketFile)).toBe(false);
      // Resource-leak fix (2026-05-23): the SQL worker-thread pool is spawned
      // BEFORE the bind, so a bind failure must shut it down + clear the
      // process-global singleton — otherwise N worker_threads leak (one set
      // per retry under startDaemonOnFreePorts) and getSqlPool() returns a
      // pool pointing at a now-closed DB. Skip the assertion when the pool is
      // disabled (ACC2_DISABLE_SQL_POOL=1) — there is nothing to leak then.
      if (process.env.ACC2_DISABLE_SQL_POOL !== "1") {
        expect(getSqlPool()).toBeNull();
      }
    } finally {
      blocker.stop(true);
      // Defensive: ensure no leaked pool bleeds into sibling tests.
      clearSqlPool();
    }
  });

  test("a STALE (dead-pid) lock is reaped and start proceeds", async () => {
    // Pick a pid that is essentially certainly dead. process.kill(pid, 0)
    // throws ESRCH → pidAlive=false → acquireBootLock reaps + proceeds.
    const deadPid = 2_147_480_000;
    expect(() => process.kill(deadPid, 0)).toThrow(); // confirm it's dead
    writeFileSync(
      tmp.socketFile,
      JSON.stringify({ pid: deadPid, started_at_ms: 1, phase: "ready", role: "all" }),
      { mode: 0o600 },
    );
    const handle = await startDaemonOnFreePorts(startDaemon, {
      stateDbPath: tmp.dbPath,
      socketFile: tmp.socketFile,
      tokenFile: tmp.tokenFile,
    });
    try {
      // Boot succeeded → lock was reaped and rewritten with OUR pid + ready.
      expect(existsSync(tmp.socketFile)).toBe(true);
      const lock = JSON.parse(readFileSync(tmp.socketFile, "utf8")) as { pid: number; phase?: string };
      expect(lock.pid).toBe(process.pid);
      expect(lock.phase).toBe("ready");
    } finally {
      await stopDaemon(handle);
    }
  });

  test("boot writes phase:booting then phase:ready, and clean shutdown releases the lock", async () => {
    expect(existsSync(tmp.socketFile)).toBe(false);
    const handle = await startDaemonOnFreePorts(startDaemon, {
      stateDbPath: tmp.dbPath,
      socketFile: tmp.socketFile,
      tokenFile: tmp.tokenFile,
    });
    // After boot completes the lock is rewritten with the ready payload.
    const lock = JSON.parse(readFileSync(tmp.socketFile, "utf8")) as { pid: number; phase?: string; port?: number };
    expect(lock.pid).toBe(process.pid);
    expect(lock.phase).toBe("ready");
    expect(typeof lock.port).toBe("number");
    // Clean shutdown unlinks the lock.
    await stopDaemon(handle);
    expect(existsSync(tmp.socketFile)).toBe(false);
  });
});
