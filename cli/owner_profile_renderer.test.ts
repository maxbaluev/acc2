import { describe, expect, test } from "bun:test";
import { renderOwnerString } from "./owner_profile_renderer";

describe("renderOwnerString", () => {
  test("replaces avoided terms with preferred terms", () => {
    expect(renderOwnerString("agent should leverage this", {
      preferred_terms: ["runtime", "use"],
      avoided_terms: ["agent", "leverage"],
      detected_language: "en",
    })).toBe("runtime should use this");
  });

  test("preserves canonical tokens", () => {
    const input = "agent sees task_committed live queued_at_cap Q4HMCH30BS5030E5C4AFTENBB4 a1b2c3d4";
    const output = renderOwnerString(input, { preferred_terms: ["runtime"], avoided_terms: ["agent", "live"] });
    expect(output).toContain("runtime sees");
    expect(output).toContain("task_committed");
    expect(output).toContain("live queued_at_cap");
    expect(output).toContain("Q4HMCH30BS5030E5C4AFTENBB4");
    expect(output).toContain("a1b2c3d4");
  });
});
