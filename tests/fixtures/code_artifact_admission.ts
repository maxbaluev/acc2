// Canonical admission fixtures for the three code runtimes (RUNTIME_AD,
// directive 3XETJCYT). The task — "admission fixtures must validate
// interfaces" — requires a valid + a set of invalid example artifacts for
// each of bun / uv / camofox-browser that prove the admission hardening
// validators (runtime/code_artifact_validation.ts) ACCEPT well-formed code
// and REJECT malformed code (missing inputs_schema, missing verifier,
// malformed schema, empty body, missing/incoherent sandbox).
//
// These are pure data shapes consumed directly by validateCodeArtifactAdmission
// — they do NOT execute any code (static/structural validation only). The
// fixtures are imported by tests/code_artifact_admission_fixtures.test.ts
// and are reusable by any self-test or future admission-path coverage.

import type {
  ArtifactInterfaceMetadata,
  SandboxDecl,
} from "../../substrate/types";
import type {
  CodeArtifactRejectionReason,
  ValidateCodeArtifactInput,
} from "../../runtime/code_artifact_validation";

// ── Shared building blocks ──────────────────────────────────────────

const BUN_SANDBOX: SandboxDecl = { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 };
const UV_SANDBOX: SandboxDecl = { runtime: "uv", cpu_ms: 1000, wall_ms: 15000, memory_mb: 256 };
const CAMOFOX_SANDBOX: SandboxDecl = {
  runtime: "camofox-browser",
  browser_allow_domains: ["example.com"],
  browser_profile_root: "/tmp/acc2-fixture-profile",
  wall_ms: 5000,
  memory_mb: 256,
};
const CAMOFOX_SANDBOX_NO_DOMAINS: SandboxDecl = {
  runtime: "camofox-browser",
  browser_allow_domains: [],
  browser_profile_root: "/tmp/acc2-fixture-profile",
  wall_ms: 5000,
  memory_mb: 256,
};

/** A COMPLETE, well-formed interface descriptor — the wave-1 authored
 *  shape. Both schemas present + well-formed; the verifier is supplied via
 *  the act-loop verifierArtifactId on the input below. */
const completeInterface = (): ArtifactInterfaceMetadata => ({
  purpose: "run a unit of code and return a residual",
  inputs_schema: { type: "object", properties: { x: { type: "number" } } },
  outputs_schema: { type: "object", properties: { residual: { type: "number" } } },
});

export type CodeArtifactFixture = {
  /** Human-readable label for the test row. */
  label: string;
  /** The validator input. */
  input: ValidateCodeArtifactInput;
};

export type ValidCodeArtifactFixture = CodeArtifactFixture & { expectAdmit: true };
export type InvalidCodeArtifactFixture = CodeArtifactFixture & {
  expectAdmit: false;
  /** The specific typed rejection the validator must return. */
  expectReason: CodeArtifactRejectionReason;
};

// ── bun fixtures ────────────────────────────────────────────────────

export const BUN_VALID: ValidCodeArtifactFixture = {
  label: "bun: complete interface + non-empty body + verifier + sandbox",
  expectAdmit: true,
  input: {
    runtime: "bun",
    body: "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null');\nconsole.log('@@RESULT@@ ' + JSON.stringify({ residual: 0.05 }));",
    declaredSandbox: BUN_SANDBOX,
    interfaceMetadata: completeInterface(),
    verifierArtifactId: "verifier_bun_v1",
  },
};

