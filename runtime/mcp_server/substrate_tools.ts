// acc2 MCP server — substrate.* tool handlers. Split out of the
// monolithic runtime/mcp_server.ts so the substrate-facing 17 methods
// can evolve independently from the runtime.* tools.
//
// Every handler returns `McpResult` (`{ok: true, result} | {ok: false,
// error}`); fastmcp's `execute` wrapper JSON-stringifies the result so
// the wire shape is uniform.

import type { z } from "zod";
import type { JsonValue, Runtime, SandboxDecl, SubstrateOrigin } from "../../substrate/types";
import { EVENT_KINDS } from "../../substrate/event_kinds";
import { emitEvent, getEventById, type EmitEventInput } from "../events";
import { summarizeEffectiveness } from "../brain_effectiveness";
import { runBunArtifact } from "../runtimes/bun";
import { runUvArtifact } from "../runtimes/uv";
import { runCamofoxArtifact } from "../runtimes/camofox";
import { getArtifact } from "../artifact_store";
import { admitArtifact } from "../artifact_admission";
import { distributeCredit } from "../credit";
import { openFixtureDCountTodos } from "../fixtures/d_count_todos";
import { emitAndApplyAmendment } from "../amendment_handler";
import { computeEmbedding } from "../embedder";
import { retrieve } from "../retrieval";
import { recordStakeholderState, type StakeholderVisibility } from "../stakeholder_compositor";
import { recordInterferenceEdge, type InterferenceEdgeKind } from "../interference";
import { findRecipeMatch } from "../recipe_replay";
import { newId } from "../ids";
import {
  codeArtifactRegistry,
  readyTasks,
  dispatchResolved,
  taskGraphFor,
  failureCounts,
  artifactRouting,
  stakeholderStateRows,
  activeObjectives,
  rollingReviewDue,
  directiveConflicts,
  entityRelationshipRows,
  irreversibleEffects,
  embeddingIndex,
  originPromotion,
  ownerConversation,
  lowRiskInlinePatterns,
  lessonImplementerQueue,
  pendingOwnerDecisionQueue,
  lessonImplementationStatus,
  appliedLessonEffectiveness,
  lessonApplyCandidates,
  promotedKnowledge,
  recipeRegistry,
} from "../../substrate/views";
import type {
  AdmitArtifactSchema,
  AmendDirectiveSchema,
  CreditSchema,
  EmbedTextSchema,
  EmitSchema,
  FindRecipeSchema,
  IdSchema,
  McpContext,
  McpResult,
  OpenDirectiveSchema,
  OpenFixtureSchema,
  ReadSchema,
  RecordInterferenceEdgeSchema,
  RecordStakeholderStateSchema,
  RegisterExternalSourceSchema,
  RunArtifactSchema,
  RunVerifierSchema,
  SearchSchema,
} from "./types";

/** Event kinds the brain (opencode) is NOT allowed to emit. These are
 *  owner / orchestrator privileged surfaces — letting the brain emit them
 *  via substrate.emit lets it impersonate the owner and recursively spawn
 *  new top-level directives. Live ledger evidence (2026-05-15 02:00+)
 *  showed the brain calling substrate.open_directive with its OWN prompt
 *  text as directive_text, each iteration doubling the "TASK GOAL:"
 *  prefix until the substrate filled with `"TASK GOAL: \"TASK GOAL:
 *  \\\"TASK GOAL:..."` zombie directives. The brain decomposes work via
 *  task_node_opened + task_edge_recorded (refines/requires) under its
 *  CURRENT directive, never by opening a new one. */
const BRAIN_FORBIDDEN_KINDS = new Set<string>([
  "directive_opened",
  "directive_amended",
  "directive_archived_by_operator",
  "owner_input_received",
  "owner_decision_recorded",
]);

const isBrainInvoker = (invoker: string | undefined): boolean => {
  return invoker === "opencode" || invoker === "recipe";
};

/** Detect "this emit call originated from the brain subprocess" using the
 *  emit's declared substrate_origin OR the MCP context invoker. opencode 1.4
 *  calls land at the daemon MCP with ctx.invoker='claude_root' (the server's
 *  default per runtime/mcp_server/index.ts:87) — so ctx.invoker alone cannot
 *  distinguish a brain call from an orchestrator call. The brain DOES set
 *  `substrate_origin: 'opencode'` explicitly on every emit per the v2 prompt
 *  grammar. Combining both signals is the canonical "is this brain?" check.
 *  Audit 2026-05-17. */
const isBrainEmit = (substrateOrigin: unknown, invoker: string | undefined): boolean => {
  if (isBrainInvoker(invoker)) return true;
  if (typeof substrateOrigin === "string" && (substrateOrigin === "opencode" || substrateOrigin === "recipe")) {
    return true;
  }
  return false;
};

