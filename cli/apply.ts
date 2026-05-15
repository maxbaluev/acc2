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

// Owner-consent territory: amendments touching these targets MUST have an
// explicit owner_decision_recorded { decision: "approved" } in the same
// trajectory OR an --owner-approved flag on the apply call. CLAUDE.md
// §"Closure + learning" + v2-design.md §6.2 (irreversible-effect gate).
const OWNER_GATED_TARGETS = [
  /\bCLAUDE\.md$/,
  /\.claude\/rules\//,
  /docs\/v2-design\.md$/,
  /docs\/operator-install\.md$/,
  /docs\/ops-guide\.md$/,
];

const isOwnerGated = (target: string): boolean =>
  OWNER_GATED_TARGETS.some((re) => re.test(target));

const targetFromPayload = (payload: Record<string, unknown>): string => {
  const direct = payload.target;
  if (typeof direct === "string") return direct;
  const proposed = payload.proposed_behavior;
  if (proposed && typeof proposed === "object") {
    const path = (proposed as Record<string, unknown>).file_path;
    if (typeof path === "string") return path;
  }
  return "";
};

const boolish = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true";

const fetchQueueRow = async (eventId: string): Promise<LessonQueueRow | null> => {
  const env = await mcpCall("substrate.read", { view_name: "lesson_implementer_queue_view" });
  if (!env.ok || !Array.isArray(env.result)) return null;
  return (env.result as LessonQueueRow[]).find((r) => r.source_event_id === eventId) ?? null;
};

const structuredProposedBehavior = (payload: Record<string, unknown>, target: string): boolean => {
  const proposed = payload.proposed_behavior;
  if (!proposed || typeof proposed !== "object") return false;
  const p = proposed as Record<string, unknown>;
  return typeof p.file_path === "string"
    && p.file_path === target
    && typeof p.anchor === "string"
    && p.anchor.trim().length > 0
    && typeof p.diff === "string"
    && p.diff.trim().length > 0;
};

const isRuntimeAutoApplyTarget = (target: string): boolean =>
  target.startsWith("cli/") || target.startsWith("runtime/");

