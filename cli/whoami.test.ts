// acc whoami test — drive runWhoami against a real daemon (same pattern as
// cli/dispatch.test.ts and cli/admin.test.ts). Pre-2026-05-17 this file
// mock.module'd "./rpc" at the top level, and Bun's mock registry persisted
// the override across the worker — cli/dispatch.test.ts then saw mcpCall
// routed through the whoami mock and the embedded expect(tool).toBe(
// "substrate.read") fired against dispatch's "substrate.open_directive"
// call. Routing whoami through a real daemon removes the mock entirely;
// no global registry pollution is possible.

import { describe, expect, test } from "bun:test";
import { runWhoami } from "./whoami";
import { mcpCall } from "./rpc";
import { useSharedDaemon } from "../tests/daemon_fixture";

// Disjoint port band from dispatch (12000/17000) and external_ingress
// (8000/10000) so parallel test files don't collide.
const MCP_BASE = 14000;
const AUX_BASE = 19000;
useSharedDaemon({
  tmpPrefix: "acc2-whoami-",
  dbName: "whoami.db",
  mcpBase: MCP_BASE,
  auxBase: AUX_BASE,
});

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => { out.push(typeof chunk === "string" ? chunk : String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { err.push(typeof chunk === "string" ? chunk : String(chunk)); return true; }) as typeof process.stderr.write;
  return { out, err, restore: () => { process.stdout.write = o; process.stderr.write = e; } };
};

describe("runWhoami", () => {
  test("fresh substrate prints a one-screen default card", async () => {
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

  test("--json emits machine-readable profile data sourced from owner_profile_recorded", async () => {
    // Seed a real owner_profile_recorded event via substrate.emit so the
    // owner_profile_view returns it. No mocks — the daemon, MCP transport,
    // and view layer all execute end-to-end.
    const emitted = await mcpCall("substrate.emit", {
      kind: "owner_profile_recorded",
      substrate_origin: "owner",
      payload: {
        detected_language: "en",
        autonomy_score: 0.9,
        autonomy_score_floor: 0.4,
        rendering_signals: { code_density: 1, casual_register: 0.2 },
        preferred_terms: ["runtime"],
        avoided_terms: ["agent"],
        things_to_never_do: ["rewrite canonical tokens"],
        hot_topics: ["profile view"],
        time_window: { timezone: "UTC" },
        exposed_concepts: ["mcp"],
        declined_concepts: ["persona enum"],
      },
    });
    expect(emitted.ok).toBe(true);
    const c = capture();
    const code = await runWhoami(["--json"]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out.join(""));
    expect(parsed.contract.name).toBe("acc_whoami_profile");
    expect(parsed.source_event_id).toBeTruthy();
    expect(parsed.profile.detected_language).toBe("en");
    expect(parsed.profile.top_rendering_signals[0]).toEqual({ key: "code_density", value: 1 });
    expect(parsed.profile.avoided_terms).toEqual(["agent"]);
  });
});
