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
import { getArtifact, insertArtifact } from "./artifact_store";
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
};

export type AdmissionRejectionReason =
  | "sandbox_decl_invalid"
  | "fixture_residual_too_high"
  | "runtime_error"
  | "phase_g_runtime_unsupported";

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

  // 2. Phase G runtimes are not yet implemented. Refuse cleanly.
  if (input.runtime !== "bun") {
    emit({
      kind: "code_artifact_admission_rejected",
      substrate_origin: "substrate_auto",
      payload: {
        reason: "phase_g_runtime_unsupported",
        runtime: input.runtime,
      } as JsonValue,
    });
    return { ok: false, reason: "phase_g_runtime_unsupported", detail: input.runtime };
  }

  // 3. Insert at admit priors. We do this BEFORE running the fixture so the
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
    id: input.artifactId,
  });

  // 4. Run the fixture in the bun runtime.
  const observation = await runBunArtifact({
    artifactId: row.id,
    body: input.body,
    declaredSandbox: input.declaredSandbox as Extract<SandboxDecl, { runtime: "bun" }>,
    inputs: input.fixtureInput,
    emit,
  });

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

  // Forward sandbox warnings so the audit trail is honest.
  for (const warning of observation.sandboxWarnings) {
    emit({
      kind: "sandbox_violation",
      substrate_origin: "substrate_auto",
      action_artifact_id: row.id,
      payload: {
        phase: "admission_unenforced_warning",
        warning,
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
    } as JsonValue,
  });
  return { ok: true, artifactId: row.id };
};