const emitApplyDenied = async (
  ev: EventRow,
  eventId: string,
  reason: string,
  target: string,
): Promise<number> => {
  const env = await mcpCall("substrate.emit", {
    kind: "lesson_apply_requested",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId],
    payload: {
      source_event_id: eventId,
      source_kind: ev.kind,
      target,
      authorization_status: "denied",
      reason,
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
  const queueRow = await fetchQueueRow(eventId);
  const kind = ev.kind ?? "";
  if (kind !== "lesson_extracted" && kind !== "contract_amendment_proposed") {
    console.error(`acc apply: event ${eventId} is ${kind}, not lesson_extracted or contract_amendment_proposed`);
    return { ok: false, code: 1 };
  }
  const ownerGateRequired = kind === "contract_amendment_proposed"
    && (isOwnerGated(target) || boolish(queueRow?.owner_gate_required));
  const ownerApproved = Boolean(opts.ownerApproved) || boolish(queueRow?.owner_approved);
  if (ownerGateRequired && !ownerApproved) {
    return { ok: false, code: await emitApplyDenied(ev, eventId, "owner_consent_missing", target) };
  }
  if (kind === "contract_amendment_proposed" && isRuntimeAutoApplyTarget(target)) {
    const hazards = Number(queueRow?.trajectory_hazard_count ?? 0);
    if (hazards > 0) {
      return { ok: false, code: await emitApplyDenied(ev, eventId, "trajectory_hazard_present", target) };
    }
    if (!structuredProposedBehavior(payload, target)) {
      return { ok: false, code: await emitApplyDenied(ev, eventId, "structured_proposed_behavior_required", target) };
    }
  }
  return { ok: true, target, ownerGateRequired, ownerApproved, queueRow };
};

/** Construct the Agent subagent prompt for a lesson_extracted /
 *  contract_amendment_proposed event. The subagent reads evidence via MCP,
 *  makes the edit, runs the verifier (`bun test --bail`), commits to git,
 *  and returns a strict JSON summary the orchestrator pipes into
 *  `acc apply --record`. */
const renderSubagentPrompt = (ev: EventRow, opts: { ownerApproved?: boolean }): string => {
  const payload = parsePayload(ev.payload);
  const kind = ev.kind ?? "?";
  const evId = ev.event_id ?? ev.id ?? "?";
  const evidenceIds = (payload.evidence_event_ids as string[] | undefined) ?? [];
  const isAmendment = kind === "contract_amendment_proposed";

  const resolvedTarget = targetFromPayload(payload);
  const target = resolvedTarget || "(unspecified — subagent must infer from summary)";
  const anchor = (payload.anchor as string | undefined) ?? "";
  const proposed = (payload.proposed_behavior as string | undefined) ?? (payload.proposed_action as string | undefined) ?? "";
  const current = (payload.current_behavior as string | undefined) ?? "";
  const summary = (payload.summary as string | undefined) ?? "";
  const lessonKind = (payload.lesson_kind as string | undefined) ?? "";

  const ownerGated = target ? isOwnerGated(target) : false;
  const ownerGateLine = ownerGated && !opts.ownerApproved
    ? `OWNER GATE — REFUSE: this target is in owner-consent territory and --owner-approved was not set on the apply call. STOP, emit a clarifying lesson_extracted, and return {"status":"refused","reason":"owner_consent_missing"}.`
    : ownerGated
      ? `OWNER GATE — APPROVED: --owner-approved was set on the apply call. Proceed but emit irreversible_effect_recorded BEFORE the write.`
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
    `EVIDENCE EVENT IDS (resolve via substrate.get_event before editing — they`,
    `cite the trajectory rows that led to this proposal):`,
    evidenceIds.length > 0
      ? evidenceIds.map((id) => `  - ${id}`).join("\n")
      : `  (none — proposal stands on its summary alone)`,
    ``,
    ownerGateLine,
    ``,
    `OPERATING CONTRACT`,
    `  1. Use the substrate, not file scanning, as your primary information surface.`,
    `     Read evidence rows via:  bun cli/dispatch.ts events --limit 200 --verbose | grep <id>`,
    `     Read task graph via:     bun cli/dispatch.ts graph <directive_id>`,
    `     Read task chronology:    bun cli/dispatch.ts inspect <task_id>`,
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
  const requestEnv = await mcpCall("substrate.emit", {
    kind: "lesson_apply_requested",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId, ownerDecisionEventId].filter(Boolean),
    payload: {
      source_event_id: eventId,
      source_kind: ev.kind,
      owner_approved: ownerApproved,
      owner_decision_event_id: ownerDecisionEventId,
      owner_gate_required: auth.ownerGateRequired,
      authorization_status: "approved",
      target: auth.target || payload.target,
      design_citations: ["v2-design.md §3", "v2-design.md §6", "v2-design.md §7", "v2-design.md §11.5", "v2-design.md §15"],
    },
  });
  if (!requestEnv.ok) {
    console.error(`acc apply: lesson_apply_requested emit failed - ${requestEnv.error}`);
    return 1;
  }
  const prompt = renderSubagentPrompt(ev, { ownerApproved });
  console.log(prompt);
  return 0;
};

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
  const ev = await fetchEvent(eventId);
  if (!ev) {
    console.error(`acc apply --record: source event ${eventId} not found`);
    return 1;
  }
  const isAmendment = ev.kind === "contract_amendment_proposed";
  const appliedKind = isAmendment ? "contract_amendment_applied" : "lesson_applied";
  const status = opts.status || "applied";
  const residual = typeof opts.residual === "number" && Number.isFinite(opts.residual)
    ? Math.min(1, Math.max(0, opts.residual))
    : status === "applied" ? 0 : 1;
  const actionArtifactId = opts.actionArtifactId || DEFAULT_APPLY_ACTION_ARTIFACT_ID;
  const verifierArtifactId = opts.verifierArtifactId || DEFAULT_APPLY_VERIFIER_ARTIFACT_ID;
  const auth = await authorizeApply(ev, eventId, { ownerApproved: opts.ownerApproved, target: opts.target });
  if (!auth.ok) return auth.code;
  let ownerDecisionEventId: string | undefined;
  try {
    ownerDecisionEventId = await emitOwnerDecisionIfNeeded(ev, eventId, auth, opts.ownerApproved);
  } catch (err) {
    console.error(`acc apply --record: ${(err as Error).message}`);
    return 1;
  }
  const target = auth.target || opts.target;

  const requestEnv = await mcpCall("substrate.emit", {
    kind: "lesson_apply_requested",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId, ownerDecisionEventId].filter(Boolean),
    payload: {
      source_event_id: eventId,
      source_kind: ev.kind,
      status,
      target,
      owner_gate_checked: true,
      owner_gate_required: auth.ownerGateRequired,
      owner_approved: auth.ownerApproved,
      owner_decision_event_id: ownerDecisionEventId,
      authorization_status: "approved",
      design_citations: ["v2-design.md §3", "v2-design.md §6", "v2-design.md §7", "v2-design.md §11.5", "v2-design.md §15"],
    },
  });
  if (!requestEnv.ok) {
    console.error(`acc apply --record: lesson_apply_requested emit failed - ${requestEnv.error}`);
    return 1;
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
      source_kind: ev.kind,
      target,
      design_citations: ["v2-design.md §3", "v2-design.md §6", "v2-design.md §7", "v2-design.md §11.5", "v2-design.md §15"],
    },
  });
  if (!actionEnv.ok) {
    console.error(`acc apply --record: action_predicted emit failed - ${actionEnv.error}`);
    return 1;
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
      source_kind: ev.kind,
      commit_sha: opts.commitSha,
      target,
      summary: opts.summary,
      reason: opts.reason,
    },
  });
  if (!scoredEnv.ok) {
    console.error(`acc apply --record: action_scored emit failed - ${scoredEnv.error}`);
    return 1;
  }
  const scoredEventId = (scoredEnv.result as { id?: string })?.id;

  if (status !== "applied" || residual >= 0.3) {
    console.log(`action_scored ${scoredEventId ?? "?"} residual=${residual}`);
    console.log(`applied_change_committed skipped (status=${status} residual=${residual})`);
    return status === "applied" ? 1 : 0;
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
        action_event_id: actionEventId,
        scored_event_id: scoredEventId,
      },
    });
    if (!committedEnv.ok) {
      console.error(`acc apply --record: applied_change_committed emit failed - ${committedEnv.error}`);
      return 1;
    }
    committedEventId = (committedEnv.result as { id?: string })?.id;
  }

  const payload: Record<string, unknown> = {
    source_event_id: eventId,
    source_kind: ev.kind,
    status,
    applied_at: new Date().toISOString(),
    request_event_id: requestEventId,
    action_event_id: actionEventId,
    scored_event_id: scoredEventId,
    residual,
  };
  if (committedEventId) payload.applied_change_event_id = committedEventId;
  if (opts.commitSha) payload.commit_sha = opts.commitSha;
  if (opts.subagentTaskId) payload.subagent_task_id = opts.subagentTaskId;
  if (opts.summary) payload.summary = opts.summary;
  if (opts.reason) payload.reason = opts.reason;
  if (target) payload.target = target;
  const env = await mcpCall("substrate.emit", {
    kind: appliedKind,
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId, committedEventId].filter(Boolean),
    payload,
  });
  if (!env.ok) {
    console.error(`acc apply --record: emit failed — ${env.error}`);
    return 1;
  }
  const result = env.result as { id?: string };
  if (committedEventId) console.log(`applied_change_committed ${committedEventId} residual=${residual}`);
  else console.log(`applied_change_committed skipped residual=${residual} status=${status}`);
  console.log(`${appliedKind} ${result.id ?? "?"} (source=${eventId.slice(0, 12)} status=${status})`);
  return 0;
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
