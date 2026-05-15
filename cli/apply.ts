#!/usr/bin/env bun
// `acc apply <event_id>` — render a Claude Agent subagent prompt for
// applying a lesson_extracted or contract_amendment_proposed event, AND
// record the act-shaped applied_change_committed spine plus the
// lesson_applied / contract_amendment_applied credit event when the
// subagent finishes. Option D + Claude subagent executor (CLAUDE.md
// §"Applying lessons via Claude Agent subagents").
//
// Two modes:
//   acc apply <event_id>
//       Reads the source event via mcpCall, renders the structured prompt
//       template, prints it to stdout. The orchestrator (main Claude) feeds
//       this prompt into the Agent tool with run_in_background:true so the
//       subagent does the actual Edit/test/git work in an isolated context.
//
//   acc apply --record <event_id> --status (applied|failed) [--commit-sha X]
//             [--subagent-task-id Y] [--summary "..."] [--reason "..."]
//       Emits action_predicted -> action_scored, then applied_change_committed
//       only when the verifier residual passes, followed by the corresponding
//       *_applied event so the originating lesson/amendment is credited
//       (closes the four-link chain:
//       create -> retrieve -> mutate -> credit, k_555).

import { mcpCall } from "./rpc";
import { lessonApplyTargetsPolicy } from "../substrate/lesson_apply_policy";

type Args = Record<string, string | boolean>;

const parseArgs = (argv: string[]): { positional: string[]; flags: Args } => {
  const positional: string[] = [];
  const flags: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq >= 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else {
        flags[a.slice(2)] = true;
      }
    }
  }
  return { positional, flags };
};

type EventRow = {
  event_id?: string;
  id?: string;
  ts?: string;
  kind?: string;
  task_id?: string;
  directive_id?: string;
  payload?: unknown;
};

type LessonQueueRow = {
  source_event_id?: string;
  source_kind?: string;
  target?: string | null;
  owner_gate_required?: boolean | number;
  owner_approved?: boolean | number;
  trajectory_hazard_count?: number;
  auto_apply_eligible?: boolean | number;
};

type ApplyAuthorization = {
  ok: true;
  target: string;
  ownerGateRequired: boolean;
  ownerApproved: boolean;
  queueRow: LessonQueueRow | null;
};

const DEFAULT_APPLY_ACTION_ARTIFACT_ID = "claude_agent_apply_change_action";
const DEFAULT_APPLY_VERIFIER_ARTIFACT_ID = "claude_agent_apply_change_verifier";
const DEFAULT_APPLY_GATE_ACTION_ARTIFACT_ID = "lesson_apply_gate_action";
const DEFAULT_APPLY_GATE_VERIFIER_ARTIFACT_ID = "lesson_apply_gate_verifier";

const fetchEvent = async (eventId: string): Promise<EventRow | null> => {
  const env = await mcpCall("substrate.get_event", { id: eventId });
  if (!env.ok) return null;
  return (env.result as EventRow) ?? null;
};

const parsePayload = (p: unknown): Record<string, unknown> => {
  if (!p) return {};
  if (typeof p === "string") {
    try { return JSON.parse(p) as Record<string, unknown>; } catch { return {}; }
  }
  if (typeof p === "object") return p as Record<string, unknown>;
  return {};
};

const targetFromPayload = (payload: Record<string, unknown>): string => {
  const direct = payload.target;
  if (typeof direct === "string") return direct;
  const proposed = payload.proposed_behavior ?? payload.proposed_action;
  if (proposed && typeof proposed === "object") {
    const path = (proposed as Record<string, unknown>).file_path;
    if (typeof path === "string") return path;
  }
  return "";
};

const targetCandidatesFromPayload = (payload: Record<string, unknown>): string[] => {
  const targets = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) targets.add(value.trim());
  };
  add(payload.target);
  for (const key of ["proposed_behavior", "proposed_action"] as const) {
    const proposed = payload[key];
    if (proposed && typeof proposed === "object") add((proposed as Record<string, unknown>).file_path);
  }
  return [...targets];
};

const boolish = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true";

const fetchQueueRow = async (eventId: string): Promise<LessonQueueRow | null> => {
  const env = await mcpCall("substrate.read", { view_name: "lesson_implementer_queue_view" });
  if (!env.ok || !Array.isArray(env.result)) return null;
  return (env.result as LessonQueueRow[]).find((r) => r.source_event_id === eventId) ?? null;
};

const structuredChangeProposal = (payload: Record<string, unknown>, target: string): boolean => {
  const proposed = payload.proposed_behavior ?? payload.proposed_action;
  if (!proposed || typeof proposed !== "object") return false;
  const p = proposed as Record<string, unknown>;
  return typeof p.file_path === "string"
    && p.file_path === target
    && typeof p.anchor === "string"
    && p.anchor.trim().length > 0
    && typeof p.diff === "string"
    && p.diff.trim().length > 0;
};

