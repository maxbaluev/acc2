// RLM-first routing: this module intentionally contains NO free-text intent
// classifier.
//
// The owner verdict is explicit ("keyword classification is totally wrong")
// and the v2 contract is unambiguous: "NO regex intent pre-classification"
// and "never use regex for language understanding." A keyword/substring
// classifier (the former `classifyTask` / `classifyGoal`) silently diverted
// any directive containing tokens like "test" / "verify" / "compute" away
// from the brain into the generate-and-select organism, which degenerate-
// closed them. That entire surface — the VERIFIABLE / AMBIGUOUS / COMPLEX /
// SINGLE_DELIVERABLE keyword arrays, the `matchKeywords` helper, and the
// `classifyTask` / `classifyGoal` functions — has been removed.
//
// Routing is now RLM-first: the directive flows straight to the substrate's
// universal prompt-composed dispatch and the LM understands intent natively.
// Generate-and-select lane eligibility must come from the substrate's scored
// dispatch decision or a posterior-scored predicate row — NOT from this
// module. Cold-start uncertainty (no scored evidence) falls through to the
// brain; the organism is never authorized to intercept on a keyword guess.
//
// This file is intentionally minimal. If a future caller needs a lane-route
// type, define it where it is consumed (or admit a scored predicate row);
// do not reintroduce a free-text classifier here.

export {};
