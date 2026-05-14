// acc2 MCP server — fastmcp-based, exposed as native MCP tools.
//
// Per v2-design.md §11.1 the daemon hosts ONE MCP server that BOTH Claude Code
// and opencode connect to as native MCP clients. This file constructs that
// server using `fastmcp` (https://github.com/punkpeye/fastmcp). Each substrate
// method (`substrate.emit`, `substrate.read`, `substrate.get_event`,
// `substrate.get_artifact`, `substrate.search`, `substrate.run_artifact`,
// `substrate.run_verifier`, `substrate.credit`) is exposed as a fastmcp tool
// with a `z.object(...)` parameter schema; `execute` returns a JSON-stringified
// `McpResult` so callers see one uniform `{ok, result|error}` shape.
//
// Phases (substrate-API surface only — wire-up is in daemon.ts):
//   - B3 (now): substrate.emit, substrate.read (stub), substrate.get_event,
//     substrate.get_artifact, substrate.search (recent-events stand-in).
//   - C: substrate.run_artifact / substrate.run_verifier (lit up by the
//     bun runtime + sandbox + artifact_store) — still stubs here.
//   - H: substrate.credit (the credit pipeline) — still a stub here.
//
// Transport choices:
//   - `httpStream` for daemon production (Claude Code + opencode connect over
//     a port; fastmcp's HTTP streaming transport is the MCP-standard wire).
//   - `stdio` for in-process tests (spawn the same FastMCP instance, attach an
//     MCP Client via StdioClientTransport, list/call tools). This is the same
//     binary; only the transport differs.

import type { Database } from "bun:sqlite";
import { FastMCP } from "fastmcp";
import { z } from "zod";
import type { JsonValue, Runtime, SandboxDecl, SubstrateOrigin } from "../substrate/types";
import { emitEvent, getEventById, type EmitEventInput } from "./events";
import { runBunArtifact } from "./runtimes/bun";
import { getArtifact } from "./artifact_store";
import { admitArtifact } from "./artifact_admission";

export type McpContext = {
  db: Database;
  /** Caller for any audit event we synthesize. CLI clients default to
   *  `claude_root`; the brain bridge tags `opencode`. */
  invoker: SubstrateOrigin;
};

export type McpResult =
  | { ok: true; result: JsonValue }
  | { ok: false; error: string };

// ── Method names (single source of truth for the whitelist) ────────

export const McpMethods = [
  "substrate.emit",
  "substrate.read",
  "substrate.get_event",
  "substrate.get_artifact",
  "substrate.search",
  "substrate.run_artifact",
  "substrate.run_verifier",
  "substrate.credit",
  "substrate.admit_artifact",
] as const;
export type McpMethodName = (typeof McpMethods)[number];

// ── Parameter schemas (zod, per v2-design.md §13.2) ────────────────

// substrate.emit accepts an `event` object, OR — for ergonomic CLI use — the
// event fields directly at the top level. Both shapes are supported; the
// `event` wrapper takes precedence when present.
const EmitEventSchema = z.object({
  kind: z.string(),
  payload: z.unknown().optional(),
  directive_id: z.string().optional(),
  task_id: z.string().optional(),
  parent_task_id: z.string().nullable().optional(),
  loop_id: z.string().optional(),
  substrate_origin: z.string().optional(),
  context_refs: z.array(z.string()).optional(),
  predicted_residual: z.number().optional(),
  action_artifact_id: z.string().optional(),
  verifier_artifact_id: z.string().optional(),
  outcome: z.string().optional(),
  residual: z.number().optional(),
});

const EmitSchema = z.object({
  event: EmitEventSchema.optional(),
  // Top-level fallback (mirrors EmitEventSchema, all optional except `kind`
  // which the handler validates from whichever surface is present).
  kind: z.string().optional(),
  payload: z.unknown().optional(),
  directive_id: z.string().optional(),
  task_id: z.string().optional(),
  parent_task_id: z.string().nullable().optional(),
  loop_id: z.string().optional(),
  substrate_origin: z.string().optional(),
  context_refs: z.array(z.string()).optional(),
});

