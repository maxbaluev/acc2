// acc2 MCP server — substrate.* tool handlers. Split out of the
// monolithic runtime/mcp_server.ts so the substrate-facing 17 methods
// can evolve independently from the runtime.* tools.
//
// Every handler returns `McpResult` (`{ok: true, result} | {ok: false,
// error}`); fastmcp's `execute` wrapper JSON-stringifies the result so
// the wire shape is uniform.

import type { z } from "zod";
import type { Database } from "bun:sqlite";
import type { BunSandboxDecl, CamofoxSandboxDecl, JsonValue, Runtime, SandboxDecl, SubstrateOrigin, UvSandboxDecl } from "../../substrate/types";
import { EVENT_KINDS, getCurrentEventKinds } from "../../substrate/event_kinds";
import { emitEvent, getEventById, type EmitEventInput } from "../events";
import { summarizeEffectiveness } from "../brain_effectiveness";
import { runBunArtifact } from "../runtimes/bun";
import { runUvArtifact } from "../runtimes/uv";
import { runCamofoxArtifact } from "../runtimes/camofox";
import { lookupRunnerInRegistry, runArtifactForRuntime } from "../runtimes/index";
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
import { findSimilarRecentCandidate } from "../knowledge_dedup";
import { newId } from "../ids";
import { evaluateClosureCommitGate } from "../closure_audit";
import {
  actArtifactRegistry,
  readyTasks,
  dispatchResolved,
  dispatchResolvedPooled,
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
  ownerRenderingPolicy,
  ownerRenderingEffectiveness,
  ownerPlainStatus,
  ownerStateBelief,
  ownerAlignmentActionPolicy,
  retrievalCredit,
  topLaws,
  lowRiskInlinePatterns,
  lessonImplementerQueue,
  pendingOwnerDecisionQueue,
  lessonImplementationStatus,
  appliedLessonEffectiveness,
  lessonApplyCandidates,
  promotedKnowledge,
  recipeRegistry,
  actProjectionObservability,
  substrateNarrativeRecent,
  claudeInlineReadyLeaves,
  pendingContractAmendments,
  directives,
  taskCriticalPaths,
  activeInference,
  artifactWarnings,
  modelRouting,
} from "../../substrate/views";
import { readPeerActivity } from "../peer_registry";
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
  // Hot-reload (2026-05-17): read through getCurrentEventKinds() so kinds
  // registered after a hot-reload of substrate/event_kinds.ts become
  // emittable via MCP without a daemon restart. The captured EVENT_KINDS
  // binding is import-time-frozen and would reject kinds added after
  // boot otherwise — proven blocker for the just-added
  // pre_apply_adjudication_recorded + runtime_self_diagnostic_recorded.
  if (!(kind in getCurrentEventKinds())) {
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
    // Closed-directive emission gate (2026-05-17): refuse new
    // task_node_opened emissions under a directive that's already
    // closed/archived. Live evidence: 74 production directives had
    // directive_closed reason=all_tasks_terminal AND undispatched
    // task_nodes — the brain (or some emitter) opened new tasks AFTER
    // closure, creating stragglers that never run. The view-side fix
    // in dbd8f69 reclassifies the existing 216 stragglers as
    // 'abandoned'; this producer-side gate prevents NEW ones.
    if (directiveId) {
      // Determine whether the directive's LATEST lifecycle event is a
      // closure or a resume. Use (ts, rowid) ordering so two events
      // inserted in the same millisecond still compare deterministically
      // (matches the closedDirectiveIds semantics in
      // runtime/directive_closure.ts:54-72 which iterates by ts then
      // rowid implicitly via SQLite insertion order).
      const latest = ctx.db
        .query(
          `SELECT kind FROM events
           WHERE directive_id = ?
             AND kind IN (
               'directive_closed',
               'directive_archived_by_operator',
               'directive_archived_missed_reviews',
               'directive_resumed'
             )
           ORDER BY ts DESC, rowid DESC LIMIT 1`,
        )
        .get(directiveId) as { kind: string } | null;
      if (latest && latest.kind !== "directive_resumed") {
        return {
          ok: false,
          error: `closed_directive_emit_refused:${directiveId};closure_kind=${latest.kind};hint=open a new directive (acc task) or emit directive_resumed first if the work was prematurely closed — the substrate refuses new task_node_opened emissions under a closed/archived DAG to prevent straggler accumulation`,
        };
      }
    }
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
    // PER-DIRECTIVE TASK FANOUT CAP (FOUNDATIONAL FIX 2026-05-17):
    // Live ledger evidence: 3 owner directives → 100+ task_node_opened rows,
    // ~30x amplification. The brain decomposes broadly (Q1-Q6 per directive)
    // then re-dispatches itself on each child, which the dispatch_decider
    // defaults to opencode_brain, which the brain often silent-exits on
    // because there's nothing strategic left to add. The downstream result
    // was the bridge_stuck / silent_dispatch loop the operator has been
    // chasing for hours.
    //
    // The structural fix: cap the total task_node_opened per directive at
    // PER_DIRECTIVE_TASK_NODE_CAP. The brain must COMMIT existing children
    // before opening more — forcing the decomposition to actually resolve
    // rather than fan out indefinitely. 20 is generous (Q1-Q6 plus follow-
    // ups for each), tight enough to force discipline.
    //
    // Owner-opened tasks bypass the cap (substrate_origin === "owner") —
    // the owner is the trust root and may legitimately ask for many tasks
    // in one directive. Only brain-emitted (substrate_origin === "opencode"
    // or "claude_root" coming through MCP) task_node_opened is capped.
    const PER_DIRECTIVE_TASK_NODE_CAP = 20;
    if (directiveId && isBrainEmit(src.substrate_origin, ctx.invoker)) {
      const countRow = ctx.db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM events
           WHERE kind = 'task_node_opened' AND directive_id = ?`,
        )
        .get(directiveId);
      const count = countRow?.n ?? 0;
      if (count >= PER_DIRECTIVE_TASK_NODE_CAP) {
        return {
          ok: false,
          error: `per_directive_task_node_cap_exceeded:cap=${PER_DIRECTIVE_TASK_NODE_CAP};existing=${count};directive=${directiveId};hint=this directive already has ${count} task_node_opened rows — the brain MUST COMMIT existing open children (substrate.emit{kind:"task_committed"}) before opening more. Use substrate.read{view_name:"task_graph_view",args:{directive_id:"${directiveId}"}} to see open children; complete or close them before further decomposition. The cap is structural to prevent silent-dispatch loops when the brain fans out broadly and re-dispatches itself on children it has nothing strategic to add to.`,
        };
      }
    }
  }
  // δ-mem follow-up (2026-05-17): emit-time dedup gate for
  // knowledge_candidate. Live ledger evidence over 24h: 770
  // knowledge_candidate emissions produced 8807 candidate_confirmed
  // rows — ~11x duplication. Brain analysis (directive Z8JQJB2S,
  // knowledge_candidate KDX9K3NG): "duplicate clusters become
  // artificial confidence". The structural fix is to refuse the
  // duplicate at the emit boundary and return the existing event's id
  // (first-wins idempotent shape, mirrors the terminal-event-conflict
  // gate at runtime/events.ts:82-113). Brain gets explicit feedback
  // "you already said this" instead of the extractor silently
  // absorbing it post-hoc.
  //
  // Bypass in test mode (NODE_ENV=test || ACC2_BRIDGE_MODE=mock) so
  // existing fixtures that intentionally emit similar candidates
  // remain green. Production gets the gate.
  if (kind === "knowledge_candidate") {
    const directiveId = src.directive_id as string | undefined;
    const substrateOrigin = (src.substrate_origin as string | undefined) ?? ctx.invoker;
    const payloadObj = (src.payload && typeof src.payload === "object" && !Array.isArray(src.payload))
      ? src.payload as Record<string, unknown>
      : {};
    const claim = typeof payloadObj.claim === "string" ? payloadObj.claim : undefined;
    const isTestMode = process.env.ACC2_BRIDGE_MODE === "mock" || process.env.NODE_ENV === "test";
    if (!isTestMode && directiveId && substrateOrigin && claim) {
      const match = findSimilarRecentCandidate(ctx.db, {
        claim,
        directive_id: directiveId,
        substrate_origin: substrateOrigin,
      });
      if (match) {
        // Refuse + emit knowledge_candidate_redundant pointing at the
        // matched prior. Return the existing event's id so the brain's
        // downstream wiring resolves the same way it would for a
        // first-wins idempotent emit.
        try {
          emitEvent(ctx.db, {
            kind: "knowledge_candidate_redundant",
            substrate_origin: "substrate_auto",
            directive_id: directiveId,
            task_id: src.task_id,
            payload: {
              refused_emit_kind: "knowledge_candidate",
              refused_author: substrateOrigin,
              matched_event_id: match.matched_event_id,
              matched_ts: match.matched_ts,
              similarity: match.similarity,
              method: match.method,
              scanned_count: match.scanned_count,
              refused_claim_preview: claim.slice(0, 200),
              hint: "Your new candidate's claim duplicates a recent emission on this directive (Jaccard >= threshold). Returning the existing event_id — your downstream citations/wiring stay consistent. If the new candidate is genuinely novel (contradiction, refinement, new evidence) rephrase the claim to make the residual signal explicit.",
            } as JsonValue,
          });
        } catch { /* swallow — refusal stands even if the dedup audit emit fails */ }
        // Fetch the matched event's ts to return in the idempotent shape.
        const tsRow = ctx.db
          .query<{ ts: string }, [string]>(
            `SELECT ts FROM events WHERE id = ?`,
          )
          .get(match.matched_event_id);
        return {
          ok: true,
          result: {
            id: match.matched_event_id,
            ts: tsRow?.ts ?? match.matched_ts,
            redundant: true,
            matched_event_id: match.matched_event_id,
            similarity: match.similarity,
          } as JsonValue,
        };
      }
    }
  }
  if (kind === "pre_apply_adjudication_recorded") {
    const payload = (src.payload && typeof src.payload === "object" && !Array.isArray(src.payload))
      ? src.payload as Record<string, unknown>
      : {};
    const verdict = payload.verdict;
    const targetEventId = payload.target_event_id;
    const evidenceEventIds = payload.evidence_event_ids;
    if (typeof verdict !== "string" || verdict.length === 0) {
      return { ok: false, error: "pre_apply_adjudication_recorded_missing_verdict" };
    }
    if (typeof targetEventId !== "string" || targetEventId.length === 0) {
      return { ok: false, error: "pre_apply_adjudication_recorded_missing_target_event_id" };
    }
    if (evidenceEventIds !== undefined && (!Array.isArray(evidenceEventIds) || evidenceEventIds.some((id) => typeof id !== "string" || id.length === 0))) {
      return { ok: false, error: "pre_apply_adjudication_recorded_invalid_evidence_event_ids" };
    }
    if (payload.owner_authority_level !== undefined && typeof payload.owner_authority_level !== "string") {
      return { ok: false, error: "pre_apply_adjudication_recorded_invalid_owner_authority_level" };
    }
    const target = getEventById(ctx.db, targetEventId);
    if (!target) {
      return { ok: false, error: `pre_apply_adjudication_target_not_found:${targetEventId}` };
    }
    const allowedTargetKinds = new Set(["contract_amendment_proposed", "act_tuple_recorded", "knowledge_candidate"]);
    if (!allowedTargetKinds.has(target.kind)) {
      return { ok: false, error: `pre_apply_adjudication_target_not_proposal:${targetEventId};kind=${target.kind}` };
    }
    const terminal = ctx.db
      .query(`SELECT id, kind FROM events
              WHERE kind IN ('applied_change_committed','applied_change_failed','candidate_confirmed','candidate_contradicted','knowledge_promoted','knowledge_demoted','action_scored')
                AND (json_extract(payload, '$.source_event_id') = ?
                  OR json_extract(payload, '$.target_event_id') = ?
                  OR EXISTS (SELECT 1 FROM json_each(events.context_refs) WHERE value = ?))
              ORDER BY ts ASC LIMIT 1`)
      .get(targetEventId, targetEventId, targetEventId) as { id: string; kind: string } | null;
    if (terminal) {
      return { ok: false, error: `pre_apply_adjudication_target_terminal:${targetEventId};terminal_kind=${terminal.kind};terminal_event_id=${terminal.id}` };
    }
  }
  // SELF01-04 runtime_self_diagnostic_recorded validator. Free-string
  // runtime + fault_kind (universal-kind principle), optional repair_hint
  // and auto_repair_action. Per VQA4E2HC3H7X: today only bun preflights;
  // uv and camofox silently pass — this event_kind closes that gap by
  // making fault detection ledger-visible across all runtimes.
  if (kind === "runtime_self_diagnostic_recorded") {
    const payload = (src.payload && typeof src.payload === "object" && !Array.isArray(src.payload))
      ? src.payload as Record<string, unknown>
      : {};
    const runtime = payload.runtime;
    const faultKind = payload.fault_kind;
    if (typeof runtime !== "string" || runtime.length === 0) {
      return { ok: false, error: "runtime_self_diagnostic_recorded_missing_runtime" };
    }
    if (typeof faultKind !== "string" || faultKind.length === 0) {
      return { ok: false, error: "runtime_self_diagnostic_recorded_missing_fault_kind" };
    }
    if (payload.repair_hint !== undefined && typeof payload.repair_hint !== "string") {
      return { ok: false, error: "runtime_self_diagnostic_recorded_invalid_repair_hint" };
    }
    if (payload.auto_repair_action !== undefined && typeof payload.auto_repair_action !== "string") {
      return { ok: false, error: "runtime_self_diagnostic_recorded_invalid_auto_repair_action" };
    }
    if (payload.evidence_event_ids !== undefined) {
      const refs = payload.evidence_event_ids;
      if (!Array.isArray(refs) || refs.some((id) => typeof id !== "string" || id.length === 0)) {
        return { ok: false, error: "runtime_self_diagnostic_recorded_invalid_evidence_event_ids" };
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
  // FOUNDATIONAL: action_predicted has producer="brain" in event_kinds.ts
  // — only the brain emits this kind in production. The brain emits via
  // MCP with substrate_origin sometimes "claude_root" (daemon default),
  // sometimes "opencode" (when explicit), so isBrainEmit alone misses the
  // common case. The kind itself proves it's a brain emit; the tuple is
  // structurally required regardless of the substrate_origin label.
  if (kind === "action_predicted") {
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
  // Hardened closure commit gate (2026-05-20). Refuse task_committed
  // emissions whose referenced task_id has a recent
  // task_closure_audited row with closure_residual >= threshold
  // (default 0.3, configurable via threshold registry). Live evidence
  // pre-fix: 10 task_committed events at residual >= 0.3 in 24h,
  // including 3 at residual = 1.00 — the brain's workflow documented
  // "refine, do NOT commit" but the dispatcher accepted the emission.
  // evaluateClosureCommitGate emits closure_blocked_high_residual on
  // refusal and closure_override_acknowledged when a fresh
  // owner_input_received{closure_override:true} post-dates the audit.
  // Fail-OPEN when no audit row exists for the task — pre-audit tasks
  // remain on the existing commit path.
  if (kind === "task_committed" && typeof input.task_id === "string") {
    const decision = evaluateClosureCommitGate(ctx.db, {
      task_id: input.task_id,
      directive_id: typeof input.directive_id === "string" ? input.directive_id : undefined,
    });
    if (!decision.allow) {
      return {
        ok: false,
        error:
          `closure_gate_high_residual:closure_residual=${decision.closure_residual.toFixed(3)};threshold=${decision.threshold.toFixed(3)};` +
          `closure_audit_event_id=${decision.closure_audit_event_id};` +
          `blocked_event_id=${decision.blocked_event_id};` +
          `discrepancies=${decision.discrepancies.join("|") || "<none>"};` +
          `hint=closure_residual >= threshold and no fresh owner_input_received{closure_override:true} post-dates the audit. Open a refinement edge (task_node_opened + task_edge_recorded{kind:'refines'}) to address the discrepancies, OR have the owner emit owner_input_received{closure_override:true} on this task to override.`,
      };
    }
  }
  const emitted = emitEvent(ctx.db, input);
  return { ok: true, result: { id: emitted.id, ts: emitted.ts } };
};

// T3.8/T5: SQL worker-thread pool router. Aggregate-heavy view projections
// (event_kind_occurrence_view, worker_liveness_view,
// stale_zero_score_knowledge_view) are routed off the main thread when the
// pool is present so Bun.SQL's fake-async sync read can't block emitEvent
// + bridge IO. When the pool is absent (tests, ACC2_DISABLE_SQL_POOL=1),
// we fall back to the synchronous main-thread path.
const poolQuery = async <T>(db: Database, sql: string, params: unknown[]): Promise<T[]> => {
  try {
    const mod = await import("../sql_pool_singleton");
    const pool = mod.getSqlPool();
    if (pool) return pool.query<T>(sql, params);
  } catch { /* tolerate — fall through to sync */ }
  return (params.length > 0 ? db.query(sql).all(...(params as Parameters<typeof db.query>)) : db.query(sql).all()) as T[];
};

export const handleRead = (
  ctx: McpContext,
  args: z.infer<typeof ReadSchema>,
): McpResult | Promise<McpResult> => {
  // Route `view_name` to the substrate/views.ts accessor.
  // Unknown views return `view_not_implemented:<name>` so callers see a
  // clear signal instead of a silent empty. The set below mirrors §4.2
  // of v2-design.md.
  const db = ctx.db;
  const view = args.view_name;
  try {
    switch (view) {
      case "act_artifact_registry_view":
      // Pre-rename view name accepted so historical brain dispatches resolve.
      case "code_artifact_registry_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const runtime = typeof arg.runtime === "string" ? arg.runtime : undefined;
        return { ok: true, result: actArtifactRegistry(db, runtime) as unknown as JsonValue };
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
        // dispatch_resolved_view is the authoritative dispatch-truth surface the
        // orchestrator polls every ~5s during a live owner turn. On the 374K-event
        // DB it materializes a full recursive task tree + per-task CTEs across all
        // directives (~217ms even when scoped — SQLite can't push the outer WHERE
        // into the materialized CTEs). Route through the SQL worker pool so it
        // doesn't block the daemon main loop / starve /health; sync fallback when
        // no pool (tests, ACC2_DISABLE_SQL_POOL). Identical results + ordering.
        return (async (): Promise<McpResult> => {
          const rows = await dispatchResolvedPooled(db, poolQuery, { directiveId, rootTaskId });
          return { ok: true, result: rows as unknown as JsonValue };
        })();
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
        return (async (): Promise<McpResult> => {
          const rows = await poolQuery<Record<string, unknown>>(db, "SELECT * FROM embedding_index_view", []);
          return { ok: true, result: rows as unknown as JsonValue };
        })();
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
      case "owner_rendering_policy_view": {
        // Owner-visible rendering loop — brain contract Q471RAN88X0H513V8BC3BTW0AW.
        // Returns null if no owner_profile_recorded row exists yet (cold install).
        // Args: none (single-row latest policy).
        return { ok: true, result: ownerRenderingPolicy(db) as unknown as JsonValue };
      }
      case "owner_rendering_effectiveness_view": {
        // Args: { audience?, surface?, limit? } — caller filters by primary
        // vs detail_drawer, by tui vs chat vs export, or just reads recent.
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const audience = typeof arg.audience === "string" ? arg.audience : undefined;
        const surface = typeof arg.surface === "string" ? arg.surface : undefined;
        const limit = typeof arg.limit === "number" ? arg.limit : undefined;
        return {
          ok: true,
          result: ownerRenderingEffectiveness(db, { audience, surface, limit }) as unknown as JsonValue,
        };
      }
      case "owner_state_belief_view": {
        // Owner world-model evidence layer — brain contract
        // CY7E62DSNX1DZ1BTD56845D994. Returns null when no
        // owner_state_hypothesis_recorded row exists yet.
        return { ok: true, result: ownerStateBelief(db) as unknown as JsonValue };
      }
      case "top_laws_view": {
        // Phase I3: auto-compiled Top Laws — the substrate's highest-
        // scoring promoted knowledge, ranked by Beta posterior. The
        // orchestrator reads this at session-start (and on demand) so
        // the operating contract self-updates from evidence rather
        // than being hard-coded as text-on-disk.
        // Args: { min_score?, limit? }
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const minScore = typeof arg.min_score === "number" ? arg.min_score : undefined;
        const limit = typeof arg.limit === "number" ? arg.limit : undefined;
        return { ok: true, result: topLaws(db, { min_score: minScore, limit }) as unknown as JsonValue };
      }
      case "retrieval_credit_view": {
        // Phase I1: RLM retrieval credit observability. Args:
        // { directive_id?, band?, limit? }. band ∈ {unused, rejected,
        // positive, mixed, negative}.
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : undefined;
        const band = typeof arg.band === "string" ? arg.band as "unused" | "rejected" | "positive" | "mixed" | "negative" : undefined;
        const limit = typeof arg.limit === "number" ? arg.limit : undefined;
        return {
          ok: true,
          result: retrievalCredit(db, { directive_id: directiveId, band, limit }) as unknown as JsonValue,
        };
      }
      case "owner_alignment_action_policy_view": {
        // Phase H5: recent alignment_action_selected × paired
        // prediction errors × belief axes. Args: { directive_id?,
        // action_kind?, limit? }.
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : undefined;
        const actionKind = typeof arg.action_kind === "string" ? arg.action_kind : undefined;
        const limit = typeof arg.limit === "number" ? arg.limit : undefined;
        return {
          ok: true,
          result: ownerAlignmentActionPolicy(db, { directive_id: directiveId, action_kind: actionKind, limit }) as unknown as JsonValue,
        };
      }
      case "owner_plain_status_view": {
        // Args: { directive_id?, limit? } — TUI primary surface reads
        // this view to render plain-language status cards. By default
        // returns the 20 most recently-active directives newest-first.
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : undefined;
        const limit = typeof arg.limit === "number" ? arg.limit : undefined;
        return {
          ok: true,
          result: ownerPlainStatus(db, { directive_id: directiveId, limit }) as unknown as JsonValue,
        };
      }
      case "event_kind_occurrence_view": {
        // Closes the dead-event_kinds hole-audit gap (brain KCs
        // 80MCT8D0S17W + CZS8VBKGAD4K): catalog which registered
        // kinds have actually been emitted vs. registered-but-dead.
        // Args: { window_hours?, dead_only? }. When dead_only=true,
        // LEFT-JOIN against the EVENT_KINDS registry and return rows
        // whose occurrence_count = 0 (registered but never emitted).
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const windowHours = typeof arg.window_hours === "number" ? arg.window_hours : undefined;
        const deadOnly = arg.dead_only === true;
        if (deadOnly) {
          // Build a values list from EVENT_KINDS and LEFT JOIN events
          // (optionally restricted to window). Surfaces zero-count
          // registered kinds. Parameterized: window placeholder only
          // (kind names come from a trusted source — the local enum).
          const kinds = Object.keys(EVENT_KINDS);
          if (kinds.length === 0) {
            return {
              ok: true,
              result: { rows: [], view_name: view, args, generated_at: new Date().toISOString() } as unknown as JsonValue,
            };
          }
          // SQLite's VALUES-with-column-alias syntax is dialect-restricted;
          // use a UNION ALL of `SELECT ? AS kind` rows for the registry CTE
          // so the LEFT JOIN against events works portably under bun:sqlite.
          const registryCte = kinds.map(() => "SELECT ? AS kind").join(" UNION ALL ");
          const eventsScope = windowHours !== undefined
            ? `(SELECT kind, ts, substrate_origin FROM events WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' hours'))`
            : `events`;
          const sql = `
            WITH registry AS (${registryCte})
            SELECT
              registry.kind AS kind,
              COUNT(e.kind) AS occurrence_count,
              MIN(e.ts) AS first_emit_ts,
              MAX(e.ts) AS last_emit_ts,
              COUNT(DISTINCT e.substrate_origin) AS distinct_origins
            FROM registry
            LEFT JOIN ${eventsScope} AS e ON e.kind = registry.kind
            GROUP BY registry.kind
            HAVING COUNT(e.kind) = 0
            ORDER BY registry.kind ASC
          `;
          const bindings: Array<string | number> = [...kinds];
          if (windowHours !== undefined) bindings.push(windowHours);
          // T3.8/T5: route through worker-thread pool when available.
          return (async (): Promise<McpResult> => {
            const rows = await poolQuery<Record<string, unknown>>(db, sql, bindings);
            return {
              ok: true,
              result: { rows, view_name: view, args, generated_at: new Date().toISOString() } as unknown as JsonValue,
            };
          })();
        }
        const sql = windowHours !== undefined
          ? `
            SELECT
              kind,
              COUNT(*) AS occurrence_count,
              MIN(ts) AS first_emit_ts,
              MAX(ts) AS last_emit_ts,
              COUNT(DISTINCT substrate_origin) AS distinct_origins
            FROM events
            WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' hours')
            GROUP BY kind
            ORDER BY last_emit_ts DESC
          `
          : `
            SELECT
              kind,
              COUNT(*) AS occurrence_count,
              MIN(ts) AS first_emit_ts,
              MAX(ts) AS last_emit_ts,
              COUNT(DISTINCT substrate_origin) AS distinct_origins
            FROM events
            GROUP BY kind
            ORDER BY last_emit_ts DESC
          `;
        // T3.8/T5: route through worker-thread pool when available.
        return (async (): Promise<McpResult> => {
          const bindings: unknown[] = windowHours !== undefined ? [windowHours] : [];
          const rows = await poolQuery<Record<string, unknown>>(db, sql, bindings);
          return {
            ok: true,
            result: { rows, view_name: view, args, generated_at: new Date().toISOString() } as unknown as JsonValue,
          };
        })();
      }
      case "worker_liveness_view": {
        // Closes brain KC CZS8VBKGAD4K: dead workers — registered
        // but never tick in window. Aggregates worker_tick_completed
        // events by the payload's `worker` key (canonical producer
        // field per live ledger evidence; brain KC 5EX1PHZYZD4R caught
        // an earlier draft that grouped by a nonexistent `worker_name`
        // key and rolled every row under one null bucket).
        // Args: { window_hours? } (default 24). No registry-sweep
        // dead_only branch yet — there is no canonical ALL_WORKER_NAMES
        // export; that follow-up is a separate contract.
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const windowHours = typeof arg.window_hours === "number" ? arg.window_hours : 24;
        const sql = `
          SELECT
            json_extract(payload, '$.worker') AS worker_name,
            COUNT(*) AS tick_count,
            MIN(ts) AS first_tick_ts,
            MAX(ts) AS last_tick_ts,
            CAST((julianday('now') - julianday(MAX(ts))) * 86400 AS INTEGER) AS seconds_since_last_tick
          FROM events
          WHERE kind = 'worker_tick_completed'
            AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' hours')
          GROUP BY worker_name
          ORDER BY last_tick_ts DESC
        `;
        // T3.8/T5: route through worker-thread pool when available.
        return (async (): Promise<McpResult> => {
          const rows = await poolQuery<Record<string, unknown>>(db, sql, [windowHours]);
          return {
            ok: true,
            result: { rows, view_name: view, args, generated_at: new Date().toISOString() } as unknown as JsonValue,
          };
        })();
      }
      case "peer_registry_view": {
        // Tier U/U1: unified multi-brain peer awareness. The SQL view
        // performs registration/activity coalescing and 24h dead-peer aging;
        // this read path preserves the standard substrate.read envelope.
        const rows = db
          .query("SELECT * FROM peer_registry_view ORDER BY last_seen_ts DESC")
          .all() as Array<Record<string, unknown>>;
        return {
          ok: true,
          result: { rows, view_name: view, args, generated_at: new Date().toISOString() } as unknown as JsonValue,
        };
      }
      case "peer_activity_view": {
        // Tier U/U2: on-the-fly mutual awareness. Args:
        // { current_peer_id?, target_resource?, limit? }. current_peer_id
        // excludes the caller so peers see other live peers before acting.
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const currentPeerId = typeof arg.current_peer_id === "string" ? arg.current_peer_id : undefined;
        const targetResource = typeof arg.target_resource === "string" ? arg.target_resource : undefined;
        const limit = typeof arg.limit === "number" ? arg.limit : undefined;
        return {
          ok: true,
          result: {
            rows: readPeerActivity(db, { current_peer_id: currentPeerId, target_resource: targetResource, limit }) as unknown as JsonValue,
            view_name: view,
            args,
            generated_at: new Date().toISOString(),
          } as unknown as JsonValue,
        };
      }
      case "stale_zero_score_knowledge_view": {
        // Closes brain KC KRG33K7VT14M: promoted knowledge with no
        // posterior activity (never cited, never confirmed/contradicted)
        // older than minimum_hours_stale (default 168 = 1 week).
        // Surfaces decorative promotions that didn't bind to any
        // action — the complement of promoted_knowledge_view.
        // Args: { minimum_hours_stale? }.
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const minHours = typeof arg.minimum_hours_stale === "number" ? arg.minimum_hours_stale : 168;
        const sql = `
          SELECT
            k.id AS knowledge_id,
            json_extract(k.payload, '$.claim') AS claim,
            k.ts AS promoted_ts,
            CAST((julianday('now') - julianday(k.ts)) * 86400 / 3600 AS INTEGER) AS hours_since_promotion,
            COALESCE(c.confirm_count, 0) AS confirm_count,
            COALESCE(x.contradict_count, 0) AS contradict_count,
            COALESCE(rb.retrieval_count, 0) AS retrieval_count
          FROM events k
          LEFT JOIN (
            SELECT json_extract(payload, '$.knowledge_id') AS kid, COUNT(*) AS confirm_count
            FROM events WHERE kind = 'candidate_confirmed' GROUP BY kid
          ) c ON c.kid = k.id
          LEFT JOIN (
            SELECT json_extract(payload, '$.knowledge_id') AS kid, COUNT(*) AS contradict_count
            FROM events WHERE kind = 'candidate_contradicted' GROUP BY kid
          ) x ON x.kid = k.id
          LEFT JOIN (
            SELECT json_extract(payload, '$.knowledge_id') AS kid, COUNT(*) AS retrieval_count
            FROM events WHERE kind = 'retrieval_binding' GROUP BY kid
          ) rb ON rb.kid = k.id
          WHERE k.kind = 'knowledge_promoted'
            AND COALESCE(c.confirm_count, 0) = 0
            AND COALESCE(x.contradict_count, 0) = 0
            AND CAST((julianday('now') - julianday(k.ts)) * 86400 / 3600 AS INTEGER) > ?
          ORDER BY hours_since_promotion DESC
          LIMIT 100
        `;
        // T3.8/T5: route through worker-thread pool when available.
        return (async (): Promise<McpResult> => {
          const rows = await poolQuery<Record<string, unknown>>(db, sql, [minHours]);
          return {
            ok: true,
            result: { rows, view_name: view, args, generated_at: new Date().toISOString() } as unknown as JsonValue,
          };
        })();
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
      case "pending_contract_amendments_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : undefined;
        const limit = typeof arg.limit === "number" ? arg.limit : undefined;
        const rows = pendingContractAmendments(db, { directiveId, limit });
        return {
          ok: true,
          result: rows.map((row) => {
            const payloadEvidence = Array.isArray(row.payload.evidence_event_ids)
              ? row.payload.evidence_event_ids.filter((x) => typeof x === "string") as string[]
              : [];
            const evidenceEventIds = Array.from(new Set([row.proposal_id, ...row.context_refs, ...payloadEvidence]));
            return {
              ...row,
              proposal_event_id: row.proposal_id,
              status: "unsettled",
              evidence_event_ids: evidenceEventIds,
              triage: {
                predicate_specificity: row.predicate ? 1 : 0,
                target_concreteness: row.target_resource && row.target_files && row.target_files.length > 0 ? 1 : 0,
                dependency_state: row.dependencies_closed ? 1 : 0,
                supersession_state: row.supersession_state === "live" ? 1 : 0,
                already_applied_evidence: row.has_applied_change ? 0 : 1,
                priority_score: Math.max(0, Math.min(1, row.selection_priority / 100)),
              },
              selection_gate: {
                requires_anchor_freshness: true,
                requires_semantic_duplicate_detection: true,
                requires_behavioral_novelty: true,
                requires_necessity: true,
              },
            };
          }) as unknown as JsonValue,
        };
      }
      case "claude_inline_ready_leaves_view": {
        // L3 inbox surface — brain design 48SN4XF3WN4KBBCHHCANDRDQRW.
        // Args: { directive_id?, limit?, only_unclaimed? }.
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : undefined;
        const limit = typeof arg.limit === "number" ? arg.limit : undefined;
        const onlyUnclaimed = arg.only_unclaimed === true;
        return {
          ok: true,
          result: claudeInlineReadyLeaves(db, { directive_id: directiveId, limit, only_unclaimed: onlyUnclaimed }) as unknown as JsonValue,
        };
      }
      case "substrate_narrative_recent_view": {
        // Content-first TUI primitive — brain design D9TBCHADS97DHAMNBC686HE3P0.
        // Args: { limit?, directive_id?, importance_in?, kinds_in? }.
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const limit = typeof arg.limit === "number" ? arg.limit : undefined;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : undefined;
        const importanceIn = Array.isArray(arg.importance_in)
          ? (arg.importance_in as unknown[]).filter((x): x is "critical" | "high" | "medium" | "low" =>
              x === "critical" || x === "high" || x === "medium" || x === "low",
            )
          : undefined;
        const kindsIn = Array.isArray(arg.kinds_in)
          ? (arg.kinds_in as unknown[]).filter((x): x is string => typeof x === "string")
          : undefined;
        return {
          ok: true,
          result: substrateNarrativeRecent(db, {
            limit,
            directive_id: directiveId,
            importance_in: importanceIn,
            kinds_in: kindsIn,
          }) as unknown as JsonValue,
        };
      }
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
      case "act_projection_observability_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const sourceActId = typeof arg.source_act_id === "string" ? arg.source_act_id : null;
        if (!sourceActId) return { ok: false, error: "act_projection_observability_view_requires_source_act_id" };
        return { ok: true, result: actProjectionObservability(db, sourceActId) as unknown as JsonValue };
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
      case "directive_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : undefined;
        return { ok: true, result: directives(db, directiveId) as unknown as JsonValue };
      }
      case "task_critical_path_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : undefined;
        return { ok: true, result: taskCriticalPaths(db, directiveId) as unknown as JsonValue };
      }
      case "active_inference_view": {
        return { ok: true, result: activeInference(db) as unknown as JsonValue };
      }
      case "artifact_warning_view": {
        return { ok: true, result: artifactWarnings(db) as unknown as JsonValue };
      }
      case "model_routing_view": {
        return { ok: true, result: modelRouting(db) as unknown as JsonValue };
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
    .query("SELECT * FROM act_artifact WHERE id = ?")
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
  // Path A (2026-05-20, contract A0DQT211JH): data-class rows have
  // runtime=null and declaredSandbox=null — no executable semantics.
  // Refuse invocation explicitly so callers get a clean error.
  if (row.runtime === null || row.declaredSandbox === null) {
    return { ok: false, error: "artifact_not_executable_data_class" };
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
      declaredSandbox: decl as BunSandboxDecl,
      inputs,
      budget: { wallMs: budget?.wall_ms, memoryMb: budget?.memory_mb },
      emit,
    });
  } else if (row.runtime === "uv") {
    observation = await runUvArtifact({
      artifactId: row.id,
      body: row.body,
      declaredSandbox: decl as UvSandboxDecl,
      inputs,
      budget: { wallMs: budget?.wall_ms, memoryMb: budget?.memory_mb },
      emit,
    });
  } else if (row.runtime === "camofox-browser") {
    observation = await runCamofoxArtifact({
      artifactId: row.id,
      body: row.body,
      declaredSandbox: decl as CamofoxSandboxDecl,
      inputs,
      budget: { wallMs: budget?.wall_ms, memoryMb: budget?.memory_mb },
      emit,
    });
  } else {
    // Candidate B (brain dispatch SW94JRKNFD36Q7G9, 2026-05-19): open
    // Runtime via runtime_runner registry. MCP returns an error result
    // when the runtime is unknown so the brain caller can recover.
    const runner = lookupRunnerInRegistry(ctx.db, row.runtime);
    if (!runner) {
      return { ok: false, error: `unknown_runtime:${row.runtime}` };
    }
    const obs = await runArtifactForRuntime({
      artifactId: row.id,
      body: row.body,
      declaredSandbox: decl,
      inputs,
      budget: { wallMs: budget?.wall_ms, memoryMb: budget?.memory_mb },
      emit,
      db: ctx.db,
    });
    observation = {
      ok: obs.ok,
      result: obs.result,
      error: obs.error,
      durationMs: obs.durationMs,
      exitCode: obs.exitCode,
      stderrTail: obs.stderrTail,
      sandboxWarnings: obs.sandboxWarnings,
      irreversibleEffects: obs.irreversibleEffects,
    };
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
  // Path A (2026-05-20, contract A0DQT211JH): pass through null/undefined
  // for runtime + declared_sandbox + fixture_input + state_root. Data-
  // class admission relies on these being null; do not coerce to
  // defaults.
  const runtime = (args.runtime ?? null) as Runtime | null;
  const decl = (args.declared_sandbox ?? null) as SandboxDecl | null;
  const result = await admitArtifact(
    ctx.db,
    {
      runtime,
      body: args.body,
      declaredSandbox: decl,
      fixtureInput: (args.fixture_input ?? null) as JsonValue | null,
      fixtureExpectedResidualBelow: args.fixture_expected_residual_below ?? 0.2,
      stateRoot: args.state_root ?? undefined,
      name: args.name,
      targetFiles: args.target_files,
      targetResources: args.target_resources,
      governance: (args.directive_id || args.owner_consent_event_id) ? {
        directiveId: args.directive_id,
        ownerConsentEventId: args.owner_consent_event_id,
      } : undefined,
      // Dark-gate plumbing (2026-05-18). Pre-2026-05-18 the MCP schema
      // dropped these fields so admission ran with the predicate +
      // strategy-first + render-pipeline gates blind. The brain emits
      // them on act_artifact_candidate; the wire now carries them
      // through to admitArtifact unchanged.
      audience: args.audience,
      citedKnowledgeIds: args.cited_knowledge_ids,
      sourceCandidateId: args.source_candidate_id,
      intent: args.intent,
      summary: args.summary,
      kind: args.kind,
      supersedes: args.supersedes,
      renderedDocxId: args.rendered_docx_id,
      markdownBodyId: args.markdown_body_id,
      referenceDocxArtifactId: args.reference_docx_artifact_id,
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

  // RLM-first ingress: the directive flows straight to dispatch with one
  // universal prompt. No regex pre-classification — the LM reads the
  // directive and understands intent natively. Emission validation rests
  // on structural validity + verifier residual, not intent-based
  // pre-refusal (no-regex-for-language-understanding law).

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
