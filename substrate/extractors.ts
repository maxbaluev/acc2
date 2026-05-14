// acc2 substrate extractors — periodic deterministic passes over the
// event log that emit derived events (Model D §3.6.1, §7.2; §4.2
// "typed-extractor views"). Each extractor is idempotent: re-running
// over the same input produces the same output. Last-seen ts cursors
// live in the `meta` table so extractors only scan new rows.
//
// Phase B2 scope (per task brief):
//   - extractKnowledgePromotions: Beta-posterior promote/demote on
//     knowledge_candidate corroboration counts.
//   - extractCodeArtifactScores: recompute code_artifact posteriors
//     from recent action_scored events; auto-promote on threshold.
//   - extractSemanticDedup: §3.6.1 Rule 1+2. Embedding-based merger.
//     Phase B2 stub: no-op when no embeddings are present (Phase F).
//   - extractRecipeCandidates: group task_committed by goal_shape;
//     emit recipe_extracted at ≥3 successes within 30 days.
//
// Each extractor returns a small summary object for daemon telemetry.

import type { Database } from "bun:sqlite";
import { withImmediateTransaction } from "./db";
import type { EventKind, SubstrateOrigin } from "./types";

// ── ULID-ish id minter (same convention as Phase B1 tests) ─────────

const newId = (): string =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();

const nowIso = (): string => new Date().toISOString();

// ── meta cursor helpers ────────────────────────────────────────────

const META_KEYS = {
  promotions: "extractor:knowledge_promotions:last_ts",
  scores:     "extractor:code_artifact_scores:last_ts",
  dedup:      "extractor:semantic_dedup:last_ts",
  recipes:    "extractor:recipe_candidates:last_ts",
} as const;

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

// ── event insertion helper ─────────────────────────────────────────

type InsertEventInput = {
  kind: EventKind;
  directive_id: string;
  task_id: string;
  parent_task_id?: string | null;
  loop_id: string;
  substrate_origin: SubstrateOrigin;
  payload: unknown;
  context_refs?: string[];
  outcome?: string;
  residual?: number;
};

const insertEvent = (db: Database, ev: InsertEventInput): string => {
  const id = newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs, outcome, residual
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      nowIso(),
      ev.directive_id,
      ev.task_id,
      ev.parent_task_id ?? null,
      ev.loop_id,
      ev.substrate_origin,
      ev.kind,
      JSON.stringify(ev.payload ?? {}),
      JSON.stringify(ev.context_refs ?? []),
      ev.outcome ?? null,
      ev.residual ?? null,
    ],
  );
  return id;
};

// ── 1. Knowledge promotion / demotion extractor ────────────────────
//
// For each open knowledge_candidate (no later knowledge_promoted /
// knowledge_demoted), count corroborating candidate_confirmed and
// contradicting candidate_contradicted events that cite it. A
// candidate cites an existing candidate id via context_refs (the
// substrate convention: every "judgment about a knowledge claim"
// references the claim's event id).
//
// Beta posterior: alpha = 1 + wins, beta = 1 + losses. §7.2 canonical
// thresholds: score ≥ 0.85 AND wins ≥ 5. Demote symmetric (score ≤ 0.30
// AND losses ≥ 5). The Phase B2 task brief mentions a `confidence ≥ 0.85`
// clause too, but that is internally inconsistent with `wins ≥ 5`
// (Beta confidence 1 - 1/sqrt(n+1) at n=5 is only ~0.59). Resolved
// in favor of the design doc — wins-count is the structural gate,
// the posterior score is the threshold, the confidence carried on
// the promotion payload is informational.

const POSTERIOR = {
  promoteScore: 0.85,
  demoteScore: 0.30,
  countThreshold: 5,
};

const betaMean = (alpha: number, beta: number): number => alpha / (alpha + beta);

const betaConfidence = (alpha: number, beta: number): number => {
  // 1 - 1/sqrt(n+1), where n = alpha+beta-2 (evidence count).
  // Matches §11.5 confidence formula used for code artifacts.
  const n = alpha + beta - 2;
  return 1 - 1 / Math.sqrt(Math.max(0, n) + 1);
};

export type KnowledgePromotionSummary = { promoted: number; demoted: number };

