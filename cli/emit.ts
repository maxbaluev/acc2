#!/usr/bin/env bun
// `acc emit <kind> --claim "..." [--confidence 0.7] [--refs evt1,evt2] [--summary "..."]`
//
// Claude-side ingress for the canonical substrate event kinds Claude has
// authority to emit: knowledge_candidate, lesson_extracted,
// claude_reasoning_recorded, act_tuple_recorded. Wires the symmetric-
// emission contract (CSYMEMIT01) that landed at commit 9da6770 but had
// no code path until now.
//
// The substrate has the per-(substrate_origin, goal_shape) primitive
// already built (substrate/views.ts:3369 originPromotionByGoalShape) and
// promoted knowledge entries say it is "the smallest falsifiable contract
// before any dispatch-lane changes" (lesson ES34ZQEMSS5Z, 2026-05-17).
// What was missing: Claude couldn't emit, so the (claude_inline, shape)
// bucket was always empty. This CLI closes that gap.
//
// Usage:
//   acc emit knowledge_candidate --claim "<the claim>" \
//             [--confidence 0.7] [--refs evt1,evt2] [--directive D...]
//
//   acc emit lesson_extracted --summary "<the lesson>" \
//             [--refs evt1,evt2] [--directive D...]
//
//   acc emit claude_reasoning_recorded --summary "<one-line distillation>" \
//             [--refs evt1,evt2]
//
// Discipline (per prior knowledge): one summary emission per substantive
// Claude turn — a commit, a multi-file edit, a confirmed diagnosis. NOT
// per-tool-call. Per-tool emission would flood the events table and
// pollute the embedding space. The brain's `brain_reasoning_recorded`
// is too granular for retrieval; what matters is the distilled output.

import { mcpCall } from "./rpc";

type Args = Record<string, string | boolean>;

const parseArgs = (argv: string[]): { positional: string[]; flags: Args } => {
  const positional: string[] = [];
  const flags: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq >= 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[a.slice(2)] = next;
      i++;
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return { positional, flags };
};

const HELP = `acc emit — Claude-side ingress for canonical substrate event kinds

usage: acc emit <kind> [flags]

  Supported kinds (CSYMEMIT01 symmetric-emission set):
    knowledge_candidate       --claim "..." [--confidence N] [--refs …]
    lesson_extracted          --summary "..." [--refs …]
    claude_reasoning_recorded --summary "..." [--refs …]
    act_tuple_recorded        --intent "..." --action "..." --verifier-kind X
                              [--predicted-residual N] [--observed-residual N]
                              [--cited-knowledge-ids …]
                              [--cited-artifact-ids …]

  Common flags:
    --directive <id>          attach to a directive (otherwise null)
    --task <id>               attach to a task (otherwise null)
    --refs id1,id2,...        context_refs (comma-separated event ids)
    --substrate-origin X      default 'claude_inline'

Emissions populate the per-(substrate_origin, goal_shape) primitive used
by retrieval reranking (substrate/views.ts originPromotionByGoalShape) so
the next opencode brain cycle can compare Claude's recent emissions
against its own. This is the smallest falsifiable contract for the
multi-model merger per promoted knowledge ES34ZQEMSS5Z.

Discipline: emit ONE summary per substantive turn (commit, multi-file
edit, confirmed diagnosis). NOT per-tool-call. Granular emission floods
the events table; the embedding space gets noisy.
`;

const SUPPORTED = new Set([
  "knowledge_candidate",
  "lesson_extracted",
  "claude_reasoning_recorded",
  "act_tuple_recorded",
  // L6 + adjudication unified primitive (registered as event_kind in
  // substrate/event_kinds.ts; consumer wired in cli/apply.ts
  // authorizeApply via the brain's diff). Required payload:
  // target_event_id, verdict (free string), adjudicator_origin.
  "pre_apply_adjudication_recorded",
]);

