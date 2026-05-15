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

/** Promote (or demote) ONE knowledge candidate by id — parallel API to
 *  `maybePromote` in artifact_store.ts. Returns the verdict so callers
 *  (Father, brain) can branch on the result without re-querying. The
 *  thresholds match the bulk extractor above so single-row and bulk
 *  passes are interchangeable. v2-design.md §3.6.1 + §7.2 + Phase Audit. */
export type KnowledgeVerdict =
  | { kind: "promoted"; candidate_id: string; score: number; confidence: number; alpha: number; beta: number }
  | { kind: "demoted"; candidate_id: string; score: number; confidence: number; alpha: number; beta: number }
  | { kind: "no_action"; candidate_id: string; score: number; confidence: number };

export const maybePromoteKnowledge = (db: Database, candidateId: string): KnowledgeVerdict => {
  const row = db
    .query(
      `SELECT id, directive_id, task_id, loop_id, substrate_origin, payload
       FROM events WHERE kind = 'knowledge_candidate' AND id = ?`,
    )
    .get(candidateId) as Record<string, unknown> | null;
  if (!row) return { kind: "no_action", candidate_id: candidateId, score: 0, confidence: 0 };

  // Already promoted/demoted?
  const already = db
    .query(
      `SELECT kind FROM events
       WHERE kind IN ('knowledge_promoted', 'knowledge_demoted')
         AND context_refs LIKE '%"' || ? || '"%'`,
    )
    .get(candidateId) as { kind: string } | null;
  if (already) {
    return { kind: "no_action", candidate_id: candidateId, score: 0, confidence: 0 };
  }

  const verdicts = db
    .query(
      `SELECT kind, context_refs FROM events
       WHERE kind IN ('candidate_confirmed', 'candidate_contradicted')`,
    )
    .all() as Array<{ kind: string; context_refs: string }>;
  let wins = 0;
  let losses = 0;
  for (const v of verdicts) {
    let refs: string[] = [];
    try { refs = JSON.parse(v.context_refs); } catch { /* skip */ }
    if (!refs.includes(candidateId)) continue;
    if (v.kind === "candidate_confirmed") wins++; else losses++;
  }
  const alpha = 1 + wins;
  const beta = 1 + losses;
  const score = betaMean(alpha, beta);
  const conf = betaConfidence(alpha, beta);

  if (wins >= POSTERIOR.countThreshold && score >= POSTERIOR.promoteScore) {
    insertEvent(db, {
      kind: "knowledge_promoted",
      directive_id: row.directive_id as string,
      task_id: row.task_id as string,
      loop_id: row.loop_id as string,
      substrate_origin: "substrate_auto",
      payload: { candidate_id: candidateId, wins, losses, score, confidence: conf, alpha, beta },
      context_refs: [candidateId],
    });
    return { kind: "promoted", candidate_id: candidateId, score, confidence: conf, alpha, beta };
  }
  if (losses >= POSTERIOR.countThreshold && score <= POSTERIOR.demoteScore) {
    insertEvent(db, {
      kind: "knowledge_demoted",
      directive_id: row.directive_id as string,
      task_id: row.task_id as string,
      loop_id: row.loop_id as string,
      substrate_origin: "substrate_auto",
      payload: { candidate_id: candidateId, wins, losses, score, confidence: conf, alpha, beta },
      context_refs: [candidateId],
    });
    return { kind: "demoted", candidate_id: candidateId, score, confidence: conf, alpha, beta };
  }
  return { kind: "no_action", candidate_id: candidateId, score, confidence: conf };
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
          `SELECT residual, directive_id, task_id, loop_id FROM events
           WHERE kind = 'action_scored' AND action_artifact_id = ? AND residual IS NOT NULL
           ORDER BY ts ASC`,
        )
        .all(art.id) as Array<{ residual: number; directive_id: string; task_id: string; loop_id: string }>;

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
      if (shouldPromote) {
        promoted++;
        // Brain audit B (2026-05-15): pre-fix extractCodeArtifactScores
        // updated the row's status but never emitted the canonical
        // code_artifact_promoted event. Operator surfaces (TUI artifact
        // panel, promotion telemetry) showed zero promotions even though
        // many artifacts crossed the bar. Emit at promotion time so the
        // event ledger is the source of truth. We attribute the row to
        // the LATEST action_scored that drove the posterior so the
        // directive/task lineage stays intact.
        const lastDriver = events[events.length - 1]!;
        insertEvent(db, {
          kind: "code_artifact_promoted",
          directive_id: lastDriver.directive_id,
          task_id: lastDriver.task_id,
          loop_id: lastDriver.loop_id,
          substrate_origin: "substrate_auto",
          payload: {
            artifact_id: art.id,
            score,
            confidence,
            posterior_alpha: alpha,
            posterior_beta: beta,
            sample_count: count,
            name: newName,
          },
          context_refs: [art.id],
        });
      }
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

