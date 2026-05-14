// acc2 goal-shape hashing — coarse approximation for per-origin retrieval
// bias (v2-design.md §3.6.1 Rule 4, §17 Phase H, §18 cutover criterion 19).
//
// The reranker multiplies cosine × posterior by a per-(origin, goal_shape)
// bias multiplier sourced from `origin_promotion_view`. To do that, we need
// a stable token-equivalent hash of a directive's goal text so that two
// directives expressing the same intent collide on the same shape, but
// distinctly-different goals get distinct shapes.
//
// The Phase H algorithm is intentionally simple:
//   1. lowercase
//   2. strip ASCII punctuation
//   3. tokenize on whitespace
//   4. discard short stop-words (length < 2)
//   5. SORT the tokens — set-equivalence over reorderings
//   6. SHA-256 the sorted token stream
//   7. take the first 16 hex chars
//
// Phase J refines this with embedding-based clustering; the substrate's
// origin_promotion_view consumes whatever string this function returns, so
// the upgrade path is contained.
//
// Properties tests must guarantee:
//   - Stable: same input → same output forever.
//   - Set-equivalent: word reorderings produce the same hash.
//   - Distinct: meaningfully different inputs produce different hashes.
//   - Empty-safe: empty string → a stable, non-empty hash (so the view
//     never has to special-case missing goals).

import { createHash } from "node:crypto";

const PUNCT_RE = /[\p{P}\p{S}]+/gu; // unicode punctuation + symbols
const WHITESPACE_RE = /\s+/u;
const HASH_PREFIX_LEN = 16;

/** Normalize a directive goal text into a stable 16-char hex hash. The
 *  hash is set-equivalent over word reorderings (Phase J refines with
 *  embedding-based clustering). */
export const goalShape = (directiveText: string): string => {
  const text = (directiveText ?? "").toString();
  const lowered = text.toLowerCase();
  // Replace every punctuation/symbol run with a single space, then split.
  const stripped = lowered.replace(PUNCT_RE, " ");
  const tokens = stripped
    .split(WHITESPACE_RE)
    .filter((t) => t.length >= 2);
  // Sort for set-equivalence: "count todos in scripts" and "todos count in
  // scripts" collapse to the same shape. (Word-order semantics are a Phase
  // J refinement; the cluster-based hash will preserve order when it
  // matters.)
  tokens.sort();
  const canonical = tokens.join(" ");
  // SHA-256 is overkill for 16 chars but it's the same primitive every
  // other acc2 hash uses (payload_hash on events). The collision surface
  // at 16 hex chars (64 bits) is plenty for per-(origin, goal_shape)
  // aggregation in a substrate that holds thousands, not billions, of
  // directives.
  return createHash("sha256").update(canonical).digest("hex").slice(0, HASH_PREFIX_LEN);
};

/** Internal accessor for tests — expose the canonicalized token string so a
 *  test can prove the normalization shape without rehashing. */
export const __canonicalizeForTest = (directiveText: string): string => {
  const text = (directiveText ?? "").toString();
  const lowered = text.toLowerCase();
  const stripped = lowered.replace(PUNCT_RE, " ");
  const tokens = stripped.split(WHITESPACE_RE).filter((t) => t.length >= 2);
  tokens.sort();
  return tokens.join(" ");
};
