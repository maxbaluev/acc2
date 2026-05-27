// acc2 substrate extractors — periodic deterministic passes over the
// event log that emit derived events (Model D §3.6.1, §7.2; §4.2
// "typed-extractor views"). Each extractor is idempotent: re-running
// over the same input produces the same output. Last-seen ts cursors
// live in the `meta` table so extractors only scan new rows.
//
// Phase B2 scope (per task brief):
//   - extractKnowledgePromotions: Beta-posterior promote/demote on
//     knowledge_candidate corroboration counts.
//   - extractActArtifactScores: recompute act_artifact posteriors
//     from recent action_scored events; auto-promote on threshold.
//   - extractSemanticDedup: §3.6.1 Rule 1+2. Embedding-based merger.
//     Phase B2 stub: no-op when no embeddings are present (Phase F).
//   - extractRecipeCandidates: group task_committed by goal_shape;
//     emit recipe-shape knowledge + promoted recipe-shape knowledge when the (goal_shape ×
//     topology) cluster's Beta posterior lower bound clears a
//     per-owner per-goal-class threshold (F5: see
//     runtime/posterior_promotion.ts). Failed gates record
//     deferred recipe-shape knowledge instead.
//
// Each extractor returns a small summary object for daemon telemetry.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withImmediateTransaction } from "./db";
import type { ArtifactInterfaceMetadata, EventKind, JsonValue, OwnerProfile, SubstrateOrigin } from "./types";
import { ARTIFACT_CANDIDATE_KINDS_SQL } from "./event_kinds";
import { OWNER_PROFILE_DEFAULTS, OWNER_PROFILE_JSON_SCHEMA } from "./types";
import { parseResourceRefs } from "../runtime/resource_uri";
import { decodeEmbeddingBlob } from "../runtime/embedder";
import { poolQuery } from "../runtime/sql_pool_singleton";
import { applyScoredOutcome, betaMean as canonicalBetaMean, betaEvidenceConfidence, getScoredEntity } from "../runtime/posterior";
import { evaluatePromotion } from "../runtime/posterior_promotion";
import { getThreshold } from "../runtime/threshold_registry";

// ── ULID-ish id minter (same convention as Phase B1 tests) ─────────

const newId = (): string =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();

const nowIso = (): string => new Date().toISOString();

// ── meta cursor helpers ────────────────────────────────────────────

const META_KEYS = {
  promotions: "extractor:knowledge_promotions:last_ts",
  scores:     "extractor:act_artifact_scores:last_ts",
  dedup:      "extractor:semantic_dedup:last_ts",
  recipes:    "extractor:recipe_candidates:last_ts",
  claudeConversations: "extractor:claude_project_conversations:last_run_ts",
} as const;

// ── Event-loop fairness (KC GJ2KN1J3KD1Z) ──────────────────────────
//
// Pre-fix: the extractor passes ran tight sync loops scanning the full
// events / act_artifact tables on a 280K-event ledger. Combined with
// per-row sub-queries (verdict counts, prior-emission LIKE scans,
// per-artifact action_scored fetches) the pass blocked the Bun event
// loop for many seconds, contributing to the role=all daemon wedge.
//
// Each extractor function is now async and yields every
// EXTRACTOR_YIELD_INTERVAL rows in its main per-row loop. Time-bounded
// scans (last EXTRACTOR_RECENT_DAYS days) cap the per-tick worst-case
// size; idempotency means earlier-credited rows are skipped on the
// next tick regardless of window.

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

// ── Off-loop read routing + inter-extractor fairness ───────────────
//
// The heaviest read scans below are full-`events` / full-`act_artifact`
// table SELECTs that, on a 400K-row ledger, block the single Bun event
// loop for tens of seconds when run synchronously (confirmed live:
// reads stall 15s during an extractors tick overrun). Routing them
// through `poolQuery` off-loads the scan to the SQL worker-thread pool
// when the daemon installed one (embedder.readUnembedded /
// archival_worker use the same idiom); `poolQuery` fail-closes to the
// in-process sync `db.query(...).all(...)` path when no pool is present
// — unit tests + ACC2_DISABLE_SQL_POOL diagnostics take the sync path
// with identical row shape / ordering / results. ONLY scalar+text
// column scans are routed; embedding-BLOB scans stay on the sync path
// (the worker postMessage clone path is reserved for the embedder's own
// readUnembedded). Reads are safe off-loop; WRITES (emitEvent / db.run
// inserts+updates that promote knowledge or score artifacts) stay on
// the main thread / single-writer transaction exactly as before — the
// change moves WHEN/WHERE the reads run, never WHAT is computed.
//
// extractorFairnessYield is the inter-extractor macrotask boundary. The
// daemon dispatcher (`runExtractorsOnce`) awaits each extractor
// sequentially; calling this once at the TOP of every extractor body
// guarantees a macrotask boundary BETWEEN consecutive extractors, so a
// single extractor's read+compute work can never chain into 30-120s of
// uninterrupted loop occupation across the whole sweep. It is an alias
// of yieldToEventLoop kept distinct for intent clarity at the call site.
const extractorFairnessYield = yieldToEventLoop;

const EXTRACTOR_YIELD_INTERVAL = 25;
/** Hard ceiling on the candidate / verdict / artifact rows pulled per
 *  pass. 5000 is generous (every extractor will normally see far fewer
 *  on a healthy substrate) but caps the worst-case catch-up cycle
 *  after a long daemon outage. Cursor-based extractors (knowledge
 *  promotions, semantic dedup) pair this with their existing meta
 *  cursor so re-runs are bounded; non-cursor extractors rely on the
 *  LIMIT alone plus the per-row idempotency check. */
const EXTRACTOR_SCAN_LIMIT = 5000;

/** LIVENESS (X5AF768V): hard ceiling on verdict rows pulled by the
 *  synchronous hot-path `maybePromoteKnowledge` recompute. The SQL
 *  predicate already filters to verdicts that cite the one candidate, so
 *  a healthy candidate sees a handful of rows; this LIMIT is the
 *  fail-closed backstop guaranteeing the hot path can NEVER materialise
 *  an unbounded scan into the event loop even under a pathological
 *  citation fan-out. Promotion needs only countThreshold (5) wins, so a
 *  1000-row bound is far above any decision boundary while staying O(1)
 *  for the loop. */
const HOT_PATH_VERDICT_SCAN_LIMIT = 1000;

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

// ── Claude Code conversation importer ──────────────────────────────

const DEFAULT_CLAUDE_PROJECTS_ROOT = join(homedir(), ".claude", "projects");

export type ClaudeProjectConversationSummary = {
  files_scanned: number;
  messages_seen: number;
  emitted: number;
  skipped_duplicate: number;
  skipped_non_owner: number;
  skipped_invalid: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const textFromClaudeContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
};

const claudeMessageRole = (entry: Record<string, unknown>, message: Record<string, unknown>): string => {
  const role = message.role ?? entry.role ?? entry.type;
  return typeof role === "string" ? role : "";
};

const stableClaudeMessageId = (
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  offset: number,
): string => {
  const raw = entry.uuid ?? entry.id ?? message.uuid ?? message.id;
  return typeof raw === "string" && raw.length > 0 ? raw : String(offset);
};

const claudeConversationDedupKey = (
  transcriptPath: string,
  stableId: string,
  role: string,
  text: string,
): string => createHash("sha256").update(`${transcriptPath}${stableId}${role}${text}`).digest("hex");

const ownerInputDedupExists = (db: Database, dedupKey: string): boolean => {
  const row = db
    .query(
      `SELECT 1 AS x FROM events
       WHERE kind = 'owner_input_received'
         AND json_extract(payload, '$.source_dedup_key') = ?
       LIMIT 1`,
    )
    .get(dedupKey) as { x: number } | null;
  return row !== null;
};

export const extractClaudeProjectConversations = async (
  db: Database,
  projectsRoot = DEFAULT_CLAUDE_PROJECTS_ROOT,
): Promise<ClaudeProjectConversationSummary> => {
  const summary: ClaudeProjectConversationSummary = {
    files_scanned: 0,
    messages_seen: 0,
    emitted: 0,
    skipped_duplicate: 0,
    skipped_non_owner: 0,
    skipped_invalid: 0,
  };
  // Inter-extractor fairness: macrotask boundary at the top of the body.
  await extractorFairnessYield();
  if (!existsSync(projectsRoot)) return summary;

  const projects = readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(projectsRoot, entry.name, "conversation.jsonl"))
    .filter((path) => existsSync(path));

  let processed = 0;
  for (const transcriptPath of projects) {
    summary.files_scanned += 1;
    const lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
    for (let offset = 0; offset < lines.length; offset++) {
      const line = lines[offset]!.trim();
      if (!line) continue;
      if (processed > 0 && processed % EXTRACTOR_YIELD_INTERVAL === 0) await yieldToEventLoop();
      processed += 1;
      summary.messages_seen += 1;

      let entry: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) throw new Error("not_object");
        entry = parsed;
      } catch {
        summary.skipped_invalid += 1;
        continue;
      }
      const message = isRecord(entry.message) ? entry.message : entry;
      const role = claudeMessageRole(entry, message);
      if (!["owner", "user", "human"].includes(role)) {
        summary.skipped_non_owner += 1;
        continue;
      }
      const text = textFromClaudeContent(message.content ?? entry.content);
      if (!text) {
        summary.skipped_invalid += 1;
        continue;
      }
      const stableId = stableClaudeMessageId(entry, message, offset);
      const dedupKey = claudeConversationDedupKey(transcriptPath, stableId, role, text);
      if (ownerInputDedupExists(db, dedupKey)) {
        summary.skipped_duplicate += 1;
        continue;
      }
      insertEvent(db, {
        kind: "owner_input_received",
        directive_id: "claude_project_conversation_import",
        task_id: "claude_project_conversation_import",
        loop_id: "extract_claude_project_conversations",
        substrate_origin: "claude_root",
        payload: {
          text,
          source: "claude_project_conversation",
          transcript_path: transcriptPath,
          stable_message_id_or_offset: stableId,
          role,
          source_dedup_key: dedupKey,
        },
      });
      summary.emitted += 1;
    }
  }
  writeMeta(db, META_KEYS.claudeConversations, nowIso());
  return summary;
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
// correspond to a real registered act_artifact row, but it must
// be stable so substrate.search-by-artifact-id can group the action
// chains for posterior aggregation.

type PromotionResultKind =
  | "knowledge_promoted"
  | "knowledge_demoted"
  | "act_artifact_promoted"
  | "knowledge_candidate"
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
// Beta(1, 1) prior reads as zero confirmations (Architecture.md).
const betaMean = canonicalBetaMean;
const betaConfidence = betaEvidenceConfidence;

