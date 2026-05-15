// acc2 owner-gate — refuse code-artifact admissions whose sandbox would
// mutate owner-protected files unless the admission cites a valid
// owner_decision_recorded consent event.
//
// Why this exists: the brain self-modified 18 source files during a prior
// session including a syntax-broken `continue;` outside a loop in
// runtime/task_dispatcher.ts — daemon refused to boot. The general lesson:
// strategic code that touches the system's own contract (CLAUDE.md,
// docs/v2-design.md, .claude/rules/*, operator guides) MUST go through
// explicit owner consent, never quietly through the admission path.
//
// The gate is intentionally narrow: only `fs_write` globs that would let
// the artifact's body write to a gated path trigger it. Read-only access
// is unrestricted (the brain reads contract files all the time for
// retrieval). Bun + uv runtimes both honour this; camofox-browser has no
// fs_write and is naturally exempt.

import type { Database } from "bun:sqlite";
import type { SandboxDecl } from "../substrate/types";

/** Glob/path patterns the system protects from un-consented mutation.
 *  Captured as regexes for cheap matching against fs_write glob entries.
 *  Each entry's `pattern` is what the gate prints in the rejection event so
 *  the operator can see which contract surface was at risk.
 *
 *  Match rule: an fs_write glob triggers the gate if any of:
 *    - the glob LITERALLY equals a gated path (e.g. "CLAUDE.md");
 *    - the glob is a prefix/substring match for the gated path (e.g.
 *      "**\/CLAUDE.md", "system/acc2/CLAUDE.md");
 *    - the glob is a wildcard that would tear open a gated directory
 *      (e.g. "docs/**", ".claude/**", "**\/*.md").
 *
 *  Conservative — false-positive flags trigger a benign consent prompt;
 *  false-negatives quietly admit self-modifying code. */
export const OWNER_GATED_PATH_PATTERNS: ReadonlyArray<{ pattern: string; regex: RegExp }> = Object.freeze([
  { pattern: "CLAUDE.md",                    regex: /(^|\/)CLAUDE\.md(\b|$)/i },
  { pattern: "docs/v2-design.md",            regex: /docs\/v2-design\.md/i },
  { pattern: ".claude/rules/**",             regex: /\.claude\/rules(\/|$)/i },
  { pattern: "docs/operator-install.md",     regex: /docs\/operator-install\.md/i },
  { pattern: "docs/ops-guide.md",            regex: /docs\/ops-guide\.md/i },
]);

/** Decide whether a single fs_write glob explicitly targets a gated path.
 *  The rule is narrow on purpose — overly broad wildcards like `**` or
 *  `**\/*` do NOT trigger consent because the runtime's cwd jail
 *  (runtimes/bun.ts spawns with cwd=<tempdir>) already prevents the body
 *  from reaching the source tree. The gate fires when the glob contains a
 *  literal reference to a gated path. This is the same shape the brain
 *  would use when *intending* to self-modify the system contract.
 *
 *  Triggers:
 *    - literal file references (case-insensitive): "CLAUDE.md",
 *      "system/acc2/CLAUDE.md", "docs/v2-design.md", etc.
 *    - directory wildcards over gated dirs: "docs/**", ".claude/rules/**".
 *
 *  Does NOT trigger:
 *    - `**`, `**\/*`, `*.txt`, `/tmp/**`, `out/*.json` — production
 *      sandboxes commonly use these and the cwd jail makes them safe.
 */
const globCoversAnyGatedPath = (glob: string): string | null => {
  for (const { pattern, regex } of OWNER_GATED_PATH_PATTERNS) {
    if (regex.test(glob)) return pattern;
  }
  return null;
};

export type OwnerGateDecision = {
  requires_consent: boolean;
  matched_patterns: string[];
};

/** Inspect a sandbox declaration. Returns { requires_consent: true,
 *  matched_patterns: [...] } if any `fs_write` glob would let the artifact
 *  body write to an owner-gated path. */
export const ownerGateDecision = (sandbox: SandboxDecl): OwnerGateDecision => {
  // camofox-browser has no fs_write — naturally exempt.
  if (sandbox.runtime === "camofox-browser") {
    return { requires_consent: false, matched_patterns: [] };
  }
  const writes: ReadonlyArray<string> = sandbox.fs_write ?? [];
  const matched = new Set<string>();
  for (const glob of writes) {
    const hit = globCoversAnyGatedPath(glob);
    if (hit) matched.add(hit);
  }
  return {
    requires_consent: matched.size > 0,
    matched_patterns: Array.from(matched),
  };
};

/** Look up the cited consent event and verify its shape:
 *    - exists in the events table
 *    - kind = 'owner_decision_recorded'
 *    - belongs to a directive (the caller may verify it matches the
 *      admission's directive scope when one is provided)
 *  Returns the directive_id when valid, null otherwise. */
export const verifyOwnerConsent = (
  db: Database,
  consentEventId: string,
  expectedDirectiveId?: string,
): { ok: true; directive_id: string } | { ok: false; reason: string } => {
  if (typeof consentEventId !== "string" || consentEventId.trim().length === 0) {
    return { ok: false, reason: "consent_event_id_blank" };
  }
  const row = db
    .query("SELECT kind, directive_id FROM events WHERE id = ?")
    .get(consentEventId) as { kind: string; directive_id: string } | null;
  if (!row) return { ok: false, reason: "consent_event_id_not_found" };
  if (row.kind !== "owner_decision_recorded") {
    return { ok: false, reason: `consent_event_kind_mismatch:${row.kind}` };
  }
  if (expectedDirectiveId !== undefined && row.directive_id !== expectedDirectiveId) {
    return { ok: false, reason: `consent_directive_mismatch:${row.directive_id}!=${expectedDirectiveId}` };
  }
  return { ok: true, directive_id: row.directive_id };
};