const proposalText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
};

const proposedChangeFields = (
  payload: Record<string, unknown>,
): { sourceField: "proposed_behavior" | "proposed_action"; proposal: Record<string, unknown> } | null => {
  for (const sourceField of ["proposed_behavior", "proposed_action"] as const) {
    const proposal = payload[sourceField];
    if (proposal && typeof proposal === "object" && !Array.isArray(proposal)) {
      return { sourceField, proposal: proposal as Record<string, unknown> };
    }
  }
  return null;
};

const formatPromptValue = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "(missing)";
  return typeof value === "string" ? value : JSON.stringify(value);
};

const renderStructuredProposalBlock = (payload: Record<string, unknown>): string => {
  const structured = proposedChangeFields(payload);
  if (!structured) {
    const fallback = proposalText(payload.proposed_behavior) || proposalText(payload.proposed_action);
    return [
      `STRUCTURED PROPOSED CHANGE`,
      `  status: unstructured`,
      fallback ? `  proposal_text: ${JSON.stringify(fallback)}` : `  proposal_text: (missing)`,
    ].join("\n");
  }

  const { sourceField, proposal } = structured;
  return [
    `STRUCTURED PROPOSED CHANGE`,
    `  source_field: ${sourceField}`,
    `  file_path:    ${formatPromptValue(proposal.file_path)}`,
    `  anchor:       ${formatPromptValue(proposal.anchor)}`,
    `  diff:`,
    `\`\`\`diff`,
    typeof proposal.diff === "string" ? proposal.diff : JSON.stringify(proposal.diff ?? ""),
    `\`\`\``,
  ].join("\n");
};

const renderGateBlock = (
  payload: Record<string, unknown>,
  auth: ApplyAuthorization,
  policy: ReturnType<typeof lessonApplyTargetsPolicy>,
): string => {
  const hazardCount = Number(auth.queueRow?.trajectory_hazard_count ?? 0);
  const structured = structuredChangeProposal(payload, auth.target);
  return [
    `APPLY GATES`,
    `  owner_gate.required: ${auth.ownerGateRequired}`,
    `  owner_gate.approved: ${auth.ownerApproved}`,
    `  owner_gate.rule: CLAUDE.md, docs/v2-design.md, docs/operator-install.md, docs/ops-guide.md, and .claude/rules/* require explicit owner consent before apply.`,
    `  cli_runtime_gate.target_in_scope: ${policy.autoApplyTarget}`,
    `  cli_runtime_gate.rule: cli/* and runtime/* may auto-apply only with structured {file_path, anchor, diff}, verifier residual < 0.3, and no dispatcher_violation or irreversible_effect_recorded in the trajectory.`,
    `  cli_runtime_gate.structured_change: ${structured || !policy.autoApplyTarget}`,
    `  cli_runtime_gate.trajectory_hazard_count: ${hazardCount}`,
  ].join("\n");
};

const emitApplyGateEvaluation = async (
  ev: EventRow,
  eventId: string,
  args: {
    target: string;
    status: "approved" | "denied";
    reason?: string;
    ownerGateRequired: boolean;
    ownerApproved: boolean;
    autoApplyTarget: boolean;
  },
): Promise<{ actionEventId?: string; scoredEventId?: string; residual: number }> => {
  const residual = args.status === "approved" ? 0 : 1;
  const actionEnv = await mcpCall("substrate.emit", {
    kind: "action_predicted",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId],
    action_artifact_id: DEFAULT_APPLY_GATE_ACTION_ARTIFACT_ID,
    verifier_artifact_id: DEFAULT_APPLY_GATE_VERIFIER_ARTIFACT_ID,
    predicted_residual: args.status === "approved" ? 0.05 : 0.95,
    payload: {
      intent: "Evaluate owner/auto gate for applying a substrate-emitted lesson or contract amendment.",
      source_event_id: eventId,
      source_kind: ev.kind,
      target: args.target,
      authorization_status: args.status,
      reason: args.reason,
      owner_gate_required: args.ownerGateRequired,
      owner_approved: args.ownerApproved,
      auto_apply_target: args.autoApplyTarget,
      design_citations: ["v2-design.md §3", "v2-design.md §6", "v2-design.md §7", "v2-design.md §11.5", "v2-design.md §15"],
    },
  });
  if (!actionEnv.ok) throw new Error(`gate action_predicted emit failed - ${actionEnv.error}`);
  const actionEventId = (actionEnv.result as { id?: string })?.id;

  const scoredEnv = await mcpCall("substrate.emit", {
    kind: "action_scored",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId, actionEventId].filter(Boolean),
    action_artifact_id: DEFAULT_APPLY_GATE_ACTION_ARTIFACT_ID,
    verifier_artifact_id: DEFAULT_APPLY_GATE_VERIFIER_ARTIFACT_ID,
    outcome: args.status,
    residual,
    payload: {
      source_event_id: eventId,
      source_kind: ev.kind,
      action_event_id: actionEventId,
      target: args.target,
      authorization_status: args.status,
      reason: args.reason,
      owner_gate_required: args.ownerGateRequired,
      owner_approved: args.ownerApproved,
      auto_apply_target: args.autoApplyTarget,
    },
  });
  if (!scoredEnv.ok) throw new Error(`gate action_scored emit failed - ${scoredEnv.error}`);
  return { actionEventId, scoredEventId: (scoredEnv.result as { id?: string })?.id, residual };
};

