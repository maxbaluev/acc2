// acc2 dispatch CLI test — drive the programmatic entry against a real
// daemon running on a free port; assert it posts a `directive_opened` event
// with the owner's words and prints the directive id.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../substrate/db";
import { startDaemon, stopDaemon, type DaemonHandle } from "../runtime/daemon";
import { runDispatch } from "./dispatch";

// Stay in a tight band well-disjoint from runtime/*.test.ts (which sit in
// [19000, 60000)) so the daemon's MCP + aux ports don't collide with sibling
// test files when bun runs them in parallel.
const MCP_BASE = 12000;
const AUX_BASE = 17000;
const pickMcp = () => MCP_BASE + Math.floor(Math.random() * 1000);
const pickAux = () => AUX_BASE + Math.floor(Math.random() * 1000);

let handle: DaemonHandle | null = null;
let dir = "";
let prevPort: string | undefined;
let prevAuxPort: string | undefined;

const captureStdout = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
  return { lines, restore: () => { console.log = orig; } };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "acc2-dispatch-"));
  const port = pickMcp();
  const auxPort = pickAux();
  handle = await startDaemon({
    port, auxPort, stateDbPath: join(dir, "dispatch.db"),
    socketFile: join(dir, "v2.sock"), tokenFile: join(dir, "v2.sock.token"),
  });
  prevPort = process.env.V2_DAEMON_PORT;
  prevAuxPort = process.env.V2_DAEMON_AUX_PORT;
  process.env.V2_DAEMON_PORT = String(port);
  process.env.V2_DAEMON_AUX_PORT = String(auxPort);
});

afterEach(async () => {
  if (handle) await stopDaemon(handle);
  handle = null;
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (prevPort === undefined) delete process.env.V2_DAEMON_PORT;
  else process.env.V2_DAEMON_PORT = prevPort;
  if (prevAuxPort === undefined) delete process.env.V2_DAEMON_AUX_PORT;
  else process.env.V2_DAEMON_AUX_PORT = prevAuxPort;
});

describe("runDispatch", () => {
  test("`acc task '<words>'` posts a directive_opened event and prints the id", async () => {
    const cap = captureStdout();
    const code = await runDispatch(["task", "fix", "the", "broken", "test"]);
    cap.restore();

    expect(code).toBe(0);
    const joined = cap.lines.join("\n");
    expect(joined).toContain("directive_opened ");
    expect(joined).toContain("fix the broken test");

    // Verify the row landed in the db.
    const db = handle!.db;
    const rows = db
      .query("SELECT payload FROM events WHERE kind = 'directive_opened' ORDER BY ts DESC")
      .all() as Array<{ payload: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(rows[0]!.payload) as { text?: string };
    expect(last.text).toBe("fix the broken test");
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
