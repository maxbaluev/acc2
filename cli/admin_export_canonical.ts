// `acc admin export-canonical <path> --yes` — build release-owned canonical.db.
//
// The output is a fresh SQLite database containing only the portable-wisdom
// boundary from docs/Architecture.md. Export is deny-by-default: any row
// whose provenance touches owner-local/private-corpus events or raw owner text
// is refused, not redacted after the fact.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { closeDb, openDb } from "../substrate/db";
import { seedActArtifacts, seedArtifactKindMetadata, seedArtifactIds } from "../substrate/seed";
import { emitEvent } from "../runtime/events";

const OWNER_LOCAL_EVENT_KINDS = new Set([
  "owner_input_received",
  "owner_decision_recorded",
  "owner_observed_outcome_recorded",
  "owner_profile_recorded",
  "owner_insight_candidate",
  "rendered_owner_message_recorded",
  "telegram_chat_dump",
  "google_drive_doc_dump",
  "google_drive_doc_comments",
]);

const PRIVATE_SENSITIVITY = new Set(["private", "owner_private", "do_not_export"]);
const RAW_OWNER_FIELDS = new Set(["text", "directive_text", "owner_profile", "full_text"]);
const STRIP_FIELDS = new Set([
  "directive_id",
  "task_id",
  "parent_task_id",
  "loop_id",
  "evidence_event_ids",
  "evidence_ids",
  "raw_evidence_ids",
  "source_event_id",
  "source_event_ids",
  "source_owner",
  "source_install_id",
  "owner_profile",
  "owner_text",
  "directive_text",
  "full_text",
  "embedding",
  "embedding_version",
]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Counts = { artifacts: number; knowledge: number; metadata: number; denied: number };

export type ExportCanonicalResult = {
  ok: boolean;
  outputPath: string;
  sha256: string;
  counts: Counts;
  errors: string[];
};

export type ExportCanonicalOptions = {
  outputPath: string;
  sourceDb?: Database;
  sourceDbPath?: string;
  nowIso?: () => string;
};

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

const stableStringify = (value: unknown): string => JSON.stringify(value ?? null);

const sha256OfFile = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const hasForbiddenPayloadMarker = (payload: Record<string, unknown>): boolean => {
  if (payload.do_not_export === true) return true;
  if (typeof payload.sensitivity === "string" && PRIVATE_SENSITIVITY.has(payload.sensitivity)) return true;
  for (const key of Object.keys(payload)) {
    if (RAW_OWNER_FIELDS.has(key)) return true;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "body")) {
    const resources = JSON.stringify(payload.target_resources ?? payload.source_resources ?? payload);
    if (/private|owner|inflow|telegram|google_drive/i.test(resources)) return true;
  }
  return false;
};

const sanitizeJson = (value: unknown): Json => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (typeof value !== "object") return null;
  const out: Record<string, Json> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (STRIP_FIELDS.has(key)) continue;
    out[key] = sanitizeJson(child);
  }
  return out;
};

type EventRow = {
  id: string;
  ts: string;
  directive_id: string;
  task_id: string;
  parent_task_id: string | null;
  loop_id: string;
  substrate_origin: string;
  kind: string;
  payload: string;
  context_refs: string;
  predicted_residual: number | null;
  action_artifact_id: string | null;
  verifier_artifact_id: string | null;
  outcome: string | null;
  residual: number | null;
  payload_hash: string | null;
  blob_ref: string | null;
  failure_kind: string | null;
  invoker: string | null;
};

const eventIsForbidden = (row: EventRow): boolean => {
  if (OWNER_LOCAL_EVENT_KINDS.has(row.kind)) return true;
  return hasForbiddenPayloadMarker(parseJson<Record<string, unknown>>(row.payload, {}));
};

const provenanceEventsForArtifact = (db: Database, artifactId: string, sourceCandidateId: string | null): EventRow[] => {
  const rows = db.query(
    `SELECT id, ts, directive_id, task_id, parent_task_id, loop_id, substrate_origin,
            kind, payload, context_refs, predicted_residual, action_artifact_id,
            verifier_artifact_id, outcome, residual, payload_hash, blob_ref,
            failure_kind, invoker
       FROM events
      WHERE id = ?
         OR id = COALESCE(?, '')
         OR action_artifact_id = ?
         OR verifier_artifact_id = ?
         OR EXISTS (SELECT 1 FROM json_each(events.context_refs) WHERE value = ?)`,
  ).all(artifactId, sourceCandidateId, artifactId, artifactId, artifactId) as EventRow[];
  return rows;
};

