// acc2 dispatch CLI test — drive the programmatic entry against a real
// daemon running on a free port; assert it posts a `directive_opened` event
// with the owner's words and prints the directive id.

import { describe, expect, test } from "bun:test";
import { runDispatch } from "./dispatch";
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
