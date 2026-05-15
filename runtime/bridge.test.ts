import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { getArtifact } from "./artifact_store";
import {
  BRAIN_READONLY_PERMISSION,
  materializeOpencodeMcpConfig,
  isBrainReadonlyToolAllowed,
  opencodeQuery,
  opencodeQueryMock,
  spawnRealOpencode,
  V2_OPENCODE_MCP_SERVER_NAME,
  V2_MCP_TOOL_SURFACE,
} from "./bridge";
import { newId } from "./ids";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const originalBridgeMode = process.env.ACC2_BRIDGE_MODE;
afterEach(() => {
  if (originalBridgeMode === undefined) delete process.env.ACC2_BRIDGE_MODE;
  else process.env.ACC2_BRIDGE_MODE = originalBridgeMode;
});

describe("bridge (Phase D mock, default mode)", () => {
  test("returns success for fixture_d_count_todos prompts and admits both artifacts", async () => {
    const db = openDb(":memory:");
    process.env.ACC2_BRIDGE_MODE = "mock";
    const result = await opencodeQuery(
      {
        prompt: "FIXTURE: fixture_d_count_todos — count TODOs",
        taskId: newId(),
        directiveId: newId(),
      },
      db,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.emitted_event_ids.length).toBeGreaterThan(0);
    }
    const admitted = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'code_artifact_admitted'")
      .get() as { c: number };
    expect(admitted.c).toBe(2);
    const predicted = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'action_predicted'")
      .get() as { c: number };
    expect(predicted.c).toBe(1);
  }, 30_000);

  test("returns success for the example.com title fetch prompt and admits both artifacts", async () => {
    const db = openDb(":memory:");
    process.env.ACC2_BRIDGE_MODE = "mock";
    const prompt = [
      "Fetch the URL https://example.com via Bun.fetch (the bun runtime).",
      "Parse the HTML response and extract the contents of the <title> tag.",
      "Return the observation as JSON in the shape { result: { title: string } }.",
      "Author TWO bun code artifacts:",
      "  1. ACTION artifact: a bun script using `Bun.fetch(\"https://example.com\")`",
      "  2. VERIFIER artifact: a bun script that reads the action's observation",
      "Admit both via substrate.admit_artifact and emit ONE action_predicted event",
    ].join("\n");

    const result = await opencodeQuery({ prompt, taskId: newId(), directiveId: newId() }, db);
    expect(result.ok).toBe(true);

    const admitted = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'code_artifact_admitted'")
      .get() as { c: number };
    expect(admitted.c).toBe(2);

    const predictedRows = db
      .query("SELECT action_artifact_id, verifier_artifact_id, payload FROM events WHERE kind = 'action_predicted'")
      .all() as Array<{ action_artifact_id: string | null; verifier_artifact_id: string | null; payload: string }>;
    expect(predictedRows.length).toBe(1);
    const predicted = predictedRows[0]!;
    expect(predicted.action_artifact_id).toBeTruthy();
    expect(predicted.verifier_artifact_id).toBeTruthy();

    const action = getArtifact(db, predicted.action_artifact_id!);
    const verifier = getArtifact(db, predicted.verifier_artifact_id!);
    expect(action?.body ?? "").toContain("Bun.fetch(\"https://example.com\")");
    expect(verifier?.body ?? "").toContain("ACC2_INPUTS");
  }, 30_000);

  test("returns mock_bridge_prompt_unrecognized for prompts without a fixture marker (Batch 3.CLEANUP)", async () => {
    const db = openDb(":memory:");
    process.env.ACC2_BRIDGE_MODE = "mock";
    const result = await opencodeQuery(
      { prompt: "some other directive", taskId: newId(), directiveId: newId() },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe("mock_bridge_prompt_unrecognized");
      if (result.reason.kind === "mock_bridge_prompt_unrecognized") {
        // The reason carries the supported-marker list so callers see why the
        // dispatch declined without grepping the bridge source.
        expect(result.reason.supported_markers.length).toBeGreaterThanOrEqual(2);
        expect(result.reason.supported_markers.some((m) => m.includes("fixture_d_count_todos"))).toBe(true);
        expect(result.reason.supported_markers.some((m) => m.includes("example.com"))).toBe(true);
      }
    }
    const failedRows = db
      .query("SELECT payload FROM events WHERE kind = 'bridge_failed' ORDER BY ts DESC LIMIT 1")
      .all() as Array<{ payload: string }>;
    expect(failedRows.length).toBe(1);
    const payload = JSON.parse(failedRows[0]!.payload) as Record<string, unknown>;
    // The substrate row mirrors the typed reason so log consumers can see the
    // unrecognized marker without reconstructing it from the BridgeResult shape.
    expect(payload.reason).toBe("mock_bridge_prompt_unrecognized");
    expect(Array.isArray(payload.supported_markers)).toBe(true);
  });

  test("explicit opencodeQueryMock entry stays callable for legacy callers", async () => {
    const db = openDb(":memory:");
    const result = await opencodeQueryMock(
      {
        prompt: "FIXTURE: fixture_d_count_todos — direct mock entry",
        taskId: newId(),
        directiveId: newId(),
      },
      db,
    );
    expect(result.ok).toBe(true);
  }, 30_000);
});

