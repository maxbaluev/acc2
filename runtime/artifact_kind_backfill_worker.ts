// acc2 artifact_kind_backfill_worker — substrate-wide alias removal of the
// legacy kind="code_artifact" default. Per brain dispatch J4HP5SYT3N4GK45S
// (Candidate A), 1419/1493 act_artifact rows (97%) carry the legacy
// `code_artifact` default that pre-dates the open-vocabulary kind column
// (`merger` / `verifier` / `decider` / `action` / `predicate` / `extractor`
// / `promoter` / `exit_classifier`). Until the rows carry concrete kind
// values, every reader that filters by kind has to keep an
// `OR kind='code_artifact'` clause, and the kind column degenerates back
// into a boolean is/isn't-typed.
//
// The worker scans every `kind='code_artifact'` row, infers a concrete
// kind from weighted evidence per KC Q548WS9TZ57BFADKFJ:
//
//   1. Explicit declared kind in the name suffix
//      (`*_v1` → parse {verifier/decider/predicate/merger/extractor/...},
//      `*_action` → action).
//   2. Body signature: first 100 chars start with `verifier`/`merger`/
//      `extractor`/`promoter` keyword markers (case-insensitive).
//   3. declared_sandbox.runtime (`bun`/`uv` → action;
//      `camofox-browser` → browser_action).
//   4. state_root prefix (`substrate/auto_admit/verifier/*` → verifier).
//   5. source_candidate_id presence + target_resources content.
//
// High-confidence (≥ 0.75) verdicts update the row in place and emit
// `artifact_kind_backfilled`. Low-confidence verdicts leave the row alone
// and emit `artifact_kind_inference_uncertain` so the dashboards can
// count what the sweep declined to mutate. Every scanned row also emits
// one `artifact_kind_inferred` audit event carrying the full evidence
// map (per KC: the trail of WHY this kind was picked must be replayable).
//
// Idempotent: the worker SKIPs any row that already has an
// `artifact_kind_backfilled` event for it. Reruns are safe — only newly
// admitted code_artifact rows (or rows whose previous run produced an
// uncertain verdict and got new evidence) are re-evaluated.
//
// Single-sweep semantics (NOT periodic): registered in
// runtime/worker_autostart.ts with a one-shot trigger. The daemon kicks
// off the sweep on the first reactive tick after boot, then stops
// running it. Opt-out via `ACC2_DISABLE_WORKERS=artifact_kind_backfill`.
//
// Stage-2 follow-ups (deferred per dispatch plan):
//   - Stage 5: reader cleanup (`OR kind='code_artifact'` clauses).
//   - Stage 6: removal of the v1 code_artifact → act_artifact migration shim.
//   - Stage 7: views.ts drop of the legacy kind clause.
//
// None of these are touched by this worker — they wait until the sweep
// proves stable in production and the substrate verifies legacy count
// → 0 (or an explicit exemption set).

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

/** Default confidence floor that promotes an inference from uncertain
 *  → backfilled. Tunable per-sweep via BackfillOptions for tests. */
export const DEFAULT_CONFIDENCE_FLOOR = 0.75;

export type InferredKind =
  | "merger"
  | "verifier"
  | "extractor"
  | "promoter"
  | "decider"
  | "predicate"
  | "exit_classifier"
  | "action"
  | "browser_action"
  | "dispatch_strategy_v1"
  | "recipe"
  | "markdown_body"
  | "docx_reference_style"
  | "rendered_docx"
  | "published_drive_doc";

/** A single piece of structural evidence the inference uncovered for a row.
 *  Captured into the `artifact_kind_inferred` audit event so the trail of
 *  WHY this kind was picked is replayable. */
export type EvidenceMap = {
  name_pattern?: string | null;
  body_signature?: string | null;
  sandbox_runtime?: string | null;
  state_root_prefix?: string | null;
  source_candidate_id?: string | null;
  target_resources?: number | null;
};