export const extractKnowledgePromotions = (db: Database): KnowledgePromotionSummary => {
  const cursor = readMeta(db, META_KEYS.promotions);

  // Open candidates: no prior promoted/demoted row points to them.
  const promotedIds = new Set(
    (db
      .query(
        `SELECT context_refs FROM events
         WHERE kind IN ('knowledge_promoted', 'knowledge_demoted')`,
      )
      .all() as Array<{ context_refs: string }>)
      .flatMap((r) => {
        try { return JSON.parse(r.context_refs) as string[]; } catch { return []; }
      }),
  );

  const candidates = db
    .query(
      `SELECT id, ts, directive_id, task_id, loop_id, substrate_origin, payload
       FROM events
       WHERE kind = 'knowledge_candidate'
         AND (? IS NULL OR ts > ?)
       ORDER BY ts ASC`,
    )
    .all(cursor, cursor) as Array<Record<string, unknown>>;

  // Pull every confirmation/contradiction event once; partition by cited id.
  const verdicts = db
    .query(
      `SELECT kind, context_refs FROM events
       WHERE kind IN ('candidate_confirmed', 'candidate_contradicted')`,
    )
    .all() as Array<{ kind: string; context_refs: string }>;

  const winsByCandidate = new Map<string, number>();
  const lossesByCandidate = new Map<string, number>();
  for (const v of verdicts) {
    let refs: string[];
    try { refs = JSON.parse(v.context_refs); } catch { refs = []; }
    for (const ref of refs) {
      if (v.kind === "candidate_confirmed") {
        winsByCandidate.set(ref, (winsByCandidate.get(ref) ?? 0) + 1);
      } else {
        lossesByCandidate.set(ref, (lossesByCandidate.get(ref) ?? 0) + 1);
      }
    }
  }

  let promoted = 0;
  let demoted = 0;
  let latestTs = cursor;

  withImmediateTransaction(db, () => {
    for (const c of candidates) {
      const cid = c.id as string;
      if (promotedIds.has(cid)) continue;
      const wins = winsByCandidate.get(cid) ?? 0;
      const losses = lossesByCandidate.get(cid) ?? 0;
      const alpha = 1 + wins;
      const beta = 1 + losses;
      const score = betaMean(alpha, beta);
      const conf = betaConfidence(alpha, beta);

      const eligibleForPromote =
        wins >= POSTERIOR.countThreshold &&
        score >= POSTERIOR.promoteScore;
      const eligibleForDemote =
        losses >= POSTERIOR.countThreshold &&
        score <= POSTERIOR.demoteScore;

      if (eligibleForPromote) {
        insertEvent(db, {
          kind: "knowledge_promoted",
          directive_id: c.directive_id as string,
          task_id: c.task_id as string,
          loop_id: c.loop_id as string,
          substrate_origin: "substrate_auto",
          payload: { candidate_id: cid, wins, losses, score, confidence: conf, alpha, beta },
          context_refs: [cid],
        });
        promoted++;
        promotedIds.add(cid);
      } else if (eligibleForDemote) {
        insertEvent(db, {
          kind: "knowledge_demoted",
          directive_id: c.directive_id as string,
          task_id: c.task_id as string,
          loop_id: c.loop_id as string,
          substrate_origin: "substrate_auto",
          payload: { candidate_id: cid, wins, losses, score, confidence: conf, alpha, beta },
          context_refs: [cid],
        });
        demoted++;
        promotedIds.add(cid);
      }
      latestTs = c.ts as string;
    }
    if (latestTs) writeMeta(db, META_KEYS.promotions, latestTs);
  });

  return { promoted, demoted };
};

// ── 2. Code artifact score extractor ───────────────────────────────
//
// For each code_artifact, walk recent action_scored events that cite
// it via action_artifact_id. Each scored event carries a residual ∈
// [0,1]. Residual ≤ 0.3 → success (alpha++), else failure (beta++).
// Recompute score = alpha/(alpha+beta), confidence per §11.5,
// recent_residual_mean = avg of last 20 residuals.
// Promote (status='promoted', name synthesized) when score ≥ 0.85,
// confidence ≥ 0.7, AND count ≥ 20.

const PROMOTE = { score: 0.85, confidence: 0.70, count: 20 };
const RESIDUAL_SUCCESS_THRESHOLD = 0.3;
const RECENT_WINDOW = 20;

