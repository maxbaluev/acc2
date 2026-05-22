export type OwnerProfileCard = {
  detected_language?: string | null;
  autonomy_score?: number | null;
  autonomy_score_floor?: number | null;
  // Open-ended signal vectors per CLAUDE.md "Owner Model" — every key
  // is discovered evidence, not a fixed schema. Six canonical axes are
  // surfaced for rendering; new axes appear by being emitted, not by
  // editing this type. Each value is a Record<string, number> so the
  // brain can score arbitrary axes (e.g. rendering_signals carries
  // `terse_preference: 0.8` or autonomy_signals carries
  // `wants_explicit_approval: 0.6`).
  rendering_signals?: Record<string, number>;
  autonomy_signals?: Record<string, number>;
  control_signals?: Record<string, number>;
  risk_signals?: Record<string, number>;
  collaboration_signals?: Record<string, number>;
  goal_continuity_signals?: Record<string, number>;
  // preferred_terms / avoided_terms remain on the card for diagnostic
  // visibility but are NO LONGER used to mechanically swap words in
  // output. The mechanical term-substitution renderer (renderOwnerString)
  // was removed: an RLM renders naturally in the owner's language at high
  // quality, it does not word-swap by rule. Owner language comes from
  // detected_language and the owner predicates, not vocabulary mirroring.
  preferred_terms?: string[];
  avoided_terms?: string[];
  things_to_never_do?: string[];
  // Patterns the owner has historically asked to manually review (e.g.
  // "anything touching auth", "external posts before send"). Substrate
  // promotes the patterns from owner_decision_recorded evidence.
  manual_review_patterns?: string[];
  hot_topics?: string[];
  time_window?: unknown;
  exposed_concepts?: string[];
  declined_concepts?: string[];
};
