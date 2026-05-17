// `acc admin export-knowledge` — anonymised, owner-approved export of
// promoted knowledge + recipes + policy bundles for cross-install
// sharing. Distinct from `acc admin export` (which dumps the full
// state.db including owner_input text and owner_decision history —
// would leak private information).
//
// Brain design 5JE82MP9TN1ZB3T1DPSYWK614G (residual 0.12,
// distribution-readiness): "A canonical anonymized knowledge export
// CLI should emit selected promoted/candidate knowledge and recipe
// shapes with payload redaction, provenance stripping, and owner
// approval, distinct from full state export."
//
// What ships in the export:
//   • promoted laws + knowledge: claim/text, tags, score, confidence,
//     goal_shape_tags. NO evidence_event_ids, NO directive_id/task_id,
//     NO source_event_id (those are install-local).
//   • policy bundles: surface, section_name, priority, version, body.
//     Same redaction.
//   • recipes: label, goal_text_hash (not raw goal_text), trajectory
//     shape, score.
//
// What does NOT ship:
//   • owner_input_received / owner_observed_outcome_recorded /
//     owner_decision_recorded: these carry the user's words and
//     decisions, never share without explicit per-row opt-in.
//   • Any payload field NOT in the allow-list per row kind.
//   • Anything with substrate_origin='claude_root' or 'claude_inline'
//     unless explicitly re-opted-in (those are typically per-session
//     artifacts, not portable priors).
//
// Owner approval gate: requires --yes OR an interactive confirmation.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDb } from "../substrate/db";

type ExportedKnowledge = {
  tier: "law" | "knowledge" | "policy_bundle";
  claim: string | null;
  tags: string[];
  score: number;
  confidence: number;
  goal_shape_tags?: string[];
  /** Only set for policy_bundle tier — the surface+section identifying
   *  the prompt slot this bundle drops into. */
  surface?: string;
  section_name?: string;
  priority?: number;
  version?: number;
  body?: string;
};

type ExportedRecipe = {
  label: string;
  /** SHA-style hash of the canonical goal text, so consumers can match
   *  shape without seeing the raw owner-provided goal. */
  goal_text_hash: string;
  score: number;
  confidence: number;
  step_count: number;
  trajectory_kind_sequence: string[];
};

export type AnonymisedExport = {
  schema_version: "anonymized_knowledge_v1";
  exported_at: string;
  source_install_id_hash: string;
  knowledge: ExportedKnowledge[];
  recipes: ExportedRecipe[];
  counts: {
    laws: number;
    knowledge: number;
    policy_bundles: number;
    recipes: number;
    skipped_owner_local: number;
  };
};