export const BUN_INVALID: InvalidCodeArtifactFixture[] = [
  {
    label: "bun: missing inputs_schema",
    expectAdmit: false,
    expectReason: "code_artifact_interface_incomplete",
    input: {
      runtime: "bun",
      body: "console.log('@@RESULT@@ {}');",
      declaredSandbox: BUN_SANDBOX,
      interfaceMetadata: { ...completeInterface(), inputs_schema: undefined },
      verifierArtifactId: "verifier_bun_v1",
    },
  },
  {
    label: "bun: missing verifier (no verifierArtifactId, no inline verifier)",
    expectAdmit: false,
    expectReason: "code_artifact_interface_incomplete",
    input: {
      runtime: "bun",
      body: "console.log('@@RESULT@@ {}');",
      declaredSandbox: BUN_SANDBOX,
      interfaceMetadata: completeInterface(),
      // verifierArtifactId intentionally omitted.
    },
  },
  {
    label: "bun: malformed outputs_schema (type is a number)",
    expectAdmit: false,
    expectReason: "code_artifact_schema_invalid",
    input: {
      runtime: "bun",
      body: "console.log('@@RESULT@@ {}');",
      declaredSandbox: BUN_SANDBOX,
      interfaceMetadata: {
        ...completeInterface(),
        outputs_schema: { type: 123 } as unknown as ArtifactInterfaceMetadata["outputs_schema"],
      },
      verifierArtifactId: "verifier_bun_v1",
    },
  },
  {
    label: "bun: empty body",
    expectAdmit: false,
    expectReason: "code_artifact_body_invalid",
    input: {
      runtime: "bun",
      body: "   \n  ",
      declaredSandbox: BUN_SANDBOX,
      interfaceMetadata: completeInterface(),
      verifierArtifactId: "verifier_bun_v1",
    },
  },
  {
    label: "bun: comment-only body (no executable substance)",
    expectAdmit: false,
    expectReason: "code_artifact_body_invalid",
    input: {
      runtime: "bun",
      body: "// just a comment\n/* and a block */",
      declaredSandbox: BUN_SANDBOX,
      interfaceMetadata: completeInterface(),
      verifierArtifactId: "verifier_bun_v1",
    },
  },
  {
    label: "bun: missing sandbox",
    expectAdmit: false,
    expectReason: "code_artifact_sandbox_incoherent",
    input: {
      runtime: "bun",
      body: "console.log('@@RESULT@@ {}');",
      declaredSandbox: null,
      interfaceMetadata: completeInterface(),
      verifierArtifactId: "verifier_bun_v1",
    },
  },
];

// ── uv fixtures ─────────────────────────────────────────────────────

export const UV_VALID: ValidCodeArtifactFixture = {
  label: "uv: complete interface + non-empty python body + verifier + sandbox",
  expectAdmit: true,
  input: {
    runtime: "uv",
    body: "result = inputs.get('x', 0) + 1\nprint('@@RESULT@@ ' + json.dumps({'residual': 0.0}))",
    declaredSandbox: UV_SANDBOX,
    interfaceMetadata: completeInterface(),
    verifierArtifactId: "verifier_uv_v1",
  },
};

export const UV_INVALID: InvalidCodeArtifactFixture[] = [
  {
    label: "uv: missing outputs_schema",
    expectAdmit: false,
    expectReason: "code_artifact_interface_incomplete",
    input: {
      runtime: "uv",
      body: "result = 1\nprint('@@RESULT@@ {}')",
      declaredSandbox: UV_SANDBOX,
      interfaceMetadata: { ...completeInterface(), outputs_schema: undefined },
      verifierArtifactId: "verifier_uv_v1",
    },
  },
  {
    label: "uv: malformed inputs_schema (array, not a shape)",
    expectAdmit: false,
    expectReason: "code_artifact_schema_invalid",
    input: {
      runtime: "uv",
      body: "result = 1\nprint('@@RESULT@@ {}')",
      declaredSandbox: UV_SANDBOX,
      interfaceMetadata: {
        ...completeInterface(),
        inputs_schema: [] as unknown as ArtifactInterfaceMetadata["inputs_schema"],
      },
      verifierArtifactId: "verifier_uv_v1",
    },
  },
  {
    label: "uv: comment-only python body",
    expectAdmit: false,
    expectReason: "code_artifact_body_invalid",
    input: {
      runtime: "uv",
      body: "# only a python comment\n# another",
      declaredSandbox: UV_SANDBOX,
      interfaceMetadata: completeInterface(),
      verifierArtifactId: "verifier_uv_v1",
    },
  },
  {
    label: "uv: missing sandbox",
    expectAdmit: false,
    expectReason: "code_artifact_sandbox_incoherent",
    input: {
      runtime: "uv",
      body: "result = 1\nprint('@@RESULT@@ {}')",
      declaredSandbox: null,
      interfaceMetadata: completeInterface(),
      verifierArtifactId: "verifier_uv_v1",
    },
  },
];

// ── camofox-browser fixtures ────────────────────────────────────────

export const CAMOFOX_VALID: ValidCodeArtifactFixture = {
  label: "camofox: well-formed session-flow body + allow-domains + complete interface",
  expectAdmit: true,
  input: {
    runtime: "camofox-browser",
    body: "await session.goto(inputs.url);\nconst t = await session.text('h1');\nconsole.log('@@RESULT@@ ' + JSON.stringify({ residual: 0.0, title: t }));",
    declaredSandbox: CAMOFOX_SANDBOX,
    interfaceMetadata: completeInterface(),
    verifierArtifactId: "verifier_camofox_v1",
  },
};