export type KnowledgePromotionSummary = { promoted: number; demoted: number };

export const extractKnowledgePromotions = async (db: Database): Promise<KnowledgePromotionSummary> => {
  // readMeta is a single indexed point-read; do it synchronously FIRST so a
  // fire-and-forget caller's earliest db touch completes before any close.
  const cursor = readMeta(db, META_KEYS.promotions);
  // Inter-extractor fairness: macrotask boundary BEFORE the heavy full-table
  // scans so this extractor can't chain its heavy work directly out of the
  // previous one in the daemon sweep.
  await extractorFairnessYield();

  // Open candidates: no prior promoted/demoted row points to them.
  // Bounded scan per KC GJ2KN1J3KD1Z: the promoted/demoted lookup
  // historically walked the full events table. Cap at the most-recent
  // EXTRACTOR_SCAN_LIMIT rows (idempotent — older verdicts are
  // already credited). Routed off-loop via poolQuery (sync fallback).
  const promotedIds = new Set(
    (await poolQuery<{ context_refs: string }>(
      db,
      `SELECT context_refs FROM events
         WHERE kind IN ('knowledge_promoted', 'knowledge_demoted')
         ORDER BY ts DESC
         LIMIT ?`,
      [EXTRACTOR_SCAN_LIMIT],
    ))
      .flatMap((r) => {
        try { return JSON.parse(r.context_refs) as string[]; } catch { return []; }
      }),
  );

  // Cursor-bounded scan per KC GJ2KN1J3KD1Z: cursor advances on each
  // tick so we never rescan already-credited candidates. EXTRACTOR_SCAN_LIMIT
  // caps the worst-case catch-up cycle after a long daemon outage. No
  // separate time floor — cursor + LIMIT together bound the work.
  // Inclusive lower bound (>=): the cursor is clamped below to the oldest
  // STILL-UNRESOLVED candidate (see the cursor-advance comment), so the
  // boundary row must be re-included to give it another promotion chance
  // when its verdicts finally arrive. Already-resolved boundary rows are
  // idempotent-skipped via the promotedIds set, so re-scanning them is a
  // cheap no-op rather than a double-promotion. Routed off-loop (sync fallback).
  const candidates = (await poolQuery<Record<string, unknown>>(
    db,
    `SELECT id, ts, directive_id, task_id, loop_id, substrate_origin, payload
       FROM events
       WHERE kind = 'knowledge_candidate'
         AND (? IS NULL OR ts >= ?)
       ORDER BY ts ASC
       LIMIT ?`,
    [cursor, cursor, EXTRACTOR_SCAN_LIMIT],
  ));

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
  // Bounded scan per KC GJ2KN1J3KD1Z: verdict events accumulate
  // monotonically. Cap at EXTRACTOR_SCAN_LIMIT * 4 most-recent
  // (4x multiplier since verdicts are typically several per
  // candidate). Idempotency on cited candidate id ensures stale
  // verdicts that fell out of the window are already credited.
  const verdicts = (await poolQuery<{ kind: string; substrate_origin: string; ts: string; context_refs: string; payload: string }>(
    db,
    `SELECT kind, substrate_origin, ts, context_refs, payload FROM events
       WHERE kind IN ('candidate_confirmed', 'candidate_contradicted', 'knowledge_contradiction_observed')
       ORDER BY ts DESC
       LIMIT ?`,
    [EXTRACTOR_SCAN_LIMIT * 4],
  ));

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
  let verdictsProcessed = 0;
  for (const v of verdicts) {
    if (verdictsProcessed > 0 && verdictsProcessed % EXTRACTOR_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
    verdictsProcessed += 1;
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
    //
    // T0.3 citation binding enforcement (2026-05-20): candidate_confirmed
    // rows stamped projected_from="bind_citation" carry a small
    // retention-bias weight (BINDING_WEIGHT=0.1 by default) emitted by
    // the bindCitation post-write hook in runtime/events.ts. The
    // extractor honors that weight so a single binding contributes
    // ~0.1 fractional wins, not 1.0. Sustained retrieval (~50 bindings)
    // crosses POSTERIOR.countThreshold (5) for promotion — the
    // "compounding" semantic. All other candidate_confirmed rows
    // default to weight=1.0 (the existing unit-count behavior).
    let weightMul = 1;
    if (v.kind === "knowledge_contradiction_observed") {
      try {
        const p = JSON.parse(v.payload ?? "{}") as Record<string, unknown>;
        const w = p.weight;
        weightMul = (typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= 1) ? w : 0.5;
      } catch { weightMul = 0.5; }
    } else if (v.kind === "candidate_confirmed") {
      try {
        const p = JSON.parse(v.payload ?? "{}") as Record<string, unknown>;
        if (p.projected_from === "bind_citation") {
          const w = p.weight;
          weightMul = (typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= 1) ? w : 0.1;
        }
      } catch { /* keep default 1.0 — backward-compatible */ }
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
  // Cursor-advance correctness (idempotency hole fix): the cursor must NOT
  // advance past a candidate that is still UNRESOLVED (neither promoted nor
  // demoted this pass). Promotion/demotion depends on verdict events
  // (candidate_confirmed / candidate_contradicted) that arrive LATER than the
  // candidate's own ts. The pre-fix loop set `latestTs = c.ts` for EVERY
  // scanned candidate and persisted it; an open candidate whose confirmations
  // landed after the next tick was then filtered out by `ts > cursor` forever
  // and could NEVER be promoted — knowledge silently dropped. We instead clamp
  // the cursor to just before the OLDEST still-open candidate so unresolved
  // rows stay in the scan window. Already-resolved older rows that fall back
  // into the window are protected by the idempotent `promotedIds` skip above.
  let oldestUnresolvedTs: string | null = null;

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
        // promotion stays domain-global.
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
      } else {
        // Unresolved this pass: it must remain re-scannable next tick because
        // its verdicts may still be accumulating. Remember the oldest such ts.
        const cts = c.ts as string;
        if (oldestUnresolvedTs === null || cts < oldestUnresolvedTs) {
          oldestUnresolvedTs = cts;
        }
      }
      // Track the newest candidate ts we saw (the all-resolved cursor target).
      latestTs = c.ts as string;
    }
    // Clamp: never advance past the oldest still-open candidate. Strict `<`
    // is used at scan time (`ts > cursor`), so setting the cursor to the
    // oldest-unresolved ts re-includes that candidate (and everything after)
    // on the next tick. When NOTHING is open, advance to the newest ts seen.
    const nextCursor = oldestUnresolvedTs ?? latestTs;
    if (nextCursor) {
      // Monotonic guard: a clamp must never move the cursor BACKWARDS past
      // where it already was, or a long-resolved early candidate could rewind
      // the whole window every tick. The pre-existing cursor is always a valid
      // floor because everything <= it was already scanned (and resolved rows
      // are idempotent via promotedIds).
      const floored = cursor !== null && nextCursor < cursor ? cursor : nextCursor;
      writeMeta(db, META_KEYS.promotions, floored);
    }
  });

  return { promoted, demoted };
};

