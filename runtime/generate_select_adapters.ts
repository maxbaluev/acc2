// Phase 3+4 of the "generate-and-select" architecture: the substrate
// adapters. Phase 2 (`generate_select.ts`) is a pure, dependency-injected
// loop that performs NO DB / network / LLM work. This module supplies the
// REAL implementations of those injected deps, built on the existing
// substrate primitives — so the loop connects to the experience stream,
// the owner-input ledger, and a deterministic no-LLM comparator.
//
// Nothing here is strategic-LLM work: the comparator is a transparent
// structural rule (lower provenance residual wins), owner contact is a
// single `owner_input_required` ledger emit (a PREFERENCE request, not a
// score), and outcome recording is one `act_tuple_recorded` envelope that
// binds the selection to the experience stream for credit. An LLM
// comparator can replace `structuralComparator` later via the same DI
// seam — this module just gives the loop a working default.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import {
  verifyClaimProvenance,
  type ClaimInput,
} from "./claim_provenance_verifier";
import {
  type Candidate,
  type ComparisonResult,
  type GenerateSelectDeps,
  type Preference,
  type SelectOutcome,
} from "./generate_select";
import { emitActTupleDirect } from "./act_tuple";
import { emitEvent, type EmittedEvent } from "./events";

// ── stable artifact handles for the act-tuple envelope ────────────────
// These are registry handles (lazily admitted by the act-tuple projection
// gate in events.ts) so credit can accrue to the generate-and-select
// selection action and its outcome verifier.
export const GENERATE_SELECT_ACTION_ARTIFACT = "generate_select_action";
export const GENERATE_SELECT_VERIFIER_ARTIFACT = "generate_select_outcome_verifier";
export const GENERATE_SELECT_VERIFIER_KIND = "generate_select_outcome";

const isSourced = (input: ClaimInput): boolean =>
  typeof (input as { source_uri?: unknown }).source_uri === "string" &&
  (input as { source_uri: string }).source_uri.length > 0;

// Count grounded (source_uri'd) leaf inputs across a candidate's claims —
// the comparator's tie-break signal. More directly-sourced inputs = more
// grounded = preferred when residuals tie.
const groundedInputCount = <T>(candidate: Candidate<T>): number => {
  let n = 0;
  for (const claim of candidate.claims) {
    for (const input of claim.inputs) if (isSourced(input)) n += 1;
  }
  return n;
};

const provenanceResidual = <T>(candidate: Candidate<T>): number =>
  verifyClaimProvenance(candidate.claims).residual;

// ── (1) recordOutcomeToStream ─────────────────────────────────────────
// Bind every selection to the experience stream as ONE grounded act-tuple
// envelope. The substrate projects it into action_predicted / scored /
// candidate_confirmed / applied_change_committed / credit rows. The
// residual is the selected candidate's provenance residual (the truth-
// bearing signal); a null selection (all candidates failed provenance)
// records as a failed outcome with residual 1.0.
export const recordOutcomeToStream = <T>(
  db: Database,
  task: string,
  outcome: SelectOutcome<T>,
  opts: {
    directiveId?: string;
    taskId?: string;
    substrateOrigin?: string;
    citedKnowledgeIds?: string[];
    citedArtifactIds?: string[];
  } = {},
): EmittedEvent => {
  const selected = outcome.selected;
  const residual = selected ? provenanceResidual(selected) : 1.0;
  const filteredSummary = outcome.filtered_out
    .map((f) => `${f.id}@${f.residual.toFixed(2)}`)
    .join(", ");
  const reasoning =
    `winner=${selected ? selected.id : "<none>"} reason=${outcome.reason}` +
    `; survivors_compared=${outcome.comparisons.length}` +
    (outcome.preference_used
      ? `; owner_preference=${outcome.preference_used.winner_id}`
      : "") +
    (filteredSummary.length > 0 ? `; filtered_out=[${filteredSummary}]` : "");

  const affected: string[] = [];
  if (selected) affected.push(`candidate:${selected.id}`);
  for (const f of outcome.filtered_out) affected.push(`candidate:${f.id}`);

  return emitActTupleDirect(db, {
    directiveId: opts.directiveId,
    taskId: opts.taskId,
    substrateOrigin: opts.substrateOrigin ?? "claude_inline",
    intent: `generate_and_select: ${task}`,
    reasoningSummary: reasoning,
    actionSummary: selected
      ? `selected candidate ${selected.id} via ${outcome.reason}`
      : "no candidate survived provenance filtering",
    effectSummary: selected
      ? `bound selection ${selected.id} to experience stream (provenance residual ${residual.toFixed(2)})`
      : "recorded a no-selection generate-and-select outcome",
    verifierKind: GENERATE_SELECT_VERIFIER_KIND,
    predictedResidual: residual,
    residual,
    outcome: selected ? "succeeded" : "failed",
    actionArtifactId: GENERATE_SELECT_ACTION_ARTIFACT,
    verifierArtifactId: GENERATE_SELECT_VERIFIER_ARTIFACT,
    affectedResources: affected.length > 0 ? affected : undefined,
    citedKnowledgeIds: opts.citedKnowledgeIds ?? [],
    citedArtifactIds: opts.citedArtifactIds ?? [],
  });
};

