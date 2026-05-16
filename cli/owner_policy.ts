#!/usr/bin/env bun
// `acc owner policy` — print the orchestrator-ready rendering policy for the
// current owner. Reads the latest `owner_profile_recorded` row from the
// substrate ledger and passes it through the shared `buildOwnerProfileSection`
// renderer (runtime/prompt_composer.ts) so the orchestrator (main Claude
// Code) and the brain see the SAME owner-policy text — one substrate, one
// source of truth (k_200 same-substrate principle).
//
// The orchestrator MUST consult this before non-trivial owner-visible
// replies: mirror `preferred_terms`, never use `avoided_terms`, honor each
// continuous `rendering_signal` independently, skip concepts in
// `exposed_concepts`. See system/acc2/CLAUDE.md "owner-facing chat language".

import { openDb } from "../substrate/db";
import { resolveDbPath } from "../runtime/state_paths";
import { buildOwnerProfileSection, readOwnerProfile } from "../runtime/prompt_composer";

const USAGE = "usage: acc owner policy\n";
const HELP = [
  "acc owner — owner profile / rendering policy",
  "",
  USAGE.trim(),
  "",
  "Subcommands:",
  "  policy   Print the orchestrator-ready rendering policy for the current owner.",
  "           Reads the latest owner_profile_recorded row and renders it via the",
  "           same prompt-composer section the brain receives.",
  "",
  "Flags:",
  "  --help   Show this help.",
  "",
].join("\n");

export const runOwnerPolicy = async (argv: string[]): Promise<number> => {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const sub = argv[0];
  if (sub === undefined) {
    process.stdout.write(`${USAGE}Run \`acc owner policy\` to print the rendering policy.\n`);
    return 0;
  }
  if (sub !== "policy") {
    process.stderr.write(`acc owner: unknown subcommand '${sub}'\n${USAGE}`);
    return 1;
  }
  const db = openDb(resolveDbPath());
  const profile = readOwnerProfile(db);
  process.stdout.write(`${buildOwnerProfileSection(profile)}\n`);
  return 0;
};
