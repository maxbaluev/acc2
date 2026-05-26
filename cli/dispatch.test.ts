// acc2 dispatch CLI test — drive the programmatic entry against a real
// daemon running on a free port; assert it posts a `directive_opened` event
// with the owner's words and prints the directive id.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runDispatch, renderDaemonStatus } from "./dispatch";
import { useSharedDaemon } from "../tests/daemon_fixture";

// Stay in a tight band well-disjoint from runtime/*.test.ts (which sit in
// [19000, 60000)) so the daemon's MCP + aux ports don't collide with sibling
// test files when bun runs them in parallel.
const MCP_BASE = 12000;
const AUX_BASE = 17000;
const daemon = useSharedDaemon({
  tmpPrefix: "acc2-dispatch-",
  dbName: "dispatch.db",
  mcpBase: MCP_BASE,
  auxBase: AUX_BASE,
});

const captureStdout = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
  return { lines, restore: () => { console.log = orig; } };
};

describe("runDispatch", () => {
  test("`acc task '<words>' --bare` opens a directive (directive_opened + root task_node_opened)", async () => {
    // Default mode now follows the event stream — that's tested with a
    // bounded deadline in a separate case. Here we assert the bare
    // "open + ack" shape with --bare so the test stays deterministic.
    const cap = captureStdout();
    const code = await runDispatch(["task", "--bare", "fix", "the", "broken", "test"]);
    cap.restore();

    expect(code).toBe(0);
    const joined = cap.lines.join("\n");
    // Compact panel-friendly form (ux/cli-observe panel-friendly follow tail):
    // `directive_opened <id> root=<task_short> · awaiting cycle-1` — exactly
    // ONE line in default mode. The full directive text + text_chars footer
    // move behind --verbose so the trailing-5-line background_tasks panel
    // is reserved for brain-progress signal, not stale prompt echo.
    expect(joined).toContain("directive_opened ");
    expect(joined).toContain("root=");
    expect(joined).toContain("· awaiting cycle-1");
    // No prompt echo by default — full text is in the ledger payload row.
    expect(joined).not.toContain("fix the broken test");
    // No text_chars footer by default — moved behind --verbose.
    expect(joined).not.toContain("text_chars");
    // Every emitted stdout line stays ≤ 120 chars (MAX_EVENT_LINE_CHARS).
    for (const ln of cap.lines) expect(ln.length).toBeLessThanOrEqual(120);

    // Directive_opened payload carries directive_text (the canonical
    // open_directive shape; the prior `payload.text` shape was a substrate
    // bypass via substrate.emit).
    const db = daemon.handle().db;
    const directiveRows = db
      .query("SELECT payload FROM events WHERE kind = 'directive_opened' ORDER BY ts DESC")
      .all() as Array<{ payload: string }>;
    expect(directiveRows.length).toBeGreaterThanOrEqual(1);
    const dpay = JSON.parse(directiveRows[0]!.payload) as { directive_text?: string; lifecycle?: string };
    expect(dpay.directive_text).toBe("fix the broken test");
    expect(dpay.lifecycle).toBe("finite");

    // Root task_node_opened must exist so the scheduler can dispatch.
    const taskRows = db
      .query("SELECT payload FROM events WHERE kind = 'task_node_opened' ORDER BY ts DESC")
      .all() as Array<{ payload: string }>;
    expect(taskRows.length).toBeGreaterThanOrEqual(1);
    const tpay = JSON.parse(taskRows[0]!.payload) as { goal?: string };
    expect(tpay.goal).toBe("fix the broken test");
  });

  test("`acc task` with no words returns exit 1", async () => {
    const code = await runDispatch(["task"]);
    expect(code).toBe(1);
  });

  test("`acc daemon status` prints the /health response", async () => {
    const cap = captureStdout();
    const code = await runDispatch(["daemon", "status"]);
    cap.restore();
    expect(code).toBe(0);
    const out = cap.lines.join("\n");
    expect(out).toContain('"status"');
    expect(out).toContain("ok");
  });

  // Amendment R6B5VZGXE5 (safe subset): reactive false-dead status fix.
  // A client-side /health timeout must NOT be reported as a dead daemon when
  // the lock pid is still alive — that is the "Terminated"-while-/health-ok
  // false-dead the directive observed. Pure-render unit tests prove both legs:
  // (a) reactive resolve — pending health + live pid → `processing`; and
  // (b) escalate-on-genuine-death — pending health + dead pid → raw failure.
  describe("renderDaemonStatus reactive false-dead fix (R6B5VZGXE5)", () => {
    const timeoutHealth = { ok: false, error: "timeout:30000ms:http://127.0.0.1:9/health" };
    const fetchFailHealth = { ok: false, error: "fetch_failed:Unable to connect" };
    const okHealth = { ok: true, status: "ok", uptime_ms: 1234 };

    test("(a) resolves promptly to processing when /health is pending but the lock pid is alive", () => {
      const out = renderDaemonStatus(timeoutHealth, { pid: 4242 }, () => true);
      expect(out.ok).toBe(true);
      expect(out.status).toBe("processing");
      expect(out.reason).toBe("health_pending_pid_alive");
      expect(out.pid).toBe(4242);
      // Never reports the daemon dead from a client deadline alone.
      expect(JSON.stringify(out)).not.toContain("Terminated");
    });

    test("(a) same reactive treatment for a transient fetch_failed probe", () => {
      const out = renderDaemonStatus(fetchFailHealth, { pid: 7 }, () => true);
      expect(out.status).toBe("processing");
    });

    test("(b) escalates: pending /health + DEAD pid surfaces the raw failure envelope", () => {
      const out = renderDaemonStatus(timeoutHealth, { pid: 4242 }, () => false);
      // No false optimism — the genuine-death envelope passes through unchanged.
      expect(out.ok).toBe(false);
      expect(out.error).toBe(timeoutHealth.error);
      expect(out.status).toBeUndefined();
    });

    test("(b) escalates: pending /health + NO lock surfaces the raw failure envelope", () => {
      const out = renderDaemonStatus(timeoutHealth, null, () => true);
      expect(out.ok).toBe(false);
      expect(out.error).toBe(timeoutHealth.error);
    });

    test("a healthy /health response passes through untouched (no pid probe needed)", () => {
      let probed = false;
      const out = renderDaemonStatus(okHealth, { pid: 1 }, () => { probed = true; return true; });
      expect(out).toEqual(okHealth);
      expect(probed).toBe(false);
    });

    test("a non-timeout error (e.g. 500) is NOT masked as processing", () => {
      const errHealth = { ok: false, error: "non_json:internal server error" };
      const out = renderDaemonStatus(errHealth, { pid: 1 }, () => true);
      expect(out).toEqual(errHealth);
    });
  });

  test("`acc help` prints the usage banner", async () => {
    const cap = captureStdout();
    const code = await runDispatch(["help"]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.lines.join("\n")).toContain("acc task");
  });

  // `acc ask`, scoreAskRoutes, and `acc help me with <words>` were all
  // removed 2026-05-16 (universal workflow: one entrypoint `acc task`;
  // substrate decides the lane via dispatch_decider open-ended axes).
  // Unknown-command behaviour now covers the former routes.

  test("unknown command returns exit 1", async () => {
    const orig = console.error;
    console.error = () => { /* silence */ };
    try {
      const code = await runDispatch(["banana"]);
      expect(code).toBe(1);
    } finally {
      console.error = orig;
    }
  });
});

