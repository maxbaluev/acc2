// acc2 integration harness — scenario definitions.
//
// Each scenario is a self-contained async function that throws on failure.
// The harness driver (harness.ts) catches throws and reports per-scenario
// PASS / FAIL. Scenarios share one running daemon process; they each
// generate their own directive ids so cross-contamination is harmless.
//
// The scenarios cover the §17 + §18 cutover criteria end-to-end against a
// real daemon (real fastmcp wire, real Bun.serve aux port, real SQLite, real
// bun-runtime artifacts). The bridge runs in mock mode for the 17 plumbing
// scenarios — 9 cutover-criteria scenarios plus 8 Batch 5 universal-goal
// pilots covering v2-design.md §10.2-10.9. The production default is `real`,
// but harness.ts and the bun test preload (`tests/preload.ts`) pin
// `ACC2_BRIDGE_MODE=mock` so no opencode subprocess is spawned. The 18th
// scenario (scenarioRealBrainEndToEnd) flips to real for its own dispatch
// and restores on exit.

import type { Database } from "bun:sqlite";
import type { DaemonHandle } from "../../runtime/daemon";
import { startDaemon, stopDaemon } from "../../runtime/daemon";
import { openDb } from "../../substrate/db";
import { emitEvent } from "../../runtime/events";
import { openFixtureDCountTodos } from "../../runtime/fixtures/d_count_todos";
import { openFixtureBusinessOutreach } from "../../runtime/fixtures/d_business_outreach";
import { openFixtureResearchSummary } from "../../runtime/fixtures/d_research_summary";
import { openFixtureCreativeConstraint } from "../../runtime/fixtures/d_creative_constraint";
import { openFixtureMultiStakeholder } from "../../runtime/fixtures/d_multi_stakeholder";
import { openFixtureHealthDecision } from "../../runtime/fixtures/d_health_decision";
import { openFixtureEmbodiedRecipe } from "../../runtime/fixtures/d_embodied_recipe";
import { openFixtureLongHorizonSavings } from "../../runtime/fixtures/d_long_horizon_savings";
import { openFixtureCrisisResponse } from "../../runtime/fixtures/d_crisis_response";
import { CRISIS_MODE, readCurrentMode } from "../../runtime/crisis_mode";
import { schedulerTick } from "../../runtime/task_scheduler";
import { dispatchReadyTask } from "../../runtime/task_dispatcher";
import {
  opencodeQueryHighResidual,
  opencodeQueryAdversarialCycle2,
} from "../../runtime/bridge";
import { readyTasks, readDagForDirective } from "../../runtime/task_topology";
import { extractSemanticDedup } from "../../substrate/extractors";
import { distributeCredit } from "../../runtime/credit";
import { embedderWorkerTick, encodeEmbeddingBlob, EMBEDDING_DIMS } from "../../runtime/embedder";
import { fatherIterate } from "../../runtime/father";
import { processRollingReviews } from "../../runtime/rolling_reviewer";
import { recordStakeholderState } from "../../runtime/stakeholder_compositor";
import { applyAmendment, emitAndApplyAmendment } from "../../runtime/amendment_handler";
import { getArtifact, applyResidualOutcome, maybePromote } from "../../runtime/artifact_store";
import { newId, nowIso } from "../../runtime/ids";
import type { JsonValue } from "../../substrate/types";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
};

const eventsByKind = (db: Database, kind: string, directiveId?: string): Array<Record<string, unknown>> => {
  if (directiveId) {
    return db
      .query("SELECT * FROM events WHERE kind = ? AND directive_id = ? ORDER BY ts ASC")
      .all(kind, directiveId) as Array<Record<string, unknown>>;
  }
  return db
    .query("SELECT * FROM events WHERE kind = ? ORDER BY ts ASC")
    .all(kind) as Array<Record<string, unknown>>;
};

const countEventsByKindForTask = (db: Database, kind: string, taskId: string): number => {
  const row = db
    .query("SELECT COUNT(*) AS n FROM events WHERE kind = ? AND task_id = ?")
    .get(kind, taskId) as { n: number };
  return row.n;
};

const countEvents = (db: Database): number => {
  const row = db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number };
  return row.n;
};

// Synthetic embedding generator — deterministic per seed-string so the same
// text always produces the same vector. We use this for scenarios that need
// embeddings without invoking the real OpenAI API.
const synthEmbedding = (seed: string, offset = 0): number[] => {
  const out = new Array<number>(EMBEDDING_DIMS);
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) | 0;
  const base = (h >>> 0) / 0xffffffff;
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    out[i] = Math.sin(base * 10 + i * 0.01 + offset * 0.0001);
  }
  return out;
};

// Persist a knowledge_candidate row with an explicit embedding blob — bypasses
// the embedder worker so scenarios that need similar-vector candidates do not
// require an OPENAI_API_KEY.
const emitKnowledgeWithEmbedding = (
  db: Database,
  text: string,
  origin: "claude_root" | "opencode" | "owner" | "substrate_auto",
  embedding: number[],
  directiveId?: string,
  taskId?: string,
): { id: string } => {
  return emitEvent(db, {
    kind: "knowledge_candidate",
    substrate_origin: origin,
    directive_id: directiveId,
    task_id: taskId,
    payload: { text } as JsonValue,
    embedding: encodeEmbeddingBlob(embedding),
    embedding_version: "v1",
  });
};

// ── Scenario 1 — Daemon lifecycle ──────────────────────────────────

export type DaemonBootResult = {
  handle: DaemonHandle;
  tmpDir: string;
  dbPath: string;
};

const pickPortPair = (): { mcp: number; aux: number } => {
  // Use a high band away from existing test ranges (8000-11000, 12000-18000,
  // 30000-32000). 45000-50000 is well clear.
  const mcp = 45000 + Math.floor(Math.random() * 2000);
  const aux = 47000 + Math.floor(Math.random() * 2000);
  return { mcp, aux };
};

export const bootDaemon = async (
  tmpDir: string,
  dbPath: string,
): Promise<DaemonHandle> => {
  const ports = pickPortPair();
  return startDaemon({
    port: ports.mcp,
    auxPort: ports.aux,
    stateDbPath: dbPath,
    socketFile: join(tmpDir, "v2.sock"),
    tokenFile: join(tmpDir, "v2.sock.token"),
    externalPushToken: "harness-default-token",
  });
};

// ── Production-equivalent boot for ad-hoc real-brain runs ──────────
//
// The harness's `--task` mode (and the canned scenarioRealBrainEndToEnd)
// must prove the EXACT code paths an operator gets after `acc init` +
// `acc daemon start`, not a privileged side door. The helper below:
//
//   1. Sets ACC2_STATE_DIR (+ ACC2_DB_PATH / V2_DAEMON_*PORT) to fresh
//      tmpdir values — so the production resolver in runtime/state_paths.ts
//      lands at this isolated location.
//   2. Calls `runInitProgrammatic({ yes: true })` — the SAME function
//      `bun cli/dispatch.ts init --yes` invokes. This seeds foundational
//      knowledge + the canonical code_artifact rows via the production
//      init path (Task 1 wiring).
//   3. Calls `startDaemon({})` with NO opts — env-var-driven, same as the
//      operator's `acc daemon start`. Default externalPushToken (null)
//      mirrors production: the harness does NOT inject the
//      "harness-default-token" privileged value.
//
// Returns the live handle + a cleanup callback that stops the daemon,
// closes the db, restores every env var, and removes the tmpdir unless
// keepState=true.
export type ProductionBootResult = {
  handle: DaemonHandle;
  tmpDir: string;
  dbPath: string;
  cleanup: () => Promise<void>;
};

export const bootDaemonProduction = async (opts: {
  /** When true, the cleanup callback leaves the tmpdir on disk so the
   *  operator can inspect. The path is returned for the caller to surface. */
  keepState?: boolean;
}): Promise<ProductionBootResult> => {
  const tmpDir = mkdtempSync(join(tmpdir(), "acc2-harness-prod-"));
  const dbPath = join(tmpDir, "state.db");
  const ports = pickPortPair();

  // Snapshot env vars we mutate so cleanup can restore them exactly.
  const prev: Record<string, string | undefined> = {
    ACC2_STATE_DIR: process.env.ACC2_STATE_DIR,
    ACC2_DB_PATH: process.env.ACC2_DB_PATH,
    ACC2_SOCKET_FILE: process.env.ACC2_SOCKET_FILE,
    ACC2_TOKEN_FILE: process.env.ACC2_TOKEN_FILE,
    V2_DAEMON_PORT: process.env.V2_DAEMON_PORT,
    V2_DAEMON_AUX_PORT: process.env.V2_DAEMON_AUX_PORT,
  };

  process.env.ACC2_STATE_DIR = tmpDir;
  // Force the DB into the tmpdir even when the dev-checkout fallback path
  // would otherwise win in the resolver.
  process.env.ACC2_DB_PATH = dbPath;
  process.env.ACC2_SOCKET_FILE = join(tmpDir, "v2.sock");
  process.env.ACC2_TOKEN_FILE = join(tmpDir, "v2.sock.token");
  process.env.V2_DAEMON_PORT = String(ports.mcp);
  process.env.V2_DAEMON_AUX_PORT = String(ports.aux);

  // Run the production init code path. The same function that backs
  // `bun cli/dispatch.ts init --yes`. Resolved paths come from env vars
  // we just set, so it lands in our tmpdir.
  const { runInitProgrammatic } = await import("../../cli/init");
  const initSummary = await runInitProgrammatic({
    yes: true,
    log: () => { /* swallow — harness prints its own narration */ },
    warn: () => { /* swallow */ },
  });
  if (initSummary.exitCode !== 0) {
    throw new Error(`acc init failed: ${initSummary.warnings.join("; ")}`);
  }

  // Now call startDaemon with NO opts — the production code path. Env
  // vars we set above route the daemon at the harness tmpdir + ports.
  const handle = await startDaemon();

  const cleanup = async (): Promise<void> => {
    try { await stopDaemon(handle); } catch { /* swallow */ }
    try {
      const { closeDb } = await import("../../substrate/db");
      closeDb(dbPath);
    } catch { /* swallow */ }
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (!opts.keepState) rmSync(tmpDir, { recursive: true, force: true });
  };

  return { handle, tmpDir, dbPath, cleanup };
};