/** Promote (or demote) ONE knowledge candidate by id — parallel API to
 *  `maybePromote` in artifact_store.ts. Returns the verdict so callers
 *  (OwnerAutonomy, brain) can branch on the result without re-querying. The
 *  thresholds match the bulk extractor above so single-row and bulk
 *  passes are interchangeable. Architecture.md + §7.2 + Phase Audit. */
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

  // T0.3 citation binding enforcement (2026-05-20): also walk
  // candidate_confirmed.payload for projected_from="bind_citation"
  // rows and honor payload.weight so retention nudges (default
  // weight=0.1) contribute fractional wins instead of unit wins. The
  // canonical bulk extractor extractKnowledgePromotions has the same
  // read; mirror it here so synchronous promotion (called after every
  // distributeCredit knowledge emit) doesn't promote on sustained
  // retrieval alone unless ~50 bindings have accumulated.
  // LIVENESS (X5AF768V): the closure-credit hot path (runtime/credit.ts:
  // distributeCredit → maybePromoteKnowledge, called once per cited
  // knowledge id on EVERY scored act) previously ran an UNBOUNDED
  // synchronous `SELECT … FROM events WHERE kind IN (…)` with no
  // candidate filter, no LIMIT, and no cursor — materialising the entire
  // verdict history (hundreds of thousands of rows on a mature ledger)
  // into JS and then JSON.parsing every context_refs to test membership.
  // On a long-running daemon this single sync scan blocked the Bun event
  // loop for tens of seconds and was a direct contributor to the 88-min
  // wedge. The fix pushes the candidate filter INTO SQLite so only the
  // handful of verdict rows that actually cite `candidateId` cross into
  // JS, and bounds the result with a LIMIT so a pathological fan-out can
  // never re-introduce an unbounded scan on the hot path. Both predicate
  // legs are required to preserve the prior semantics exactly: the
  // primary distributeCredit emit and the bind_citation emit both stamp
  // `payload.knowledge_id`, while the semantic-dedup corroboration path
  // cites the candidate only through context_refs — the LIKE leg keeps
  // those wins counted. The trailing `refs.includes(candidateId)` check
  // is retained as an exact-match guard against LIKE substring collisions.
  const verdicts = db
    .query(
      `SELECT kind, context_refs, payload FROM events
       WHERE kind IN ('candidate_confirmed', 'candidate_contradicted')
         AND (json_extract(payload, '$.knowledge_id') = ?1
              OR context_refs LIKE '%"' || ?1 || '"%')
       ORDER BY ts DESC
       LIMIT ?2`,
    )
    .all(candidateId, HOT_PATH_VERDICT_SCAN_LIMIT) as Array<{ kind: string; context_refs: string; payload: string }>;
  let wins = 0;
  let losses = 0;
  for (const v of verdicts) {
    let refs: string[] = [];
    try { refs = JSON.parse(v.context_refs); } catch { /* skip */ }
    if (!refs.includes(candidateId)) continue;
    if (v.kind === "candidate_confirmed") {
      let weight = 1;
      try {
        const p = JSON.parse(v.payload ?? "{}") as Record<string, unknown>;
        if (p.projected_from === "bind_citation") {
          const w = p.weight;
          weight = (typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= 1) ? w : 0.1;
        }
      } catch { /* keep weight=1 — backward-compatible */ }
      wins += weight;
    } else {
      losses += 1;
    }
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
// For each act_artifact, walk recent action_scored events that cite
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

export type ActArtifactScoreSummary = { updated: number; promoted: number };

export const extractActArtifactScores = async (db: Database): Promise<ActArtifactScoreSummary> => {
  // Inter-extractor fairness: macrotask boundary at the top of the body.
  await extractorFairnessYield();
  // Bounded scan per KC GJ2KN1J3KD1Z: cap act_artifact rows scanned
  // per tick. Ordering by updated_at (newest first) means rows updated
  // most recently (i.e. with recent scored evidence) get re-scored
  // each cycle; older artifacts still re-score as their action_scored
  // children arrive. Idempotent: the UPDATE is a recompute and emits
  // act_artifact_promoted only when threshold-crossing. The body column
  // is text (synthesizeName reads it), so this scan is safe off-loop;
  // routed via poolQuery (sync fallback). The per-artifact action_scored
  // sub-query below stays sync — it runs inside the write transaction.
  const artifacts = (await poolQuery<{ id: string; body: string; status: string; name: string | null }>(
    db,
    `SELECT id, body, status, name FROM act_artifact
       ORDER BY updated_at DESC
       LIMIT ?`,
    [EXTRACTOR_SCAN_LIMIT],
  ));

  let updated = 0;
  let promoted = 0;

  // Yield BEFORE the transaction (the scan loop holds the write lock
  // inside withImmediateTransaction; yielding inside would stall
  // every other writer). For the artifacts loop we accept the
  // transaction-bounded duration and rely on the LIMIT cap + the
  // per-artifact sub-query already being indexed on action_artifact_id.
  await yieldToEventLoop();

  withImmediateTransaction(db, () => {
    for (const art of artifacts) {
      const events = db
        .query(
          `SELECT id, ts, residual, directive_id, task_id, loop_id FROM events
           WHERE kind = 'action_scored' AND action_artifact_id = ? AND residual IS NOT NULL
           ORDER BY ts ASC`,
        )
        .all(art.id) as Array<{ id: string; ts: string; residual: number; directive_id: string; task_id: string; loop_id: string }>;

      if (events.length === 0) continue;

      for (const ev of events) {
        applyScoredOutcome(db, {
          entity_id: art.id,
          entity_kind: "act_artifact",
          residual: ev.residual,
          ts: ev.ts,
          directive_id: ev.directive_id,
          task_id: ev.task_id,
          projection_key: "extract_act_artifact_score:" + ev.id + ":" + art.id,
          payload: {
            projection_source: "extractActArtifactScores",
            action_scored_event_id: ev.id,
          },
        });
      }
      const scored = getScoredEntity(db, art.id);
      if (!scored) continue;
      const alpha = scored.posterior_alpha;
      const beta = scored.posterior_beta;
      const score = scored.score;
      const confidence = scored.confidence;
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
        `UPDATE act_artifact
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
        // Brain audit B (2026-05-15): pre-fix extractActArtifactScores
        // updated the row's status but never emitted the canonical
        // act_artifact_promoted event. Operator surfaces (TUI artifact
        // panel, promotion telemetry) showed zero promotions even though
        // many artifacts crossed the bar. Emit at promotion time so the
        // event ledger is the source of truth. We attribute the row to
        // the LATEST action_scored that drove the posterior so the
        // directive/task lineage stays intact.
        const lastDriver = events[events.length - 1]!;
        emitPromotionSpine(db, {
          kind: "act_artifact_promoted",
          candidate_id: art.id,
          directive_id: lastDriver.directive_id,
          task_id: lastDriver.task_id,
          loop_id: lastDriver.loop_id,
          artifact_prefix: "act_artifact_promotion",
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

// T2.1 / Tier-S4 — both of these constants are now adaptive via the
// universal threshold registry. The hardcoded literals remain as the
// cold-start defaults (returned when no admitted threshold_predicate
// row exists). External callers can still import these for the
// canonical defaults; in-file consumers route through getThreshold().
//
// Canonical names (act_artifact.name):
//   - merger_dedup_cosine_threshold        (default 0.92)
//   - merger_synthesis_eligibility_count   (default 2)
export const KNOWLEDGE_DEDUP_COSINE_THRESHOLD = 0.92;
export const SYNTHESIS_CORROBORATION_THRESHOLD = 2;

/** Read text from a knowledge_candidate payload (handles `text` or `claim`). */
const candidateText = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  return ((p.text as string | undefined) ?? (p.claim as string | undefined) ?? "").toString();
};

export const extractSemanticDedup = async (db: Database): Promise<SemanticDedupSummary> => {
  // readMeta is a single indexed point-read; do it synchronously FIRST so a
  // fire-and-forget caller's earliest db touch completes before any close.
  const cursor = readMeta(db, META_KEYS.dedup);
  // Inter-extractor fairness: macrotask boundary before the heavy scans.
  // The scans here read the embedding BLOB column, so they stay on the
  // sync path (the worker postMessage clone path is reserved for the
  // embedder's own readUnembedded); the yield still keeps the daemon
  // sweep from chaining straight out of the prior extractor.
  await extractorFairnessYield();

  // Tier-S4: thresholds resolved through the universal registry. Cold-start
  // falls back to the hardcoded defaults; once a threshold_predicate row
  // is admitted, its Beta-posterior-ranked value wins. Read once per pass
  // so the hot row-by-row loop doesn't pay the cache + SQL lookup cost
  // per comparison.
  const dedupCosineThreshold = getThreshold(
    db,
    "merger_dedup_cosine_threshold",
    KNOWLEDGE_DEDUP_COSINE_THRESHOLD,
  );
  const synthesisEligibilityCount = getThreshold(
    db,
    "merger_synthesis_eligibility_count",
    SYNTHESIS_CORROBORATION_THRESHOLD,
  );

  // New candidates since last run (with their embeddings + text).
  // Cursor-bounded scan per KC GJ2KN1J3KD1Z: cursor + LIMIT cap the
  // per-tick work without a separate time floor.
  const candidates = db
    .query(
      `SELECT id, ts, directive_id, task_id, loop_id, substrate_origin,
              payload, embedding
       FROM events
       WHERE kind = 'knowledge_candidate'
         AND (? IS NULL OR ts > ?)
       ORDER BY ts ASC
       LIMIT ?`,
    )
    .all(cursor, cursor, EXTRACTOR_SCAN_LIMIT) as Array<{
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
  // Bounded scan per KC GJ2KN1J3KD1Z: cap at EXTRACTOR_SCAN_LIMIT.
  // Ordered DESC by ts so the most-recent (most-likely match)
  // candidates come first. Older candidates that drop out of the
  // window had ample opportunity to be merged in prior ticks.
  const openCandidates = db
    .query(
      `SELECT id, ts, directive_id, task_id, loop_id, substrate_origin,
              payload, embedding
       FROM events
       WHERE kind = 'knowledge_candidate'
         AND embedding IS NOT NULL
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(EXTRACTOR_SCAN_LIMIT) as Array<{
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
        if (cos < dedupCosineThreshold) continue;
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
          // F6 extension — universal internal Act scoring for merger
          // agreement. The substrate just decided to combine evidence
          // from two candidates rather than open a contradiction. The
          // future_citation_utility verifier closes the credit chain
          // when downstream events cite the merged knowledge (high
          // citation rate → low residual → merger was the right
          // call). Lazy-require avoids the extractors ↔ runtime cycle.
          //
          // Pair key is sorted lexicographically: when two candidates
          // share a ms-level timestamp the outer loop can fire in
          // either direction (prior=A,cand=B then prior=B,cand=A).
          // Both directions describe the SAME merger decision, so the
          // projection key must collapse to one row regardless of
          // iteration order.
          try {
            const pairKey = prior.id < cand.id
              ? prior.id + ":" + cand.id
              : cand.id + ":" + prior.id;
            const { recordInternalAct } = require("../runtime/internal_act_projection") as typeof import("../runtime/internal_act_projection");
            recordInternalAct(db, {
              intent: "merge knowledge candidates (agreement)",
              actionHandle: "knowledge_merger_v1",
              verifierHandle: "future_citation_utility",
              verifierKind: "deterministic_code",
              predictedResidual: 0.2,
              reasoningSummary: `cosine=${cos.toFixed(3)} polarity=${polA} agreed prior=${prior.id}`,
              actionSummary: `candidate_confirmed emitted citing prior ${prior.id}`,
              effectSummary: `merger fused new candidate ${cand.id} as corroborating evidence`,
              directiveId: cand.directive_id,
              taskId: cand.task_id,
              sourceActId: "knowledge_merger_v1:agreement:" + pairKey,
              extra: {
                branch: "agreement",
                cosine: cos,
                prior_candidate_id: prior.id,
                new_candidate_id: cand.id,
                cross_origin: prior.substrate_origin !== cand.substrate_origin,
              },
            });
          } catch { /* fail-soft: merger row already landed */ }
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
            if (corroborationCount >= synthesisEligibilityCount && distinctOrigins.size >= 2) {
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
          // F6 extension — universal internal Act scoring for merger
          // contradiction. The substrate is explicitly admitting
          // uncertainty: two candidates with high cosine similarity
          // disagree on polarity. The adjudication_outcome verifier
          // closes credit when the contradiction is later resolved
          // (an owner-confirmed winner, a stronger third candidate
          // breaking the tie). Higher predicted_residual (0.5)
          // mirrors the increased risk per the F6 brief.
          //
          // Pair key is sorted lexicographically so iteration-order
          // duplicates (prior=A,cand=B then prior=B,cand=A on tied
          // timestamps) collapse to one projection row.
          try {
            const pairKey = prior.id < cand.id
              ? prior.id + ":" + cand.id
              : cand.id + ":" + prior.id;
            const { recordInternalAct } = require("../runtime/internal_act_projection") as typeof import("../runtime/internal_act_projection");
            recordInternalAct(db, {
              intent: "open knowledge merger contradiction",
              actionHandle: "knowledge_merger_v1",
              verifierHandle: "adjudication_outcome",
              verifierKind: "deterministic_code",
              predictedResidual: 0.5,
              reasoningSummary: `cosine=${cos.toFixed(3)} polarity disagreement prior=${polB} new=${polA}`,
              actionSummary: `contradictory_candidates emitted citing ${prior.id} vs ${cand.id}`,
              effectSummary: `adjudication pending; downstream owner or stronger evidence resolves`,
              directiveId: cand.directive_id,
              taskId: cand.task_id,
              sourceActId: "knowledge_merger_v1:contradiction:" + pairKey,
              extra: {
                branch: "contradiction",
                cosine: cos,
                prior_candidate_id: prior.id,
                new_candidate_id: cand.id,
                polarity_prior: polB,
                polarity_new: polA,
                cross_origin: prior.substrate_origin !== cand.substrate_origin,
              },
            });
          } catch { /* fail-soft: contradiction row already landed */ }
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

// ── 3a. Artifact consolidation extractor (CONSOLIDAT, 3XETJCYT) ─────
//
// Knowledge candidates dedup (extractSemanticDedup above). act_artifacts
// did NOT: two artifacts that do the SAME job (same `kind`, overlapping
// `interface_metadata.goal_shapes`, near-identical interface_purpose/usage)
// coexist forever, splitting posterior credit and cluttering selection
// (ARTIFACT_S). This pass makes redundant artifacts CONVERGE by POSTERIOR:
// the higher-Beta-posterior artifact wins; the loser is RETIRED by aliasing
// it to the winner via the EXISTING act_artifact_aliased mechanism (wave-1
// resolveArtifactId). After consolidation: (a) future citations of the loser
// resolve to the winner, (b) selection sees only the winner, (c) the loser's
// row is NOT deleted — append-only, one-way, cycle-safe.
//
// This is the closing half of the evolve-better-code loop: capability_gap
// authors a competitor → both run + accrue posterior → selector prefers the
// winner → consolidation retires the loser ONCE the winner is clearly better.
//
// Equivalence detector (CONSERVATIVE — only HIGH-confidence duplicates):
//   1. Same `kind` (a telegram-sender is never equivalent to a code-runner).
//   2. Same `runtime` AND structurally-compatible `declared_sandbox` — never
//      merge across runtimes/sandboxes (would break execution).
//   3. Overlapping `interface_metadata.goal_shapes` (≥1 shared shape) — both
//      must claim the same goal-class.
//   4. Compatible inputs/outputs schema (the JSON descriptors must not
//      conflict — a mismatch means a different call convention → not a dup).
//   5. High cosine of the interface descriptor embedding (purpose + usage +
//      effects text) ≥ a tunable threshold (default 0.93, registry-overridable
//      via `artifact_consolidation_cosine_threshold`).
//   6. The winner must have ENOUGH observations (posterior_alpha+beta-2 ≥ a
//      min-observation floor) so we never retire on a single lucky run.
//
// Safety: never consolidate INTO a quarantined/retired artifact (winner must
// be admitted/promoted); never re-alias an already-consolidated pair
// (idempotent — skip pairs that already carry an act_artifact_aliased edge in
// EITHER direction OR an act_artifact_consolidated evidence row); never create
// a cycle (winner is never the loser of a prior consolidation, and we refuse
// to alias an id that is already an alias source). Emits an
// act_artifact_consolidated evidence row per consolidation.
//
// Bounded scan: GROUP FIRST by (kind, primary goal_shape) so pairwise cosine
// only runs WITHIN a group — never O(n^2) over all artifacts. Per-tick row
// cap + per-group size cap bound the worst case.

export type ArtifactConsolidationSummary = {
  consolidated: number;
  groups_scanned: number;
  pairs_examined: number;
};

/** Default cosine floor for declaring two artifact interface descriptors
 *  equivalent. Deliberately STRICTER than the knowledge dedup floor (0.92):
 *  retiring an artifact is more consequential than corroborating knowledge,
 *  so we demand a tighter match. Registry-overridable. */
export const ARTIFACT_CONSOLIDATION_COSINE_THRESHOLD = 0.93;

/** Minimum observations (alpha+beta-2, i.e. scored runs) the WINNER must have
 *  before we retire a competitor against it. Mirrors the capability-gap min
 *  so consolidation needs at least as much evidence as gap-detection. */
export const ARTIFACT_CONSOLIDATION_MIN_WINNER_OBS = Number(
  process.env.ACC2_CONSOLIDATION_MIN_WINNER_OBS ?? 5,
);

/** Per-group artifact cap. Within one (kind, goal_shape) bucket we examine at
 *  most this many artifacts pairwise; larger buckets are truncated to the
 *  highest-scored rows (the most-likely winners/losers). Bounds the inner
 *  loop at O(cap^2) per group, never O(n^2) over the table. */
const CONSOLIDATION_GROUP_CAP = 40;

type ConsolidationArtifactRow = {
  id: string;
  kind: string;
  runtime: string | null;
  declared_sandbox: string | null;
  status: string;
  score: number;
  confidence: number;
  posterior_alpha: number;
  posterior_beta: number;
  interface_metadata: string | null;
};

/** Build the text we embed to compare two artifact INTERFACES. Domain-neutral:
 *  purpose + usage example descriptions + effects + preconditions. NOT the
 *  body — two artifacts can have very different code yet serve the identical
 *  capability (that is precisely the pair we want to converge). Returns "" if
 *  the descriptor carries no comparable text. */
const consolidationInterfaceText = (meta: ArtifactInterfaceMetadata | null): string => {
  if (!meta) return "";
  const parts: string[] = [];
  if (typeof meta.purpose === "string") parts.push(meta.purpose);
  if (Array.isArray(meta.usage_examples)) {
    for (const ex of meta.usage_examples) {
      if (ex && typeof ex.description === "string") parts.push(ex.description);
    }
  }
  if (Array.isArray(meta.effects)) parts.push(...meta.effects.filter((e): e is string => typeof e === "string"));
  if (Array.isArray(meta.preconditions)) parts.push(...meta.preconditions.filter((p): p is string => typeof p === "string"));
  return parts.join(" • ").trim();
};

/** First goal_shape of an artifact's descriptor (the GROUPING key). Returns
 *  null when the artifact declares no goal_shapes — such rows are skipped
 *  (we cannot group them and cannot honestly judge capability equivalence). */
const primaryGoalShape = (meta: ArtifactInterfaceMetadata | null): string | null => {
  if (!meta || !Array.isArray(meta.goal_shapes) || meta.goal_shapes.length === 0) return null;
  const first = meta.goal_shapes[0];
  return typeof first === "string" && first.length > 0 ? first : null;
};

/** Do the two artifacts share at least one goal_shape? */
const sharesGoalShape = (a: ArtifactInterfaceMetadata | null, b: ArtifactInterfaceMetadata | null): boolean => {
  const sa = new Set((a?.goal_shapes ?? []).filter((s): s is string => typeof s === "string"));
  for (const s of (b?.goal_shapes ?? [])) {
    if (typeof s === "string" && sa.has(s)) return true;
  }
  return false;
};

/** Conservative schema-compatibility check. We only need to refuse OBVIOUSLY
 *  incompatible call conventions (a mismatch means different I/O → not a dup).
 *  Both-null / either-null is treated as compatible (legacy rows + rows that
 *  simply omit the optional descriptor — we fall back to the cosine + shape
 *  signals). When BOTH declare a schema, they must be structurally equal
 *  (deep JSON equality) to count as compatible — anything else is refused. */
const schemaCompatible = (a: ArtifactInterfaceMetadata | null, b: ArtifactInterfaceMetadata | null): boolean => {
  const cmp = (x: JsonValue | undefined, y: JsonValue | undefined): boolean => {
    if (x === undefined || x === null || y === undefined || y === null) return true;
    try { return JSON.stringify(x) === JSON.stringify(y); } catch { return false; }
  };
  return cmp(a?.inputs_schema, b?.inputs_schema) && cmp(a?.outputs_schema, b?.outputs_schema);
};

/** Structural compatibility of declared sandboxes — never merge across
 *  different sandbox declarations (would change the execution contract). Both
 *  null is compatible; otherwise the JSON must be equal. */
const sandboxCompatible = (a: string | null, b: string | null): boolean => {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a === b;
};

/** Total scored observations behind a Beta posterior (alpha+beta seeded at 1
 *  each in admission → subtract the 2 priors). */
const observationCount = (alpha: number, beta: number): number => Math.max(0, alpha + beta - 2);

/** Pick the winner of an equivalent pair by POSTERIOR, not recency. Higher
 *  score wins; ties broken by higher confidence, then more observations. */
const consolidationWinner = <T extends ConsolidationArtifactRow>(
  a: T,
  b: T,
): { winner: T; loser: T } => {
  const aBetter =
    a.score > b.score ||
    (a.score === b.score && a.confidence > b.confidence) ||
    (a.score === b.score && a.confidence === b.confidence &&
      observationCount(a.posterior_alpha, a.posterior_beta) >= observationCount(b.posterior_alpha, b.posterior_beta));
  return aBetter ? { winner: a, loser: b } : { winner: b, loser: a };
};

/** Embed function injection seam. Production passes the real
 *  runtime/embedder.computeEmbedding (requires an API key); tests inject a
 *  deterministic stub. Default resolves to computeEmbedding lazily so the
 *  extractors module has no hard runtime/embedder cycle at import time. */
export type ArtifactConsolidationEmbedFn = (text: string) => Promise<Float32Array | null>;

const defaultConsolidationEmbed: ArtifactConsolidationEmbedFn = async (text) => {
  if (!text) return null;
  try {
    const { computeEmbedding } = await import("../runtime/embedder");
    const res = await computeEmbedding(text);
    if (!res || !Array.isArray(res.embedding)) return null;
    return Float32Array.from(res.embedding);
  } catch { return null; }
};

export const extractArtifactConsolidation = async (
  db: Database,
  embedFn: ArtifactConsolidationEmbedFn = defaultConsolidationEmbed,
): Promise<ArtifactConsolidationSummary> => {
  // Inter-extractor fairness: macrotask boundary at the top of the body.
  await extractorFairnessYield();

  const cosineThreshold = getThreshold(
    db,
    "artifact_consolidation_cosine_threshold",
    ARTIFACT_CONSOLIDATION_COSINE_THRESHOLD,
  );

  // Only EXECUTABLE artifacts (runtime IS NOT NULL) with a non-null
  // interface_metadata participate — we judge capability equivalence from
  // the descriptor, and data-class rows are not invoked by the selector.
  // Bounded scan: cap rows per tick; group first so pairwise cosine is
  // intra-group only.
  const rows = (await poolQuery<ConsolidationArtifactRow>(
    db,
    `SELECT id, kind, runtime, declared_sandbox, status, score, confidence,
            posterior_alpha, posterior_beta, interface_metadata
       FROM act_artifact
      WHERE runtime IS NOT NULL
        AND interface_metadata IS NOT NULL
        AND status IN ('admitted', 'promoted')
      ORDER BY score DESC, updated_at DESC
      LIMIT ?`,
    [EXTRACTOR_SCAN_LIMIT],
  ));

  if (rows.length === 0) {
    return { consolidated: 0, groups_scanned: 0, pairs_examined: 0 };
  }

  // GROUP FIRST: bucket by (kind, primary goal_shape). Pairwise similarity
  // only runs WITHIN a bucket — never O(n^2) across all artifacts.
  type Parsed = ConsolidationArtifactRow & { meta: ArtifactInterfaceMetadata | null };
  const groups = new Map<string, Parsed[]>();
  for (const r of rows) {
    let meta: ArtifactInterfaceMetadata | null = null;
    if (r.interface_metadata) {
      try {
        const p = JSON.parse(r.interface_metadata);
        if (p && typeof p === "object" && !Array.isArray(p)) meta = p as ArtifactInterfaceMetadata;
      } catch { meta = null; }
    }
    const shape = primaryGoalShape(meta);
    if (shape === null) continue; // cannot group / judge — skip
    const key = r.kind + " " + shape;
    let bucket = groups.get(key);
    if (!bucket) { bucket = []; groups.set(key, bucket); }
    if (bucket.length < CONSOLIDATION_GROUP_CAP) bucket.push({ ...r, meta });
  }

  // Already-consolidated pair set (idempotency + cycle safety). A pair is
  // skipped if EITHER an act_artifact_aliased edge OR an
  // act_artifact_consolidated evidence row already links the two ids in
  // EITHER direction. We also collect every id that is ALREADY an alias
  // SOURCE (old_id) — such an id has been retired, so it can neither be a
  // fresh loser again (already retired) nor a winner (would create a cycle:
  // a retired id must never become an alias TARGET).
  const aliasedOldIds = new Set<string>(
    (db.query(`SELECT DISTINCT json_extract(payload,'$.old_id') AS old_id FROM events WHERE kind = 'act_artifact_aliased'`)
      .all() as Array<{ old_id: string | null }>)
      .map((r) => r.old_id)
      .filter((x): x is string => !!x),
  );
  const consolidatedPairs = new Set<string>(
    (db.query(`SELECT json_extract(payload,'$.winner_id') AS w, json_extract(payload,'$.loser_id') AS l FROM events WHERE kind = 'act_artifact_consolidated'`)
      .all() as Array<{ w: string | null; l: string | null }>)
      .flatMap((r) => (r.w && r.l) ? [r.w + " " + r.l, r.l + " " + r.w] : []),
  );
  const pairSeen = (x: string, y: string): boolean =>
    consolidatedPairs.has(x + " " + y) || consolidatedPairs.has(y + " " + x);

  // Embed each candidate's interface descriptor once (outside the write
  // transaction — embedding may be async / network). Cache by id.
  const textById = new Map<string, string>();
  for (const bucket of groups.values()) {
    for (const a of bucket) {
      if (!textById.has(a.id)) textById.set(a.id, consolidationInterfaceText(a.meta));
    }
  }
  const vecById = new Map<string, Float32Array>();
  for (const [id, text] of textById) {
    if (!text) continue;
    const v = await embedFn(text);
    if (v) vecById.set(id, v);
  }

  let consolidated = 0;
  let pairsExamined = 0;
  const groupsScanned = groups.size;
  // Track ids retired THIS pass so we never use a fresh loser as a later
  // winner within the same tick (cycle safety inside the batch).
  const retiredThisPass = new Set<string>();

  withImmediateTransaction(db, () => {
    for (const bucket of groups.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const a = bucket[i]!;
          const b = bucket[j]!;
          pairsExamined++;

          // Cycle / idempotency / retirement guards.
          if (a.id === b.id) continue;
          if (retiredThisPass.has(a.id) || retiredThisPass.has(b.id)) continue;
          if (aliasedOldIds.has(a.id) || aliasedOldIds.has(b.id)) continue; // already retired elsewhere
          if (pairSeen(a.id, b.id)) continue; // already consolidated

          // Equivalence signals (conservative — ALL must hold).
          if (a.runtime !== b.runtime) continue;                       // never cross runtimes
          if (!sandboxCompatible(a.declared_sandbox, b.declared_sandbox)) continue; // never cross sandboxes
          if (!sharesGoalShape(a.meta, b.meta)) continue;              // must share a goal_shape
          if (!schemaCompatible(a.meta, b.meta)) continue;             // compatible I/O convention
          const va = vecById.get(a.id);
          const vb = vecById.get(b.id);
          if (!va || !vb || va.length !== vb.length) continue;         // need comparable embeddings
          const cos = cosineSimilarity(va, vb);
          if (cos < cosineThreshold) continue;                         // high-confidence only

          const { winner, loser } = consolidationWinner(a, b);
          // Winner must be a live (admitted/promoted) row with enough
          // evidence; loser is retired INTO it. Never consolidate INTO a
          // quarantined/retired winner (status filter already excludes those
          // from the scan, but re-check defensively).
          if (winner.status !== "admitted" && winner.status !== "promoted") continue;
          if (observationCount(winner.posterior_alpha, winner.posterior_beta) < ARTIFACT_CONSOLIDATION_MIN_WINNER_OBS) continue;
          // Cycle safety: the winner must not itself be a retired alias source.
          if (aliasedOldIds.has(winner.id) || retiredThisPass.has(winner.id)) continue;

          // RETIRE the loser by aliasing it to the winner (wave-1 mechanism).
          // resolveArtifactId(loser) → winner thereafter; selection sees only
          // the winner; the loser's row is preserved (append-only, one-way).
          insertEvent(db, {
            kind: "act_artifact_aliased",
            directive_id: "3XETJCYT",
            task_id: "artifact_consolidation",
            loop_id: "substrate_consolidation",
            substrate_origin: "substrate_auto",
            payload: {
              old_id: loser.id,
              new_id: winner.id,
              reason: "consolidation",
              cosine: cos,
            },
            context_refs: [winner.id, loser.id],
          });
          // Durable evidence row (auditable + idempotency key for re-runs).
          insertEvent(db, {
            kind: "act_artifact_consolidated",
            directive_id: "3XETJCYT",
            task_id: "artifact_consolidation",
            loop_id: "substrate_consolidation",
            substrate_origin: "substrate_auto",
            payload: {
              winner_id: winner.id,
              loser_id: loser.id,
              kind: winner.kind,
              cosine: cos,
              winner_score: winner.score,
              winner_confidence: winner.confidence,
              loser_score: loser.score,
              loser_confidence: loser.confidence,
              winner_observations: observationCount(winner.posterior_alpha, winner.posterior_beta),
              loser_observations: observationCount(loser.posterior_alpha, loser.posterior_beta),
              shared_goal_shapes: (winner.meta?.goal_shapes ?? []).filter((s: string) =>
                (loser.meta?.goal_shapes ?? []).includes(s)),
            },
            context_refs: [winner.id, loser.id],
          });
          // Flip the loser's status to 'retired' so the selector + every
          // status-filtered surface stops considering it (the alias chain
          // handles citation redirection; the status flip handles selection).
          db.run(
            `UPDATE act_artifact SET status = 'retired', updated_at = ? WHERE id = ?`,
            [nowIso(), loser.id],
          );

          // In-pass bookkeeping so we cannot re-use these ids this tick.
          retiredThisPass.add(loser.id);
          aliasedOldIds.add(loser.id);
          consolidatedPairs.add(winner.id + " " + loser.id);
          consolidatedPairs.add(loser.id + " " + winner.id);
          consolidated++;
        }
      }
    }
  });

  // The alias cache (resolveArtifactId memoization) must be invalidated after
  // emitting act_artifact_aliased through the extractor's LOCAL insertEvent
  // (which bypasses the runtime/events.ts emitEvent post-write hook). Without
  // this the next resolveArtifactId(loser) would return the stale identity.
  if (consolidated > 0) {
    try {
      const { invalidateAliasCache } = require("../substrate/migration_runner") as typeof import("../substrate/migration_runner");
      invalidateAliasCache(db);
    } catch { /* fail-soft: cold cache rebuilds on next miss */ }
  }

  return { consolidated, groups_scanned: groupsScanned, pairs_examined: pairsExamined };
};

// ── 3b. Cross-candidate semantic corroboration extractor (T1.3) ────
//
// Promotion rate gap (live evidence 2026-05-19): 3324+ knowledge_candidate
// events vs ~311 knowledge_promoted (~9.3% rate). Many candidates never
// receive a direct `candidate_confirmed` because no downstream act
// intentionally cited them — but their CLAIM semantically corroborates
// already-promoted entries. This extractor walks the unverified tail,
// finds nearest promoted-knowledge neighbors via vec_events cosine
// (≥ 0.88), checks goal_shape overlap + positive polarity, and emits
// `candidate_confirmed` with `confirmation_source: "semantic_corroboration"`
// and a bootstrap weight of 0.3. The downstream knowledge-promotion
// extractor then folds these confirmations into the Beta posterior the
// same way direct citations are folded.
//
// Bounded: LIMIT 500 per tick + 30-day window. Idempotent: candidates
// that already received a `semantic_corroboration` confirmation are
// skipped. Yields to the event loop every 25 rows per KC GJ2KN1J3KD1Z.

// T2.1 / Tier-S4 — three of these defaults are now adaptive via the
// universal threshold registry. The hardcoded literals remain as the
// cold-start defaults (returned when no admitted threshold_predicate
// row exists). External callers can import the const for the canonical
// defaults; in-function consumers route through getThreshold().
//
// Canonical names (act_artifact.name):
//   - merger_corroboration_cosine_threshold   (default 0.88)
//   - merger_corroboration_polarity_floor     (default 0.85)
//   - merger_corroboration_credit_weight      (default 0.3)
//
// scanLimit / windowDays / knn remain non-adaptive — they bound the
// per-tick work, not the merger semantics.
export const CROSS_CANDIDATE_CORROBORATION_CONFIG = {
  // 2026-05-21: scanLimit 500→120. Each candidate runs a vec0 knn search
  // (~44ms); 500/tick was ~22s of CPU even after the candidates-query +
  // 2a-Set O(n²) fixes. The extractor runs reactively + every 5min, so a
  // 120-candidate batch (~5s) still drains the unverified backlog steadily
  // without pinning the daemon. Bounds per-tick work, not merger semantics.
  scanLimit: 120,
  windowDays: 30,
  cosineThreshold: 0.88,
  promotedScoreThreshold: 0.85,
  bootstrapWeight: 0.3,
  knn: 10,
} as const;

export type CrossCandidateCorroborationSummary = {
  scanned: number;
  corroborated: number;
  skipped_recent: number;
  skipped_existing: number;
};

const parsePayloadSafe = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== "string") return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
};

const parseRefsSafe = (raw: unknown): string[] => {
  if (!raw || typeof raw !== "string") return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as unknown[]).map(String) : [];
  } catch { return []; }
};

const goalShapeTagsFor = (payload: Record<string, unknown>): string[] => {
  const tags = payload.goal_shape_tags;
  if (Array.isArray(tags)) return (tags as unknown[]).map(String).filter((t) => t.length > 0);
  // Fallback: applies_to[] is the rich-schema sibling; accept it as a
  // surrogate when goal_shape_tags is absent (older candidate shape).
  const applies = payload.applies_to;
  if (Array.isArray(applies)) return (applies as unknown[]).map(String).filter((t) => t.length > 0);
  return [];
};

/** Scan unverified knowledge_candidate events, find nearest promoted
 *  neighbors via vec_events cosine, and emit candidate_confirmed
 *  (confirmation_source=semantic_corroboration) when the neighbor
 *  passes the cosine + goal-shape + polarity gates. See section
 *  comment above for design rationale. */
export const extractCrossCandidateCorroboration = async (
  db: Database,
): Promise<CrossCandidateCorroborationSummary> => {
  // Inter-extractor fairness: macrotask boundary at the top of the body.
  await extractorFairnessYield();
  const cfg = CROSS_CANDIDATE_CORROBORATION_CONFIG;
  const cutoffIso = new Date(Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000).toISOString();

  // Tier-S4: merger thresholds resolved via the universal registry.
  // Cold-start falls back to the hardcoded defaults from cfg; once a
  // threshold_predicate row is admitted, its Beta-posterior-ranked
  // value wins. Read once per pass — the inner loop reuses these.
  const cosineThreshold = getThreshold(
    db,
    "merger_corroboration_cosine_threshold",
    cfg.cosineThreshold,
  );
  const polarityFloor = getThreshold(
    db,
    "merger_corroboration_polarity_floor",
    cfg.promotedScoreThreshold,
  );
  const creditWeight = getThreshold(
    db,
    "merger_corroboration_credit_weight",
    cfg.bootstrapWeight,
  );

  // 1. Pull unverified candidates inside the time window.
  //    "Unverified" = no candidate_confirmed/contradicted citing this
  //    candidate id yet. The NOT-EXISTS sub-query LIKE-matches the
  //    candidate id token in context_refs JSON (mirrors the pattern
  //    used in maybePromoteKnowledge / extractSemanticDedup).
  // 2026-05-21 O(n²)→O(n) fix (owner: avoid O(n²), stay fast/reactive).
  // Pre-fix this used a CORRELATED `NOT EXISTS (… context_refs LIKE
  // '%"'||events.id||'"%')` — a leading-% LIKE (un-indexable) scanned over
  // all candidate_confirmed/contradicted events (37K+ on the live DB) FOR
  // EVERY knowledge_candidate in the window, until 500 unverified passed.
  // Since most candidates ARE confirmed, SQLite evaluated the full-scan
  // LIKE for thousands of candidates = O(N×M). Measured 48,625 ms — the
  // entire daemon-CPU burden ran through this one extractor.
  //
  // Fix: materialize the verified-candidate-id set ONCE via json_each over
  // the confirmed/contradicted context_refs arrays, then anti-join with
  // `id NOT IN (…)`. One scan + a hash anti-join instead of N full-scan
  // LIKEs. Semantics preserved (a candidate is "verified" iff some
  // confirmed/contradicted event cites its id in context_refs).
  // Routed off-loop via poolQuery (sync fallback) — scalar+text columns only.
  const candidates = (await poolQuery<{
    id: string;
    ts: string;
    directive_id: string;
    task_id: string;
    loop_id: string;
    payload: string;
  }>(
    db,
    `WITH verified_candidate_ids AS (
         SELECT DISTINCT je.value AS cand_id
         FROM events v, json_each(v.context_refs) je
         WHERE v.kind IN ('candidate_confirmed', 'candidate_contradicted')
       )
       SELECT id, ts, directive_id, task_id, loop_id, payload
       FROM events
       WHERE kind = 'knowledge_candidate'
         AND ts > ?
         AND id NOT IN (SELECT cand_id FROM verified_candidate_ids)
       ORDER BY ts DESC
       LIMIT ?`,
    [cutoffIso, cfg.scanLimit],
  ));

  let scanned = 0;
  let corroborated = 0;
  let skipped_recent = 0;
  let skipped_existing = 0;

  // 2. Probe whether vec_events is available. If the extension is
  //    absent (test envs without sqlite-vec wired in), every nearest-
  //    neighbor query would throw — fail soft by counting the
  //    candidate as skipped_existing (no embedding row).
  let vecAvailable = true;
  try {
    db.query("SELECT 1 FROM vec_events LIMIT 1").get();
  } catch {
    vecAvailable = false;
  }

  // 2026-05-21 O(n²)→O(n) fix (part 2): precompute the set of candidate ids
  // that ALREADY have a semantic_corroboration candidate_confirmed, ONCE.
  // Pre-fix the loop ran a per-candidate correlated double-LIKE (context_refs
  // LIKE + payload LIKE, both leading-%, un-indexable) over all 37K
  // candidate_confirmed rows — 500× full scans = the bulk of the remaining
  // 36s after the candidates-query fix. One scan + a Set membership check
  // (O(1)) replaces 500 full-scan queries.
  const semanticCorroboratedIds = new Set<string>();
  try {
    const rows = (await poolQuery<{ context_refs: string | null; payload: string | null }>(
      db,
      `SELECT context_refs, payload FROM events
         WHERE kind = 'candidate_confirmed'
           AND payload LIKE '%"confirmation_source":"semantic_corroboration"%'`,
    ));
    for (const row of rows) {
      try {
        for (const ref of JSON.parse(row.context_refs ?? "[]") as string[]) semanticCorroboratedIds.add(ref);
      } catch { /* tolerate malformed context_refs */ }
      try {
        const cid = (JSON.parse(row.payload ?? "{}") as { candidate_id?: string }).candidate_id;
        if (cid) semanticCorroboratedIds.add(cid);
      } catch { /* tolerate malformed payload */ }
    }
  } catch { /* fail-soft: empty set just means no idempotency skip */ }

  for (const cand of candidates) {
    if (scanned > 0 && scanned % EXTRACTOR_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
    scanned += 1;

    // 2a. Idempotency: skip if a prior semantic_corroboration confirm
    //     already references this candidate id (precomputed Set — O(1) —
    //     replacing the former per-candidate correlated double-LIKE scan).
    if (semanticCorroboratedIds.has(cand.id)) {
      skipped_existing += 1;
      continue;
    }

    if (!vecAvailable) {
      skipped_existing += 1;
      continue;
    }

    // 2b. Pull candidate embedding from vec_events. If absent (embedder
    //     hasn't backfilled this row yet) skip silently.
    let queryVec: number[] | null = null;
    try {
      // vec_events stores the embedding as the virtual table's float[]
      // column. Reading it back is the "embedding" alias; we serialise
      // via the embedding_index path by selecting the source events
      // row's embedding BLOB instead (cheaper + portable).
      const blobRow = db
        .query("SELECT embedding FROM events WHERE id = ?")
        .get(cand.id) as { embedding: Uint8Array | null } | null;
      if (!blobRow?.embedding) {
        skipped_existing += 1;
        continue;
      }
      const decoded = decodeEmbeddingBlob(blobRow.embedding);
      if (!decoded) {
        skipped_existing += 1;
        continue;
      }
      queryVec = Array.from(decoded);
    } catch {
      skipped_existing += 1;
      continue;
    }

    if (!queryVec) {
      skipped_existing += 1;
      continue;
    }

    // 2c. Top-K nearest neighbors via vec_events MATCH.
    let neighbors: Array<{ event_id: string; distance: number }> = [];
    try {
      neighbors = db
        .query(
          "SELECT event_id, distance FROM vec_events WHERE embedding MATCH ? AND k = ? ORDER BY distance",
        )
        .all(JSON.stringify(queryVec), cfg.knn) as Array<{ event_id: string; distance: number }>;
    } catch {
      skipped_existing += 1;
      continue;
    }

    // 2d. Walk neighbors. Distance convention matches
    //     runtime/embedding_index.ts (vec0 returns L2² between
    //     L2-normalised unit vectors → cosine_distance = distance / 2;
    //     cosine_similarity = 1 - distance / 2).
    const candPayload = parsePayloadSafe(cand.payload);
    const candTags = goalShapeTagsFor(candPayload);

    let matchedPromoted: { id: string; cosine: number } | null = null;
    for (const n of neighbors) {
      if (n.event_id === cand.id) continue;
      const cosineDistance = Math.max(0, Math.min(2, n.distance / 2));
      const cosine = 1 - cosineDistance;
      if (cosine < cosineThreshold) continue;

      // The neighbor row must be a knowledge_promoted (score ≥ threshold
      // + positive polarity). knowledge_candidate neighbors are common
      // for embedded events but the spec only credits promoted ones —
      // a co-promoted neighbor is the structurally-honest corroborator.
      const neighbor = db
        .query("SELECT id, kind, payload FROM events WHERE id = ?")
        .get(n.event_id) as { id: string; kind: string; payload: string } | null;
      if (!neighbor) continue;
      if (neighbor.kind !== "knowledge_promoted") continue;

      const promotedPayload = parsePayloadSafe(neighbor.payload);
      const promotedScore = typeof promotedPayload.score === "number" ? promotedPayload.score : NaN;
      if (!Number.isFinite(promotedScore) || promotedScore < polarityFloor) continue;

      // Goal-shape overlap: prefer at least one common tag; lenient
      // fallback when either side declares no tags.
      const neighborTags = goalShapeTagsFor(promotedPayload);
      if (candTags.length > 0 && neighborTags.length > 0) {
        const common = candTags.some((t) => neighborTags.includes(t));
        if (!common) continue;
      }

      matchedPromoted = { id: neighbor.id, cosine };
      break;
    }

    if (!matchedPromoted) {
      skipped_recent += 1;
      continue;
    }

    // 2e. Emit candidate_confirmed citing both rows.
    insertEvent(db, {
      kind: "candidate_confirmed",
      directive_id: cand.directive_id,
      task_id: cand.task_id,
      loop_id: cand.loop_id,
      substrate_origin: "substrate_auto",
      payload: {
        candidate_id: cand.id,
        confirmation_source: "semantic_corroboration",
        weight: creditWeight,
        matched_promoted_id: matchedPromoted.id,
        cosine_similarity: matchedPromoted.cosine,
        evidence_event_ids: [cand.id, matchedPromoted.id],
      },
      context_refs: [cand.id, matchedPromoted.id],
    });
    corroborated += 1;
  }

  return { scanned, corroborated, skipped_recent, skipped_existing };
};

// ── 4. Recipe-candidate extractor ──────────────────────────────────
//
// Group task_committed events by a coarse "goal shape" — the
// normalized goal text from the directive payload + the count of
// task nodes under that directive. Each cluster's Beta posterior
// (alpha from positive owner outcomes + low-residual closure audits;
// beta from negative outcomes + high-residual closures) is evaluated
// against a per-owner per-goal-class threshold by
// `evaluatePromotion` in runtime/posterior_promotion.ts. Clusters
// that clear the gate emit `recipe-shape knowledge` + `promoted recipe-shape knowledge`;
// clusters that fail emit `deferred recipe-shape knowledge` so the deferral
// is observable.
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

// Minimum sample size before the posterior gate is consulted at all. One
// committed shape gives the extractor a candidate to evaluate; the actual
// promotion decision is then per-owner per-goal-class through
// evaluatePromotion (runtime/posterior_promotion.ts) — there is no fixed
// success count gate. This replaces the legacy RECIPE_THRESHOLD = 3
// magic number (F5 roadmap, event WW7W1NZ8A10R52PB4E7EJE9YBW).
const RECIPE_MIN_OBSERVATIONS = 1;

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
 *  rows in chronological order. recipe-shape knowledge then cites these
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

export type RecipeCandidateSummary = { extracted: number; deferred?: number };

/** Walk every owner_observed_outcome_recorded and task_closure_audited row
 *  bound to the supplied directives and accumulate Beta posterior weight.
 *  Owner outcomes carry weight OWNER_SIGNAL_WEIGHT (1.0); closure verdicts
 *  carry CLOSURE_SIGNAL_WEIGHT (0.5). Sign is determined by the row's
 *  signal_class (open-string) or by closure_residual when no class is set. */
const collectRecipePosteriorEvidence = (
  db: Database,
  directiveIds: readonly string[],
): { alpha: number; beta: number } => {
  if (directiveIds.length === 0) return { alpha: 0, beta: 0 };
  const placeholders = directiveIds.map(() => "?").join(",");

  let alpha = 0;
  let beta = 0;

  // Owner observations: signal_class drives sign + weight. Fallback uses
  // the verdict / observed_outcome.verdict field that
  // residualFromOwnerObservedOutcome (runtime/credit.ts) already reads.
  const ownerRows = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'owner_observed_outcome_recorded'
         AND directive_id IN (${placeholders})`,
    )
    .all(...directiveIds) as Array<{ payload: string }>;
  for (const row of ownerRows) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(row.payload ?? "{}") as Record<string, unknown>; } catch { /* malformed */ }
    const signalClass = typeof p.signal_class === "string" ? p.signal_class : null;
    if (signalClass === "positive_strong") { alpha += 1.0; continue; }
    if (signalClass === "negative_strong") { beta += 1.0; continue; }
    if (signalClass === "positive_weak") { alpha += 0.7; continue; }
    if (signalClass === "negative_weak") { beta += 0.7; continue; }
    if (signalClass === "neutral") continue;
    // No explicit class — fall back to the verdict string.
    const observedOutcome = (p.observed_outcome ?? {}) as Record<string, unknown>;
    const verdict = String(p.verdict ?? observedOutcome.verdict ?? observedOutcome.outcome ?? "").toLowerCase();
    if (verdict === "positive" || verdict === "success" || verdict === "succeeded") alpha += 0.5;
    else if (verdict === "negative" || verdict === "failure" || verdict === "failed") beta += 0.5;
  }

  // Closure audits: residual < 0.3 → alpha weight 0.5; >= 0.3 → beta 0.5.
  const closureRows = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'task_closure_audited'
         AND directive_id IN (${placeholders})`,
    )
    .all(...directiveIds) as Array<{ payload: string }>;
  for (const row of closureRows) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(row.payload ?? "{}") as Record<string, unknown>; } catch { /* malformed */ }
    const cr = typeof p.closure_residual === "number"
      ? p.closure_residual
      : typeof p.residual === "number"
        ? (p.residual as number)
        : null;
    if (cr === null) continue;
    if (cr < 0.3) alpha += 0.5;
    else beta += 0.5;
  }

  return { alpha, beta };
};