const portableArtifactKind = (id: string, kind: string, stateRoot: string | null, seedIds: Set<string>): boolean => {
  if (seedIds.has(id)) return true;
  if (stateRoot?.startsWith("substrate/primitive")) return true;
  if (kind === "verifier" || kind === "artifact_kind_metadata") return true;
  if (kind.includes("predicate") || kind.includes("threshold")) return true;
  if (kind.includes("prompt") && kind.includes("bundle")) return true;
  if (kind.includes("recipe")) return true;
  if (kind.includes("dispatch_strategy")) return true;
  if (kind.includes("plugin_package")) return true;
  return false;
};

type ArtifactRow = {
  id: string;
  runtime: string | null;
  body: string;
  declared_sandbox: string | null;
  state_root: string | null;
  kind: string;
  posterior_alpha: number;
  posterior_beta: number;
  score: number;
  confidence: number;
  recent_residual_mean: number;
  recent_kill_count: number;
  status: string;
  name: string | null;
  fixture_input: string | null;
  fixture_expected_residual: number | null;
  intent: string | null;
  summary: string | null;
  target_files: string | null;
  target_resources: string | null;
  source_candidate_id: string | null;
  owner_gate_verdict: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  lost_version_count: number;
  created_at: string;
  updated_at: string;
};

const insertArtifact = (db: Database, row: ArtifactRow): void => {
  db.run(
    `INSERT INTO act_artifact (
       id, runtime, body, declared_sandbox, state_root, kind,
       posterior_alpha, posterior_beta, score, confidence,
       recent_residual_mean, recent_kill_count, status, name,
       fixture_input, fixture_expected_residual, intent, summary,
       target_files, target_resources, source_candidate_id, owner_gate_verdict,
       supersedes, superseded_by, lost_version_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       runtime = excluded.runtime,
       body = excluded.body,
       declared_sandbox = excluded.declared_sandbox,
       state_root = excluded.state_root,
       kind = excluded.kind,
       posterior_alpha = excluded.posterior_alpha,
       posterior_beta = excluded.posterior_beta,
       score = excluded.score,
       confidence = excluded.confidence,
       recent_residual_mean = excluded.recent_residual_mean,
       recent_kill_count = excluded.recent_kill_count,
       status = excluded.status,
       name = excluded.name,
       fixture_input = excluded.fixture_input,
       fixture_expected_residual = excluded.fixture_expected_residual,
       intent = excluded.intent,
       summary = excluded.summary,
       target_files = excluded.target_files,
       target_resources = excluded.target_resources,
       source_candidate_id = NULL,
       owner_gate_verdict = NULL,
       supersedes = excluded.supersedes,
       superseded_by = excluded.superseded_by,
       lost_version_count = excluded.lost_version_count,
       updated_at = excluded.updated_at`,
    [
      row.id, row.runtime, row.body, row.declared_sandbox, row.state_root, row.kind,
      row.posterior_alpha, row.posterior_beta, row.score, row.confidence,
      row.recent_residual_mean, row.recent_kill_count, row.status, row.name,
      row.fixture_input ? stableStringify(sanitizeJson(parseJson(row.fixture_input, null))) : null,
      row.fixture_expected_residual, row.intent, row.summary,
      row.target_files ? stableStringify(sanitizeJson(parseJson(row.target_files, []))) : null,
      row.target_resources ? stableStringify(sanitizeJson(parseJson(row.target_resources, []))) : null,
      null, null, row.supersedes, row.superseded_by, row.lost_version_count,
      row.created_at, row.updated_at,
    ],
  );
};

const insertCanonicalEvent = (db: Database, row: EventRow, payload: Record<string, unknown>, refs: string[] = []): void => {
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id, substrate_origin,
       kind, payload, context_refs, predicted_residual, action_artifact_id,
       verifier_artifact_id, outcome, residual, embedding, embedding_version,
       payload_hash, blob_ref, failure_kind, invoker
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [
      row.id, row.ts, "canonical", "canonical", null, "canonical", "substrate_auto",
      row.kind, stableStringify(sanitizeJson(payload)), stableStringify(refs),
      row.predicted_residual, row.action_artifact_id, row.verifier_artifact_id,
      row.outcome, row.residual, null, null, row.failure_kind, row.invoker,
    ],
  );
};

const candidateExportPayload = (payload: Record<string, unknown>): Record<string, unknown> => ({
  claim: payload.claim ?? payload.summary ?? null,
  tags: Array.isArray(payload.tags) ? payload.tags : [],
  proposed_tier: payload.proposed_tier,
  portable: payload.portable === true ? true : undefined,
  judgment_packet: payload.judgment_packet === true ? true : undefined,
  confidence_estimate: payload.confidence_estimate,
  applies_to: Array.isArray(payload.applies_to) ? payload.applies_to : undefined,
  implications: Array.isArray(payload.implications) ? payload.implications : undefined,
  source_files: Array.isArray(payload.source_files) ? payload.source_files : undefined,
});

