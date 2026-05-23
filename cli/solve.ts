// `acc solve "<task>"` — live CLI entry for the generate-and-select organism.
//
// Routes the task through runtime/solve_loop.ts:solveTask with a LIVE LLM
// generator (runtime/llm_generate.ts, one real OpenAI verbalized-sampling
// call) and the substrate adapters (structural comparator, owner-preference
// emit, experience-stream recorder) bound to the local state.db. This is the
// proof that the organism is operationally live end to end:
//   route -> predict -> generate -> provenance-filter -> select -> record.
//
// retrieveSimilar returns [] for now (treat every task as novel -> the
// predictor has no prior, so the full generate-and-select path is exercised).
// Wiring it to the real experience-stream reader is a follow-on.

import type { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { resolveDbPath } from "../runtime/state_paths";
import { solveTask, type SolveDeps } from "../runtime/solve_loop";
import { generateCandidates } from "../runtime/llm_generate";
import {
  structuralComparator,
  requestOwnerPreference,
} from "../runtime/generate_select_adapters";
import { recordOutcomeToStream } from "../runtime/generate_select_adapters";
import { verifyClaimProvenance } from "../runtime/claim_provenance_verifier";
import { emitEvent } from "../runtime/events";

type SolveEnv = {
  out: (s: string) => void;
  err: (s: string) => void;
  stateDbPath?: string;
  openSubstrate?: (path?: string) => Database;
};

const defaultEnv = (): SolveEnv => ({
  out: (s) => console.log(s),
  err: (s) => console.error(s),
});

const usage = (): string => [
  "acc solve — run the generate-and-select organism on a task (live LLM)",
  "",
  "Usage:",
  "  acc solve \"<task text>\" [--n N]",
  "",
  "Generates diverse candidates via one OpenAI verbalized-sampling call,",
  "deterministically provenance-filters invented/unsourced numbers, pairwise-",
  "compares survivors, spends a sparse owner preference only on close calls,",
  "and records the outcome to the experience stream. Requires OPENAI_API_KEY.",
].join("\n");

const truncate = (s: string, max = 400): string =>
  s.length <= max ? s : `${s.slice(0, max)}…(+${s.length - max} chars)`;

export const runSolve = async (
  argv: string[],
  envOverride?: Partial<SolveEnv>,
): Promise<number> => {
  const env: SolveEnv = { ...defaultEnv(), ...(envOverride ?? {}) };
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    env.out(usage());
    return argv.length === 0 ? 1 : 0;
  }
  const nIdx = argv.indexOf("--n");
  const n = nIdx >= 0 && argv[nIdx + 1] ? Math.max(1, Number(argv[nIdx + 1])) : 2;
  const task = argv
    .filter((a, i) => a !== "--n" && argv[i - 1] !== "--n")
    .join(" ")
    .trim();
  if (!task) {
    env.err("acc solve: missing task text");
    env.out(usage());
    return 1;
  }

  const path = env.stateDbPath ?? resolveDbPath();
  let db: Database;
  try {
    db = (env.openSubstrate ?? ((p?: string) => openDb(p ?? resolveDbPath())))(path);
  } catch (err) {
    env.err(`acc solve: failed to open substrate: ${(err as Error).message}`);
    return 1;
  }

  // Capture the owner intent as a first-class ledger row before dispatch.
  const directive = emitEvent(db, {
    kind: "owner_input_received",
    substrate_origin: "claude_inline",
    payload: { text: task, source: "acc solve" },
  });

  let ownerRequested = false;
  const deps: SolveDeps<string> = {
    generate: (t, nn) => generateCandidates(t, nn),
    // Novel task -> no prior -> full generate-and-select path exercised.
    retrieveSimilar: async () => [],
    comparator: async (t, a, b) => structuralComparator(t, a, b),
    requestOwnerPreference: async (t, a, b) => {
      ownerRequested = true;
      return requestOwnerPreference(db, t, a, b, {
        directiveId: directive.id,
        substrateOrigin: "claude_inline",
      }).preference;
    },
    recordOutcome: (outcome) => {
      recordOutcomeToStream(db, task, outcome, {
        directiveId: directive.id,
        substrateOrigin: "claude_inline",
      });
    },
  };

  const result = await solveTask<string>(task, deps);

  const selected = result.selected;
  const residual = selected
    ? verifyClaimProvenance(selected.claims).residual
    : null;
  const filtered = result.selectOutcome?.filtered_out ?? [];

  env.out("── acc solve result ──────────────────────────────");
  env.out(`route:    ${result.route}`);
  env.out(`path:     ${result.path}`);
  env.out(`reason:   ${result.reason}`);
  env.out(
    `selected: ${selected ? selected.id : "<none — no candidate survived>"}`,
  );
  if (selected) {
    env.out(`provenance_residual: ${residual?.toFixed(3)}`);
    env.out(`body:\n${truncate(String(selected.artifact))}`);
  }
  if (filtered.length > 0) {
    env.out(
      `filtered_out: ${filtered.map((f) => `${f.id}@residual=${f.residual.toFixed(3)}`).join(", ")}`,
    );
  } else {
    env.out("filtered_out: (none)");
  }
  env.out(`owner_preference_requested: ${ownerRequested ? "yes" : "no"}`);
  env.out(`directive_id: ${directive.id}`);
  return selected ? 0 : 2;
};