export const extractRecipeCandidates = async (db: Database): Promise<RecipeCandidateSummary> => {
  // readMeta is a single indexed point-read; do it synchronously FIRST so a
  // fire-and-forget caller's earliest db touch completes before any close.
  const cursor = readMeta(db, META_KEYS.recipes);
  // Inter-extractor fairness: macrotask boundary before the heavy scans.
  await extractorFairnessYield();

  // Pull every recent task_committed event in the 30-day window.
  // Bounded by EXTRACTOR_SCAN_LIMIT per KC GJ2KN1J3KD1Z. Routed off-loop
  // via poolQuery (sync fallback) — scalar+text columns only.
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  const committed = (await poolQuery<Record<string, unknown>>(
    db,
    `SELECT id, ts, directive_id, task_id, loop_id, substrate_origin, payload
       FROM events
       WHERE kind = 'task_committed' AND ts >= ?
       ORDER BY ts ASC
       LIMIT ?`,
    [cutoff, EXTRACTOR_SCAN_LIMIT],
  ));
  // Yield once after the big read so the daemon /health route and
  // peer workers can advance before we walk the per-directive
  // sub-queries.
  await yieldToEventLoop();

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
  // Recipe-shaped knowledge rows replaced the recipe-shape knowledge event family
  // (universality proposal A12CR1QCDN0SS51CM95K39T45M). The payload still
  // carries goal_shape / topology_signature at top level for internal readers;
  // recipe_shape.enabled distinguishes recipe-shaped knowledge from regular
  // knowledge rows.
  const alreadyExtracted = new Set(
    (await poolQuery<{ payload: string }>(
      db,
      `SELECT payload FROM events WHERE kind IN ('knowledge_candidate', 'knowledge_promoted')
           AND COALESCE(
             json_extract(payload, '$.recipe_shape.enabled'),
             json_extract(payload, '$.recipe.enabled'),
             json_extract(payload, '$.is_recipe'),
             0
           ) IN (1, 'true')`,
    ))
      .map((r) => {
        try {
          const p = JSON.parse(r.payload) as { goal_shape?: string; topology_signature?: string };
          return `${p.goal_shape ?? ""}||${p.topology_signature ?? ""}`;
        } catch { return ""; }
      }),
  );

  // F5 (2026-05-18): the legacy gate was `entries.length < 3`. That fixed
  // count was advisory pretending to be structural — k_252 in miniature.
  // We now derive Beta posterior evidence per (goal_shape × topology) from
  // closure + owner-observation events on the cluster's directives and
  // route through evaluatePromotion. Threshold is per-owner per-goal-class
  // via runtime/posterior_promotion.ts.
  const ownerProfile = readLatestOwnerProfile(db);

  let extracted = 0;
  let deferred = 0;
  let latestTs = cursor;

  withImmediateTransaction(db, () => {
    for (const [compositeKey, entries] of shapeGroups) {
      if (entries.length < RECIPE_MIN_OBSERVATIONS) continue;
      if (alreadyExtracted.has(compositeKey)) continue;
      const directiveIds = Array.from(new Set(entries.map((e) => e.row.directive_id as string)));

      // Build Beta posterior from per-directive evidence:
      //   - owner_observed_outcome_recorded → alpha or beta with weight
      //     drawn from signal_class (1.0 strong, 0.7 weak, 0.5 fallback).
      //   - task_closure_audited → alpha weight 0.5 (residual < 0.3) or
      //     beta weight 0.5 (residual >= 0.3).
      //   - The task_committed rows that built the cluster contribute weight
      //     0.5 each as substrate-internal positive evidence. The brain
      //     committed the directive but no closure/owner audit has weighed in
      //     yet, so this is the same weight as a closure verdict — never
      //     enough on its own to cross the gate without a confirming signal.
      const evidence = collectRecipePosteriorEvidence(db, directiveIds);
      // Add a Beta(1, 1) uniform prior so a no-failure observation still
      // carries proper uncertainty (alpha=1, beta=0 would yield std=0 and
      // collapse the lower bound onto the mean — wrong for an unverified
      // win). One strong positive owner outcome on top of the prior gives
      // alpha=2, beta=1, which is exactly the case the F5 roadmap names as
      // the falsifying boundary (lower ≈ 0.43, crosses HIGH 0.4).
      const posteriorAlpha = evidence.alpha + entries.length * 0.5 + 1;
      const posteriorBeta = evidence.beta + 1;
      const goalClass = entries[entries.length - 1]!.goalShape.split("::")[0] ?? "";
      const verdict = evaluatePromotion(
        { posterior_alpha: posteriorAlpha, posterior_beta: posteriorBeta },
        ownerProfile,
        goalClass,
      );

      // Use the latest committed row's directive_id as the recipe's anchor.
      const anchor = entries[entries.length - 1]!.row;
      const goalShape = entries[entries.length - 1]!.goalShape;
      const topology = entries[entries.length - 1]!.topology;
      const trajectory = buildTrajectoryFor(db, anchor.directive_id as string);
      const entryIds = entries.map((e) => e.row.id as string);
      const trajectoryRefs = trajectoryEventIdsFor(db, anchor.directive_id as string);

      if (!verdict.promote) {
        // Record the deferral so operators can audit the gate decision; the
        // candidate stays unpromoted until later evidence shifts the
        // posterior. Recipe-shape knowledge rows replaced deferred recipe-shape knowledge
        // (universality proposal A12CR1QCDN0SS51CM95K39T45M); promotion_state
        // tracks the deferral verdict on the same substrate.
        insertEvent(db, {
          kind: "knowledge_candidate",
          substrate_origin: "substrate_auto",
          directive_id: anchor.directive_id as string,
          task_id: anchor.task_id as string,
          loop_id: anchor.loop_id as string,
          payload: {
            claim: `Reusable trajectory candidate for ${goalClass} lacks enough posterior support for promotion.`,
            evidence: [`confidence=${verdict.confidence}`, `threshold=${verdict.threshold}`, verdict.reason],
            implications: ["Keep the trajectory retrievable as candidate knowledge, but do not route it as promoted reusable knowledge yet."],
            applies_to: ["reusable_trajectory", goalClass],
            confidence_estimate: verdict.confidence,
            // Top-level mirrors for legacy readers (kept until all readers
            // switch to recipe_shape.* projections).
            goal_shape: goalShape,
            topology_signature: topology,
            goal_class: goalClass,
            posterior_alpha: posteriorAlpha,
            posterior_beta: posteriorBeta,
            confidence: verdict.confidence,
            threshold: verdict.threshold,
            mean: verdict.mean,
            std: verdict.std,
            sample_size: verdict.sample_size,
            reason: verdict.reason,
            directive_ids: directiveIds,
            window_days: 30,
            recipe_shape: {
              enabled: true,
              promotion_state: "deferred",
              goal_shape: goalShape,
              topology_signature: topology,
              goal_class: goalClass,
              posterior_alpha: posteriorAlpha,
              posterior_beta: posteriorBeta,
              confidence: verdict.confidence,
              threshold: verdict.threshold,
              mean: verdict.mean,
              std: verdict.std,
              sample_size: verdict.sample_size,
              reason: verdict.reason,
              directive_ids: directiveIds,
              window_days: 30,
              trajectory,
            },
          },
          context_refs: [...entryIds, ...trajectoryRefs],
        });
        deferred++;
        latestTs = anchor.ts as string;
        continue;
      }

      // Promotion gate passed — emit a recipe-shaped knowledge_candidate row
      // (trajectory cache) AND a paired knowledge_promoted row carrying the
      // posterior evidence. The recipe-shape knowledge/promoted recipe-shape knowledge event family
      // was absorbed into knowledge_* under universality proposal
      // A12CR1QCDN0SS51CM95K39T45M; recipe_shape.enabled distinguishes
      // recipe-shaped knowledge from regular knowledge rows.
      emitPromotionSpine(db, {
        kind: "knowledge_candidate",
        candidate_id: entryIds[0]!,
        extra_context_refs: [...entryIds.slice(1), ...trajectoryRefs],
        directive_id: anchor.directive_id as string,
        task_id: anchor.task_id as string,
        loop_id: anchor.loop_id as string,
        artifact_prefix: "recipe_cluster_extraction",
        payload: {
          claim: `Reusable trajectory for ${goalClass} is supported by repeated low-residual outcomes.`,
          evidence: [`success_count=${entries.length}`, `confidence=${verdict.confidence}`, `threshold=${verdict.threshold}`],
          implications: ["Retrieval may surface this trajectory as reusable knowledge; dispatch credit remains on dispatch_decided and action_scored outcomes."],
          applies_to: ["reusable_trajectory", goalClass],
          confidence_estimate: verdict.confidence,
          // Top-level mirrors for legacy readers.
          goal_shape: goalShape,
          topology_signature: topology,
          success_count: entries.length,
          window_days: 30,
          confidence: verdict.confidence,
          posterior_alpha: posteriorAlpha,
          posterior_beta: posteriorBeta,
          promotion_threshold: verdict.threshold,
          directive_ids: directiveIds,
          trajectory,
          recipe_shape: {
            enabled: true,
            promotion_state: "candidate_ready",
            goal_shape: goalShape,
            topology_signature: topology,
            success_count: entries.length,
            window_days: 30,
            confidence: verdict.confidence,
            posterior_alpha: posteriorAlpha,
            posterior_beta: posteriorBeta,
            promotion_threshold: verdict.threshold,
            threshold: verdict.threshold,
            mean: verdict.mean,
            std: verdict.std,
            sample_size: verdict.sample_size,
            reason: verdict.reason,
            directive_ids: directiveIds,
            trajectory,
          },
        },
      });
      insertEvent(db, {
        kind: "knowledge_promoted",
        substrate_origin: "substrate_auto",
        directive_id: anchor.directive_id as string,
        task_id: anchor.task_id as string,
        loop_id: anchor.loop_id as string,
        payload: {
          claim: `Reusable trajectory for ${goalClass} promoted with posterior confidence ${verdict.confidence.toFixed(2)}.`,
          evidence: [`posterior_alpha=${posteriorAlpha}`, `posterior_beta=${posteriorBeta}`, verdict.reason],
          implications: ["Dispatcher may route through substrate_replay when this knowledge matches a task's goal_shape/topology pair."],
          applies_to: ["reusable_trajectory", goalClass],
          confidence_estimate: verdict.confidence,
          goal_shape: goalShape,
          topology_signature: topology,
          goal_class: goalClass,
          posterior_alpha: posteriorAlpha,
          posterior_beta: posteriorBeta,
          confidence: verdict.confidence,
          threshold: verdict.threshold,
          mean: verdict.mean,
          std: verdict.std,
          sample_size: verdict.sample_size,
          reason: verdict.reason,
          directive_ids: directiveIds,
          recipe_shape: {
            enabled: true,
            promotion_state: "promoted",
            goal_shape: goalShape,
            topology_signature: topology,
            goal_class: goalClass,
            posterior_alpha: posteriorAlpha,
            posterior_beta: posteriorBeta,
            confidence: verdict.confidence,
            threshold: verdict.threshold,
            mean: verdict.mean,
            std: verdict.std,
            sample_size: verdict.sample_size,
            reason: verdict.reason,
            directive_ids: directiveIds,
          },
        },
        context_refs: [...entryIds, ...trajectoryRefs],
      });
      extracted++;
      latestTs = anchor.ts as string;
    }
    if (latestTs) writeMeta(db, META_KEYS.recipes, latestTs);
  });

  return { extracted, deferred };
};

