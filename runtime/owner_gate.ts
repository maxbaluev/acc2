// acc2 owner consent helpers. Apply policy is structural: fixed source-path
// enumerations do not decide whether an artifact or proposal requires owner
// consent. Dynamic owner-stated boundaries live in owner_profile.things_to_never_do.

import type { Database } from "bun:sqlite";
import type { SandboxDecl } from "../substrate/types";

export const OWNER_GATED_PATH_PATTERNS: ReadonlyArray<{ pattern: string; regex: RegExp }> = Object.freeze([]);

export const STRUCTURALLY_PROTECTED_SURFACES = Object.freeze([
  "admin_token",
  "deny_list",
  "owner_gate.things_to_never_do",
  "sqlite.foreign_keys",
  "sqlite.not_null",
  "sqlite.single_writer",
]);

export const protectedSurfaceReason = (surfaceId: string): string | null => {
  if (STRUCTURALLY_PROTECTED_SURFACES.includes(surfaceId)) return "structural_security_or_schema_invariant";
  return null;
};

export type OwnerGateDecision = {
  requires_consent: boolean;
  matched_patterns: string[];
};

/** Inspect a sandbox declaration. Static path lists are not policy; artifact
 *  admission relies on sandbox declaration, runtime observation, verifier
 *  residuals, and owner_profile.things_to_never_do at apply time. */
export const ownerGateDecision = (_sandbox: SandboxDecl): OwnerGateDecision => ({
  requires_consent: false,
  matched_patterns: [],
});

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