const ReadSchema = z.object({
  view_name: z.string(),
  args: z.unknown().optional(),
});

const IdSchema = z.object({
  id: z.string(),
});

const SearchSchema = z.object({
  query: z.string(),
  opts: z
    .object({
      k: z.number().optional(),
      runtime: z.string().optional(),
      min_score: z.number().optional(),
    })
    .optional(),
});

const RunArtifactSchema = z.object({
  artifact_id: z.string(),
  inputs: z.unknown().optional(),
  // Legacy alias from B3 surface — accepted for backwards compatibility with
  // any caller that still sends `input` (singular).
  input: z.unknown().optional(),
  budget: z
    .object({
      wall_ms: z.number().optional(),
      memory_mb: z.number().optional(),
    })
    .optional(),
});

const RunVerifierSchema = z.object({
  verifier_artifact_id: z.string(),
  observation: z.unknown().optional(),
  budget: z
    .object({
      wall_ms: z.number().optional(),
      memory_mb: z.number().optional(),
    })
    .optional(),
});

const AdmitArtifactSchema = z.object({
  runtime: z.enum(["bun", "uv", "camofox-browser"]),
  body: z.string(),
  declared_sandbox: z.unknown(),
  fixture_input: z.unknown(),
  fixture_expected_residual_below: z.number().optional(),
  state_root: z.string().optional(),
  name: z.string().optional(),
});

const CreditSchema = z
  .object({
    // Phase H wires the real credit pipeline. The shape stays flexible so the
    // stub doesn't constrain the design before we ship the pipeline.
    knowledge_id: z.string().optional(),
    artifact_id: z.string().optional(),
    outcome: z.string().optional(),
  })
  .passthrough();

// ── Handlers (pure functions over (ctx, args) → McpResult) ──────────
//
// fastmcp's `execute` calls these and JSON-stringifies the result; this
// keeps every method behind a uniform `{ok, …}` envelope so callers can
// pattern-match one shape regardless of which tool they called.

const handleEmit = (
  ctx: McpContext,
  args: z.infer<typeof EmitSchema>,
): McpResult => {
  // Accept either `{event: {…}}` or flat top-level fields.
  const src = args.event ?? args;
  const kind = src.kind;
  if (!kind || typeof kind !== "string") {
    return { ok: false, error: "missing 'kind'" };
  }
  const input: EmitEventInput = {
    kind: kind as EmitEventInput["kind"],
    substrate_origin:
      (src.substrate_origin as SubstrateOrigin | undefined) ?? ctx.invoker,
    directive_id: src.directive_id,
    task_id: src.task_id,
    parent_task_id: src.parent_task_id ?? undefined,
    loop_id: src.loop_id,
    payload: (src.payload as JsonValue) ?? {},
    context_refs: src.context_refs,
    invoker: ctx.invoker,
  };
  // Optional fields that only exist on EmitEventSchema (not on the flat shape).
  if (args.event) {
    const e = args.event;
    input.predicted_residual = e.predicted_residual;
    input.action_artifact_id = e.action_artifact_id;
    input.verifier_artifact_id = e.verifier_artifact_id;
    input.outcome = e.outcome as EmitEventInput["outcome"];
    input.residual = e.residual;
  }
  const emitted = emitEvent(ctx.db, input);
  return { ok: true, result: { id: emitted.id, ts: emitted.ts } };
};

const handleRead = (
  _ctx: McpContext,
  args: z.infer<typeof ReadSchema>,
): McpResult => {
  // TODO(B2/F): once the named-view dispatcher lands, route `view_name` to
  // the substrate/views.ts accessor. For B3 we explicitly signal not-yet-
  // implemented so callers get a clear error instead of a silent empty.
  return {
    ok: false,
    error: `view_not_implemented:${args.view_name}`,
  };
};

const handleGetEvent = (
  ctx: McpContext,
  args: z.infer<typeof IdSchema>,
): McpResult => {
  const ev = getEventById(ctx.db, args.id);
  if (!ev) return { ok: false, error: "event_not_found" };
  return { ok: true, result: ev as unknown as JsonValue };
};