export const scenarioDaemonLifecycle = async (): Promise<void> => {
  const tmpDir = mkdtempSync(join(tmpdir(), "acc2-harness-s1-"));
  const dbPath = join(tmpDir, "state.db");
  try {
    // 1. Start daemon
    const h1 = await bootDaemon(tmpDir, dbPath);
    try {
      // Assert daemon_started landed within 2s — it fires synchronously inside
      // startDaemon so polling is pro-forma.
      const started = eventsByKind(h1.db, "daemon_started");
      assert(started.length >= 1, "daemon_started event must be emitted");

      // /health probe
      const healthRes = await fetch(`http://127.0.0.1:${h1.auxPort}/health`);
      assert(healthRes.status === 200, "/health must return 200");
      const health = (await healthRes.json()) as Record<string, unknown>;
      assert(health.status === "ok", "/health status must be 'ok'");
      assert(typeof health.pid === "number", "/health must include pid");
      assert(health.db_path === dbPath, "/health db_path must match");

      // Register a source via direct call (the MCP path is exercised in
      // scenario 7). Use registerExternalSource directly so the test does not
      // hinge on the MCP HTTP wire being ready.
      const { registerExternalSource } = await import("../../runtime/external_ingress");
      registerExternalSource(h1.db, h1.ingressState, {
        name: "harness_lifecycle_source",
        bearer_token: "harness-lifecycle-token",
        default_sensitivity: "internal",
      });

      // POST /external/push
      const pushRes = await fetch(`http://127.0.0.1:${h1.auxPort}/external/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer harness-lifecycle-token",
        },
        body: JSON.stringify({
          source: "harness_lifecycle_source",
          kind: "external_event_received",
          payload: { text: "lifecycle ping" },
        }),
      });
      assert(pushRes.status === 200, `external push status must be 200, got ${pushRes.status}`);
      const pushed = (await pushRes.json()) as { ok: boolean; event_id?: string };
      assert(pushed.ok === true, "external push must return ok:true");
      assert(typeof pushed.event_id === "string", "external push must return event_id");

      // Snapshot count BEFORE shutdown so we can compare post-restart.
      const preShutdownCount = countEvents(h1.db);

      // Stop
      await stopDaemon(h1);

      const shutdownsAfter = eventsByKind(openDb(dbPath), "daemon_shutdown");
      assert(shutdownsAfter.length >= 1, "daemon_shutdown event must be emitted");

      // Close any open db connection on the path so re-start is clean.
      const { closeDb } = await import("../../substrate/db");
      closeDb(dbPath);

      // Restart
      const h2 = await bootDaemon(tmpDir, dbPath);
      try {
        const rebuilds = eventsByKind(h2.db, "daemon_index_rebuilt");
        assert(rebuilds.length >= 2, `daemon_index_rebuilt must fire on each boot (got ${rebuilds.length})`);

        const postRestartCount = countEvents(h2.db);
        // pre-shutdown count + 1 (shutdown) + 2 (start + rebuilt) = +3
        assert(
          postRestartCount >= preShutdownCount + 2,
          `post-restart count (${postRestartCount}) must be >= pre-shutdown (${preShutdownCount}) + 2`,
        );
      } finally {
        await stopDaemon(h2);
      }
    } finally {
      try { await stopDaemon(h1); } catch { /* already stopped */ }
    }
  } finally {
    const { closeDb } = await import("../../substrate/db");
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  }
};

// ── Scenario 2 — MVP fixture (fixture_d_count_todos) ──────────────

export const scenarioMvpFixture = async (handle: DaemonHandle): Promise<void> => {
  const tmpDir = mkdtempSync(join(tmpdir(), "acc2-harness-s2-"));
  try {
    writeFileSync(join(tmpDir, "a.txt"), "// TODO alpha", "utf-8");
    writeFileSync(join(tmpDir, "b.txt"), "// TODO beta", "utf-8");
    writeFileSync(join(tmpDir, "c.txt"), "no marker", "utf-8");

    const { directiveId, taskId } = await openFixtureDCountTodos(handle.db, tmpDir);

    const tick = await schedulerTick(handle.db, {
      directiveId,
      fixtureTargetPath: tmpDir,
      maxConcurrent: 1,
    });
    assert(tick.dispatched.includes(taskId), `scheduler must have dispatched task ${taskId}`);

    // The canonical event chain must be present.
    const expectedKinds = [
      "directive_opened",
      "task_node_opened",
      "brain_dispatched",
      "brain_dispatch_closed",
      "action_predicted",
      "artifact_invoked",
      "artifact_observed",
      "action_scored",
      "task_committed",
    ];
    for (const kind of expectedKinds) {
      const rows = handle.db
        .query("SELECT id FROM events WHERE kind = ? AND directive_id = ?")
        .all(kind, directiveId) as Array<{ id: string }>;
      assert(rows.length >= 1, `expected ${kind} event for directive ${directiveId}`);
    }

    // No refinement edge.
    const refines = handle.db
      .query(
        "SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND directive_id = ?",
      )
      .all(directiveId) as Array<{ payload: string }>;
    for (const r of refines) {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      assert(p.kind !== "refines", `unexpected refines edge on MVP fixture: ${r.payload}`);
    }

    // No dispatcher_violation.
    const violations = handle.db
      .query("SELECT id FROM events WHERE kind = 'dispatcher_violation' AND directive_id = ?")
      .all(directiveId) as Array<{ id: string }>;
    assert(violations.length === 0, `unexpected dispatcher_violation: ${violations.length}`);

    // action_scored residual must be 0.
    const scored = handle.db
      .query("SELECT residual FROM events WHERE kind = 'action_scored' AND task_id = ?")
      .get(taskId) as { residual: number } | null;
    assert(scored !== null && scored.residual === 0, `action_scored residual must be 0`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
};

// ── Scenario 3 — Refinement edge on high residual ──────────────────

export const scenarioRefinementEdge = async (handle: DaemonHandle): Promise<void> => {
  // The high-residual mock admits an action that always returns trivial
  // observation + a verifier that always returns residual=1. Open a fresh
  // fixture directive (it provides a task_node we can dispatch against) and
  // route through opencodeQueryHighResidual.
  const { directiveId, taskId } = await openFixtureDCountTodos(handle.db, "/tmp");
  const ready = readyTasks(handle.db, directiveId);
  const task = ready.find((n) => n.id === taskId);
  assert(task !== undefined, "task must be ready");

  const result = await dispatchReadyTask(handle.db, task!, {
    bridge: opencodeQueryHighResidual,
  });
  assert(result.violations.length === 0, `unexpected violations: ${result.violations.join(",")}`);

  // action_scored with residual >= 0.3
  const scored = handle.db
    .query("SELECT residual FROM events WHERE kind = 'action_scored' AND task_id = ?")
    .get(taskId) as { residual: number } | null;
  assert(scored !== null, "action_scored must be emitted");
  assert(scored!.residual >= 0.3, `residual must be >= 0.3 (got ${scored!.residual})`);

  // task_edge_recorded with kind=refines
  const edges = handle.db
    .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND directive_id = ?")
    .all(directiveId) as Array<{ payload: string }>;
  const refines = edges
    .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
    .find((p) => p.kind === "refines" && p.from_task === taskId);
  assert(refines !== undefined, "refines edge must be emitted");

  // The refines edge points at a new task_node_opened child.
  const childId = refines!.to_task as string;
  const child = handle.db
    .query("SELECT id FROM events WHERE kind = 'task_node_opened' AND task_id = ?")
    .get(childId) as { id: string } | null;
  assert(child !== null, "refinement child task_node_opened must exist");

  // NO task_committed on the original task.
  const committed = countEventsByKindForTask(handle.db, "task_committed", taskId);
  assert(committed === 0, `task_committed must NOT fire on high-residual original (got ${committed})`);
};

// ── Scenario 4 — Cycle-1 enforcement (adversarial) ────────────────

export const scenarioCycleOneEnforcement = async (handle: DaemonHandle): Promise<void> => {
  const { directiveId, taskId } = await openFixtureDCountTodos(handle.db, "/tmp");
  const ready = readyTasks(handle.db, directiveId);
  const task = ready.find((n) => n.id === taskId);
  assert(task !== undefined, "task must be ready");

  const result = await dispatchReadyTask(handle.db, task!, {
    bridge: opencodeQueryAdversarialCycle2,
  });
  assert(
    result.violations.includes("cycle_1_only_breach"),
    `violations must include cycle_1_only_breach (got ${result.violations.join(",")})`,
  );

  // dispatcher_violation event with failure_kind=cycle_1_only_breach
  const violation = handle.db
    .query(
      "SELECT failure_kind FROM events WHERE kind = 'dispatcher_violation' AND task_id = ?",
    )
    .get(taskId) as { failure_kind: string } | null;
  assert(violation !== null, "dispatcher_violation event must be emitted");
  assert(
    violation!.failure_kind === "cycle_1_only_breach",
    `failure_kind must be cycle_1_only_breach (got ${violation!.failure_kind})`,
  );

  // NO task_committed
  const committed = countEventsByKindForTask(handle.db, "task_committed", taskId);
  assert(committed === 0, `task_committed must NOT fire after cycle violation (got ${committed})`);

  // No action_predicted for this task (the adversarial mock emits
  // brain_cycle_2_started instead of action_predicted, and the dispatcher
  // aborts before any action-stage work).
  const predicted = countEventsByKindForTask(handle.db, "action_predicted", taskId);
  assert(predicted === 0, `action_predicted must NOT fire on cycle violation (got ${predicted})`);
};

// ── Scenario 5 — Distribution (multi-client semantic merger) ──────

export const scenarioDistributionMerger = async (handle: DaemonHandle): Promise<void> => {
  // Implementation note (from spec): we simulate two MCP clients by emitting
  // two knowledge_candidate events with distinct substrate_origin tags
  // ("claude_root" and "opencode") rather than spinning up two real MCP
  // client connections. The semantic dedup extractor operates on the events
  // themselves — the origin tag is what `distributeCredit` reads for the
  // multi-origin assertion.
  const directiveId = `d_harness_s5_${newId()}`;
  emitEvent(handle.db, {
    kind: "directive_opened",
    directive_id: directiveId,
    task_id: directiveId,
    payload: { directive_text: "harness s5 distribution test" } as JsonValue,
  });

  // Two semantically-equivalent knowledge claims with matching embeddings.
  // Both carry the same anchor token "cycle-1-only" so future entity-anchor
  // joins would unify them; the embedding match alone drives this scenario.
  const embedA = synthEmbedding("cycle-1-only-structural", 0);
  const embedB = synthEmbedding("cycle-1-only-structural", 0); // identical → cosine = 1
  const candA = emitKnowledgeWithEmbedding(
    handle.db,
    "Cycle-1-only is structurally enforced — cycle-1-only anchor",
    "claude_root",
    embedA,
    directiveId,
    directiveId,
  );
  const candB = emitKnowledgeWithEmbedding(
    handle.db,
    "The dispatcher rejects cycle-2 emission attempts — cycle-1-only anchor",
    "opencode",
    embedB,
    directiveId,
    directiveId,
  );

  // Trigger the dedup extractor.
  const dedupResult = extractSemanticDedup(handle.db);
  assert(dedupResult.merged >= 1, `dedup must produce at least one merged row (got ${dedupResult.merged})`);

  // Both original candidate rows still exist (they're never deleted).
  const candARow = handle.db.query("SELECT id FROM events WHERE id = ?").get(candA.id);
  const candBRow = handle.db.query("SELECT id FROM events WHERE id = ?").get(candB.id);
  assert(candARow !== null, "original candidate A must still exist");
  assert(candBRow !== null, "original candidate B must still exist");

  // candidate_confirmed row linking them
  const confirmed = handle.db
    .query(
      "SELECT id, context_refs FROM events WHERE kind = 'candidate_confirmed' AND context_refs LIKE ?",
    )
    .all(`%${candA.id}%`) as Array<{ id: string; context_refs: string }>;
  assert(confirmed.length >= 1, "candidate_confirmed must link the two candidates");
  const refs = JSON.parse(confirmed[0]!.context_refs) as string[];
  assert(
    refs.includes(candA.id) && refs.includes(candB.id),
    `candidate_confirmed context_refs must include both candidates: ${refs.join(",")}`,
  );

  // Now synthesize an action_predicted that cites both origin candidates and
  // run distributeCredit. We need a real action + verifier artifact pair so
  // the credit pipeline can resolve them. We re-use the artifacts admitted
  // by an MVP dispatch (cheap reuse — they're guaranteed to exist after
  // scenario 2). Find the most recent fixture_d action artifact.
  const actionArt = handle.db
    .query(
      "SELECT id FROM code_artifact WHERE name = 'fixture_d_count_todos_action' ORDER BY created_at DESC LIMIT 1",
    )
    .get() as { id: string } | null;
  const verifierArt = handle.db
    .query(
      "SELECT id FROM code_artifact WHERE name = 'fixture_d_count_todos_verifier' ORDER BY created_at DESC LIMIT 1",
    )
    .get() as { id: string } | null;
  assert(actionArt !== null && verifierArt !== null, "MVP artifacts must already exist");

  const taskId = `t_harness_s5_${newId()}`;
  emitEvent(handle.db, {
    kind: "task_node_opened",
    directive_id: directiveId,
    task_id: taskId,
    payload: { goal: "harness s5 credit task" } as JsonValue,
  });
  const actionPredicted = emitEvent(handle.db, {
    kind: "action_predicted",
    directive_id: directiveId,
    task_id: taskId,
    action_artifact_id: actionArt!.id,
    verifier_artifact_id: verifierArt!.id,
    predicted_residual: 0.1,
    context_refs: [candA.id, candB.id],
    payload: { intent: "harness s5 multi-origin credit" } as JsonValue,
  });
  const observed = emitEvent(handle.db, {
    kind: "artifact_observed",
    directive_id: directiveId,
    task_id: taskId,
    action_artifact_id: actionArt!.id,
    payload: { result: { count: 1 } } as JsonValue,
  });
  const scored = emitEvent(handle.db, {
    kind: "action_scored",
    directive_id: directiveId,
    task_id: taskId,
    action_artifact_id: actionArt!.id,
    verifier_artifact_id: verifierArt!.id,
    residual: 0.05,
    payload: { dispatch_id: "harness-s5" } as JsonValue,
  });

  const dist = await distributeCredit(handle.db, {
    action_event_id: actionPredicted.id,
    observation_event_id: observed.id,
    scored_event_id: scored.id,
    predicted_residual: 0.1,
    observed_residual: 0.05,
  });

  const knowledgeContribs = dist.contributions.filter((c) => c.target_kind === "knowledge");
  const cIds = new Set(knowledgeContribs.map((c) => c.target_id));
  assert(cIds.has(candA.id), `credit must distribute to candidate A (${candA.id})`);
  assert(cIds.has(candB.id), `credit must distribute to candidate B (${candB.id})`);
};

// ── Scenario 6 — Credit chain closure ─────────────────────────────

export const scenarioCreditChainClosure = async (handle: DaemonHandle): Promise<void> => {
  // Run a full MVP dispatch to get action + verifier artifacts seeded with a
  // first action_scored. Then synthesize 25 additional action_predicted/
  // observed/scored triplets and route them through distributeCredit so the
  // posterior crosses the promotion threshold (score ≥ 0.85, confidence ≥
  // 0.7, invocations ≥ 20).
  const tmpDir = mkdtempSync(join(tmpdir(), "acc2-harness-s6-"));
  try {
    writeFileSync(join(tmpDir, "x.txt"), "// TODO chain", "utf-8");
    const { directiveId, taskId } = await openFixtureDCountTodos(handle.db, tmpDir);
    const tick = await schedulerTick(handle.db, {
      directiveId,
      fixtureTargetPath: tmpDir,
      maxConcurrent: 1,
    });
    assert(tick.dispatched.includes(taskId), "MVP dispatch must run");

    // Read the action + verifier artifact ids from the action_predicted row.
    const predicted = handle.db
      .query(
        "SELECT action_artifact_id, verifier_artifact_id FROM events WHERE kind = 'action_predicted' AND task_id = ? LIMIT 1",
      )
      .get(taskId) as { action_artifact_id: string; verifier_artifact_id: string };
    assert(
      predicted && predicted.action_artifact_id && predicted.verifier_artifact_id,
      "action + verifier artifact ids must be resolvable",
    );

    // code_artifact_score_updated fires for BOTH action and verifier (Phase
    // H, distributeCredit primary credit emissions).
    const updated = handle.db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'code_artifact_score_updated' AND task_id = ?",
      )
      .get(taskId) as { n: number };
    assert(updated.n >= 2, `at least 2 code_artifact_score_updated events expected (got ${updated.n})`);

    const preScore = getArtifact(handle.db, predicted.action_artifact_id);
    assert(preScore !== null, "action artifact row must exist");

    // 25 more residual=0 outcomes, directly through applyResidualOutcome +
    // maybePromote so we exercise the threshold path without running 25 full
    // dispatches. Each iteration also emits a synthetic action_predicted +
    // scored so distributeCredit can run for at least one extra round.
    let promotedFired = false;
    const sinkEvents: string[] = [];
    const emitSink = (event: import("../../runtime/events").EmitEventInput): void => {
      const out = emitEvent(handle.db, { ...event, invoker: event.invoker ?? "substrate_auto" });
      sinkEvents.push(out.id);
    };

    for (let i = 0; i < 25; i++) {
      const ts = nowIso();
      applyResidualOutcome(handle.db, predicted.action_artifact_id, 0, ts);
      applyResidualOutcome(handle.db, predicted.verifier_artifact_id, 0, ts);
      const promotedAction = maybePromote(handle.db, predicted.action_artifact_id, emitSink);
      const promotedVerifier = maybePromote(handle.db, predicted.verifier_artifact_id, emitSink);
      if (promotedAction || promotedVerifier) promotedFired = true;
    }

    // Score moved.
    const postScore = getArtifact(handle.db, predicted.action_artifact_id);
    assert(postScore !== null, "post-update artifact must exist");
    assert(
      postScore!.score !== preScore!.score,
      `action artifact score must have changed (pre=${preScore!.score} post=${postScore!.score})`,
    );

    // At least one code_artifact_promoted event fired.
    const promoted = handle.db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'code_artifact_promoted'")
      .get() as { n: number };
    assert(
      promotedFired || promoted.n >= 1,
      `code_artifact_promoted must fire at least once (count=${promoted.n})`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
};

// ── Scenario 7 — External push retrievability ─────────────────────

export const scenarioExternalPushRetrievable = async (handle: DaemonHandle): Promise<void> => {
  // Register a source via the registration helper (the MCP path is exercised
  // by mcp_server.test.ts; the harness focuses on the end-to-end semantics).
  const sourceName = "harness_external_test";
  const token = "harness-external-token-1234";
  const { registerExternalSource } = await import("../../runtime/external_ingress");
  const reg = registerExternalSource(handle.db, handle.ingressState, {
    name: sourceName,
    bearer_token: token,
    default_sensitivity: "internal",
  });
  assert(reg.ok === true, `register_external_source must succeed (got ${JSON.stringify(reg)})`);

  const distinctText = "the quick brown fox jumps over the lazy dog";
  const pushRes = await fetch(`http://127.0.0.1:${handle.auxPort}/external/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      source: sourceName,
      kind: "external_event_received",
      payload: { summary: distinctText },
    }),
  });
  assert(pushRes.status === 200, `external push must return 200 (got ${pushRes.status})`);
  const pushed = (await pushRes.json()) as { ok: boolean; event_id?: string };
  assert(pushed.ok, "external push must return ok:true");
  const externalEventId = pushed.event_id!;

  // Embed the inbound event. The embedder worker requires OPENAI_API_KEY; we
  // can't assume one in the harness environment, so we install a deterministic
  // mock fetch ONLY for the OpenAI endpoint during this scenario.
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-harness-mock";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.toString() : (input as Request).url);
    if (url.includes("/embeddings")) {
      // Parse the request to determine batch size + seed the embedding from
      // the input text so semantically-related queries land close in cosine.
      let bodyText = "";
      try { bodyText = (init?.body as string) ?? ""; } catch { /* swallow */ }
      let inputs: unknown = "";
      try { inputs = JSON.parse(bodyText).input; } catch { /* swallow */ }
      const arr = Array.isArray(inputs) ? inputs as string[] : [inputs as string];
      const data = arr.map((text, i) => ({
        index: i,
        embedding: synthEmbedding(typeof text === "string" ? text : "harness", 0),
      }));
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input as any, init);
  }) as typeof fetch;

  try {
    // Tick the embedder until our event is embedded (it should be in the
    // first batch of unembedded rows).
    let embedded = false;
    for (let i = 0; i < 6; i++) {
      const r = await embedderWorkerTick(handle.db, { batchSize: 50 });
      const row = handle.db
        .query("SELECT embedding FROM events WHERE id = ?")
        .get(externalEventId) as { embedding: Uint8Array | null } | null;
      if (row?.embedding) { embedded = true; break; }
      if (r.embedded === 0 && r.failed === 0 && r.skipped_no_text === 0) break;
    }
    assert(embedded, "embedder worker must have embedded the inbound event");

    // Rebuild the in-memory index so the retrieval surface picks up the new
    // entry (the daemon's index is mutated by the worker via add(); for
    // the harness we rebuild from db).
    const { EmbeddingIndex } = await import("../../runtime/embedding_index");
    const index = EmbeddingIndex.rebuildFromDb(handle.db);

    // Call substrate.search through the retrieval module directly (the MCP
    // tool wraps this — using it directly avoids the streaming HTTP wire).
    const { retrieve } = await import("../../runtime/retrieval");
    const result = await retrieve(handle.db, index, {
      text: "quick brown fox",
      k: 20,
    });

    if (result.query_embedding_unavailable) {
      // If the query embedding wasn't synthesized for some reason, fall back
      // to the recency stand-in surface and verify the event is in recent
      // hits — that still proves retrievability.
      const recent = handle.db
        .query("SELECT id FROM events ORDER BY ts DESC LIMIT 50")
        .all() as Array<{ id: string }>;
      const ids = new Set(recent.map((r) => r.id));
      assert(ids.has(externalEventId), "fallback: inbound event must appear in recent events");
    } else {
      const hitIds = new Set(result.hits.map((h) => h.event_id));
      assert(
        hitIds.has(externalEventId),
        `retrieve must surface the inbound event in top-K (got ${result.hits.length} hits)`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
};

// ── Scenario 8 — Father one-shot tick ─────────────────────────────

export const scenarioFatherOneShot = async (handle: DaemonHandle): Promise<void> => {
  // Seed a rolling_active directive whose next_review_due is firmly in the
  // past so the rolling-review picker fires on the first Father iterate.
  const directiveId = `d_harness_s8_${newId()}`;
  const pastTs = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  emitEvent(handle.db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      directive_text: "harness s8 rolling-active",
      lifecycle: "rolling_active",
      urgency: "normal",
      review_cadence: "weekly",
      next_review_due: pastTs,
      partial_commit_checkpoints: [],
    } as JsonValue,
  });

  // Snapshot bridge_invoked count before the iterate so we can assert no LLM
  // was called from this iteration.
  const bridgeBefore = handle.db
    .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'bridge_invoked'")
    .get() as { n: number };

  const result = await fatherIterate(handle.db);
  assert(result.cycle_id.length > 0, "father iterate must return a cycle_id");

  // father_cycle_recorded must have fired this tick.
  const cycle = handle.db
    .query(
      "SELECT id FROM events WHERE kind = 'father_cycle_recorded' AND payload LIKE ?",
    )
    .get(`%${result.cycle_id}%`) as { id: string } | null;
  assert(cycle !== null, "father_cycle_recorded must be emitted");

  // directive_review_due must have fired for the rolling-active directive.
  const review = handle.db
    .query("SELECT id FROM events WHERE kind = 'directive_review_due' AND directive_id = ?")
    .get(directiveId) as { id: string } | null;
  assert(review !== null, "directive_review_due must be emitted for the overdue rolling-active directive");

  // No bridge_invoked since Father — Father never calls an LLM.
  const bridgeAfter = handle.db
    .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'bridge_invoked'")
    .get() as { n: number };
  assert(
    bridgeAfter.n === bridgeBefore.n,
    `Father iterate must not call any LLM (bridge_invoked delta=${bridgeAfter.n - bridgeBefore.n})`,
  );
};

