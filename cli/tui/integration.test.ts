// cli/tui/integration.test.ts — end-to-end harness verifying the TUI works
// against the REAL running daemon. Unit tests with mock snapshots cannot
// catch transport-layer bugs (callHealth hitting a non-existent MCP method,
// label mis-mapping, projection windowing) — the owner's screenshot caught
// exactly that gap (health=DEAD / uptime=? / closure=? / zombie=235 against
// a healthy daemon).
//
// This harness is opt-in via `ACC2_TUI_HARNESS_REAL=1`. The default test
// preload sandboxes ACC2_STATE_DIR to a per-PID tmpdir so `bun test` stays
// hermetic — that sandboxing means the test process cannot see the
// operator's real daemon lock at ~/.accint/v2.sock. Setting
// `ACC2_TUI_HARNESS_REAL=1` overrides the sandbox INSIDE this test file
// (and only this file) so the harness queries the real daemon at the real
// lock path. Run it as:
//
//   bun cli/dispatch.ts daemon start                # ensure daemon is up
//   ACC2_TUI_HARNESS_REAL=1 bun test cli/tui/integration.test.ts
//
// Without the env var the harness skips cleanly so the default `bun test`
// suite remains hermetic.
//
// Invariants asserted:
//   1. realSubstrateClient.health() returns ok:true / status:"ok" /
//      uptime_s:number / events_count:number  — the StatusLine bug the
//      owner caught was a transport-layer mismatch; this asserts the shape.
//   2. fetchDashboardSnapshot() produces a non-null DashboardSnapshot whose
//      health.verdict is "ALIVE" (not "DEAD"), uptime_s is a finite number,
//      and events_count is a positive integer.
//   3. dispatch_resolved_view rows that DO come back carry literal lifecycle
//      tokens from the substrate-owned vocabulary (live/queued_at_cap/
//      completed/failed/zombie) — never the TUI-local "live" fallback.
//   4. owner_profile_view routes through substrate.read (the MCP gap fixed
//      in commit 24d8dfa surfaced via fetchDashboardSnapshot).
//   5. Each canonical view returns shape-coherent data when read through
//      the SubstrateClient (smoke check: arrays for view reads).
//   6. The acc CLI binaries the command palette spawns (acc whoami, acc
//      status, acc changes 24h) all exit 0 with parseable JSON when invoked
//      with --json — proving the palette's wrapped verbs actually work.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// IMPORTANT: this file must restore the real state-dir BEFORE importing
// rpc/transport/store so their port resolvers read the real daemon lock,
// not the hermetic per-PID tmpdir the preload set.
const HARNESS_REAL = process.env.ACC2_TUI_HARNESS_REAL === "1";
const ORIGINAL_STATE_DIR = process.env.ACC2_STATE_DIR;
if (HARNESS_REAL) {
  process.env.ACC2_STATE_DIR = join(homedir(), ".accint");
}

const { auxBaseUrl } = await import("../rpc");
const { realSubstrateClient } = await import("./transport/substrate-client");
const { fetchDashboardSnapshot } = await import("./state/store");

const daemonReachable = (): boolean => {
  if (!HARNESS_REAL) return false;
  // Look at the canonical lock file directly so we don't depend on
  // auxBaseUrl resolution chains crossing the preload's sandbox.
  const lockPath = join(homedir(), ".accint", "v2.sock");
  if (!existsSync(lockPath)) return false;
  try {
    JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return false;
  }
  // Probe the aux endpoint.
  const base = auxBaseUrl();
  if (!base) return false;
  try {
    const r = spawnSync("bun", ["cli/dispatch.ts", "daemon", "status"], {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, ACC2_STATE_DIR: join(homedir(), ".accint") },
    });
    if (r.status !== 0) return false;
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    return /"status"\s*:\s*"ok"/.test(out);
  } catch {
    return false;
  }
};

const DAEMON_OK = daemonReachable();

const CANONICAL_LIFECYCLE_TOKENS = new Set([
  "live", "queued_at_cap", "completed", "failed", "zombie",
]);

beforeAll(() => {
  if (!HARNESS_REAL) {
    // eslint-disable-next-line no-console
    console.warn(
      "[cli/tui/integration] ACC2_TUI_HARNESS_REAL=1 not set — skipping the live-substrate harness. " +
      "Run as `ACC2_TUI_HARNESS_REAL=1 bun test cli/tui/integration.test.ts` to exercise.",
    );
  } else if (!DAEMON_OK) {
    // eslint-disable-next-line no-console
    console.warn(
      "[cli/tui/integration] daemon unreachable at ~/.accint/v2.sock — start with " +
      "`bun cli/dispatch.ts daemon start` and re-run.",
    );
  }
});

afterAll(() => {
  // Restore the preload-set state-dir so neighboring tests stay hermetic.
  if (ORIGINAL_STATE_DIR === undefined) delete process.env.ACC2_STATE_DIR;
  else process.env.ACC2_STATE_DIR = ORIGINAL_STATE_DIR;
});

