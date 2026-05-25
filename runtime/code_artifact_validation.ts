// acc2 code-artifact admission hardening (RUNTIME_AD, directive 3XETJCYT).
//
// The wave-1 capability-gap loop now AUTHORS new executable artifacts
// automatically (runtime/capability_gap.ts → brain emits an
// act_artifact_candidate → substrate.admit_artifact). That closes the
// offensive half of the artifact lifecycle, but it also means a
// brain-authored artifact can flow into the runtime UNCHECKED: if the
// authored code is missing its interface (no inputs/outputs schema, no
// verifier), declares a malformed schema, ships an empty body, or omits
// its sandbox, the runtime would happily execute it. This module is the
// fail-closed admission gate for the THREE code runtimes (bun / uv /
// camofox-browser): it validates that authored code is well-formed + safe
// BEFORE it runs.
//
// ── Scope (gate ONLY on code runtimes) ──────────────────────────────
//
// These validators apply EXCLUSIVELY to the executable code runtimes
// resolved by runtime/runtimes/index.ts:
//   - bun            (TypeScript/JS body)
//   - uv             (Python body)
//   - camofox-browser(browser-flow body)
// Non-code artifacts (telegram / gdrive / data-class rows with
// runtime=null, registry runtimes, document placeholders) are
// UNAFFECTED — admitArtifact only invokes this gate when the runtime is
// one of the three concrete code runtimes. This honours the
// "add capability vocabulary by admitting rows, not enums" invariant:
// the gate keys on the structural runtime, never on an open kind enum.
//
// ── Backward-compat ─────────────────────────────────────────────────
//
// The INTERFACE-COMPLETENESS check (inputs_schema / outputs_schema /
// verifier) fires ONLY when interface_metadata is SUPPLIED on the
// admission. Legacy / internal admissions that omit interface_metadata
// entirely (the historical executable-tool path, e.g. a one-shot
// diagnostic runner) keep admitting exactly as before — the metadata is
// descriptive, and absence is the legacy signal. When the brain DOES
// author a code artifact WITH an interface descriptor (the wave-1 path),
// that descriptor must be COMPLETE and well-formed, or admission is
// refused fail-closed. The SCHEMA-VALIDITY and SANDBOX-COHERENCE checks
// run whenever the relevant field is present, so a malformed schema is
// caught even on a partial descriptor.

import type {
  ArtifactInterfaceMetadata,
  JsonValue,
  Runtime,
  SandboxDecl,
} from "../substrate/types";

/** The three concrete code runtimes this gate applies to. Registry
 *  runtimes and runtime=null data-class rows are NOT code-runtime
 *  artifacts and are never validated here. */
export const CODE_RUNTIMES = new Set<string>(["bun", "uv", "camofox-browser"]);

export const isCodeRuntime = (runtime: Runtime | null | undefined): boolean =>
  typeof runtime === "string" && CODE_RUNTIMES.has(runtime);

/** Typed rejection reasons emitted when a code artifact fails admission
 *  hardening. Each maps 1:1 to a fail-closed refusal so the event payload,
 *  the AdmissionResult, and the test assertions all agree on the cause. */
export type CodeArtifactRejectionReason =
  | "code_artifact_interface_incomplete"
  | "code_artifact_schema_invalid"
  | "code_artifact_body_invalid"
  | "code_artifact_sandbox_incoherent";

export type CodeArtifactValidationResult =
  | { ok: true }
  | { ok: false; reason: CodeArtifactRejectionReason; detail: string };

const ok: CodeArtifactValidationResult = { ok: true };

const reject = (
  reason: CodeArtifactRejectionReason,
  detail: string,
): CodeArtifactValidationResult => ({ ok: false, reason, detail });

// ── Schema validity ─────────────────────────────────────────────────
//
// inputs_schema / outputs_schema are open-ended JSON (JSON-Schema-like OR
// prose) per ArtifactInterfaceMetadata — they are NOT a code type. We do
// NOT impose a closed JSON-Schema dialect (that would contradict the
// "no fixed enums" invariant). We DO require structural well-formedness:
//   - the value must be a non-null JSON object or a non-empty string
//     (prose schema). null / array / empty-string / number / boolean are
//     malformed because none of them describe a shape.
//   - if the object looks JSON-Schema-like (declares a `type` or a
//     `properties` field), those fields must themselves be well-formed:
//     `type` is a non-empty string or array of strings; `properties` is a
//     plain object. This catches the common authored-code mistake of a
//     `{ "type": 123 }` or `{ "properties": [] }` without forcing a full
//     JSON-Schema validator.

