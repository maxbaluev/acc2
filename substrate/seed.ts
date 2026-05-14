// acc2 substrate seed — optional foundational knowledge import (§16) +
// the ten seed code artifacts (§11.4). Both functions are idempotent:
// re-running on a warm db produces zero new rows.
//
// Foundational knowledge is OWNER-APPROVED ONLY (k_3601-style explicit
// consent gate). Calling with {ownerApproved: false} is a no-op by
// design — the substrate refuses to seed without the owner's signal.
//
// Seed code artifacts enter at `admitted` with prior scores per the
// design table; the substrate IS the merger, so we never seed them
// directly into `promoted` — only repeated successful invocation
// (extractCodeArtifactScores §11.5 promotion path) earns that status.

import type { Database } from "bun:sqlite";
import { withImmediateTransaction } from "./db";
import type { CodeArtifactStatus, Runtime, SandboxDecl } from "./types";

const newId = (): string =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();

const nowIso = (): string => new Date().toISOString();

// ── meta gate ──────────────────────────────────────────────────────

const META_SEEDED_FOUNDATIONAL = "seed:foundational_knowledge";

const readMeta = (db: Database, key: string): string | null => {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
};

const writeMeta = (db: Database, key: string, value: string): void => {
  db.run(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
};

// ── Foundational knowledge — load-bearing principles ────────────────
//
// Each entry below carries the canonical text the merger would have
// promoted from real evidence. We mark them substrate_auto with a
// `skip_corroboration: true` flag (per §16) so the promotion event is
// honest about its synthetic provenance.

type FoundationalLaw = {
  text: string;
  tags: string[];
  score: number;
  confidence: number;
};

const SEED_LAWS: FoundationalLaw[] = [
  {
    text: "Verifier code artifacts return a scalar residual in [0,1]. 0 = goal met; 1 = goal missed.",
    tags: ["substrate", "verifier", "residual"],
    score: 0.95,
    confidence: 0.95,
  },
  {
    text: "Cycle-1-only is structural. The dispatcher rejects self-iteration; refinement edges replace cycle 2+.",
    tags: ["dispatcher", "cycle-1", "structural"],
    score: 0.95,
    confidence: 0.95,
  },
  {
    text: "v2 does not migrate from v1. The substrate launches empty; v1 is archived read-only.",
    tags: ["greenfield", "no-migration"],
    score: 0.95,
    confidence: 0.95,
  },
  {
    text: "Knowledge merger is owned by the substrate (Model D). Neither LLM judges its own candidate text.",
    tags: ["merger", "model-d", "substrate"],
    score: 0.95,
    confidence: 0.90,
  },
  {
    text: "Citation without state mutation is decorative memory. Every citation must mutate retrieval state.",
    tags: ["k_554", "retrieval", "mutation"],
    score: 0.90,
    confidence: 0.90,
  },
  {
    text: "Advisory gates do not change behavior. Make them hard. (k_252)",
    tags: ["k_252", "advisory", "hard"],
    score: 0.90,
    confidence: 0.90,
  },
  {
    text: "Four links — create, retrieve, mutate, credit — are owned by the substrate, not any LLM.",
    tags: ["k_555", "four-links", "rlm"],
    score: 0.95,
    confidence: 0.90,
  },
  {
    text: "Code artifacts admit at score=0.5/confidence=0.3 and earn 'promoted' only via accumulated action_scored evidence.",
    tags: ["latm", "voyager", "promotion"],
    score: 0.90,
    confidence: 0.85,
  },
  {
    text: "Owner channel is Claude Code chat only. No telegram, no email, no licensed-expert routing.",
    tags: ["owner-channel", "subscription-cli-only"],
    score: 0.95,
    confidence: 0.95,
  },
  {
    text: "Declared sandbox != actual usage at runtime emits sandbox_violation and quarantines the artifact.",
    tags: ["sandbox", "quarantine", "k_252"],
    score: 0.90,
    confidence: 0.85,
  },
];

export type FoundationalSeedSummary = { imported: number };

export const seedFoundationalKnowledge = (
  db: Database,
  options?: { ownerApproved?: boolean },
): FoundationalSeedSummary => {
  if (!options?.ownerApproved) {
    return { imported: 0 };
  }
  if (readMeta(db, META_SEEDED_FOUNDATIONAL) !== null) {
    return { imported: 0 };
  }

  const directiveId = "dir_seed_foundational";
  const loopId = "loop_seed_foundational";
  const taskId = "task_seed_foundational";
  let imported = 0;

  withImmediateTransaction(db, () => {
    for (const law of SEED_LAWS) {
      const candidateId = newId();
      db.run(
        `INSERT INTO events (
           id, ts, directive_id, task_id, loop_id, substrate_origin,
           kind, payload, context_refs
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          candidateId,
          nowIso(),
          directiveId,
          taskId,
          loopId,
          "substrate_auto",
          "knowledge_candidate",
          JSON.stringify({
            text: law.text,
            tags: law.tags,
            proposed_tier: "law",
            derived_from: ["v1_archive_import", "v2_design_md"],
            confidence_estimate: law.confidence,
            skip_corroboration: true,
          }),
          JSON.stringify([]),
        ],
      );
      const promoteId = newId();
      db.run(
        `INSERT INTO events (
           id, ts, directive_id, task_id, loop_id, substrate_origin,
           kind, payload, context_refs
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          promoteId,
          nowIso(),
          directiveId,
          taskId,
          loopId,
          "substrate_auto",
          "knowledge_promoted",
          JSON.stringify({
            candidate_id: candidateId,
            score: law.score,
            confidence: law.confidence,
            skip_corroboration: true,
          }),
          JSON.stringify([candidateId]),
        ],
      );
      imported++;
    }
    writeMeta(db, META_SEEDED_FOUNDATIONAL, nowIso());
  });

  return { imported };
};

// ── Seed code artifacts (§11.4) ────────────────────────────────────

type SeedArtifact = {
  seedName: string;        // stable: id = `seed_<seedName>`
  runtime: Runtime;
  body: string;
  declared_sandbox: SandboxDecl;
  state_root: string;
  initial_score: number;
  initial_confidence: number;
  fixture_input: unknown;
  fixture_expected_residual: number;
  display_name: string;
};

const SEED_ARTIFACTS: SeedArtifact[] = [
  {
    seedName: "substrate_read",
    runtime: "bun",
    body: [
      "// substrate_read — query the events table or a substrate view.",
      "// args: { sql: string, params?: unknown[] }",
      "export default async (db, args) => {",
      "  return db.query(args.sql).all(...(args.params ?? []));",
      "};",
    ].join("\n"),
    declared_sandbox: {
      runtime: "bun",
      substrate_access: "ro",
      cpu_ms: 2000,
      wall_ms: 5000,
      memory_mb: 128,
    },
    state_root: "substrate/read",
    initial_score: 0.95,
    initial_confidence: 0.95,
    fixture_input: { sql: "SELECT 1 AS x" },
    fixture_expected_residual: 0.0,
    display_name: "substrate_read",
  },
  {
    seedName: "substrate_save",
    runtime: "bun",
    body: [
      "// substrate_save — append a single event row to the substrate.",
      "// args: { kind, directive_id, task_id, loop_id, substrate_origin, payload }",
      "export default async (db, args, { newId, nowIso }) => {",
      "  const id = newId();",
      "  db.run(",
      "    `INSERT INTO events (id, ts, directive_id, task_id, loop_id,",
      "       substrate_origin, kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,",
      "    [id, nowIso(), args.directive_id, args.task_id, args.loop_id,",
      "     args.substrate_origin, args.kind, JSON.stringify(args.payload ?? {})],",
      "  );",
      "  return id;",
      "};",
    ].join("\n"),
    declared_sandbox: {
      runtime: "bun",
      substrate_access: "rw",
      cpu_ms: 2000,
      wall_ms: 5000,
      memory_mb: 128,
    },
    state_root: "substrate/save",
    initial_score: 0.95,
    initial_confidence: 0.95,
    fixture_input: {
      kind: "owner_input_received",
      directive_id: "d_fixture",
      task_id: "t_fixture",
      loop_id: "l_fixture",
      substrate_origin: "owner",
      payload: { text: "fixture ping" },
    },
    fixture_expected_residual: 0.0,
    display_name: "substrate_save",
  },
  {
    seedName: "substrate_embed",
    runtime: "bun",
    body: "// stub Phase B+: will be authored per LATM. Computes text-embedding-3-small over args.text + stores in events.embedding.",
    declared_sandbox: {
      runtime: "bun",
      substrate_access: "rw",
      net_allow: ["api.openai.com"],
      cpu_ms: 5000,
      wall_ms: 15000,
      memory_mb: 256,
    },
    state_root: "substrate/embed",
    initial_score: 0.90,
    initial_confidence: 0.85,
    fixture_input: { text: "hello world" },
    fixture_expected_residual: 0.0,
    display_name: "substrate_embed",
  },
  {
    seedName: "substrate_search",
    runtime: "bun",
    body: "// stub Phase B+: will be authored per LATM. Embedding+posterior reranked retrieval over substrate view rows.",
    declared_sandbox: {
      runtime: "bun",
      substrate_access: "ro",
      cpu_ms: 5000,
      wall_ms: 10000,
      memory_mb: 256,
    },
    state_root: "substrate/search",
    initial_score: 0.90,
    initial_confidence: 0.85,
    fixture_input: { query: "verifier residual" },
    fixture_expected_residual: 0.0,
    display_name: "substrate_search",
  },
  {
    seedName: "agent_invoke",
    runtime: "bun",
    body: "// stub Phase B+: will be authored per LATM. Spawns a sub-agent (Claude or opencode) for a sub-directive.",
    declared_sandbox: {
      runtime: "bun",
      proc_allow: ["claude", "opencode"],
      cpu_ms: 5000,
      wall_ms: 120000,
      memory_mb: 256,
    },
    state_root: "substrate/agent_invoke",
    initial_score: 0.85,
    initial_confidence: 0.75,
    fixture_input: { sub_directive: "fixture: echo ok" },
    fixture_expected_residual: 0.0,
    display_name: "agent_invoke",
  },
  {
    seedName: "web_search",
    runtime: "bun",
    body: "// stub Phase B+: will be authored per LATM. Serper.dev wrapper for web search.",
    declared_sandbox: {
      runtime: "bun",
      net_allow: ["google.serper.dev"],
      cpu_ms: 5000,
      wall_ms: 15000,
      memory_mb: 128,
    },
    state_root: "substrate/web_search",
    initial_score: 0.80,
    initial_confidence: 0.70,
    fixture_input: { query: "OpenAI text-embedding-3-small" },
    fixture_expected_residual: 0.0,
    display_name: "web_search",
  },
  {
    seedName: "web_fetch_and_parse",
    runtime: "bun",
    body: "// stub Phase B+: will be authored per LATM. HTTP fetch + readability extract.",
    declared_sandbox: {
      runtime: "bun",
      net_allow: ["*"],
      cpu_ms: 10000,
      wall_ms: 30000,
      memory_mb: 256,
    },
    state_root: "substrate/web_fetch",
    initial_score: 0.75,
    initial_confidence: 0.70,
    fixture_input: { url: "https://example.com" },
    fixture_expected_residual: 0.0,
    display_name: "web_fetch_and_parse",
  },
  {
    seedName: "browser_session_act",
    runtime: "camofox-browser",
    body: "// stub Phase B+: will be authored per LATM. Opens chromium against a profile, runs a sequence of page operations.",
    declared_sandbox: {
      runtime: "camofox-browser",
      browser_allow_domains: ["example.com"],
      browser_profile_root: "/var/acc2/browser/profile",
      wall_ms: 60000,
      memory_mb: 1024,
    },
    state_root: "substrate/browser",
    initial_score: 0.75,
    initial_confidence: 0.65,
    fixture_input: { url: "https://example.com", actions: [] },
    fixture_expected_residual: 0.0,
    display_name: "browser_session_act",
  },
  {
    seedName: "shell_run",
    runtime: "bun",
    body: "// stub Phase B+: will be authored per LATM. Spawn a subprocess with declared argv.",
    declared_sandbox: {
      runtime: "bun",
      proc_allow: ["echo", "ls", "cat"],
      cpu_ms: 5000,
      wall_ms: 10000,
      memory_mb: 128,
    },
    state_root: "substrate/shell",
    initial_score: 0.80,
    initial_confidence: 0.70,
    fixture_input: { argv: ["echo", "ok"] },
    fixture_expected_residual: 0.0,
    display_name: "shell_run",
  },
  {
    seedName: "py_run",
    runtime: "uv",
    body: "# stub Phase B+: will be authored per LATM. Run a Python snippet under nsjail with declared deps.",
    declared_sandbox: {
      runtime: "uv",
      pypi_allow: [],
      cpu_ms: 10000,
      wall_ms: 30000,
      memory_mb: 256,
    },
    state_root: "substrate/py",
    initial_score: 0.75,
    initial_confidence: 0.70,
    fixture_input: { code: "print('ok')" },
    fixture_expected_residual: 0.0,
    display_name: "py_run",
  },
];

export type CodeArtifactSeedSummary = { inserted: number; skipped: number };

const seedIdFor = (seedName: string): string => `seed_${seedName}`;

export const seedCodeArtifacts = (db: Database): CodeArtifactSeedSummary => {
  let inserted = 0;
  let skipped = 0;
  const initialStatus: CodeArtifactStatus = "admitted";

  withImmediateTransaction(db, () => {
    for (const seed of SEED_ARTIFACTS) {
      const id = seedIdFor(seed.seedName);
      const existing = db.query("SELECT id FROM code_artifact WHERE id = ?").get(id);
      if (existing) {
        skipped++;
        continue;
      }
      const ts = nowIso();
      const alpha = 1 + seed.initial_score * 4;
      const beta = 1 + (1 - seed.initial_score) * 4;
      db.run(
        `INSERT INTO code_artifact (
           id, runtime, body, declared_sandbox, state_root,
           posterior_alpha, posterior_beta, score, confidence,
           recent_residual_mean, recent_kill_count, status, name,
           fixture_input, fixture_expected_residual,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          seed.runtime,
          seed.body,
          JSON.stringify(seed.declared_sandbox),
          seed.state_root,
          alpha,
          beta,
          seed.initial_score,
          seed.initial_confidence,
          0.0,
          0,
          initialStatus,
          seed.display_name,
          JSON.stringify(seed.fixture_input),
          seed.fixture_expected_residual,
          ts,
          ts,
        ],
      );
      inserted++;
    }
  });

  return { inserted, skipped };
};

/** Convenience helper — primarily for tests / the daemon boot path.
 *  Returns the canonical seed ids so callers can join against them. */
export const seedArtifactIds = (): string[] => SEED_ARTIFACTS.map((s) => seedIdFor(s.seedName));