// ── (2) requestOwnerPreference ────────────────────────────────────────
// Emit an `owner_input_required` event presenting BOTH candidates and
// asking which is better and WHY — a PREFERENCE, not a score. This is the
// REQUEST side: the actual preference returns asynchronously via a later
// owner-input event keyed back to this request. We return a marker
// Preference whose `reason` records that the request was emitted (the loop
// treats `winner_id` as the current champion until the owner answers).
export const requestOwnerPreference = <T>(
  db: Database,
  task: string,
  a: Candidate<T>,
  b: Candidate<T>,
  opts: {
    directiveId?: string;
    taskId?: string;
    substrateOrigin?: string;
  } = {},
): { request: EmittedEvent; preference: Preference } => {
  const candidateView = (c: Candidate<T>) => ({
    id: c.id,
    generator: c.generator,
    provenance_residual: provenanceResidual(c),
    grounded_inputs: groundedInputCount(c),
    artifact: c.artifact as JsonValue,
  });

  const request = emitEvent(db, {
    kind: "owner_input_required",
    substrate_origin: opts.substrateOrigin ?? "claude_inline",
    directive_id: opts.directiveId,
    task_id: opts.taskId,
    payload: {
      input_kind: "pairwise_preference",
      question: "Which of these two is better, and why?",
      task,
      candidate_a: candidateView(a),
      candidate_b: candidateView(b),
      note: "This is a PREFERENCE request (which is better + why), not a numeric score.",
    },
  });

  return {
    request,
    preference: {
      winner_id: a.id,
      reason: `owner_input_required emitted (event ${request.id}); awaiting owner preference`,
    },
  };
};

// ── (3) structuralComparator ──────────────────────────────────────────
// A NO-LLM default pairwise comparator. Prefer the candidate with LOWER
// provenance residual (less invented/unsourced numerics); tie-break by
// MORE grounded (source_uri'd) inputs. Confidence reflects the residual
// gap so the loop's "close call -> spend an owner preference" path fires
// only when the structural signal is weak. This makes the whole loop work
// WITHOUT the brain; an LLM comparator can replace it via DI.
export const structuralComparator = <T>(
  _task: string,
  a: Candidate<T>,
  b: Candidate<T>,
): ComparisonResult => {
  const ra = provenanceResidual(a);
  const rb = provenanceResidual(b);
  const gap = Math.abs(ra - rb);

  if (gap > 1e-9) {
    const winner = ra < rb ? a : b;
    return {
      winner_id: winner.id,
      confidence: Math.min(1, gap),
      rationale:
        `lower provenance residual wins: ${a.id}=${ra.toFixed(3)} vs ` +
        `${b.id}=${rb.toFixed(3)} (gap ${gap.toFixed(3)})`,
    };
  }

  // Residuals tie -> tie-break on grounded-input count.
  const ga = groundedInputCount(a);
  const gb = groundedInputCount(b);
  if (ga !== gb) {
    const winner = ga > gb ? a : b;
    return {
      winner_id: winner.id,
      // Equal residuals -> a genuinely close call: low confidence so the
      // loop is free to spend an owner preference. The grounded-input
      // edge nudges confidence above zero.
      confidence: Math.min(0.1, Math.abs(ga - gb) / Math.max(1, ga + gb)),
      rationale:
        `equal provenance residual (${ra.toFixed(3)}); more grounded inputs ` +
        `wins: ${a.id}=${ga} vs ${b.id}=${gb}`,
    };
  }

  // Total tie: keep the incumbent (a), zero confidence -> maximally close.
  return {
    winner_id: a.id,
    confidence: 0,
    rationale: `total tie: equal residual (${ra.toFixed(3)}) and grounded inputs (${ga})`,
  };
};

// ── (4) buildSubstrateDeps ────────────────────────────────────────────
// Convenience assembler: wires the structural comparator (default),
// owner-preference request, and experience-stream recorder into a
// GenerateSelectDeps the pure loop can consume directly. Pass a custom
// `comparator` (e.g. an LLM-backed one) to override the structural default.
export const buildSubstrateDeps = <T>(
  db: Database,
  cfg: {
    task: string;
    generators: ((task: string) => Promise<Candidate<T>[]>)[];
    comparator?: (
      task: string,
      a: Candidate<T>,
      b: Candidate<T>,
    ) => Promise<ComparisonResult>;
    highStakes?: boolean;
    directiveId?: string;
    taskId?: string;
    substrateOrigin?: string;
    filterThreshold?: number;
    closeMargin?: number;
  },
): GenerateSelectDeps<T> => {
  const ctx = {
    directiveId: cfg.directiveId,
    taskId: cfg.taskId,
    substrateOrigin: cfg.substrateOrigin,
  };
  return {
    generators: cfg.generators,
    comparator:
      cfg.comparator ??
      (async (task, a, b) => structuralComparator(task, a, b)),
    requestOwnerPreference: async (task, a, b) =>
      requestOwnerPreference(db, task, a, b, ctx).preference,
    recordOutcome: (outcome: SelectOutcome<T>) => {
      recordOutcomeToStream(db, cfg.task, outcome, ctx);
    },
    highStakes: cfg.highStakes,
    filterThreshold: cfg.filterThreshold,
    closeMargin: cfg.closeMargin,
  };
};
