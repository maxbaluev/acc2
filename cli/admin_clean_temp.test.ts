// cli/admin_clean_temp.test.ts — covers the OS-hygiene sweeper:
// - removes recognised /tmp/acc2-* dirs
// - refuses anything outside /tmp/ or with the wrong prefix
// - emits zero substrate events

import { describe, expect, test } from "bun:test";
import {
  CLEAN_TEMP_PREFIXES, refuseReason, runCleanTempState,
} from "./admin_clean_temp";

describe("refuseReason — safety check", () => {
  test("allows canonical /tmp/acc2-harness-task-* path", () => {
    expect(refuseReason("/tmp/acc2-harness-task-abc123")).toBe(null);
  });

  test("allows every recognised prefix", () => {
    for (const prefix of CLEAN_TEMP_PREFIXES) {
      expect(refuseReason(`/tmp/${prefix}xyz`)).toBe(null);
    }
  });

  test("refuses path outside /tmp/", () => {
    const reason = refuseReason("/var/acc2-harness-task-abc");
    expect(reason).not.toBe(null);
    expect(reason!).toContain("outside /tmp/");
  });

  test("refuses non-matching basename inside /tmp/", () => {
    const reason = refuseReason("/tmp/something-else");
    expect(reason).not.toBe(null);
    expect(reason!).toContain("non-matching basename");
  });

  test("refuses nested path under /tmp/ (traversal guard)", () => {
    const reason = refuseReason("/tmp/acc2-harness-task-abc/sub");
    expect(reason).not.toBe(null);
    expect(reason!).toContain("nested path");
  });
});

describe("runCleanTempState — programmatic entry", () => {
  test("removes every enumerated candidate that passes the safety check", async () => {
    const removed: string[] = [];
    const outLines: string[] = [];
    const errLines: string[] = [];
    const code = await runCleanTempState([], {
      out: (l) => outLines.push(l),
      err: (l) => errLines.push(l),
      enumerate: () => [
        "/tmp/acc2-harness-task-fixture1",
        "/tmp/acc2-cli-deep-fixture2",
      ],
      remove: (p) => { removed.push(p); },
    });
    expect(code).toBe(0);
    expect(removed.sort()).toEqual([
      "/tmp/acc2-cli-deep-fixture2",
      "/tmp/acc2-harness-task-fixture1",
    ]);
    // each removal printed one line, plus a tally line
    expect(outLines.some((l) => l.includes("removed: /tmp/acc2-harness-task-fixture1"))).toBe(true);
    expect(outLines.some((l) => l.includes("removed: /tmp/acc2-cli-deep-fixture2"))).toBe(true);
    expect(outLines.some((l) => l.includes("removed=2"))).toBe(true);
  });

  test("refuses /tmp/something-else without invoking remove()", async () => {
    const removed: string[] = [];
    const errLines: string[] = [];
    const code = await runCleanTempState([], {
      out: () => {},
      err: (l) => errLines.push(l),
      // Even if the enumerator (hypothetically) returned a stray path,
      // the per-path safety check must refuse it.
      enumerate: () => ["/tmp/something-else"],
      remove: (p) => { removed.push(p); },
    });
    expect(code).toBe(0);
    expect(removed).toEqual([]);
    expect(errLines.some((l) => l.includes("refused"))).toBe(true);
  });

  test("returns 0 with a friendly note when nothing matches", async () => {
    const outLines: string[] = [];
    const code = await runCleanTempState([], {
      out: (l) => outLines.push(l),
      err: () => {},
      enumerate: () => [],
      remove: () => {},
    });
    expect(code).toBe(0);
    expect(outLines.some((l) => l.includes("no stale harness state dirs"))).toBe(true);
  });
});
