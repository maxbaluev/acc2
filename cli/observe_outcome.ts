#!/usr/bin/env bun
// `acc observe <event_id> --verdict positive|negative [--reason "..."]`
//
// Owner-side ingress for `owner_observed_outcome_recorded` — the loop-
// closing primitive landed at commit 9da6770 (amendment OWNROBSV05).
// CLAUDE.md "Closure And Learning" mandates that when the owner observes
// that an applied change actually did (or did NOT) deliver the intended
// outcome, the substrate must record that observation in the ledger so
// posteriors on cited_artifact_ids can update accordingly.
//
// Until this verb exists, the orchestrator and brain have no signal when
// the owner says "TUI still doesn't work" — every apply chain claims
// success at verifier_residual time, and the next session sees the cited
// knowledge entries' posteriors UN-penalized. The four-link credit chain
// (k_555) only closes on the substrate's own verifier; owner observation
// is the missing link.
//
// Usage:
//   acc observe <event_id> --verdict negative --reason "TUI hotkeys broken"
//   acc observe <event_id> --verdict positive
//
// The <event_id> normally references an `applied_change_committed` event
// (or a `task_committed` for non-code work). The emitted event carries
// context_refs=[event_id] so the substrate can walk back to the cited
// knowledge/artifact ids on the original applied chain.

import { mcpCall } from "./rpc";

type Args = Record<string, string | boolean>;

const parseArgs = (argv: string[]): { positional: string[]; flags: Args } => {
  const positional: string[] = [];
  const flags: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq >= 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[a.slice(2)] = next;
      i++;
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return { positional, flags };
};

const HELP = `acc observe — record an owner-observed outcome on a prior change

usage: acc observe <event_id> --verdict positive|negative [--reason "..."]

  <event_id>  applied_change_committed / task_committed / act_tuple_recorded
              row the operator is judging.
  --verdict   positive | negative | partial — required.
  --reason    short free-text explaining what the operator observed.

Emits an owner_observed_outcome_recorded event with context_refs=[event_id]
so the substrate can walk back to cited knowledge/artifact ids and update
posteriors. Closes the k_555 four-link credit chain on owner observation
(OWNROBSV05 amendment landed 2026-05-17 at commit 9da6770).
`;

export const runObserveOutcome = async (argv: string[]): Promise<number> => {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return argv.length === 0 ? 1 : 0;
  }
  const { positional, flags } = parseArgs(argv);
  const eventId = positional[0];
  if (!eventId) {
    process.stderr.write("acc observe: missing <event_id> positional\n");
    return 1;
  }
  const signal = String(flags.signal ?? flags.verdict ?? "");
  const { buildOwnerOutcomeEmitInput } = await import("../runtime/owner_outcome_channel");
  const reason = typeof flags.reason === "string" ? flags.reason : null;

  const refEnv = await mcpCall("substrate.get_event", { id: eventId });
  if (!refEnv.ok) {
    process.stderr.write(`acc observe: event ${eventId} not found (${refEnv.error})\n`);
    return 1;
  }
  const refRow = refEnv.result as {
    id?: string;
    kind?: string;
    directive_id?: string;
    task_id?: string;
    payload?: unknown;
    context_refs?: string[];
    residual?: number;
  } | null;
  if (!refRow || !refRow.id || !refRow.kind) {
    process.stderr.write(`acc observe: event ${eventId} not found in substrate\n`);
    return 1;
  }
  const expected = new Set(["applied_change_committed", "task_committed", "act_tuple_recorded", "action_scored"]);
  if (!expected.has(refRow.kind)) {
    process.stderr.write(
      `acc observe: warning — event ${eventId} is kind=${refRow.kind}, not an applied/committed/action row. ` +
      `Posterior credit propagation expects one of {${[...expected].join(", ")}}. ` +
      `The observation will still be recorded.\n`,
    );
  }

  const eventInput = buildOwnerOutcomeEmitInput({
    id: refRow.id,
    kind: refRow.kind as never,
    directive_id: refRow.directive_id ?? "directive_root",
    task_id: refRow.task_id ?? "task_root",
    payload: refRow.payload as never,
    context_refs: refRow.context_refs ?? [],
    residual: refRow.residual,
  }, {
    signal,
    target: { event_id: eventId },
    reason,
    observation: reason,
  });
  const emit = await mcpCall("substrate.emit", eventInput);
  if (!emit.ok) {
    process.stderr.write(`acc observe: emit failed — ${emit.error}\n`);
    return 1;
  }
  const out = emit.result as { event_id?: string; id?: string } | null;
  const newId = out?.event_id ?? out?.id ?? "?";
  process.stdout.write(
    `owner_observed_outcome_recorded ${newId} verdict=${(eventInput.payload as { verdict?: string }).verdict ?? "partial"} source=${eventId}` +
    (reason ? ` reason=${JSON.stringify(reason)}` : "") + "\n",
  );
  return 0;
};