const emitApplyDenied = async (
  ev: EventRow,
  eventId: string,
  reason: string,
  target: string,
  gate: { ownerGateRequired: boolean; ownerApproved: boolean; autoApplyTarget: boolean },
): Promise<number> => {
  let gateActionEventId: string | undefined;
  let gateScoredEventId: string | undefined;
  try {
    const gateEval = await emitApplyGateEvaluation(ev, eventId, {
      target,
      status: "denied",
      reason,
      ...gate,
    });
    gateActionEventId = gateEval.actionEventId;
    gateScoredEventId = gateEval.scoredEventId;
  } catch (err) {
    console.error(`acc apply: ${(err as Error).message}`);
    return 1;
  }
  const env = await mcpCall("substrate.emit", {
    kind: "lesson_apply_requested",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId, gateActionEventId, gateScoredEventId].filter(Boolean),
    payload: {
      source_event_id: eventId,
      source_kind: ev.kind,
      target,
      authorization_status: "denied",
      reason,
      gate_action_event_id: gateActionEventId,
      gate_scored_event_id: gateScoredEventId,
      gate_residual: 1,
      owner_gate_required: gate.ownerGateRequired,
      owner_approved: gate.ownerApproved,
      auto_apply_target: gate.autoApplyTarget,
      design_citations: ["v2-design.md §3", "v2-design.md §6", "v2-design.md §7", "v2-design.md §11.5", "v2-design.md §15"],
    },
  });
  if (!env.ok) {
    console.error(`acc apply: authorization denial emit failed - ${env.error}`);
    return 1;
  }
  console.error(`acc apply: authorization denied - ${reason}`);
  return 1;
};

const emitOwnerDecisionIfNeeded = async (
  ev: EventRow,
  eventId: string,
  auth: ApplyAuthorization,
  ownerApprovedFlag: boolean | undefined,
): Promise<string | undefined> => {
  if (!auth.ownerGateRequired || !ownerApprovedFlag || boolish(auth.queueRow?.owner_approved)) return undefined;
  const env = await mcpCall("substrate.emit", {
    kind: "owner_decision_recorded",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId],
    payload: {
      source_event_id: eventId,
      decision: "approved",
      decision_kind: "lesson_apply_owner_gate",
      target: auth.target,
    },
  });
  if (!env.ok) throw new Error(`owner_decision_recorded emit failed - ${env.error}`);
  return (env.result as { id?: string })?.id;
};

const authorizeApply = async (
  ev: EventRow,
  eventId: string,
  opts: { ownerApproved?: boolean; target?: string },
): Promise<ApplyAuthorization | { ok: false; code: number }> => {
  const payload = parsePayload(ev.payload);
  const target = opts.target || targetFromPayload(payload);
  const targets = [...new Set(
    [...targetCandidatesFromPayload(payload), opts.target]
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0),
  )];
  const queueRow = await fetchQueueRow(eventId);
  const kind = ev.kind ?? "";
  if (kind !== "lesson_extracted" && kind !== "contract_amendment_proposed") {
    console.error(`acc apply: event ${eventId} is ${kind}, not lesson_extracted or contract_amendment_proposed`);
    return { ok: false, code: 1 };
  }
  const policy = lessonApplyTargetsPolicy(targets);
  const ownerGateRequired = policy.ownerGateRequired || boolish(queueRow?.owner_gate_required);
  const ownerApproved = Boolean(opts.ownerApproved) || boolish(queueRow?.owner_approved);
  if (ownerGateRequired && !ownerApproved) {
    return { ok: false, code: await emitApplyDenied(ev, eventId, "owner_consent_missing", target, {
      ownerGateRequired,
      ownerApproved,
      autoApplyTarget: policy.autoApplyTarget,
    }) };
  }
  if (policy.autoApplyTarget) {
    const hazards = Number(queueRow?.trajectory_hazard_count ?? 0);
    if (hazards > 0) {
      return { ok: false, code: await emitApplyDenied(ev, eventId, "trajectory_hazard_present", target, {
        ownerGateRequired,
        ownerApproved,
        autoApplyTarget: policy.autoApplyTarget,
      }) };
    }
    if (!structuredChangeProposal(payload, target)) {
      return { ok: false, code: await emitApplyDenied(ev, eventId, "structured_proposed_behavior_required", target, {
        ownerGateRequired,
        ownerApproved,
        autoApplyTarget: policy.autoApplyTarget,
      }) };
    }
  }
  return { ok: true, target, ownerGateRequired, ownerApproved, queueRow };
};

