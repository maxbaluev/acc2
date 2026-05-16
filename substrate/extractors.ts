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
import type { EventKind, OwnerProfile, SubstrateOrigin } from "./types";
import { OWNER_PROFILE_DEFAULTS, OWNER_PROFILE_JSON_SCHEMA } from "./types";
import { parseResourceRefs } from "../runtime/resource_uri";
import { decodeEmbeddingBlob } from "../runtime/embedder";
import { betaMean as canonicalBetaMean, betaEvidenceConfidence } from "../runtime/posterior";

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
  // Universal act-loop fields (k_555 spine support): action_predicted +
  // action_scored events carry these, and substrate.credit traverses
  // them at credit-distribution time. Without writing these columns,
  // any spine the extractors emit is invisible to retrieval-by-artifact.
  action_artifact_id?: string;
  verifier_artifact_id?: string;
  predicted_residual?: number;
};

const insertEvent = (db: Database, ev: InsertEventInput): string => {
  const id = newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs, outcome, residual,
       action_artifact_id, verifier_artifact_id, predicted_residual
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ev.action_artifact_id ?? null,
      ev.verifier_artifact_id ?? null,
      ev.predicted_residual ?? null,
    ],
  );
  return id;
};

// ── k_555 four-link spine helper ───────────────────────────────────
//
// Every substrate-side promotion / demotion / extraction event the
// extractors emit IS its own action: the extractor logic is the
// action, the posterior calculation (or schema validation) is the
// verifier, residual=0 on success. Without action_predicted +
// action_scored events citing the same candidate, substrate.credit
// has no row to attach Shapley-weighted credit to — the inspiring
// candidate's Beta posterior never updates from the promotion.
//
// emitPromotionSpine writes the three rows atomically and returns
// their ids so the caller can wire context_refs through. The
// artifactPrefix names a stable pseudo-artifact pair
// (`<prefix>_action` + `<prefix>_verifier`); it doesn't have to
// correspond to a real registered code_artifact row, but it must
// be stable so substrate.search-by-artifact-id can group the action
// chains for posterior aggregation.

type PromotionResultKind =
  | "knowledge_promoted"
  | "knowledge_demoted"
  | "code_artifact_promoted"
  | "recipe_extracted"
  | "owner_profile_recorded";

const emitPromotionSpine = (
  db: Database,
  args: {
    kind: PromotionResultKind;
    candidate_id: string;
    directive_id: string;
    task_id: string;
    loop_id: string;
    payload: Record<string, unknown>;
    artifact_prefix: string;
    extra_context_refs?: string[];
  },
): { action_id: string; scored_id: string; result_id: string } => {
  const baseRefs = [args.candidate_id, ...(args.extra_context_refs ?? [])];
  const action_id = insertEvent(db, {
    kind: "action_predicted",
    directive_id: args.directive_id,
    task_id: args.task_id,
    loop_id: args.loop_id,
    substrate_origin: "substrate_auto",
    action_artifact_id: `${args.artifact_prefix}_action`,
    verifier_artifact_id: `${args.artifact_prefix}_verifier`,
    predicted_residual: 0,
    payload: { candidate_id: args.candidate_id, target_kind: args.kind },
    context_refs: baseRefs,
  });
  const scored_id = insertEvent(db, {
    kind: "action_scored",
    directive_id: args.directive_id,
    task_id: args.task_id,
    loop_id: args.loop_id,
    substrate_origin: "substrate_auto",
    action_artifact_id: `${args.artifact_prefix}_action`,
    verifier_artifact_id: `${args.artifact_prefix}_verifier`,
    outcome: "succeeded",
    residual: 0,
    payload: { candidate_id: args.candidate_id, target_kind: args.kind },
    context_refs: [...baseRefs, action_id],
  });
  const result_id = insertEvent(db, {
    kind: args.kind,
    directive_id: args.directive_id,
    task_id: args.task_id,
    loop_id: args.loop_id,
    substrate_origin: "substrate_auto",
    payload: { ...args.payload, action_event_id: action_id, scored_event_id: scored_id },
    context_refs: [...baseRefs, action_id, scored_id],
  });
  // Close the credit loop: call distributeCredit so the cited candidate
  // (+ extra_context_refs) get candidate_confirmed evidence on the
  // promotion. Without this, the spine events exist but no credit
  // flows to inspiring candidates' Beta posteriors — the loop is
  // open. The synthetic-actuator path in runtime/credit.ts handles
  // the missing-artifact case cleanly (skip artifact posterior,
  // continue with citation credit). Best-effort: errors are logged
  // but don't roll back the promotion.
  void import("../runtime/credit")
    .then(({ distributeCredit }) => distributeCredit(db, {
      action_event_id: action_id,
      observation_event_id: scored_id,
      scored_event_id: scored_id,
      predicted_residual: 0,
      observed_residual: 0,
    }))
    .catch(() => { /* extractor cadence remains best-effort */ });
  return { action_id, scored_id, result_id };
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
  // Brain knowledge audit bc5vdkrik finding #3 (2026-05-15): the rigid
  // (wins ≥ 5 AND score ≥ 0.85) gate favored near-duplicate stamping
  // and under-promoted rich non-duplicate insights. Multi-origin
  // corroboration is a STRONGER signal than count alone — two distinct
  // substrate_origin values confirming the same claim is harder to
  // forge than five stamps from the same origin. Lower the score bar
  // when the confirmations come from ≥ 2 origins.
  multiOriginPromoteScore: 0.75,
  multiOriginMinCount: 3,
  multiOriginMinOrigins: 2,
};

