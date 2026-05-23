// Deterministic claim-provenance verifier — keystone of the
// "generate-and-select" architecture.
//
// Taste-free, objective verification. No LLM, no calibration, no DB, no
// network. It catches the failure mode the owner flagged in the Lakeland
// report: invented/unsourced numbers (e.g. a "6% recovery rate" multiplier
// that appears nowhere in the underlying 10-K) silently feeding a headline
// figure.
//
// A numeric claim is a small derivation: an arithmetic expression over a set
// of inputs. Each input is either grounded in a real source, derived from
// other inputs, or unsourced/invented. The verifier walks the provenance of
// every input and bottoms out at source_uri'd leaves. Any input that does not
// — because it is marked unsourced, or its derived_from chain reaches an
// unsourced/missing input — is INVALID. It also checks the arithmetic of
// simple binary expressions. The residual rises with the count of invalid
// inputs and arithmetic errors, so any report carrying an invented
// derivation input scores above the 0.3 closure bar and fails.

export type ClaimInput = { label: string; value: number } & (
  | { source_uri: string }
  | { derived_from: string[] }
  | { unsourced: true }
);

export type NumericClaim = {
  id: string;
  expression: string;
  result: number;
  inputs: ClaimInput[];
};

export type ProvenanceResult = {
  residual: number;
  breakdown: {
    total_inputs: number;
    unsourced_inputs: { claim_id: string; label: string }[];
    arithmetic_errors: { claim_id: string; expected: number; got: number }[];
  };
};

const EPSILON = 1e-6;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

const isSourced = (
  input: ClaimInput,
): input is ClaimInput & { source_uri: string } =>
  typeof (input as { source_uri?: unknown }).source_uri === "string" &&
  (input as { source_uri: string }).source_uri.length > 0;

const isUnsourced = (input: ClaimInput): boolean =>
  (input as { unsourced?: unknown }).unsourced === true;

const derivedFrom = (input: ClaimInput): string[] | null => {
  const df = (input as { derived_from?: unknown }).derived_from;
  return Array.isArray(df) ? (df as string[]) : null;
};

// An input is grounded iff it has a source_uri, OR it is derived_from a chain
// of inputs (resolved by label) that all bottom out in source_uri'd leaves.
// Unsourced inputs, dangling derived_from references, and cycles are NOT
// grounded. Memoized + cycle-guarded over the per-claim label index.
const isGrounded = (
  input: ClaimInput,
  index: Map<string, ClaimInput>,
  resolving: Set<string>,
  memo: Map<string, boolean>,
): boolean => {
  if (isUnsourced(input)) return false;
  if (isSourced(input)) return true;

  const deps = derivedFrom(input);
  if (deps === null) return false; // neither sourced, derived, nor flagged

  const cached = memo.get(input.label);
  if (cached !== undefined) return cached;

  if (resolving.has(input.label)) return false; // cycle → not grounded
  resolving.add(input.label);

  let grounded = deps.length > 0; // derived_from [] grounds in nothing
  for (const depLabel of deps) {
    const dep = index.get(depLabel);
    if (dep === undefined || !isGrounded(dep, index, resolving, memo)) {
      grounded = false;
      break;
    }
  }

  resolving.delete(input.label);
  memo.set(input.label, grounded);
  return grounded;
};

// Evaluate a simple `a (*|+|-|/) b` binary expression over input VALUES,
// resolved by label. Returns null when the expression is not a recognizable
// two-operand form or an operand label is missing — non-binary expressions
// are simply not arithmetic-checked (we only assert what we can verify).
const evalBinaryExpression = (
  expression: string,
  index: Map<string, ClaimInput>,
): number | null => {
  const m = expression.match(/^\s*(\S+)\s*([*+\-/])\s*(\S+)\s*$/);
  if (!m) return null;
  const [, leftTok, op, rightTok] = m;

  const resolve = (tok: string): number | null => {
    const byLabel = index.get(tok);
    if (byLabel !== undefined) return byLabel.value;
    const n = Number(tok);
    return Number.isFinite(n) ? n : null;
  };

  const a = resolve(leftTok);
  const b = resolve(rightTok);
  if (a === null || b === null) return null;

  switch (op) {
    case "*":
      return a * b;
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "/":
      return b === 0 ? null : a / b;
    default:
      return null;
  }
};

export function verifyClaimProvenance(
  claims: NumericClaim[],
): ProvenanceResult {
  let totalInputs = 0;
  const unsourcedInputs: { claim_id: string; label: string }[] = [];
  const arithmeticErrors: {
    claim_id: string;
    expected: number;
    got: number;
  }[] = [];

  for (const claim of claims) {
    const index = new Map<string, ClaimInput>();
    for (const input of claim.inputs) index.set(input.label, input);

    const memo = new Map<string, boolean>();
    for (const input of claim.inputs) {
      totalInputs += 1;
      if (!isGrounded(input, index, new Set<string>(), memo)) {
        unsourcedInputs.push({ claim_id: claim.id, label: input.label });
      }
    }

    const computed = evalBinaryExpression(claim.expression, index);
    if (computed !== null && Math.abs(computed - claim.result) > EPSILON) {
      arithmeticErrors.push({
        claim_id: claim.id,
        expected: computed,
        got: claim.result,
      });
    }
  }

  const residual = clamp01(
    (unsourcedInputs.length * 1.0 + arithmeticErrors.length * 1.0) /
      Math.max(1, totalInputs),
  );

  return {
    residual,
    breakdown: {
      total_inputs: totalInputs,
      unsourced_inputs: unsourcedInputs,
      arithmetic_errors: arithmeticErrors,
    },
  };
}
