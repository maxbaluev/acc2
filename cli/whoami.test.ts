import { beforeEach, describe, expect, mock, test } from "bun:test";

type Env = { ok: true; result: unknown } | { ok: false; error: string };
let env: Env;

mock.module("./rpc", () => ({
  mcpCall: async (tool: string, args: Record<string, unknown>) => {
    expect(tool).toBe("substrate.read");
    expect(args.view_name).toBe("owner_profile_view");
    return env;
  },
}));

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => { out.push(typeof chunk === "string" ? chunk : String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { err.push(typeof chunk === "string" ? chunk : String(chunk)); return true; }) as typeof process.stderr.write;
  return { out, err, restore: () => { process.stdout.write = o; process.stderr.write = e; } };
};

beforeEach(() => {
  env = { ok: true, result: [] };
});

describe("runWhoami", () => {
  test("fresh substrate prints a one-screen default card", async () => {
    const { runWhoami } = await import("./whoami");
    const c = capture();
    const code = await runWhoami([]);
    c.restore();
    expect(code).toBe(0);
    const out = c.out.join("");
    expect(out).toContain("acc whoami - owner profile");
    expect(out).toContain("source=fresh_substrate_default");
    expect(out).toContain("autonomy_score=unset floor=0.40 with_floor=0.40");
    expect(out).toContain("rendering_signals=none");
    expect(c.err.join("")).toBe("");
  });

  test("--json emits machine-readable profile data", async () => {
    env = { ok: true, result: [{ event_id: "EVT123", ts: "2026-05-16T00:00:00.000Z", payload: {
      detected_language: "en",
      autonomy_score: 0.9,
      autonomy_score_floor: 0.4,
      rendering_signals: { code_density: 1, casual_register: 0.2, ignored: "no" },
      preferred_terms: ["runtime"],
      avoided_terms: ["agent"],
      things_to_never_do: ["rewrite canonical tokens"],
      hot_topics: ["profile view"],
      time_window: { timezone: "UTC" },
      exposed_concepts: ["mcp"],
      declined_concepts: ["persona enum"],
    } }] };
    const { runWhoami } = await import("./whoami");
    const c = capture();
    const code = await runWhoami(["--json"]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out.join(""));
    expect(parsed.contract.name).toBe("acc_whoami_profile");
    expect(parsed.source_event_id).toBe("EVT123");
    expect(parsed.profile.detected_language).toBe("en");
    expect(parsed.profile.top_rendering_signals[0]).toEqual({ key: "code_density", value: 1 });
    expect(parsed.profile.avoided_terms).toEqual(["agent"]);
  });
});
