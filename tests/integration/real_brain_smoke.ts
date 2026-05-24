#!/usr/bin/env bun
// acc2 real-opencode smoke — Batch 2.α gate.
//
// Boots a fresh daemon on free ports in a temp state directory, opens a
// non-trivial directive (fetch example.com, extract the HTML <title>), runs
// a scheduler tick with `ACC2_BRIDGE_MODE=real` so the brain dispatch routes
// through the actual `opencode run` subprocess, and asserts the full
// scenario-format event chain landed (action_predicted → artifact_invoked →
// artifact_observed → action_scored → task_committed when residual<0.3).
//
// Run:
//   cd /home/maxbaluev/bos2/system/acc2 && bun tests/integration/real_brain_smoke.ts
//
// Flags:
//   --print-prompt   Print the composed brain prompt before dispatching.
//   --mock-bridge    Run against ACC2_BRIDGE_MODE=mock (success criterion
//                    becomes "scenario chain green" — the mock emits the
//                    canonical example.com events; this is the CI lane).
//
// This is an executable, not a `bun test` test. The shape test under
// tests/real-brain-smoke-shape.test.ts imports `runRealBrainSmoke` with
// --mock-bridge so CI can prove the module compiles + assertions structure
// is sound.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeDb } from "../../substrate/db";
import {
  bootDaemon,
} from "./scenarios";
import type { DaemonHandle } from "../../runtime/daemon";
import { stopDaemon } from "../../runtime/daemon";
import { emitEvent } from "../../runtime/events";
import { newId } from "../../runtime/ids";
import { composePrompt } from "../../runtime/prompt_composer";
import { schedulerTick, drainInFlightDispatches } from "../../runtime/task_scheduler";
import { seedFoundationalKnowledge, seedActArtifacts } from "../../substrate/seed";
import { getArtifact } from "../../runtime/artifact_store";
import type { JsonValue } from "../../substrate/types";

// ── Smoke-mode env hook ───────────────────────────────────────────

export type SmokeOpts = {
  printPrompt?: boolean;
  /** mock-bridge mode — runs the same example.com directive against
   *  ACC2_BRIDGE_MODE=mock so CI can validate plumbing without opencode on PATH. */
  mockBridge?: boolean;
  /** Optional override for the bridge model (passed through to opencode). */
  model?: string;
  /** Optional dispatch timeout (ms). Real opencode runs can take a minute or
   *  more on first cold boot; default 600s. */
  dispatchTimeoutMs?: number;
};

// ── Step-result harness format ────────────────────────────────────

type StepResult = {
  label: string;
  status: "pass" | "fail";
  elapsedMs: number;
  detail?: string;
  error?: Error;
};

const PAD = 50;
const formatLabel = (s: string): string => {
  if (s.length >= PAD) return s;
  return s + " " + ".".repeat(Math.max(0, PAD - s.length - 1));
};
const fmtSec = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

// ── Pre-flight checks ─────────────────────────────────────────────

type PreflightOutcome = {
  ok: boolean;
  failure?: string;
  remediation?: string;
};