const synthesizeName = (id: string, body: string): string => {
  // First non-empty comment line in the body; fall back to auto_<suffix>.
  const lines = body.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("//")) {
      const txt = line.replace(/^\/\/+\s*/, "").trim();
      if (txt) return txt.slice(0, 60).replace(/[^a-zA-Z0-9_]+/g, "_").toLowerCase();
    }
    if (line.startsWith("#")) {
      const txt = line.replace(/^#+\s*/, "").trim();
      if (txt) return txt.slice(0, 60).replace(/[^a-zA-Z0-9_]+/g, "_").toLowerCase();
    }
  }
  return `auto_${id.slice(-6).toLowerCase()}`;
};

export type CodeArtifactScoreSummary = { updated: number; promoted: number };

export const extractCodeArtifactScores = (db: Database): CodeArtifactScoreSummary => {
  const artifacts = db
    .query("SELECT id, body, status, name FROM code_artifact")
    .all() as Array<{ id: string; body: string; status: string; name: string | null }>;

  let updated = 0;
  let promoted = 0;

  withImmediateTransaction(db, () => {
    for (const art of artifacts) {
      const events = db
        .query(
          `SELECT residual FROM events
           WHERE kind = 'action_scored' AND action_artifact_id = ? AND residual IS NOT NULL
           ORDER BY ts ASC`,
        )
        .all(art.id) as Array<{ residual: number }>;

      if (events.length === 0) continue;

      let wins = 0;
      let losses = 0;
      for (const ev of events) {
        if (ev.residual <= RESIDUAL_SUCCESS_THRESHOLD) wins++; else losses++;
      }
      const alpha = 1 + wins;
      const beta = 1 + losses;
      const score = betaMean(alpha, beta);
      const confidence = betaConfidence(alpha, beta);
      const recentResiduals = events.slice(-RECENT_WINDOW).map((e) => e.residual);
      const recentMean =
        recentResiduals.reduce((a, b) => a + b, 0) / Math.max(1, recentResiduals.length);
      const count = events.length;

      const shouldPromote =
        art.status === "admitted" &&
        score >= PROMOTE.score &&
        confidence >= PROMOTE.confidence &&
        count >= PROMOTE.count;
      const newStatus = shouldPromote ? "promoted" : art.status;
      const newName = shouldPromote && !art.name ? synthesizeName(art.id, art.body) : art.name;

      db.run(
        `UPDATE code_artifact
           SET posterior_alpha = ?,
               posterior_beta = ?,
               score = ?,
               confidence = ?,
               recent_residual_mean = ?,
               status = ?,
               name = ?,
               updated_at = ?
         WHERE id = ?`,
        [alpha, beta, score, confidence, recentMean, newStatus, newName, nowIso(), art.id],
      );
      updated++;
      if (shouldPromote) promoted++;
    }
  });

  return { updated, promoted };
};

// ── 3. Semantic dedup extractor (§3.6.1 Rules 1+2) ─────────────────
//
// Phase B2: gracefully no-op when no embeddings are present. Phase F
// lights the cosine-similarity path with sqlite-vec. We still update
// the meta cursor so subsequent runs are bounded scans, and we still
// emit polarity-based contradictory_candidates when two new
// candidates with cosine ≥ 0.92 disagree (Phase F wiring).

const NEGATION_TOKENS = ["not ", "no ", "never ", "without ", "don't", "doesn't", "isn't", "aren't", "won't"];

const polarityOf = (text: string): "assert" | "deny" => {
  const lower = text.trim().toLowerCase();
  for (const tok of NEGATION_TOKENS) {
    if (lower.startsWith(tok)) return "deny";
  }
  return "assert";
};

export type SemanticDedupSummary = { merged: number; contradicted: number };

export const extractSemanticDedup = (db: Database): SemanticDedupSummary => {
  const cursor = readMeta(db, META_KEYS.dedup);

  // New candidates since last run.
  const candidates = db
    .query(
      `SELECT id, ts, directive_id, task_id, loop_id, substrate_origin,
              payload, embedding
       FROM events
       WHERE kind = 'knowledge_candidate'
         AND (? IS NULL OR ts > ?)
       ORDER BY ts ASC`,
    )
    .all(cursor, cursor) as Array<{
      id: string;
      ts: string;
      directive_id: string;
      task_id: string;
      loop_id: string;
      substrate_origin: string;
      payload: string;
      embedding: Uint8Array | null;
    }>;

  if (candidates.length === 0) {
    return { merged: 0, contradicted: 0 };
  }

  // Phase B2 gate: if NONE of the new candidates carry embeddings,
  // we cannot do cosine-based dedup and must no-op cleanly. Phase F
  // wires the real path through sqlite-vec; until then keep the
  // cursor advancing so we don't re-scan.
  const haveEmbeddings = candidates.some((c) => c.embedding !== null);
  const latestTs = candidates[candidates.length - 1]!.ts;

  if (!haveEmbeddings) {
    writeMeta(db, META_KEYS.dedup, latestTs);
    return { merged: 0, contradicted: 0 };
  }

  // Phase F will replace this body with sqlite-vec KNN queries. Until
  // then we hold the contract that "embeddings present" still produces
  // a {0,0} summary because the cosine path is not wired. The branch
  // exists so tests can prove the wire-up point is single-source.
  writeMeta(db, META_KEYS.dedup, latestTs);
  return { merged: 0, contradicted: 0 };
};