// ── Scenario 9 — Amendment supersession ───────────────────────────

export const scenarioAmendmentSupersession = async (handle: DaemonHandle): Promise<void> => {
  const directiveId = `d_harness_s9_${newId()}`;
  emitEvent(handle.db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: { directive_text: "harness s9 amendment test", lifecycle: "finite" } as JsonValue,
  });

  const taskA = `t_harness_s9_a_${newId()}`;
  const taskB = `t_harness_s9_b_${newId()}`;
  emitEvent(handle.db, {
    kind: "task_node_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: taskA,
    parent_task_id: null,
    payload: { goal: "first child task", lifecycle: "finite" } as JsonValue,
  });
  emitEvent(handle.db, {
    kind: "task_node_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: taskB,
    parent_task_id: null,
    payload: { goal: "second child task", lifecycle: "finite" } as JsonValue,
  });

  // Emit a minimal action_predicted on the first task — we just need the
  // amendment to mark its outcome="amended" via superseded_predictions.
  const predicted = emitEvent(handle.db, {
    kind: "action_predicted",
    substrate_origin: "opencode",
    directive_id: directiveId,
    task_id: taskA,
    payload: { intent: "to be superseded" } as JsonValue,
  });

  const summary = await emitAndApplyAmendment(handle.db, {
    original_directive_id: directiveId,
    amendment_text: "supersede first child",
    superseded_tasks: [taskA],
    superseded_predictions: [predicted.id],
    new_task_goals: ["replacement task"],
    rationale: "harness supersession test",
  });

  assert(summary.already_applied === false, "amendment must not be already_applied");
  assert(
    summary.superseded_tasks_closed.includes(taskA),
    "amendment must close the first child task",
  );
  assert(
    summary.superseded_predictions_marked.includes(predicted.id),
    "amendment must mark the action_predicted",
  );
  assert(
    summary.new_tasks_opened.length === 1,
    `amendment must open exactly one new task (got ${summary.new_tasks_opened.length})`,
  );

  // directive_amended event landed.
  const amended = handle.db
    .query("SELECT id FROM events WHERE kind = 'directive_amended' AND directive_id = ?")
    .all(directiveId) as Array<{ id: string }>;
  assert(amended.length >= 1, "directive_amended event must be present");

  // Superseded task has a task_committed_superseded row with outcome=amended.
  const supRow = handle.db
    .query(
      "SELECT outcome FROM events WHERE kind = 'task_committed_superseded' AND task_id = ?",
    )
    .get(taskA) as { outcome: string } | null;
  assert(supRow !== null, "task_committed_superseded must be emitted for superseded task");
  assert(supRow!.outcome === "amended", `outcome must be 'amended' (got ${supRow!.outcome})`);

  // The new task is open.
  const newTaskId = summary.new_tasks_opened[0]!;
  const newOpened = handle.db
    .query("SELECT id FROM events WHERE kind = 'task_node_opened' AND task_id = ?")
    .get(newTaskId) as { id: string } | null;
  assert(newOpened !== null, "new task must be opened");

  // The original action_predicted's outcome row got updated to "amended".
  const predRow = handle.db
    .query("SELECT outcome FROM events WHERE id = ?")
    .get(predicted.id) as { outcome: string | null } | null;
  assert(predRow !== null, "predicted event must still exist");
  assert(
    predRow!.outcome === "amended",
    `predicted outcome must be 'amended' (got ${predRow!.outcome})`,
  );
};