/** Construct the Agent subagent prompt for a lesson_extracted /
 *  contract_amendment_proposed event. The subagent reads evidence via MCP,
 *  makes the edit, runs the verifier (`bun test --bail`), commits to git,
 *  and returns a strict JSON summary the orchestrator pipes into
 *  `acc apply --record`. */
const renderSubagentPrompt = (ev: EventRow, opts: { ownerApproved?: boolean; auth: ApplyAuthorization }): string => {
  const payload = parsePayload(ev.payload);
  const kind = ev.kind ?? "?";
  const evId = ev.event_id ?? ev.id ?? "?";
  const evidenceIds = (payload.evidence_event_ids as string[] | undefined) ?? [];
  const isAmendment = kind === "contract_amendment_proposed";

  const resolvedTarget = targetFromPayload(payload);
  const target = resolvedTarget || "(unspecified — subagent must infer from summary)";
  const anchor = (payload.anchor as string | undefined) ?? "";
  const proposed = proposalText(payload.proposed_behavior) || proposalText(payload.proposed_action);
  const current = (payload.current_behavior as string | undefined) ?? "";
  const summary = (payload.summary as string | undefined) ?? "";
  const lessonKind = (payload.lesson_kind as string | undefined) ?? "";

  const policy = lessonApplyTargetsPolicy(targetCandidatesFromPayload(payload));
  const ownerGateLine = policy.ownerGateRequired && !opts.ownerApproved
    ? `OWNER GATE — REFUSE: this target is in owner-consent territory and --owner-approved was not set on the apply call. STOP, emit a clarifying lesson_extracted, and return {"status":"refused","reason":"owner_consent_missing"}.`
    : policy.ownerGateRequired
      ? `OWNER GATE — APPROVED: owner consent is recorded for this source event.`
    : policy.autoApplyTarget
        ? `AUTO-APPLY GATE — CLI/RUNTIME: proceed only because acc apply verified a structured proposed change {file_path, anchor, diff}, verifier residual must be < 0.3, and this trajectory has no dispatcher_violation or irreversible_effect_recorded rows.`
      : `(target outside owner-consent territory — apply directly)`;

  return [
    `You are a Claude Code Agent subagent running in run_in_background mode.`,
    `Your job: APPLY one substrate-emitted improvement to the AccInt v2 codebase,`,
    `then commit the change to git, and return a JSON summary.`,
    ``,
    `SOURCE EVENT`,
    `  event_id:  ${evId}`,
    `  kind:      ${kind}`,
    `  ts:        ${ev.ts ?? "?"}`,
    `  task_id:   ${ev.task_id ?? "?"}`,
    `  directive: ${ev.directive_id ?? "?"}`,
    ``,
    `EVENT PAYLOAD (verbatim, the brain's proposal):`,
    isAmendment
      ? [
          `  target:             ${target}`,
          anchor ? `  anchor:             ${anchor}` : ``,
          current ? `  current_behavior:   ${JSON.stringify(current)}` : ``,
          proposed ? `  proposed_behavior:  ${JSON.stringify(proposed)}` : ``,
        ].filter(Boolean).join("\n")
      : [
          lessonKind ? `  lesson_kind:     ${lessonKind}` : ``,
          summary ? `  summary:         ${JSON.stringify(summary)}` : ``,
          proposed ? `  proposed_action: ${JSON.stringify(proposed)}` : ``,
        ].filter(Boolean).join("\n"),
    ``,
    renderStructuredProposalBlock(payload),
    ``,
    renderGateBlock(payload, opts.auth, policy),
    ``,
    `EVIDENCE EVENT IDS (resolve via substrate.get_event before editing — they`,
    `cite the trajectory rows that led to this proposal):`,
    evidenceIds.length > 0
      ? evidenceIds.map((id) => `  - ${id}`).join("\n")
      : `  (none — proposal stands on its summary alone)`,
    ``,
    ownerGateLine,
    ``,
    `OPERATING CONTRACT`,
    `  1. Use EXACT substrate handles, not file/log scanning, as your primary information surface.`,
    `     Resolve the SOURCE EVENT and each EVIDENCE EVENT id directly via MCP — do NOT grep`,
    `     over event history or dump 200-row windows to reconstruct context. The handles are`,
    `     already on the proposal; use them.`,
    `     If you need more context on a specific node:`,
    `       bun cli/dispatch.ts graph <directive_id>    (task DAG for one directive only)`,
    `       bun cli/dispatch.ts inspect <task_id>       (chronology for one task only)`,
    `  2. Make the SMALLEST possible edit that satisfies the proposal — no scope creep.`,
    `     Use Edit (not Write) for in-place changes. Preserve indentation + surrounding context.`,
    `  3. Run \`bun test --bail\` and confirm all tests pass before committing.`,
    `  4. Stage the specific edited file(s) only — never \`git add -A\` or \`git add .\`.`,
    `  5. Commit with message:`,
    `        <lesson_kind-or-amendment>: <one-line summary>`,
    ``,
    `        Applies: ${evId}`,
    `        Evidence: ${evidenceIds.length > 0 ? evidenceIds.join(", ") : "(see source event)"}`,
    `        Co-Authored-By: Claude Agent (acc2 applier) <noreply@accint>`,
    `  6. Return ONE JSON object on stdout — nothing else. Schema:`,
    `        {`,
    `          "status":         "applied" | "failed" | "refused",`,
    `          "target":         "<repo-relative file path>",`,
    `          "commit_sha":     "<10-char sha>"  // when status=applied`,
    `          "summary":        "<one-sentence summary of the change>",`,
    `          "residual":       0,  // verifier residual in [0,1], if known`,
    `          "action_artifact_id":   "<optional substrate code artifact id>",`,
    `          "verifier_artifact_id": "<optional substrate verifier artifact id>",`,
    `          "reason":         "<failure reason>"  // when status=failed or refused`,
    `        }`,
    ``,
    `FORBIDDEN`,
    `  - DO NOT skip the test gate. \`--no-verify\` is forbidden. Hook failures get`,
    `    investigated, not bypassed.`,
    `  - DO NOT touch files outside the proposed target's scope.`,
    `  - DO NOT amend a previous commit. New commit only.`,
    `  - DO NOT push to remote. Local commit only.`,
    ``,
    `When done, return the JSON summary on stdout. The orchestrator will pipe it`,
    `into \`acc apply --record ${evId} --status <status> --commit-sha <sha> --summary <text> --residual <n>\``,
    `to emit action_predicted -> action_scored -> applied_change_committed plus the`,
    `corresponding ${isAmendment ? "contract_amendment_applied" : "lesson_applied"} event and close the four-link credit chain.`,
  ].join("\n");
};

