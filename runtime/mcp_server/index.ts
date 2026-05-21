// acc2 MCP server — bootstrap + HTTP wrapper. Per v2-design.md §11.1
// the daemon hosts ONE MCP server that BOTH Claude Code and opencode
// connect to as native MCP clients. This file constructs that server
// using `fastmcp` (https://github.com/punkpeye/fastmcp). Each substrate
// method is exposed as a fastmcp tool with a `z.object(...)` parameter
// schema; `execute` returns a JSON-stringified `McpResult` so callers
// see one uniform `{ok, result|error}` shape.
//
// Handlers live in two focused files:
//   - ./substrate_tools.ts — 17 substrate.* handlers
//   - ./runtime_tools.ts   — 7  runtime.* handlers
//
// Shared zod schemas + McpResult / McpContext / McpServerOptions and
// the canonical `McpMethods` whitelist live in ./types.ts.
//
// Transport choices:
//   - `httpStream` for daemon production (Claude Code + opencode connect
//     over a port; fastmcp's HTTP streaming transport is the MCP-standard
//     wire).
//   - `stdio` for in-process tests (spawn the same FastMCP instance,
//     attach an MCP Client via StdioClientTransport, list/call tools).
//     This is the same binary; only the transport differs.

import { FastMCP } from "fastmcp";
import type { McpContext, McpResult, McpServerOptions } from "./types";
import {
  AdmitArtifactSchema,
  AmendDirectiveSchema,
  BrainSelfAuditSchema,
  CreditSchema,
  DetectFatherDriftSchema,
  DispatchReadyTaskSchema,
  EmbedTextSchema,
  EmitSchema,
  FatherIterateSchema,
  FindRecipeSchema,
  IdSchema,
  OpenDirectiveSchema,
  OpenFixtureSchema,
  ProcessRollingReviewsSchema,
  PromptSelfInspectSchema,
  ReadSchema,
  RecentEventsSchema,
  RecordInterferenceEdgeSchema,
  RecordStakeholderStateSchema,
  RegisterExternalSourceSchema,
  ReplayRecipeSchema,
  RunArtifactSchema,
  RunVerifierSchema,
  SchedulerTickSchema,
  SearchSchema,
  SystemMapSchema,
  TrajectoryReplaySchema,
} from "./types";
import {
  handleAdmitArtifact,
  handleAmendDirective,
  handleCredit,
  handleEmbedText,
  handleEmit,
  handleFindRecipe,
  handleGetArtifact,
  handleGetEvent,
  handleOpenDirective,
  handleOpenFixture,
  handleRead,
  handleRecordInterferenceEdge,
  handleRecordStakeholderState,
  handleRegisterExternalSource,
  handleRunArtifact,
  handleRunVerifier,
  handleSearch,
} from "./substrate_tools";
import {
  handleBrainSelfAudit,
  handleDetectFatherDrift,
  handleDispatchReadyTask,
  handleFatherIterate,
  handleProcessRollingReviews,
  handlePromptSelfInspect,
  handleRecentEvents,
  handleReplayRecipe,
  handleSchedulerTick,
  handleSystemMap,
  handleTrajectoryReplay,
} from "./runtime_tools";

/** Build a FastMCP server with every substrate tool wired against `ctx.db`.
 *  The caller drives `.start({transportType, …})` — daemon uses `httpStream`,
 *  tests use `stdio`. The server holds no Database reference of its own; all
 *  state flows through `db` via the closure here. */