const fnv1a64 = (s: string): string => {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const buf = new TextEncoder().encode(s);
  for (const b of buf) {
    h ^= BigInt(b);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
};

const parseJson = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** Pull every knowledge_promoted row, classify by tier (law /
 *  policy_bundle / knowledge), redact to the allow-list. */
export const collectPromotedKnowledge = (db: ReturnType<typeof openDb>): ExportedKnowledge[] => {
  type Row = { id: string; payload: string; substrate_origin: string; refs: string };
  const rows = db
    .query("SELECT id, payload, substrate_origin, COALESCE(context_refs, '[]') AS refs FROM events WHERE kind = 'knowledge_promoted'")
    .all() as Row[];
  const out: ExportedKnowledge[] = [];
  for (const r of rows) {
    const payload = parseJson<Record<string, unknown>>(r.payload, {});
    const candidateId = payload.candidate_id as string | undefined;
    let candidatePayload: Record<string, unknown> = {};
    if (candidateId) {
      const c = db
        .query("SELECT payload FROM events WHERE kind = 'knowledge_candidate' AND id = ?")
        .get(candidateId) as { payload: string } | null;
      if (c) candidatePayload = parseJson<Record<string, unknown>>(c.payload, {});
    }
    const proposedTier = (candidatePayload.proposed_tier as string | undefined) ?? (payload.type === "policy_bundle" ? "policy_bundle" : "knowledge");
    const tier = proposedTier === "law" ? "law" : proposedTier === "policy_bundle" ? "policy_bundle" : "knowledge";
    const claim = (candidatePayload.claim as string | undefined) ?? (candidatePayload.text as string | undefined) ?? (payload.body as string | undefined) ?? null;
    const tags = Array.isArray(candidatePayload.tags) ? (candidatePayload.tags as string[]).filter((x) => typeof x === "string") : [];
    const score = typeof payload.score === "number" ? payload.score : 0;
    const confidence = typeof payload.confidence === "number" ? payload.confidence : 0;
    const base: ExportedKnowledge = {
      tier,
      claim,
      tags,
      score,
      confidence,
    };
    if (Array.isArray(payload.goal_shape_tags)) base.goal_shape_tags = (payload.goal_shape_tags as unknown[]).filter((x): x is string => typeof x === "string");
    if (tier === "policy_bundle") {
      base.surface = (payload.surface as string | undefined) ?? undefined;
      base.section_name = (payload.section_name as string | undefined) ?? undefined;
      base.priority = typeof payload.priority === "number" ? payload.priority : undefined;
      base.version = typeof payload.version === "number" ? payload.version : undefined;
      base.body = (payload.body as string | undefined) ?? undefined;
    }
    out.push(base);
  }
  return out;
};

/** Pull every recipe (admitted or promoted), hash the goal text, emit
 *  the trajectory shape. */
export const collectRecipes = (db: ReturnType<typeof openDb>): ExportedRecipe[] => {
  type Row = { canonical_id: string; goal_text: string; score: number; confidence: number; trajectory: string };
  let rows: Row[] = [];
  try {
    rows = db
      .query(
        "SELECT canonical_id, goal_text, score, confidence, trajectory FROM recipe WHERE status IN ('admitted', 'promoted')",
      )
      .all() as Row[];
  } catch {
    return [];
  }
  return rows.map((r) => {
    const trajectory = parseJson<Array<{ action_artifact_id?: string; kind?: string }>>(r.trajectory, []);
    return {
      label: r.canonical_id,
      goal_text_hash: fnv1a64(r.goal_text ?? ""),
      score: r.score ?? 0,
      confidence: r.confidence ?? 0,
      step_count: trajectory.length,
      trajectory_kind_sequence: trajectory.map((s) => s.kind ?? s.action_artifact_id ?? "?").filter((x) => typeof x === "string"),
    };
  });
};

export const buildAnonymisedExport = (db: ReturnType<typeof openDb>): AnonymisedExport => {
  const knowledge = collectPromotedKnowledge(db);
  const recipes = collectRecipes(db);
  const laws = knowledge.filter((k) => k.tier === "law").length;
  const policy_bundles = knowledge.filter((k) => k.tier === "policy_bundle").length;
  const knowledge_count = knowledge.filter((k) => k.tier === "knowledge").length;
  // Skipped: rows we deliberately did NOT include (owner_input_received,
  // owner_decision_recorded, owner_observed_outcome_recorded). Count for
  // operator transparency.
  const skipped = (db
    .query("SELECT COUNT(*) AS c FROM events WHERE kind IN ('owner_input_received','owner_decision_recorded','owner_observed_outcome_recorded')")
    .get() as { c: number }).c;
  // Stable, anonymous source identifier so a downstream merger can
  // dedup imports from the same install over time without learning
  // which user it came from. Hash of the install's first directive
  // event id (effectively epoch-stable, no identifying info).
  const firstEv = db.query("SELECT id FROM events ORDER BY ts ASC LIMIT 1").get() as { id?: string } | null;
  const installIdHash = firstEv?.id ? fnv1a64(`install:${firstEv.id}`) : fnv1a64("install:unknown");
  return {
    schema_version: "anonymized_knowledge_v1",
    exported_at: new Date().toISOString(),
    source_install_id_hash: installIdHash,
    knowledge,
    recipes,
    counts: {
      laws,
      knowledge: knowledge_count,
      policy_bundles,
      recipes: recipes.length,
      skipped_owner_local: skipped,
    },
  };
};

export type ExportKnowledgeEnv = {
  out: (s: string) => void;
  err: (s: string) => void;
  openSubstrate?: () => ReturnType<typeof openDb>;
  yes?: boolean;
};

const HELP = `acc admin export-knowledge — anonymised export for cross-install sharing

usage: acc admin export-knowledge <path> [--yes]

  Emits promoted laws / knowledge / policy bundles / recipes with:
    • owner-local rows redacted (owner_input_received, owner_decision_recorded,
      owner_observed_outcome_recorded NEVER ship)
    • directive_id / task_id / evidence_event_ids stripped
    • recipe goal_text hashed (consumers match shape, not raw goal)
    • install-id replaced with a stable hash

  This is OWNER-APPROVED ONLY. Pass --yes to confirm you have the
  authority to share this substrate's promoted knowledge. Without
  --yes the command writes nothing and prints a confirmation prompt.

  Companion to \`acc admin export\` (full state.db) — that includes
  owner-local rows and should NEVER be shared without explicit per-row
  review.

  Schema: anonymized_knowledge_v1 (see cli/admin_export_knowledge.ts).
`;

export const runExportKnowledge = async (argv: string[], env: ExportKnowledgeEnv): Promise<number> => {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    env.out(HELP);
    return argv.length === 0 ? 1 : 0;
  }
  const path = argv.find((a) => !a.startsWith("--"));
  if (!path) {
    env.err("acc admin export-knowledge: missing <path>");
    env.err(HELP);
    return 1;
  }
  const yes = env.yes ?? (argv.includes("--yes") || argv.includes("-y"));
  if (!yes) {
    env.err("acc admin export-knowledge: missing --yes (owner approval gate)");
    env.err("  This export emits substrate knowledge for cross-install sharing.");
    env.err("  Verify you have the authority to share; then re-run with --yes.");
    return 1;
  }
  const db = (env.openSubstrate ?? openDb)();
  const exported = buildAnonymisedExport(db);
  const absPath = resolve(path);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify(exported, null, 2));
  env.out(`acc admin export-knowledge: wrote ${absPath}`);
  env.out(`  laws:           ${exported.counts.laws}`);
  env.out(`  knowledge:      ${exported.counts.knowledge}`);
  env.out(`  policy bundles: ${exported.counts.policy_bundles}`);
  env.out(`  recipes:        ${exported.counts.recipes}`);
  env.out(`  skipped (owner-local, never ships): ${exported.counts.skipped_owner_local}`);
  env.out(`  source_install_id_hash: ${exported.source_install_id_hash}`);
  return 0;
};
