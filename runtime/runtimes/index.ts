// Runtime dispatcher — selects the runner for an artifact's declared
// sandbox.runtime. Same observation shape across bun / uv / camofox-browser
// so the dispatcher can call once and consume the result uniformly.

import type { JsonValue, SandboxDecl } from "../../substrate/types";
import type { EmitEventInput } from "../events";
import { runBunArtifact, type BunRuntimeObservation } from "./bun";
import { runUvArtifact, type UvRuntimeObservation } from "./uv";
import { runCamofoxArtifact, type CamofoxRuntimeObservation } from "./camofox";

export type UnifiedRuntimeInvocation = {
  artifactId: string;
  body: string;
  declaredSandbox: SandboxDecl;
  inputs: JsonValue;
  budget?: { wallMs?: number; memoryMb?: number };
  emit?: (event: EmitEventInput) => void;
};

export type UnifiedRuntimeObservation =
  | BunRuntimeObservation
  | UvRuntimeObservation
  | CamofoxRuntimeObservation;

/** Dispatch an artifact invocation to the runner declared by its sandbox.
 *  Returns the matching observation type; callers read `ok`, `result`,
 *  `irreversibleEffects`, etc. which are present on every variant. */
export const runArtifactForRuntime = async (
  inv: UnifiedRuntimeInvocation,
): Promise<UnifiedRuntimeObservation> => {
  const runtime = inv.declaredSandbox.runtime;
  if (runtime === "bun") {
    return runBunArtifact({
      ...inv,
      declaredSandbox: inv.declaredSandbox as SandboxDecl & { runtime: "bun" },
    });
  }
  if (runtime === "uv") {
    return runUvArtifact({
      ...inv,
      declaredSandbox: inv.declaredSandbox as SandboxDecl & { runtime: "uv" },
    });
  }
  if (runtime === "camofox-browser") {
    return runCamofoxArtifact({
      ...inv,
      declaredSandbox: inv.declaredSandbox as SandboxDecl & { runtime: "camofox-browser" },
    });
  }
  const _exhaustive: never = runtime;
  throw new Error(`unknown_runtime:${_exhaustive as string}`);
};