const promotedExportPayload = (payload: Record<string, unknown>, candidateId: string | null): Record<string, unknown> => ({
  candidate_id: candidateId,
  score: typeof payload.score === "number" ? payload.score : 0.5,
  confidence: typeof payload.confidence === "number" ? payload.confidence : 0.3,
  posterior_alpha: payload.posterior_alpha,
  posterior_beta: payload.posterior_beta,
  goal_shape_tags: Array.isArray(payload.goal_shape_tags) ? payload.goal_shape_tags : undefined,
  type: payload.type,
  surface: payload.surface,
  section_name: payload.section_name,
  priority: payload.priority,
  version: payload.version,
  portable: true,
});

const copyArtifactKindMetadata = (source: Database, out: Database): number => {
  let copied = 0;
  const rows = source.query(
    `SELECT artifact_kind, needs_strategic_grounding, posterior_alpha, posterior_beta, last_updated_ts
       FROM artifact_kind_metadata`,
  ).all() as Array<{ artifact_kind: string; needs_strategic_grounding: number; posterior_alpha: number; posterior_beta: number; last_updated_ts: string }>;
  for (const row of rows) {
    out.run(
      `INSERT INTO artifact_kind_metadata
         (artifact_kind, needs_strategic_grounding, posterior_alpha, posterior_beta, last_updated_ts)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(artifact_kind) DO UPDATE SET
         needs_strategic_grounding = excluded.needs_strategic_grounding,
         posterior_alpha = excluded.posterior_alpha,
         posterior_beta = excluded.posterior_beta,
         last_updated_ts = excluded.last_updated_ts`,
      [row.artifact_kind, row.needs_strategic_grounding, row.posterior_alpha, row.posterior_beta, row.last_updated_ts],
    );
    copied++;
  }
  return copied;
};

const validateCanonicalDb = (db: Database): string[] => {
  const errors: string[] = [];
  const forbiddenKinds = db.query(
    `SELECT COUNT(*) AS c FROM events
      WHERE kind IN (${Array.from(OWNER_LOCAL_EVENT_KINDS).map(() => "?").join(",")})`,
  ).get(...Array.from(OWNER_LOCAL_EVENT_KINDS)) as { c: number };
  if (forbiddenKinds.c > 0) errors.push(`forbidden_event_kinds:${forbiddenKinds.c}`);
  const forbiddenPayload = db.query(
    `SELECT COUNT(*) AS c FROM events
      WHERE json_extract(payload, '$.do_not_export') = 1
         OR json_extract(payload, '$.sensitivity') IN ('private','owner_private','do_not_export')
         OR json_type(payload, '$.text') IS NOT NULL
         OR json_type(payload, '$.directive_text') IS NOT NULL
         OR json_type(payload, '$.owner_profile') IS NOT NULL
         OR json_type(payload, '$.full_text') IS NOT NULL`,
  ).get() as { c: number };
  if (forbiddenPayload.c > 0) errors.push(`forbidden_payload_fields:${forbiddenPayload.c}`);
  const artifactLeaks = db.query(
    `SELECT COUNT(*) AS c FROM act_artifact
      WHERE embedding IS NOT NULL OR source_candidate_id IS NOT NULL OR owner_gate_verdict IS NOT NULL`,
  ).get() as { c: number };
  if (artifactLeaks.c > 0) errors.push(`artifact_provenance_leaks:${artifactLeaks.c}`);
  return errors;
};