export const CAMOFOX_VALID_STEP_LIST: ValidCodeArtifactFixture = {
  label: "camofox: well-formed JSON step-list body",
  expectAdmit: true,
  input: {
    runtime: "camofox-browser",
    body: JSON.stringify([
      { op: "goto", url: "https://example.com" },
      { op: "text", selector: "h1" },
    ]),
    declaredSandbox: CAMOFOX_SANDBOX,
    interfaceMetadata: completeInterface(),
    verifierArtifactId: "verifier_camofox_v1",
  },
};

export const CAMOFOX_INVALID: InvalidCodeArtifactFixture[] = [
  {
    label: "camofox: body is not a browser flow (no session op, no step list)",
    expectAdmit: false,
    expectReason: "code_artifact_body_invalid",
    input: {
      runtime: "camofox-browser",
      body: "const x = 1 + 1; console.log('@@RESULT@@ {}');",
      declaredSandbox: CAMOFOX_SANDBOX,
      interfaceMetadata: completeInterface(),
      verifierArtifactId: "verifier_camofox_v1",
    },
  },
  {
    label: "camofox: malformed JSON step list",
    expectAdmit: false,
    expectReason: "code_artifact_body_invalid",
    input: {
      runtime: "camofox-browser",
      body: "[ { op: goto, url }",
      declaredSandbox: CAMOFOX_SANDBOX,
      interfaceMetadata: completeInterface(),
      verifierArtifactId: "verifier_camofox_v1",
    },
  },
  {
    label: "camofox: navigates to a URL but declares browser_allow_domains: []",
    expectAdmit: false,
    expectReason: "code_artifact_sandbox_incoherent",
    input: {
      runtime: "camofox-browser",
      body: "await session.goto('https://example.com');\nconsole.log('@@RESULT@@ {}');",
      declaredSandbox: CAMOFOX_SANDBOX_NO_DOMAINS,
      interfaceMetadata: completeInterface(),
      verifierArtifactId: "verifier_camofox_v1",
    },
  },
  {
    label: "camofox: missing inputs_schema",
    expectAdmit: false,
    expectReason: "code_artifact_interface_incomplete",
    input: {
      runtime: "camofox-browser",
      body: "await session.goto(inputs.url);\nconsole.log('@@RESULT@@ {}');",
      declaredSandbox: CAMOFOX_SANDBOX,
      interfaceMetadata: { ...completeInterface(), inputs_schema: undefined },
      verifierArtifactId: "verifier_camofox_v1",
    },
  },
  {
    label: "camofox: empty body",
    expectAdmit: false,
    expectReason: "code_artifact_body_invalid",
    input: {
      runtime: "camofox-browser",
      body: "",
      declaredSandbox: CAMOFOX_SANDBOX,
      interfaceMetadata: completeInterface(),
      verifierArtifactId: "verifier_camofox_v1",
    },
  },
];

// ── Backward-compat fixtures (legacy executable-tool path) ──────────

/** A code artifact with NO interface_metadata is the legacy
 *  executable-tool shape (e.g. a one-shot diagnostic runner). It must
 *  still admit — the interface-completeness gate fires ONLY when
 *  interface_metadata is supplied. */
export const BUN_LEGACY_NO_METADATA: ValidCodeArtifactFixture = {
  label: "bun: legacy executable tool with no interface_metadata still admits",
  expectAdmit: true,
  input: {
    runtime: "bun",
    body: "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null');\nconsole.log('@@RESULT@@ ' + JSON.stringify({ ok: true, echoed: inputs }));",
    declaredSandbox: BUN_SANDBOX,
    interfaceMetadata: null,
    // No verifier required when no descriptor is supplied (legacy path).
  },
};

export const ALL_VALID: ValidCodeArtifactFixture[] = [
  BUN_VALID,
  UV_VALID,
  CAMOFOX_VALID,
  CAMOFOX_VALID_STEP_LIST,
  BUN_LEGACY_NO_METADATA,
];

export const ALL_INVALID: InvalidCodeArtifactFixture[] = [
  ...BUN_INVALID,
  ...UV_INVALID,
  ...CAMOFOX_INVALID,
];
