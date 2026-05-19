// acc2 F6 completion — verifier meta wrap point (decision 11).
//
// Every verifier invocation passes through this single function so the
// substrate scores the verifier itself, not only the action the
// verifier scores. The wrap records ONE meta-act per call:
//
//   action_handle  = <verifier_handle being invoked> (the verifier IS
//                    the action of the meta layer)
//   verifier_handle = verifier_reliability_meta
//
// The downstream signal that closes the credit chain is the
// verifier_reliability_meta score that arrives later — a deterministic
// audit comparing the verifier's residual to the observed ground truth
// (owner confirmation, peer verifier, calibration backtest). Predicted
// residual 0.3 mirrors the F6 brief — moderate confidence that the
// verifier was correct at decision time.
//
// The wrap is intentionally I/O-shaped (async, returns the verifier's
// observation verbatim) so call sites can drop in without restructuring
// their await chain. The meta-act emit is fire-and-forget around the
// underlying verifier invocation: if recordInternalAct refuses the
// envelope, the verifier's primary result still returns to the caller.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { recordInternalAct } from "./internal_act_projection";

// FNV-1a 32-bit hash, same shape as owner_entity_acts.ts. Inlined so
// the verifier wrap has zero cross-file dependencies beyond the act
// projection helper.
const stableHash = (input: string): string => {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
};

const safeJson = (value: JsonValue | undefined): string => {
  try { return JSON.stringify(value ?? null); }
  catch { return "unserializable"; }
};

export type VerifierInvocationParams<R> = {
  /** Free-string handle for the verifier — names the verifier class
   *  (predicate_gate, deterministic_code, peer_llm_claude, etc.). */
  verifierHandle: string;
  /** Inputs the verifier received. Used to derive the deterministic
   *  projection key so retries against the same inputs collapse to
   *  one meta-act projection. */
  inputs: JsonValue | undefined;
  /** Predicted residual at meta-decision time. Defaults to 0.3 —
   *  moderate confidence the verifier got the answer right. */
  predictedResidual?: number;
  /** Async callback that actually runs the verifier. Whatever it
   *  returns is forwarded verbatim to the caller; the wrap only
   *  observes the call boundary. */
  invoke: () => Promise<R>;
  /** Optional context — directive, task, source event. Substrate-level
   *  by default (no inheritance into the work projection). */
  directiveId?: string;
  taskId?: string;
  sourceEventId?: string;
  citedArtifactIds?: string[];
  /** Extra payload fields for the meta-act. Avoid large blobs. */
  extra?: { [k: string]: JsonValue };
};

/** Invoke a verifier and record one meta-act for the invocation. The
 *  verifier's observation/result is returned verbatim — the meta-act
 *  emit is a side-effect that fires once per call boundary. Idempotent
 *  via sourceActId = `verifier_reliability_meta:<verifier_handle>:<inputs_hash>`.
 *
 *  Note: residual on the meta-act is the PREDICTED residual at call
 *  time (defaults to 0.3). The actual observed residual from the
 *  verifier's own output flows through the normal action_scored path
 *  for the underlying action and is NOT replayed onto the meta-act
 *  here — the meta layer is scored later by an audit verifier
 *  (verifier_reliability_meta) that compares predicted vs observed. */
export const invokeVerifierWithMeta = async <R>(
  db: Database,
  params: VerifierInvocationParams<R>,
): Promise<R> => {
  const inputsHash = stableHash(safeJson(params.inputs));
  const residual = typeof params.predictedResidual === "number" ? params.predictedResidual : 0.3;
  recordInternalAct(db, {
    intent: "invoke verifier",
    actionHandle: params.verifierHandle,
    verifierHandle: "verifier_reliability_meta",
    verifierKind: "deterministic_code",
    predictedResidual: residual,
    reasoningSummary: `invoking verifier ${params.verifierHandle}`,
    actionSummary: `verifier ${params.verifierHandle} invoked`,
    effectSummary: `verifier ${params.verifierHandle} produced residual signal for credit pipeline`,
    directiveId: params.directiveId,
    taskId: params.taskId,
    sourceEventId: params.sourceEventId,
    sourceActId: "verifier_reliability_meta:" + params.verifierHandle + ":" + inputsHash,
    citedArtifactIds: params.citedArtifactIds,
    extra: {
      ...(params.extra ?? {}),
      verifier_handle: params.verifierHandle,
      inputs_hash: inputsHash,
    },
  });
  return params.invoke();
};