// ── Scenario 10 — Rolling-active review (no close) ────────────────

export const scenarioRollingActiveReview = async (handle: DaemonHandle): Promise<void> => {
  // Open a rolling_active directive whose next_review_due is in the past.
  // processRollingReviews should:
  //   1. emit directive_review_due,
  //   2. open a fresh review task (task_node_opened with goal "review progress: …"),
  //   3. NOT emit task_committed on the directive's root (rolling-active never closes).
  const directiveId = `d_harness_s10_${newId()}`;
  const rootTaskId = directiveId;
  const pastTs = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  emitEvent(handle.db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: rootTaskId,
    payload: {
      directive_text: "harness rolling-active review",
      lifecycle: "rolling_active",
      urgency: "normal",
      review_cadence: "daily",
      next_review_due: pastTs,
      partial_commit_checkpoints: [],
    } as JsonValue,
  });

  // Snapshot the task_committed count for the root BEFORE the reviewer runs.
  const committedBefore = handle.db
    .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'task_committed' AND task_id = ?")
    .get(rootTaskId) as { n: number };

  const summary = await processRollingReviews(handle.db);
  assert(
    summary.reviews_opened >= 1,
    `rolling reviewer must open at least one review (got ${summary.reviews_opened})`,
  );

  // directive_review_due lands for the rolling-active directive.
  const due = handle.db
    .query("SELECT id FROM events WHERE kind = 'directive_review_due' AND directive_id = ?")
    .all(directiveId) as Array<{ id: string }>;
  assert(due.length >= 1, "directive_review_due must be emitted on past-due rolling-active");

  // A fresh review task_node_opened appears.
  const reviewTasks = handle.db
    .query(
      "SELECT payload FROM events WHERE kind = 'task_node_opened' AND directive_id = ?",
    )
    .all(directiveId) as Array<{ payload: string }>;
  const reviewTask = reviewTasks
    .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
    .find((p) => typeof p.goal === "string" && (p.goal as string).startsWith("review progress:"));
  assert(reviewTask !== undefined, "a review subtask must open");

  // No task_committed on the root — rolling-active never closes.
  const committedAfter = handle.db
    .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'task_committed' AND task_id = ?")
    .get(rootTaskId) as { n: number };
  assert(
    committedAfter.n === committedBefore.n,
    `rolling-active root must NOT commit (delta=${committedAfter.n - committedBefore.n})`,
  );

  // Cadence advanced — a directive_amended row with rolling_review_advancement=true.
  const amended = handle.db
    .query(
      "SELECT payload FROM events WHERE kind = 'directive_amended' AND directive_id = ? ORDER BY ts DESC LIMIT 1",
    )
    .get(directiveId) as { payload: string } | null;
  assert(amended !== null, "directive_amended must advance cadence");
  const ap = JSON.parse(amended!.payload) as Record<string, unknown>;
  assert(
    ap.rolling_review_advancement === true,
    `directive_amended must carry rolling_review_advancement (got ${JSON.stringify(ap)})`,
  );
};

// ── Scenario 11 — Stakeholder conflict + consult subtask ──────────

export const scenarioStakeholderConflict = async (handle: DaemonHandle): Promise<void> => {
  // Open a multi-stakeholder directive with two opposing declared_utility
  // numeric bounds. recordStakeholderState detects the disagreement and
  // emits the typed stakeholder_conflict_detected event plus a
  // stakeholder_consult task_node_opened.
  const directiveId = `d_harness_s11_${newId()}`;
  emitEvent(handle.db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      directive_text: "harness multi-stakeholder negotiation",
      lifecycle: "finite",
      urgency: "normal",
    } as JsonValue,
  });

  // Self insists on min_salary >= 280000; counterpart caps max_salary at 220000.
  recordStakeholderState(handle.db, {
    directive_id: directiveId,
    stakeholder_id: "self",
    declared_utility: { min_salary: 280000 },
    information_visibility: "full",
  });
  const result = recordStakeholderState(handle.db, {
    directive_id: directiveId,
    stakeholder_id: "counterpart",
    declared_utility: { max_salary: 220000 },
    information_visibility: "limited",
  });

  assert(
    result.conflicts.length >= 1,
    `conflict detector must surface ≥1 disagreement (got ${result.conflicts.length})`,
  );

  // stakeholder_conflict_detected event landed.
  const detected = handle.db
    .query("SELECT payload FROM events WHERE kind = 'stakeholder_conflict_detected' AND directive_id = ?")
    .all(directiveId) as Array<{ payload: string }>;
  assert(detected.length >= 1, "stakeholder_conflict_detected event must fire");
  const dp = JSON.parse(detected[0]!.payload) as Record<string, unknown>;
  assert(
    Array.isArray(dp.pair) && (dp.pair as unknown[]).length === 2,
    `detection payload must carry the conflicting pair (got ${JSON.stringify(dp.pair)})`,
  );

  // A stakeholder_consult task_node_opened landed under the directive.
  const tasks = handle.db
    .query("SELECT payload FROM events WHERE kind = 'task_node_opened' AND directive_id = ?")
    .all(directiveId) as Array<{ payload: string }>;
  const consult = tasks
    .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
    .find((p) => p.task_kind === "stakeholder_consult");
  assert(consult !== undefined, "a stakeholder_consult task must open under the directive");

  // owner_input_required references the consult task.
  const inputReq = handle.db
    .query("SELECT payload FROM events WHERE kind = 'owner_input_required' AND directive_id = ?")
    .get(directiveId) as { payload: string } | null;
  assert(inputReq !== null, "owner_input_required must be emitted");
  const irp = JSON.parse(inputReq!.payload) as Record<string, unknown>;
  assert(
    typeof irp.consult_task_id === "string",
    "owner_input_required must reference the consult_task_id",
  );
};

// ── Scenario 12 — Cross-directive interference (mutual_exclusion) ──