const isPlainObject = (v: JsonValue): v is Record<string, JsonValue> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const validateSchemaValue = (
  field: "inputs_schema" | "outputs_schema",
  value: JsonValue | undefined,
): CodeArtifactValidationResult => {
  if (value === undefined || value === null) {
    return reject(
      "code_artifact_schema_invalid",
      `${field} is null/absent — a code artifact must declare a parseable ${field}`,
    );
  }
  // Prose schema: a non-empty string is acceptable (open-ended).
  if (typeof value === "string") {
    return value.trim().length > 0
      ? ok
      : reject("code_artifact_schema_invalid", `${field} is an empty string`);
  }
  // Structured schema: must be a plain object describing a shape.
  if (!isPlainObject(value)) {
    return reject(
      "code_artifact_schema_invalid",
      `${field} must be a JSON object or a non-empty prose string, got ${
        Array.isArray(value) ? "array" : typeof value
      }`,
    );
  }
  if (Object.keys(value).length === 0) {
    return reject(
      "code_artifact_schema_invalid",
      `${field} is an empty object — declares no shape`,
    );
  }
  // If it looks JSON-Schema-like, the structural fields must be sane.
  if ("type" in value) {
    const t = value.type;
    const typeOk =
      (typeof t === "string" && t.length > 0) ||
      (Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === "string" && x.length > 0));
    if (!typeOk) {
      return reject(
        "code_artifact_schema_invalid",
        `${field}.type is malformed — must be a non-empty string or array of strings`,
      );
    }
  }
  if ("properties" in value && !isPlainObject(value.properties as JsonValue)) {
    return reject(
      "code_artifact_schema_invalid",
      `${field}.properties must be a JSON object`,
    );
  }
  return ok;
};

// ── Runtime-specific body sanity (static / structural — NEVER executes) ─
//
// We must NOT run the code to validate it (that's the fixture-run step in
// artifact_admission.ts). We do cheap static/structural checks only:
//   - bun / uv: the body must be present + non-empty + non-whitespace, and
//     declare an entry — i.e. it must actually contain code, not be a
//     comment-only / blank stub that would no-op at runtime.
//   - camofox-browser: the body must be a well-formed browser-flow step
//     list. The camofox wrapper drives a `session` facade
//     (goto/fill/click/text/screenshot) — a flow that references NONE of
//     those session operations is not a browser flow at all. We accept
//     either a JSON step-array body OR an imperative body that invokes at
//     least one `session.<op>` call (matching how the seed flows are
//     authored).

const CAMOFOX_SESSION_OPS = ["goto", "fill", "click", "text", "url", "screenshot", "page"];

/** Strip line + block comments and whitespace to test whether a body has
 *  any executable substance. Conservative: we only need to know the body
 *  is NOT comment/blank-only. */
const stripCommentsAndWhitespace = (body: string): string =>
  body
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1") // line comments (avoid :// in URLs)
    .replace(/#[^\n]*/g, "") // python / shell comments
    .replace(/\s+/g, "")
    .trim();

const validateCodeBody = (
  runtime: Runtime,
  body: string,
): CodeArtifactValidationResult => {
  if (typeof body !== "string" || body.trim().length === 0) {
    return reject(
      "code_artifact_body_invalid",
      `${runtime} artifact body is empty — nothing to run`,
    );
  }
  if (runtime === "camofox-browser") {
    // A browser flow must either be a JSON step list or reference at least
    // one session operation. Try JSON-step-array first.
    const trimmed = body.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.length > 0) return ok;
        return reject(
          "code_artifact_body_invalid",
          "camofox-browser step list parsed but is empty",
        );
      } catch (err) {
        return reject(
          "code_artifact_body_invalid",
          `camofox-browser body opens like a step list but is not valid JSON: ${(err as Error).message}`,
        );
      }
    }
    // Imperative flow: must invoke at least one session.<op>.
    const referencesSession = CAMOFOX_SESSION_OPS.some((op) =>
      body.includes(`session.${op}`),
    );
    if (!referencesSession) {
      return reject(
        "code_artifact_body_invalid",
        `camofox-browser body is not a well-formed browser flow — it references no session operation (${CAMOFOX_SESSION_OPS.join("/")})`,
      );
    }
    return ok;
  }
  // bun / uv: body must contain executable substance (not comment-only).
  const substance = stripCommentsAndWhitespace(body);
  if (substance.length === 0) {
    return reject(
      "code_artifact_body_invalid",
      `${runtime} artifact body has no executable statements (comment/whitespace only)`,
    );
  }
  return ok;
};

// ── Sandbox coherence ───────────────────────────────────────────────
//
// The sandbox SHAPE is already validated upstream (validateSandboxDecl).
// Here we add a cheap COHERENCE check that is specific to the code
// runtime: a camofox-browser flow that navigates to a URL must declare at
// least one allowed domain (otherwise page.route blocks every request and
// the flow can never reach its target). This is the only coherence rule
// that is cheaply + statically detectable; everything else is scored by
// residual downstream, not pre-gated.

const validateSandboxCoherence = (
  runtime: Runtime,
  body: string,
  sandbox: SandboxDecl,
): CodeArtifactValidationResult => {
  if (runtime === "camofox-browser") {
    const decl = sandbox as { browser_allow_domains?: unknown };
    const navigates = body.includes("session.goto") || /https?:\/\//.test(body);
    const allow = Array.isArray(decl.browser_allow_domains)
      ? decl.browser_allow_domains
      : [];
    if (navigates && allow.length === 0) {
      return reject(
        "code_artifact_sandbox_incoherent",
        "camofox-browser flow navigates to a URL but declares browser_allow_domains: [] — page.route would block every request",
      );
    }
  }
  return ok;
};