export const createMcpServer = (opts: McpServerOptions): FastMCP => {
  const ctx: McpContext = {
    db: opts.db,
    invoker: opts.invoker ?? "claude_root",
    index: opts.index ?? null,
    ingressState: opts.ingressState ?? null,
  };

  const server = new FastMCP({
    name: opts.name ?? "acc2-substrate",
    version: opts.version ?? "0.0.1",
    instructions:
      "AccInt v2 substrate. Every method returns `{ok, result|error}` " +
      "JSON-stringified. Read v2-design.md §11 + §13.2 for the protocol.",
    // 2026-05-21 wedge fix: fastmcp default ping fires every 5s on EVERY
    // active SSE session. After ~1000 sessions accumulate from one day of
    // dispatch churn (each acc task / orchestrator poll / opencode brain
    // opens a session, and ungracefully-closed clients leak), the main
    // event loop spends most cycles draining keep-alive frames. Daemon
    // CPU climbs to 93-100% even with most workers disabled.
    //
    // Substrate doesn't depend on MCP ping for liveness — it has
    // substrate.read({view_name:"dispatch_resolved_view"}) and the aux
    // /health endpoint. Disable ping entirely.
    ping: { enabled: false },
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
      "Read a named substrate view. Unknown view_name returns " +
      "view_not_implemented:<name> so callers can detect typos.",
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
      "Fetch one act_artifact row by id. JSON columns are pre-parsed.",
    parameters: IdSchema,
    execute: wrap(handleGetArtifact),
  });

  server.addTool({
    name: "substrate.search",
    description:
      "Search the substrate. Phase F: routes through the cosine × posterior " +
      "reranker when an embedding index is mounted; falls back to recent-events " +
      "stand-in on fresh / unembedded substrates. Supports kind_filter, " +
      "aspect_weights, and domain_hints to scope open-ended routing.",
    parameters: SearchSchema,
    execute: wrap(handleSearch),
  });

  server.addTool({
    name: "substrate.embed_text",
    description:
      "Embed an arbitrary text via the same model the substrate indexes with " +
      "(text-embedding-3-small). Returns {embedding: number[], version, model}.",
    parameters: EmbedTextSchema,
    execute: wrap(handleEmbedText),
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
      "Distribute one action_scored outcome across cited knowledge + " +
      "code artifacts via Shapley decomposition by corroboration order " +
      "(§3.6.1 Rule 3). Returns the per-entity weights, Beta posterior " +
      "deltas, and ids of every emitted event.",
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

  server.addTool({
    name: "substrate.open_fixture",
    description:
      "Open a named test fixture directive. Phase D ships d_count_todos. " +
      "Returns {directive_id, task_id} so the caller can drive the dispatcher.",
    parameters: OpenFixtureSchema,
    execute: wrap(handleOpenFixture),
  });

  server.addTool({
    name: "runtime.dispatch_ready_task",
    description:
      "Dispatch one ready task through the single-cycle brain pipeline. " +
      "Phase D: composes prompt, calls mocked bridge, runs action + verifier, " +
      "emits action_scored + task_committed when residual < threshold.",
    parameters: DispatchReadyTaskSchema,
    execute: wrap(handleDispatchReadyTask),
  });

  server.addTool({
    name: "runtime.scheduler_tick",
    description:
      "Run one tick of the parallel scheduler. Picks up to max_concurrent " +
      "ready tasks (default 5), routes by dispatch lane, returns the per-tick " +
      "summary (dispatched / in_flight / skipped_*). Phase E.",
    parameters: SchedulerTickSchema,
    execute: wrap(handleSchedulerTick),
  });

  server.addTool({
    name: "substrate.amend_directive",
    description:
      "Emit a directive_amended event AND immediately apply it: supersede " +
      "the named tasks/predictions, open task_node_opened for each new_task_goals " +
      "entry, return the amendment summary. Phase E.",
    parameters: AmendDirectiveSchema,
    execute: wrap(handleAmendDirective),
  });

  server.addTool({
    name: "substrate.record_stakeholder_state",
    description:
      "Record a stakeholder_state_recorded event for a multi-stakeholder " +
      "directive. Auto-detects conflicts against prior stakeholder declarations " +
      "and emits stakeholder_conflict + owner_input_required when they disagree. Phase I.",
    parameters: RecordStakeholderStateSchema,
    execute: wrap(handleRecordStakeholderState),
  });

  server.addTool({
    name: "substrate.record_interference_edge",
    description:
      "Record a directive_interference_edge (kind: blocks | watches | depletes). " +
      "Validates against self-loops, refuses cycle-introducing blocks edges only " +
      "after surfacing them, and emits directive_interference_cycle_detected for " +
      "any cycle in the blocks subgraph. Phase I.",
    parameters: RecordInterferenceEdgeSchema,
    execute: wrap(handleRecordInterferenceEdge),
  });

  server.addTool({
    name: "substrate.open_directive",
    description:
      "Convenience: open a fresh directive with optional lifecycle (finite | " +
      "rolling_active), urgency (normal | elevated | crisis), review cadence, " +
      "initial root task, and an initial stakeholders list. Emits crisis_mode_engaged " +
      "when urgency=crisis. Phase I.",
    parameters: OpenDirectiveSchema,
    execute: wrap(handleOpenDirective),
  });

  server.addTool({
    name: "runtime.process_rolling_reviews",
    description:
      "Drain rolling_review_due_view: emit directive_review_due, open a review " +
      "subtask, advance next_review_due by one cadence period. Father (Phase K) " +
      "calls this on its tick. Phase I.",
    parameters: ProcessRollingReviewsSchema,
    execute: wrap(handleProcessRollingReviews),
  });

  server.addTool({
    name: "runtime.father_iterate",
    description:
      "One Father tick (Phase K, §14). Reads active_objectives_view, " +
      "rolling_review_due_view, and directive_conflicts_view; selects the " +
      "highest-priority unblocked work; opens a directive from a template " +
      "(NEVER calls an LLM). Honors §3 owner-yield: if owner_input_received " +
      "is within the active window, Father yields without opening anything.",
    parameters: FatherIterateSchema,
    execute: wrap(handleFatherIterate),
  });

  server.addTool({
    name: "runtime.detect_father_drift",
    description:
      "Diagnostic: scan recent events with substrate_origin='father' and emit " +
      "father_drift_detected for any event whose kind is outside the §14 " +
      "FATHER_ACTION_EVENT_KINDS taxonomy. Idempotent — already-reported " +
      "offenders are not re-emitted.",
    parameters: DetectFatherDriftSchema,
    execute: wrap(handleDetectFatherDrift),
  });

  server.addTool({
    name: "substrate.find_recipe",
    description:
      "Find a recipe matching the supplied task by goal_shape + topology " +
      "signature with confidence ≥ min_confidence (Phase J, §15). Returns the " +
      "RecipeMatch or null.",
    parameters: FindRecipeSchema,
    execute: wrap(handleFindRecipe),
  });

  server.addTool({
    name: "runtime.replay_recipe",
    description:
      "Replay a matched reusable trajectory against a task — execute its " +
      "action + verifier artifact handles WITHOUT calling the brain (Phase J, §15). " +
      "On success emits action_predicted/scored/task_committed with " +
      "recipe_replayed=true; on residual ≥ threshold records the high residual " +
      "on standard action_scored rows (replay_aborted=true) and the dispatcher " +
      "routes back to opencode_brain.",
    parameters: ReplayRecipeSchema,
    execute: wrap(handleReplayRecipe),
  });

  server.addTool({
    name: "substrate.register_external_source",
    description:
      "Register a new external-event source (calendar, email, IoT…). Mints a " +
      "per-source bearer token override on the daemon's ingress state and " +
      "emits external_source_registered for audit (§5.2). Requires the " +
      "ingress state to be wired into the MCP context (i.e. running inside " +
      "the daemon, not bare stdio).",
    parameters: RegisterExternalSourceSchema,
    execute: wrap(handleRegisterExternalSource),
  });

  server.addTool({
    name: "runtime.recent_events",
    description:
      "Return the most-recent K events (default 30, max 200), optionally " +
      "filtered by kind. Used by `acc watch` to fill its event buffer before " +
      "SSE has caught up. Result is `{events: [...]}` in ts-ASC order.",
    parameters: RecentEventsSchema,
    execute: wrap(handleRecentEvents),
  });

  // ── Brain self-introspection (Phase 1 brain harness rewrite) ────
  // Glass-box surface the brain reads to understand itself and the
  // substrate. system_map = catalog of event_kinds/views/tools/runtimes;
  // brain_self_audit = the brain's own report card (citation/promotion/
  // proposal-accept rates, residual distribution); trajectory_replay =
  // full task DAG + lessons for a directive; prompt_self_inspect = what
  // the composer would put in front of the brain right now for a task.

  server.addTool({
    name: "runtime.system_map",
    description:
      "Canonical catalog of the substrate: event_kinds with producers, " +
      "views, MCP tools, runtimes, and the top-K admitted artifacts. " +
      "Brain reads this once per new directive shape to know what it can " +
      "emit, read, and call. Pure read; safe at any depth.",
    parameters: SystemMapSchema,
    execute: wrap(handleSystemMap),
  });

  server.addTool({
    name: "runtime.brain_self_audit",
    description:
      "Brain's own report card over a time window (default 7d): emission " +
      "breakdown, citation/promotion rate, proposal accept rate, residual " +
      "distribution, effectiveness classification, recent brain-caused " +
      "failures. Brain reads every cycle so improvement proposals are " +
      "evidence-grounded, not vibes-based. Pure read.",
    parameters: BrainSelfAuditSchema,
    execute: wrap(handleBrainSelfAudit),
  });

  server.addTool({
    name: "runtime.trajectory_replay",
    description:
      "Full projection of one directive: task DAG with per-node status / " +
      "action_count / latest_residual / knowledge+lesson+amendment counts, " +
      "plus the lesson + amendment streams. Brain reads when refining so " +
      "it sees what's already been tried, not just the current task's " +
      "prompt. Pure read.",
    parameters: TrajectoryReplaySchema,
    execute: wrap(handleTrajectoryReplay),
  });

  server.addTool({
    name: "runtime.prompt_self_inspect",
    description:
      "Re-compose the prompt the brain would see for a task and return " +
      "section names + priority + token budgets + truncation list. Brain " +
      "uses to detect 'section X kept dropping under budget' or to spot- " +
      "check 'was I shown the latest owner_profile?'. Pure read.",
    parameters: PromptSelfInspectSchema,
    execute: wrap(handlePromptSelfInspect),
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
  "substrate.embed_text": handleEmbedText as any,
  "substrate.run_artifact": handleRunArtifact as any,
  "substrate.run_verifier": handleRunVerifier as any,
  "substrate.credit": handleCredit as any,
  "substrate.admit_artifact": handleAdmitArtifact as any,
  "substrate.open_fixture": handleOpenFixture as any,
  "substrate.amend_directive": handleAmendDirective as any,
  "substrate.record_stakeholder_state": handleRecordStakeholderState as any,
  "substrate.record_interference_edge": handleRecordInterferenceEdge as any,
  "substrate.open_directive": handleOpenDirective as any,
  "runtime.dispatch_ready_task": handleDispatchReadyTask as any,
  "runtime.scheduler_tick": handleSchedulerTick as any,
  "runtime.process_rolling_reviews": handleProcessRollingReviews as any,
  "runtime.father_iterate": handleFatherIterate as any,
  "runtime.detect_father_drift": handleDetectFatherDrift as any,
  "substrate.find_recipe": handleFindRecipe as any,
  "runtime.replay_recipe": handleReplayRecipe as any,
  "substrate.register_external_source": handleRegisterExternalSource as any,
  "runtime.recent_events": handleRecentEvents as any,
  "runtime.system_map": handleSystemMap as any,
  "runtime.brain_self_audit": handleBrainSelfAudit as any,
  "runtime.trajectory_replay": handleTrajectoryReplay as any,
  "runtime.prompt_self_inspect": handlePromptSelfInspect as any,
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

// ── Public surface re-exports ─────────────────────────────────────

export type { McpContext, McpResult, McpMethodName, McpServerOptions } from "./types";
export { McpMethods } from "./types";
