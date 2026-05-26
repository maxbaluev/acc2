// acc2 artifact admission — gate for new code artifacts (Architecture.md).
//
// Admission protocol:
//   1. Validate the sandbox declaration shape. Bad shape → admission rejected.
//   2. Materialize a fresh act_artifact row in `admitted` state with priors
//      (alpha=1, beta=1, score=0.5, confidence=0.3) — these are the canonical
//      §11.5 admit values. We allocate the id BEFORE running the fixture so
//      the runtime invocation has a stable artifact_id to tag the events.
//   3. Run the fixture under the artifact's declared runtime. bun, uv, and
//      camofox-browser all route through `runArtifactForRuntime`; uv/camofox
//      may reject with structured `*_runtime_unavailable` when host binaries are
//      absent, but they are real runners, not Phase-G unsupported stubs.
//   4. If the fixture run is `ok: true` and the observed residual (computed
//      from the artifact's `fixtureExpectedResidual` predicate — see below)
//      falls below `fixtureExpectedResidualBelow`, admit. Otherwise emit
//      `act_artifact_admission_rejected` + remove the row.
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
import type { ArtifactInterfaceMetadata, JsonValue, Runtime, SandboxDecl } from "../substrate/types";
import { validateSandboxDecl } from "./sandbox";
import { isCodeRuntime, validateCodeArtifactAdmission } from "./code_artifact_validation";
import { priorRepairAttempts, repairSessionIdFor, requestArtifactRepair } from "./artifact_repair";
import { runArtifactForRuntime } from "./runtimes/index";
import { getArtifact, insertArtifact } from "./artifact_store";
import { ownerGateDecision } from "./owner_gate";
import { runPredicateGate } from "./verifiers/predicate_gate";
import { markSuperseded, rebaseCitationRooting, persistRebasedRooting, type RebaseRootingResult } from "./artifact_provenance";
import { partitionCitedKnowledge } from "./artifact_candidate_screen";
import { parseResourceUri } from "./resource_uri";
import type { EmitEventInput } from "./events";
import { requiresStrategicGrounding } from "../substrate/artifact_kind_metadata";
import {
  validateRenderedDocxAdmission,
  validatePublishedDriveDocAdmission,
  RENDERED_DOCX_KIND,
  PUBLISHED_DRIVE_DOC_KIND,
} from "./render_pipeline";