// ── Interface completeness ──────────────────────────────────────────
//
// When interface_metadata IS supplied for a code runtime (the wave-1
// authored path), it must carry the fields the substrate needs to RUN +
// VERIFY the artifact:
//   - inputs_schema  — the shape of the inputs the code accepts
//   - outputs_schema — the shape of the observation it returns
//   - a verifier     — a verifier_artifact_id OR an inline verifier
//                      (interface_metadata.verifier_artifact_id, when the
//                      brain inlines it on the descriptor) so the act loop
//                      can score whether the run succeeded.
// Missing any required field → reject with WHICH field is missing.

export type CodeArtifactInterfaceInput = {
  runtime: Runtime;
  body: string;
  declaredSandbox: SandboxDecl | null;
  interfaceMetadata: ArtifactInterfaceMetadata | null | undefined;
  /** The act-loop verifier id threaded from the admission caller
   *  (substrate.admit_artifact → action_predicted carries
   *  verifier_artifact_id). When absent, an inline verifier on
   *  interface_metadata satisfies the requirement. */
  verifierArtifactId?: string | null;
};

const hasVerifier = (
  input: CodeArtifactInterfaceInput,
): boolean => {
  if (typeof input.verifierArtifactId === "string" && input.verifierArtifactId.length > 0) {
    return true;
  }
  // Inline verifier declared on the interface descriptor. The descriptor is
  // open-ended, so the brain may carry an inline verifier under either
  // `verifier_artifact_id` (a reference) or `verifier` (an inline body /
  // descriptor). Either presence satisfies the requirement.
  const meta = input.interfaceMetadata as
    | (ArtifactInterfaceMetadata & { verifier_artifact_id?: unknown; verifier?: unknown })
    | null
    | undefined;
  if (!meta) return false;
  if (typeof meta.verifier_artifact_id === "string" && meta.verifier_artifact_id.length > 0) {
    return true;
  }
  if (meta.verifier !== undefined && meta.verifier !== null) return true;
  return false;
};

/** Validate that a code artifact declares the interface fields needed to
 *  run + verify. Fires ONLY when interface_metadata is supplied (legacy
 *  no-metadata admissions are exempt, preserving backward-compat). */
const validateInterfaceCompleteness = (
  input: CodeArtifactInterfaceInput,
): CodeArtifactValidationResult => {
  const meta = input.interfaceMetadata;
  // Backward-compat: no descriptor → legacy executable-tool path admits.
  if (meta === null || meta === undefined) return ok;

  const missing: string[] = [];
  if (meta.inputs_schema === undefined || meta.inputs_schema === null) {
    missing.push("inputs_schema");
  }
  if (meta.outputs_schema === undefined || meta.outputs_schema === null) {
    missing.push("outputs_schema");
  }
  if (!hasVerifier(input)) {
    missing.push("verifier_artifact_id (or an inline interface_metadata.verifier)");
  }
  if (missing.length > 0) {
    return reject(
      "code_artifact_interface_incomplete",
      `code artifact declares interface_metadata but is missing required interface field(s): ${missing.join(", ")}`,
    );
  }
  // Both schemas present — validate they are well-formed.
  const inputsCheck = validateSchemaValue("inputs_schema", meta.inputs_schema);
  if (!inputsCheck.ok) return inputsCheck;
  const outputsCheck = validateSchemaValue("outputs_schema", meta.outputs_schema);
  if (!outputsCheck.ok) return outputsCheck;
  return ok;
};

// ── Public entry — the single code-artifact admission gate ──────────

export type ValidateCodeArtifactInput = CodeArtifactInterfaceInput;

/** Run ALL code-artifact admission hardening checks in fail-closed order:
 *    1. sandbox present + coherent (the SHAPE is validated upstream; here
 *       we add runtime-specific coherence).
 *    2. body present + structurally well-formed for the runtime.
 *    3. interface completeness (only when interface_metadata is supplied).
 *    4. schema validity (when schemas are present).
 *  Returns the FIRST failure (so the rejection names the specific cause)
 *  or { ok: true }. The caller (admitArtifact) only invokes this for code
 *  runtimes, so non-code artifacts never reach here. */
export const validateCodeArtifactAdmission = (
  input: ValidateCodeArtifactInput,
): CodeArtifactValidationResult => {
  // Sandbox must be present — code cannot run sandbox-less. (admitArtifact
  // already refuses a null declaredSandbox for executable runtimes; this is
  // a defensive re-check so the validator is correct standalone + testable.)
  if (!input.declaredSandbox) {
    return reject(
      "code_artifact_sandbox_incoherent",
      `${input.runtime} code artifact declares no sandbox policy`,
    );
  }
  const bodyCheck = validateCodeBody(input.runtime, input.body);
  if (!bodyCheck.ok) return bodyCheck;

  const coherenceCheck = validateSandboxCoherence(
    input.runtime,
    input.body,
    input.declaredSandbox,
  );
  if (!coherenceCheck.ok) return coherenceCheck;

  const interfaceCheck = validateInterfaceCompleteness(input);
  if (!interfaceCheck.ok) return interfaceCheck;

  return ok;
};