const handleGetArtifact = (
  ctx: McpContext,
  args: z.infer<typeof IdSchema>,
): McpResult => {
  const row = ctx.db
    .query("SELECT * FROM code_artifact WHERE id = ?")
    .get(args.id) as Record<string, unknown> | null;
  if (!row) return { ok: false, error: "artifact_not_found" };
  return {
    ok: true,
    result: {
      ...row,
      declared_sandbox: JSON.parse((row.declared_sandbox as string) ?? "{}"),
      fixture_input: JSON.parse((row.fixture_input as string) ?? "{}"),
    } as JsonValue,
  };
};

const handleSearch = (
  ctx: McpContext,
  args: z.infer<typeof SearchSchema>,
): McpResult => {
  // Phase F lights up embedding-based retrieval (cosine × posterior reranker).
  // For B3 we return the most recent N events as a structurally-correct stand-
  // in so the tool surface is wired end-to-end and tests can assert hits.
  const k = Math.max(1, Math.min(100, args.opts?.k ?? 20));
  const rows = ctx.db
    .query(
      "SELECT id, ts, kind, directive_id, task_id, substrate_origin, payload " +
        "FROM events ORDER BY ts DESC LIMIT ?",
    )
    .all(k) as Array<Record<string, unknown>>;
  const hits = rows.map((r) => ({
    id: r.id as string,
    ts: r.ts as string,
    kind: r.kind as string,
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    substrate_origin: r.substrate_origin as string,
    payload: JSON.parse((r.payload as string) ?? "{}") as JsonValue,
  }));
  return {
    ok: true,
    result: {
      hits,
      mode: "recent_events_stub",
      query: args.query,
    } as JsonValue,
  };
};

// ── Phase C runtime handlers ──────────────────────────────────────
//
// substrate.run_artifact dispatches by the artifact's stored runtime:
//   - bun  → runBunArtifact (Phase C wires this)
//   - uv / camofox-browser → return `phase_g_runtime_unsupported`
// substrate.run_verifier is structurally identical — verifiers are just
// code artifacts whose body is expected to return `{residual: number}`.
// We do NOT enforce the shape; we pass the observation as inputs and let
// the verifier body decide what to do.
//
// Phase H wires substrate.credit. For Phase C we leave the stub error
// string in place so callers can still pattern-match — applyResidualOutcome
// is exposed to the substrate elsewhere (admission + future credit pipeline).

const callBunArtifactByRuntime = async (
  ctx: McpContext,
  artifactId: string,
  inputs: JsonValue,
  budget: { wall_ms?: number; memory_mb?: number } | undefined,
): Promise<McpResult> => {
  const row = getArtifact(ctx.db, artifactId);
  if (!row) return { ok: false, error: "artifact_not_found" };
  if (row.runtime !== "bun") {
    return { ok: false, error: `phase_g_runtime_unsupported:${row.runtime}` };
  }
  const decl = row.declaredSandbox;
  if (decl.runtime !== "bun") {
    return { ok: false, error: "sandbox_decl_runtime_mismatch" };
  }
  const observation = await runBunArtifact({
    artifactId: row.id,
    body: row.body,
    declaredSandbox: decl,
    inputs,
    budget: { wallMs: budget?.wall_ms, memoryMb: budget?.memory_mb },
    emit: (event) => {
      try {
        emitEvent(ctx.db, { ...event, invoker: event.invoker ?? ctx.invoker });
      } catch { /* event-emission failure must not poison the runtime */ }
    },
  });
  return {
    ok: true,
    result: {
      ok: observation.ok,
      result: observation.result ?? null,
      error: observation.error ?? null,
      duration_ms: observation.durationMs,
      exit_code: observation.exitCode,
      stderr_tail: observation.stderrTail,
      sandbox_warnings: observation.sandboxWarnings,
      irreversible_effects: observation.irreversibleEffects,
    } as JsonValue,
  };
};

