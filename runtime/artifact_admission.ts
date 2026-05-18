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
import { runPredicateGate } from "./verifiers/predicate_gate";
import { markSuperseded } from "./artifact_provenance";
import { parseResourceUri } from "./resource_uri";
import type { EmitEventInput } from "./events";
import {
  validateRenderedDocxAdmission,
  validatePublishedDriveDocAdmission,
  RENDERED_DOCX_KIND,
  PUBLISHED_DRIVE_DOC_KIND,
} from "./render_pipeline";

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
  /** Predicate-gate audience tag (C1, 2026-05-18). When set to
   *  `ceo_buyer` or `external_executive`, the substrate runs
   *  alex_predicate_* knowledge_candidates against `body` BEFORE
   *  inserting the row; any match emits `predicate_gate_rejected` and
   *  refuses admission. Other audiences (or undefined) skip the gate. */
  audience?: string;
  /** Strategy-first gate input (C3, 2026-05-18, directive
   *  QHTRBV6PFX2JVBMHDNDA4B03GC). When `name` starts with `atms_report_v`,
   *  the substrate requires at least one cited knowledge_candidate event
   *  whose payload.claim ends with `_strategic_direction_chosen`. The
   *  brain emits these ids on `code_artifact_candidate.cited_knowledge_ids`
   *  and the admission caller (bridge/runtime) threads them through. */
  citedKnowledgeIds?: string[];
  /** C5 (2026-05-18, contract HJJS1665H961B2SRYHC5J85D14): provenance
   *  chain. `kind` discriminates the artifact (e.g. `published_drive_doc`);
   *  `supersedes` is the prior artifact_id that this admission replaces.
   *  When both are set and kind === `published_drive_doc`, the admission
   *  emits `code_artifact_superseded` against the prior row AFTER
   *  successful row insert. Non-destructive: the external Drive doc is
   *  not trashed — only the substrate marks the prior superseded. */
  kind?: string;
  supersedes?: string;
  /** C2 (2026-05-18, contract V32YTK7HKN6MS38KWJY1SKTXAW): render
   *  pipeline lineage. When `kind === 'rendered_docx'` BOTH fields are
   *  required and must resolve to admitted artifacts of the correct
   *  kinds (markdown_body + docx_reference_style). When
   *  `kind === 'published_drive_doc'` `renderedDocxId` is required and
   *  must resolve to an admitted `rendered_docx` row (preview-first
   *  rule, lesson NA80J19NTD4Y). */
  markdownBodyId?: string;
  referenceDocxArtifactId?: string;
  renderedDocxId?: string;
};