/** Detect directive_text that looks like a leaked prompt-composer
 *  template — the brain's prompt fed BACK as a new directive's content.
 *  Live ledger 2026-05-15 02:00-03:07 showed recursive openings whose
 *  text begins with "TASK GOAL:" (or quoted variants) plus WORKFLOW /
 *  DIRECTIVE ID markers. These are the signatures the prompt composer
 *  injects into the brain's prompt; they should never appear in a fresh
 *  directive_text. Returns the matched signature string on detection,
 *  null when the text is clean. */
const detectPromptTemplateLeak = (text: string): string | null => {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // (1) Recursive prefix doubling — the smoking gun from the live ledger.
  if (/TASK GOAL:\s*TASK GOAL:/i.test(trimmed)) return "recursive_task_goal_doubled";
  // (2) Single TASK GOAL: at the start of a fresh directive is almost
  // always a prompt-leak (real owner phrasing rarely begins this way).
  if (/^\s*"?TASK GOAL:/i.test(trimmed)) return "leading_task_goal_marker";
  // (3) WORKFLOW + DIRECTIVE ID + RUNTIMES — three markers the prompt
  // composer always injects; their joint presence is conclusive.
  const markers = [
    /\bDIRECTIVE ID:\s*\w/i,
    /\bRUNTIMES AVAILABLE\b/i,
    /\bYOUR WORKFLOW\b/i,
    /\bRETRIEVED KNOWLEDGE\b/i,
    /\bCONSTITUTIONAL GATES ACTIVE\b/i,
  ];
  const hits = markers.reduce((n, re) => n + (re.test(trimmed) ? 1 : 0), 0);
  if (hits >= 2) return `prompt_composer_markers_count=${hits}`;
  return null;
};

/** Find an already-open (non-closed, non-archived) directive whose
 *  directive_text matches the supplied text exactly. Used by
 *  handleOpenDirective for idempotent same-directive dedup — pre-fix the
 *  CLI / brain / Father autonomous loop could legitimately retry an
 *  opening and produce duplicate top-level directives competing for the
 *  same scheduler slots. */
const findOpenDirectiveByText = (
  ctxDb: Parameters<typeof emitEvent>[0],
  text: string,
): string | null => {
  const row = ctxDb
    .query(
      `SELECT directive_id FROM events
       WHERE kind = 'directive_opened'
         AND json_extract(payload, '$.directive_text') = ?
         AND directive_id NOT IN (
           SELECT directive_id FROM events
           WHERE kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
         )
       ORDER BY ts ASC LIMIT 1`,
    )
    .get(text) as { directive_id: string } | null;
  return row?.directive_id ?? null;
};

export const handleEmit = (
  ctx: McpContext,
  args: z.infer<typeof EmitSchema>,
): McpResult => {
  // Accept either `{event: {…}}` or flat top-level fields.
  const src = args.event ?? args;
  const kind = src.kind;
  if (!kind || typeof kind !== "string") {
    return { ok: false, error: "missing 'kind'" };
  }
  // Brain audit C (2026-05-15): reject any kind not declared in the
  // canonical EVENT_KINDS registry at the ledger write boundary. Pre-fix
  // a dynamic caller (brain emitting via MCP) could persist an arbitrary
  // string and bypass the embedding filter, health-metric tagging,
  // mirror-inline classification, and downstream view filters. The
  // registry is the only safe vocabulary.
  if (!(kind in EVENT_KINDS)) {
    return {
      ok: false,
      error: `unknown_event_kind:${kind}; register it in substrate/event_kinds.ts EVENT_KINDS before emitting`,
    };
  }
  // Brain privilege gate: the brain may NOT emit owner/orchestrator
  // kinds via substrate.emit. See BRAIN_FORBIDDEN_KINDS doc above.
  if (isBrainInvoker(ctx.invoker) && BRAIN_FORBIDDEN_KINDS.has(kind)) {
    return {
      ok: false,
      error: `brain_forbidden_kind:${kind}; brain decomposes via task_node_opened+task_edge_recorded under the current directive`,
    };
  }
  // Idempotent task dedup: same (directive_id, goal) under an open
  // directive is a no-op. Pre-fix the brain looping a refinement edge
  // would re-emit task_node_opened with the same goal, the scheduler
  // would see "new task" each time, and the DAG would explode with
  // duplicate work. We return the existing task_id so the caller's
  // refinement-edge wiring still resolves correctly.
  if (kind === "task_node_opened") {
    const directiveId = src.directive_id as string | undefined;
    const taskId = src.task_id as string | undefined;
    const parentTaskId = src.parent_task_id as string | null | undefined;
    const goalRaw = ((src.payload as Record<string, unknown> | undefined)?.goal) ?? undefined;
    const goal = typeof goalRaw === "string" ? goalRaw : undefined;
    // Audit-#8 (2026-05-15): the brain has been observed reusing the root
    // task_id when opening refinement CHILDREN — directive 97DNBDA4P93N
    // had 4 task_node_opened rows all carrying the same task_id but
    // different goals. This breaks readyTasks dedup and the cascade
    // (children invisible to the refines-edge walk because they have
    // no distinct task_id). Reject any task_node_opened whose task_id
    // already has a row UNDER THE SAME DIRECTIVE.
    //   - If the existing row was the root (parent IS NULL) and the new
    //     row is also presented as the root (parent IS NULL) AND the
    //     goal matches → return the existing id (idempotent open).
    //   - If the existing row is the root and the new row is a child
    //     (parent_task_id non-null) reusing the root's id → reject with
    //     a clear error so the brain rewrites with a fresh id.
    //   - Same kind+task_id but different goal text under the same
    //     directive → reject.
    if (directiveId && taskId) {
      const existing = ctx.db
        .query(
          `SELECT task_id, parent_task_id, json_extract(payload, '$.goal') AS goal
           FROM events
           WHERE kind = 'task_node_opened'
             AND directive_id = ?
             AND task_id = ?
           ORDER BY ts ASC LIMIT 1`,
        )
        .get(directiveId, taskId) as { task_id: string; parent_task_id: string | null; goal: string } | null;
      if (existing) {
        const existingGoalMatches = (goal ?? "") === (existing.goal ?? "");
        const existingIsRoot = existing.parent_task_id == null;
        const newIsRoot = parentTaskId == null;
        if (existingIsRoot && newIsRoot && existingGoalMatches) {
          // True idempotent re-open of the same root with the same goal.
          return {
            ok: true,
            result: { id: existing.task_id, deduped: true, reason: "root_task_already_opened" } as JsonValue,
          };
        }
        return {
          ok: false,
          error: `task_id_reuse:${taskId};existing_parent_task_id=${existing.parent_task_id ?? "null"};existing_goal=${(existing.goal ?? "").slice(0, 80)};new_parent_task_id=${parentTaskId ?? "null"};hint=mint a fresh task_id for each task_node_opened — the brain must NOT reuse the root id when opening refinement children`,
        };
      }
    }
    // Existing dedup: same (directive_id, goal) → return the existing
    // task_id so a refinement-edge wiring still resolves.
    if (directiveId && goal && goal.length > 0) {
      const existing = ctx.db
        .query(
          `SELECT task_id FROM events
           WHERE kind = 'task_node_opened' AND directive_id = ?
             AND json_extract(payload, '$.goal') = ?
           ORDER BY ts ASC LIMIT 1`,
        )
        .get(directiveId, goal) as { task_id: string } | null;
      if (existing) {
        return {
          ok: true,
          result: { id: existing.task_id, deduped: true, reason: "task_goal_already_opened" } as JsonValue,
        };
      }
    }
  }
  // Brain audit F (2026-05-15): refuse task_edge_recorded events whose
  // from_task/to_task endpoints don't exist as task_node_opened rows
  // under the same directive. Without this gate, refinement edges can
  // point at non-existent children → DAG cascade walks a graph that
  // disagrees with the renderer.
  if (kind === "task_edge_recorded") {
    const directiveId = src.directive_id as string | undefined;
    const payload = (src.payload as Record<string, unknown> | undefined) ?? {};
    const fromTask = (payload.from_task ?? payload.from) as string | undefined;
    const toTask = (payload.to_task ?? payload.to) as string | undefined;
    if (directiveId && fromTask && toTask) {
      // Brain audit (2026-05-16, src 442HA2904S1K1FAG0VS1FQVC88,
      // evidence knowledge 3SX8NAZVJN44K3DY8JQ5V1VTZM): refuse self-loop
      // edges (from_task == to_task) at the emit layer. Self-loops produce
      // degenerate DAGs where decomposition leaves logically collapse to
      // one node — witnessed in meta-audit directive M6495S46GX7XQ73AJ8DH84RGTR
      // where 7 task_node_opened all shared the root task_id and 7
      // self-loop edges left only 2 of 7 subtasks producing output. The
      // task_graph_view and parallel-DAG scheduler both assume an acyclic
      // refinement graph; self-loops violate that assumption structurally.
      if (fromTask === toTask) {
        return {
          ok: false,
          error: `task_edge_self_loop:${fromTask}`,
        };
      }
      const fromExists = ctx.db
        .query(
          `SELECT 1 FROM events
           WHERE kind = 'task_node_opened' AND directive_id = ? AND task_id = ?
           LIMIT 1`,
        )
        .get(directiveId, fromTask);
      const toExists = ctx.db
        .query(
          `SELECT 1 FROM events
           WHERE kind = 'task_node_opened' AND directive_id = ? AND task_id = ?
           LIMIT 1`,
        )
        .get(directiveId, toTask);
      if (!fromExists || !toExists) {
        const missing: string[] = [];
        if (!fromExists) missing.push(`from_task=${fromTask}`);
        if (!toExists) missing.push(`to_task=${toTask}`);
        return {
          ok: false,
          error: `task_edge_endpoint_missing:${missing.join(",")};hint=open the endpoint via task_node_opened in the same directive before recording the edge`,
        };
      }
    }
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
  // Optional event fields. Accept BOTH the `args.event.*` wrapped shape and
  // the flat `args.*` shape — opencode 1.4+ flattens our zod schema when
  // surfacing the tool to the brain, so flat is the dominant calling shape.
  // The wrapper shape stays for callers using the explicit `event` envelope.
  const e = args.event ?? args;
  // Brain may put act-loop fields top-level OR inside payload. Accept both.
  const payloadObj = (input.payload && typeof input.payload === "object" && !Array.isArray(input.payload))
    ? input.payload as Record<string, unknown>
    : {};
  input.predicted_residual = e.predicted_residual ?? (payloadObj.predicted_residual as number | undefined);
  input.action_artifact_id = e.action_artifact_id ?? (payloadObj.action_artifact_id as string | undefined);
  input.verifier_artifact_id = e.verifier_artifact_id ?? (payloadObj.verifier_artifact_id as string | undefined);
  input.outcome = e.outcome as EmitEventInput["outcome"];
  input.residual = e.residual;

  // ACT-LOOP TUPLE VALIDATION (FOUNDATIONAL FIX 2026-05-17):
  // v2-design.md §3 + §10 mandate that every action_predicted carries
  // `intent + action_artifact_id + verifier_artifact_id + predicted_residual`.
  // Observed brain behavior: 28 of 30 recent action_predicted events from
  // opencode 1.4 omitted the artifact tuple, emitting only intent + free-form
  // `verifier_axes` / `budget_estimate`. That breaks the credit chain
  // (action → verifier → outcome → posterior update is impossible without
  // artifact_ids) and constitutes the k_252 "advisory pretending to be hard"
  // violation. Fix: refuse brain-emitted action_predicted that omits the
  // tuple. isBrainEmit gates the validation to brain emits (substrate_origin
  // = "opencode" OR brain-invoker context) so test fixtures and CLI
  // orchestrator paths that emit raw action_predicted for setup are
  // unaffected.
  if (kind === "action_predicted" && isBrainEmit(src.substrate_origin, ctx.invoker)) {
    const missing: string[] = [];
    if (!input.action_artifact_id) missing.push("action_artifact_id");
    if (!input.verifier_artifact_id) missing.push("verifier_artifact_id");
    if (typeof input.predicted_residual !== "number") missing.push("predicted_residual");
    if (missing.length > 0) {
      return {
        ok: false,
        error: `action_predicted_missing_act_loop_tuple:${missing.join(",")};hint=action_predicted MUST carry action_artifact_id+verifier_artifact_id+predicted_residual (v2-design.md §3). For design work without a runtime artifact, emit knowledge_candidate (recommendation) or lesson_extracted (reusable pattern) instead. For repo changes, emit contract_amendment_proposed. To execute an action, first substrate.admit_artifact for BOTH the action artifact and the verifier artifact, then emit action_predicted with both IDs.`,
      };
    }
  }
  const emitted = emitEvent(ctx.db, input);
  return { ok: true, result: { id: emitted.id, ts: emitted.ts } };
};

export const handleRead = (
  ctx: McpContext,
  args: z.infer<typeof ReadSchema>,
): McpResult => {
  // Phase Audit: route `view_name` to the substrate/views.ts accessor.
  // Views not yet implemented return `view_not_implemented:<name>` so
  // callers see a clear signal instead of a silent empty. The set below
  // mirrors §4.2 of v2-design.md; views computed in TS (knowledge_view,
  // judgment_packet_view) still return view_not_implemented until their
  // accessors land.
  const db = ctx.db;
  const view = args.view_name;
  try {
    switch (view) {
      case "code_artifact_registry_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const runtime = typeof arg.runtime === "string" ? arg.runtime : undefined;
        return { ok: true, result: codeArtifactRegistry(db, runtime) as unknown as JsonValue };
      }
      case "ready_tasks_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const limit = typeof arg.limit === "number" ? arg.limit : undefined;
        return { ok: true, result: readyTasks(db, limit) as unknown as JsonValue };
      }
      case "dispatch_resolved_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : undefined;
        const rootTaskId = typeof arg.root_task_id === "string" ? arg.root_task_id : undefined;
        return { ok: true, result: dispatchResolved(db, { directiveId, rootTaskId }) as unknown as JsonValue };
      }
      case "task_graph_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : null;
        if (!directiveId) return { ok: false, error: "task_graph_view_requires_directive_id" };
        return { ok: true, result: taskGraphFor(db, directiveId) as unknown as JsonValue };
      }
      case "failure_view":
        return { ok: true, result: failureCounts(db) as unknown as JsonValue };
      case "artifact_routing_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const runtime = typeof arg.runtime === "string" ? arg.runtime : undefined;
        return { ok: true, result: artifactRouting(db, runtime) as unknown as JsonValue };
      }
      case "stakeholder_state_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : undefined;
        return { ok: true, result: stakeholderStateRows(db, directiveId) as unknown as JsonValue };
      }
      case "active_objectives_view":
        return { ok: true, result: activeObjectives(db) as unknown as JsonValue };
      case "rolling_review_due_view":
        return { ok: true, result: rollingReviewDue(db) as unknown as JsonValue };
      case "directive_conflicts_view":
        return { ok: true, result: directiveConflicts(db) as unknown as JsonValue };
      case "entity_relationship_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : undefined;
        return { ok: true, result: entityRelationshipRows(db, directiveId) as unknown as JsonValue };
      }
      case "irreversible_effects_view":
        return { ok: true, result: irreversibleEffects(db) as unknown as JsonValue };
      case "embedding_index_view":
        return { ok: true, result: embeddingIndex(db) as unknown as JsonValue };
      case "origin_promotion_view":
        return { ok: true, result: originPromotion(db) as unknown as JsonValue };
      case "owner_profile_view": {
        const rows = db
          .query("SELECT * FROM owner_profile_view")
          .all() as Array<Record<string, unknown>>;
        return {
          ok: true,
          result: rows.map((row) => ({
            event_id: row.event_id as string,
            ts: row.ts as string,
            payload: JSON.parse((row.payload as string) ?? "{}") as JsonValue,
            substrate_origin: row.substrate_origin as string,
          })) as unknown as JsonValue,
        };
      }
      case "owner_conversation_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : undefined;
        return { ok: true, result: ownerConversation(db, directiveId) as unknown as JsonValue };
      }
      case "contradictory_candidates_view": {
        const rows = db
          .query("SELECT * FROM contradictory_candidates_view ORDER BY ts DESC")
          .all() as Array<Record<string, unknown>>;
        return { ok: true, result: rows as unknown as JsonValue };
      }
      case "low_risk_inline_patterns_view": {
        return {
          ok: true,
          result: lowRiskInlinePatterns(db) as unknown as JsonValue,
        };
      }
      case "lesson_implementer_queue_view":
        return { ok: true, result: lessonImplementerQueue(db) as unknown as JsonValue };
      case "pending_owner_decision_queue_view":
        return { ok: true, result: pendingOwnerDecisionQueue(db) as unknown as JsonValue };
      case "lesson_implementation_status_view":
        return { ok: true, result: lessonImplementationStatus(db) as unknown as JsonValue };
      case "applied_lesson_effectiveness_view":
        return { ok: true, result: appliedLessonEffectiveness(db) as unknown as JsonValue };
      case "lesson_apply_candidate_view":
        return { ok: true, result: lessonApplyCandidates(db) as unknown as JsonValue };
      case "promoted_knowledge_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const origin = typeof arg.origin === "string" ? arg.origin : undefined;
        const since = typeof arg.since === "string" ? arg.since : undefined;
        const limit = typeof arg.limit === "number" ? arg.limit : undefined;
        return { ok: true, result: promotedKnowledge(db, { origin, since, limit }) as unknown as JsonValue };
      }
      case "recipe_registry_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const limit = typeof arg.limit === "number" ? arg.limit : undefined;
        return { ok: true, result: recipeRegistry(db, limit) as unknown as JsonValue };
      }
      case "brain_effectiveness_view": {
        // Brain elegance bc8je5f3x (2026-05-15): the brain can query its
        // own classification rate to learn whether depth-1 retrieval is
        // producing prompts the model can act on without refinement.
        // Pure read over events — no schema changes.
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const windowMs = typeof arg.window_ms === "number" ? arg.window_ms : undefined;
        return { ok: true, result: summarizeEffectiveness(db, { windowMs }) as unknown as JsonValue };
      }
      default:
        return { ok: false, error: `view_not_implemented:${view}` };
    }
  } catch (err) {
    return { ok: false, error: `view_read_failed:${(err as Error).message}` };
  }
};