const renderPromptCommand = async (eventId: string, ownerApproved: boolean): Promise<number> => {
  const ev = await fetchEvent(eventId);
  if (!ev) {
    console.error(`acc apply: event ${eventId} not found in substrate`);
    return 1;
  }
  if (ev.kind !== "lesson_extracted" && ev.kind !== "contract_amendment_proposed") {
    console.error(`acc apply: event ${eventId} is ${ev.kind}, not lesson_extracted or contract_amendment_proposed`);
    return 1;
  }
  const payload = parsePayload(ev.payload);
  const auth = await authorizeApply(ev, eventId, { ownerApproved, target: targetFromPayload(payload) });
  if (!auth.ok) return auth.code;
  let ownerDecisionEventId: string | undefined;
  try {
    ownerDecisionEventId = await emitOwnerDecisionIfNeeded(ev, eventId, auth, ownerApproved);
  } catch (err) {
    console.error(`acc apply: ${(err as Error).message}`);
    return 1;
  }
  let gateActionEventId: string | undefined;
  let gateScoredEventId: string | undefined;
  try {
    const gatePolicy = lessonApplyTargetsPolicy(targetCandidatesFromPayload(payload));
    const gateEval = await emitApplyGateEvaluation(ev, eventId, {
      target: auth.target || targetFromPayload(payload),
      status: "approved",
      ownerGateRequired: auth.ownerGateRequired,
      ownerApproved: auth.ownerApproved,
      autoApplyTarget: gatePolicy.autoApplyTarget,
    });
    gateActionEventId = gateEval.actionEventId;
    gateScoredEventId = gateEval.scoredEventId;
  } catch (err) {
    console.error(`acc apply: ${(err as Error).message}`);
    return 1;
  }
  const requestEnv = await mcpCall("substrate.emit", {
    kind: "lesson_apply_requested",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId, ownerDecisionEventId, gateActionEventId, gateScoredEventId].filter(Boolean),
    payload: {
      source_event_id: eventId,
      source_kind: ev.kind,
      owner_approved: auth.ownerApproved,
      owner_decision_event_id: ownerDecisionEventId,
      owner_gate_required: auth.ownerGateRequired,
      gate_action_event_id: gateActionEventId,
      gate_scored_event_id: gateScoredEventId,
      gate_residual: 0,
      authorization_status: "approved",
      target: auth.target || payload.target,
      design_citations: ["v2-design.md §3", "v2-design.md §6", "v2-design.md §7", "v2-design.md §11.5", "v2-design.md §15"],
    },
  });
  if (!requestEnv.ok) {
    console.error(`acc apply: lesson_apply_requested emit failed - ${requestEnv.error}`);
    return 1;
  }
  const prompt = renderSubagentPrompt(ev, { ownerApproved: auth.ownerApproved, auth });
  console.log(prompt);
  return 0;
};