export type InferenceVerdict = {
  /** The inferred concrete kind, or null when no evidence strand fired. */
  kind: InferredKind | null;
  /** Confidence ∈ [0, 1]. Weighted sum of triggered strands with cap at 1.0. */
  confidence: number;
  /** Per-strand evidence for the audit trail. */
  evidence: EvidenceMap;
  /** Candidate alternatives when no single strand dominated. Used for
   *  uncertain verdicts so dashboards can show which kinds were close. */
  candidate_kinds?: InferredKind[];
  candidate_confidences?: number[];
};

export type BackfillRow = {
  id: string;
  body: string;
  declared_sandbox: string;
  state_root: string;
  name: string | null;
  target_resources: string | null;
  source_candidate_id: string | null;
};

export type BackfillSummary = {
  /** Total rows visited in this sweep. */
  scanned: number;
  /** Rows whose kind column was actually updated in place. */
  backfilled: number;
  /** Rows the sweep declined to mutate (below confidence floor / no evidence). */
  uncertain: number;
  /** Rows skipped because a prior backfilled event already exists for them. */
  skipped_idempotent: number;
  /** Per-kind breakdown of backfills applied. */
  by_kind: Partial<Record<InferredKind, number>>;
  /** Sweep id stamped onto every emitted audit event. Used for cross-row
   *  joins in dashboards (one sweep = one batch). */
  sweep_id: string;
  /** error_caught style strings for failed update or emit attempts. */
  errors: string[];
};

export type BackfillOptions = {
  /** Hard cap on rows examined per sweep. Default 5000 (the live substrate
   *  has ~1419 affected rows; the cap absorbs growth). */
  maxRows?: number;
  /** Override the confidence floor. Default DEFAULT_CONFIDENCE_FLOOR (0.75). */
  confidenceFloor?: number;
  /** When true, only count what WOULD backfill — no UPDATE, no emit. */
  dryRun?: boolean;
  /** Override the sweep id (deterministic in tests). Default crypto.randomUUID. */
  sweepId?: string;
};

// ── Evidence strand 1: name suffix parsing ─────────────────────────────

/** Parse the name suffix for an explicit kind declaration. Examples:
 *  `closure_verifier_v1` → verifier, `dispatch_decider_v1` → decider,
 *  `lesson_apply_gate_action` → action, `predicate_gate_v1` → predicate.
 *  Returns null when no suffix matches. */
export const inferKindFromName = (name: string | null): {
  kind: InferredKind | null;
  pattern: string | null;
} => {
  if (typeof name !== "string" || name.length === 0) return { kind: null, pattern: null };
  const lower = name.toLowerCase();
  // _action suffix is unambiguous.
  if (/_action$/.test(lower) || /_action_v\d+$/.test(lower)) {
    return { kind: "action", pattern: "*_action" };
  }
  // _v\d+ rows expose the role in the segment preceding the version.
  // closure_verifier_v1, dispatch_decider_v1, lesson_extractor_v1, …
  const vMatch = lower.match(/^(.+?)_v\d+$/);
  if (vMatch) {
    const base = vMatch[1];
    if (/(^|_)verifier(_|$)/.test(base)) return { kind: "verifier", pattern: "*verifier*_v" };
    if (/(^|_)decider(_|$)/.test(base)) return { kind: "decider", pattern: "*decider*_v" };
    if (/(^|_)predicate(_|$)/.test(base) || /_gate$/.test(base))
      return { kind: "predicate", pattern: "*predicate*_v" };
    if (/(^|_)merger(_|$)/.test(base)) return { kind: "merger", pattern: "*merger*_v" };
    if (/(^|_)extractor(_|$)/.test(base)) return { kind: "extractor", pattern: "*extractor*_v" };
    if (/(^|_)promoter(_|$)/.test(base)) return { kind: "promoter", pattern: "*promoter*_v" };
    if (/(^|_)classifier(_|$)/.test(base)) return { kind: "decider", pattern: "*classifier*_v" };
    if (/(^|_)chooser(_|$)/.test(base)) return { kind: "decider", pattern: "*chooser*_v" };
    if (/(^|_)dispatch_strategy(_|$)/.test(base))
      return { kind: "dispatch_strategy_v1", pattern: "*dispatch_strategy_v" };
  }
  return { kind: null, pattern: null };
};