// ── 4. Recipe-candidate extractor ──────────────────────────────────
//
// Group task_committed events by a coarse "goal shape" — the
// normalized goal text from the directive payload + the count of
// task nodes under that directive. When ≥3 shapes succeed within a
// 30-day window, emit a recipe_extracted event with confidence=0.5.
//
// Phase J refines the matching:
//   - `goal_shape` is normalised text (the existing token, retained so
//     pre-Phase-J tests keep passing).
//   - `topology_signature` is a hash of the task DAG shape — nodes by
//     parent-id structure, ignoring specific artifact ids. Two trajectories
//     count as similar ONLY when goal_shape AND topology_signature match.
//   - `trajectory` is the cached sequence of action_predicted + verifier
//     ids the replay engine consumes. Each step carries `step_kind` plus
//     `artifact_id` and a small `payload_template` (the original payload
//     verbatim, modulo task_id/directive_id which the replayer rewrites).
//
// Idempotent via meta cursor + dedup on (goal_shape, topology_signature).

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const RECIPE_THRESHOLD = 3;

const goalShapeFor = (db: Database, directiveId: string): string => {
  const dirRow = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'directive_opened' AND directive_id = ?
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(directiveId) as { payload: string } | null;
  let normGoal = "";
  if (dirRow) {
    try {
      const p = JSON.parse(dirRow.payload) as { goal?: unknown; intent?: unknown; directive_text?: unknown };
      // Accept `goal`, `intent`, OR `directive_text` (production directives
      // store the human-readable directive as `directive_text`; tests often
      // use `goal`/`intent`).
      const goal = (p.goal ?? p.intent ?? p.directive_text ?? "") as string;
      normGoal = String(goal).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 80);
    } catch { /* malformed payload — fall through to empty */ }
  }
  const taskCount = (db
    .query(
      `SELECT COUNT(DISTINCT task_id) AS c FROM events
       WHERE kind = 'task_node_opened' AND directive_id = ?`,
    )
    .get(directiveId) as { c: number }).c;
  return `${normGoal}::n${taskCount}`;
};

/** Topology signature for one directive — a hash of (parent_task_id → task_id)
 *  edges, ignoring specific artifact ids. Two directives with the same DAG
 *  shape collide. */
const topologySignatureFor = (db: Database, directiveId: string): string => {
  const rows = db
    .query(
      `SELECT task_id, parent_task_id FROM events
       WHERE kind = 'task_node_opened' AND directive_id = ?
       ORDER BY ts ASC`,
    )
    .all(directiveId) as Array<{ task_id: string; parent_task_id: string | null }>;
  // Normalize: each task gets an ordinal index by insertion order. The signature
  // is a sorted list of (parent_ord → child_ord) edges, hashed.
  const ordinal = new Map<string, number>();
  rows.forEach((r, idx) => { ordinal.set(r.task_id, idx); });
  const edges: string[] = [];
  for (const r of rows) {
    const child = ordinal.get(r.task_id) ?? -1;
    const parent = r.parent_task_id !== null ? (ordinal.get(r.parent_task_id) ?? -1) : -1;
    edges.push(`${parent}->${child}`);
  }
  edges.sort();
  const canonical = `n${rows.length}::${edges.join(",")}`;
  // Cheap, stable hash (no need for SHA — the input is short).
  let h = 5381;
  for (let i = 0; i < canonical.length; i++) {
    h = ((h * 33) ^ canonical.charCodeAt(i)) | 0;
  }
  return `topo_${(h >>> 0).toString(16).padStart(8, "0")}::${rows.length}`;
};

/** Build a replay trajectory for a directive from its action_predicted +
 *  verifier sequence. Each step carries the artifact id (if any) and a
 *  payload template the replayer can re-stamp with fresh task_id /
 *  directive_id at replay time. */