describe("bridge (real subprocess, opt-in via ACC2_BRIDGE_MODE=real)", () => {
  test("real spawn surface returns a structured failure when opencode is absent", async () => {
    const db = openDb(":memory:");
    // Inject a spawnFn that throws as if `opencode` weren't on PATH.
    const fakeSpawn = (() => {
      throw new Error("ENOENT: opencode not found");
    }) as unknown as typeof Bun.spawn;
    const result = await spawnRealOpencode(
      { prompt: "real-spawn probe", taskId: newId(), directiveId: newId() },
      db,
      {
        spawnFn: fakeSpawn,
        // Provide a stub MCP URL so the bridge proceeds to the spawn step
        // (which is where the fake spawn throws).
        mcpServerUrl: "http://127.0.0.1:1/mcp",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe("auth_missing");
    }
    const failed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'bridge_failed'")
      .get() as { c: number };
    expect(failed.c).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test("real spawn fails fast when V2_MCP_SERVER_URL is missing", async () => {
    const db = openDb(":memory:");
    // The bridge would refuse to invoke opencode without an MCP URL because
    // opencode would then have no v2 tool surface and the dispatch would
    // certainly hit `no_action_predicted`. Fail fast at the bridge instead.
    const originalUrl = process.env.V2_MCP_SERVER_URL;
    delete process.env.V2_MCP_SERVER_URL;
    try {
      const sentinel = {
        kill: () => {},
        stdout: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
        stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
        exited: Promise.resolve(0),
      };
      const fakeSpawn = (() => sentinel) as unknown as typeof Bun.spawn;
      const result = await spawnRealOpencode(
        { prompt: "no-mcp-url probe", taskId: newId(), directiveId: newId() },
        db,
        { spawnFn: fakeSpawn },
      );
      expect(result.ok).toBe(false);
      const failed = db
        .query(
          "SELECT payload FROM events WHERE kind = 'bridge_failed' ORDER BY ts DESC LIMIT 1",
        )
        .get() as { payload: string } | null;
      expect(failed).not.toBeNull();
      const payload = JSON.parse(failed!.payload) as Record<string, unknown>;
      expect(payload.reason).toBe("mcp_server_url_missing");
    } finally {
      if (originalUrl !== undefined) process.env.V2_MCP_SERVER_URL = originalUrl;
    }
  }, 10_000);

  test("real spawn materializes opencode-config.json declaring v2 MCP server and sets OPENCODE_CONFIG env", async () => {
    const db = openDb(":memory:");
    // Capture the args + env passed to spawn so we can assert the wiring.
    let capturedArgv: string[] | null = null;
    let capturedEnv: Record<string, string | undefined> | null = null;
    const sentinel = {
      kill: () => {},
      stdout: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      exited: Promise.resolve(0),
    };
    const fakeSpawn = ((argv: string[], opts: { env?: Record<string, string | undefined> }) => {
      capturedArgv = argv;
      capturedEnv = opts.env ?? null;
      return sentinel;
    }) as unknown as typeof Bun.spawn;

    const tmpConfigDir = mkdtempSync(join(tmpdir(), "acc2-bridge-test-cfg-"));
    try {
      // No MCP handshake will land (the fake spawn never emits stdout) so the
      // watchdog will fire. We don't care — we want the config-materialization
      // side effect, and the inspection below is synchronous.
      const result = await spawnRealOpencode(
        { prompt: "config probe", taskId: newId(), directiveId: newId() },
        db,
        {
          spawnFn: fakeSpawn,
          mcpServerUrl: "http://127.0.0.1:45678/mcp",
          configDir: tmpConfigDir,
          // Short handshake window so the test completes quickly when the
          // watchdog fires (the fake spawn never emits a tool_call).
          mcpHandshakeWindowMs: 200,
          // Disable the long dispatch watchdogs so the test exits as soon as
          // the handshake watchdog fires.
          timeoutMs: 1_000,
        },
      );
      // The bridge MUST have materialized the config file with v2's MCP
      // server declaration before reaching the spawn call. Read it back from
      // disk and assert the shape — cleanup happens in finally, but the
      // file exists during the test for inspection.
      const configPath = join(tmpConfigDir, "opencode-config.json");
      // Note: the bridge cleans up the tempdir after the subprocess exits,
      // so by the time await spawnRealOpencode returns, the file is gone.
      // Instead we assert on the captured env, which preserves the path the
      // bridge wrote even after cleanup.
      expect(capturedEnv).not.toBeNull();
      const env = capturedEnv!;
      expect(env.OPENCODE_CONFIG).toBe(configPath);
      expect(env.V2_MCP_SERVER_URL).toBe("http://127.0.0.1:45678/mcp");
      expect(env.MCP_SERVER_URL).toBe("http://127.0.0.1:45678/mcp");

      // The argv must NOT include any --mcp-* flag (we wire via env/config).
      expect(capturedArgv).not.toBeNull();
      const argv = capturedArgv!;
      expect(argv[0]).toBe("opencode");
      expect(argv[1]).toBe("run");
      expect(argv).toContain("--format=json");
      expect(argv).not.toContain("--dangerously-skip-permissions");
      expect(argv.find((a) => a.startsWith("--mcp"))).toBeUndefined();

      // The bridge always either returns ok=true or ok=false with a reason;
      // in this case the MCP handshake watchdog fires (no tool_call from the
      // fake spawn) so we get mcp_handshake_failed.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason.kind).toBe("subprocess_crash");
      }
      const failed = db
        .query(
          "SELECT payload FROM events WHERE kind = 'bridge_failed' ORDER BY ts DESC LIMIT 1",
        )
        .get() as { payload: string } | null;
      expect(failed).not.toBeNull();
      const payload = JSON.parse(failed!.payload) as Record<string, unknown>;
      expect(payload.reason).toBe("mcp_handshake_failed");
      expect(payload.mcp_server_url).toBe("http://127.0.0.1:45678/mcp");
    } finally {
      try { rmSync(tmpConfigDir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  }, 10_000);

  test("materializeOpencodeMcpConfig writes a valid opencode.json with v2's MCP server declaration", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "acc2-materialize-test-"));
    try {
      const { configPath, tempDir } = materializeOpencodeMcpConfig({
        mcpServerUrl: "http://127.0.0.1:9387/mcp",
        configDir: tmpDir,
      });
      expect(existsSync(configPath)).toBe(true);
      expect(tempDir).toBe(tmpDir);
      const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      expect(cfg.$schema).toBe("https://opencode.ai/config.json");
      expect(cfg.permission).toEqual(BRAIN_READONLY_PERMISSION);
      const mcp = cfg.mcp as Record<string, unknown>;
      expect(mcp).toBeDefined();
      const server = mcp[V2_OPENCODE_MCP_SERVER_NAME] as Record<string, unknown>;
      expect(server).toBeDefined();
      expect(server.type).toBe("remote");
      expect(server.url).toBe("http://127.0.0.1:9387/mcp");
      expect(server.enabled).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("brain readonly permission policy blocks direct source edits while preserving read-only and MCP tools", () => {
    expect(isBrainReadonlyToolAllowed("read")).toBe(true);
    expect(isBrainReadonlyToolAllowed("glob")).toBe(true);
    expect(isBrainReadonlyToolAllowed("grep")).toBe(true);
    expect(isBrainReadonlyToolAllowed("list")).toBe(true);
    expect(isBrainReadonlyToolAllowed("substrate.search")).toBe(true);
    expect(isBrainReadonlyToolAllowed("runtime.run_artifact")).toBe(true);
    expect(isBrainReadonlyToolAllowed("acc2-substrate_substrate_emit")).toBe(true);
    expect(isBrainReadonlyToolAllowed("acc2-substrate_runtime_dispatch_ready_task")).toBe(true);

    // This is the verifier shape for the owner-reported failure: a brain that
    // tries to patch source or commit from its opencode process must be denied.
    expect(isBrainReadonlyToolAllowed("edit")).toBe(false);
    expect(isBrainReadonlyToolAllowed("write")).toBe(false);
    expect(isBrainReadonlyToolAllowed("apply_patch")).toBe(false);
    expect(isBrainReadonlyToolAllowed("bash")).toBe(false);
    expect(isBrainReadonlyToolAllowed("task")).toBe(false);
    expect(isBrainReadonlyToolAllowed("repo_clone")).toBe(false);
    expect(isBrainReadonlyToolAllowed("unknown_future_write_tool")).toBe(false);
  });

  test("no-progress watchdog fires bridge_stuck when subprocess emits zero frames within stuckThresholdMs", async () => {
    const db = openDb(":memory:");
    // Build a fake subprocess that stays alive (`exited` resolves only after
    // we signal it) and emits NO stdout. This simulates the wedge symptom the
    // harness --task surfaced: subprocess running, no progress, no signal to
    // the operator until the 600s overall watchdog fires.
    let resolveExit: ((code: number) => void) | null = null;
    const exitedPromise = new Promise<number>((resolve) => { resolveExit = resolve; });
    let killed = false;
    const sentinel = {
      kill: (_signal?: string) => {
        if (killed) return;
        killed = true;
        // Simulate the subprocess receiving SIGTERM and exiting after a tick.
        setTimeout(() => resolveExit?.(143), 1);
      },
      stdout: {
        getReader: () => ({
          read: async () => {
            // Block until the subprocess exits (mirroring real stdout EOF
            // semantics — the reader resolves with done=true on exit).
            await exitedPromise;
            return { done: true, value: undefined };
          },
        }),
      },
      stderr: {
        getReader: () => ({
          read: async () => {
            await exitedPromise;
            return { done: true, value: undefined };
          },
        }),
      },
      exited: exitedPromise,
    };
    const fakeSpawn = (() => sentinel) as unknown as typeof Bun.spawn;

    const before = Date.now();
    const result = await spawnRealOpencode(
      { prompt: "stuck probe", taskId: newId(), directiveId: newId() },
      db,
      {
        spawnFn: fakeSpawn,
        mcpServerUrl: "http://127.0.0.1:1/mcp",
        // Short stuck thresholds so the test runs fast. The first-frame
        // budget governs the pre-handshake wedge path; without a frame
        // ever landing, the watchdog must use this budget. 200ms is well
        // under the 10s timeoutMs ceiling.
        stuckThresholdMs: 200,
        firstFrameThresholdMs: 200,
        // Long handshake + dispatch watchdogs so they don't fire first; the
        // stuck path must be the one that surfaces.
        mcpHandshakeWindowMs: 10_000,
        timeoutMs: 10_000,
      },
    );
    const elapsed = Date.now() - before;
    // The stuck watchdog fires its first poll within max(500ms, threshold/4)
    // so the run should complete well below the 10s dispatch timeout. The
    // upper bound below leaves slack for slow CI runners.
    expect(elapsed).toBeLessThan(5_000);
    expect(result.ok).toBe(false);

    // A bridge_stuck event was emitted with reason=no_frames_received.
    // Because no frame ever landed, the first-frame tier fired.
    const stuckRow = db
      .query("SELECT payload FROM events WHERE kind = 'bridge_stuck' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(stuckRow).not.toBeNull();
    const stuckPayload = JSON.parse(stuckRow!.payload) as Record<string, unknown>;
    expect(stuckPayload.reason).toBe("no_frames_received");
    expect(typeof stuckPayload.elapsed_ms).toBe("number");
    expect(stuckPayload.threshold_ms).toBe(200);
    expect(stuckPayload.first_frame_seen).toBe(false);
    expect(stuckPayload.tier).toBe("first_frame");

    // The bridge_failed taxonomy entry carries the subprocess_stuck reason.
    const failedRow = db
      .query("SELECT payload FROM events WHERE kind = 'bridge_failed' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(failedRow).not.toBeNull();
    const failedPayload = JSON.parse(failedRow!.payload) as Record<string, unknown>;
    expect(failedPayload.reason).toBe("subprocess_stuck");
    expect(failedPayload.no_frames_received).toBe(true);
    expect(failedPayload.first_frame_seen).toBe(false);
    expect(failedPayload.tier).toBe("first_frame");
  }, 15_000);

  test("v2 MCP tool surface advertises every substrate.* and runtime.* tool the daemon exposes", () => {
    // Defensive: the brain prompt composer ships V2_MCP_TOOL_SURFACE as a
    // discovery hint. Keep this list in sync with runtime/mcp_server.ts —
    // when a new tool lands there, append it here so the hint stays
    // accurate. This test surfaces accidental drift.
    const expected = [
      "substrate.emit",
      "substrate.read",
      "substrate.get_event",
      "substrate.get_artifact",
      "substrate.search",
      "substrate.embed_text",
      "substrate.run_artifact",
      "substrate.run_verifier",
      "substrate.credit",
      "substrate.admit_artifact",
      "substrate.open_fixture",
      "substrate.amend_directive",
      "substrate.record_stakeholder_state",
      "substrate.record_interference_edge",
      "substrate.open_directive",
      "substrate.find_recipe",
      "substrate.register_external_source",
      "runtime.dispatch_ready_task",
      "runtime.scheduler_tick",
      "runtime.process_rolling_reviews",
      "runtime.father_iterate",
      "runtime.detect_father_drift",
      "runtime.replay_recipe",
      "runtime.recent_events",
    ];
    expect([...V2_MCP_TOOL_SURFACE].sort()).toEqual([...expected].sort());
  });

  test("auth pre-flight: opencode has no auth providers → HIDL emitted and dispatch skipped", async () => {
    const db = openDb(":memory:");
    // Track whether spawn was even called. The pre-flight check must short
    // the dispatch BEFORE the subprocess is touched — wasted process cost is
    // the failure mode the HIDL surface is meant to prevent.
    let spawnCalled = 0;
    const fakeSpawn = (() => {
      spawnCalled++;
      throw new Error("spawn should never have been called once auth pre-flight fails");
    }) as unknown as typeof Bun.spawn;
    const result = await spawnRealOpencode(
      { prompt: "auth-preflight probe", taskId: newId(), directiveId: newId() },
      db,
      {
        spawnFn: fakeSpawn,
        mcpServerUrl: "http://127.0.0.1:1/mcp",
        // Inject a probe that reports zero credentials + zero env providers
        // — the canonical auth_missing shape.
        authProbe: () => ({ credentialCount: 0, envProviderCount: 0 }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.kind).toBe("auth_missing");
    expect(spawnCalled).toBe(0);

    // HIDL row exists with reason=auth_missing and mirror-inline visibility.
    const hidl = db
      .query(
        `SELECT payload FROM events
         WHERE kind = 'hidl_action_required'
         ORDER BY ts DESC LIMIT 1`,
      )
      .get() as { payload: string } | null;
    expect(hidl).not.toBeNull();
    const hidlPayload = JSON.parse(hidl!.payload) as Record<string, unknown>;
    expect(hidlPayload.reason).toBe("auth_missing");
    expect(typeof hidlPayload.summary).toBe("string");
    expect(String(hidlPayload.suggested_action)).toContain("opencode auth login");

    // bridge_failed row was also emitted carrying the pre-flight reason.
    const failed = db
      .query("SELECT payload FROM events WHERE kind = 'bridge_failed' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(failed).not.toBeNull();
    const failedPayload = JSON.parse(failed!.payload) as Record<string, unknown>;
    expect(failedPayload.reason).toBe("auth_missing");
    expect(failedPayload.mcp_handshake_ok).toBe(false);
  }, 5_000);

  test("auth pre-flight: probe returns null (unknown) → dispatch proceeds, no HIDL emitted", async () => {
    const db = openDb(":memory:");
    // Null probe = transient probe glitch / opencode binary missing. The
    // bridge must NOT short-circuit on this — the downstream spawn / exit
    // paths surface the gap if it materialises there.
    let spawnCalled = 0;
    const sentinel = {
      kill: () => {},
      stdout: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      exited: Promise.resolve(0),
    };
    const fakeSpawn = (() => { spawnCalled++; return sentinel; }) as unknown as typeof Bun.spawn;
    await spawnRealOpencode(
      { prompt: "auth-probe-null", taskId: newId(), directiveId: newId() },
      db,
      {
        spawnFn: fakeSpawn,
        mcpServerUrl: "http://127.0.0.1:1/mcp",
        authProbe: () => null,
        mcpHandshakeWindowMs: 100,
        firstFrameThresholdMs: 100,
        timeoutMs: 1_000,
      },
    );
    expect(spawnCalled).toBe(1);
    const hidlCount = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'hidl_action_required'")
      .get() as { c: number };
    expect(hidlCount.c).toBe(0);
  }, 5_000);

  test("auth post-flight: opencode exits non-zero with auth-shaped stderr → HIDL reason=auth_expired", async () => {
    const db = openDb(":memory:");
    // Build a fake subprocess that exits non-zero with stderr matching a
    // canonical auth-shaped error string (401 + "unauthorized"). The bridge
    // must promote this to a HIDL emission with reason=auth_expired —
    // distinct from the pre-flight `auth_missing` so the ledger preserves
    // WHEN the auth went bad.
    const stderrBytes = new TextEncoder().encode(
      "Error: 401 Unauthorized — authentication failed (token may be expired)\n",
    );
    const sentinel = {
      kill: () => {},
      stdout: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      stderr: {
        getReader: () => {
          let delivered = false;
          return {
            read: async () => {
              if (delivered) return { done: true, value: undefined };
              delivered = true;
              return { done: false, value: stderrBytes };
            },
          };
        },
      },
      exited: Promise.resolve(1),
    };
    const fakeSpawn = (() => sentinel) as unknown as typeof Bun.spawn;
    const result = await spawnRealOpencode(
      { prompt: "auth-postflight probe", taskId: newId(), directiveId: newId() },
      db,
      {
        spawnFn: fakeSpawn,
        mcpServerUrl: "http://127.0.0.1:1/mcp",
        // Probe says auth is configured — the post-flight path is the one
        // we're exercising.
        authProbe: () => ({ credentialCount: 1, envProviderCount: 0 }),
        mcpHandshakeWindowMs: 100,
        firstFrameThresholdMs: 100,
        timeoutMs: 1_000,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.kind).toBe("auth_missing");

    const hidl = db
      .query(
        `SELECT payload FROM events
         WHERE kind = 'hidl_action_required'
         ORDER BY ts DESC LIMIT 1`,
      )
      .get() as { payload: string } | null;
    expect(hidl).not.toBeNull();
    const hidlPayload = JSON.parse(hidl!.payload) as Record<string, unknown>;
    expect(hidlPayload.reason).toBe("auth_expired");
    expect(String(hidlPayload.summary).toLowerCase()).toContain("auth");

    // bridge_failed row carries reason=auth_expired (distinct from the
    // pre-Bridge default subprocess_crash bucket).
    const failed = db
      .query("SELECT payload FROM events WHERE kind = 'bridge_failed' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(failed).not.toBeNull();
    const failedPayload = JSON.parse(failed!.payload) as Record<string, unknown>;
    expect(failedPayload.reason).toBe("auth_expired");
  }, 5_000);

  test("HIDL idempotency: two auth failures within one hour emit only one HIDL row", async () => {
    const db = openDb(":memory:");
    let spawnCalled = 0;
    const fakeSpawn = (() => {
      spawnCalled++;
      throw new Error("spawn should not run when pre-flight short-circuits");
    }) as unknown as typeof Bun.spawn;
    const baseOpts = {
      spawnFn: fakeSpawn,
      mcpServerUrl: "http://127.0.0.1:1/mcp",
      authProbe: () => ({ credentialCount: 0, envProviderCount: 0 }),
    };
    await spawnRealOpencode(
      { prompt: "idem-1", taskId: newId(), directiveId: newId() },
      db,
      baseOpts,
    );
    await spawnRealOpencode(
      { prompt: "idem-2", taskId: newId(), directiveId: newId() },
      db,
      baseOpts,
    );
    expect(spawnCalled).toBe(0);
    const hidlCount = db
      .query(
        `SELECT COUNT(*) as c FROM events
         WHERE kind = 'hidl_action_required'
           AND json_extract(payload, '$.reason') = 'auth_missing'`,
      )
      .get() as { c: number };
    // Two dispatch attempts, one HIDL row — the canonical idempotency shape.
    expect(hidlCount.c).toBe(1);
    // Both attempts still emit their bridge_failed taxonomy rows (the dispatch
    // outcome must be observable on every call); idempotency lives on the
    // owner-facing HIDL surface only.
    const failedCount = db
      .query(
        `SELECT COUNT(*) as c FROM events
         WHERE kind = 'bridge_failed'
           AND json_extract(payload, '$.reason') = 'auth_missing'`,
      )
      .get() as { c: number };
    expect(failedCount.c).toBe(2);
  }, 5_000);
});