export const runEmit = async (argv: string[]): Promise<number> => {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return argv.length === 0 ? 1 : 0;
  }
  const { positional, flags } = parseArgs(argv);
  const kind = positional[0];
  if (!kind) {
    process.stderr.write("acc emit: missing <kind> positional\n");
    return 1;
  }
  if (!SUPPORTED.has(kind)) {
    process.stderr.write(
      `acc emit: kind '${kind}' is not in the Claude-side authority set. Supported: ${[...SUPPORTED].join(", ")}\n`,
    );
    return 1;
  }

  const parseRefs = (raw: unknown): string[] => {
    if (typeof raw !== "string") return [];
    return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  };

  const refs = parseRefs(flags.refs);
  const evidenceRefs = parseRefs(flags["evidence-refs"]);
  const substrateOrigin = typeof flags["substrate-origin"] === "string"
    ? String(flags["substrate-origin"])
    : "claude_inline";

  // Build payload per kind. Each kind has a small required-field set so
  // the substrate's merger can do meaningful clustering.
  const payload: Record<string, unknown> = {};
  if (kind === "knowledge_candidate") {
    if (typeof flags.claim !== "string" || flags.claim.length === 0) {
      process.stderr.write("acc emit knowledge_candidate: --claim is required\n");
      return 1;
    }
    payload.claim = flags.claim;
    if (flags.confidence !== undefined) {
      const c = Number(flags.confidence);
      if (Number.isFinite(c) && c >= 0 && c <= 1) payload.confidence = c;
    }
  } else if (kind === "lesson_extracted") {
    if (typeof flags.summary !== "string" || flags.summary.length === 0) {
      process.stderr.write("acc emit lesson_extracted: --summary is required\n");
      return 1;
    }
    payload.summary = flags.summary;
  } else if (kind === "claude_reasoning_recorded") {
    if (typeof flags.summary !== "string" || flags.summary.length === 0) {
      process.stderr.write("acc emit claude_reasoning_recorded: --summary is required\n");
      return 1;
    }
    payload.summary = flags.summary;
  } else if (kind === "act_tuple_recorded") {
    if (typeof flags.intent !== "string" || flags.intent.length === 0) {
      process.stderr.write("acc emit act_tuple_recorded: --intent is required\n");
      return 1;
    }
    if (typeof flags.action !== "string" || flags.action.length === 0) {
      process.stderr.write("acc emit act_tuple_recorded: --action is required\n");
      return 1;
    }
    if (typeof flags["verifier-kind"] !== "string" || flags["verifier-kind"].length === 0) {
      process.stderr.write("acc emit act_tuple_recorded: --verifier-kind is required\n");
      return 1;
    }
    payload.intent = flags.intent;
    payload.action = flags.action;
    payload.verifier_kind = flags["verifier-kind"];
    if (flags["predicted-residual"] !== undefined) {
      const n = Number(flags["predicted-residual"]);
      if (Number.isFinite(n) && n >= 0 && n <= 1) payload.predicted_residual = n;
    }
    if (flags["observed-residual"] !== undefined) {
      const n = Number(flags["observed-residual"]);
      if (Number.isFinite(n) && n >= 0 && n <= 1) payload.observed_residual = n;
    }
    payload.cited_knowledge_ids = parseRefs(flags["cited-knowledge-ids"]);
    payload.cited_artifact_ids = parseRefs(flags["cited-artifact-ids"]);
  } else if (kind === "pre_apply_adjudication_recorded") {
    if (typeof flags.verdict !== "string" || flags.verdict.length === 0) {
      process.stderr.write("acc emit pre_apply_adjudication_recorded: --verdict is required\n");
      return 1;
    }
    if (typeof flags.target !== "string" || flags.target.length === 0) {
      process.stderr.write("acc emit pre_apply_adjudication_recorded: --target is required\n");
      return 1;
    }
    payload.verdict = flags.verdict;
    payload.target_event_id = flags.target;
    payload.adjudicator_origin = substrateOrigin;
    payload.evidence_event_ids = evidenceRefs;
    if (typeof flags["owner-authority"] === "string" && flags["owner-authority"].length > 0) {
      payload.owner_authority_level = flags["owner-authority"];
    }
  } else if (kind === "pre_apply_adjudication_recorded") {
    if (typeof flags.target !== "string" || flags.target.length === 0) {
      process.stderr.write("acc emit pre_apply_adjudication_recorded: --target is required (event_id of the proposal being adjudicated)\n");
      return 1;
    }
    if (typeof flags.verdict !== "string" || flags.verdict.length === 0) {
      process.stderr.write("acc emit pre_apply_adjudication_recorded: --verdict is required (free string: contradicts, corrects, proposes_alternative, peer_approve, gray_zone_review, escalate_to_owner)\n");
      return 1;
    }
    payload.target_event_id = flags.target;
    payload.verdict = String(flags.verdict).toLowerCase();
    payload.adjudicator_origin = substrateOrigin;
    payload.evidence_event_ids = parseRefs(flags["evidence-refs"]);
    if (typeof flags["owner-authority"] === "string") {
      payload.owner_authority_level = flags["owner-authority"];
    }
    if (typeof flags.reason === "string") payload.reason = flags.reason;
    // The apply-gate consumer looks for target_event_id in
    // context_refs OR in payload — we set both so the read path
    // is fail-safe.
    if (!refs.includes(String(flags.target))) refs.push(String(flags.target));
  }

  // Tag emitter so the per-(origin, shape) primitive can rank Claude
  // emissions distinctly from opencode emissions.
  payload.emitter = "claude_code";
  payload.emitted_at = new Date().toISOString();

  // The MCP schema rejects null for directive_id / task_id — omit the
  // fields entirely when not set rather than passing null.
  const emitArgs: Record<string, unknown> = {
    kind,
    payload,
    context_refs: [...new Set([...refs, ...evidenceRefs, ...(typeof payload.target_event_id === "string" ? [payload.target_event_id] : [])])],
    substrate_origin: substrateOrigin,
  };
  if (typeof flags.directive === "string") emitArgs.directive_id = flags.directive;
  if (typeof flags.task === "string") emitArgs.task_id = flags.task;
  const env = await mcpCall("substrate.emit", emitArgs);
  if (!env.ok) {
    process.stderr.write(`acc emit: ${kind} failed — ${env.error}\n`);
    return 1;
  }
  const out = env.result as { event_id?: string; id?: string } | null;
  const newId = out?.event_id ?? out?.id ?? "?";
  const summary = (typeof payload.claim === "string" ? payload.claim
    : typeof payload.summary === "string" ? payload.summary
    : typeof payload.intent === "string" ? payload.intent
    : typeof payload.verdict === "string" ? String(payload.verdict) + " -> " + String(payload.target_event_id ?? "?")
    : "").replace(/\s+/g, " ").slice(0, 80);
  process.stdout.write(`${kind} ${newId} origin=${substrateOrigin} ${summary}\n`);
  return 0;
};
