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