/** Outcome of recording an apply through the substrate credit chain. */
export type ApplyOutcomeResult =
  | { ok: false; reason: string; exitCode: number }
  | {
      ok: true;
      appliedKind: "contract_amendment_applied" | "lesson_applied";
      appliedEventId: string;
      committedEventId?: string;
      residual: number;
      status: string;
      verifierPassed: boolean;
    };

/** Emit the full apply credit chain for one substrate-emitted lesson or
 *  contract amendment. Used by both the CLI (`acc apply --record`) and the
 *  daemon-side auto-apply worker (`runtime/auto_apply_worker.ts`) — one
 *  implementation guarantees both callers update posteriors and lineage
 *  identically. The four-link chain (k_555) is:
 *
 *      lesson_apply_requested → action_predicted → action_scored
 *      → applied_change_committed → contract_amendment_applied / lesson_applied
 *
 *  Returns a structured result; callers handle stdout / exit codes. */
export const recordApplyOutcome = async (opts: {
  eventId: string;
  status: string;
  commitSha?: string;
  subagentTaskId?: string;
  summary?: string;
  reason?: string;
  target?: string;
  residual?: number;
  actionArtifactId?: string;
  verifierArtifactId?: string;
  ownerApproved?: boolean;
}): Promise<ApplyOutcomeResult> => {
  const ev = await fetchEvent(opts.eventId);
  if (!ev) {
    return { ok: false, reason: `source event ${opts.eventId} not found`, exitCode: 1 };
  }
  const isAmendment = ev.kind === "contract_amendment_proposed";
  const appliedKind = (isAmendment ? "contract_amendment_applied" : "lesson_applied") as
    | "contract_amendment_applied"
    | "lesson_applied";
  const status = opts.status || "applied";
  const residual = typeof opts.residual === "number" && Number.isFinite(opts.residual)
    ? Math.min(1, Math.max(0, opts.residual))
    : status === "applied" ? 0 : 1;
  const actionArtifactId = opts.actionArtifactId || DEFAULT_APPLY_ACTION_ARTIFACT_ID;
  const verifierArtifactId = opts.verifierArtifactId || DEFAULT_APPLY_VERIFIER_ARTIFACT_ID;
  const payload = parsePayload(ev.payload);
  const auth = await authorizeApply(ev, opts.eventId, { ownerApproved: opts.ownerApproved, target: opts.target });
  if (!auth.ok) return { ok: false, reason: "authorization denied", exitCode: auth.code };
  const eventId = opts.eventId;
  let ownerDecisionEventId: string | undefined;
  try {
    ownerDecisionEventId = await emitOwnerDecisionIfNeeded(ev, eventId, auth, opts.ownerApproved);
  } catch (err) {
    return { ok: false, reason: (err as Error).message, exitCode: 1 };
  }
  const target = auth.target || opts.target;
  let gateActionEventId: string | undefined;
  let gateScoredEventId: string | undefined;
  try {
    const gatePolicy = lessonApplyTargetsPolicy(opts.target ? [opts.target] : targetCandidatesFromPayload(payload));
    const gateEval = await emitApplyGateEvaluation(ev, eventId, {
      target: target || targetFromPayload(payload),
      status: "approved",
      ownerGateRequired: auth.ownerGateRequired,
      ownerApproved: auth.ownerApproved,
      autoApplyTarget: gatePolicy.autoApplyTarget,
    });
    gateActionEventId = gateEval.actionEventId;
    gateScoredEventId = gateEval.scoredEventId;
  } catch (err) {
    return { ok: false, reason: (err as Error).message, exitCode: 1 };
  }

  const requestEnv = await mcpCall("substrate.emit", {
    kind: "lesson_apply_requested",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId, ownerDecisionEventId, gateActionEventId, gateScoredEventId].filter(Boolean),
    payload: {
      source_event_id: eventId,
      source_kind: ev.kind,
      status,
      target,
      owner_gate_checked: true,
      owner_gate_required: auth.ownerGateRequired,
      owner_approved: auth.ownerApproved,
      owner_decision_event_id: ownerDecisionEventId,
      gate_action_event_id: gateActionEventId,
      gate_scored_event_id: gateScoredEventId,
      gate_residual: 0,
      authorization_status: "approved",
      design_citations: ["v2-design.md §3", "v2-design.md §6", "v2-design.md §7", "v2-design.md §11.5", "v2-design.md §15"],
    },
  });
  if (!requestEnv.ok) {
    return { ok: false, reason: `lesson_apply_requested emit failed - ${requestEnv.error}`, exitCode: 1 };
  }
  const requestEventId = (requestEnv.result as { id?: string })?.id;

  const actionEnv = await mcpCall("substrate.emit", {
    kind: "action_predicted",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId, requestEventId].filter(Boolean),
    action_artifact_id: actionArtifactId,
    verifier_artifact_id: verifierArtifactId,
    predicted_residual: 0.2,
    payload: {
      intent: "Apply a substrate-emitted lesson or contract amendment as a committed code change.",
      source_event_id: eventId,
      request_event_id: requestEventId,
      authorization_event_id: requestEventId,
      source_kind: ev.kind,
      target,
      owner_gate_checked: true,
      owner_gate_required: auth.ownerGateRequired,
      owner_approved: auth.ownerApproved,
      authorization_status: "approved",
      design_citations: ["v2-design.md §3", "v2-design.md §6", "v2-design.md §7", "v2-design.md §11.5", "v2-design.md §15"],
    },
  });
  if (!actionEnv.ok) {
    return { ok: false, reason: `action_predicted emit failed - ${actionEnv.error}`, exitCode: 1 };
  }
  const actionEventId = (actionEnv.result as { id?: string })?.id;

  const scoredEnv = await mcpCall("substrate.emit", {
    kind: "action_scored",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId, requestEventId, actionEventId].filter(Boolean),
    action_artifact_id: actionArtifactId,
    verifier_artifact_id: verifierArtifactId,
    outcome: status,
    residual,
    payload: {
      source_event_id: eventId,
      request_event_id: requestEventId,
      authorization_event_id: requestEventId,
      source_kind: ev.kind,
      commit_sha: opts.commitSha,
      target,
      summary: opts.summary,
      reason: opts.reason,
      owner_gate_checked: true,
      owner_gate_required: auth.ownerGateRequired,
      owner_approved: auth.ownerApproved,
      authorization_status: "approved",
    },
  });
  if (!scoredEnv.ok) {
    return { ok: false, reason: `action_scored emit failed - ${scoredEnv.error}`, exitCode: 1 };
  }
  const scoredEventId = (scoredEnv.result as { id?: string })?.id;
  // k_555 four-link spine: distribute credit so context_refs cites mutate
  // posterior state. Without this call the candidate_confirmed / artifact
  // posterior updates never happen — audit b7kjyk2k1 / WTF8EZSFAD measured
  // only 11.8% of action_scored rows actually closing the credit loop.
  // Best-effort: a credit-distribution failure (no action_predicted lineage,
  // missing artifact rows in test fixtures, etc.) must NOT abort the apply
  // chain — the four-link events have already been written and the worker
  // can re-attempt credit out-of-band. Applies brain proposal MB9YVKN25H3K.
  if (actionEventId && scoredEventId) {
    try {
      await mcpCall("substrate.credit", {
        action_event_id: actionEventId,
        observation_event_id: scoredEventId,
        scored_event_id: scoredEventId,
        predicted_residual: 0.2,
        observed_residual: residual,
      });
    } catch { /* swallow — see comment above */ }
  }

  const verifierPassed = status === "applied" && residual < 0.3;
  let committedEventId: string | undefined;
  if (verifierPassed) {
    const committedEnv = await mcpCall("substrate.emit", {
      kind: "applied_change_committed",
      substrate_origin: "claude_root",
      directive_id: ev.directive_id,
      task_id: ev.task_id,
      context_refs: [eventId, requestEventId, actionEventId, scoredEventId].filter(Boolean),
      action_artifact_id: actionArtifactId,
      verifier_artifact_id: verifierArtifactId,
      residual,
      payload: {
        source_event_id: eventId,
        source_kind: ev.kind,
        status,
        commit_sha: opts.commitSha,
        subagent_task_id: opts.subagentTaskId,
        summary: opts.summary,
        reason: opts.reason,
        target,
        residual,
        request_event_id: requestEventId,
        authorization_event_id: requestEventId,
        action_event_id: actionEventId,
        scored_event_id: scoredEventId,
        owner_gate_checked: true,
        owner_gate_required: auth.ownerGateRequired,
        owner_approved: auth.ownerApproved,
        authorization_status: "approved",
      },
    });
    if (!committedEnv.ok) {
      return { ok: false, reason: `applied_change_committed emit failed - ${committedEnv.error}`, exitCode: 1 };
    }
    committedEventId = (committedEnv.result as { id?: string })?.id;
  }

  const appliedPayload: Record<string, unknown> = {
    source_event_id: eventId,
    source_kind: ev.kind,
    status,
    applied_at: new Date().toISOString(),
    request_event_id: requestEventId,
    authorization_event_id: requestEventId,
    action_event_id: actionEventId,
    scored_event_id: scoredEventId,
    residual,
    owner_gate_checked: true,
    owner_gate_required: auth.ownerGateRequired,
    owner_approved: auth.ownerApproved,
    authorization_status: "approved",
  };
  if (committedEventId) appliedPayload.applied_change_event_id = committedEventId;
  if (opts.commitSha) appliedPayload.commit_sha = opts.commitSha;
  if (opts.subagentTaskId) appliedPayload.subagent_task_id = opts.subagentTaskId;
  if (opts.summary) appliedPayload.summary = opts.summary;
  if (opts.reason) appliedPayload.reason = opts.reason;
  if (target) appliedPayload.target = target;
  const env = await mcpCall("substrate.emit", {
    kind: appliedKind,
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId, committedEventId].filter(Boolean),
    payload: appliedPayload,
  });
  if (!env.ok) {
    return { ok: false, reason: `emit failed — ${env.error}`, exitCode: 1 };
  }
  const result = env.result as { id?: string };
  return {
    ok: true,
    appliedKind,
    appliedEventId: result.id ?? "?",
    committedEventId,
    residual,
    status,
    verifierPassed,
  };
};