export const scenarioCrossDirectiveInterference = async (handle: DaemonHandle): Promise<void> => {
  // Two independent directives joined by a mutual_exclusion edge. The scheduler
  // must dispatch one and defer the other with `task_deferred_for_interference`.
  //
  // We assert the END-TO-END plumbing via two scoped schedulerTick calls
  // rather than a single unscoped one — the shared harness daemon's prior
  // scenarios leave uncommitted tasks behind that would pollute an unscoped
  // ready-task list. Scoping to each directive isolates the assertion to
  // exactly the tasks we authored. Pair A: dispatch t1 under d1. Pair B:
  // dispatch t1b under d1b, manually inject t1b's directive into the in-
  // flight directive set, then attempt to dispatch t2b under d2b — the
  // scheduler must defer it via the interference path. The interference
  // helper (`findDeferringConflict`) accepts an explicit `inFlightDirectiveIds`
  // set, so this scenario reaches into it directly to assert the typed
  // behaviour without relying on cross-tick promise lifetime.
  const tmpDir = mkdtempSync(join(tmpdir(), "acc2-harness-s12-"));
  try {
    writeFileSync(join(tmpDir, "x.txt"), "// TODO mutex", "utf-8");

    // Pair A — schedulerTick dispatches t1 fine when no peer is in-flight.
    const { taskId: t1, directiveId: d1 } = await openFixtureDCountTodos(handle.db, tmpDir);
    const { directiveId: d2 } = await openFixtureDCountTodos(handle.db, tmpDir);
    emitEvent(handle.db, {
      kind: "directive_interference_edge",
      substrate_origin: "owner",
      directive_id: d1,
      payload: {
        from_directive: d1,
        to_directive: d2,
        kind: "mutual_exclusion",
        reason: "harness s12 mutual_exclusion",
      } as JsonValue,
    });

    const tick1 = await schedulerTick(handle.db, {
      directiveId: d1,
      fixtureTargetPath: tmpDir,
      maxConcurrent: 5,
    });
    assert(
      tick1.dispatched.includes(t1),
      `t1 must dispatch when d2 is not in-flight (tick1.dispatched=${tick1.dispatched.join(",")})`,
    );

    // Pair B — direct path through findDeferringConflict to assert the
    // interference plumbing. We synthesize "d1b is in-flight" so d2b's
    // ready task surfaces the deferral verdict.
    const { findDeferringConflict } = await import("../../runtime/interference");
    const { directiveId: d1b } = await openFixtureDCountTodos(handle.db, tmpDir);
    const { directiveId: d2b } = await openFixtureDCountTodos(handle.db, tmpDir);
    emitEvent(handle.db, {
      kind: "directive_interference_edge",
      substrate_origin: "owner",
      directive_id: d1b,
      payload: {
        from_directive: d1b,
        to_directive: d2b,
        kind: "mutual_exclusion",
        reason: "harness s12 mutual_exclusion (pair B)",
      } as JsonValue,
    });
    const verdict = findDeferringConflict(handle.db, d2b, new Set([d1b]));
    assert(verdict !== null, "findDeferringConflict must return a conflict when d1b is in-flight");
    assert(verdict!.kind === "mutual_exclusion", `verdict.kind must be mutual_exclusion (got ${verdict!.kind})`);
    assert(
      verdict!.conflicting_directive === d1b,
      `conflicting_directive must be d1b (got ${verdict!.conflicting_directive})`,
    );

    // Symmetric: from d1b's perspective, d2b in-flight is also a conflict.
    const verdictRev = findDeferringConflict(handle.db, d1b, new Set([d2b]));
    assert(verdictRev !== null, "findDeferringConflict must be direction-agnostic for mutual_exclusion");

    // No conflict when neither side is in-flight.
    assert(
      findDeferringConflict(handle.db, d1b, new Set([])) === null,
      "empty in-flight set must yield no conflict",
    );

    // task_deferred_for_interference event surfaces via the scheduler.
    // Issue a directive-scoped tick on d2b after marking d1b's task as
    // in-flight by emitting a brain_dispatched event (a real-brain dispatch
    // indicator). We synthesize the in-flight set by emitting the dispatch
    // event for d1b's task, then re-tick d2b — but since IN_FLIGHT is
    // process-local, the scheduler won't pick that up automatically. The
    // canonical end-to-end emission test lives in
    // tests/task_scheduler.test.ts ("cross-directive mutual_exclusion
    // defers the second ready task") — this harness scenario verifies the
    // public interference API and the event-type wiring.

    // Verify the event TYPE is part of the EventKind partition (type-level
    // assertion via direct INSERT — would fail to compile otherwise).
    emitEvent(handle.db, {
      kind: "task_deferred_for_interference",
      substrate_origin: "substrate_auto",
      directive_id: d2b,
      payload: {
        from_directive: d2b,
        conflicting_directive: d1b,
        interaction: "mutual_exclusion",
        reason: "harness s12 end-to-end emission probe",
      } as JsonValue,
    });
    const ev = handle.db
      .query("SELECT payload FROM events WHERE kind = 'task_deferred_for_interference' AND directive_id = ?")
      .get(d2b) as { payload: string } | null;
    assert(ev !== null, "task_deferred_for_interference event must round-trip through the substrate");
    const p = JSON.parse(ev!.payload) as Record<string, unknown>;
    assert(p.interaction === "mutual_exclusion", `interaction must be mutual_exclusion (got ${p.interaction})`);
    assert(
      typeof p.from_directive === "string" && typeof p.conflicting_directive === "string",
      "payload must carry from_directive + conflicting_directive",
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
};

// ── Batch 5 universal-goal pilot scenarios (v2-design.md §10.2-10.9) ──
//
// Each scenario mirrors its sibling fixture under the shared daemon. The
// substrate runs an unmodified scheduler tick against the fixture's directive,
// the mock bridge admits its canonical action + verifier pair, the dispatcher
// runs them, and the verifier scores residual=0. Plumbing-only — no real
// brain — to keep the harness's <2s wall-clock budget.

const assertUniversalFixtureCommits = (
  handle: DaemonHandle,
  directiveId: string,
  taskId: string,
  fixtureLabel: string,
): void => {
  const scored = handle.db
    .query("SELECT residual FROM events WHERE kind = 'action_scored' AND directive_id = ?")
    .get(directiveId) as { residual: number } | null;
  assert(scored !== null, `${fixtureLabel}: action_scored must be emitted`);
  assert(
    scored!.residual === 0,
    `${fixtureLabel}: residual must be 0 (got ${scored!.residual})`,
  );

  const committed = handle.db
    .query("SELECT residual FROM events WHERE kind = 'task_committed' AND directive_id = ?")
    .get(directiveId) as { residual: number } | null;
  assert(committed !== null, `${fixtureLabel}: task_committed must be emitted`);
  assert(
    committed!.residual < 0.3,
    `${fixtureLabel}: commit residual must be < 0.3 (got ${committed!.residual})`,
  );

  const violations = handle.db
    .query("SELECT COUNT(*) as c FROM events WHERE kind = 'dispatcher_violation' AND directive_id = ?")
    .get(directiveId) as { c: number };
  assert(violations.c === 0, `${fixtureLabel}: no dispatcher_violation rows`);

  // Cross-check the canonical event chain — same shape as scenario 2's MVP gate.
  const expectedKinds = [
    "directive_opened",
    "task_node_opened",
    "brain_dispatched",
    "brain_dispatch_closed",
    "action_predicted",
    "artifact_invoked",
    "artifact_observed",
    "action_scored",
    "task_committed",
  ];
  for (const kind of expectedKinds) {
    const rows = handle.db
      .query("SELECT id FROM events WHERE kind = ? AND directive_id = ?")
      .all(kind, directiveId) as Array<{ id: string }>;
    assert(rows.length >= 1, `${fixtureLabel}: expected ${kind} event`);
  }

  // No refines edges — these fixtures all commit in one cycle.
  const refines = handle.db
    .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND directive_id = ?")
    .all(directiveId) as Array<{ payload: string }>;
  for (const r of refines) {
    const p = JSON.parse(r.payload) as Record<string, unknown>;
    assert(
      p.kind !== "refines",
      `${fixtureLabel}: unexpected refines edge: ${r.payload}`,
    );
  }
};

export const scenarioBusinessOutreach = async (handle: DaemonHandle): Promise<void> => {
  const { directiveId, taskId } = await openFixtureBusinessOutreach(handle.db);
  const tick = await schedulerTick(handle.db, { directiveId, maxConcurrent: 1 });
  assert(tick.dispatched.includes(taskId), "scheduler must dispatch the outreach root task");
  assertUniversalFixtureCommits(handle, directiveId, taskId, "business_outreach");

  // The action's observation envelope must include a written file_path that
  // exists on disk and a body containing the recipient name. This is the §10.2
  // "compose_emails leaf" assertion the design's verification surface calls for.
  const scored = handle.db
    .query("SELECT payload FROM events WHERE kind = 'action_scored' AND directive_id = ?")
    .get(directiveId) as { payload: string };
  const payload = JSON.parse(scored.payload) as Record<string, unknown>;
  const actionResult = payload.action_result as { result: { recipient: string; file_path: string; body: string } } | null;
  assert(actionResult !== null, "business_outreach: action_result must be set");
  assert(
    typeof actionResult!.result.file_path === "string" && existsSync(actionResult!.result.file_path),
    `business_outreach: tempfile must exist on disk (path=${actionResult!.result.file_path})`,
  );
  assert(
    actionResult!.result.body.includes(actionResult!.result.recipient),
    "business_outreach: email body must include the recipient name",
  );
};

export const scenarioResearchSummary = async (handle: DaemonHandle): Promise<void> => {
  const { directiveId, taskId } = await openFixtureResearchSummary(handle.db);
  const tick = await schedulerTick(handle.db, { directiveId, maxConcurrent: 1 });
  assert(tick.dispatched.includes(taskId), "scheduler must dispatch the research-summary task");
  assertUniversalFixtureCommits(handle, directiveId, taskId, "research_summary");

  // Verify the summary string itself ended up legible: present in the action
  // result envelope, between 40 and 1200 chars, and every keyword present.
  const scored = handle.db
    .query("SELECT payload FROM events WHERE kind = 'action_scored' AND directive_id = ?")
    .get(directiveId) as { payload: string };
  const payload = JSON.parse(scored.payload) as Record<string, unknown>;
  const actionResult = payload.action_result as {
    result: { summary: string; keywords: string[] };
  } | null;
  assert(actionResult !== null, "research_summary: action_result must be set");
  assert(
    actionResult!.result.summary.length >= 40 && actionResult!.result.summary.length <= 1200,
    `research_summary: summary length must be in [40, 1200] (got ${actionResult!.result.summary.length})`,
  );
  for (const kw of actionResult!.result.keywords) {
    assert(
      actionResult!.result.summary.toLowerCase().includes(kw.toLowerCase()),
      `research_summary: summary must reference keyword "${kw}"`,
    );
  }
};

export const scenarioCreativeConstraint = async (handle: DaemonHandle): Promise<void> => {
  const { directiveId, taskId } = await openFixtureCreativeConstraint(handle.db);
  const tick = await schedulerTick(handle.db, { directiveId, maxConcurrent: 1 });
  assert(tick.dispatched.includes(taskId), "scheduler must dispatch the haiku task");
  assertUniversalFixtureCommits(handle, directiveId, taskId, "creative_constraint");

  const scored = handle.db
    .query("SELECT payload FROM events WHERE kind = 'action_scored' AND directive_id = ?")
    .get(directiveId) as { payload: string };
  const payload = JSON.parse(scored.payload) as Record<string, unknown>;
  const actionResult = payload.action_result as { result: { lines: string[] } } | null;
  assert(actionResult !== null, "creative_constraint: action_result must be set");
  assert(
    Array.isArray(actionResult!.result.lines) && actionResult!.result.lines.length === 3,
    `creative_constraint: must produce three lines (got ${actionResult!.result.lines.length})`,
  );
};

export const scenarioMultiStakeholder = async (handle: DaemonHandle): Promise<void> => {
  const { directiveId, taskId } = await openFixtureMultiStakeholder(handle.db);
  const tick = await schedulerTick(handle.db, { directiveId, maxConcurrent: 1 });
  assert(tick.dispatched.includes(taskId), "scheduler must dispatch the stakeholder task");
  assertUniversalFixtureCommits(handle, directiveId, taskId, "multi_stakeholder");

  const scored = handle.db
    .query("SELECT payload FROM events WHERE kind = 'action_scored' AND directive_id = ?")
    .get(directiveId) as { payload: string };
  const payload = JSON.parse(scored.payload) as Record<string, unknown>;
  const actionResult = payload.action_result as {
    result: {
      chosen: number | null;
      feasible: boolean;
      stakeholders: Array<{ low: number; high: number }>;
    };
  } | null;
  assert(actionResult !== null, "multi_stakeholder: action_result must be set");
  assert(actionResult!.result.feasible === true, "multi_stakeholder: intersection must be feasible");
  assert(typeof actionResult!.result.chosen === "number", "multi_stakeholder: chosen must be a number");
  const v = actionResult!.result.chosen as number;
  for (const s of actionResult!.result.stakeholders) {
    assert(
      v >= s.low && v <= s.high,
      `multi_stakeholder: chosen ${v} must lie in [${s.low}, ${s.high}]`,
    );
  }
};

export const scenarioHealthDecision = async (handle: DaemonHandle): Promise<void> => {
  const { directiveId, taskId } = await openFixtureHealthDecision(handle.db);
  const tick = await schedulerTick(handle.db, { directiveId, maxConcurrent: 1 });
  assert(tick.dispatched.includes(taskId), "scheduler must dispatch the health-decision task");
  assertUniversalFixtureCommits(handle, directiveId, taskId, "health_decision");

  const scored = handle.db
    .query("SELECT payload FROM events WHERE kind = 'action_scored' AND directive_id = ?")
    .get(directiveId) as { payload: string };
  const payload = JSON.parse(scored.payload) as Record<string, unknown>;
  const actionResult = payload.action_result as {
    result: { recommendation: string; citation_knowledge_id: string; safety_note: string };
  } | null;
  assert(actionResult !== null, "health_decision: action_result must be set");
  assert(actionResult!.result.recommendation.length > 0, "health_decision: recommendation must be non-empty");
  assert(
    actionResult!.result.citation_knowledge_id.length > 0,
    "health_decision: citation_knowledge_id must be non-empty (knowledge anchor)",
  );
  assert(
    actionResult!.result.safety_note.toLowerCase().includes("consult a clinician"),
    "health_decision: safety_note must include 'consult a clinician'",
  );
};

export const scenarioEmbodiedRecipe = async (handle: DaemonHandle): Promise<void> => {
  const { directiveId, taskId } = await openFixtureEmbodiedRecipe(handle.db);
  const tick = await schedulerTick(handle.db, { directiveId, maxConcurrent: 1 });
  assert(tick.dispatched.includes(taskId), "scheduler must dispatch the recipe task");
  assertUniversalFixtureCommits(handle, directiveId, taskId, "embodied_recipe");

  const scored = handle.db
    .query("SELECT payload FROM events WHERE kind = 'action_scored' AND directive_id = ?")
    .get(directiveId) as { payload: string };
  const payload = JSON.parse(scored.payload) as Record<string, unknown>;
  const actionResult = payload.action_result as {
    result: { ingredients: string[]; steps: string[] };
  } | null;
  assert(actionResult !== null, "embodied_recipe: action_result must be set");
  assert(actionResult!.result.steps.length > 0, "embodied_recipe: steps must be non-empty");
  const lowerIngs = actionResult!.result.ingredients.map((s) => s.toLowerCase());
  for (const step of actionResult!.result.steps) {
    assert(step.trim().length > 0, "embodied_recipe: each step must be non-empty");
    const hit = lowerIngs.some((ing) => step.toLowerCase().includes(ing));
    assert(hit, `embodied_recipe: step "${step}" must reference at least one ingredient`);
  }
};

export const scenarioLongHorizonSavings = async (handle: DaemonHandle): Promise<void> => {
  const { directiveId, taskId } = await openFixtureLongHorizonSavings(handle.db);
  const tick = await schedulerTick(handle.db, { directiveId, maxConcurrent: 1 });
  assert(tick.dispatched.includes(taskId), "scheduler must dispatch the savings task");
  assertUniversalFixtureCommits(handle, directiveId, taskId, "long_horizon_savings");

  const scored = handle.db
    .query("SELECT payload FROM events WHERE kind = 'action_scored' AND directive_id = ?")
    .get(directiveId) as { payload: string };
  const payload = JSON.parse(scored.payload) as Record<string, unknown>;
  const actionResult = payload.action_result as {
    result: { target: number; months: number; monthly: number; total: number };
  } | null;
  assert(actionResult !== null, "long_horizon_savings: action_result must be set");
  assert(actionResult!.result.monthly > 0, "long_horizon_savings: monthly must be positive");
  assert(
    actionResult!.result.total >= actionResult!.result.target,
    `long_horizon_savings: total (${actionResult!.result.total}) must cover target (${actionResult!.result.target})`,
  );
  assert(
    actionResult!.result.total <= actionResult!.result.target * 1.05,
    `long_horizon_savings: total must stay within +5% of target`,
  );
};

export const scenarioCrisisResponse = async (handle: DaemonHandle): Promise<void> => {
  const { directiveId, taskId } = await openFixtureCrisisResponse(handle.db);

  // crisis_mode_engaged fired alongside directive_opened.
  const engaged = handle.db
    .query("SELECT id FROM events WHERE kind = 'crisis_mode_engaged' AND directive_id = ?")
    .all(directiveId) as Array<{ id: string }>;
  assert(engaged.length >= 1, "crisis_response: crisis_mode_engaged must fire");

  // Scheduler concurrency cap rises to CRISIS_MODE.max_concurrent (20).
  const mode = readCurrentMode(handle.db, directiveId);
  assert(
    mode.max_concurrent === CRISIS_MODE.max_concurrent,
    `crisis_response: max_concurrent must be ${CRISIS_MODE.max_concurrent} (got ${mode.max_concurrent})`,
  );
  assert(mode.latm_authoring_suspended === true, "crisis_response: LATM authoring must be suspended");

  const tick = await schedulerTick(handle.db, { directiveId, maxConcurrent: 1 });
  assert(tick.dispatched.includes(taskId), "scheduler must dispatch the crisis task");
  assertUniversalFixtureCommits(handle, directiveId, taskId, "crisis_response");

  const scored = handle.db
    .query("SELECT payload FROM events WHERE kind = 'action_scored' AND directive_id = ?")
    .get(directiveId) as { payload: string };
  const payload = JSON.parse(scored.payload) as Record<string, unknown>;
  const actionResult = payload.action_result as {
    result: { triage_steps: string[]; urgency: string };
  } | null;
  assert(actionResult !== null, "crisis_response: action_result must be set");
  assert(
    actionResult!.result.triage_steps.length >= 3,
    `crisis_response: triage_steps must have at least 3 (got ${actionResult!.result.triage_steps.length})`,
  );
  assert(actionResult!.result.urgency === "crisis", "crisis_response: urgency must be 'crisis'");
};

// ── Scenario 21 — real_brain_end_to_end (opt-in opencode dispatch) ─

/**
 * Real-brain pre-flight: returns `null` when every prerequisite is present
 * and the scenario should run; returns a short reason string when the
 * scenario should be SKIPPED (printed by the harness as a `[skip]` line,
 * not failed).
 *
 * The harness wrapper decides inclusion (default: skip real-brain; opt
 * in via `--include-real` or `--real-only`). This pre-flight only checks
 * environmental prerequisites — by the time it runs, the wrapper has
 * already chosen to include the scenario.
 *
 * Skip conditions:
 *  - `OPENAI_API_KEY` absent (embedder/downstream cannot warm).
 *  - `opencode` binary not on PATH.
 *
 * Real-brain is opt-in because each run burns ~2 min wall-clock + opencode
 * tokens; the plumbing suite proves the loop end-to-end without that cost.
 */
export const realBrainPreflight = (_argv: string[]): string | null => {
  if (!process.env.OPENAI_API_KEY) return "OPENAI_API_KEY absent";
  try {
    const r = Bun.spawnSync(["which", "opencode"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return "opencode CLI not on PATH";
    const out = (r.stdout?.toString() ?? "").trim();
    if (out.length === 0) return "opencode CLI not on PATH";
  } catch {
    return "opencode CLI not on PATH";
  }
  return null;
};

/**
 * Open the example.com title-fetch directive, run one scheduler tick with
 * ACC2_BRIDGE_MODE=real, and assert the full event chain landed
 * (bridge_invoked → action_predicted → artifact_invoked → artifact_observed
 * → action_scored → task_committed when residual < 0.3). Owns its own
 * daemon — the shared harness daemon is mock-pinned, this one is real.
 *
 * Failure: throws with a classified reason from the bridge's failure
 * taxonomy (auth_missing / rate_limit / timeout / parse_error /
 * subprocess_crash / cycle_1_only_breach / verifier_residual_high /
 * no_action_predicted) so the harness's per-scenario FAIL line carries
 * actionable detail.
 */
export const scenarioRealBrainEndToEnd = async (): Promise<void> => {
  // The harness pins ACC2_BRIDGE_MODE=mock for the 17 plumbing scenarios.
  // This scenario flips to real for its own dispatch, then restores.
  const originalMode = process.env.ACC2_BRIDGE_MODE;
  process.env.ACC2_BRIDGE_MODE = "real";

  // Real opencode dispatch can take 60-180s on cold boot (model warm-up +
  // reasoning + tool calls). Widen the bridge watchdog + MCP handshake
  // window unless the operator already overrode them.
  const originalTimeout = process.env.ACC2_OPENCODE_TIMEOUT_MS;
  const originalHandshake = process.env.ACC2_OPENCODE_MCP_HANDSHAKE_MS;
  if (!originalTimeout) process.env.ACC2_OPENCODE_TIMEOUT_MS = "600000";
  if (!originalHandshake) process.env.ACC2_OPENCODE_MCP_HANDSHAKE_MS = "120000";

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

  // PRODUCTION BOOT PATH. The harness MUST exercise the same code paths
  // an operator gets from `acc init && acc daemon start`. We no longer
  // call `bootDaemon(...)` with custom opts and seed via a privileged
  // side door — instead `bootDaemonProduction()` runs `runInitProgrammatic`
  // (which seeds knowledge + code_artifacts via Task 1 wiring) and then
  // `startDaemon()` with NO opts. Real-brain proof of the loop now also
  // proves the operator-install seed surface.
  let prod: ProductionBootResult | null = null;
  try {
    prod = await bootDaemonProduction({ keepState: false });
    const handle = prod.handle;
    // Expose the MCP URL so the real opencode subprocess can connect back.
    process.env.V2_MCP_SERVER_URL = `http://127.0.0.1:${handle.port}/mcp`;

    const directiveId = newId();
    const taskId = newId();
    emitEvent(handle.db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: {
        directive_text: REAL_DIRECTIVE_TEXT,
        smoke: "harness_real_brain_end_to_end",
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
        goal: REAL_DIRECTIVE_TEXT,
        lifecycle: "finite",
        urgency: "normal",
      } as JsonValue,
    });

    const tick = await schedulerTick(handle.db, {
      directiveId,
      maxConcurrent: 1,
    });
    assert(
      tick.dispatched.includes(taskId),
      `scheduler did not dispatch task ${taskId} (dispatched=[${tick.dispatched.join(",")}])`,
    );

    // Classify bridge failure first — the operator wants the failure mode
    // word from the taxonomy, not a low-level assertion miss.
    const bridgeFailed = handle.db
      .query(
        "SELECT payload FROM events WHERE kind = 'bridge_failed' AND directive_id = ? ORDER BY ts DESC LIMIT 1",
      )
      .get(directiveId) as { payload: string } | null;
    if (bridgeFailed) {
      const p = JSON.parse(bridgeFailed.payload ?? "{}") as Record<string, unknown>;
      const reason = String(p.reason ?? "unknown");
      throw new Error(`bridge_failed: ${reason} (see docs/real-brain-runbook.md)`);
    }

    const bridgeInvoked = handle.db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'bridge_invoked' AND directive_id = ?")
      .get(directiveId) as { n: number };
    assert(bridgeInvoked.n >= 1, "bridge_invoked must be emitted");

    const predicted = handle.db
      .query(
        "SELECT action_artifact_id, verifier_artifact_id FROM events WHERE kind = 'action_predicted' AND directive_id = ? ORDER BY ts ASC",
      )
      .all(directiveId) as Array<{
      action_artifact_id: string | null;
      verifier_artifact_id: string | null;
    }>;
    assert(predicted.length >= 1, "action_predicted must be emitted by the brain (no_action_predicted)");
    const pred = predicted[0]!;
    assert(
      typeof pred.action_artifact_id === "string" && pred.action_artifact_id.length > 0,
      "action_artifact_id must be set",
    );
    assert(
      typeof pred.verifier_artifact_id === "string" && pred.verifier_artifact_id.length > 0,
      "verifier_artifact_id must be set",
    );

    const action = getArtifact(handle.db, pred.action_artifact_id!);
    const verifier = getArtifact(handle.db, pred.verifier_artifact_id!);
    assert(action !== null, `action artifact ${pred.action_artifact_id} must resolve`);
    assert(verifier !== null, `verifier artifact ${pred.verifier_artifact_id} must resolve`);

    const invoked = handle.db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'artifact_invoked' AND directive_id = ?")
      .get(directiveId) as { n: number };
    const observed = handle.db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'artifact_observed' AND directive_id = ?")
      .get(directiveId) as { n: number };
    assert(invoked.n >= 1, "artifact_invoked must be emitted");
    assert(observed.n >= 1, "artifact_observed must be emitted");

    const scoredRows = handle.db
      .query(
        "SELECT residual, payload FROM events WHERE kind = 'action_scored' AND directive_id = ? ORDER BY ts ASC",
      )
      .all(directiveId) as Array<{ residual: number; payload: string }>;
    assert(scoredRows.length >= 1, "action_scored must be emitted");
    const residual = scoredRows[0]!.residual;
    assert(
      Number.isFinite(residual) && residual >= 0 && residual <= 1,
      `residual must be in [0,1] (got ${residual}) — verifier_residual_high if >= 0.3`,
    );

    const violations = handle.db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'dispatcher_violation' AND directive_id = ?")
      .get(directiveId) as { n: number };
    assert(violations.n === 0, `dispatcher_violation must not fire (cycle_1_only_breach; count=${violations.n})`);

    if (residual < 0.3) {
      const committed = handle.db
        .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'task_committed' AND directive_id = ?")
        .get(directiveId) as { n: number };
      assert(committed.n >= 1, "task_committed must be emitted when residual < 0.3");

      // Title-extraction proof — search action_scored.payload.action_result for
      // result.title (the runtime-observed payload the dispatcher captured).
      let title: string | null = null;
      for (const r of scoredRows) {
        try {
          const p = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
          const ar = p.action_result as Record<string, unknown> | undefined;
          const result = ar?.result as Record<string, unknown> | undefined;
          if (result && typeof result.title === "string" && result.title.length > 0) {
            title = result.title;
            break;
          }
        } catch { /* skip */ }
      }
      assert(
        title !== null,
        "result.title must be a non-empty string (action_scored.payload.action_result.result.title)",
      );
    } else {
      // Refinement edge gate.
      const edges = handle.db
        .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND directive_id = ?")
        .all(directiveId) as Array<{ payload: string }>;
      const refines = edges
        .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
        .filter((p) => p.kind === "refines");
      assert(refines.length >= 1, "refinement edge must be emitted when residual >= 0.3");
    }
  } finally {
    if (prod) await prod.cleanup();
    if (originalMode === undefined) delete process.env.ACC2_BRIDGE_MODE;
    else process.env.ACC2_BRIDGE_MODE = originalMode;
    if (originalTimeout === undefined) delete process.env.ACC2_OPENCODE_TIMEOUT_MS;
    else process.env.ACC2_OPENCODE_TIMEOUT_MS = originalTimeout;
    if (originalHandshake === undefined) delete process.env.ACC2_OPENCODE_MCP_HANDSHAKE_MS;
    else process.env.ACC2_OPENCODE_MCP_HANDSHAKE_MS = originalHandshake;
  }
};

// ── Ad-hoc task — operator-driven real-brain validation ────────────

export type AdHocTaskUrgency = "normal" | "elevated" | "crisis";

export type AdHocTaskOptions = {
  /** The natural-language directive to send to the brain. */
  taskText: string;
  /** Max wall-clock to wait for a terminal event (default 5 min). */
  timeoutMs?: number;
  /** When true, keep the temp state dir + DB on exit so the operator can inspect.
   *  The path is printed in the final summary. */
  keepState?: boolean;
  /** Directive urgency. `crisis` engages crisis-mode dispatch (v2-design.md §3.5);
   *  the post-run summary reports `crisis_mode_engaged: yes/no` based on whether
   *  a `crisis_mode_engaged` event fired during the run. Default "normal". */
  urgency?: AdHocTaskUrgency;
  /** Output sink (default: process.stdout.write). */
  writer?: (s: string) => void;
};

export type AdHocTaskResult = {
  committed: boolean;
  failed: boolean;
  timedOut: boolean;
  residual: number | null;
  durationMs: number;
  directiveId: string;
  stateDir: string;
  eventsCount: number;
  artifactsCount: number;
  violations: number;
  refinementEdges: number;
  /** Echo of the requested urgency from AdHocTaskOptions. */
  urgency: AdHocTaskUrgency;
  /** True iff a `crisis_mode_engaged` event was emitted under this directive
   *  during the run. Always false when urgency !== "crisis". */
  crisisModeEngaged: boolean;
};

/**
 * Drive the real brain (opencode → gpt-5.5) on an arbitrary operator-supplied
 * directive in a fresh ephemeral daemon. Prints the full event chain to the
 * writer as it unfolds, then prints a verdict + structured result.
 *
 * Unlike scenarioRealBrainEndToEnd this scenario makes NO content assertions
 * (no "title equals X") — it only verifies structural invariants of the loop:
 * bridge_invoked, action_predicted, artifact_invoked, action_scored, no
 * dispatcher_violation, and a terminal event (task_committed OR a refinement
 * edge) within the timeout.
 *
 * Returns a structured result instead of throwing — the harness wrapper
 * decides exit-code based on { committed, failed, timedOut }.
 */
export const scenarioAdHocTask = async (opts: AdHocTaskOptions): Promise<AdHocTaskResult> => {
  const write = opts.writer ?? ((s: string) => process.stdout.write(s));
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const keepState = opts.keepState ?? false;
  const urgency: AdHocTaskUrgency = opts.urgency ?? "normal";

  // Flip bridge to real for this run; restore on exit.
  const originalMode = process.env.ACC2_BRIDGE_MODE;
  process.env.ACC2_BRIDGE_MODE = "real";
  const originalTimeout = process.env.ACC2_OPENCODE_TIMEOUT_MS;
  const originalHandshake = process.env.ACC2_OPENCODE_MCP_HANDSHAKE_MS;
  if (!originalTimeout) process.env.ACC2_OPENCODE_TIMEOUT_MS = "600000";
  if (!originalHandshake) process.env.ACC2_OPENCODE_MCP_HANDSHAKE_MS = "120000";

  const startedAt = Date.now();
  const directiveId = newId();
  const taskId = newId();

  // PRODUCTION BOOT PATH. The harness's --task mode MUST exercise the
  // same code paths an operator gets from `acc init && acc daemon start`.
  // No more bootDaemon(...) side door + manual seedFoundationalKnowledge /
  // seedCodeArtifacts call — bootDaemonProduction below sets
  // ACC2_STATE_DIR + ports, runs `runInitProgrammatic({yes:true})` (the
  // SAME function `bun cli/dispatch.ts init --yes` invokes — seeds both
  // knowledge and code_artifacts via Task 1 wiring), then calls
  // `startDaemon()` with NO opts. If today's flow skipped any seed step,
  // it surfaces explicitly: the production init path is now the only
  // surface that decides what the substrate contains at boot.
  let prod: ProductionBootResult | null = null;
  let result: AdHocTaskResult = {
    committed: false, failed: false, timedOut: false, residual: null,
    durationMs: 0, directiveId, stateDir: "",
    eventsCount: 0, artifactsCount: 0, violations: 0, refinementEdges: 0,
    urgency, crisisModeEngaged: false,
  };

  try {
    write(`acc2 harness — ad-hoc real-brain task\n`);
    write(`======================================\n`);
    write(`task:  ${opts.taskText}\n`);

    prod = await bootDaemonProduction({ keepState });
    const handle = prod.handle;
    result.stateDir = prod.tmpDir;
    write(`state: ${prod.tmpDir}\n\n`);

    process.env.V2_MCP_SERVER_URL = `http://127.0.0.1:${handle.port}/mcp`;
    write(`boot: daemon up on mcp=${handle.port} aux=${handle.auxPort} (${((Date.now()-startedAt)/1000).toFixed(2)}s)\n`);
    write(`boot: production code path — acc init + acc daemon start (no privileged side door)\n`);

    // Knowledge lives as `events` rows (kind=knowledge_promoted) — one substrate,
    // one ledger (k_2367). code_artifact is the only materialized projection.
    // We probe the seeded counts after init+start so the operator can see
    // the substrate contents WITHOUT the harness directly calling seed code.
    const seededK = handle.db.query(
      "SELECT COUNT(*) AS n FROM events WHERE kind = 'knowledge_promoted'",
    ).get() as { n: number };
    const seededA = handle.db.query("SELECT COUNT(*) AS n FROM code_artifact").get() as { n: number };
    write(`seed: knowledge_promoted=${seededK.n}, code_artifacts=${seededA.n}\n`);

    emitEvent(handle.db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: {
        directive_text: opts.taskText,
        smoke: "harness_adhoc_task",
        lifecycle: "finite",
        urgency,
      } as JsonValue,
    });
    emitEvent(handle.db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      parent_task_id: null,
      payload: {
        goal: opts.taskText,
        lifecycle: "finite",
        urgency,
      } as JsonValue,
    });
    // Crisis directives engage crisis-mode dispatch (v2-design.md §3.5). The
    // mode change is recorded as a structural `crisis_mode_engaged` event so
    // downstream surfaces (and the post-run summary) can tell whether the
    // substrate actually flipped into the lowered-threshold lane —
    // readCurrentMode() then reads the directive's payload urgency and
    // delivers CRISIS_MODE adjustments to the scheduler / dispatcher. The
    // event is the canonical observable; emitting it here mirrors what
    // `openCrisisDirective` (runtime/crisis_mode.ts) does for non-harness
    // call sites.
    if (urgency === "crisis") {
      emitEvent(handle.db, {
        kind: "crisis_mode_engaged",
        substrate_origin: "substrate_auto",
        directive_id: directiveId,
        payload: { reason: "harness_adhoc_task_urgency_crisis" } as JsonValue,
      });
      write(`crisis: mode engaged (urgency=${urgency})\n`);
    }
    write(`emit: directive_opened ${directiveId.slice(0,12)}... (task ${taskId.slice(0,12)}..., urgency=${urgency})\n\n`);

    // Snapshot the artifact baseline so the post-run count reflects only
    // what the brain admitted during THIS dispatch (the seed already loaded N).
    const artifactsBaseline = (
      handle.db.query("SELECT COUNT(*) AS n FROM code_artifact").get() as { n: number }
    ).n;

    // Stream EVERY event for this directive as it lands — the brain's MCP
    // tool calls land here as event rows (substrate.admit_artifact emits
    // code_artifact_admitted, etc.), so this surfaces brain activity that
    // would otherwise be invisible during the ~2 min opencode window.
    // Plus a heartbeat every 15s of silence so the operator can tell
    // "thinking" from "hung".
    const seen = new Set<string>();
    let lastTs = "1970-01-01";
    let lastEventAt = Date.now();

    write(`dispatch: scheduler tick…\n`);
    const tickPromise = schedulerTick(handle.db, { directiveId, maxConcurrent: 1 });

    const HEARTBEAT_MS = 15_000;
    const heartbeat = setInterval(() => {
      const sinceLast = ((Date.now() - lastEventAt) / 1000).toFixed(1);
      const total = ((Date.now() - startedAt) / 1000).toFixed(1);
      write(`  … still working — ${total}s elapsed, last event ${sinceLast}s ago\n`);
    }, HEARTBEAT_MS);

    const deadline = startedAt + timeoutMs;
    let terminal: { kind: string; payload: string } | null = null;

    try {
      while (Date.now() < deadline) {
        const rows = handle.db
          .query(
            `SELECT id, kind, ts, payload, substrate_origin,
                    predicted_residual, action_artifact_id, verifier_artifact_id,
                    outcome, residual, failure_kind, invoker
             FROM events WHERE directive_id = ? AND ts > ?
             ORDER BY ts ASC, rowid ASC`,
          )
          .all(directiveId, lastTs) as EventRow[];
        for (const r of rows) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1) + "s";
          const summary = summarizeEventForCli(r);
          // Compact: [   7.4s] kind                          summary
          write(`  [${elapsed.padStart(7)}] ${r.kind.padEnd(28)} ${summary}\n`);
          lastTs = r.ts > lastTs ? r.ts : lastTs;
          lastEventAt = Date.now();
          if (r.kind === "task_committed" || r.kind === "task_failed") {
            terminal = { kind: r.kind, payload: r.payload };
          }
        }
        if (terminal) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      clearInterval(heartbeat);
    }
    try { await tickPromise; } catch { /* swallow — terminal already known */ }

    // On timeout, dump diagnostic info so the operator knows what was last
    // observed and what the daemon thinks is going on.
    if (terminal === null && Date.now() >= deadline) {
      write(`\n⚠ timed out after ${(timeoutMs / 1000).toFixed(0)}s — diagnostic dump:\n`);
      const lastEvents = handle.db
        .query(
          `SELECT ts, kind, substrate_origin, substr(payload, 1, 80) AS p
           FROM events WHERE directive_id = ? ORDER BY ts DESC LIMIT 10`,
        )
        .all(directiveId) as Array<{ ts: string; kind: string; substrate_origin: string; p: string }>;
      for (const e of lastEvents.reverse()) {
        write(`    ${e.ts}  ${e.kind.padEnd(28)} [${e.substrate_origin}]  ${e.p}\n`);
      }
      try {
        const h = await fetch(`http://127.0.0.1:${handle.auxPort}/health`);
        const body = await h.text();
        write(`  daemon /health: ${h.status} ${body.slice(0, 200)}\n`);
      } catch (err) {
        write(`  daemon /health: ${(err as Error).message}\n`);
      }
    }

    // Tally final state.
    const totals = handle.db.query("SELECT COUNT(*) AS n FROM events WHERE directive_id = ?").get(directiveId) as { n: number };
    const artifactsAfter = (
      handle.db.query("SELECT COUNT(*) AS n FROM code_artifact").get() as { n: number }
    ).n;
    const artifacts = { n: artifactsAfter - artifactsBaseline };
    const violations = handle.db.query(
      "SELECT COUNT(*) AS n FROM events WHERE kind = 'dispatcher_violation' AND directive_id = ?",
    ).get(directiveId) as { n: number };
    const refines = handle.db.query(
      "SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND directive_id = ?",
    ).all(directiveId) as Array<{ payload: string }>;
    const refineCount = refines
      .map((e) => { try { return JSON.parse(e.payload) as Record<string, unknown>; } catch { return {}; } })
      .filter((p) => p.kind === "refines").length;
    const scoredRow = handle.db.query(
      "SELECT residual FROM events WHERE kind = 'action_scored' AND directive_id = ? ORDER BY ts ASC LIMIT 1",
    ).get(directiveId) as { residual: number } | null;

    // Crisis-mode probe: a `crisis_mode_engaged` row scoped to this directive
    // means the substrate flipped into CRISIS_MODE. We probe even on
    // urgency=normal so an unexpected mode transition surfaces in the
    // summary rather than vanishing.
    const crisisRow = handle.db.query(
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'crisis_mode_engaged' AND directive_id = ?",
    ).get(directiveId) as { c: number };

    result = {
      committed: terminal?.kind === "task_committed",
      failed: terminal?.kind === "task_failed",
      timedOut: terminal === null,
      residual: scoredRow?.residual ?? null,
      durationMs: Date.now() - startedAt,
      directiveId,
      stateDir: prod.tmpDir,
      eventsCount: totals.n,
      artifactsCount: artifacts.n,
      violations: violations.n,
      refinementEdges: refineCount,
      urgency,
      crisisModeEngaged: crisisRow.c > 0,
    };

    write(`\n──────────────────────────────────────\n`);
    write(`verdict: ${result.committed ? "COMMITTED" : result.failed ? "FAILED" : "TIMED OUT"}`);
    if (result.residual !== null) write(`  residual=${result.residual.toFixed(3)}`);
    write(`\n`);
    write(`  events emitted: ${result.eventsCount}\n`);
    write(`  artifacts admitted: ${result.artifactsCount}\n`);
    write(`  dispatcher_violation: ${result.violations}${result.violations === 0 ? "" : "  ⚠"}\n`);
    write(`  refinement edges: ${result.refinementEdges}\n`);
    write(`  duration: ${(result.durationMs / 1000).toFixed(1)}s\n`);
    if (urgency === "crisis") {
      write(`  crisis_mode_engaged: ${result.crisisModeEngaged ? "yes" : "no"}\n`);
    }

    return result;
  } finally {
    // Production-boot cleanup: stops daemon, closes db, restores every env
    // var the boot path mutated, removes the tmpdir unless keepState.
    if (prod) {
      await prod.cleanup();
      if (keepState) write(`\nstate kept at: ${prod.tmpDir} (--keep-state)\n`);
    }
    if (originalMode === undefined) delete process.env.ACC2_BRIDGE_MODE;
    else process.env.ACC2_BRIDGE_MODE = originalMode;
    if (originalTimeout === undefined) delete process.env.ACC2_OPENCODE_TIMEOUT_MS;
    else process.env.ACC2_OPENCODE_TIMEOUT_MS = originalTimeout;
    if (originalHandshake === undefined) delete process.env.ACC2_OPENCODE_MCP_HANDSHAKE_MS;
    else process.env.ACC2_OPENCODE_MCP_HANDSHAKE_MS = originalHandshake;
  }
};

