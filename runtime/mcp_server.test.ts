// acc2 MCP server test — exercises the fastmcp surface via stdio transport.
//
// The production daemon binds fastmcp on httpStream + a sibling Bun.serve for
// /external/push, /health, /shutdown. Tests use the stdio transport against
// the SAME FastMCP instance so we don't have to pick free ports per test or
// race the Streamable-HTTP handshake — we get end-to-end protocol coverage
// (ListTools, CallTool, schema rejection) without an HTTP socket.
//
// The MCP-standard client used here is `@modelcontextprotocol/sdk/client` (a
// transitive dep of fastmcp). It opens an stdio pair against a child bun
// process running `mcp_server_stdio_entry.ts`, which boots a fresh in-memory
// SQLite + a fastmcp server on stdio. Each test isolates state via a fresh
// child process so concurrent test files cannot bleed into each other.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpMethods } from "./mcp_server";

const STDIO_ENTRY = join(import.meta.dir, "mcp_server_stdio_entry.ts");

type ToolCallResponse = { content: Array<{ type: string; text?: string }> };

type Harness = {
  client: Client;
  transport: StdioClientTransport;
  dir: string;
  dbPath: string;
};

const spawnHarness = async (): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), "acc2-mcp-stdio-"));
  const dbPath = join(dir, "mcp.db");
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", STDIO_ENTRY],
    env: {
      ...process.env,
      ACC2_TEST_DB_PATH: dbPath,
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "acc2-test-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport, dir, dbPath };
};

const closeHarness = async (h: Harness): Promise<void> => {
  try { await h.client.close(); } catch { /* swallow */ }
  try { await h.transport.close(); } catch { /* swallow */ }
  rmSync(h.dir, { recursive: true, force: true });
};

/** Parse the JSON-stringified McpResult that every tool returns as its first
 *  text-content block. fastmcp ships strings as one TextContent entry. */
const parseEnvelope = (res: ToolCallResponse): { ok: boolean; result?: any; error?: string } => {
  const first = res.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`unexpected MCP content shape: ${JSON.stringify(res)}`);
  }
  return JSON.parse(first.text);
};