// ── Evidence strand 2: body signature ─────────────────────────────────

/** Scan the FIRST 200 characters of the artifact body for a role
 *  keyword. Returns the matched keyword (for evidence) plus the inferred
 *  kind. The 200-char window keeps the scan O(rows) regardless of body
 *  size — the keyword is expected to appear in the leading comment or
 *  the docstring. */
export const inferKindFromBody = (body: string | null | undefined): {
  kind: InferredKind | null;
  signature: string | null;
} => {
  if (typeof body !== "string" || body.length === 0) return { kind: null, signature: null };
  const head = body.slice(0, 200).toLowerCase();
  // Order matters — more specific markers first.
  if (/^\s*(\/\/|#)?\s*verifier/.test(head) || /\bverifier\b/.test(head.slice(0, 100)))
    return { kind: "verifier", signature: "verifier_keyword" };
  if (/^\s*(\/\/|#)?\s*merger/.test(head) || /\bmerger\b/.test(head.slice(0, 100)))
    return { kind: "merger", signature: "merger_keyword" };
  if (/^\s*(\/\/|#)?\s*extractor/.test(head) || /\bextractor\b/.test(head.slice(0, 100)))
    return { kind: "extractor", signature: "extractor_keyword" };
  if (/^\s*(\/\/|#)?\s*promoter/.test(head) || /\bpromoter\b/.test(head.slice(0, 100)))
    return { kind: "promoter", signature: "promoter_keyword" };
  if (/^\s*(\/\/|#)?\s*exit/.test(head) || /\bexit_classifier\b/.test(head.slice(0, 100)))
    return { kind: "exit_classifier", signature: "exit_keyword" };
  if (/^\s*(\/\/|#)?\s*decider/.test(head) || /\bdecider\b/.test(head.slice(0, 100)))
    return { kind: "decider", signature: "decider_keyword" };
  if (/^\s*(\/\/|#)?\s*predicate/.test(head) || /\bpredicate\b/.test(head.slice(0, 100)))
    return { kind: "predicate", signature: "predicate_keyword" };
  return { kind: null, signature: null };
};

// ── Evidence strand 3: declared_sandbox.runtime ───────────────────────

/** Read the sandbox runtime tag from the JSON-encoded declared_sandbox
 *  column. Empty / malformed returns null. */
export const inferKindFromSandbox = (declaredSandbox: string | null | undefined): {
  kind: InferredKind | null;
  runtime: string | null;
} => {
  if (typeof declaredSandbox !== "string" || declaredSandbox.length === 0) {
    return { kind: null, runtime: null };
  }
  try {
    const parsed = JSON.parse(declaredSandbox) as { runtime?: unknown };
    const runtime = typeof parsed.runtime === "string" ? parsed.runtime : null;
    if (runtime === "camofox-browser") return { kind: "browser_action", runtime };
    if (runtime === "bun" || runtime === "uv") return { kind: "action", runtime };
    return { kind: null, runtime };
  } catch {
    return { kind: null, runtime: null };
  }
};

// ── Evidence strand 4: state_root prefix ──────────────────────────────

/** Match well-known state_root prefixes to a concrete kind. */
export const inferKindFromStateRoot = (stateRoot: string | null | undefined): {
  kind: InferredKind | null;
  prefix: string | null;
} => {
  if (typeof stateRoot !== "string" || stateRoot.length === 0) {
    return { kind: null, prefix: null };
  }
  if (stateRoot.startsWith("substrate/auto_admit/verifier_handle/")) {
    return { kind: "verifier", prefix: "substrate/auto_admit/verifier_handle/" };
  }
  if (stateRoot.startsWith("substrate/auto_admit/verifier/")) {
    return { kind: "verifier", prefix: "substrate/auto_admit/verifier/" };
  }
  if (stateRoot.startsWith("dispatch/strategy")) {
    return { kind: "dispatch_strategy_v1", prefix: "dispatch/strategy" };
  }
  if (stateRoot.startsWith("recipes/")) {
    return { kind: "recipe", prefix: "recipes/" };
  }
  if (stateRoot.startsWith("render/markdown")) {
    return { kind: "markdown_body", prefix: "render/markdown" };
  }
  if (stateRoot.startsWith("render/docx_reference")) {
    return { kind: "docx_reference_style", prefix: "render/docx_reference" };
  }
  if (stateRoot.startsWith("render/rendered_docx")) {
    return { kind: "rendered_docx", prefix: "render/rendered_docx" };
  }
  if (stateRoot.startsWith("render/published")) {
    return { kind: "published_drive_doc", prefix: "render/published" };
  }
  if (stateRoot.startsWith("substrate/primitive/")) {
    return { kind: "action", prefix: "substrate/primitive/" };
  }
  return { kind: null, prefix: null };
};

// ── Verdict composition ───────────────────────────────────────────────

/** Compose the four evidence strands into a single weighted verdict.
 *  Weights (sum >= 1.0 caps at 1.0):
 *    name suffix      → 0.70  (strongest signal — explicit declaration)
 *    body signature   → 0.45
 *    state_root prefix→ 0.30  (known taxonomy)
 *    sandbox runtime  → 0.10  (weakest — bun runtime can mean anything)
 *  Strands that pick DIFFERENT kinds compete: the kind with the highest
 *  total weight wins; ties resolve to the kind from the earliest-priority
 *  strand (name > body > state_root > sandbox). When no strand fires the
 *  verdict is null with confidence 0. */
export const composeVerdict = (row: BackfillRow): InferenceVerdict => {
  const evidence: EvidenceMap = {};
  const strands: Array<{ kind: InferredKind; weight: number; priority: number }> = [];

  const fromName = inferKindFromName(row.name);
  if (fromName.kind !== null) {
    evidence.name_pattern = fromName.pattern;
    strands.push({ kind: fromName.kind, weight: 0.70, priority: 1 });
  } else {
    evidence.name_pattern = null;
  }

  const fromBody = inferKindFromBody(row.body);
  if (fromBody.kind !== null) {
    evidence.body_signature = fromBody.signature;
    strands.push({ kind: fromBody.kind, weight: 0.45, priority: 2 });
  } else {
    evidence.body_signature = null;
  }

  const fromStateRoot = inferKindFromStateRoot(row.state_root);
  if (fromStateRoot.kind !== null) {
    evidence.state_root_prefix = fromStateRoot.prefix;
    strands.push({ kind: fromStateRoot.kind, weight: 0.30, priority: 3 });
  } else {
    evidence.state_root_prefix = null;
  }

  const fromSandbox = inferKindFromSandbox(row.declared_sandbox);
  evidence.sandbox_runtime = fromSandbox.runtime ?? null;
  if (fromSandbox.kind !== null) {
    strands.push({ kind: fromSandbox.kind, weight: 0.10, priority: 4 });
  }

  evidence.source_candidate_id = row.source_candidate_id ?? null;
  let trCount: number | null = null;
  if (typeof row.target_resources === "string" && row.target_resources.length > 0) {
    try {
      const parsed = JSON.parse(row.target_resources);
      if (Array.isArray(parsed)) trCount = parsed.length;
    } catch {
      trCount = null;
    }
  }
  evidence.target_resources = trCount;

  if (strands.length === 0) {
    return { kind: null, confidence: 0, evidence };
  }

  // Group strands by kind, sum weights, pick the winner.
  const totals = new Map<InferredKind, { weight: number; priority: number }>();
  for (const s of strands) {
    const prev = totals.get(s.kind);
    if (prev) {
      prev.weight += s.weight;
      // Keep the earliest priority for tie-breaks.
      if (s.priority < prev.priority) prev.priority = s.priority;
    } else {
      totals.set(s.kind, { weight: s.weight, priority: s.priority });
    }
  }
  const sorted = [...totals.entries()].sort((a, b) => {
    if (b[1].weight !== a[1].weight) return b[1].weight - a[1].weight;
    return a[1].priority - b[1].priority;
  });
  const winner = sorted[0];
  const candidate_kinds = sorted.slice(0, 3).map(([k]) => k);
  const candidate_confidences = sorted.slice(0, 3).map(([, v]) => Math.min(1, v.weight));
  return {
    kind: winner[0],
    confidence: Math.min(1, winner[1].weight),
    evidence,
    candidate_kinds,
    candidate_confidences,
  };
};

// ── Idempotency probe ─────────────────────────────────────────────────

/** Returns true when the row already has a `artifact_kind_backfilled` event
 *  emitted by a prior sweep. The worker SKIPs such rows so reruns are
 *  no-ops. The probe also covers UPDATEs the worker itself emitted —
 *  artifact_id is the canonical join key. */
const hasExistingBackfill = (db: Database, artifactId: string): boolean => {
  const row = db
    .query<{ c: number }, [string, string]>(
      `SELECT COUNT(*) AS c FROM events
        WHERE kind = ?
          AND json_extract(payload, '$.artifact_id') = ?`,
    )
    .get("artifact_kind_backfilled", artifactId);
  return (row?.c ?? 0) > 0;
};

/** Returns true when the row already has a prior `artifact_kind_inferred`
 *  event. The high-confidence path UPDATEs `act_artifact.kind` so the row
 *  naturally leaves the `WHERE kind = 'code_artifact'` selector; the
 *  uncertain path does NOT mutate kind, so without this probe the worker
 *  re-emits artifact_kind_inferred + artifact_kind_inference_uncertain on
 *  EVERY sweep for the same row. Live evidence: 9536 emissions in 10
 *  minutes saturated the event loop and starved the MCP server, killing a
 *  brain dispatch with mcp_call_failed:Request timed out. */
const hasExistingInference = (db: Database, artifactId: string): boolean => {
  const row = db
    .query<{ c: number }, [string, string]>(
      `SELECT COUNT(*) AS c FROM events
        WHERE kind = ?
          AND json_extract(payload, '$.artifact_id') = ?`,
    )
    .get("artifact_kind_inferred", artifactId);
  return (row?.c ?? 0) > 0;
};

// ── Worker tick ───────────────────────────────────────────────────────

/** Single sweep run. Scans every row with kind='code_artifact', composes
 *  a verdict from the four evidence strands, updates kind in place when
 *  confidence ≥ floor, emits the canonical audit-event triple per row.
 *  Returns a structured summary the daemon's supervisedTick can log. */
/** Yield every YIELD_EVERY_N_ROWS rows so the daemon's event loop can
 *  process /health probes, MCP calls, and other reactive workers while
 *  the sweep runs. Pre-fix, 1072 rows × (composeVerdict + 2 emitEvent
 *  + activation-bus publishes) ran fully synchronously and held the
 *  Bun event loop for 9+ minutes — daemon ports were bound but every
 *  request 30s-timed-out behind this loop. Per substrate KC
 *  GJ2KN1J3KD1Z (bounded amendments per worker): the chunked-yield
 *  pattern lets long sweeps share the event loop with request handlers.
 *  25 rows × ~5ms each = ~125ms per chunk between yields — short enough
 *  that /health stays sub-second even mid-sweep. */
const YIELD_EVERY_N_ROWS = 25;
const yieldToEventLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export const runArtifactKindBackfill = async (
  db: Database,
  options: BackfillOptions = {},
): Promise<BackfillSummary> => {
  const maxRows = Math.max(1, options.maxRows ?? 5000);
  const confidenceFloor = options.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
  const dryRun = options.dryRun ?? false;
  const sweepId = options.sweepId ?? `sweep_${crypto.randomUUID()}`;

  const summary: BackfillSummary = {
    scanned: 0,
    backfilled: 0,
    uncertain: 0,
    skipped_idempotent: 0,
    by_kind: {},
    sweep_id: sweepId,
    errors: [],
  };

  let rows: BackfillRow[];
  try {
    rows = db
      .query<BackfillRow, [number]>(
        `SELECT id, body, declared_sandbox, state_root, name,
                target_resources, source_candidate_id
         FROM act_artifact
         WHERE kind = 'code_artifact'
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(maxRows);
  } catch (err) {
    summary.errors.push(`scan_failed:${(err as Error).message}`);
    return summary;
  }

  summary.scanned = rows.length;

  let processedSinceYield = 0;
  for (const row of rows) {
    // Yield to event loop every YIELD_EVERY_N_ROWS rows so request
    // handlers (MCP, /health) and other reactive workers can run.
    if (processedSinceYield >= YIELD_EVERY_N_ROWS) {
      await yieldToEventLoop();
      processedSinceYield = 0;
    }
    processedSinceYield++;
    // Skip rows we've already inferred against (high-confidence backfilled
    // path UPDATEs the kind column so the row leaves the WHERE clause; the
    // uncertain path does not, so we need a separate event-based check to
    // prevent re-emitting on every sweep).
    if (hasExistingBackfill(db, row.id) || hasExistingInference(db, row.id)) {
      summary.skipped_idempotent++;
      continue;
    }

    const verdict = composeVerdict(row);
    const evidencePayload: JsonValue = {
      name_pattern: verdict.evidence.name_pattern ?? null,
      body_signature: verdict.evidence.body_signature ?? null,
      sandbox_runtime: verdict.evidence.sandbox_runtime ?? null,
      state_root_prefix: verdict.evidence.state_root_prefix ?? null,
      source_candidate_id: verdict.evidence.source_candidate_id ?? null,
      target_resources: verdict.evidence.target_resources ?? null,
    };

    // Always emit the per-row inference verdict for the audit trail.
    if (!dryRun) {
      try {
        emitEvent(db, {
          kind: "artifact_kind_inferred",
          substrate_origin: "substrate_auto",
          context_refs: [row.id],
          payload: {
            artifact_id: row.id,
            inferred_kind: verdict.kind,
            confidence: verdict.confidence,
            evidence: evidencePayload,
            sweep_id: sweepId,
          },
        });
      } catch (err) {
        summary.errors.push(`emit_inferred_failed:${row.id}:${(err as Error).message}`);
      }
    }

    if (verdict.kind === null || verdict.confidence < confidenceFloor) {
      summary.uncertain++;
      if (!dryRun) {
        try {
          emitEvent(db, {
            kind: "artifact_kind_inference_uncertain",
            substrate_origin: "substrate_auto",
            context_refs: [row.id],
            payload: {
              artifact_id: row.id,
              candidate_kinds: verdict.candidate_kinds ?? [],
              confidences: verdict.candidate_confidences ?? [],
              reason: "below_confidence_threshold",
              sweep_id: sweepId,
            },
          });
        } catch (err) {
          summary.errors.push(`emit_uncertain_failed:${row.id}:${(err as Error).message}`);
        }
      }
      continue;
    }

    // High-confidence verdict → UPDATE the kind column in place + emit
    // the canonical backfilled audit event.
    if (!dryRun) {
      try {
        db.run(
          `UPDATE act_artifact SET kind = ?, updated_at = datetime('now') WHERE id = ?`,
          [verdict.kind, row.id],
        );
        emitEvent(db, {
          kind: "artifact_kind_backfilled",
          substrate_origin: "substrate_auto",
          context_refs: [row.id],
          payload: {
            artifact_id: row.id,
            previous_kind: "code_artifact",
            new_kind: verdict.kind,
            confidence: verdict.confidence,
            sweep_id: sweepId,
          },
        });
      } catch (err) {
        summary.errors.push(`update_failed:${row.id}:${(err as Error).message}`);
        continue;
      }
    }
    summary.backfilled++;
    summary.by_kind[verdict.kind] = (summary.by_kind[verdict.kind] ?? 0) + 1;
  }

  return summary;
};