export const handleGetEvent = (
  ctx: McpContext,
  args: z.infer<typeof IdSchema>,
): McpResult => {
  const ev = getEventById(ctx.db, args.id);
  if (!ev) return { ok: false, error: "event_not_found" };
  return { ok: true, result: ev as unknown as JsonValue };
};

export const handleGetArtifact = (
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

export const handleSearch = async (
  ctx: McpContext,
  args: z.infer<typeof SearchSchema>,
): Promise<McpResult> => {
  const k = Math.max(1, Math.min(100, args.opts?.k ?? 20));

  // Phase F: when the daemon mounted an index AND it has entries, route
  // through the reranker. Otherwise fall back to the recency stand-in so
  // fresh substrates / no-API-key environments still return structurally-
  // correct hits.
  if (ctx.index && ctx.index.size() > 0) {
    const result = await retrieve(ctx.db, ctx.index, {
      text: args.query,
      k,
      runtime: args.opts?.runtime,
      minScore: args.opts?.min_score,
      kindFilter: args.opts?.kind_filter,
      aspectWeights: args.opts?.aspect_weights,
      domainHints: args.opts?.domain_hints,
    });
    if (!result.query_embedding_unavailable) {
      return {
        ok: true,
        result: {
          hits: result.hits,
          mode: "rerank",
          query: args.query,
          mixed_version_excluded: result.mixed_version_excluded,
          retrieved_at: result.retrieved_at,
        } as JsonValue,
      };
    }
    // fall through to recency stand-in when query embedding unavailable
  }

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

export const handleEmbedText = async (
  _ctx: McpContext,
  args: z.infer<typeof EmbedTextSchema>,
): Promise<McpResult> => {
  const result = await computeEmbedding(args.text);
  if (!result) {
    return { ok: false, error: "embedding_unavailable" };
  }
  return {
    ok: true,
    result: {
      embedding: result.embedding,
      version: result.version,
      model: "text-embedding-3-small",
    } as JsonValue,
  };
};

// ── Phase C runtime handlers (substrate.run_artifact / run_verifier) ──
//
// substrate.run_artifact dispatches by the artifact's stored runtime:
//   - bun  → runBunArtifact
//   - uv   → runUvArtifact (Phase G wires this)
//   - camofox-browser → runCamofoxArtifact (Phase G wires this)
// substrate.run_verifier is structurally identical — verifiers are just
// code artifacts whose body is expected to return `{residual: number}`.
// We do NOT enforce the shape; we pass the observation as inputs and let
// the verifier body decide what to do.

const callArtifactByRuntime = async (
  ctx: McpContext,
  artifactId: string,
  inputs: JsonValue,
  budget: { wall_ms?: number; memory_mb?: number } | undefined,
): Promise<McpResult> => {
  const row = getArtifact(ctx.db, artifactId);
  if (!row) return { ok: false, error: "artifact_not_found" };
  // Dispatcher quarantine gate (§11.6): quarantined artifacts MUST NOT be
  // invoked. The rehab worker is the only path back to `admitted`. Fail
  // closed so a stale brain dispatch can't poke a known-bad artifact.
  if (row.status === "quarantined") {
    return { ok: false, error: "artifact_quarantined" };
  }
  const decl = row.declaredSandbox;
  if (decl.runtime !== row.runtime) {
    return { ok: false, error: "sandbox_decl_runtime_mismatch" };
  }
  const emit = (event: EmitEventInput): void => {
    try {
      emitEvent(ctx.db, { ...event, invoker: event.invoker ?? ctx.invoker });
    } catch { /* event-emission failure must not poison the runtime */ }
  };
  let observation: {
    ok: boolean;
    result?: JsonValue;
    error?: string;
    durationMs: number;
    exitCode: number;
    stderrTail: string;
    sandboxWarnings: string[];
    irreversibleEffects: Array<{ kind: string; description: string }>;
  };
  if (row.runtime === "bun") {
    observation = await runBunArtifact({
      artifactId: row.id,
      body: row.body,
      declaredSandbox: decl as Extract<SandboxDecl, { runtime: "bun" }>,
      inputs,
      budget: { wallMs: budget?.wall_ms, memoryMb: budget?.memory_mb },
      emit,
    });
  } else if (row.runtime === "uv") {
    observation = await runUvArtifact({
      artifactId: row.id,
      body: row.body,
      declaredSandbox: decl as Extract<SandboxDecl, { runtime: "uv" }>,
      inputs,
      budget: { wallMs: budget?.wall_ms, memoryMb: budget?.memory_mb },
      emit,
    });
  } else {
    observation = await runCamofoxArtifact({
      artifactId: row.id,
      body: row.body,
      declaredSandbox: decl as Extract<SandboxDecl, { runtime: "camofox-browser" }>,
      inputs,
      budget: { wallMs: budget?.wall_ms, memoryMb: budget?.memory_mb },
      emit,
    });
  }
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

export const handleRunArtifact = async (
  ctx: McpContext,
  args: z.infer<typeof RunArtifactSchema>,
): Promise<McpResult> => {
  const inputs = (args.inputs ?? null) as JsonValue;
  return callArtifactByRuntime(ctx, args.artifact_id, inputs, args.budget as { wall_ms?: number; memory_mb?: number } | undefined);
};

export const handleRunVerifier = async (
  ctx: McpContext,
  args: z.infer<typeof RunVerifierSchema>,
): Promise<McpResult> => {
  const observation = (args.observation ?? null) as JsonValue;
  return callArtifactByRuntime(ctx, args.verifier_artifact_id, observation, args.budget as { wall_ms?: number; memory_mb?: number } | undefined);
};

export const handleAdmitArtifact = async (
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
      targetFiles: args.target_files,
      targetResources: args.target_resources,
      governance: (args.directive_id || args.owner_consent_event_id) ? {
        directiveId: args.directive_id,
        ownerConsentEventId: args.owner_consent_event_id,
      } : undefined,
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

export const handleCredit = async (
  ctx: McpContext,
  args: z.infer<typeof CreditSchema>,
): Promise<McpResult> => {
  try {
    const result = await distributeCredit(ctx.db, {
      action_event_id: args.action_event_id,
      observation_event_id: args.observation_event_id,
      scored_event_id: args.scored_event_id,
      predicted_residual: args.predicted_residual,
      observed_residual: args.observed_residual,
    });
    return {
      ok: true,
      result: {
        action_artifact_id: result.action_artifact_id,
        verifier_artifact_id: result.verifier_artifact_id,
        predicted_residual: result.predicted_residual,
        observed_residual: result.observed_residual,
        delta: result.delta,
        contributions: result.contributions as unknown as JsonValue,
        emitted_events: result.emitted_events as unknown as JsonValue,
      } as JsonValue,
    };
  } catch (err) {
    return { ok: false, error: `credit_distribution_failed:${(err as Error).message}` };
  }
};

// ── Phase D handlers ──────────────────────────────────────────────

export const handleOpenFixture = async (
  ctx: McpContext,
  args: z.infer<typeof OpenFixtureSchema>,
): Promise<McpResult> => {
  if (args.fixture !== "d_count_todos") {
    return { ok: false, error: `unknown_fixture:${args.fixture}` };
  }
  const result = await openFixtureDCountTodos(ctx.db, args.target_path);
  return {
    ok: true,
    result: {
      directive_id: result.directiveId,
      task_id: result.taskId,
    } as JsonValue,
  };
};

export const handleAmendDirective = async (
  ctx: McpContext,
  args: z.infer<typeof AmendDirectiveSchema>,
): Promise<McpResult> => {
  // Brain privilege gate (parallel to open_directive): amendments are
  // owner/orchestrator actions. The brain refines work via task_edge_recorded
  // (refines) on NEW task_ids, not by amending the original directive.
  if (isBrainInvoker(ctx.invoker)) {
    return {
      ok: false,
      error: "brain_forbidden_op:substrate.amend_directive; use task_edge_recorded(refines) on the current directive instead",
    };
  }
  const summary = await emitAndApplyAmendment(ctx.db, {
    original_directive_id: args.original_directive_id,
    amendment_text: args.amendment_text,
    superseded_tasks: args.superseded_tasks,
    superseded_predictions: args.superseded_predictions,
    new_task_goals: args.new_task_goals,
    rationale: args.rationale,
    amended_by: args.amended_by,
  });
  return {
    ok: true,
    result: {
      amendment_event_id: summary.amendment_event_id,
      superseded_tasks_closed: summary.superseded_tasks_closed,
      superseded_predictions_marked: summary.superseded_predictions_marked,
      new_tasks_opened: summary.new_tasks_opened,
      already_applied: summary.already_applied,
    } as JsonValue,
  };
};

export const handleRecordStakeholderState = (
  ctx: McpContext,
  args: z.infer<typeof RecordStakeholderStateSchema>,
): McpResult => {
  const result = recordStakeholderState(ctx.db, {
    directive_id: args.directive_id,
    stakeholder_id: args.stakeholder_id,
    declared_utility: (args.declared_utility ?? null) as JsonValue,
    inferred_constraints: args.inferred_constraints,
    information_visibility: args.information_visibility as StakeholderVisibility | undefined,
  });
  return {
    ok: true,
    result: {
      event_id: result.event_id,
      conflict_count: result.conflicts.length,
      conflicts: result.conflicts as unknown as JsonValue,
    } as JsonValue,
  };
};

export const handleRecordInterferenceEdge = (
  ctx: McpContext,
  args: z.infer<typeof RecordInterferenceEdgeSchema>,
): McpResult => {
  const result = recordInterferenceEdge(ctx.db, {
    from_directive: args.from_directive,
    to_directive: args.to_directive,
    kind: args.kind as InterferenceEdgeKind,
    reason: args.reason,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, result: { event_id: result.event_id } as JsonValue };
};

export const handleOpenDirective = (
  ctx: McpContext,
  args: z.infer<typeof OpenDirectiveSchema>,
): McpResult => {
  // Brain privilege gate: opening a NEW top-level directive is an
  // owner/orchestrator action. The brain decomposes within its current
  // directive via task_node_opened + task_edge_recorded. Live evidence
  // (2026-05-15 02:00+) showed the brain recursively calling open_directive
  // with its own prompt text, doubling the "TASK GOAL:" prefix each cycle.
  if (isBrainInvoker(ctx.invoker)) {
    return {
      ok: false,
      error: "brain_forbidden_op:substrate.open_directive; use task_node_opened + task_edge_recorded (refines) under the current directive instead",
    };
  }
  // Structural prompt-template-leak gate: refuse directive_text that looks
  // like a leaked prompt-composer template (TASK GOAL: markers, WORKFLOW
  // / DIRECTIVE ID / RUNTIMES AVAILABLE prefaces, recursive doubling).
  // Catches the autonomous Father / shelled-out brain loop that fed its
  // OWN prompt back as a directive — the live ledger 2026-05-15 02:00-03:07
  // had 10+ such recursive openings before this gate.
  const leak = detectPromptTemplateLeak(args.directive_text);
  if (leak) {
    return {
      ok: false,
      error: `prompt_template_leak_refused:${leak}; directive_text must be fresh owner intent, not a re-injected prompt`,
    };
  }
  // Idempotent dedup: if an OPEN directive with the exact same text
  // already exists (not closed / not archived), return its id instead of
  // opening a duplicate. Pre-fix double-clicks and shell loops produced
  // sibling directives competing for the same concurrency slots.
  const existing = findOpenDirectiveByText(ctx.db, args.directive_text);
  if (existing) {
    return {
      ok: true,
      result: {
        directive_id: existing,
        task_id: existing,
        deduped: true,
        reason: "open_directive_text_already_exists",
      } as JsonValue,
    };
  }
  const directiveId = newId();
  const taskId = newId();
  const lifecyclePayload: Record<string, unknown> = {
    directive_text: args.directive_text,
    lifecycle: args.lifecycle ?? "finite",
    urgency: args.urgency ?? "normal",
  };
  if (args.lifecycle === "rolling_active") {
    lifecyclePayload.review_cadence = args.review_cadence ?? "weekly";
    lifecyclePayload.next_review_due = args.next_review_due ?? new Date().toISOString();
    lifecyclePayload.partial_commit_checkpoints = [];
  }
  emitEvent(ctx.db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: lifecyclePayload as JsonValue,
  });

  // Owner input is, by definition, the directive text. Emitting
  // owner_input_received here is the structural fix for the gap that
  // left OWNER CONTEXT empty in production — until 2026-05-15, this
  // kind had zero producers in the main repo even though OWNER
  // CONTEXT (last-8 readOwnerContext) + the vocabulary extractor +
  // the rendering-signal classifier all consume it. Without this
  // emit, the brain saw an empty owner-context section on every cycle
  // and the Layer-2 extractor pipeline had no input vocabulary to
  // mine. The emit also gives the embedder real text to vectorize so
  // semantic retrieval against owner phrasing actually works.
  emitEvent(ctx.db, {
    kind: "owner_input_received",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      text: args.directive_text,
      source: "acc_task_directive",
    } as JsonValue,
  });

  if (args.urgency === "crisis") {
    emitEvent(ctx.db, {
      kind: "crisis_mode_engaged",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      payload: { reason: "directive_urgency_crisis" } as JsonValue,
    });
  }

  emitEvent(ctx.db, {
    kind: "task_node_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: taskId,
    parent_task_id: null,
    payload: {
      goal: args.initial_task_goal ?? args.directive_text,
      lifecycle: "finite",
      urgency: args.urgency ?? "normal",
    } as JsonValue,
  });

  const stakeholderEventIds: string[] = [];
  if (args.stakeholders) {
    for (const s of args.stakeholders) {
      const r = recordStakeholderState(ctx.db, {
        directive_id: directiveId,
        stakeholder_id: s.stakeholder_id,
        declared_utility: (s.declared_utility ?? null) as JsonValue,
        inferred_constraints: s.inferred_constraints,
        information_visibility: s.information_visibility as StakeholderVisibility | undefined,
      });
      stakeholderEventIds.push(r.event_id);
    }
  }

  return {
    ok: true,
    result: {
      directive_id: directiveId,
      task_id: taskId,
      stakeholder_event_ids: stakeholderEventIds,
    } as JsonValue,
  };
};

// ── Phase J: recipe lookup ────────────────────────────────────────

export const handleFindRecipe = (
  ctx: McpContext,
  args: z.infer<typeof FindRecipeSchema>,
): McpResult => {
  const taskRow = ctx.db
    .query("SELECT directive_id FROM events WHERE task_id = ? AND kind = 'task_node_opened' LIMIT 1")
    .get(args.task_id) as { directive_id: string } | null;
  if (!taskRow) return { ok: false, error: "task_not_found" };
  const taskPayloadRow = ctx.db
    .query("SELECT payload FROM events WHERE task_id = ? AND kind = 'task_node_opened' LIMIT 1")
    .get(args.task_id) as { payload: string } | null;
  let goal = "";
  if (taskPayloadRow) {
    try {
      const p = JSON.parse(taskPayloadRow.payload ?? "{}") as Record<string, unknown>;
      goal = (p.goal as string | undefined) ?? "";
    } catch { /* swallow */ }
  }
  const match = findRecipeMatch(
    ctx.db,
    { id: args.task_id, directive_id: taskRow.directive_id, parent_id: null, goal, status: "pending" },
    { minConfidence: args.min_confidence },
  );
  if (!match) return { ok: true, result: null as unknown as JsonValue };
  return {
    ok: true,
    result: {
      recipe_id: match.recipe_id,
      goal_shape: match.goal_shape,
      topology_signature: match.topology_signature,
      confidence: match.confidence,
      trajectory_length: match.trajectory.length,
    } as JsonValue,
  };
};

// ── External-source registration (§5.2) ───────────────────────────

export const handleRegisterExternalSource = (
  ctx: McpContext,
  args: z.infer<typeof RegisterExternalSourceSchema>,
): McpResult => {
  if (!ctx.ingressState) {
    return { ok: false, error: "external_ingress_not_mounted" };
  }
  const { registerExternalSource } = require("../external_ingress") as typeof import("../external_ingress");
  const r = registerExternalSource(ctx.db, ctx.ingressState, args);
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    result: { source: r.source, token_preview: r.token_preview } as JsonValue,
  };
};