const which = (cmd: string): string | null => {
  try {
    const r = Bun.spawnSync(["which", cmd], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return null;
    const out = (r.stdout?.toString() ?? "").trim();
    return out.length > 0 ? out : null;
  } catch { return null; }
};

const checkBunVersion = (): boolean => {
  try {
    const v = Bun.version;
    const major = Number(v.split(".")[0] ?? "0");
    return Number.isFinite(major) && major >= 1;
  } catch { return false; }
};

const preflight = (opts: SmokeOpts): PreflightOutcome => {
  // OPENAI_API_KEY required even in mock mode? The embedder uses it; the
  // smoke does NOT trigger embedding (it doesn't tick the embedder worker).
  // We still warn if absent so operators see the gap before they run a real
  // dispatch against opencode (opencode auth is separate).
  if (!opts.mockBridge) {
    if (!process.env.OPENAI_API_KEY) {
      return {
        ok: false,
        failure: "OPENAI_API_KEY not set",
        remediation: "Export OPENAI_API_KEY in your shell (or load .env). The brain dispatch itself does not call OpenAI directly, but downstream embedder workers need this key for retrieval.",
      };
    }
    const oc = which("opencode");
    if (!oc) {
      return {
        ok: false,
        failure: "opencode CLI not on PATH",
        remediation: "Install opencode from https://github.com/sst/opencode and authenticate via `opencode auth`. Re-run after `which opencode` returns a path.",
      };
    }
  }
  if (!checkBunVersion()) {
    return {
      ok: false,
      failure: `Bun version ${Bun.version} unsupported`,
      remediation: "Upgrade to Bun >= 1.0.0 (https://bun.sh)",
    };
  }
  const explicit = process.env.ACC2_BRIDGE_MODE;
  const targetMode = opts.mockBridge ? "mock" : "real";
  if (explicit && explicit !== targetMode) {
    process.stdout.write(
      `[warn] ACC2_BRIDGE_MODE=${explicit} in env; the smoke will override to ${targetMode}\n`,
    );
  }
  return { ok: true };
};

// ── Directive text ────────────────────────────────────────────────

const REAL_DIRECTIVE_TEXT = [
  "Fetch the URL https://example.com via Bun.fetch (the bun runtime).",
  "Parse the HTML response and extract the contents of the <title> tag.",
  "Return the observation as JSON in the shape { result: { title: string } }.",
  "Author TWO bun code artifacts:",
  "  1. ACTION artifact: a bun script using `Bun.fetch(\"https://example.com\")`",
  "     that prints exactly one line `@@RESULT@@ {\"result\":{\"title\":\"<extracted>\"}}`.",
  "  2. VERIFIER artifact: a bun script that reads the action's observation",
  "     from `process.env.ACC2_INPUTS` (a JSON string) and prints",
  "     `@@RESULT@@ {\"residual\":0}` when result.title is a non-empty string,",
  "     `@@RESULT@@ {\"residual\":1}` otherwise.",
  "Admit both via substrate.admit_artifact and emit ONE action_predicted event",
  "that cites both artifact ids. This is a single-cycle dispatch — emit a",
  "refinement edge instead of self-iterating if anything is incomplete.",
].join("\n");


// ── Per-step assertions ───────────────────────────────────────────

const eventsByKindForDirective = (
  db: Database,
  kind: string,
  directiveId: string,
): Array<Record<string, unknown>> => {
  return db
    .query("SELECT * FROM events WHERE kind = ? AND directive_id = ? ORDER BY ts ASC")
    .all(kind, directiveId) as Array<Record<string, unknown>>;
};

const recordStep = (
  results: StepResult[],
  label: string,
  startMs: number,
  body: () => string | undefined,
): void => {
  const elapsedMs = Date.now() - startMs;
  try {
    const detail = body();
    results.push({ label, status: "pass", elapsedMs, detail });
    process.stdout.write(
      `${formatLabel(label)} PASS (${fmtSec(elapsedMs)})${detail ? `  ${detail}` : ""}\n`,
    );
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    results.push({ label, status: "fail", elapsedMs, error: e });
    process.stdout.write(`${formatLabel(label)} FAIL (${fmtSec(elapsedMs)})\n`);
    process.stdout.write(`        ${e.message}\n`);
  }
};

// ── Failure-mode classification ────────────────────────────────────

type FailureMode =
  | "auth_missing"
  | "rate_limit"
  | "timeout"
  | "parse_error"
  | "subprocess_crash"
  | "cycle_1_only_breach"
  | "verifier_residual_high"
  | "no_action_predicted"
  | "unknown";

const classifyBridgeFailure = (
  db: Database,
  directiveId: string,
): { mode: FailureMode; detail: string } | null => {
  const failed = db
    .query(
      "SELECT payload FROM events WHERE kind = 'bridge_failed' AND directive_id = ? ORDER BY ts DESC LIMIT 1",
    )
    .get(directiveId) as { payload: string } | null;
  if (failed) {
    const p = JSON.parse(failed.payload ?? "{}") as Record<string, unknown>;
    const reason = (p.reason as string) ?? "unknown";
    if (reason.startsWith("cycle_violation")) {
      return { mode: "cycle_1_only_breach", detail: reason };
    }
    if (reason === "timeout") return { mode: "timeout", detail: `ms_elapsed=${p.ms_elapsed ?? "?"}` };
    if (reason === "subprocess_crash") {
      return { mode: "subprocess_crash", detail: String(p.stderr_tail ?? "").slice(-200) };
    }
    if (reason.includes("auth")) return { mode: "auth_missing", detail: reason };
    if (reason.includes("rate")) return { mode: "rate_limit", detail: reason };
    if (reason.includes("parse")) return { mode: "parse_error", detail: reason };
    return { mode: "unknown", detail: reason };
  }
  return null;
};

// ── Main entrypoint ───────────────────────────────────────────────

export const runRealBrainSmoke = async (opts: SmokeOpts = {}): Promise<number> => {
  const t0 = Date.now();
  const targetMode = opts.mockBridge ? "mock" : "real";

  process.stdout.write("acc2 real-opencode smoke — Batch 2.α\n");
  process.stdout.write("========================================\n");
  process.stdout.write(`mode: ${targetMode}${opts.printPrompt ? " (print-prompt)" : ""}\n\n`);

  // 1. Pre-flight
  const pre = preflight(opts);
  if (!pre.ok) {
    process.stdout.write(`preflight: FAIL — ${pre.failure}\n`);
    if (pre.remediation) process.stdout.write(`            ${pre.remediation}\n`);
    return 1;
  }
  process.stdout.write("preflight: PASS\n");

  // Pin the bridge mode for the dispatch.
  const originalMode = process.env.ACC2_BRIDGE_MODE;
  process.env.ACC2_BRIDGE_MODE = targetMode;
  if (opts.model) process.env.ACC2_OPENCODE_MODEL = opts.model;

  // 2. Boot daemon + seed
  const tmpDir = mkdtempSync(join(tmpdir(), "acc2-real-brain-smoke-"));
  const dbPath = join(tmpDir, "state.db");
  let handle: DaemonHandle | null = null;
  const results: StepResult[] = [];

  try {
    const bootStart = Date.now();
    try {
      handle = await bootDaemon(tmpDir, dbPath);
    } catch (err) {
      process.stdout.write(`boot: FAILED — ${(err as Error).message}\n`);
      return 1;
    }
    process.stdout.write(`boot: daemon up on mcp=${handle.port} aux=${handle.auxPort} (${fmtSec(Date.now() - bootStart)})\n`);

    // Expose MCP server URL for the real-bridge env wiring.
    process.env.V2_MCP_SERVER_URL = `http://127.0.0.1:${handle.port}/mcp`;

    // Seed the substrate.
    const seedKnow = seedFoundationalKnowledge(handle.db, { ownerApproved: true });
    const seedArt = seedActArtifacts(handle.db);
    process.stdout.write(
      `seed: knowledge=${seedKnow.imported}, act_artifacts=${seedArt.inserted} (skipped=${seedArt.skipped})\n\n`,
    );

    // 3. Open the directive. Both modes use the same REAL directive: the
    //    mock bridge recognizes the example.com marker and admits matching
    //    action+verifier artifacts; the real bridge dispatches the same
    //    natural-language directive to opencode.
    const directiveText = REAL_DIRECTIVE_TEXT;
    const directiveId = newId();
    const taskId = newId();

    emitEvent(handle.db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: {
        directive_text: directiveText,
        smoke: "real_brain_smoke_batch_2_alpha",
        lifecycle: "finite",
      } as JsonValue,
    });
    emitEvent(handle.db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      parent_task_id: null,
      payload: {
        goal: directiveText,
        lifecycle: "finite",
        urgency: "normal",
        target_path: opts.mockBridge ? tmpDir : undefined,
      } as JsonValue,
    });

    if (opts.printPrompt) {
      const composed = await composePrompt(handle.db, { taskId, budgetTokens: 8000 });
      process.stdout.write("\n--- composed prompt (--print-prompt) ---\n");
      process.stdout.write(composed.text + "\n");
      process.stdout.write(`--- (${composed.sections.length} sections, ${composed.truncated.length} truncated) ---\n\n`);
    }

    // For the mock path, give the fixture an empty target directory so the
    // canned mock+dispatcher can run cleanly. For real mode, no target_path
    // is needed — the brain authors a network-fetching artifact.
    let fixtureTargetPath: string | undefined;
    if (opts.mockBridge) {
      fixtureTargetPath = tmpDir;
      writeFileSync(join(tmpDir, "probe.txt"), "// TODO probe", "utf-8");
    }

    // 4. Run scheduler tick
    process.stdout.write(`dispatch: launching scheduler tick (target mode=${targetMode})…\n`);
    const dispatchStart = Date.now();
    const tick = await schedulerTick(handle.db, {
      directiveId,
      fixtureTargetPath,
      maxConcurrent: 1,
    });
    // schedulerTick returns after launch (parallel-dispatch contract,
    // commit 1826363); drain in-flight before downstream assertions.
    await drainInFlightDispatches();
    const dispatchElapsedMs = Date.now() - dispatchStart;
    process.stdout.write(
      `dispatch: scheduler tick returned dispatched=[${tick.dispatched.join(",")}] in ${fmtSec(dispatchElapsedMs)}\n\n`,
    );

    // 5. Assertions
    recordStep(results, "scheduler dispatched the task", dispatchStart, () => {
      assert(
        tick.dispatched.includes(taskId),
        `scheduler did not dispatch task ${taskId} (dispatched=[${tick.dispatched.join(",")}])`,
      );
      return `task=${taskId}`;
    });

    recordStep(results, "bridge_invoked event", Date.now(), () => {
      const rows = eventsByKindForDirective(handle!.db, "bridge_invoked", directiveId);
      assert(rows.length >= 1, "bridge_invoked must be emitted");
      return `count=${rows.length}`;
    });

    // Real mode: if the bridge failed, classify and bail with an actionable
    // failure mode. We do NOT throw an assertion — we report the failure.
    if (!opts.mockBridge) {
      const failure = classifyBridgeFailure(handle.db, directiveId);
      if (failure) {
        process.stdout.write(`\n[real bridge failure] mode=${failure.mode}\n`);
        process.stdout.write(`                     detail=${failure.detail}\n`);
        process.stdout.write(`                     see docs/real-brain-runbook.md for remediation\n`);
        return 2;
      }
    }

    let actionPayload: Record<string, unknown> | null = null;
    let actionArtifactId: string | null = null;
    let verifierArtifactId: string | null = null;
    recordStep(results, "action_predicted with both artifact ids", Date.now(), () => {
      const rows = eventsByKindForDirective(handle!.db, "action_predicted", directiveId);
      assert(rows.length >= 1, "action_predicted must be emitted by the brain");
      const r = rows[0]!;
      actionArtifactId = (r.action_artifact_id as string) ?? null;
      verifierArtifactId = (r.verifier_artifact_id as string) ?? null;
      assert(typeof actionArtifactId === "string" && actionArtifactId.length > 0, "action_artifact_id must be set");
      assert(typeof verifierArtifactId === "string" && verifierArtifactId.length > 0, "verifier_artifact_id must be set");
      try { actionPayload = JSON.parse((r.payload as string) ?? "{}") as Record<string, unknown>; } catch { /* ignore */ }
      return `action=${actionArtifactId} verifier=${verifierArtifactId}`;
    });

    recordStep(results, "both artifacts resolve via getArtifact", Date.now(), () => {
      assert(actionArtifactId !== null && verifierArtifactId !== null, "ids must have been captured");
      const a = getArtifact(handle!.db, actionArtifactId!);
      const v = getArtifact(handle!.db, verifierArtifactId!);
      assert(a !== null, `action artifact ${actionArtifactId} must resolve`);
      assert(v !== null, `verifier artifact ${verifierArtifactId} must resolve`);
      return `action.runtime=${a!.runtime} verifier.runtime=${v!.runtime}`;
    });

    recordStep(results, "artifact_invoked + artifact_observed", Date.now(), () => {
      const invoked = eventsByKindForDirective(handle!.db, "artifact_invoked", directiveId);
      const observed = eventsByKindForDirective(handle!.db, "artifact_observed", directiveId);
      assert(invoked.length >= 1, "artifact_invoked must be emitted (action runtime)");
      assert(observed.length >= 1, "artifact_observed must be emitted (action runtime)");
      return `invoked=${invoked.length} observed=${observed.length}`;
    });

    let scoredResidual: number | null = null;
    recordStep(results, "action_scored with residual in [0,1]", Date.now(), () => {
      const rows = eventsByKindForDirective(handle!.db, "action_scored", directiveId);
      assert(rows.length >= 1, "action_scored must be emitted");
      const r = rows[0]!;
      const res = r.residual as number;
      assert(Number.isFinite(res) && res >= 0 && res <= 1, `residual must be in [0,1] (got ${res})`);
      scoredResidual = res;
      return `residual=${res.toFixed(3)}`;
    });

    recordStep(results, "no dispatcher_violation events", Date.now(), () => {
      const rows = eventsByKindForDirective(handle!.db, "dispatcher_violation", directiveId);
      assert(rows.length === 0, `unexpected dispatcher_violation events (count=${rows.length})`);
      return "count=0";
    });

    // Residual gate — commit OR refinement edge
    if (scoredResidual !== null && scoredResidual < 0.3) {
      recordStep(results, "task_committed (residual < 0.3)", Date.now(), () => {
        const rows = eventsByKindForDirective(handle!.db, "task_committed", directiveId);
        assert(rows.length >= 1, "task_committed must be emitted when residual<0.3");
        return `count=${rows.length}`;
      });
    } else if (scoredResidual !== null) {
      recordStep(results, "refinement edge (residual >= 0.3)", Date.now(), () => {
        const rows = handle!.db
          .query(
            "SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND directive_id = ?",
          )
          .all(directiveId) as Array<{ payload: string }>;
        const refines = rows
          .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
          .filter((p) => p.kind === "refines");
        assert(refines.length >= 1, "refinement edge must be emitted when residual>=0.3");
        return `refines=${refines.length}`;
      });
    }

    // Title assertion — runs in BOTH modes because mock and real bridge now
    // exercise the same example.com action body.
    //
    // The title lives in the `action_scored` event's `action_result.result.title`
    // (that's the runtime-observed payload the dispatcher captured). The
    // `artifact_observed` rows only carry phase + duration; the actual result
    // envelope is hoisted into action_scored.payload.action_result.
    recordStep(results, "observation result.title is non-empty string", Date.now(), () => {
      const scoredRows = eventsByKindForDirective(handle!.db, "action_scored", directiveId);
      let title: string | null = null;
      for (const r of scoredRows.reverse()) {
        try {
          const p = JSON.parse((r.payload as string) ?? "{}") as Record<string, unknown>;
          const ar = p.action_result as Record<string, unknown> | undefined;
          const result = ar?.result as Record<string, unknown> | undefined;
          if (result && typeof result.title === "string" && result.title.length > 0) {
            title = result.title;
            break;
          }
        } catch { /* skip */ }
      }
      assert(title !== null, `result.title must be a non-empty string (action_scored.payload.action_result.result.title)`);
      return `title="${title}"`;
    });
  } finally {
    if (handle) {
      try { await stopDaemon(handle); } catch { /* swallow */ }
    }
    try { closeDb(); } catch { /* swallow */ }
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalMode === undefined) delete process.env.ACC2_BRIDGE_MODE;
    else process.env.ACC2_BRIDGE_MODE = originalMode;
  }

  // Summary
  const elapsedTotal = Date.now() - t0;
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.length - passed;
  process.stdout.write("\n========================================\n");
  if (failed === 0) {
    process.stdout.write(
      `${passed}/${results.length} steps passed in ${fmtSec(elapsedTotal)}\n`,
    );
    if (opts.mockBridge) {
      process.stdout.write("[ok] mock-bridge plumbing green — scenario chain sound\n");
    } else {
      process.stdout.write("[ok] real opencode dispatch solved the directive end-to-end\n");
    }
    return 0;
  }
  process.stdout.write(
    `${passed}/${results.length} passed — ${failed} failure${failed > 1 ? "s" : ""}\n`,
  );
  return 1;
};

// ── CLI entrypoint ────────────────────────────────────────────────

const parseArgs = (argv: string[]): SmokeOpts => {
  const opts: SmokeOpts = {};
  for (const a of argv) {
    if (a === "--print-prompt") opts.printPrompt = true;
    else if (a === "--mock-bridge") opts.mockBridge = true;
    else if (a.startsWith("--model=")) opts.model = a.slice("--model=".length);
    else if (a.startsWith("--timeout=")) opts.dispatchTimeoutMs = Number(a.slice("--timeout=".length));
  }
  return opts;
};

if (import.meta.main) {
  void (async () => {
    const opts = parseArgs(process.argv.slice(2));
    const code = await runRealBrainSmoke(opts);
    process.exit(code);
  })();
}
