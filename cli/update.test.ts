// `acc update` self-update path: gate, happy path, and rollback-on-failed-health.
// runUpdate takes an injectable UpdateEnv so we drive git/daemon/health via mocks
// without touching the real source tree, daemon, or state.db.
import { test, expect, describe } from "bun:test";
import { runUpdate, type UpdateEnv } from "./update";

type Call = { cmd: string; args: string[] };

const makeEnv = (opts: {
  healthOk: boolean;
  calls: Call[];
  events: string[];
}): UpdateEnv => ({
  out: (line) => opts.events.push("OUT " + line),
  err: (line) => opts.events.push("ERR " + line),
  // Mock spawnSync: git rev-parse/pull/reset all succeed; record every call.
  spawnSync: ((cmd: string, args: string[]) => {
    opts.calls.push({ cmd, args });
    if (args[0] === "rev-parse") return { status: 0, stdout: "abc1234deadbeef\n", stderr: "" } as never;
    return { status: 0, stdout: "", stderr: "" } as never;
  }) as UpdateEnv["spawnSync"],
  startDaemon: async () => { opts.events.push("START"); },
  stopDaemon: async () => { opts.events.push("STOP"); return true; },
  healthOk: async () => opts.healthOk,
  // Nonexistent db path → migration block is skipped (existsSync false).
  dbPath: "/nonexistent/acc2-update-test/state.db",
});

describe("acc update", () => {
  test("refuses to mutate without --yes", async () => {
    const events: string[] = [];
    const code = await runUpdate([], makeEnv({ healthOk: true, calls: [], events }));
    expect(code).toBe(1);
    expect(events.some((e) => e.includes("rerun with --yes"))).toBe(true);
    // No daemon mutation happened.
    expect(events).not.toContain("STOP");
  });

  test("--help returns 0 without mutating", async () => {
    const events: string[] = [];
    const calls: Call[] = [];
    const code = await runUpdate(["--help"], makeEnv({ healthOk: true, calls, events }));
    expect(code).toBe(0);
    expect(calls.length).toBe(0);
  });

  test("happy path: post-update health ok returns 0 and restarts the daemon", async () => {
    const events: string[] = [];
    const calls: Call[] = [];
    const code = await runUpdate(["--yes", "--no-pull"], makeEnv({ healthOk: true, calls, events }));
    expect(code).toBe(0);
    expect(events).toContain("STOP");
    expect(events).toContain("START");
    expect(events.some((e) => e.includes("post-update health: ok"))).toBe(true);
    // --no-pull means no `git pull`; only rev-parse before/after.
    expect(calls.every((c) => c.args[0] !== "pull")).toBe(true);
    // No rollback reset on the happy path.
    expect(calls.every((c) => !(c.args[0] === "reset"))).toBe(true);
  });

  test("rollback: failed post-update health resets --hard to the pre-update HEAD and returns 1", async () => {
    const events: string[] = [];
    const calls: Call[] = [];
    const code = await runUpdate(["--yes", "--no-pull"], makeEnv({ healthOk: false, calls, events }));
    expect(code).toBe(1);
    // Rolled back to the HEAD captured before the update (abc1234deadbeef).
    const reset = calls.find((c) => c.cmd === "git" && c.args[0] === "reset");
    expect(reset).toBeDefined();
    expect(reset!.args).toEqual(["reset", "--hard", "abc1234deadbeef"]);
    expect(events.some((e) => e.includes("rolling source back"))).toBe(true);
  });
});