export type AdmissionInput = {
  /** Path A (2026-05-20, contract A0DQT211JH): non-executing data-class
   *  rows omit runtime (null/undefined). When runtime is null/undefined
   *  admission stores body+name+summary without running fixture/sandbox/
   *  owner-gate machinery. Concrete runtimes ("bun" | "uv" |
   *  "camofox-browser") run the full executable admission flow. */
  runtime: Runtime | null;
  body: string;
  declaredSandbox: SandboxDecl | null;
  fixtureInput: JsonValue | null;
  /** Threshold the fixture's residual must come in BELOW for admission to pass.
   *  Typically 0.2 per Architecture.md. Ignored when runtime is null
   *  (data-class admission skips fixture execution entirely). */
  fixtureExpectedResidualBelow: number;
  /** Optional pre-allocated id so callers (or tests) can refer to the row
   *  before the function returns. */
  artifactId?: string;
  stateRoot?: string;
  name?: string;
  /** Brain dataflow audit bxdhdkm9e #3 (2026-05-15): provenance metadata
   *  the brain emits on act_artifact_candidate but the admission path
   *  previously dropped. The fields are all OPTIONAL — legacy seed
   *  admissions that don't supply them remain valid. When supplied,
   *  they land on the act_artifact row and become readable via the
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
  /** citation_rooting_rebase_hard_gate (amendment #6): task/trajectory context
   *  used to REBASE the rooting of a zero-direct-citation full body through
   *  inherited evidence before refusing artifact_citation_underrooted. OPTIONAL
   *  — when absent the gate cannot rebase and refuses exactly as before. */
  taskId?: string | null;
  contextRefs?: string[];
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
   *  brain emits these ids on `act_artifact_candidate.cited_knowledge_ids`
   *  and the admission caller (bridge/runtime) threads them through. */
  citedKnowledgeIds?: string[];
  /** C5 (2026-05-18, contract HJJS1665H961B2SRYHC5J85D14): provenance
   *  chain. `kind` discriminates the artifact (e.g. `published_drive_doc`);
   *  `supersedes` is the prior artifact_id that this admission replaces.
   *  When both are set and kind === `published_drive_doc`, the admission
   *  emits `act_artifact_superseded` against the prior row AFTER
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
  /** UNIVERSAL_ (2026-05-24, directive 3XETJCYT, kc BD86CJ6HQS): first-
   *  class, domain-NEUTRAL interface metadata (purpose / goal_shapes /
   *  usage_examples / preconditions / effects / cost_profile /
   *  reliability_profile / inputs_schema / outputs_schema). OPTIONAL —
   *  legacy / minimal admissions that omit it remain valid (the row's
   *  interface_metadata column stays NULL). When supplied it lands on the
   *  act_artifact row and flows through getArtifact + the registry view so
   *  the selector + brain can understand/select the artifact for ANY goal
   *  (Telegram action, browser flow, calendar handle, checklist, contact,
   *  script) — not just code. Admission does NOT gate on it: it is
   *  descriptive metadata, scored downstream by residual, never a refusal
   *  surface (CLAUDE.md "do not add pre-check gates when residual can
   *  score the same thing"). */
  interfaceMetadata?: ArtifactInterfaceMetadata | null;
  /** RUNTIME_AD (2026-05-24, directive 3XETJCYT): the act-loop verifier id
   *  for this artifact. Threaded so the code-artifact admission gate can
   *  confirm a code runtime declares HOW it will be verified (a
   *  verifier_artifact_id OR an inline verifier on interface_metadata)
   *  before it runs. OPTIONAL — only consulted for the three code runtimes
   *  and only when interface_metadata is supplied (the wave-1 authored
   *  path); legacy / non-code admissions ignore it. */
  verifierArtifactId?: string | null;
  /** SANDREPAIR (2026-05-24, directive KDZVSFNPM): goal_shape the artifact
   *  serves, threaded so a failed code-artifact smoke-test can open an
   *  error-grounded repair directive that keeps the corrected candidate
   *  aimed at the SAME goal-class (selector continuity with capability_gap).
   *  OPTIONAL — when absent the repair directive omits the goal-shape line.
   *  Non-code runtimes / data-class rows ignore it. */
  goalShape?: string | null;
  /** SANDREPAIR (2026-05-24, directive KDZVSFNPM): when true, a FAILED
   *  fixture smoke-test for a CODE runtime opens a bounded, error-grounded
   *  repair loop (artifact_repair_needed → brain re-author → re-admit, capped
   *  at MAX_REPAIR_ATTEMPTS) INSTEAD of leaving the rejection terminal. The
   *  rejection event still fires (fail-closed: the artifact is NOT admitted
   *  on this run); the repair dispatch is additive. Defaults to true for code
   *  runtimes so the capability-gap → author → test → repair chain composes
   *  end-to-end; set false to preserve the legacy single-shot reject (used by
   *  callers/tests that do not want a repair dispatch). */
  enableRepair?: boolean;
  /** Bounded inline repair bodies tried in the same pre-admission sandbox
   *  loop before falling back to the external repair directive. */
  repairCandidateBodies?: string[];
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
  | "published_drive_doc_invalid_inputs"
  // Candidate B (brain dispatch SW94JRKNFD36Q7G9, 2026-05-19): an
  // unknown runtime (not bun/uv/camofox-browser) with no matching
  // runtime_runner registry row → refuse admission rather than try to
  // run the fixture in a runner that does not exist.
  | "unknown_runtime"
  // RUNTIME_AD (2026-05-24, directive 3XETJCYT): code-artifact admission
  // hardening for the three code runtimes (bun / uv / camofox-browser).
  // Authored code must be well-formed + safe BEFORE it runs — the
  // capability-gap loop now authors replacements automatically, so a
  // malformed authored artifact must be caught here, fail-closed, rather
  // than executing broken code. These mirror CodeArtifactRejectionReason
  // from runtime/code_artifact_validation.ts.
  | "code_artifact_interface_incomplete"
  | "code_artifact_schema_invalid"
  | "code_artifact_body_invalid"
  | "code_artifact_sandbox_incoherent";

export type AdmissionResult =
  | { ok: true; artifactId: string; supersedes_dropped?: boolean }
  | { ok: false; reason: AdmissionRejectionReason; detail?: string };

// Canonical admission priors per Architecture.md.
const ADMIT_ALPHA = 1.0;
const ADMIT_BETA = 1.0;
const ADMIT_SCORE = 0.5;
const ADMIT_CONFIDENCE = 0.3;

/** Run admission for a new code artifact. Inserts the row at admit priors,
 *  runs the fixture, and either confirms admission (emitting
 *  `act_artifact_admitted`) or rolls back + emits
 *  `act_artifact_admission_rejected`. */
/** Path A (2026-05-20, contract A0DQT211JH): data-class admission. Non-
 *  executing rows (raw corpus dumps, target universes, privileged AccInt
 *  files) pass runtime === null/undefined. Admission stores body+name+
 *  summary without running fixture/sandbox/owner-gate/predicate-gate
 *  machinery and emits `act_artifact_admitted` with
 *  admission_mode='data_class_nullable'. The earlier runtime="data"
 *  sentinel is deleted. */
export const admitArtifact = async (
  db: Database,
  input: AdmissionInput,
  emit: (event: EmitEventInput) => void,
): Promise<AdmissionResult> => {
  // Path A short-circuit: null/undefined runtime → data-class row.
  // Skip every executable gate (sandbox shape, owner consent, predicate
  // gate, strategy-first gate, render-pipeline lineage, fixture
  // execution). Require body+name+summary so the substrate stores
  // self-describing bytes.
  if (input.runtime === null || input.runtime === undefined) {
    if (typeof input.body !== "string" || input.body.length === 0) {
      emit({
        kind: "act_artifact_admission_rejected",
        substrate_origin: "substrate_auto",
        payload: {
          reason: "runtime_error",
          detail: "data_class_admission_requires_body",
          admission_mode: "data_class_nullable",
        } as JsonValue,
      });
      return { ok: false, reason: "runtime_error", detail: "data_class_admission_requires_body" };
    }
    if (typeof input.name !== "string" || input.name.length === 0) {
      emit({
        kind: "act_artifact_admission_rejected",
        substrate_origin: "substrate_auto",
        payload: {
          reason: "runtime_error",
          detail: "data_class_admission_requires_name",
          admission_mode: "data_class_nullable",
        } as JsonValue,
      });
      return { ok: false, reason: "runtime_error", detail: "data_class_admission_requires_name" };
    }
    if (typeof input.summary !== "string" || input.summary.length === 0) {
      emit({
        kind: "act_artifact_admission_rejected",
        substrate_origin: "substrate_auto",
        payload: {
          reason: "runtime_error",
          detail: "data_class_admission_requires_summary",
          admission_mode: "data_class_nullable",
        } as JsonValue,
      });
      return { ok: false, reason: "runtime_error", detail: "data_class_admission_requires_summary" };
    }
    const dataRow = insertArtifact(db, {
      runtime: null,
      kind: input.kind,
      body: input.body,
      declaredSandbox: null,
      stateRoot: input.stateRoot ?? null,
      posteriorAlpha: ADMIT_ALPHA,
      posteriorBeta: ADMIT_BETA,
      score: ADMIT_SCORE,
      confidence: ADMIT_CONFIDENCE,
      recentResidualMean: 0,
      recentKillCount: 0,
      status: "admitted",
      name: input.name,
      fixtureInput: null,
      fixtureExpectedResidual: null,
      intent: input.intent ?? null,
      summary: input.summary,
      targetFiles: input.targetFiles ?? null,
      targetResources: input.targetResources ?? null,
      sourceCandidateId: input.sourceCandidateId ?? null,
      ownerGateVerdict: "auto",
      supersedes: input.supersedes ?? null,
      interfaceMetadata: input.interfaceMetadata ?? null,
      id: input.artifactId,
    });
    emit({
      kind: "act_artifact_admitted",
      substrate_origin: "substrate_auto",
      action_artifact_id: dataRow.id,
      payload: {
        artifact_id: dataRow.id,
        runtime: null,
        kind: input.kind ?? "runtime_action",
        admission_mode: "data_class_nullable",
        body_length: input.body.length,
        name: input.name,
        source_candidate_id: input.sourceCandidateId ?? null,
      } as JsonValue,
    });
    if (input.supersedes) {
      try {
        markSuperseded(db, input.supersedes, dataRow.id, emit);
      } catch { /* supersede chain is best-effort for data artifacts */ }
    }
    return { ok: true, artifactId: dataRow.id };
  }

  // Executable admission path (runtime is bun/uv/camofox-browser/registry).
  if (!input.declaredSandbox) {
    emit({
      kind: "act_artifact_admission_rejected",
      substrate_origin: "substrate_auto",
      payload: {
        reason: "sandbox_decl_invalid",
        detail: "declared_sandbox_required_for_executable_runtime",
        runtime: input.runtime,
      } as JsonValue,
    });
    return { ok: false, reason: "sandbox_decl_invalid", detail: "declared_sandbox_required_for_executable_runtime" };
  }

  // 1. Sandbox shape gate.
  const v = validateSandboxDecl(input.declaredSandbox);
  if (!v.ok) {
    emit({
      kind: "act_artifact_admission_rejected",
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
      kind: "act_artifact_admission_rejected",
      substrate_origin: "substrate_auto",
      directive_id: input.governance?.directiveId,
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

  // 1.4 Code-artifact admission hardening (RUNTIME_AD, directive 3XETJCYT).
  //     Gate ONLY the three code runtimes (bun / uv / camofox-browser).
  //     Authored code must be well-formed + safe BEFORE it runs: the
  //     capability-gap loop (wave-1) now AUTHORS new code artifacts
  //     automatically, so a malformed brain-authored replacement must be
  //     caught here, fail-closed, rather than executing broken code. The
  //     gate runs BEFORE the row insert + fixture run so a rejected
  //     artifact never gets a row to roll back and never executes. Non-code
  //     runtimes (registry runtimes) and data-class rows (handled by the
  //     null-runtime short-circuit above) never reach this check.
  //
  //     Backward-compat: the interface-completeness leg fires only when
  //     interface_metadata is supplied (the wave-1 authored path); legacy
  //     executable-tool admissions that omit it admit exactly as before.
  if (isCodeRuntime(input.runtime)) {
    const codeCheck = validateCodeArtifactAdmission({
      runtime: input.runtime,
      body: input.body,
      declaredSandbox: input.declaredSandbox,
      interfaceMetadata: input.interfaceMetadata,
      verifierArtifactId: input.verifierArtifactId,
    });
    if (!codeCheck.ok) {
      emit({
        kind: "act_artifact_admission_rejected",
        substrate_origin: "substrate_auto",
        directive_id: input.governance?.directiveId,
        payload: {
          reason: codeCheck.reason,
          detail: codeCheck.detail,
          runtime: input.runtime,
          source_candidate_id: input.sourceCandidateId ?? null,
        } as JsonValue,
      });
      return { ok: false, reason: codeCheck.reason, detail: codeCheck.detail };
    }
  }

  const gate = ownerGateDecision(input.declaredSandbox);
  if (gate.requires_consent) {
    emit({
      kind: "act_artifact_admission_rejected",
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
  //
  //     F2 (2026-05-18): admission only runs the gate when an audience
  //     is explicitly declared. The emit-side screen for
  //     act_artifact_candidate handles its own audience inference;
  //     admission of action / verifier code (no audience field) is
  //     internal substrate plumbing and skips the buyer-facing gate.
  const predicateGate = input.audience
    ? runPredicateGate(db, {
        audience: input.audience,
        body: input.body,
        sourceCandidateId: input.sourceCandidateId,
      })
    : { rejected: false as const, residual: 0, matches: [] as Array<{ kc_id: string; predicate_claim: string; matched_text: string; offset: number; surrounding_context: string }>, citedKnowledgeIds: [] as string[] };
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

  // 1.6 Strategy-first gate. Originally hard-coded to the `atms_report_v*`
  //     prefix (C3, directive QHTRBV6PFX2JVBMHDNDA4B03GC); F4c
  //     (contract 897XTN2GF11XB9D4N45N2R9W58) generalised it. The gate
  //     now keys on the posterior-scored `artifact_kind_metadata` row
  //     for input.kind / input.name. When the matched row's
  //     `needs_strategic_grounding` exceeds the threshold the substrate
  //     requires at least one cited knowledge_candidate event whose
  //     payload.claim ends `_strategic_direction_chosen`. The fail-closed
  //     default — no metadata row → no enforcement — keeps brand-new
  //     artifact kinds out of the gate until owner-rejection feedback
  //     (or another posterior path) teaches the substrate they need it.
  //     The gate runs BEFORE the row insert so a rejected candidate never
  //     gets an artifact row to roll back.
  const strategicGroundingHit = requiresStrategicGrounding(db, {
    kind: input.kind ?? null,
    name: input.name ?? null,
  });
  if (strategicGroundingHit.required) {
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
          artifact_name: input.name ?? null,
          artifact_kind: input.kind ?? null,
          matched_kind: strategicGroundingHit.matched_kind,
          needs_strategic_grounding: strategicGroundingHit.needs_strategic_grounding,
          cited_knowledge_ids: (input.citedKnowledgeIds ?? []) as unknown as JsonValue,
          source_candidate_id: input.sourceCandidateId ?? null,
          missing_claim_suffix: "_strategic_direction_chosen",
          inspected_ids: strategicCitation.inspectedIds as unknown as JsonValue,
        } as JsonValue,
      });
      return {
        ok: false,
        reason: "strategy_first_violation_missing_strategic_direction_chosen",
        detail: `kind=${strategicGroundingHit.matched_kind} requires a cited knowledge_candidate with claim ending _strategic_direction_chosen; cited_count=${(input.citedKnowledgeIds ?? []).length}`,
      };
    }
  }

  // F1 decorative-citation refusal mirror (admission path, 2026-05-18).
  // Substantive candidates (audience set OR body > 200 chars) must cite
  // ≥1 knowledge id that resolves to a real events.id; label-only
  // citations break the k_555 four-link chain at the binding step.
  // Pure placeholder-kind admissions (rendered_docx / published_drive_doc
  // / markdown_body) are exempt from the underrooted refusal because
  // their bodies are structural placeholders, but unresolvable labels
  // still fire decorative_citation.
  const PLACEHOLDER_BODY_KINDS = new Set([
    "published_drive_doc",
    "rendered_docx",
    "markdown_body",
  ]);
  // 2026-05-21 executable-tool exemption. The citation-underrooted gate was
  // designed for SUBSTANTIVE KNOWLEDGE artifacts (documents, reports,
  // claims) — those must cite the knowledge that grounds the claim. But the
  // brain also admits EXECUTABLE TOOLING artifacts (diagnostic/test/patch
  // runners, e.g. t02_git_diff_runner, t02_anchor_diagnostic) to DO its
  // implementation work. A code runner is a tool, not a knowledge claim —
  // its "rooting" is the declared sandbox + verifier residual, not a
  // knowledge citation. Pre-fix, every uncited executable runner the brain
  // created during a normal implementation dispatch (T0.2) was refused with
  // artifact_citation_underrooted, storming lane_routing_refused and
  // blocking the dispatch from making progress. Executable artifacts (a
  // non-null runtime ∈ {bun, uv, camofox-browser}) are therefore exempt
  // from the knowledge-citation requirement, exactly as placeholder kinds
  // are. Knowledge artifacts (runtime: null) still must root their claims.
  const admissionIsExecutableTool = input.runtime !== null && input.runtime !== undefined;
  const admissionIsSubstantive =
    (typeof input.audience === "string" && input.audience.length > 0) ||
    (typeof input.body === "string" && input.body.length > 200);
  const admissionIsPlaceholder =
    (typeof input.kind === "string" && PLACEHOLDER_BODY_KINDS.has(input.kind)) ||
    admissionIsExecutableTool;
  // citation_rooting_rebase_hard_gate (amendment #6): when a substantive
  // zero-direct-citation full body would be refused, attempt to rebase its
  // rooting through inherited task/root/parent evidence FIRST. A resolved
  // rebase is persisted on the admitted row (effective_cited_knowledge_ids /
  // effective_grounding_refs) + emits retrieval_binding events AFTER the row
  // insert below; an unresolved rebase keeps the underrooted refusal.
  let admissionRebase: Extract<RebaseRootingResult, { ok: true }> | null = null;
  if (admissionIsSubstantive) {
    const cited = input.citedKnowledgeIds ?? [];
    const { resolved: resolvedAtAdmit, unresolved: unresolvedAtAdmit } =
      partitionCitedKnowledge(db, cited);
    if (cited.length === 0 && !admissionIsPlaceholder) {
      const rebase = rebaseCitationRooting(db, {
        taskId: input.taskId ?? null,
        directiveId: input.governance?.directiveId ?? null,
        sourceCandidateId: input.sourceCandidateId ?? null,
        contextRefs: input.contextRefs ?? [],
      });
      if (rebase.ok) {
        admissionRebase = rebase;
      } else {
        emit({
          kind: "lane_routing_refused",
          substrate_origin: "substrate_auto",
          payload: {
            reason: "artifact_citation_underrooted",
            refused_kind: "act_artifact_admission",
            artifact_kind: input.kind ?? null,
            artifact_name: input.name ?? null,
            audience: input.audience ?? null,
            body_length: typeof input.body === "string" ? input.body.length : 0,
          } as JsonValue,
        });
      }
    } else if (unresolvedAtAdmit.length > 0) {
      emit({
        kind: "lane_routing_refused",
        substrate_origin: "substrate_auto",
        payload: {
          reason: "decorative_citation",
          refused_kind: "act_artifact_admission",
          artifact_kind: input.kind ?? null,
          artifact_name: input.name ?? null,
          unresolved_labels: unresolvedAtAdmit as unknown as JsonValue,
          resolved_ids: resolvedAtAdmit as unknown as JsonValue,
        } as JsonValue,
      });
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
        kind: "act_artifact_admission_rejected",
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

  // RLM-first: the supersedes pointer is admitted on structural validity,
  // not on regex-classified directive intent. The strategic-grounding gate
  // above already requires a cited strategic-direction knowledge_candidate;
  // a verifier residual scores whether the change worked. No intent-based
  // pre-refusal of the provenance chain.
  const effectiveSupersedes: string | null | undefined = input.supersedes;

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
    // Authored executable rows are non-live until sandbox + verifier residual pass.
    status: "provisional",
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
    supersedes: effectiveSupersedes ?? null,
    interfaceMetadata: input.interfaceMetadata ?? null,
    id: input.artifactId,
  });

  // 3. Run candidate bodies inside a bounded pre-admission loop. The row
  //    remains provisional until one body passes sandbox execution and, when
  //    supplied, the verifier_artifact_id residual gate.
  type AdmissionObservation = {
    ok: boolean;
    result?: JsonValue;
    error?: string;
    durationMs: number;
    exitCode: number;
    stderrTail: string;
    sandboxWarnings: string[];
    irreversibleEffects: Array<{ kind: string; description: string }>;
  };
  type AttemptFailure = {
    reason: AdmissionRejectionReason;
    detail?: string;
    evidence: { error_output: string; observed_residual: number | null; exit_code?: number };
    body: string;
  };
  const normalizeObservation = (obs: Awaited<ReturnType<typeof runArtifactForRuntime>>): AdmissionObservation => ({
    ok: obs.ok,
    result: obs.result,
    error: obs.error,
    durationMs: obs.durationMs,
    exitCode: obs.exitCode,
    stderrTail: obs.stderrTail,
    sandboxWarnings: obs.sandboxWarnings,
    irreversibleEffects: obs.irreversibleEffects,
  });
  const residualFromResult = (result: JsonValue | undefined): number | null => {
    if (result && typeof result === "object" && !Array.isArray(result) && typeof (result as Record<string, unknown>).residual === "number") {
      return (result as { residual: number }).residual;
    }
    return null;
  };
  const observationPayload = (obs: AdmissionObservation): JsonValue => ({
    ok: obs.ok,
    result: obs.result ?? null,
    error: obs.error ?? null,
    duration_ms: obs.durationMs,
    exit_code: obs.exitCode,
    stderr_tail: obs.stderrTail,
    sandbox_warnings: obs.sandboxWarnings as unknown as JsonValue,
  });
  const repairBodies = (input.repairCandidateBodies ?? [])
    .filter((body): body is string => typeof body === "string" && body.length > 0)
    .slice(0, 3);
  const candidateBodies = [input.body, ...repairBodies];
  const attemptTrace: JsonValue[] = [];
  let observation: AdmissionObservation | null = null;
  let winningBody = input.body;
  let lastFailure: AttemptFailure | null = null;
  const repairEnabled = isCodeRuntime(input.runtime) && (input.enableRepair ?? true);
  const maybeRequestRepair = (failure: AttemptFailure): void => {
    if (!repairEnabled) return;
    requestArtifactRepair(
      db,
      {
        candidateArtifactId: row.id,
        body: failure.body,
        runtime: input.runtime as string,
        declaredSandbox: input.declaredSandbox as unknown as JsonValue,
        fixtureInput: input.fixtureInput,
        fixtureExpectedResidualBelow: input.fixtureExpectedResidualBelow,
        evidence: failure.evidence,
        originalIntent: input.intent ?? input.summary ?? null,
        goalShape: input.goalShape ?? null,
        sourceCandidateId: input.sourceCandidateId ?? null,
        directiveId: input.governance?.directiveId,
      },
      emit,
    );
  };
  const rejectWithTrace = (failure: AttemptFailure): AdmissionResult => {
    db.run("DELETE FROM act_artifact WHERE id = ?", [row.id]);
    const lastAttempt = attemptTrace.at(-1);
    const mirroredResidualFields = lastAttempt && typeof lastAttempt === "object" && !Array.isArray(lastAttempt)
      ? {
          observed_residual: (lastAttempt as Record<string, JsonValue>).observed_residual ?? null,
          verifier_residual: (lastAttempt as Record<string, JsonValue>).verifier_residual ?? null,
          residual_out_of_range: (lastAttempt as Record<string, JsonValue>).residual_out_of_range ?? null,
        }
      : { observed_residual: null, verifier_residual: null, residual_out_of_range: null };
    emit({
      kind: "act_artifact_admission_rejected",
      substrate_origin: "substrate_auto",
      directive_id: input.governance?.directiveId,
      action_artifact_id: row.id,
      payload: {
        reason: failure.reason,
        detail: failure.detail ?? null,
        runtime: input.runtime,
        source_candidate_id: input.sourceCandidateId ?? null,
        ...mirroredResidualFields,
        attempt_trace: attemptTrace,
      } as JsonValue,
    });
    if (failure.reason === "runtime_error" || failure.reason === "fixture_residual_too_high") maybeRequestRepair(failure);
    return { ok: false, reason: failure.reason, detail: failure.detail };
  };

  for (let i = 0; i < candidateBodies.length; i++) {
    const body = candidateBodies[i]!;
    const attempt = i + 1;
    const source = i === 0 ? "initial" : "inline_repair";
    db.run("UPDATE act_artifact SET body = ?, updated_at = ? WHERE id = ?", [body, new Date().toISOString(), row.id]);
    observation = normalizeObservation(await runArtifactForRuntime({
      artifactId: row.id,
      body,
      declaredSandbox: input.declaredSandbox,
      inputs: input.fixtureInput,
      emit,
      db,
    }));
    const traceEntry: Record<string, JsonValue> = {
      attempt,
      source,
      body_length: body.length,
      ok: observation.ok,
      exit_code: observation.exitCode,
      duration_ms: observation.durationMs,
      sandbox_warnings: observation.sandboxWarnings as unknown as JsonValue,
    };
    const failAttempt = (failure: AttemptFailure, terminal = false): AdmissionResult | null => {
      traceEntry.reason = failure.reason;
      traceEntry.detail = failure.detail ?? null;
      traceEntry.stderr_tail = observation?.stderrTail ?? "";
      attemptTrace.push(traceEntry as JsonValue);
      lastFailure = failure;
      return terminal || attempt === candidateBodies.length ? rejectWithTrace(failure) : null;
    };

    if (!observation.ok && (observation.error ?? "").startsWith("unknown_runtime")) {
      const result = failAttempt({
        reason: "unknown_runtime",
        detail: `no runtime_runner registry row for runtime=${input.runtime}`,
        evidence: { error_output: observation.error ?? "unknown_runtime", observed_residual: null, exit_code: observation.exitCode },
        body,
      }, true);
      if (result) return result;
    }
    if (!observation.ok && ((observation.error ?? "").startsWith("runtime_unavailable") || observation.error === "uv_runtime_unavailable" || observation.error === "camofox_runtime_unavailable")) {
      const result = failAttempt({
        reason: "runtime_unavailable",
        detail: observation.error,
        evidence: { error_output: observation.error ?? "runtime_unavailable", observed_residual: null, exit_code: observation.exitCode },
        body,
      }, true);
      if (result) return result;
    }
    if (!observation.ok) {
      const result = failAttempt({
        reason: "runtime_error",
        detail: observation.error ?? "unknown",
        evidence: { error_output: observation.stderrTail || observation.error || "runtime_error", observed_residual: null, exit_code: observation.exitCode },
        body,
      });
      if (result) return result;
      continue;
    }

    const fixtureResidual = residualFromResult(observation.result);
    if (fixtureResidual !== null) {
      const residualOutOfRange = !Number.isFinite(fixtureResidual) || fixtureResidual < 0 || fixtureResidual > 1;
      if (residualOutOfRange || fixtureResidual >= input.fixtureExpectedResidualBelow) {
        traceEntry.observed_residual = Number.isFinite(fixtureResidual) ? fixtureResidual : String(fixtureResidual);
        traceEntry.residual_out_of_range = residualOutOfRange;
        const detail = residualOutOfRange
          ? `observed=${fixtureResidual} is not a valid residual in [0,1]`
          : `observed=${fixtureResidual} threshold=${input.fixtureExpectedResidualBelow}`;
        const errorOutput = residualOutOfRange
          ? `fixture_residual_out_of_range: observed=${fixtureResidual} is not a valid residual in [0,1]`
          : `fixture_residual_too_high: observed=${fixtureResidual} must be < ${input.fixtureExpectedResidualBelow}`;
        const result = failAttempt({
          reason: "fixture_residual_too_high",
          detail,
          evidence: { error_output: errorOutput, observed_residual: Number.isFinite(fixtureResidual) ? fixtureResidual : null, exit_code: observation.exitCode },
          body,
        });
        if (result) return result;
        continue;
      }
    }

    if (typeof input.verifierArtifactId === "string" && input.verifierArtifactId.length > 0) {
      const verifier = getArtifact(db, input.verifierArtifactId);
      if (!verifier || verifier.runtime === null || verifier.declaredSandbox === null) {
        const detail = verifier ? "verifier_artifact_not_executable" : "verifier_artifact_not_found";
        const result = failAttempt({
          reason: "runtime_error",
          detail,
          evidence: { error_output: detail, observed_residual: null, exit_code: observation.exitCode },
          body,
        }, true);
        if (result) return result;
      } else {
        const verifierObs = normalizeObservation(await runArtifactForRuntime({
          artifactId: verifier.id,
          body: verifier.body,
          declaredSandbox: verifier.declaredSandbox,
          inputs: {
            candidate_artifact_id: row.id,
            candidate_result: observation.result ?? null,
            candidate_observation: observationPayload(observation),
            fixture_input: input.fixtureInput,
            attempt,
            source,
          } as JsonValue,
          emit,
          db,
        }));
        if (!verifierObs.ok) {
          traceEntry.verifier_ok = false;
          const result = failAttempt({
            reason: "runtime_error",
            detail: verifierObs.error ?? "verifier_runtime_error",
            evidence: { error_output: verifierObs.stderrTail || verifierObs.error || "verifier_runtime_error", observed_residual: null, exit_code: verifierObs.exitCode },
            body,
          });
          if (result) return result;
          continue;
        }
        const verifierResidual = residualFromResult(verifierObs.result);
        traceEntry.verifier_ok = true;
        traceEntry.verifier_residual = verifierResidual === null ? null : (Number.isFinite(verifierResidual) ? verifierResidual : String(verifierResidual));
        const residualOutOfRange = verifierResidual === null || !Number.isFinite(verifierResidual) || verifierResidual < 0 || verifierResidual > 1;
        if (residualOutOfRange || verifierResidual >= input.fixtureExpectedResidualBelow) {
          const detail = residualOutOfRange ? `verifier residual missing or invalid: ${verifierResidual}` : `verifier_residual=${verifierResidual} threshold=${input.fixtureExpectedResidualBelow}`;
          const errorOutput = residualOutOfRange ? `verifier_residual_invalid:${verifierResidual}` : `verifier_residual_too_high: observed=${verifierResidual} must be < ${input.fixtureExpectedResidualBelow}`;
          const result = failAttempt({
            reason: "fixture_residual_too_high",
            detail,
            evidence: { error_output: errorOutput, observed_residual: verifierResidual !== null && Number.isFinite(verifierResidual) ? verifierResidual : null, exit_code: verifierObs.exitCode },
            body,
          });
          if (result) return result;
          continue;
        }
      }
    }

    traceEntry.reason = null;
    traceEntry.detail = null;
    attemptTrace.push(traceEntry as JsonValue);
    winningBody = body;
    db.run("UPDATE act_artifact SET body = ?, status = 'admitted', updated_at = ? WHERE id = ?", [winningBody, new Date().toISOString(), row.id]);
    break;
  }

  if (!observation || getArtifact(db, row.id)?.status === "provisional") {
    return rejectWithTrace(lastFailure ?? {
      reason: "runtime_error",
      detail: "no_candidate_attempts_ran",
      evidence: { error_output: "no_candidate_attempts_ran", observed_residual: null },
      body: input.body,
    });
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
  if (input.kind === "published_drive_doc" && effectiveSupersedes) {
    markSuperseded(
      db,
      effectiveSupersedes,
      row.id,
      emit,
      strategicGroundingHit.required ? { residual: 0 } : undefined,
    );
  }

  const citedKnowledgeIds = input.citedKnowledgeIds ?? [];
  const repairSessionId = repairSessionIdFor({
    sourceCandidateId: input.sourceCandidateId ?? null,
    candidateArtifactId: row.id,
    body: input.body,
  });
  const repairAttempts = priorRepairAttempts(db, repairSessionId);
  if (citedKnowledgeIds.length > 0 || repairAttempts > 0) {
    emit({
      kind: "knowledge_candidate",
      substrate_origin: "substrate_auto",
      directive_id: input.governance?.directiveId,
      action_artifact_id: row.id,
      context_refs: citedKnowledgeIds,
      payload: {
        claim: `Artifact ${row.id} was admitted after ${repairAttempts} repair attempt(s) and ${citedKnowledgeIds.length} cited knowledge item(s); successful authoring patterns should cite retrieved knowledge and preserve repair deltas for future artifact authors.`,
        evidence: [`artifact_id=${row.id}`, `runtime=${input.runtime}`, `repair_attempts=${repairAttempts}`, `cited_knowledge_count=${citedKnowledgeIds.length}`],
        implications: ["Future artifact authoring prompts can retrieve this row as evidence that cited guidance and repair deltas produced an admitted artifact."],
        applies_to: ["artifact_authoring", "artifact_repair", input.runtime ?? "data_class"],
        confidence_estimate: 0.7,
        source_files: ["runtime/artifact_admission.ts"],
        artifact_feedback: {
          artifact_id: row.id,
          runtime: input.runtime,
          source_candidate_id: input.sourceCandidateId ?? null,
          cited_knowledge_ids: citedKnowledgeIds,
          repair_session_id: repairSessionId,
          repair_attempts: repairAttempts,
          goal_shape: input.goalShape ?? null,
        },
      } as JsonValue,
    });
  }
  if (repairAttempts > 0) {
    emit({
      kind: "lesson_extracted",
      substrate_origin: "substrate_auto",
      directive_id: input.governance?.directiveId,
      action_artifact_id: row.id,
      context_refs: citedKnowledgeIds,
      payload: {
        lesson_kind: "artifact_repair_delta",
        summary: `A repaired artifact candidate was admitted after ${repairAttempts} failed pre-admission attempt(s); keep concrete sandbox error evidence plus cited authoring guidance in repair prompts.`,
        evidence_event_ids: citedKnowledgeIds,
        applies_to: ["artifact_repair", input.runtime ?? "runtime"],
        repair_session_id: repairSessionId,
        artifact_id: row.id,
        repair_attempts: repairAttempts,
      } as JsonValue,
    });
  }

  // Re-read in case downstream stamped any field; mostly defensive.
  const final = getArtifact(db, row.id);
  emit({
    kind: "act_artifact_admitted",
    substrate_origin: "substrate_auto",
    action_artifact_id: row.id,
    payload: {
      artifact_id: row.id,
      runtime: input.runtime,
      score: final?.score ?? ADMIT_SCORE,
      confidence: final?.confidence ?? ADMIT_CONFIDENCE,
      target_files: final?.targetFiles ?? null,
      target_resources: final?.targetResources?.map((r) => r.uri) ?? null,
      attempt_trace: attemptTrace,
      verifier_artifact_id: input.verifierArtifactId ?? null,
    } as JsonValue,
  });
  // citation_rooting_rebase_hard_gate (amendment #6): persist the rebased
  // rooting on the now-admitted row + emit retrieval_binding for each resolved
  // inherited root so the four-link credit chain closes. Best-effort: the
  // artifact is already admitted; binding credit is additive, never a gate.
  if (admissionRebase) {
    try {
      persistRebasedRooting(
        db,
        {
          artifactId: row.id,
          rebase: admissionRebase,
          directiveId: input.governance?.directiveId ?? null,
          taskId: input.taskId ?? null,
          bindingSurface: "artifact_admission",
        },
        emit,
      );
    } catch { /* fail-soft: admission already succeeded */ }
  }

  // Composition closure (directive KDZVSFNPM): if this admission serves a
  // goal_shape that had an OPEN proactive capability gap, resolve it — the
  // organism BUILT the missing capability (proactive gap → author → SANDREPAIR
  // → admission → resolve), so the next selection finds a good fit. Best-
  // effort + idempotent; a missing goal_shape simply skips.
  if (input.goalShape) {
    try {
      // Lazy require avoids a static import cycle (capability_gap → artifact_store).
      const { resolveProactiveGap } = require("./capability_gap") as typeof import("./capability_gap");
      resolveProactiveGap(db, input.goalShape, row.id, emit);
    } catch { /* non-fatal — admission already succeeded */ }
  }
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
