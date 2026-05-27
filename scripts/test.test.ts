import { describe, expect, test } from "bun:test";
import { parseFailedTestFiles } from "./test";
describe("scripts/test failed-file retry parsing", () => {
  test("extracts current file from Bun file-heading plus fail marker", () => {
    const output = ["runtime/bridge.test.ts:", "(pass) bridge > happy path [1.00ms]", "(fail) bridge > transient native crash [0.01ms]", "runtime/daemon.test.ts:", "(pass) daemon > starts [1.00ms]"].join("\n");
    expect(parseFailedTestFiles(output)).toEqual(["runtime/bridge.test.ts"]);
  });
  test("extracts direct failed file paths and de-duplicates", () => {
    const output = ["fail: ./runtime/task_dispatcher.test.ts:123: expected 1 to be 0", "error while running runtime/task_dispatcher.test.ts", "SIGILL in runtime/daemon.test.ts"].join("\n");
    expect(parseFailedTestFiles(output)).toEqual(["runtime/daemon.test.ts", "runtime/task_dispatcher.test.ts"]);
  });
});
