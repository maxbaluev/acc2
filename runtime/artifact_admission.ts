// acc2 artifact admission — gate for new code artifacts (v2-design.md §11.5).
//
// Admission protocol:
//   1. Validate the sandbox declaration shape. Bad shape → admission rejected.
//   2. Materialize a fresh code_artifact row in `admitted` state with priors
//      (alpha=1, beta=1, score=0.5, confidence=0.3) — these are the canonical
//      §11.5 admit values. We allocate the id BEFORE running the fixture so
//      the runtime invocation has a stable artifact_id to tag the events.
//   3. Run the fixture under the artifact's declared runtime. For Phase C
//      only `runtime: 'bun'` is wired; uv / camofox-browser admission returns
//      `phase_g_runtime_unsupported` and rolls back the row.
//   4. If the fixture run is `ok: true` and the observed residual (computed
//      from the artifact's `fixtureExpectedResidual` predicate — see below)
//      falls below `fixtureExpectedResidualBelow`, admit. Otherwise emit
//      `code_artifact_admission_rejected` + remove the row.
//
// Residual derivation at admission:
//   The admission caller declares `fixtureExpectedResidualBelow` (typically
//   0.2 — the §11.5 threshold). The fixture's artifact body is responsible
//   for returning a JSON value via `@@RESULT@@ <json>`. We treat the run as
//   "passing" if the bun runtime returns `ok: true` AND the parsed result
//   either:
//     (a) contains a numeric `residual` field ≤ fixtureExpectedResidualBelow, or
//     (b) is any other shape (we trust the body to have crashed if it disagreed
//         with its own fixture — admission is a smoke test, not a verifier).
//   This matches the design intent: admission proves the runtime can execute
//   the body cleanly, not that the verifier is perfect.

import type { Database } from "bun:sqlite";
import type { JsonValue, Runtime, SandboxDecl } from "../substrate/types";
import { validateSandboxDecl } from "./sandbox";
import { runBunArtifact } from "./runtimes/bun";
import { runUvArtifact } from "./runtimes/uv";
import { runCamofoxArtifact } from "./runtimes/camofox";
import { getArtifact, insertArtifact } from "./artifact_store";
import { ownerGateDecision } from "./owner_gate";
import type { EmitEventInput } from "./events";

export type AdmissionInput = {
  runtime: Runtime;
  body: string;
  declaredSandbox: SandboxDecl;
  fixtureInput: JsonValue;
  /** Threshold the fixture's residual must come in BELOW for admission to pass.
   *  Typically 0.2 per v2-design.md §11.5. */
  fixtureExpectedResidualBelow: number;
  /** Optional pre-allocated id so callers (or tests) can refer to the row
   *  before the function returns. */
  artifactId?: string;
  stateRoot?: string;
  name?: string;
  /** Brain dataflow audit bxdhdkm9e #3 (2026-05-15): provenance metadata
   *  the brain emits on code_artifact_candidate but the admission path
   *  previously dropped. The fields are all OPTIONAL — legacy seed
   *  admissions that don't supply them remain valid. When supplied,
   *  they land on the code_artifact row and become readable via the
   *  registry view + TUI artifact detail pane. */
  intent?: string;
  summary?: string;
  targetFiles?: string[];
  targetResources?: string[];
  sourceCandidateId?: string;
  governance?: {
    directiveId?: string;
    ownerConsentEventId?: string;
  };
};

export type AdmissionRejectionReason =
  | "sandbox_decl_invalid"
  | "fixture_residual_too_high"
  | "runtime_error"
  | "runtime_unavailable";

export type AdmissionResult =
  | { ok: true; artifactId: string }
  | { ok: false; reason: AdmissionRejectionReason; detail?: string };

// Canonical admission priors per v2-design.md §11.5.
const ADMIT_ALPHA = 1.0;
const ADMIT_BETA = 1.0;
const ADMIT_SCORE = 0.5;
const ADMIT_CONFIDENCE = 0.3;

/** Run admission for a new code artifact. Inserts the row at admit priors,
 *  runs the fixture, and either confirms admission (emitting
 *  `code_artifact_admitted`) or rolls back + emits
 *  `code_artifact_admission_rejected`. */