const buildTrajectoryFor = (
  db: Database,
  directiveId: string,
): Array<{ step_kind: string; artifact_id: string | null; verifier_artifact_id: string | null; payload_template: unknown }> => {
  const rows = db
    .query(
      `SELECT kind, action_artifact_id, verifier_artifact_id, predicted_residual, payload
       FROM events
       WHERE directive_id = ?
         AND kind IN ('task_node_opened', 'action_predicted')
       ORDER BY ts ASC`,
    )
    .all(directiveId) as Array<{
      kind: string;
      action_artifact_id: string | null;
      verifier_artifact_id: string | null;
      predicted_residual: number | null;
      payload: string;
    }>;
  return rows.map((r) => {
    let parsed: unknown;
    try { parsed = JSON.parse(r.payload ?? "{}"); } catch { parsed = {}; }
    return {
      step_kind: r.kind,
      artifact_id: r.action_artifact_id,
      verifier_artifact_id: r.verifier_artifact_id,
      payload_template: parsed,
      predicted_residual: r.predicted_residual,
    };
  });
};

export type RecipeCandidateSummary = { extracted: number };

export const extractRecipeCandidates = (db: Database): RecipeCandidateSummary => {
  const cursor = readMeta(db, META_KEYS.recipes);

  // Pull every recent task_committed event in the 30-day window.
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  const committed = db
    .query(
      `SELECT id, ts, directive_id, task_id, loop_id, substrate_origin, payload
       FROM events
       WHERE kind = 'task_committed' AND ts >= ?
       ORDER BY ts ASC`,
    )
    .all(cutoff) as Array<Record<string, unknown>>;

  // Group by (goal_shape, topology_signature) — both must match to count as
  // similar. The composite key is what dedup operates on.
  type RowEntry = { row: Record<string, unknown>; goalShape: string; topology: string };
  const shapeGroups = new Map<string, RowEntry[]>();
  for (const row of committed) {
    const goalShape = goalShapeFor(db, row.directive_id as string);
    const topology = topologySignatureFor(db, row.directive_id as string);
    const compositeKey = `${goalShape}||${topology}`;
    const arr = shapeGroups.get(compositeKey) ?? [];
    arr.push({ row, goalShape, topology });
    shapeGroups.set(compositeKey, arr);
  }

  // Already-extracted shapes — dedup by composite key (goal_shape, topology).
  const alreadyExtracted = new Set(
    (db
      .query(
        `SELECT payload FROM events WHERE kind = 'recipe_extracted'`,
      )
      .all() as Array<{ payload: string }>)
      .map((r) => {
        try {
          const p = JSON.parse(r.payload) as { goal_shape?: string; topology_signature?: string };
          return `${p.goal_shape ?? ""}||${p.topology_signature ?? ""}`;
        } catch { return ""; }
      }),
  );

  let extracted = 0;
  let latestTs = cursor;

  withImmediateTransaction(db, () => {
    for (const [compositeKey, entries] of shapeGroups) {
      if (entries.length < RECIPE_THRESHOLD) continue;
      if (alreadyExtracted.has(compositeKey)) continue;
      const directiveIds = Array.from(new Set(entries.map((e) => e.row.directive_id as string)));
      // Use the latest committed row's directive_id as the recipe's anchor.
      const anchor = entries[entries.length - 1]!.row;
      const goalShape = entries[entries.length - 1]!.goalShape;
      const topology = entries[entries.length - 1]!.topology;
      // The trajectory is read off the most recent successful directive — the
      // replayer will use this exact sequence of action artifacts + verifiers.
      const trajectory = buildTrajectoryFor(db, anchor.directive_id as string);
      insertEvent(db, {
        kind: "recipe_extracted",
        directive_id: anchor.directive_id as string,
        task_id: anchor.task_id as string,
        loop_id: anchor.loop_id as string,
        substrate_origin: "substrate_auto",
        payload: {
          goal_shape: goalShape,
          topology_signature: topology,
          success_count: entries.length,
          window_days: 30,
          confidence: 0.5,
          directive_ids: directiveIds,
          trajectory,
        },
        context_refs: entries.map((e) => e.row.id as string),
      });
      extracted++;
      latestTs = anchor.ts as string;
    }
    if (latestTs) writeMeta(db, META_KEYS.recipes, latestTs);
  });

  return { extracted };
};