/** Decode an event-embedding BLOB into a Float32Array. Tolerates non-aligned
 *  views — copies bytes into an aligned buffer before constructing the view. */
const decodeEmbeddingBlobLocal = (blob: Uint8Array | null): Float32Array | null => {
  if (!blob || blob.byteLength === 0) return null;
  if (blob.byteLength % 4 !== 0) return null;
  const aligned = new Uint8Array(blob.byteLength);
  aligned.set(blob);
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
};

const cosineSimilarity = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

const KNOWLEDGE_DEDUP_COSINE_THRESHOLD = 0.92;
const SYNTHESIS_CORROBORATION_THRESHOLD = 2;

/** Read text from a knowledge_candidate payload (handles `text` or `claim`). */
const candidateText = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  return ((p.text as string | undefined) ?? (p.claim as string | undefined) ?? "").toString();
};

export const extractSemanticDedup = (db: Database): SemanticDedupSummary => {
  const cursor = readMeta(db, META_KEYS.dedup);

  // New candidates since last run (with their embeddings + text).
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

  const haveEmbeddings = candidates.some((c) => c.embedding !== null);
  const latestTs = candidates[candidates.length - 1]!.ts;

  if (!haveEmbeddings) {
    // §3.6.1 Rule 1 needs cosine similarity; without embeddings we
    // cannot honestly dedup. We advance the cursor so we do not rescan
    // unembedded rows on every tick — the embedder worker will revisit
    // when text-embedding-3-small lands.
    writeMeta(db, META_KEYS.dedup, latestTs);
    return { merged: 0, contradicted: 0 };
  }

  // Existing open candidates (every candidate, including pre-cursor rows —
  // the new candidate must compare against ALL prior open candidates, not
  // only the new ones, so the merge is correct).
  const openCandidates = db
    .query(
      `SELECT id, ts, directive_id, task_id, loop_id, substrate_origin,
              payload, embedding
       FROM events
       WHERE kind = 'knowledge_candidate'
         AND embedding IS NOT NULL
       ORDER BY ts ASC`,
    )
    .all() as Array<{
      id: string;
      ts: string;
      directive_id: string;
      task_id: string;
      loop_id: string;
      substrate_origin: string;
      payload: string;
      embedding: Uint8Array;
    }>;

  // Already-synthesised candidate ids so we don't double-emit.
  const synthesisedFor = new Set(
    (db
      .query(`SELECT context_refs FROM events WHERE kind = 'knowledge_synthesized'`)
      .all() as Array<{ context_refs: string }>)
      .flatMap((r) => { try { return JSON.parse(r.context_refs) as string[]; } catch { return []; } }),
  );

  let merged = 0;
  let contradicted = 0;

  withImmediateTransaction(db, () => {
    for (const cand of candidates) {
      if (!cand.embedding) continue;
      const vecA = decodeEmbeddingBlobLocal(cand.embedding);
      if (!vecA) continue;
      const textA = candidateText(JSON.parse(cand.payload ?? "{}"));
      const polA = polarityOf(textA);

      // Compare against every prior candidate with an embedding.
      for (const prior of openCandidates) {
        if (prior.id === cand.id) continue;
        // Only consider strictly-earlier candidates so we don't re-match
        // the same pair twice in either direction.
        if (prior.ts > cand.ts) continue;
        const vecB = decodeEmbeddingBlobLocal(prior.embedding);
        if (!vecB) continue;
        if (vecB.length !== vecA.length) continue;
        const cos = cosineSimilarity(vecA, vecB);
        if (cos < KNOWLEDGE_DEDUP_COSINE_THRESHOLD) continue;
        const textB = candidateText(JSON.parse(prior.payload ?? "{}"));
        const polB = polarityOf(textB);

        if (polA === polB) {
          // Rule 1: dedup — attach the new candidate as corroborating evidence
          // on the prior candidate. We emit a candidate_confirmed citing the
          // prior candidate's id, carrying the new candidate's origin so
          // multi-origin corroboration is observable.
          insertEvent(db, {
            kind: "candidate_confirmed",
            directive_id: cand.directive_id,
            task_id: cand.task_id,
            loop_id: cand.loop_id,
            substrate_origin: "substrate_auto",
            payload: {
              corroborator_event_id: cand.id,
              corroborated_origin: cand.substrate_origin,
              cosine: cos,
              reason: "embedding_dedup",
            },
            context_refs: [prior.id, cand.id],
          });
          merged++;
          // Rule 3: synthesis when ≥ N corroborations from ≥ 2 distinct origins.
          if (!synthesisedFor.has(prior.id)) {
            const origins = (db
              .query(
                `SELECT DISTINCT substrate_origin FROM events
                 WHERE kind = 'candidate_confirmed'
                   AND context_refs LIKE '%"' || ? || '"%'`,
              )
              .all(prior.id) as Array<{ substrate_origin: string }>).map((r) => r.substrate_origin);
            const distinctOrigins = new Set([prior.substrate_origin, ...origins]);
            const corroborationCount = (db
              .query(
                `SELECT COUNT(*) AS c FROM events
                 WHERE kind = 'candidate_confirmed'
                   AND context_refs LIKE '%"' || ? || '"%'`,
              )
              .get(prior.id) as { c: number }).c;
            if (corroborationCount >= SYNTHESIS_CORROBORATION_THRESHOLD && distinctOrigins.size >= 2) {
              insertEvent(db, {
                kind: "knowledge_synthesized",
                directive_id: prior.directive_id,
                task_id: prior.task_id,
                loop_id: prior.loop_id,
                substrate_origin: "substrate_auto",
                payload: {
                  primary_candidate_id: prior.id,
                  synthesized_text: textB.length > 0 ? textB : textA,
                  corroborator_event_id: cand.id,
                  origins: Array.from(distinctOrigins),
                  corroboration_count: corroborationCount,
                },
                context_refs: [prior.id, cand.id],
              });
              synthesisedFor.add(prior.id);
            }
          }
        } else {
          // Rule 2: polarity disagreement → contradictory_candidates row.
          insertEvent(db, {
            kind: "contradictory_candidates",
            directive_id: cand.directive_id,
            task_id: cand.task_id,
            loop_id: cand.loop_id,
            substrate_origin: "substrate_auto",
            payload: {
              candidate_a: prior.id,
              candidate_b: cand.id,
              cosine: cos,
              polarity_a: polB,
              polarity_b: polA,
            },
            context_refs: [prior.id, cand.id],
          });
          contradicted++;
        }
      }
    }
    writeMeta(db, META_KEYS.dedup, latestTs);
  });

  return { merged, contradicted };
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

// ── 5. Recipe extraction on every commit (inline, post-task_committed) ─
//
// `extractRecipeCandidates` (above) is the statistical 3-success path —
// the brain accumulates evidence before the substrate commits to caching
// a trajectory at confidence=0.5. That cadence depends on Father / the
// rolling reviewer firing periodically, which under pre-flip defaults was
// off in tests and in fresh installs.
//
// `extractRecipeFromCommit` is the synchronous post-commit path the task
// dispatcher calls right after emitting `task_committed`. It records a
// recipe the FIRST time a (goal_shape, topology_signature) pair lands
// successfully — confidence=1.0 because the trajectory just succeeded in
// the wild. The 3-shape extractor will skip the same composite key on
// its next run (dedup is by composite key), so the two paths compose
// cleanly: a single successful commit seeds a high-confidence recipe;
// the statistical extractor remains the fallback that catches batches
// the inline path missed.
//
// Idempotent: looks up the latest recipe row for the same
// (goal_shape, topology_signature) before emitting. Re-running for the
// same directive is a no-op.

export type RecipeFromCommitSummary = { extracted: 0 | 1; recipe_id: string | null };

export const extractRecipeFromCommit = (
  db: Database,
  taskId: string,
): RecipeFromCommitSummary => {
  // Read the task_committed row — that's the anchor for the rest of the lookups.
  const committed = db
    .query(
      `SELECT id, ts, directive_id, task_id, loop_id
       FROM events
       WHERE kind = 'task_committed' AND task_id = ?
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(taskId) as { id: string; ts: string; directive_id: string; task_id: string; loop_id: string | null } | null;
  if (!committed) return { extracted: 0, recipe_id: null };

  const goalShape = goalShapeFor(db, committed.directive_id);
  const topology = topologySignatureFor(db, committed.directive_id);

  // Dedup by composite key — if a recipe already exists for this
  // (goal_shape, topology) we bump its confidence by +0.05 (the same
  // success delta updateRecipeConfidence applies on a successful Tier-0
  // replay). The brain just hand-proved the recipe's trajectory by
  // committing a task with the same goal_shape + topology, so the
  // recipe is observably correct.
  //
  // Without this bump, recipes seeded at 0.5 prior could NEVER reach
  // the 0.85 dispatch threshold — Tier-0 replay only fires above
  // threshold, and confidence only bumps from successful replays.
  // Catch-22. Now every brain-driven commit on a matching shape ratchets
  // the recipe toward Tier-0 eligibility (~7 brain successes = 0.85).
  const existingRows = db
    .query(
      `SELECT id, payload FROM events WHERE kind = 'recipe_extracted' ORDER BY ts DESC`,
    )
    .all() as Array<{ id: string; payload: string }>;
  for (const r of existingRows) {
    try {
      const p = JSON.parse(r.payload) as { goal_shape?: string; topology_signature?: string; confidence?: number };
      if (p.goal_shape === goalShape && p.topology_signature === topology) {
        // The originating recipe row exists. Find the LATEST confidence
        // for this composite key (recipes append new rows on each update)
        // and emit a fresh confidence-bumped row so the matcher reads it.
        let latestConfidence = typeof p.confidence === "number" ? p.confidence : 0.5;
        for (const r2 of existingRows) {
          try {
            const p2 = JSON.parse(r2.payload) as { goal_shape?: string; topology_signature?: string; confidence?: number };
            if (p2.goal_shape === goalShape && p2.topology_signature === topology) {
              if (typeof p2.confidence === "number") {
                latestConfidence = p2.confidence;
                break; // existingRows is ORDER BY ts DESC — first match is latest.
              }
            }
          } catch { /* skip */ }
        }
        // Idempotency: a single committed_task should bump confidence at
        // most ONCE. Look for an existing bump row whose context_refs
        // include this committed.id; if found, no-op.
        const alreadyBumped = db
          .query(
            `SELECT 1 FROM events
             WHERE kind = 'recipe_extracted'
               AND context_refs LIKE ?
               AND substrate_origin = 'substrate_auto'
               AND task_id = ?
             LIMIT 1`,
          )
          .get(`%${committed.id}%`, committed.task_id);
        const RECIPE_MAX_CONFIDENCE = 0.95;
        const bumped = Math.min(RECIPE_MAX_CONFIDENCE, latestConfidence + 0.05);
        if (!alreadyBumped && bumped > latestConfidence) {
          // Carry the seed row's trajectory across — the matcher reads the
          // LATEST row for a (goal_shape, topology) key, so the bump must
          // preserve the original trajectory or replayRecipe runs an empty
          // playback. Re-fetch from the seed `r` row's payload.
          let seedTrajectory: unknown = [];
          try {
            const seedPayload = JSON.parse(r.payload) as Record<string, unknown>;
            seedTrajectory = seedPayload.trajectory ?? [];
          } catch { /* leave empty array */ }
          try {
            insertEvent(db, {
              kind: "recipe_extracted",
              directive_id: committed.directive_id,
              task_id: committed.task_id,
              loop_id: committed.loop_id ?? "",
              substrate_origin: "substrate_auto",
              payload: {
                goal_shape: goalShape,
                topology_signature: topology,
                confidence: bumped,
                previous_confidence: latestConfidence,
                confidence_update: "brain_replay_success",
                derived_from_recipe_id: r.id,
                seeded_by: "inline_post_commit_bump",
                trajectory: seedTrajectory,
              },
              context_refs: [r.id, committed.id],
            });
          } catch { /* failure to write a bump row is non-fatal — recipe still matches */ }
        }
        return { extracted: 0, recipe_id: r.id };
      }
    } catch { /* skip malformed */ }
  }

  const trajectory = buildTrajectoryFor(db, committed.directive_id);
  let recipeId = "";
  withImmediateTransaction(db, () => {
    recipeId = insertEvent(db, {
      kind: "recipe_extracted",
      directive_id: committed.directive_id,
      task_id: committed.task_id,
      loop_id: committed.loop_id ?? "",
      substrate_origin: "substrate_auto",
      payload: {
        goal_shape: goalShape,
        topology_signature: topology,
        success_count: 1,
        window_days: 30,
        // Inline first-commit seed lands at the canonical 0.5 prior — below
        // the 0.6 replay threshold — so the recipe is observable but does
        // NOT yet preempt the brain. Two successful replays via
        // updateRecipeConfidence(+0.05 each) push it above threshold; that
        // matches the statistical extractor's prior so the two paths
        // converge on the same posterior trajectory.
        confidence: 0.5,
        directive_ids: [committed.directive_id],
        trajectory,
        seeded_by: "inline_post_commit",
      },
      context_refs: [committed.id],
    });
  });
  return { extracted: 1, recipe_id: recipeId };
};