/** CLI wrapper for `acc apply --record`. Calls recordApplyOutcome and
 *  prints the stdout summary lines the operator expects, returning the
 *  appropriate exit code. */
const recordApply = async (
  eventId: string,
  opts: {
    status: string;
    commitSha?: string;
    subagentTaskId?: string;
    summary?: string;
    reason?: string;
    target?: string;
    residual?: number;
    actionArtifactId?: string;
    verifierArtifactId?: string;
    ownerApproved?: boolean;
  },
): Promise<number> => {
  const result = await recordApplyOutcome({ eventId, ...opts });
  if (!result.ok) {
    console.error(`acc apply --record: ${result.reason}`);
    return result.exitCode;
  }
  if (result.committedEventId) {
    console.log(`applied_change_committed ${result.committedEventId} residual=${result.residual}`);
  } else {
    console.log(`applied_change_committed skipped residual=${result.residual} status=${result.status}`);
  }
  console.log(`${result.appliedKind} ${result.appliedEventId} (source=${eventId.slice(0, 12)} status=${result.status})`);
  return result.status === "applied" && !result.verifierPassed ? 1 : 0;
};

export const runApply = async (argv: string[]): Promise<number> => {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || (positional.length === 0 && !flags.record)) {
    console.log("acc apply <event_id> [--owner-approved]");
    console.log("        Render the subagent prompt for applying the event.");
    console.log("acc apply --record <event_id> --status applied|failed|refused");
    console.log("                  [--commit-sha X] [--subagent-task-id Y]");
    console.log("                  [--summary Z] [--reason W] [--target FILE] [--residual N]");
    console.log("                  [--action-artifact-id A] [--verifier-artifact-id V]");
    console.log("        Emit action_predicted/action_scored, gated applied_change_committed, and *_applied.");
    return positional.length === 0 ? 1 : 0;
  }
  const eventId = (typeof flags.record === "string" ? flags.record : positional[0]) ?? "";
  if (!eventId) {
    console.error("acc apply: requires <event_id>");
    return 1;
  }
  if (flags.record) {
    const status = typeof flags.status === "string" ? flags.status : "applied";
    return recordApply(eventId, {
      status,
      commitSha: typeof flags["commit-sha"] === "string" ? flags["commit-sha"] : undefined,
      subagentTaskId: typeof flags["subagent-task-id"] === "string" ? flags["subagent-task-id"] : undefined,
      summary: typeof flags.summary === "string" ? flags.summary : undefined,
      reason: typeof flags.reason === "string" ? flags.reason : undefined,
      target: typeof flags.target === "string" ? flags.target : undefined,
      residual: typeof flags.residual === "string" ? Number(flags.residual) : undefined,
      actionArtifactId: typeof flags["action-artifact-id"] === "string" ? flags["action-artifact-id"] : undefined,
      verifierArtifactId: typeof flags["verifier-artifact-id"] === "string" ? flags["verifier-artifact-id"] : undefined,
      ownerApproved: Boolean(flags["owner-approved"]),
    });
  }
  return renderPromptCommand(eventId, Boolean(flags["owner-approved"]));
};

if (import.meta.main) {
  void runApply(process.argv.slice(2)).then((code) => process.exit(code));
}