export const runExportCanonical = async (opts: ExportCanonicalOptions): Promise<ExportCanonicalResult> => {
  const outputPath = resolve(opts.outputPath);
  const source = opts.sourceDb ?? openDb(opts.sourceDbPath ?? "");
  const counts: Counts = { artifacts: 0, knowledge: 0, metadata: 0, denied: 0 };
  const errors: string[] = [];

  closeDb(outputPath);
  if (existsSync(outputPath)) rmSync(outputPath, { force: true });
  mkdirSync(dirname(outputPath), { recursive: true });
  const out = openDb(outputPath);

  try {
    seedActArtifacts(out);
    seedArtifactKindMetadata(out);
    counts.metadata += copyArtifactKindMetadata(source, out);

    const seedIds = new Set(seedArtifactIds());
    const artifacts = source.query(
      `SELECT id, runtime, body, declared_sandbox, state_root, kind,
              posterior_alpha, posterior_beta, score, confidence,
              recent_residual_mean, recent_kill_count, status, name,
              fixture_input, fixture_expected_residual, intent, summary,
              target_files, target_resources, source_candidate_id, owner_gate_verdict,
              supersedes, superseded_by, lost_version_count, created_at, updated_at
         FROM act_artifact`,
    ).all() as ArtifactRow[];

    for (const artifact of artifacts) {
      if (!portableArtifactKind(artifact.id, artifact.kind, artifact.state_root, seedIds)) { counts.denied++; continue; }
      const provenance = provenanceEventsForArtifact(source, artifact.id, artifact.source_candidate_id);
      if (provenance.some(eventIsForbidden)) { counts.denied++; continue; }
      insertArtifact(out, artifact);
      counts.artifacts++;
    }

    const promotedRows = source.query(
      `SELECT id, ts, directive_id, task_id, parent_task_id, loop_id, substrate_origin,
              kind, payload, context_refs, predicted_residual, action_artifact_id,
              verifier_artifact_id, outcome, residual, payload_hash, blob_ref,
              failure_kind, invoker
         FROM events WHERE kind = 'knowledge_promoted'`,
    ).all() as EventRow[];

    for (const promoted of promotedRows) {
      const promotedPayload = parseJson<Record<string, unknown>>(promoted.payload, {});
      const candidateId = typeof promotedPayload.candidate_id === "string"
        ? promotedPayload.candidate_id
        : parseJson<string[]>(promoted.context_refs, []).find((x) => typeof x === "string") ?? null;
      const candidate = candidateId ? source.query(
        `SELECT id, ts, directive_id, task_id, parent_task_id, loop_id, substrate_origin,
                kind, payload, context_refs, predicted_residual, action_artifact_id,
                verifier_artifact_id, outcome, residual, payload_hash, blob_ref,
                failure_kind, invoker
           FROM events WHERE id = ? LIMIT 1`,
      ).get(candidateId) as EventRow | null : null;
      const candidatePayload = candidate ? parseJson<Record<string, unknown>>(candidate.payload, {}) : {};
      const portable = promotedPayload.portable === true || candidatePayload.portable === true || candidatePayload.judgment_packet === true;
      if (!portable) { counts.denied++; continue; }
      if (eventIsForbidden(promoted) || (candidate && eventIsForbidden(candidate))) { counts.denied++; continue; }
      if (candidate) insertCanonicalEvent(out, candidate, candidateExportPayload(candidatePayload));
      insertCanonicalEvent(out, promoted, promotedExportPayload(promotedPayload, candidateId), candidateId ? [candidateId] : []);
      counts.knowledge++;
    }

    errors.push(...validateCanonicalDb(out));
    if (errors.length > 0) return { ok: false, outputPath, sha256: "", counts, errors };

    try { out.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
    const sha256 = sha256OfFile(outputPath);
    emitEvent(source, {
      kind: "state_exported",
      substrate_origin: "owner",
      payload: {
        mode: "canonical",
        output_path: outputPath,
        sha256,
        rows_shipped: counts.artifacts + counts.knowledge + counts.metadata,
        rows_denied: counts.denied,
        counts,
      },
    });
    return { ok: true, outputPath, sha256, counts, errors: [] };
  } finally {
    closeDb(outputPath);
  }
};

export type ExportCanonicalEnv = {
  out: (line: string) => void;
  err: (line: string) => void;
  openSubstrate?: () => Database;
  sourceDbPath?: string;
  yes?: boolean;
};

const HELP = `acc admin export-canonical — build release canonical.db

usage: acc admin export-canonical <path> --yes

  Writes a fresh SQLite canonical.db containing only portable-wisdom rows.
  Hard-excludes owner-local/private-corpus provenance and strips owner ids,
  raw evidence ids, embeddings, directive_id/task_id, and source-owner fields.
`;

export const runExportCanonicalCmd = async (argv: string[], env: ExportCanonicalEnv): Promise<number> => {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    env.out(HELP);
    return argv.length === 0 ? 1 : 0;
  }
  const outputPath = argv.find((arg) => !arg.startsWith("--"));
  if (!outputPath) {
    env.err("acc admin export-canonical: missing <path>");
    env.err(HELP);
    return 1;
  }
  const yes = env.yes ?? (argv.includes("--yes") || argv.includes("-y"));
  if (!yes) {
    env.err("acc admin export-canonical: missing --yes (release export approval gate)");
    return 1;
  }
  const sourceDb = env.openSubstrate ? env.openSubstrate() : openDb(env.sourceDbPath ?? "");
  const result = await runExportCanonical({ outputPath, sourceDb, sourceDbPath: env.sourceDbPath });
  if (!result.ok) {
    env.err(`acc admin export-canonical: failed: ${result.errors.join(", ")}`);
    return 1;
  }
  env.out(`acc admin export-canonical: wrote ${result.outputPath}`);
  env.out(`  rows shipped: ${result.counts.artifacts + result.counts.knowledge + result.counts.metadata}`);
  env.out(`  rows denied:  ${result.counts.denied}`);
  env.out(`  sha256:       ${result.sha256}`);
  return 0;
};
