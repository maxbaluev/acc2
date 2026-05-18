// rendering_verifier.ts — scores owner-visible strings against the policy.
//
// Brain contract Q471RAN88X0H513V8BC3BTW0AW (2026-05-17): every primary
// owner-visible surface must hide IDs/jargon and use the owner's
// language. This verifier turns that invariant into a number a
// substrate-side action_scored row can credit against the policy
// posterior.
//
// Verifier shape (universal-kind, per substrate/CLAUDE.md):
//   - INPUT:  the rendered text + the OwnerRenderingPolicyRow snapshot
//   - OUTPUT: { residual ∈ [0,1], breakdown: Record<string,number>,
//                violations: Array<{axis, sample, message}> }
//
// The residual is the *expected loss* — 0.0 means the render perfectly
// matches the policy, 1.0 means total violation. Consumers route to
// owner_rendering_feedback_recorded when residual > threshold, and the
// breakdown lets the brain learn which axis (jargon vs ids vs declined
// concepts) is regressing.
//
// Axis names are intentionally open-ended (k_201, universal-kind): the
// Record<string,number> shape lets new axes appear in the breakdown
// without code changes downstream.

import type { OwnerRenderingPolicyRow } from "../substrate/views";

/** ULID-shape detector: 26 chars of Crockford base32 (digits + A-Z minus
 *  I, L, O, U). The acc substrate uses ULID-26 as the canonical event_id
 *  shape; any primary owner-visible string containing one is leaking
 *  the substrate's internal vocabulary into the operator's surface.
 *
 *  We accept both the strict Crockford alphabet (no I/L/O/U) and the
 *  looser "any A-Z 26-char block" — older event_ids predate the strict
 *  Crockford constraint, and we'd rather flag a false-positive on a
 *  random 26-letter word than miss a real id leak. */
export const ID_LIKE_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b|\b[0-9A-Z]{26}\b/;

/** Substrate vocabulary that operators outside the engineering team
 *  should NOT see in primary surfaces. The renderer is free to put these
 *  in detail drawers; the verifier flags them when they appear in a
 *  string marked audience='primary'. */
export const SUBSTRATE_JARGON_TERMS: readonly string[] = [
  "dispatch_decided",
  "task_node_opened",
  "task_committed",
  "task_failed",
  "constitutional_gate",
  "dispatcher_violation",
  "closure_audited",
  "task_closure_audited",
  "lifecycle_status",
  "residual_optional",
  "verifier_residual",
  "act_tuple_recorded",
  "owner_profile_view",
  "owner_rendering_policy_view",
  "substrate_narrative_recent_view",
  "claude_inline_ready_leaves_view",
  "context_refs",
  "dispatch_resolved_view",
  "pending_owner_decision_queue_view",
  "kind=task_",
  "knowledge_candidate",
  "contract_amendment_proposed",
  "directive_amended",
  "directive_opened",
  "directive_closed",
  "applied_change_committed",
  "opencode_brain",
  "claude_inline",
  "substrate_replay",
  "bridge_failed",
  "intent_classified",
  "ACC2_",
  "v2.sock",
  "owner_input_received",
  "owner_decision_recorded",
  "rendered_owner_message_recorded",
  "owner_rendering_feedback_recorded",
];

/** Soft jargon — borderline "engineering English" that may leak into
 *  primary text. The verifier weights these lower than substrate kind
 *  names (a soft hit raises residual less than a hard hit). */
export const SOFT_JARGON_TERMS: readonly string[] = [
  "posterior",
  "predicated",
  "MCP",
  "SQLite",
  "WAL",
  "ULID",
  "verifier",
  "shadow_score",
  "shadow_ranks",
  "anchored_replace",
  "actor identity",
  "minted session",
  "Beta posterior",
];

export type RenderingVerifierInput = {
  rendered_text: string;
  audience: "primary" | "detail_drawer" | string;
  policy: OwnerRenderingPolicyRow | null;
};

export type RenderingVerifierViolation = {
  axis: string;
  sample: string;
  message: string;
};

export type RenderingVerifierResult = {
  residual: number;
  breakdown: Record<string, number>;
  violations: RenderingVerifierViolation[];
};

const ZERO_AXES = {
  id_leak: 0,
  jargon_substrate: 0,
  jargon_soft: 0,
  avoided_term: 0,
  declined_concept: 0,
  things_to_never_do: 0,
  ask_clarity: 0,
} as const;

/** Lowercase + word-boundary check helper. Returns the matched term
 *  exactly (for evidence) or null. */
const findTerm = (text: string, term: string): string | null => {
  if (!term) return null;
  const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const m = re.exec(text);
  return m ? m[0] : null;
};

/** Score a rendered owner-visible string against the current rendering
 *  policy. Pure function — no DB reads, no side effects, no event emits.
 *
 *  Residual aggregation:
 *    - ID leak               : 0.40 (hard)
 *    - Substrate jargon hit  : 0.15 per term (capped at 0.45)
 *    - Soft jargon hit       : 0.05 per term (capped at 0.20)
 *    - Owner avoided term    : 0.20 per term (capped at 0.40)
 *    - Declined concept hit  : 0.20 per term (capped at 0.40)
 *    - things_to_never_do    : 0.50 (single hit → near-total violation)
 *    - Ask clarity penalty   : 0.10 if the surface mentions an action
 *                              without a clear "what owner does next"
 *                              phrasing
 *  Detail-drawer surfaces relax ID + substrate-jargon penalties to 1/4
 *  of the primary weight (drawers MAY surface IDs for drilldown).
 *  Final residual is clamped to [0,1]. */
