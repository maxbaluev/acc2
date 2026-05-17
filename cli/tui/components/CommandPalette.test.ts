// cli/tui/components/CommandPalette.test.ts — parseCommand contract.
//
// parseCommand is the load-bearing translation from the operator's
// command-line text into the canonical acc-verb argv vector the TUI
// spawns. Every supported verb gets one assertion so a regression
// where a verb falls through to noop is caught locally instead of
// surfacing as "the TUI silently ignored my input" in the field.

import { describe, expect, test } from "bun:test";
import { parseCommand } from "./CommandPalette";

const shellArgv = (line: string): string[] => {
  const intent = parseCommand(line);
  if (intent.kind !== "shell") throw new Error(`parseCommand(${JSON.stringify(line)}) → ${intent.kind}`);
  return intent.argv;
};

describe("parseCommand", () => {
  test("task — collapses words into a single argv entry", () => {
    expect(shellArgv("task fix the TUI hotkeys")).toEqual(["task", "fix the TUI hotkeys"]);
  });

  test("apply — preserves event_id literally", () => {
    expect(shellArgv("apply RPDJGRQPW57T")).toEqual(["apply", "RPDJGRQPW57T"]);
  });

  test("decline — adds --decline flag", () => {
    expect(shellArgv("decline RPDJGRQPW57T")).toEqual(["apply", "RPDJGRQPW57T", "--decline"]);
  });

  test("tail — local TUI drawer toggle (no spawn)", () => {
    expect(shellArgv("tail")).toEqual(["__tui__", "tail"]);
  });

  test("inspect <event_id> — pins Event Inspector drawer to the id", () => {
    expect(shellArgv("inspect AMENDEV_ABC123")).toEqual(["events", "--id", "AMENDEV_ABC123"]);
  });

  test("observe — pipes verdict + reason as flags (operator-feedback loop)", () => {
    expect(shellArgv("observe EVT_ABC negative TUI hotkeys still broken")).toEqual([
      "observe",
      "EVT_ABC",
      "--verdict",
      "negative",
      "--reason",
      "TUI hotkeys still broken",
    ]);
  });

  test("observe — without reason still emits the verdict", () => {
    expect(shellArgv("observe EVT_ABC positive")).toEqual([
      "observe",
      "EVT_ABC",
      "--verdict",
      "positive",
    ]);
  });

  test("changes — defaults the window to 24h when omitted", () => {
    expect(shellArgv("changes")).toEqual(["changes", "24h"]);
  });

  test("whoami / status / pending — wrap cleanly", () => {
    expect(shellArgv("whoami")).toEqual(["whoami"]);
    expect(shellArgv("status")).toEqual(["status"]);
    expect(shellArgv("pending")).toEqual(["admin", "pending-decisions"]);
  });

  test("q / quit / exit — exit intent (not shell)", () => {
    expect(parseCommand("q").kind).toBe("exit");
    expect(parseCommand("quit").kind).toBe("exit");
    expect(parseCommand("exit").kind).toBe("exit");
  });

  test("unknown verbs do NOT pass through to a raw acc subprocess (audit 6H587JE69X)", () => {
    expect(parseCommand("rm -rf /").kind).toBe("noop");
    expect(parseCommand("not-a-real-verb").kind).toBe("noop");
  });
});