const handleRunArtifact = async (
  ctx: McpContext,
  args: z.infer<typeof RunArtifactSchema>,
): Promise<McpResult> => {
  const inputs = (args.inputs ?? args.input ?? null) as JsonValue;
  return callBunArtifactByRuntime(ctx, args.artifact_id, inputs, args.budget as { wall_ms?: number; memory_mb?: number } | undefined);
};

const handleRunVerifier = async (
  ctx: McpContext,
  args: z.infer<typeof RunVerifierSchema>,
): Promise<McpResult> => {
  const observation = (args.observation ?? null) as JsonValue;
  return callBunArtifactByRuntime(ctx, args.verifier_artifact_id, observation, args.budget as { wall_ms?: number; memory_mb?: number } | undefined);
};

const handleAdmitArtifact = async (
  ctx: McpContext,
  args: z.infer<typeof AdmitArtifactSchema>,
): Promise<McpResult> => {
  const runtime = args.runtime as Runtime;
  const decl = args.declared_sandbox as SandboxDecl;
  const result = await admitArtifact(
    ctx.db,
    {
      runtime,
      body: args.body,
      declaredSandbox: decl,
      fixtureInput: (args.fixture_input ?? null) as JsonValue,
      fixtureExpectedResidualBelow: args.fixture_expected_residual_below ?? 0.2,
      stateRoot: args.state_root,
      name: args.name,
    },
    (event) => {
      try {
        emitEvent(ctx.db, { ...event, invoker: event.invoker ?? ctx.invoker });
      } catch { /* swallow */ }
    },
  );
  if (result.ok) {
    return { ok: true, result: { artifact_id: result.artifactId } as JsonValue };
  }
  return { ok: false, error: `${result.reason}${result.detail ? `:${result.detail}` : ""}` };
};

const handleCredit = (): McpResult => ({
  ok: false,
  error: "credit_pipeline_phase_h",
});

// ── FastMCP server factory ─────────────────────────────────────────

export type McpServerOptions = {
  db: Database;
  invoker?: SubstrateOrigin;
  name?: string;
  version?: `${number}.${number}.${number}`;
};

/** Build a FastMCP server with every substrate tool wired against `ctx.db`.
 *  The caller drives `.start({transportType, …})` — daemon uses `httpStream`,
 *  tests use `stdio`. The server holds no Database reference of its own; all
 *  state flows through `db` via the closure here. */