describe("daemonRestart stale-lock cleanup uses the canonical resolvers", () => {
  // Regression for the drift the brain caught: daemonRestart's stale-lock
  // cleanup hardcoded `homedir()/.accint/v2.sock`, so an ACC2_STATE_DIR /
  // ACC2_SOCKET_FILE deployment would probe/delete the wrong default lock.
  // The fix routes through resolveSocketFile()/resolveTokenFile() — the same
  // resolvers daemonStart() and runtime/daemon.ts use. Asserted at the
  // source level because daemonRestart spawns a real daemon (can't exercise
  // it without restarting the running one).
  const src = readFileSync(join(import.meta.dir, "dispatch.ts"), "utf8");
  const block = (() => {
    const i = src.indexOf("Clean any lingering stale lock");
    expect(i).toBeGreaterThanOrEqual(0);
    return src.slice(i, i + 600);
  })();

  test("uses resolveSocketFile() / resolveTokenFile()", () => {
    expect(block).toContain("resolveSocketFile()");
    expect(block).toContain("resolveTokenFile()");
  });

  test("no longer hardcodes the default ~/.accint/v2.sock path", () => {
    expect(block).not.toContain('homedir(), ".accint", "v2.sock"');
  });
});

// ── Crash-watchdog wiring (follow-on for AHV73KJDK54P3FF7D2NDV9TQ2C) ──
//
// The watchdog (runtime/daemon_supervisor.ts) only fires if `acc daemon start`
// launches the daemon UNDER startDaemonSupervised. These tests pin that the
// canonical default path routes through the supervisor — and that
// `--foreground-child` opts OUT — without ever spawning a real daemon: we mock
// node:child_process spawn so the child is a no-op fake, and spy the watchdog.
describe("acc daemon start routes through the crash-watchdog supervisor", () => {
  const src = readFileSync(join(import.meta.dir, "dispatch.ts"), "utf8");

  test("daemonStart delegates to startDaemonSupervised by default", () => {
    // The spawn now lives in cli/daemon.ts; daemonStart imports and calls the
    // supervised entry rather than spawning runtime/daemon.ts directly.
    expect(src).toContain('await import("./daemon")');
    expect(src).toContain("startDaemonSupervised({ foregroundChild: opts.foregroundChild");
    // The raw `spawn("bun", [entry], …)` direct-spawn block is gone from
    // daemonStart — that path now lives only behind the supervisor.
    const startIdx = src.indexOf("const daemonStart =");
    const startBody = src.slice(startIdx, src.indexOf("const daemonStop ="));
    expect(startBody).not.toContain('spawn("bun"');
  });

  test("`--foreground-child` flag is threaded from the daemon subcommand routing", () => {
    expect(src).toContain('daemonStart({ foregroundChild: argv.includes("--foreground-child") })');
  });

  test("daemonStop routes through the bounded stop path", () => {
    expect(src).toContain("stopDaemonBounded");
    const stopIdx = src.indexOf("const daemonStop =");
    const stopBody = src.slice(stopIdx, src.indexOf("const daemonStatus ="));
    expect(stopBody).toContain('await import("./daemon")');
    expect(stopBody).toContain("stopDaemonBounded({ drainBudgetMs: opts.drainBudgetMs })");
  });

  test("default start consults the watchdog when a lock exists; --foreground-child skips it (mocked spawn)", async () => {
    const { mock } = await import("bun:test");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    // Isolate state dir + write a lock so the supervised branch reaches the
    // watchdog. We never spawn a real daemon: spawn is mocked to a fake child.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "acc2-wd-"));
    const prevStateDir = process.env.ACC2_STATE_DIR;
    const prevSock = process.env.ACC2_SOCKET_FILE;
    process.env.ACC2_STATE_DIR = stateDir;
    delete process.env.ACC2_SOCKET_FILE;

    const spawnSpy = mock(() => ({ pid: 4242, unref() {} }));
    mock.module("node:child_process", () => ({ spawn: spawnSpy }));

    const watchdogSpy = mock(async () => ({
      action: "no_recovery_needed" as const,
      reason: "lock_healthy",
      verdict: { reason: "alive" },
    }));
    mock.module("../runtime/daemon_supervisor", () => ({ recoverCrashedDaemon: watchdogSpy }));

    // Fresh import so the mocks are in effect for this module instance.
    // `?wd-test` query suffix forces a fresh module instance so the mocks
    // above apply. Cast to string so tsc skips module resolution on the
    // Bun-only query specifier (runtime behavior unchanged).
    const { startDaemonSupervised } = await import("./daemon?wd-test" as string);

    try {
      const { resolveSocketFile } = await import("../runtime/state_paths");
      const lockPath = resolveSocketFile();
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port: 1, aux_port: 2, role: "all" }));

      // Default (supervised): the watchdog MUST be consulted; spawn is NOT
      // called directly because the healthy incumbent is left untouched.
      watchdogSpy.mockClear();
      spawnSpy.mockClear();
      const supervised = await startDaemonSupervised({});
      expect(watchdogSpy).toHaveBeenCalledTimes(1);
      expect(supervised.outcome).toBe("already_healthy");
      expect(spawnSpy).not.toHaveBeenCalled();

      // --foreground-child: opts OUT of the watchdog and spawns directly.
      watchdogSpy.mockClear();
      spawnSpy.mockClear();
      const foreground = await startDaemonSupervised({ foregroundChild: true });
      expect(watchdogSpy).not.toHaveBeenCalled();
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(foreground.outcome).toBe("spawned_fresh");
    } finally {
      mock.restore();
      if (prevStateDir === undefined) delete process.env.ACC2_STATE_DIR; else process.env.ACC2_STATE_DIR = prevStateDir;
      if (prevSock !== undefined) process.env.ACC2_SOCKET_FILE = prevSock;
      try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