export const verifyRendering = (input: RenderingVerifierInput): RenderingVerifierResult => {
  const breakdown: Record<string, number> = { ...ZERO_AXES };
  const violations: RenderingVerifierViolation[] = [];
  const text = input.rendered_text ?? "";
  const isPrimary = input.audience === "primary";
  const drawerScale = isPrimary ? 1.0 : 0.25;

  // (1) ID leak.
  const idMatch = ID_LIKE_RE.exec(text);
  if (idMatch) {
    const hit = 0.40 * drawerScale;
    breakdown.id_leak = hit;
    violations.push({
      axis: "id_leak",
      sample: idMatch[0],
      message: isPrimary
        ? "primary owner-visible string contains an event_id-shaped token (26-char ULID); move it to detail_refs"
        : "detail drawer contains an id-shaped token; verify the operator actually needs the raw id",
    });
  }

  // (2) Substrate jargon (hard).
  let substrateJargonHits = 0;
  for (const term of SUBSTRATE_JARGON_TERMS) {
    const hit = findTerm(text, term);
    if (hit) {
      substrateJargonHits += 1;
      violations.push({
        axis: "jargon_substrate",
        sample: hit,
        message: `substrate vocabulary '${hit}' should not appear in ${isPrimary ? "primary" : "detail"} owner surfaces`,
      });
      if (substrateJargonHits >= 3) break;
    }
  }
  breakdown.jargon_substrate = Math.min(0.45, substrateJargonHits * 0.15) * drawerScale;

  // (3) Soft jargon.
  let softJargonHits = 0;
  for (const term of SOFT_JARGON_TERMS) {
    const hit = findTerm(text, term);
    if (hit) {
      softJargonHits += 1;
      violations.push({ axis: "jargon_soft", sample: hit, message: `engineering jargon '${hit}' may not render for non-technical owners` });
      if (softJargonHits >= 4) break;
    }
  }
  breakdown.jargon_soft = Math.min(0.20, softJargonHits * 0.05);

  // (4–6) Owner-profile-derived terms.
  const policy = input.policy;
  if (policy) {
    // avoided_terms
    let avoidedHits = 0;
    for (const term of policy.avoided_terms) {
      const hit = findTerm(text, term);
      if (hit) {
        avoidedHits += 1;
        violations.push({
          axis: "avoided_term",
          sample: hit,
          message: `term '${hit}' is on the owner's avoided_terms list`,
        });
      }
    }
    breakdown.avoided_term = Math.min(0.40, avoidedHits * 0.20);

    // declined_concepts
    let declinedHits = 0;
    for (const term of policy.declined_concepts) {
      const hit = findTerm(text, term);
      if (hit) {
        declinedHits += 1;
        violations.push({
          axis: "declined_concept",
          sample: hit,
          message: `concept '${hit}' was previously declined by the owner`,
        });
      }
    }
    breakdown.declined_concept = Math.min(0.40, declinedHits * 0.20);

    // things_to_never_do — a single hit is near-total violation.
    for (const term of policy.things_to_never_do) {
      const hit = findTerm(text, term);
      if (hit) {
        breakdown.things_to_never_do = 0.50;
        violations.push({
          axis: "things_to_never_do",
          sample: hit,
          message: `owner-set hard constraint hit: '${hit}'`,
        });
        break;
      }
    }
  }

  // (7) Ask clarity — when the renderer hints at an owner action but the
  //     phrasing is too engineering-y to make the ask obvious. Heuristic:
  //     primary surfaces that mention dispatch / route / cycle / residual
  //     without an explicit ordinary-language ask phrase ("reply", "let
  //     me know", "would you like", "do you want", "approve", "decline")
  //     get a small penalty.
  if (isPrimary) {
    const actionIndicators = /\b(dispatch|route|cycle|residual|claim|verify|gate|fail|abort)\b/i;
    const askPhrases = /\b(reply|let me know|would you|do you want|approve|decline|please|next step|tell me)\b/i;
    if (actionIndicators.test(text) && !askPhrases.test(text)) {
      breakdown.ask_clarity = 0.10;
      violations.push({
        axis: "ask_clarity",
        sample: "<no ordinary-language ask phrase found>",
        message: "primary surface implies an action without a clear plain-words ask",
      });
    }
  }

  // Aggregate residual — sum axes, clamp to [0,1].
  const residual = Math.max(
    0,
    Math.min(
      1,
      breakdown.id_leak
        + breakdown.jargon_substrate
        + breakdown.jargon_soft
        + breakdown.avoided_term
        + breakdown.declined_concept
        + breakdown.things_to_never_do
        + breakdown.ask_clarity,
    ),
  );

  return { residual, breakdown, violations };
};

/** Convenience: clean residual for a render the verifier should NEVER
 *  punish (system-emitted owner-facing UI primitives are pre-tested). */
export const RENDERING_CLEAN_RESIDUAL = 0.0;

/** The threshold above which the substrate's owner_rendering_feedback
 *  loop should mark the render as needing a follow-up
 *  (residual ≥ 0.3 = bad render; the same threshold acc2 uses for
 *  closure_residual). */
export const RENDERING_RESIDUAL_THRESHOLD = 0.3;