// ── 5. Recipe extraction on every commit (inline, post-task_committed) ─
//
// `extractRecipeCandidates` (above) is the statistical 3-success path —
// the brain accumulates evidence before the substrate commits to caching
// a trajectory at confidence=0.5. That cadence depends on OwnerAutonomy / the
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
      `SELECT id, payload FROM events WHERE kind IN ('knowledge_candidate', 'knowledge_promoted')
         AND COALESCE(
           json_extract(payload, '$.recipe_shape.enabled'),
           json_extract(payload, '$.recipe.enabled'),
           json_extract(payload, '$.is_recipe'),
           0
         ) IN (1, 'true')
       ORDER BY ts DESC`,
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
             WHERE kind IN ('knowledge_candidate', 'knowledge_promoted')
               AND COALESCE(
                 json_extract(payload, '$.recipe_shape.enabled'),
                 json_extract(payload, '$.recipe.enabled'),
                 json_extract(payload, '$.is_recipe'),
                 0
               ) IN (1, 'true')
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
              kind: "knowledge_candidate",
              candidate_id: r.id,                       // the seed recipe being bumped
              extra_context_refs: [committed.id],       // the successful commit driving the bump
              directive_id: committed.directive_id,
              task_id: committed.task_id,
              loop_id: committed.loop_id ?? "",
              artifact_prefix: "recipe_confidence_bump",
              payload: {
                claim: `Reusable trajectory ${r.id} replay-success bumped confidence to ${bumped.toFixed(2)}.`,
                evidence: ["brain commit on matching goal_shape+topology", `previous_confidence=${latestConfidence}`],
                implications: ["Recipe-shape knowledge ratchets toward Tier-0 replay eligibility on repeat brain success."],
                applies_to: ["reusable_trajectory", goalShape],
                confidence_estimate: bumped,
                goal_shape: goalShape,
                topology_signature: topology,
                confidence: bumped,
                previous_confidence: latestConfidence,
                confidence_update: "brain_replay_success",
                derived_from_recipe_id: r.id,
                seeded_by: "inline_post_commit_bump",
                trajectory: seedTrajectory,
                recipe_shape: {
                  enabled: true,
                  promotion_state: "confidence_bump",
                  goal_shape: goalShape,
                  topology_signature: topology,
                  confidence: bumped,
                  previous_confidence: latestConfidence,
                  confidence_update: "brain_replay_success",
                  derived_from_recipe_id: r.id,
                  seeded_by: "inline_post_commit_bump",
                  trajectory: seedTrajectory,
                },
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
      kind: "knowledge_candidate",
      directive_id: committed.directive_id,
      task_id: committed.task_id,
      loop_id: committed.loop_id ?? "",
      substrate_origin: "substrate_auto",
      payload: {
        claim: `Reusable trajectory seeded inline from successful task_committed for goal_shape ${goalShape}.`,
        evidence: ["inline_post_commit seed", `topology=${topology}`],
        implications: ["Substrate retains a low-confidence reusable trajectory the dispatcher may replay once posterior support catches up."],
        applies_to: ["reusable_trajectory", goalShape],
        confidence_estimate: 0.5,
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
        recipe_shape: {
          enabled: true,
          promotion_state: "inline_seed",
          goal_shape: goalShape,
          topology_signature: topology,
          confidence: 0.5,
          success_count: 1,
          window_days: 30,
          directive_ids: [committed.directive_id],
          trajectory,
          seeded_by: "inline_post_commit",
        },
      },
      context_refs: [committed.id],
    });
  });
  return { extracted: 1, recipe_id: recipeId };
};

