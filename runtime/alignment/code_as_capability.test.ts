// Phase Align — Principle 4: code-as-capability
//
// Architecture.md, §6, §11: every action is a code artifact resolved from
// the artifact_store and executed inside a per-runtime sandbox. There is no
// "hardcoded helper" path that bypasses artifact lookup or permission args.
//
// Asserts:
//   1. The dispatcher invokes only via `getArtifact` + runtime modules.
//   2. The only `Bun.spawn` calls outside `runtime/runtimes/*` live in
//      `runtime/bridge.ts` (the opencode subprocess) and are commented as
//      intentional.
//   3. `action_predicted` events carry artifact_id columns that resolve
//      cleanly through `getArtifact`.

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { admitArtifact } from "../artifact_admission";
import { getArtifact } from "../artifact_store";
import { emitEvent } from "../events";
import { newId } from "../ids";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

afterAll(() => closeDb());

const collectTsFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (p: string): void => {
    let entries: string[] = [];
    try { entries = readdirSync(p); } catch { return; }
    for (const name of entries) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(p, name);
      let s;
      try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) { walk(full); continue; }
      if (!s.isFile()) continue;
      if (!name.endsWith(".ts")) continue;
      if (name.endsWith(".test.ts")) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
};

describe("alignment / code_as_capability (Principle 4)", () => {
  test("Bun.spawn outside runtime modules is restricted to bridge subprocess code", () => {
    const root = join(import.meta.dir, "..", "..", "runtime");
    const files = collectTsFiles(root);
    // Acceptable callers: runtime/runtimes/*.ts (the legitimate runtime
    // executors) and runtime/bridge/opencode.ts (the opencode subprocess
    // wrangler after the bridge.ts module split). Anything else bypassing
    // artifact resolution is a substrate violation.
    const offenders: string[] = [];
    for (const f of files) {
      if (f.includes("/runtime/runtimes/")) continue;
      if (f.endsWith("/runtime/bridge/opencode.ts")) continue;
      // bridge/types.ts only references Bun.spawn as a TYPE (`typeof
      // Bun.spawn`) for the SpawnOpts injection seam — no invocation site.
      if (f.endsWith("/runtime/bridge/types.ts")) continue;
      if (f.endsWith("/runtime/sandbox.ts")) continue; // sandbox.ts only mentions Bun.spawn in JSDoc comments
      // brain_invocation_worker.ts is the substrate-side equivalent of
      // `acc task` CLI — substrate-internal dispatch wrangler that
      // spawns the same opencode subprocess as the CLI path. Per the
      // 2026-05-20 brain HCWM88JN0H6N amendment GMZ08ASMTD7W: any
      // substrate component can request brain design via this primitive
      // rather than the CLI being the only entry. The spawn is the
      // canonical brain-dispatch fork, classified as bridge subprocess
      // code by intent.
      if (f.endsWith("/runtime/brain_invocation_worker.ts")) continue;
      const text = readFileSync(f, "utf-8");
      // Strip line comments so the JSDoc references in module docstrings
      // don't false-positive.
      const stripped = text.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      if (/\bBun\.spawn\b/.test(stripped)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test("every action_predicted resolves to a real act_artifact row", async () => {
    closeDb();
    const db = openDb(":memory:");
    // Admit one real action + verifier artifact pair (the Phase D fixture
    // shape — minimal but exercises the admission pipeline).
    const directiveId = newId();
    const taskId = newId();
    const sandbox = {
      runtime: "bun" as const,
      fs_read: ["**/*"],
      fs_write: [],
      net_allow: [],
      proc_allow: [],
      substrate_access: "none" as const,
      cpu_ms: 5000,
      wall_ms: 5000,
      memory_mb: 128,
    };
    const action = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: `process.stdout.write("@@RESULT@@ " + JSON.stringify({ result: { ok: true } }) + "\\n");`,
        declaredSandbox: sandbox,
        fixtureInput: {},
        fixtureExpectedResidualBelow: 1.1,
        name: "alignment_action",
      },
      (ev) => emitEvent(db, { ...ev, directive_id: directiveId, task_id: taskId, invoker: "opencode" }),
    );
    const verifier = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: `process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual: 0 }) + "\\n");`,
        declaredSandbox: sandbox,
        fixtureInput: {},
        fixtureExpectedResidualBelow: 1.1,
        name: "alignment_verifier",
      },
      (ev) => emitEvent(db, { ...ev, directive_id: directiveId, task_id: taskId, invoker: "opencode" }),
    );
    expect(action.ok).toBe(true);
    expect(verifier.ok).toBe(true);
    if (!action.ok || !verifier.ok) return;

    emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: action.artifactId,
      verifier_artifact_id: verifier.artifactId,
      predicted_residual: 0.05,
      payload: {},
    });

    const rows = db
      .query(
        `SELECT action_artifact_id, verifier_artifact_id FROM events
         WHERE kind = 'action_predicted' AND task_id = ?`,
      )
      .all(taskId) as Array<{ action_artifact_id: string | null; verifier_artifact_id: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // Both ids must be present AND resolvable through the artifact_store.
      expect(r.action_artifact_id).not.toBeNull();
      expect(r.verifier_artifact_id).not.toBeNull();
      const a = getArtifact(db, r.action_artifact_id!);
      const v = getArtifact(db, r.verifier_artifact_id!);
      expect(a).not.toBeNull();
      expect(v).not.toBeNull();
    }
  });
});