export const admitArtifact = async (
  db: Database,
  input: AdmissionInput,
  emit: (event: EmitEventInput) => void,
): Promise<AdmissionResult> => {
  // 1. Sandbox shape gate.
  const v = validateSandboxDecl(input.declaredSandbox);
  if (!v.ok) {
    emit({
      kind: "code_artifact_admission_rejected",
      substrate_origin: "substrate_auto",
      payload: {
        reason: "sandbox_decl_invalid",
        detail: v.reason,
        runtime: input.runtime,
      } as JsonValue,
    });
    return { ok: false, reason: "sandbox_decl_invalid", detail: v.reason };
  }
  if (input.declaredSandbox.runtime !== input.runtime) {
    emit({
      kind: "code_artifact_admission_rejected",
      substrate_origin: "substrate_auto",
      payload: {
        reason: "sandbox_decl_invalid",
        detail: `runtime_mismatch:${input.declaredSandbox.runtime}!=${input.runtime}`,
      } as JsonValue,
    });
    return {
      ok: false,
      reason: "sandbox_decl_invalid",
      detail: `runtime_mismatch:${input.declaredSandbox.runtime}!=${input.runtime}`,
    };
  }

  const gate = ownerGateDecision(input.declaredSandbox);
  if (gate.requires_consent) {
    emit({
      kind: "code_artifact_admission_rejected",
      substrate_origin: "substrate_auto",
      payload: {
        reason: "owner_consent_missing",
        detail: "dynamic_owner_policy_unavailable_at_admission",
        matched_patterns: gate.matched_patterns,
        runtime: input.runtime,
      } as JsonValue,
    });
    return { ok: false, reason: "runtime_error", detail: "dynamic_owner_policy_unavailable_at_admission" };
  }

  // 2. Insert at admit priors. We do this BEFORE running the fixture so the
  //    artifact_id is stable across the artifact_invoked / artifact_observed
  //    events; if the fixture fails we DELETE the row in the rejection branch.
  const row = insertArtifact(db, {
    runtime: input.runtime,
    body: input.body,
    declaredSandbox: input.declaredSandbox,
    stateRoot: input.stateRoot ?? null,
    posteriorAlpha: ADMIT_ALPHA,
    posteriorBeta: ADMIT_BETA,
    score: ADMIT_SCORE,
    confidence: ADMIT_CONFIDENCE,
    recentResidualMean: 0,
    recentKillCount: 0,
    status: "admitted",
    name: input.name ?? null,
    fixtureInput: input.fixtureInput,
    fixtureExpectedResidual: input.fixtureExpectedResidualBelow,
    intent: input.intent ?? null,
    summary: input.summary ?? null,
    targetFiles: input.targetFiles ?? null,
    targetResources: input.targetResources ?? null,
    sourceCandidateId: input.sourceCandidateId ?? null,
    // owner_gate_verdict is "auto" when no owner gate fired, else "owner_approved"
    // (we already passed the gate check above for the require_consent branch).
    ownerGateVerdict: gate.requires_consent ? "owner_approved" : "auto",
    id: input.artifactId,
  });

  // 3. Run the fixture in the artifact's declared runtime. Phase G lights up
  //    uv and camofox-browser; bun was always wired. Each runtime returns the
  //    same observation envelope shape so this dispatch is purely a router.
  let observation: {
    ok: boolean;
    result?: JsonValue;
    error?: string;
    durationMs: number;
    exitCode: number;
    stderrTail: string;
    sandboxWarnings: string[];
    irreversibleEffects: Array<{ kind: string; description: string }>;
  };
  if (input.runtime === "bun") {
    observation = await runBunArtifact({
      artifactId: row.id,
      body: input.body,
      declaredSandbox: input.declaredSandbox as Extract<SandboxDecl, { runtime: "bun" }>,
      inputs: input.fixtureInput,
      emit,
    });
  } else if (input.runtime === "uv") {
    observation = await runUvArtifact({
      artifactId: row.id,
      body: input.body,
      declaredSandbox: input.declaredSandbox as Extract<SandboxDecl, { runtime: "uv" }>,
      inputs: input.fixtureInput,
      emit,
    });
  } else {
    observation = await runCamofoxArtifact({
      artifactId: row.id,
      body: input.body,
      declaredSandbox: input.declaredSandbox as Extract<SandboxDecl, { runtime: "camofox-browser" }>,
      inputs: input.fixtureInput,
      emit,
    });
  }

  // Surface "runtime not installed" cleanly as `runtime_unavailable` so the
  // caller can treat it as a soft refusal (e.g. admit the artifact anyway,
  // run at execution time once playwright/uv are present). For Phase G we
  // KEEP the rejection: admission is a smoke test and a smoke test that
  // can't be run isn't a pass.
  if (!observation.ok && (
    observation.error === "uv_runtime_unavailable" ||
    observation.error === "camofox_runtime_unavailable"
  )) {
    db.run("DELETE FROM code_artifact WHERE id = ?", [row.id]);
    emit({
      kind: "code_artifact_admission_rejected",
      substrate_origin: "substrate_auto",
      action_artifact_id: row.id,
      payload: {
        reason: "runtime_unavailable",
        detail: observation.error,
        runtime: input.runtime,
        sandbox_warnings: observation.sandboxWarnings as unknown as JsonValue,
      } as JsonValue,
    });
    return { ok: false, reason: "runtime_unavailable", detail: observation.error };
  }

  if (!observation.ok) {
    db.run("DELETE FROM code_artifact WHERE id = ?", [row.id]);
    emit({
      kind: "code_artifact_admission_rejected",
      substrate_origin: "substrate_auto",
      action_artifact_id: row.id,
      payload: {
        reason: "runtime_error",
        detail: observation.error ?? "unknown",
        stderr_tail: observation.stderrTail,
        exit_code: observation.exitCode,
        duration_ms: observation.durationMs,
      } as JsonValue,
    });
    return { ok: false, reason: "runtime_error", detail: observation.error };
  }

  // Residual check — if the result envelope carries a numeric `residual` we
  // honour the threshold; otherwise admission passes on the strength of a
  // clean ok:true run (§11.5 admission is a smoke test, not a full verify).
  const result = observation.result;
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof (result as Record<string, unknown>).residual === "number"
  ) {
    const observedResidual = (result as { residual: number }).residual;
    if (observedResidual >= input.fixtureExpectedResidualBelow) {
      db.run("DELETE FROM code_artifact WHERE id = ?", [row.id]);
      emit({
        kind: "code_artifact_admission_rejected",
        substrate_origin: "substrate_auto",
        action_artifact_id: row.id,
        payload: {
          reason: "fixture_residual_too_high",
          observed_residual: observedResidual,
          threshold_below: input.fixtureExpectedResidualBelow,
        } as JsonValue,
      });
      return {
        ok: false,
        reason: "fixture_residual_too_high",
        detail: `observed=${observedResidual} threshold=${input.fixtureExpectedResidualBelow}`,
      };
    }
  }

  // Forward sandbox warnings so the audit trail is honest. Use the
  // canonical sandbox_unenforced_warning kind (matches the shape that
  // runtime/runtimes/bun.ts emits at fixture-run time). Pre-2026-05-17
  // these were mis-emitted as sandbox_violation — which implies a
  // RUNTIME violation occurred — and bloated health metrics with what
  // are actually honor-system advisories. Live evidence: 206/224
  // sandbox_violation events in the last 24h had phase=
  // "admission_unenforced_warning" payloads. Canonical fix: emit as
  // sandbox_unenforced_warning with the {runtime, warning} payload
  // shape so admission warnings and runtime warnings are queryable
  // through one kind.
  for (const warning of observation.sandboxWarnings) {
    emit({
      kind: "sandbox_unenforced_warning",
      substrate_origin: "substrate_auto",
      action_artifact_id: row.id,
      payload: {
        runtime: input.runtime,
        warning,
        phase: "admission",
      } as JsonValue,
    });
  }

  // Re-read in case downstream stamped any field; mostly defensive.
  const final = getArtifact(db, row.id);
  emit({
    kind: "code_artifact_admitted",
    substrate_origin: "substrate_auto",
    action_artifact_id: row.id,
    payload: {
      artifact_id: row.id,
      runtime: input.runtime,
      score: final?.score ?? ADMIT_SCORE,
      confidence: final?.confidence ?? ADMIT_CONFIDENCE,
      target_files: final?.targetFiles ?? null,
      target_resources: final?.targetResources?.map((r) => r.uri) ?? null,
    } as JsonValue,
  });
  return { ok: true, artifactId: row.id };
};