// ──────────────────────────────────────────────────────────────────────
// Auto cross-directive interference detection (organism-alignment Track C,
// 2026-05-15). Scans act_artifact rows for overlapping normalized
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

  // act_artifact.source_candidate_id points back to the originating
  // act_artifact_candidate event; that event's directive_id is the
  // artifact's owning goal. Old artifacts without source_candidate_id
  // are skipped — they pre-date the schema and we don't synthesize
  // ownership from heuristics (PRIOR 2: never silently fallback). The
  // candidate event lookup matches both the canonical kind string and
  // the F4a legacy alias so historical rows still resolve.
  const rows = db
    .query(
      `SELECT
         a.id                 AS artifact_id,
         a.target_resources   AS target_resources,
         e.directive_id       AS directive_id
       FROM act_artifact a
       LEFT JOIN events e
         ON e.kind IN (${ARTIFACT_CANDIDATE_KINDS_SQL})
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

export const extractDirectiveInterference = async (
  db: Database,
): Promise<DirectiveInterferenceSummary> => {
  // Inter-extractor fairness: macrotask boundary at the top of the body.
  await extractorFairnessYield();
  const byResource = collectArtifactDirectives(db);
  const existing = readExistingInterferencePairs(db);
  let proposed = 0;
  let deduped = 0;
  // Yield once before the pairwise emit loop — collectArtifactDirectives
  // can scan a large act_artifact table and we want the daemon /health
  // route to advance between the read and the emit phase.
  await yieldToEventLoop();

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
          task_id: "directive_interference_detection",
          loop_id: "extractDirectiveInterference",
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
  // act_artifact) and continues with citation credit. Best-effort:
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
export const extractOwnerProfilePromotions = async (
  db: Database,
): Promise<OwnerProfilePromotionSummary> => {
  // Inter-extractor fairness: macrotask boundary at the top of the body.
  await extractorFairnessYield();
  // Bounded scan per KC GJ2KN1J3KD1Z: cap at EXTRACTOR_SCAN_LIMIT
  // owner_insight_candidate rows. Ordered ASC so older candidates
  // (more likely to have accumulated sibling cosine evidence) come
  // first; idempotency in maybePromoteOwnerProfile makes re-runs safe.
  // Routed off-loop via poolQuery (sync fallback).
  const rows = (await poolQuery<{ id: string }>(
    db,
    `SELECT id FROM events
       WHERE kind = 'owner_insight_candidate'
       ORDER BY ts ASC
       LIMIT ?`,
    [EXTRACTOR_SCAN_LIMIT],
  ));
  let promoted = 0;
  let skipped = 0;
  let processed = 0;
  for (const r of rows) {
    if (processed > 0 && processed % EXTRACTOR_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
    processed += 1;
    const verdict = maybePromoteOwnerProfile(db, r.id);
    if (verdict.kind === "promoted") promoted++;
    else skipped++;
  }
  return { promoted, skipped };
};