describe("fastmcp substrate tools — stdio transport", () => {
  let h: Harness | null = null;

  beforeEach(async () => { h = await spawnHarness(); });
  afterEach(async () => { if (h) await closeHarness(h); h = null; });

  test("ListTools exposes every substrate method exactly once", async () => {
    const listed = await h!.client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    const expected = [...McpMethods].sort();
    expect(names).toEqual(expected);
    // Each tool advertises its zod-derived input schema.
    for (const tool of listed.tools) {
      expect(tool.inputSchema).toBeTruthy();
      expect(typeof tool.inputSchema).toBe("object");
    }
  });

  test("substrate.emit inserts an event and returns its id + ts", async () => {
    const res = (await h!.client.callTool({
      name: "substrate.emit",
      arguments: { kind: "owner_input_received", payload: { text: "hello" } },
    })) as ToolCallResponse;
    const env = parseEnvelope(res);
    expect(env.ok).toBe(true);
    expect(typeof env.result.id).toBe("string");
    expect(env.result.id.length).toBeGreaterThan(0);
    expect(typeof env.result.ts).toBe("string");
  });

  test("substrate.emit flat-shape action_predicted carries action_artifact_id / verifier_artifact_id / predicted_residual (Batch 2.β)", async () => {
    // opencode 1.4+ flattens MCP tool schemas — the brain calls
    // substrate.emit with top-level arguments, not a nested `{event:{...}}`.
    // Before Batch 2.β the FLAT schema dropped the artifact-id and residual
    // fields, leaving action_predicted half-baked (the dispatcher then could
    // not find the artifacts and emitted no action). This test pins the fix.
    const emit = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.emit",
        arguments: {
          kind: "action_predicted",
          substrate_origin: "opencode",
          directive_id: "d_flat_batch_2b",
          task_id: "t_flat_batch_2b",
          action_artifact_id: "ca_flat_action_id_001",
          verifier_artifact_id: "cv_flat_verifier_id_002",
          predicted_residual: 0.05,
          payload: { intent: "flat-shape probe" },
        },
      })) as ToolCallResponse,
    );
    expect(emit.ok).toBe(true);
    const got = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.get_event",
        arguments: { id: emit.result.id as string },
      })) as ToolCallResponse,
    );
    expect(got.ok).toBe(true);
    expect(got.result.kind).toBe("action_predicted");
    expect(got.result.action_artifact_id).toBe("ca_flat_action_id_001");
    expect(got.result.verifier_artifact_id).toBe("cv_flat_verifier_id_002");
    expect(got.result.predicted_residual).toBe(0.05);
  });

  test("substrate.get_event round-trips the event we just emitted", async () => {
    const emit = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.emit",
        arguments: { kind: "owner_input_received", payload: { text: "round-trip" } },
      })) as ToolCallResponse,
    );
    const id = emit.result.id as string;
    const got = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.get_event",
        arguments: { id },
      })) as ToolCallResponse,
    );
    expect(got.ok).toBe(true);
    expect(got.result.id).toBe(id);
    expect(got.result.kind).toBe("owner_input_received");
    expect(got.result.payload.text).toBe("round-trip");
  });

  test("substrate.get_event with an unknown id returns ok:false event_not_found", async () => {
    const env = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.get_event",
        arguments: { id: "doesnotexist000000000000" },
      })) as ToolCallResponse,
    );
    expect(env.ok).toBe(false);
    expect(env.error).toBe("event_not_found");
  });

  test("substrate.run_artifact returns artifact_not_found for an unknown id", async () => {
    const env = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.run_artifact",
        arguments: { artifact_id: "anything" },
      })) as ToolCallResponse,
    );
    expect(env.ok).toBe(false);
    expect(env.error).toBe("artifact_not_found");
  });

  test("substrate.run_verifier returns artifact_not_found for an unknown id", async () => {
    const env = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.run_verifier",
        arguments: { verifier_artifact_id: "anything" },
      })) as ToolCallResponse,
    );
    expect(env.ok).toBe(false);
    expect(env.error).toBe("artifact_not_found");
  });

  test("substrate.admit_artifact + substrate.run_artifact light up the bun runtime end-to-end", async () => {
    // Admit a tiny artifact that echoes its inputs and prints the result marker.
    const body = [
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null');",
      "console.log('@@RESULT@@ ' + JSON.stringify({ value: (inputs?.x ?? 0) + 1 }));",
    ].join("\n");
    const admit = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.admit_artifact",
        arguments: {
          runtime: "bun",
          body,
          declared_sandbox: {
            runtime: "bun",
            cpu_ms: 2000,
            wall_ms: 5000,
            memory_mb: 128,
          },
          fixture_input: { x: 1 },
          fixture_expected_residual_below: 0.2,
        },
      })) as ToolCallResponse,
    );
    expect(admit.ok).toBe(true);
    const artifactId = admit.result.artifact_id as string;
    expect(typeof artifactId).toBe("string");

    const run = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.run_artifact",
        arguments: { artifact_id: artifactId, inputs: { x: 41 } },
      })) as ToolCallResponse,
    );
    expect(run.ok).toBe(true);
    expect(run.result.ok).toBe(true);
    expect(run.result.result.value).toBe(42);
  });

  test("substrate.run_artifact routes uv-runtime artifacts (admit-or-skip when uv absent)", async () => {
    // Phase G: a uv-runtime artifact admits when uv is on PATH, otherwise the
    // admission cleanly refuses with `runtime_unavailable`. Either branch
    // proves the dispatch is wired (vs. the Phase-C stub returning
    // `phase_g_runtime_unsupported`).
    const body = "result = inputs.get('x', 0) + 1\nprint('@@RESULT@@ ' + json.dumps({'value': result}))";
    const admit = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.admit_artifact",
        arguments: {
          runtime: "uv",
          body,
          declared_sandbox: {
            runtime: "uv",
            cpu_ms: 5000, wall_ms: 15000, memory_mb: 256,
          },
          fixture_input: { x: 1 },
          fixture_expected_residual_below: 0.2,
        },
      })) as ToolCallResponse,
    );
    if (admit.ok) {
      // uv is installed — round-trip works.
      const run = parseEnvelope(
        (await h!.client.callTool({
          name: "substrate.run_artifact",
          arguments: { artifact_id: admit.result.artifact_id, inputs: { x: 41 } },
        })) as ToolCallResponse,
      );
      expect(run.ok).toBe(true);
      expect(run.result.ok).toBe(true);
      expect(run.result.result.value).toBe(42);
    } else {
      // uv absent — admission must surface runtime_unavailable, NOT the old
      // phase_g_runtime_unsupported error string.
      expect(admit.error).toContain("runtime_unavailable");
    }
  });

  test("substrate.run_artifact routes camofox-runtime artifacts cleanly (playwright-gated)", async () => {
    // Phase G: a camofox-browser artifact admits only when playwright is
    // installed. The default test harness has no playwright, so admission
    // must refuse with `runtime_unavailable` — but the dispatch must NOT
    // throw or return the old `phase_g_runtime_unsupported`.
    const admit = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.admit_artifact",
        arguments: {
          runtime: "camofox-browser",
          body: "await session.goto(inputs.url); console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));",
          declared_sandbox: {
            runtime: "camofox-browser",
            browser_allow_domains: ["example.com"],
            browser_profile_root: "/tmp/acc2-mcp-test-profile",
            wall_ms: 30000,
            memory_mb: 1024,
          },
          fixture_input: { url: "https://example.com" },
          fixture_expected_residual_below: 0.2,
        },
      })) as ToolCallResponse,
    );
    if (!admit.ok) {
      expect(admit.error).toContain("runtime_unavailable");
    }
  });

  test("substrate.credit rejects malformed args (Phase H wired)", async () => {
    // The Phase H pipeline requires five typed fields; calling with an empty
    // arg map must raise an MCP InputValidationError before the handler runs.
    let threw = false;
    try {
      await h!.client.callTool({
        name: "substrate.credit",
        arguments: {},
      });
    } catch (err) {
      threw = true;
      // The error message references the missing fields.
      expect(String(err)).toContain("action_event_id");
    }
    expect(threw).toBe(true);
  });

  test("substrate.credit returns credit_distribution_failed on unknown action_event_id", async () => {
    const env = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.credit",
        arguments: {
          action_event_id: "does_not_exist",
          observation_event_id: "x",
          scored_event_id: "y",
          predicted_residual: 0.1,
          observed_residual: 0.1,
        },
      })) as ToolCallResponse,
    );
    expect(env.ok).toBe(false);
    expect(env.error).toContain("credit_distribution_failed");
  });

  test("substrate.read with unknown view returns view_not_implemented", async () => {
    const env = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.read",
        arguments: { view_name: "judgment_packet" },
      })) as ToolCallResponse,
    );
    expect(env.ok).toBe(false);
    expect(env.error).toContain("view_not_implemented:");
  });

  test("substrate.search returns the recent-events stub shape", async () => {
    await h!.client.callTool({
      name: "substrate.emit",
      arguments: { kind: "owner_input_received", payload: { text: "a" } },
    });
    await h!.client.callTool({
      name: "substrate.emit",
      arguments: { kind: "owner_input_received", payload: { text: "b" } },
    });
    const env = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.search",
        arguments: { query: "anything", opts: { k: 5 } },
      })) as ToolCallResponse,
    );
    expect(env.ok).toBe(true);
    expect(env.result.mode).toBe("recent_events_stub");
    expect(Array.isArray(env.result.hits)).toBe(true);
    expect(env.result.hits.length).toBeGreaterThanOrEqual(2);
  });

  test("calling an unknown tool surfaces an MCP error (not a silent success)", async () => {
    let threw = false;
    try {
      await h!.client.callTool({
        name: "substrate.does_not_exist",
        arguments: {},
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("substrate.get_event with missing required parameters is rejected by the schema", async () => {
    // `substrate.get_event` requires `id`. Calling with no arguments must
    // fail the schema check before reaching the handler.
    let threw = false;
    try {
      await h!.client.callTool({
        name: "substrate.get_event",
        arguments: {},
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("runtime.scheduler_tick returns the SchedulerTick shape on an empty substrate", async () => {
    const res = (await h!.client.callTool({
      name: "runtime.scheduler_tick",
      arguments: { max_concurrent: 5 },
    })) as ToolCallResponse;
    const env = parseEnvelope(res);
    expect(env.ok).toBe(true);
    expect(Array.isArray(env.result.dispatched)).toBe(true);
    expect(Array.isArray(env.result.in_flight)).toBe(true);
    expect(Array.isArray(env.result.skipped_concurrency_cap)).toBe(true);
    expect(Array.isArray(env.result.skipped_recipe)).toBe(true);
    expect(Array.isArray(env.result.skipped_inline)).toBe(true);
  });

  test("substrate.open_directive opens a directive + root task and emits crisis_mode_engaged when urgency=crisis", async () => {
    const res = (await h!.client.callTool({
      name: "substrate.open_directive",
      arguments: {
        directive_text: "medical emergency",
        urgency: "crisis",
        initial_task_goal: "triage",
      },
    })) as ToolCallResponse;
    const env = parseEnvelope(res);
    expect(env.ok).toBe(true);
    expect(typeof env.result.directive_id).toBe("string");
    expect(typeof env.result.task_id).toBe("string");

    // Read the directive_opened back via substrate.get_event.
    const id = env.result.directive_id;
    const search = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.search",
        arguments: { query: "crisis", opts: { k: 50 } },
      })) as ToolCallResponse,
    );
    const seenKinds = new Set(search.result.hits.map((h: any) => h.kind));
    expect(seenKinds.has("crisis_mode_engaged")).toBe(true);
    expect(typeof id).toBe("string");
  });

  test("substrate.record_stakeholder_state records and detects conflicts", async () => {
    const dir = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.open_directive",
        arguments: { directive_text: "negotiate salary" },
      })) as ToolCallResponse,
    );
    const directiveId = dir.result.directive_id;

    const first = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.record_stakeholder_state",
        arguments: {
          directive_id: directiveId,
          stakeholder_id: "self",
          declared_utility: { min_salary: 280000 },
        },
      })) as ToolCallResponse,
    );
    expect(first.ok).toBe(true);
    expect(first.result.conflict_count).toBe(0);

    const second = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.record_stakeholder_state",
        arguments: {
          directive_id: directiveId,
          stakeholder_id: "counterpart",
          declared_utility: { max_salary: 200000 },
        },
      })) as ToolCallResponse,
    );
    expect(second.ok).toBe(true);
    expect(second.result.conflict_count).toBeGreaterThan(0);
  });

  test("substrate.record_interference_edge rejects self-loops and records valid edges", async () => {
    const a = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.open_directive",
        arguments: { directive_text: "A" },
      })) as ToolCallResponse,
    );
    const b = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.open_directive",
        arguments: { directive_text: "B" },
      })) as ToolCallResponse,
    );
    const self = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.record_interference_edge",
        arguments: {
          from_directive: a.result.directive_id,
          to_directive: a.result.directive_id,
          kind: "blocks",
          reason: "no",
        },
      })) as ToolCallResponse,
    );
    expect(self.ok).toBe(false);

    const valid = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.record_interference_edge",
        arguments: {
          from_directive: a.result.directive_id,
          to_directive: b.result.directive_id,
          kind: "depletes",
          reason: "shared budget",
        },
      })) as ToolCallResponse,
    );
    expect(valid.ok).toBe(true);
    expect(typeof valid.result.event_id).toBe("string");
  });

  test("runtime.process_rolling_reviews returns the summary shape", async () => {
    const res = (await h!.client.callTool({
      name: "runtime.process_rolling_reviews",
      arguments: { now: "2026-05-13T12:00:00.000Z" },
    })) as ToolCallResponse;
    const env = parseEnvelope(res);
    expect(env.ok).toBe(true);
    expect(typeof env.result.reviews_opened).toBe("number");
    expect(typeof env.result.missed_advanced).toBe("number");
  });

  test("substrate.amend_directive opens new tasks and supersedes named ones", async () => {
    // Seed a directive + a task via substrate.emit so the amendment has
    // something to supersede / a root to attach new tasks to.
    const dirRes = (await h!.client.callTool({
      name: "substrate.emit",
      arguments: {
        kind: "directive_opened",
        directive_id: "d_amend_test",
        task_id: "d_amend_test",
        payload: { directive_text: "original goal", lifecycle: "finite" },
      },
    })) as ToolCallResponse;
    expect(parseEnvelope(dirRes).ok).toBe(true);

    await h!.client.callTool({
      name: "substrate.emit",
      arguments: {
        kind: "task_node_opened",
        directive_id: "d_amend_test",
        task_id: "t_root_amend",
        payload: { goal: "root", lifecycle: "finite" },
      },
    });
    await h!.client.callTool({
      name: "substrate.emit",
      arguments: {
        kind: "task_node_opened",
        directive_id: "d_amend_test",
        task_id: "t_will_be_superseded",
        payload: { goal: "will-be-superseded", lifecycle: "finite" },
      },
    });

    const amend = (await h!.client.callTool({
      name: "substrate.amend_directive",
      arguments: {
        original_directive_id: "d_amend_test",
        amendment_text: "narrow scope",
        superseded_tasks: ["t_will_be_superseded"],
        new_task_goals: ["alpha", "beta"],
        rationale: "owner reframed",
      },
    })) as ToolCallResponse;
    const env = parseEnvelope(amend);
    expect(env.ok).toBe(true);
    expect(env.result.superseded_tasks_closed).toContain("t_will_be_superseded");
    expect(env.result.new_tasks_opened.length).toBe(2);
    expect(env.result.already_applied).toBe(false);
  });

  test("Phase K: runtime.father_iterate opens a templated directive on an empty substrate", async () => {
    const res = (await h!.client.callTool({
      name: "runtime.father_iterate",
      arguments: { now: "2026-05-13T12:00:00.000Z" },
    })) as ToolCallResponse;
    const env = parseEnvelope(res);
    expect(env.ok).toBe(true);
    expect(typeof env.result.cycle_id).toBe("string");
    expect(["compile_directive_from_template", "yield"]).toContain(env.result.action);
  });

  test("Phase K: runtime.detect_father_drift returns a structured report", async () => {
    const res = (await h!.client.callTool({
      name: "runtime.detect_father_drift",
      arguments: {},
    })) as ToolCallResponse;
    const env = parseEnvelope(res);
    expect(env.ok).toBe(true);
    expect(typeof env.result.drift_count).toBe("number");
    expect(Array.isArray(env.result.offending_event_ids)).toBe(true);
  });

  test("Phase J: substrate.find_recipe returns null when no matching recipe exists", async () => {
    // Open a fresh directive + task so the find_recipe handler has something
    // to project against.
    const dir = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.open_directive",
        arguments: { directive_text: "no-recipe directive" },
      })) as ToolCallResponse,
    );
    const taskId = dir.result.task_id;
    const res = (await h!.client.callTool({
      name: "substrate.find_recipe",
      arguments: { task_id: taskId },
    })) as ToolCallResponse;
    const env = parseEnvelope(res);
    expect(env.ok).toBe(true);
    expect(env.result).toBeNull();
  });

  test("Phase J: substrate.find_recipe returns task_not_found for an unknown task_id", async () => {
    const res = (await h!.client.callTool({
      name: "substrate.find_recipe",
      arguments: { task_id: "00000000000000000000000000" },
    })) as ToolCallResponse;
    const env = parseEnvelope(res);
    expect(env.ok).toBe(false);
    expect(env.error).toBe("task_not_found");
  });
});