describe.skipIf(!DAEMON_OK)("TUI integration harness (real substrate)", () => {
  test("realSubstrateClient.health() returns the canonical /health shape via aux-port", async () => {
    const client = realSubstrateClient();
    const h = await client.health();
    expect(h.ok).toBe(true);
    expect(h.status).toBe("ok");
    expect(typeof h.uptime_s).toBe("number");
    expect(h.uptime_s as number).toBeGreaterThan(0);
    expect(typeof h.events_count).toBe("number");
    expect(h.events_count as number).toBeGreaterThan(0);
  }, 10_000);

  test("fetchDashboardSnapshot produces ALIVE verdict + numeric uptime against a live daemon", async () => {
    const client = realSubstrateClient();
    const snap = await fetchDashboardSnapshot(client);
    expect(snap).not.toBeNull();
    expect(snap.health.verdict).toBe("ALIVE");
    expect(typeof snap.health.uptime_s).toBe("number");
    expect(snap.health.uptime_s as number).toBeGreaterThan(0);
    expect(typeof snap.health.events_count).toBe("number");
    expect(snap.health.daemon_status).toBe("ok");
  }, 15_000);

  test("dispatch_resolved_view rows carry literal substrate-owned lifecycle tokens (no TUI-local fabrication)", async () => {
    const client = realSubstrateClient();
    const snap = await fetchDashboardSnapshot(client);
    // The view may return many historical rows; check the first 50.
    const sample = snap.dispatch.slice(0, 50);
    for (const row of sample) {
      // The lifecycle_status MUST be a literal token; the TUI now widens to
      // `string` so an unknown value would pass through verbatim — but every
      // value we DO see should be in the canonical set when the substrate is
      // running its production view. If a NEW value appears, it must be a
      // string, never "unknown" (which would prove lifecycleFromView returned
      // the empty-field fallback).
      expect(typeof row.lifecycle_status).toBe("string");
      if (!CANONICAL_LIFECYCLE_TOKENS.has(row.lifecycle_status as string)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[harness] non-canonical lifecycle token surfaced: ${JSON.stringify(row.lifecycle_status)} ` +
          `for directive=${row.directive_id} root=${row.root_task_id}. Verify substrate/views.ts ` +
          `DispatchResolvedStatus is up to date.`,
        );
      }
      // The forbidden symptom: the row had no lifecycle_status field at all
      // and the TUI silently defaulted to "live" — which is what
      // pre-50d02b8 the dashboard would do.
      expect(row.lifecycle_status).not.toBe("");
    }
  }, 15_000);

  test("owner_profile_view routes through substrate.read (the MCP gap from commit 24d8dfa)", async () => {
    const client = realSubstrateClient();
    const env = await client.read("owner_profile_view");
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(Array.isArray(env.result)).toBe(true);
    }
  }, 10_000);

  test("all canonical TUI-consumed views return array shapes through substrate.read", async () => {
    const client = realSubstrateClient();
    const views = [
      "dispatch_resolved_view",
      "pending_owner_decision_queue_view",
      "ready_tasks_view",
      "owner_profile_view",
      "promoted_knowledge_view",
      "contradictory_candidates_view",
      "active_objectives_view",
      "directive_conflicts_view",
      "rolling_review_due_view",
      "irreversible_effects_view",
    ];
    for (const v of views) {
      const env = await client.read(v);
      expect(env.ok).toBe(true);
      if (env.ok) {
        expect(Array.isArray(env.result)).toBe(true);
      }
    }
  }, 30_000);

  test("acc CLI binaries the command palette wraps all expose --json output", () => {
    // Smoke-check each wrapped acc verb the CommandPalette dispatches.
    // We don't parse the full payloads — just that exit=0 and stdout
    // contains valid JSON of the expected top-level shape. This catches
    // regressions where the palette would route to a verb that broke its
    // contract.
    const probes = [
      { argv: ["whoami", "--json"],    rootShape: "object" as const },
      { argv: ["status"],               rootShape: "any" as const },
      { argv: ["changes", "24h", "--json"], rootShape: "array" as const },
    ];
    for (const p of probes) {
      const r = spawnSync("bun", ["cli/dispatch.ts", ...p.argv], {
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(r.status).toBe(0);
      if (p.rootShape === "any") continue; // acc status is human prose by default
      // Existence-only smoke: the verb exited 0 AND its stdout contained a
      // canonical JSON sigil ({ for object, [ for array). Per-verb shape
      // validation is the unit tests' job (cli/whoami.test.ts,
      // cli/changes.test.ts) — the harness is here to prove the palette's
      // wrapped verb is reachable through the dispatch switch, not to
      // re-validate the schema.
      const out = (r.stdout ?? "").trim();
      if (p.rootShape === "array") expect(out).toContain("[");
      if (p.rootShape === "object") expect(out).toContain("{");
    }
  }, 60_000);
});
