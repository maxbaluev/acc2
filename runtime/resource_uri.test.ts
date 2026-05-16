import { describe, expect, test } from "bun:test";
import { parseResourceUri, parseResourceRefs, repoTargetFilesFromResources, resourceMatchesPattern, resourcesFromTargetFiles } from "./resource_uri";

describe("resource URI parser", () => {
  test("accepts the domain-neutral resource schemes", () => {
    expect(parseResourceUri("repo:runtime/foo.ts")?.scheme).toBe("repo");
    expect(parseResourceUri("url:https://example.com/report")?.scheme).toBe("url");
    expect(parseResourceUri("browser_session:research/customer-a")?.scheme).toBe("browser_session");
    expect(parseResourceUri("ledger:directive/abc")?.scheme).toBe("ledger");
    expect(parseResourceUri("contact:stakeholder/alice")?.scheme).toBe("contact");
    expect(parseResourceUri("calendar:work/event-1")?.scheme).toBe("calendar");
    expect(parseResourceUri("sensor:habit_tracker/steps")?.scheme).toBe("sensor");
  });

  test("rejects malformed or unsafe resource URIs", () => {
    expect(parseResourceUri("repo:/absolute.ts")).toBeNull();
    expect(parseResourceUri("repo:../escape.ts")).toBeNull();
    expect(parseResourceUri("url:ftp://example.com/file")).toBeNull();
    expect(parseResourceUri("unknown:x")).toBeNull();
    expect(parseResourceUri("repo:has space.ts")).toBeNull();
  });

  test("normalizes accepted resource URIs", () => {
    expect(parseResourceUri("REPO:./runtime/foo.ts")?.uri).toBe("repo:runtime/foo.ts");
    expect(parseResourceUri("url:https://example.com/report")?.uri).toBe("url:https://example.com/report");
  });

  test("preserves repo target_files parity", () => {
    const refs = resourcesFromTargetFiles(["runtime/foo.ts", "docs/a.md"]);
    expect(refs?.map((r) => r.uri)).toEqual(["repo:runtime/foo.ts", "repo:docs/a.md"]);
    expect(repoTargetFilesFromResources(refs)).toEqual(["runtime/foo.ts", "docs/a.md"]);
    expect(parseResourceRefs(JSON.stringify(["repo:runtime/foo.ts"]))?.[0]?.id).toBe("runtime/foo.ts");
  });

  test("matches patterns within the same resource scheme only", () => {
    const repo = parseResourceUri("repo:runtime/foo.ts")!;
    const url = parseResourceUri("url:https://example.com/runtime/foo.ts")!;
    expect(resourceMatchesPattern(repo, "extension", "repo:.ts")).toBe(true);
    expect(resourceMatchesPattern(repo, "glob", "repo:runtime/*.ts")).toBe(true);
    expect(resourceMatchesPattern(url, "glob", "repo:runtime/*.ts")).toBe(false);
  });
});