// Canonical Beta math lives in `runtime/posterior.ts`. Local aliases
// preserve the existing call-site names (`betaMean`, `betaConfidence`)
// and keep the surrounding diff minimal. `betaConfidence` resolves to
// the evidence-count variant `1 − 1/√(max(0, α + β − 2) + 1)` so the
// Beta(1, 1) prior reads as zero confirmations (v2-design.md §11.5).
const betaMean = canonicalBetaMean;
const betaConfidence = betaEvidenceConfidence;

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
  // Track substrate_origin per win so the multi-origin promotion gate can
  // count distinct origins. Brain knowledge audit bc5vdkrik #3.
  //
  // Time-decay (2026-05-15): each verdict event is weighted by
  // exp(-dt/halfLife) where dt is the age of the verdict in ms. Older
  // confirmations contribute less than fresh ones — stops a knowledge
  // entry from being locked in by ancient corroborations when recent
  // reality contradicts it. Half-life mirrors artifact_store.ts
  // (default 30 days, override via ACC2_POSTERIOR_HALF_LIFE_MS).
  // Brain-side negative knowledge (gap #2, 2026-05-15): the brain can
  // DIRECTLY mutate a knowledge entry's posterior toward contradiction
  // via knowledge_contradiction_observed. Treated identically to
  // candidate_contradicted for the count, but with a single citation
  // path (payload.knowledge_id → context_refs[0] effective).
  const verdicts = db
    .query(
      `SELECT kind, substrate_origin, ts, context_refs, payload FROM events
       WHERE kind IN ('candidate_confirmed', 'candidate_contradicted', 'knowledge_contradiction_observed')`,
    )
    .all() as Array<{ kind: string; substrate_origin: string; ts: string; context_refs: string; payload: string }>;

  const halfLifeMs = 30 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const verdictWeight = (ts: string): number => {
    if (halfLifeMs <= 0) return 1;
    const verdictMs = Date.parse(ts);
    if (!Number.isFinite(verdictMs)) return 1;
    const ageMs = Math.max(0, nowMs - verdictMs);
    return Math.pow(0.5, ageMs / halfLifeMs);
  };

  const winsByCandidate = new Map<string, number>();
  const lossesByCandidate = new Map<string, number>();
  const winOriginsByCandidate = new Map<string, Set<string>>();
  for (const v of verdicts) {
    let refs: string[];
    try { refs = JSON.parse(v.context_refs); } catch { refs = []; }
    // knowledge_contradiction_observed carries the knowledge_id in
    // payload (not necessarily context_refs); pull it explicitly so
    // brain-side contradictions land on the right entry.
    if (v.kind === "knowledge_contradiction_observed") {
      try {
        const p = JSON.parse(v.payload ?? "{}") as Record<string, unknown>;
        const kid = p.knowledge_id as string | undefined;
        if (kid && !refs.includes(kid)) refs.push(kid);
      } catch { /* skip malformed */ }
    }
    const ageWeight = verdictWeight(v.ts);
    // Brain-side negative knowledge may declare its own weight via
    // payload.weight (default 0.5 — the brain's snap judgment counts
    // less than an action-validated contradiction by default). The
    // declared weight × the time-decay weight gives the final
    // contribution.
    let weightMul = 1;
    if (v.kind === "knowledge_contradiction_observed") {
      try {
        const p = JSON.parse(v.payload ?? "{}") as Record<string, unknown>;
        const w = p.weight;
        weightMul = (typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= 1) ? w : 0.5;
      } catch { weightMul = 0.5; }
    }
    const w = ageWeight * weightMul;
    for (const ref of refs) {
      if (v.kind === "candidate_confirmed") {
        winsByCandidate.set(ref, (winsByCandidate.get(ref) ?? 0) + w);
        const origins = winOriginsByCandidate.get(ref) ?? new Set<string>();
        origins.add(v.substrate_origin);
        winOriginsByCandidate.set(ref, origins);
      } else {
        // candidate_contradicted OR knowledge_contradiction_observed
        lossesByCandidate.set(ref, (lossesByCandidate.get(ref) ?? 0) + w);
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

      const originsCount = winOriginsByCandidate.get(cid)?.size ?? 0;
      const eligibleForPromoteStrict =
        wins >= POSTERIOR.countThreshold &&
        score >= POSTERIOR.promoteScore;
      // Brain knowledge audit bc5vdkrik #3 (2026-05-15): multi-origin
      // corroboration relaxes the score bar from 0.85 to 0.75 with a
      // lower count requirement (≥ 3) when confirmations come from
      // ≥ 2 distinct substrate_origin values. Forging two origins is
      // structurally harder than stamping five identical near-duplicates.
      const eligibleForPromoteMultiOrigin =
        wins >= POSTERIOR.multiOriginMinCount &&
        score >= POSTERIOR.multiOriginPromoteScore &&
        originsCount >= POSTERIOR.multiOriginMinOrigins;
      const eligibleForPromote = eligibleForPromoteStrict || eligibleForPromoteMultiOrigin;
      const eligibleForDemote =
        losses >= POSTERIOR.countThreshold &&
        score <= POSTERIOR.demoteScore;

      if (eligibleForPromote) {
        // Domain-aware annotation (Batch 1 — 2026-05-15): if the source
        // candidate carries rich-schema applies_to[] + confidence_estimate
        // fields, propagate them onto the promotion event so downstream
        // consumers (retrieval reranker, prompt composer, TUI) can filter
        // / rank by domain. Flat candidates carry no annotation and the
        // promotion stays domain-global (backward compatible).
        let appliesTo: string[] | undefined;
        let candConfidenceEstimate: number | undefined;
        let claimSnippet: string | undefined;
        try {
          const cp = JSON.parse((c.payload as string) ?? "{}") as Record<string, unknown>;
          if (Array.isArray(cp.applies_to)) appliesTo = (cp.applies_to as unknown[]).map(String);
          if (typeof cp.confidence_estimate === "number") candConfidenceEstimate = cp.confidence_estimate;
          claimSnippet = (cp.claim as string | undefined) ??
            (cp.text as string | undefined) ??
            (cp.summary as string | undefined);
        } catch { /* skip annotation */ }
        emitPromotionSpine(db, {
          kind: "knowledge_promoted",
          candidate_id: cid,
          directive_id: c.directive_id as string,
          task_id: c.task_id as string,
          loop_id: c.loop_id as string,
          artifact_prefix: "knowledge_promotion",
          payload: {
            candidate_id: cid,
            wins,
            losses,
            score,
            confidence: conf,
            alpha,
            beta,
            origin_count: originsCount,
            promotion_path: eligibleForPromoteStrict ? "strict" : "multi_origin",
            applies_to: appliesTo,
            candidate_confidence_estimate: candConfidenceEstimate,
            claim_snippet: claimSnippet,
          },
        });
        promoted++;
        promotedIds.add(cid);
      } else if (eligibleForDemote) {
        emitPromotionSpine(db, {
          kind: "knowledge_demoted" as PromotionResultKind,
          candidate_id: cid,
          directive_id: c.directive_id as string,
          task_id: c.task_id as string,
          loop_id: c.loop_id as string,
          artifact_prefix: "knowledge_demotion",
          payload: { candidate_id: cid, wins, losses, score, confidence: conf, alpha, beta },
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
    emitPromotionSpine(db, {
      kind: "knowledge_promoted",
      candidate_id: candidateId,
      directive_id: row.directive_id as string,
      task_id: row.task_id as string,
      loop_id: row.loop_id as string,
      artifact_prefix: "knowledge_promotion",
      payload: { candidate_id: candidateId, wins, losses, score, confidence: conf, alpha, beta },
    });
    return { kind: "promoted", candidate_id: candidateId, score, confidence: conf, alpha, beta };
  }
  if (losses >= POSTERIOR.countThreshold && score <= POSTERIOR.demoteScore) {
    emitPromotionSpine(db, {
      kind: "knowledge_demoted" as PromotionResultKind,
      candidate_id: candidateId,
      directive_id: row.directive_id as string,
      task_id: row.task_id as string,
      loop_id: row.loop_id as string,
      artifact_prefix: "knowledge_demotion",
      payload: { candidate_id: candidateId, wins, losses, score, confidence: conf, alpha, beta },
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
        emitPromotionSpine(db, {
          kind: "code_artifact_promoted",
          candidate_id: art.id,
          directive_id: lastDriver.directive_id,
          task_id: lastDriver.task_id,
          loop_id: lastDriver.loop_id,
          artifact_prefix: "code_artifact_promotion",
          payload: {
            artifact_id: art.id,
            score,
            confidence,
            posterior_alpha: alpha,
            posterior_beta: beta,
            sample_count: count,
            name: newName,
          },
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

// Embedder dedup (audit T3AUDEMBEDDER5M7 follow-up, owner-approved
// 2026-05-16): the local decodeEmbeddingBlob copy is gone — imported
// from runtime/embedder.ts as the single source of truth.

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
    // cannot honestly dedup. Organism-alignment audit b3qc9ryzj
    // finding #8 (2026-05-15): pre-fix this branch advanced the
    // cursor PAST unembedded candidates so they were never revisited
    // — when the embedder worker later filled the embedding column,
    // those rows had ts older than the cursor and got permanently
    // skipped, breaking the four-link credit chain for those entries.
    // Fix: do NOT advance the cursor when no embeddings landed yet.
    // The next tick will rescan the same window; once the embedder
    // fills at least one row, the loop falls through to the dedup
    // pass and advances honestly.
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
      const vecA = decodeEmbeddingBlob(cand.embedding);
      if (!vecA) continue;
      const textA = candidateText(JSON.parse(cand.payload ?? "{}"));
      const polA = polarityOf(textA);

      // Compare against every prior candidate with an embedding.
      for (const prior of openCandidates) {
        if (prior.id === cand.id) continue;
        // Only consider strictly-earlier candidates so we don't re-match
        // the same pair twice in either direction.
        if (prior.ts > cand.ts) continue;
        const vecB = decodeEmbeddingBlob(prior.embedding);
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
              fusion_method: prior.substrate_origin === cand.substrate_origin ? "same_origin_dedup" : "cross_origin_beta_evidence",
              merger_quality_axes: {
                agreement_similarity: cos,
                cross_origin: prior.substrate_origin === cand.substrate_origin ? 0 : 1,
              },
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
          if (prior.substrate_origin !== cand.substrate_origin) {
            insertEvent(db, {
              kind: "merger_debate_required",
              directive_id: cand.directive_id,
              task_id: cand.task_id,
              loop_id: cand.loop_id,
              substrate_origin: "substrate_auto",
              payload: {
                candidate_a: prior.id,
                candidate_b: cand.id,
                origins: [prior.substrate_origin, cand.substrate_origin],
                cosine: cos,
                polarity_a: polB,
                polarity_b: polA,
                reason: "cross_origin_polarity_disagreement",
                merger_quality_axes: {
                  contradiction_similarity: cos,
                  cross_origin: 1,
                },
              },
              context_refs: [prior.id, cand.id],
            });
          }
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

/** Read the event ids that actually drove the trajectory for a
 *  directive — task_node_opened + action_predicted + action_scored
 *  rows in chronological order. recipe_extracted then cites these
 *  via context_refs so the credit chain has explicit pointers from
 *  every recipe back to the actions that proved it. Without these
 *  citations, recipe → action posterior credit had no path; brain
 *  audit by166hjyv flagged this as a credit-spine gap. */
const trajectoryEventIdsFor = (db: Database, directiveId: string): string[] => {
  const rows = db
    .query(
      `SELECT id FROM events
       WHERE directive_id = ?
         AND kind IN ('task_node_opened', 'action_predicted', 'action_scored')
       ORDER BY ts ASC, rowid ASC`,
    )
    .all(directiveId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
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
      const entryIds = entries.map((e) => e.row.id as string);
      // Cite trajectory event ids (task_node_opened / action_predicted /
      // action_scored) for the anchor directive so the recipe carries
      // explicit credit pointers back to the actions that proved it.
      // Brain audit by166hjyv flagged this as a credit-spine gap: without
      // these citations, distributeCredit could only reach the cluster
      // entries, not the underlying action_scored ancestors.
      const trajectoryRefs = trajectoryEventIdsFor(db, anchor.directive_id as string);
      emitPromotionSpine(db, {
        kind: "recipe_extracted",
        candidate_id: entryIds[0]!,
        extra_context_refs: [...entryIds.slice(1), ...trajectoryRefs],
        directive_id: anchor.directive_id as string,
        task_id: anchor.task_id as string,
        loop_id: anchor.loop_id as string,
        artifact_prefix: "recipe_cluster_extraction",
        payload: {
          goal_shape: goalShape,
          topology_signature: topology,
          success_count: entries.length,
          window_days: 30,
          confidence: 0.5,
          directive_ids: directiveIds,
          trajectory,
        },
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
            emitPromotionSpine(db, {
              kind: "recipe_extracted",
              candidate_id: r.id,                       // the seed recipe being bumped
              extra_context_refs: [committed.id],       // the successful commit driving the bump
              directive_id: committed.directive_id,
              task_id: committed.task_id,
              loop_id: committed.loop_id ?? "",
              artifact_prefix: "recipe_confidence_bump",
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

// ──────────────────────────────────────────────────────────────────────
// Auto cross-directive interference detection (organism-alignment Track C,
// 2026-05-15). Scans code_artifact rows for overlapping normalized
// target_resources across directives. Artifacts without valid target_resources
// fail closed; target_files are display compatibility only, not matching input.
// When two distinct directives admit artifacts that touch the same resource, that's a structural `resource_conflict` —
// dispatching them concurrently risks racing edits. Emits one
// `directive_interference_edge` event per discovered conflict; dedupes
// against existing edges so re-running is a no-op.
//
// Pre-fix the substrate had the mechanism (`directive_interference_edge`
// kind + scheduler defer logic) but only manual `substrate.record_
// interference_edge` calls populated it. Parallel multi-goal work was
// therefore racing on shared files invisibly.

export type DirectiveInterferenceSummary = { proposed: number; deduped: number };

const collectArtifactDirectives = (
  db: Database,
): Map<string, Map<string, Set<string>>> => {
  // resource_uri -> directive_id -> Set<artifact_id>
  // Two distinct directives sharing a resource -> resource_conflict.
  const byResource = new Map<string, Map<string, Set<string>>>();

  // code_artifact.source_candidate_id points back to the originating
  // code_artifact_candidate event; that event's directive_id is the
  // artifact's owning goal. Old artifacts without source_candidate_id
  // are skipped — they pre-date the schema and we don't synthesize
  // ownership from heuristics (PRIOR 2: never silently fallback).
  const rows = db
    .query(
      `SELECT
         a.id                 AS artifact_id,
         a.target_resources   AS target_resources,
         e.directive_id       AS directive_id
       FROM code_artifact a
       LEFT JOIN events e
         ON e.kind = 'code_artifact_candidate'
        AND e.id = a.source_candidate_id
       WHERE a.target_resources IS NOT NULL
         AND a.source_candidate_id IS NOT NULL
         AND a.status IN ('admitted', 'promoted')`,
    )
    .all() as Array<{ artifact_id: string; target_resources: string | null; directive_id: string | null }>;

  for (const r of rows) {
    if (!r.directive_id) continue;
    const resources = parseResourceRefs(r.target_resources);
    if (!resources) continue;
    for (const resourceRef of resources) {
      const resource = resourceRef.uri;
      const byDirective = byResource.get(resource) ?? new Map<string, Set<string>>();
      const artifacts = byDirective.get(r.directive_id) ?? new Set<string>();
      artifacts.add(r.artifact_id);
      byDirective.set(r.directive_id, artifacts);
      byResource.set(resource, byDirective);
    }
  }
  return byResource;
};

const readExistingInterferencePairs = (db: Database): Set<string> => {
  // Build a "from→to|kind" set so we can dedupe. resource_conflict is
  // symmetric: we treat (a→b) and (b→a) as the same edge for the dedup
  // check by also adding the reverse key.
  const out = new Set<string>();
  const rows = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'directive_interference_edge'`,
    )
    .all() as Array<{ payload: string }>;
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      const from = p.from_directive as string | undefined;
      const to = p.to_directive as string | undefined;
      const kind = p.kind as string | undefined;
      if (!from || !to || !kind) continue;
      out.add(`${from}|${to}|${kind}`);
      out.add(`${to}|${from}|${kind}`);
    } catch { /* skip */ }
  }
  return out;
};

export const extractDirectiveInterference = (
  db: Database,
): DirectiveInterferenceSummary => {
  const byResource = collectArtifactDirectives(db);
  const existing = readExistingInterferencePairs(db);
  let proposed = 0;
  let deduped = 0;

  // For each resource with > 1 owning directive, emit pairwise edges. The
  // owning-artifact ids land in the payload as evidence so an operator
  // can audit which artifacts are causing the conflict.
  for (const [resource, byDirective] of byResource) {
    const directives = [...byDirective.keys()];
    if (directives.length < 2) continue;
    for (let i = 0; i < directives.length; i++) {
      for (let j = i + 1; j < directives.length; j++) {
        const a = directives[i]!;
        const b = directives[j]!;
        const key = `${a}|${b}|resource_conflict`;
        if (existing.has(key)) { deduped++; continue; }
        const evidenceA = [...byDirective.get(a)!];
        const evidenceB = [...byDirective.get(b)!];
        insertEvent(db, {
          kind: "directive_interference_edge",
          directive_id: a,
          substrate_origin: "substrate_auto",
          payload: {
            from_directive: a,
            to_directive: b,
            kind: "resource_conflict",
            reason: `shared_target_resource:${resource}`,
            shared_resource: resource,
            evidence_artifacts_from: evidenceA,
            evidence_artifacts_to: evidenceB,
            detected_by: "extractDirectiveInterference",
          },
          context_refs: [...evidenceA, ...evidenceB],
        });
        proposed++;
        existing.add(key);
        existing.add(`${b}|${a}|resource_conflict`);
      }
    }
  }
  return { proposed, deduped };
};

// ──────────────────────────────────────────────────────────────────────
// 6. Owner-profile promotion (Layer-2 autonomy, brain dispatch
//    ZMJQQ963Z124V7VS amendment, 2026-05-15).
//
// `owner_insight_candidate` events carry one assertion about owner
// preferences:
//   payload = { field: keyof OwnerProfile, value: unknown, confidence: number, claim: string }
// Promotion rule (per substrate/types.ts:14-26 design comment):
//   (a) sibling cosine ≥ 0.85 against another owner_insight_candidate
//       AND the sibling's confidence supports the same field/value, OR
//   (b) payload.confidence ≥ 0.85 (high-confidence single-origin), OR
//   (c) an explicit owner_decision_recorded with payload.decision === "approve"
//       cites this candidate's id (manual approval bypass).
//
// On promotion: merge the assertion's field into the latest
// owner_profile_recorded row's payload, validate against
// OWNER_PROFILE_JSON_SCHEMA, and emit a NEW owner_profile_recorded with the
// merged JSON. Validation failure drops the candidate silently — the
// runtime stays fail-closed against malformed data.
//
// Idempotent: a candidate already cited as a context_ref by a prior
// owner_profile_recorded row is skipped.

const OWNER_PROFILE_PROMOTE_CONFIDENCE_THRESHOLD = 0.85;
const OWNER_PROFILE_COSINE_THRESHOLD = 0.85;

// Mini JSON-schema validator — handles the OWNER_PROFILE_JSON_SCHEMA shape
// (object/array/enum/string-min-max/integer-min-max). Returns true when
// the value conforms; false on any structural violation. Keep this local
// to extractors.ts so we don't pull in a 1MB ajv dep for a 100-line shape.
const validateAgainstSchema = (value: unknown, schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return true;
  const s = schema as Record<string, unknown>;
  if (s.enum && Array.isArray(s.enum)) {
    return (s.enum as unknown[]).includes(value);
  }
  if (s.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const props = (s.properties as Record<string, unknown> | undefined) ?? {};
    const additional = s.additionalProperties;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k in props) {
        if (!validateAgainstSchema(v, props[k])) return false;
      } else if (additional === false) {
        return false;
      }
    }
    return true;
  }
  if (s.type === "array") {
    if (!Array.isArray(value)) return false;
    const items = s.items;
    for (const v of value) {
      if (!validateAgainstSchema(v, items)) return false;
    }
    return true;
  }
  if (s.type === "string") {
    if (typeof value !== "string") return false;
    if (typeof s.minLength === "number" && value.length < (s.minLength as number)) return false;
    if (typeof s.maxLength === "number" && value.length > (s.maxLength as number)) return false;
    return true;
  }
  if (s.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return false;
    if (typeof s.minimum === "number" && value < (s.minimum as number)) return false;
    if (typeof s.maximum === "number" && value > (s.maximum as number)) return false;
    return true;
  }
  if (s.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (typeof s.minimum === "number" && value < (s.minimum as number)) return false;
    if (typeof s.maximum === "number" && value > (s.maximum as number)) return false;
    return true;
  }
  return true;
};

// Meta fields the substrate stamps on each owner_profile_recorded row
// for audit (which candidate inspired this promotion + via which route).
// They are NOT part of OWNER_PROFILE_JSON_SCHEMA; strip them when reading
// back so a subsequent merge + re-validate doesn't trip
// additionalProperties=false.
const OWNER_PROFILE_META_FIELDS = [
  "promoted_from",
  "promotion_route",
  // k_555 spine pointers — added 2026-05-15 when the owner_profile
  // promoter started emitting action_predicted + action_scored before
  // each owner_profile_recorded. They live on the row for audit but
  // aren't part of OWNER_PROFILE_JSON_SCHEMA, so re-validation on
  // subsequent merge passes would fail without stripping them.
  "action_event_id",
  "scored_event_id",
] as const;

const readLatestOwnerProfile = (db: Database): OwnerProfile => {
  // ts has 1-second resolution in some test envs; the rowid tiebreaker
  // ensures we get the GENUINELY-LATEST row when two promotions land
  // in the same second (common in test setups + back-to-back tick
  // promotions in production).
  const row = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'owner_profile_recorded'
       ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get() as { payload: string } | null;
  if (!row) return { ...OWNER_PROFILE_DEFAULTS } as OwnerProfile;
  try {
    const parsed = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
    for (const m of OWNER_PROFILE_META_FIELDS) delete parsed[m];
    return { ...OWNER_PROFILE_DEFAULTS, ...parsed } as OwnerProfile;
  } catch {
    return { ...OWNER_PROFILE_DEFAULTS } as OwnerProfile;
  }
};

const candidateAlreadyPromoted = (db: Database, candidateId: string): boolean => {
  const row = db
    .query(
      `SELECT 1 AS x FROM events
       WHERE kind = 'owner_profile_recorded'
         AND context_refs LIKE '%"' || ? || '"%'
       LIMIT 1`,
    )
    .get(candidateId) as { x: number } | null;
  return row !== null;
};

const ownerApprovalExists = (db: Database, candidateId: string): boolean => {
  const rows = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'owner_decision_recorded'
         AND context_refs LIKE '%"' || ? || '"%'`,
    )
    .all(candidateId) as Array<{ payload: string }>;
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      if (typeof p.decision === "string" && p.decision.toLowerCase() === "approve") return true;
    } catch { /* skip malformed */ }
  }
  return false;
};

const siblingCosineSupports = (
  db: Database,
  candidateId: string,
  field: string,
): boolean => {
  // Pull the candidate's embedding + sibling embeddings (other open
  // owner_insight_candidate rows targeting the SAME field). If cosine ≥
  // OWNER_PROFILE_COSINE_THRESHOLD against any sibling, that's
  // multi-origin corroboration the dedup path can latch onto.
  const me = db
    .query("SELECT embedding FROM events WHERE id = ?")
    .get(candidateId) as { embedding: Uint8Array | null } | null;
  if (!me?.embedding) return false;
  const vecA = decodeEmbeddingBlob(me.embedding);
  if (!vecA) return false;
  const siblings = db
    .query(
      `SELECT id, payload, embedding FROM events
       WHERE kind = 'owner_insight_candidate'
         AND id != ?
         AND embedding IS NOT NULL`,
    )
    .all(candidateId) as Array<{ id: string; payload: string; embedding: Uint8Array }>;
  for (const s of siblings) {
    try {
      const sp = JSON.parse(s.payload ?? "{}") as Record<string, unknown>;
      if (sp.field !== field) continue;
      const vecB = decodeEmbeddingBlob(s.embedding);
      if (!vecB || vecB.length !== vecA.length) continue;
      const cos = cosineSimilarity(vecA, vecB);
      if (cos >= OWNER_PROFILE_COSINE_THRESHOLD) return true;
    } catch { /* skip */ }
  }
  return false;
};

export type OwnerProfileVerdict =
  | { kind: "promoted"; candidate_id: string; recorded_event_id: string; field: string; route: "cosine" | "confidence" | "owner_approval" }
  | { kind: "no_action"; candidate_id: string; reason: string };

/** Promote a single owner_insight_candidate into a fresh
 *  owner_profile_recorded row when promotion rules fire. Returns the
 *  verdict so callers can audit / surface. Idempotent: a candidate
 *  already cited by an owner_profile_recorded row is skipped. */
export const maybePromoteOwnerProfile = (
  db: Database,
  sourceCandidateId: string,
): OwnerProfileVerdict => {
  const row = db
    .query(
      `SELECT id, directive_id, task_id, loop_id, substrate_origin, payload
       FROM events
       WHERE kind = 'owner_insight_candidate' AND id = ?`,
    )
    .get(sourceCandidateId) as Record<string, unknown> | null;
  if (!row) {
    return { kind: "no_action", candidate_id: sourceCandidateId, reason: "candidate_missing" };
  }
  if (candidateAlreadyPromoted(db, sourceCandidateId)) {
    return { kind: "no_action", candidate_id: sourceCandidateId, reason: "already_promoted" };
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse((row.payload as string) ?? "{}") as Record<string, unknown>;
  } catch {
    return { kind: "no_action", candidate_id: sourceCandidateId, reason: "payload_unparseable" };
  }
  const field = payload.field;
  const value = payload.value;
  const confidence = typeof payload.confidence === "number" ? payload.confidence : 0;
  if (typeof field !== "string" || field.length === 0) {
    return { kind: "no_action", candidate_id: sourceCandidateId, reason: "missing_field" };
  }
  // Field must be one of OwnerProfile's keys — anything else is rejected
  // before we touch the profile (fail closed).
  const allowedFields = Object.keys(OWNER_PROFILE_JSON_SCHEMA.properties as Record<string, unknown>);
  if (!allowedFields.includes(field)) {
    return { kind: "no_action", candidate_id: sourceCandidateId, reason: "field_not_in_owner_profile" };
  }

  // Determine the promotion route.
  let route: "cosine" | "confidence" | "owner_approval" | null = null;
  if (ownerApprovalExists(db, sourceCandidateId)) {
    route = "owner_approval";
  } else if (confidence >= OWNER_PROFILE_PROMOTE_CONFIDENCE_THRESHOLD) {
    route = "confidence";
  } else if (siblingCosineSupports(db, sourceCandidateId, field)) {
    route = "cosine";
  }
  if (!route) {
    return { kind: "no_action", candidate_id: sourceCandidateId, reason: "no_promotion_route" };
  }

  // Merge the assertion's value into the latest profile.
  //
  // ADDITIVE-MERGE fields (Record<string, …>): rendering_signals and
  // exposed_concepts are open-ended maps that DIFFERENT producers
  // contribute different keys to. Pure-replace would overwrite the
  // entire map every time a new key arrived. For these fields, we
  // shallow-merge: existing keys stay, new keys are added, conflicting
  // keys are overwritten with the new value (so signal updates land).
  //
  // PURE-REPLACE fields (everything else): scalars (autonomy_score,
  // detected_language) replace cleanly. Arrays (preferred_terms,
  // avoided_terms, hot_topics, things_to_never_do) are also replace —
  // the producers (vocabulary extractor, brain emit) always send the
  // FULL current list, so replace is correct + cheap.
  const ADDITIVE_RECORD_FIELDS = new Set([
    "rendering_signals",
    "autonomy_signals",
    "control_signals",
    "risk_signals",
    "collaboration_signals",
    "goal_continuity_signals",
    "exposed_concepts",
    "understood_concepts",
    "declined_concepts",
  ]);
  const latest = readLatestOwnerProfile(db);
  const merged: Record<string, unknown> = { ...latest };
  if (ADDITIVE_RECORD_FIELDS.has(field) && value && typeof value === "object" && !Array.isArray(value)) {
    const existing = merged[field];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      merged[field] = { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      merged[field] = value;
    }
  } else {
    merged[field] = value;
  }
  // The defaults set `time_window: null` to mark "no window declared";
  // the schema only describes the object shape (no null union), so
  // strip null values before validation. Same for any other null-marker
  // defaults — schema validation runs against present fields only.
  const forValidation: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== null && v !== undefined) forValidation[k] = v;
  }

  // Validate the merged profile against the JSON schema before emitting.
  if (!validateAgainstSchema(forValidation, OWNER_PROFILE_JSON_SCHEMA)) {
    return { kind: "no_action", candidate_id: sourceCandidateId, reason: "schema_validation_failed" };
  }

  let recordedId = "";
  let actionId = "";
  let scoredId = "";
  withImmediateTransaction(db, () => {
    // Close the k_555 four-link spine: action_predicted → action_scored →
    // owner_profile_recorded. Without the predict/score pair,
    // substrate.credit has no action_scored row to attach Shapley
    // credit to, and the source candidate's Beta posterior never
    // updates from this promotion. The promoter IS its own action:
    // the merge is the action, the schema validation is the verifier,
    // residual=0 because the validator returned true.
    actionId = insertEvent(db, {
      kind: "action_predicted",
      directive_id: (row.directive_id as string) ?? "owner_profile",
      task_id: (row.task_id as string) ?? "owner_profile",
      loop_id: (row.loop_id as string) ?? "loop_root",
      substrate_origin: "substrate_auto",
      action_artifact_id: "owner_profile_promoter_action",
      verifier_artifact_id: "owner_profile_schema_verifier",
      predicted_residual: 0,
      payload: { candidate_id: sourceCandidateId, field, route },
      context_refs: [sourceCandidateId],
    });
    scoredId = insertEvent(db, {
      kind: "action_scored",
      directive_id: (row.directive_id as string) ?? "owner_profile",
      task_id: (row.task_id as string) ?? "owner_profile",
      loop_id: (row.loop_id as string) ?? "loop_root",
      substrate_origin: "substrate_auto",
      action_artifact_id: "owner_profile_promoter_action",
      verifier_artifact_id: "owner_profile_schema_verifier",
      outcome: "succeeded",
      residual: 0,
      payload: { candidate_id: sourceCandidateId, field, route },
      context_refs: [sourceCandidateId, actionId],
    });
    recordedId = insertEvent(db, {
      kind: "owner_profile_recorded",
      directive_id: (row.directive_id as string) ?? "owner_profile",
      task_id: (row.task_id as string) ?? "owner_profile",
      loop_id: (row.loop_id as string) ?? "loop_root",
      substrate_origin: "substrate_auto",
      payload: {
        ...merged,
        promoted_from: sourceCandidateId,
        promotion_route: route,
        action_event_id: actionId,
        scored_event_id: scoredId,
      },
      context_refs: [sourceCandidateId, actionId, scoredId],
    });
  });
  // Close the credit loop: call distributeCredit so the source candidate
  // gets candidate_confirmed evidence and its Beta posterior updates.
  // The synthetic-actuator path in runtime/credit.ts skips primary
  // artifact updates (owner_profile_promoter_action isn't a registered
  // code_artifact) and continues with citation credit. Best-effort:
  // distributor failures don't roll back the promotion.
  void import("../runtime/credit")
    .then(({ distributeCredit }) => distributeCredit(db, {
      action_event_id: actionId,
      observation_event_id: scoredId,
      scored_event_id: scoredId,
      predicted_residual: 0,
      observed_residual: 0,
    }))
    .catch(() => { /* extractor cadence is best-effort */ });
  return { kind: "promoted", candidate_id: sourceCandidateId, recorded_event_id: recordedId, field, route };
};

export type OwnerProfilePromotionSummary = { promoted: number; skipped: number };

/** Bulk extractor — scans every owner_insight_candidate that hasn't been
 *  promoted yet and runs `maybePromoteOwnerProfile` on each. Idempotent
 *  via the per-candidate skip in `candidateAlreadyPromoted`. */
export const extractOwnerProfilePromotions = (
  db: Database,
): OwnerProfilePromotionSummary => {
  const rows = db
    .query(
      `SELECT id FROM events
       WHERE kind = 'owner_insight_candidate'
       ORDER BY ts ASC`,
    )
    .all() as Array<{ id: string }>;
  let promoted = 0;
  let skipped = 0;
  for (const r of rows) {
    const verdict = maybePromoteOwnerProfile(db, r.id);
    if (verdict.kind === "promoted") promoted++;
    else skipped++;
  }
  return { promoted, skipped };
};