export const createMcpServer = (opts: McpServerOptions): FastMCP => {
  const ctx: McpContext = {
    db: opts.db,
    invoker: opts.invoker ?? "claude_root",
  };

  const server = new FastMCP({
    name: opts.name ?? "acc2-substrate",
    version: opts.version ?? "0.0.1",
    instructions:
      "AccInt v2 substrate. Every method returns `{ok, result|error}` " +
      "JSON-stringified. Read v2-design.md §11 + §13.2 for the protocol.",
  });

  // Each tool's `execute` returns `JSON.stringify(McpResult)` so the wire shape
  // is uniform regardless of which method was called. The MCP standard ships
  // text content; the test client / brain re-parses the JSON. Handlers can be
  // sync or async — we await the return so Phase C's runtime handlers (which
  // spawn subprocesses) plug in without contortion.
  const wrap =
    <A>(handler: (ctx: McpContext, args: A) => McpResult | Promise<McpResult>) =>
    async (args: unknown): Promise<string> => {
      try {
        const result = await handler(ctx, args as A);
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: `handler_error:${(err as Error).message}`,
        } satisfies McpResult);
      }
    };

  server.addTool({
    name: "substrate.emit",
    description:
      "Emit one substrate event. Returns {ok, result:{id, ts}} on success.",
    parameters: EmitSchema,
    execute: wrap(handleEmit),
  });

  server.addTool({
    name: "substrate.read",
    description:
      "Read a named substrate view. (B3: every view returns " +
      "view_not_implemented; Phase B2/F lights up real dispatch.)",
    parameters: ReadSchema,
    execute: wrap(handleRead),
  });

  server.addTool({
    name: "substrate.get_event",
    description: "Fetch one event by id. Returns {ok, result: Event}.",
    parameters: IdSchema,
    execute: wrap(handleGetEvent),
  });

  server.addTool({
    name: "substrate.get_artifact",
    description:
      "Fetch one code_artifact row by id. JSON columns are pre-parsed.",
    parameters: IdSchema,
    execute: wrap(handleGetArtifact),
  });

  server.addTool({
    name: "substrate.search",
    description:
      "Search the substrate. (B3: recent-events stand-in; Phase F adds " +
      "cosine × posterior retrieval.)",
    parameters: SearchSchema,
    execute: wrap(handleSearch),
  });

  server.addTool({
    name: "substrate.run_artifact",
    description:
      "Run a code artifact through its declared runtime + sandbox. " +
      "Phase C: bun-runtime artifacts execute end-to-end; uv and " +
      "camofox-browser return phase_g_runtime_unsupported until Phase G.",
    parameters: RunArtifactSchema,
    execute: wrap(handleRunArtifact),
  });

  server.addTool({
    name: "substrate.run_verifier",
    description:
      "Run a verifier artifact against an observation; returns the " +
      "verifier's JSON output (expected shape `{residual: number}`). " +
      "Phase C wires bun verifiers; uv/camofox return phase_g_runtime_unsupported.",
    parameters: RunVerifierSchema,
    execute: wrap(handleRunVerifier),
  });

  server.addTool({
    name: "substrate.credit",
    description:
      "Credit a knowledge / artifact citation with an outcome. " +
      "(Phase H wires the credit pipeline; until then returns " +
      "credit_pipeline_phase_h.)",
    parameters: CreditSchema,
    execute: wrap(handleCredit),
  });

  server.addTool({
    name: "substrate.admit_artifact",
    description:
      "Admit a new code artifact. Validates its sandbox declaration, runs " +
      "its fixture under the declared runtime, and on success inserts at " +
      "score=0.5/confidence=0.3. uv and camofox-browser admissions are " +
      "deferred to Phase G.",
    parameters: AdmitArtifactSchema,
    execute: wrap(handleAdmitArtifact),
  });

  return server;
};

// ── HTTP wrapper (Phase-B3 Bun.serve compatibility) ────────────────
//
// The Phase-B3 deliverable specifies a Bun.serve HTTP surface where the
// daemon routes `POST /mcp/<method>` directly to a handler dictionary.
// This export keeps that surface alive alongside the fastmcp transport so
// the daemon's plain-HTTP route handler can dispatch by method name.

const HTTP_DISPATCH: Record<string, (ctx: McpContext, args: any) => McpResult | Promise<McpResult>> = {
  "substrate.emit": handleEmit as any,
  "substrate.read": handleRead as any,
  "substrate.get_event": handleGetEvent as any,
  "substrate.get_artifact": handleGetArtifact as any,
  "substrate.search": handleSearch as any,
  "substrate.run_artifact": handleRunArtifact as any,
  "substrate.run_verifier": handleRunVerifier as any,
  "substrate.credit": handleCredit as any,
  "substrate.admit_artifact": handleAdmitArtifact as any,
};

/** Bun.serve route handler: POST /mcp/<method>. Parses JSON body, validates
 *  the method against the whitelist, returns `{ok, …}` with status 200 on
 *  success and 400 on handler-rejected errors (404 for unknown methods). */
export const handleMcpRequest = async (ctx: McpContext, req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  const url = new URL(req.url);
  const method = url.pathname.replace(/^\/mcp\//, "");
  const handler = HTTP_DISPATCH[method];
  if (!handler) {
    return Response.json({ ok: false, error: `unknown_method:${method}` }, { status: 404 });
  }
  let body: any = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch (err) {
    return Response.json({ ok: false, error: `bad_json:${(err as Error).message}` }, { status: 400 });
  }
  try {
    const result = await handler(ctx, body);
    return Response.json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return Response.json(
      { ok: false, error: `handler_error:${(err as Error).message}` },
      { status: 500 },
    );
  }
};