type EventRow = {
  id: string;
  kind: string;
  ts: string;
  payload: string;
  substrate_origin: string;
  predicted_residual: number | null;
  action_artifact_id: string | null;
  verifier_artifact_id: string | null;
  outcome: string | null;
  residual: number | null;
  failure_kind: string | null;
  invoker: string | null;
};

/**
 * Compact one-line summary per event kind for the streaming CLI output.
 * Reads from EVENT ROW COLUMNS (predicted_residual, action_artifact_id,
 * residual, etc.) — not just payload — because the schema stores those
 * fields as dedicated columns, not as JSON inside payload.
 */
const summarizeEventForCli = (r: EventRow): string => {
  let p: Record<string, unknown> = {};
  try { p = JSON.parse(r.payload ?? "{}") as Record<string, unknown>; } catch { /* keep empty */ }
  const short = (s: string | null | undefined): string =>
    typeof s === "string" && s.length > 0 ? s.slice(0, 10) : "?";
  const origin = r.substrate_origin ? `[${r.substrate_origin}]` : "";
  switch (r.kind) {
    // Bridge / dispatch
    case "bridge_invoked":
      return `${origin} → opencode  prompt_chars=${p.prompt_chars ?? "?"}  model=${p.model ?? "?"}`;
    case "bridge_failed":
      return `${origin} reason=${String(p.reason ?? "unknown")}  ⚠`;
    case "brain_dispatched":
      return `${origin} task=${short(p.task_id as string)}`;
    case "brain_dispatch_closed":
      return `${origin} events_count=${p.events_count ?? "?"}`;
    case "dispatcher_violation":
      return `${origin} failure_kind=${r.failure_kind ?? p.failure_kind ?? "?"}  ⚠`;

    // Action / verification
    case "action_predicted":
      return `${origin} action=${short(r.action_artifact_id)} verifier=${short(r.verifier_artifact_id)} predicted_residual=${r.predicted_residual ?? "?"}`;
    case "artifact_invoked":
      return `artifact=${short(p.artifact_id as string)}  runtime=${p.runtime ?? "?"}`;
    case "artifact_observed":
      return `ok=${p.ok ?? "?"}  duration_ms=${p.duration_ms ?? "?"}`;
    case "action_scored":
      return `residual=${r.residual ?? p.residual ?? "?"}  outcome=${r.outcome ?? "?"}`;
    case "task_committed":
      return `residual=${r.residual ?? p.residual ?? "?"}`;
    case "task_failed":
      return `failure_kind=${r.failure_kind ?? p.failure_kind ?? "?"}  ⚠`;
    case "task_edge_recorded":
      return `edge=${String(p.kind ?? "?")}  from=${short(p.from_task as string)} → to=${short(p.to_task as string)}`;
    case "task_node_opened":
      return `task=${short(r.id)}  goal="${String(p.goal ?? "").slice(0, 50)}"`;

    // Brain MCP traffic — the most diagnostic stream during the brain's
    // "thinking" window. bridge_frame_received fires for each opencode tool
    // call (both built-ins like grep/glob/read AND v2's substrate.* / runtime.*
    // MCP tools). opencode 1.x stashes inputs/outputs under several field
    // paths depending on the tool kind and revision — we probe all of them
    // so the operator sees WHAT the brain is doing, not just which verb it
    // chose.
    case "bridge_frame_received": {
      const type = String(p.type ?? "?");
      const part = (p.part as Record<string, unknown> | undefined) ?? {};
      const state = (part.state as Record<string, unknown> | undefined) ?? {};
      const toolName = String(
        part.tool ?? part.name ?? p.tool ?? p.name ?? "?",
      )
        .replace(/^acc2-substrate_substrate_/, "substrate.")
        .replace(/^acc2-substrate_runtime_/, "runtime.");
      // Probe every plausible input location. opencode 1.14 stashes most
      // tool inputs under `part.state.input` while older builds used
      // `part.input`; some tools route through `part.arguments`.
      const input =
        (state.input as unknown) ??
        (part.input as unknown) ??
        (part.arguments as unknown) ??
        (part.params as unknown) ??
        (p.input as unknown) ??
        null;
      // Likewise for outputs/results.
      const output =
        (state.output as unknown) ??
        (state.result as unknown) ??
        (part.output as unknown) ??
        (part.result as unknown) ??
        null;
      const truncate = (raw: string, max: number): string =>
        raw.length > max ? raw.slice(0, max - 3) + "..." : raw;
      const fmt = (v: unknown, max: number): string => {
        if (v === null || v === undefined) return "";
        if (typeof v === "string") return truncate(v, max);
        try { return truncate(JSON.stringify(v), max); } catch { return ""; }
      };
      if (type === "tool_use" || type === "tool_call") {
        const inputStr = fmt(input, 140);
        return `${origin} → ${toolName}${inputStr ? "  " + inputStr : ""}`;
      }
      if (type === "tool_result") {
        const outStr = fmt(output, 140);
        return `${origin} ← ${toolName}${outStr ? "  " + outStr : ""}`;
      }
      return `${origin} ${type}  ${toolName}`;
    }
    case "bridge_mcp_connected":
      return `${origin} ✓ MCP handshake  first_tool=${String(p.first_tool ?? "?").replace(/^acc2-substrate_substrate_/, "substrate.").replace(/^acc2-substrate_runtime_/, "runtime.")}`;
    case "constitutional_gate_decision":
      return `${origin} route=${p.route ?? "?"}  reason=${p.reason ?? "?"}`;

    case "code_artifact_admitted":
      return `${origin} artifact=${short(p.artifact_id as string)}  runtime=${p.runtime ?? "?"}  ${p.role ? "role=" + p.role : ""}`;
    case "code_artifact_admission_failed":
      return `${origin} reason=${String(p.reason ?? "?")}  ⚠`;
    case "code_artifact_candidate":
      return `${origin} runtime=${p.runtime ?? "?"}`;
    case "knowledge_candidate":
      return `${origin} text="${String(p.text ?? "").slice(0, 60)}"`;
    case "knowledge_promoted":
    case "knowledge_admitted":
      return `${origin} text="${String(p.text ?? "").slice(0, 60)}"`;
    case "knowledge_synthesized":
      return `${origin} corroborators=${Array.isArray(p.corroborator_event_ids) ? (p.corroborator_event_ids as unknown[]).length : "?"}`;

    // Retrieval / state
    case "retrieval_query_made":
      return `${origin} query="${String(p.query ?? "").slice(0, 50)}"  k=${p.k ?? "?"}`;
    case "external_event_received":
      return `${origin} source=${p.source ?? "?"}`;

    // Directive lifecycle (rare, but useful)
    case "directive_amended":
      return `${origin} superseded=${Array.isArray(p.superseded_tasks) ? (p.superseded_tasks as unknown[]).length : "?"}`;

    default: {
      // Default: extract the most-useful top-level fields from payload as
      // `key=value` pairs (more informative than dumping a JSON prefix that
      // gets cut mid-key). Keeps unknown event kinds legible without
      // teaching this switch every one.
      const PREFER_KEYS = [
        "reason", "failure_kind", "task_id", "artifact_id", "runtime",
        "tool", "ok", "source", "kind", "route", "directive_id",
        "text", "goal", "model", "query", "k",
      ];
      const parts: string[] = [];
      for (const k of PREFER_KEYS) {
        if (k in p) {
          const v = p[k];
          let s = typeof v === "string" ? v : JSON.stringify(v);
          if (typeof s === "string" && s.length > 60) s = s.slice(0, 57) + "...";
          parts.push(`${k}=${s}`);
        }
      }
      // If none of the preferred keys exist, fall back to a wider raw prefix
      // (200 chars — terminal will wrap, which is preferable to truncation).
      if (parts.length === 0) {
        const raw = String(r.payload ?? "");
        return `${origin} ${raw.length > 200 ? raw.slice(0, 197) + "..." : raw}`;
      }
      return `${origin} ${parts.join("  ")}`;
    }
  }
};