export type AdmissionRejectionReason =
  | "sandbox_decl_invalid"
  | "fixture_residual_too_high"
  | "runtime_error"
  | "runtime_unavailable"
  | "predicate_gate_failed"
  | "strategy_first_violation_missing_strategic_direction_chosen"
  | "published_drive_doc_missing_drive_uri"
  // C2 (2026-05-18, contract V32YTK7HKN6MS38KWJY1SKTXAW): render
  // pipeline admission rejections. The free-string reason field below
  // mirrors the reasons returned by render_pipeline.ts validators so
  // the substrate event payload + AdmissionResult.reason agree.
  | "rendered_docx_invalid_inputs"
  | "published_drive_doc_invalid_inputs";

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

  // 1.5 Predicate gate (C1, 2026-05-18). Runs alex_predicate_*
  //     knowledge_candidates against `body` when audience is
  //     ceo_buyer or external_executive. Closes the advisory failure
  //     mode (k_252) where brain self-scan reported "zero hits" while
  //     banned phrases remained. The gate is BEFORE the row insert so
  //     a rejected candidate never gets an artifact row to roll back.
  const predicateGate = runPredicateGate(db, {
    audience: input.audience,
    body: input.body,
    sourceCandidateId: input.sourceCandidateId,
  });
  if (predicateGate.rejected) {
    emit({
      kind: "predicate_gate_rejected",
      substrate_origin: "substrate_auto",
      payload: {
        reason: "predicate_gate_failed",
        audience: input.audience,
        source_candidate_id: input.sourceCandidateId ?? null,
        match_count: predicateGate.matches.length,
        matches: predicateGate.matches as unknown as JsonValue,
        cited_knowledge_ids: predicateGate.citedKnowledgeIds as unknown as JsonValue,
        residual: predicateGate.residual,
      } as JsonValue,
    });
    return {
      ok: false,
      reason: "predicate_gate_failed",
      detail: `predicate_gate_matches=${predicateGate.matches.length}`,
    };
  }

  // 1.6 Strategy-first gate (C3, 2026-05-18, directive QHTRBV6PFX2JVBMHDNDA4B03GC).
  //     Any artifact whose name starts with `atms_report_v` MUST cite at
  //     least one knowledge_candidate event whose payload.claim ends
  //     `_strategic_direction_chosen`. Closes the failure mode where
  //     report v1-v3 picked initiatives from substrate priors (NFPA
  //     traceability + demand forecasting + visual QC) without first
  //     synthesising a strategic direction (lesson
  //     4JGQAN7NFH1XH9M4VARB4RNJ8M `strategic_first_then_initiatives_lesson`).
  //     The gate is BEFORE the row insert so a rejected candidate never
  //     gets an artifact row to roll back. The strategy-citation discovery
  //     uses event ledger lookup, not hand-rolled English keyword regex —
  //     the substrate is the source of truth for what counts as a
  //     strategic direction.
  if (typeof input.name === "string" && input.name.startsWith("atms_report_v")) {
    const strategicCitation = findStrategicDirectionCitation(
      db,
      input.citedKnowledgeIds ?? [],
    );
    if (!strategicCitation.ok) {
      emit({
        kind: "atms_strategy_first_violation",
        substrate_origin: "substrate_auto",
        payload: {
          reason: "strategy_first_violation_missing_strategic_direction_chosen",
          artifact_name: input.name,
          cited_knowledge_ids: (input.citedKnowledgeIds ?? []) as unknown as JsonValue,
          source_candidate_id: input.sourceCandidateId ?? null,
          missing_claim_suffix: "_strategic_direction_chosen",
          inspected_ids: strategicCitation.inspectedIds as unknown as JsonValue,
        } as JsonValue,
      });
      return {
        ok: false,
        reason: "strategy_first_violation_missing_strategic_direction_chosen",
        detail: `atms_report_v* admission requires a cited knowledge_candidate with claim ending _strategic_direction_chosen; cited_count=${(input.citedKnowledgeIds ?? []).length}`,
      };
    }
  }

  // 1.7 published_drive_doc gate (C5, 2026-05-18, contract
  //     HJJS1665H961B2SRYHC5J85D14). When kind === `published_drive_doc`
  //     the target_resources MUST carry at least one canonical Drive doc
  //     URI (`drive://document/<doc_id>`). Refusing here keeps the chain
  //     authoritative — every published_drive_doc row reliably names the
  //     external resource it represents.
  if (input.kind === "published_drive_doc") {
    const driveUri = (input.targetResources ?? []).find((uri) => {
      const parsed = parseResourceUri(uri);
      return parsed?.scheme === "drive";
    });
    if (!driveUri) {
      emit({
        kind: "code_artifact_admission_rejected",
        substrate_origin: "substrate_auto",
        payload: {
          reason: "published_drive_doc_missing_drive_uri",
          detail: "published_drive_doc admission requires target_resources to include a drive://document/<doc_id> URI",
          target_resources: (input.targetResources ?? []) as unknown as JsonValue,
          runtime: input.runtime,
        } as JsonValue,
      });
      return {
        ok: false,
        reason: "published_drive_doc_missing_drive_uri",
        detail: "target_resources missing drive://document/<doc_id>",
      };
    }
  }

  // 1.8 rendered_docx gate (C2, 2026-05-18, contract
  //     V32YTK7HKN6MS38KWJY1SKTXAW). When kind === `rendered_docx` BOTH
  //     `markdownBodyId` and `referenceDocxArtifactId` must point at
  //     admitted artifacts of the correct kinds. The render pipeline
  //     refuses to admit a rendered_docx whose lineage cannot be
  //     resolved — preserves the same-substrate invariant (k_200) that
  //     every transform's inputs are addressable.
  if (input.kind === RENDERED_DOCX_KIND) {
    const renderedCheck = validateRenderedDocxAdmission(db, {
      markdownBodyId: input.markdownBodyId,
      referenceDocxArtifactId: input.referenceDocxArtifactId,
    });
    if (!renderedCheck.ok) {
      emit({
        kind: "rendered_docx_invalid_inputs",
        substrate_origin: "substrate_auto",
        payload: {
          reason: renderedCheck.reason,
          detail: renderedCheck.detail,
          markdown_body_id: input.markdownBodyId ?? null,
          reference_docx_artifact_id: input.referenceDocxArtifactId ?? null,
          runtime: input.runtime,
        } as JsonValue,
      });
      return {
        ok: false,
        reason: "rendered_docx_invalid_inputs",
        detail: `${renderedCheck.reason}: ${renderedCheck.detail}`,
      };
    }
  }

  // 1.9 published_drive_doc preview-first gate (C2, 2026-05-18,
  //     contract V32YTK7HKN6MS38KWJY1SKTXAW). Layered on top of the C5
  //     drive:// URI gate above. Refuses admission when the payload
  //     does not name a rendered_docx ancestor (preview-first rule,
  //     lesson NA80J19NTD4Y) OR when any target_resources entry
  //     advertises application/pdf in the Alex-facing path
  //     (k_FMAFQVA0DH no-PDF rule).
  if (input.kind === PUBLISHED_DRIVE_DOC_KIND) {
    const publishCheck = validatePublishedDriveDocAdmission(
      db,
      { renderedDocxId: input.renderedDocxId },
      input.targetResources ?? null,
    );
    if (!publishCheck.ok) {
      emit({
        kind: "published_drive_doc_invalid_inputs",
        substrate_origin: "substrate_auto",
        payload: {
          reason: publishCheck.reason,
          detail: publishCheck.detail,
          rendered_docx_id: input.renderedDocxId ?? null,
          target_resources: (input.targetResources ?? []) as unknown as JsonValue,
          runtime: input.runtime,
        } as JsonValue,
      });
      return {
        ok: false,
        reason: "published_drive_doc_invalid_inputs",
        detail: `${publishCheck.reason}: ${publishCheck.detail}`,
      };
    }
  }

  // 2. Insert at admit priors. We do this BEFORE running the fixture so the
  //    artifact_id is stable across the artifact_invoked / artifact_observed
  //    events; if the fixture fails we DELETE the row in the rejection branch.
  const row = insertArtifact(db, {
    runtime: input.runtime,
    kind: input.kind,
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
    supersedes: input.supersedes ?? null,
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

  // C5 (2026-05-18) provenance hook: when a published_drive_doc admission
  // succeeds AND the caller declared `supersedes`, flip the prior row's
  // `superseded_by` to point at this new artifact. Non-destructive — the
  // external Drive doc is not trashed, only the substrate marks the
  // chain. `markSuperseded` is idempotent on repeat calls with the same
  // pair, so retrying admission for any reason does not duplicate the
  // event row.
  if (input.kind === "published_drive_doc" && input.supersedes) {
    markSuperseded(db, input.supersedes, row.id, emit);
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

/** C3 strategy-first citation lookup. Returns ok:true when at least one
 *  cited_knowledge_id resolves to a knowledge_candidate event whose
 *  payload.claim ends with `_strategic_direction_chosen`. Exported for
 *  reuse by the closure-audit predicate so admission and closure agree
 *  on what "strategic direction chosen" means. */
export const STRATEGIC_DIRECTION_CHOSEN_SUFFIX = "_strategic_direction_chosen";

export const findStrategicDirectionCitation = (
  db: Database,
  citedKnowledgeIds: readonly string[],
): { ok: boolean; matchedId?: string; inspectedIds: string[] } => {
  const inspected: string[] = [];
  if (citedKnowledgeIds.length === 0) return { ok: false, inspectedIds: inspected };
  // Resolve each cited id to its knowledge_candidate event and inspect
  // payload.claim. Pre-2026-05-18: nothing enforced this — admission
  // happily accepted reports that cited zero knowledge events.
  for (const id of citedKnowledgeIds) {
    if (typeof id !== "string" || id.length === 0) continue;
    inspected.push(id);
    const row = db
      .query<{ payload: string; kind: string }, [string]>(
        "SELECT kind, payload FROM events WHERE id = ? LIMIT 1",
      )
      .get(id);
    if (!row) continue;
    if (row.kind !== "knowledge_candidate" && row.kind !== "knowledge_synthesized") continue;
    let payload: { claim?: unknown };
    try { payload = JSON.parse(row.payload ?? "{}"); }
    catch { continue; }
    if (typeof payload.claim !== "string") continue;
    if (payload.claim.trim().endsWith(STRATEGIC_DIRECTION_CHOSEN_SUFFIX)) {
      return { ok: true, matchedId: id, inspectedIds: inspected };
    }
  }
  return { ok: false, inspectedIds: inspected };
};
