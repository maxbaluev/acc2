// Tests for `acc admin export-canonical` — release canonical.db boundary.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { runAdmin } from "./admin";
import { runExportCanonical, runExportCanonicalCmd } from "./admin_export_canonical";

type Db = ReturnType<typeof openDb>;

const insertEvent = (db: Db, fields: {
  id: string;
  kind: string;
  payload: unknown;
  context_refs?: string[];
  directive_id?: string;
  task_id?: string;
  action_artifact_id?: string | null;
  verifier_artifact_id?: string | null;
}): void => {
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id, substrate_origin,
       kind, payload, context_refs, action_artifact_id, verifier_artifact_id
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.id,
      "2026-05-21T00:00:00.000Z",
      fields.directive_id ?? "owner_directive_secret",
      fields.task_id ?? "owner_task_secret",
      "owner_loop_secret",
      "claude_root",
      fields.kind,
      JSON.stringify(fields.payload),
      JSON.stringify(fields.context_refs ?? []),
      fields.action_artifact_id ?? null,
      fields.verifier_artifact_id ?? null,
    ],
  );
};

const insertArtifact = (db: Db, fields: {
  id: string;
  kind: string;
  source_candidate_id?: string | null;
  posterior_alpha?: number;
  posterior_beta?: number;
  score?: number;
  confidence?: number;
}): void => {
  db.run(
    `INSERT INTO act_artifact (
       id, runtime, body, declared_sandbox, state_root, kind,
       posterior_alpha, posterior_beta, score, confidence,
       recent_residual_mean, recent_kill_count, status, name,
       fixture_input, fixture_expected_residual, intent, summary,
       target_files, target_resources, source_candidate_id, owner_gate_verdict,
       created_at, updated_at
     ) VALUES (?, 'bun', ?, '{}', 'substrate/primitive/test', ?, ?, ?, ?, ?, 0, 0,
               'promoted', ?, '{}', 0.1, NULL, NULL, NULL, ?, ?, 'owner_approved', ?, ?)`,
    [
      fields.id,
      `portable body for ${fields.id}`,
      fields.kind,
      fields.posterior_alpha ?? 8,
      fields.posterior_beta ?? 2,
      fields.score ?? 0.8,
      fields.confidence ?? 0.7,
      fields.id,
      JSON.stringify([`repo:${fields.id}`]),
      fields.source_candidate_id ?? null,
      "2026-05-21T00:00:00.000Z",
      "2026-05-21T00:00:00.000Z",
    ],
  );
};

describe("acc admin export-canonical", () => {
  let tmpRoot = "";

  afterEach(() => {
    closeDb();
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  const fixture = (): { db: Db; outPath: string } => {
    tmpRoot = mkdtempSync(join(tmpdir(), "acc2-canonical-"));
    const db = openDb(join(tmpRoot, "state.db"));
    runViews(db);

    insertArtifact(db, {
      id: "portable_predicate",
      kind: "owner_safe_predicate",
      posterior_alpha: 13,
      posterior_beta: 3,
      score: 0.91,
      confidence: 0.83,
    });
    insertEvent(db, {
      id: "KC_PORTABLE",
      kind: "knowledge_candidate",
      payload: {
        claim: "Portable verifier rows preserve posterior evidence.",
        portable: true,
        tags: ["canonical"],
        evidence_event_ids: ["RAW_EVIDENCE_SHOULD_NOT_EXPORT"],
      },
    });
    insertEvent(db, {
      id: "KP_PORTABLE",
      kind: "knowledge_promoted",
      payload: {
        candidate_id: "KC_PORTABLE",
        portable: true,
        score: 0.88,
        confidence: 0.77,
        posterior_alpha: 9,
        posterior_beta: 2,
      },
      context_refs: ["KC_PORTABLE", "RAW_EVIDENCE_SHOULD_NOT_EXPORT"],
    });

    insertEvent(db, {
      id: "PRIVATE_SOURCE",
      kind: "knowledge_candidate",
      payload: { claim: "private", do_not_export: true },
    });
    insertArtifact(db, { id: "private_verifier", kind: "verifier", source_candidate_id: "PRIVATE_SOURCE" });

    insertEvent(db, {
      id: "OWNER_LOCAL",
      kind: "owner_input_received",
      payload: { text: "owner secret words" },
    });
    insertArtifact(db, { id: "owner_local_recipe", kind: "recipe", source_candidate_id: "OWNER_LOCAL" });

    insertEvent(db, {
      id: "KC_PRIVATE_TEXT",
      kind: "knowledge_candidate",
      payload: { text: "raw corpus text", portable: true },
    });
    insertEvent(db, {
      id: "KP_PRIVATE_TEXT",
      kind: "knowledge_promoted",
      payload: { candidate_id: "KC_PRIVATE_TEXT", portable: true, score: 0.9, confidence: 0.9 },
      context_refs: ["KC_PRIVATE_TEXT"],
    });

    return { db, outPath: join(tmpRoot, "canonical.db") };
  };

  test("portable rows ship, posteriors are preserved, and owner identity is stripped", async () => {
    const { db, outPath } = fixture();
    const result = await runExportCanonical({ outputPath: outPath, sourceDb: db });
    expect(result.ok).toBe(true);
    expect(existsSync(outPath)).toBe(true);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);

    const out = new Database(outPath, { create: false, strict: true });
    try {
      const artifact = out.query(
        "SELECT posterior_alpha, posterior_beta, score, confidence, source_candidate_id, owner_gate_verdict, embedding FROM act_artifact WHERE id = 'portable_predicate'",
      ).get() as { posterior_alpha: number; posterior_beta: number; score: number; confidence: number; source_candidate_id: string | null; owner_gate_verdict: string | null; embedding: Uint8Array | null };
      expect(artifact.posterior_alpha).toBe(13);
      expect(artifact.posterior_beta).toBe(3);
      expect(artifact.score).toBe(0.91);
      expect(artifact.confidence).toBe(0.83);
      expect(artifact.source_candidate_id).toBeNull();
      expect(artifact.owner_gate_verdict).toBeNull();
      expect(artifact.embedding).toBeNull();

      const promoted = out.query("SELECT payload, directive_id, task_id, context_refs FROM events WHERE id = 'KP_PORTABLE'").get() as { payload: string; directive_id: string; task_id: string; context_refs: string };
      expect(promoted.directive_id).toBe("canonical");
      expect(promoted.task_id).toBe("canonical");
      expect(JSON.stringify(promoted)).not.toContain("RAW_EVIDENCE_SHOULD_NOT_EXPORT");
      expect(JSON.parse(promoted.payload).posterior_alpha).toBe(9);
    } finally {
      out.close();
    }
  });

  test("do_not_export provenance, owner-local kinds, and raw text are hard-excluded", async () => {
    const { db, outPath } = fixture();
    const result = await runExportCanonical({ outputPath: outPath, sourceDb: db });
    expect(result.ok).toBe(true);
    expect(result.counts.denied).toBeGreaterThanOrEqual(3);

    const out = new Database(outPath, { create: false, strict: true });
    try {
      const json = JSON.stringify(out.query("SELECT * FROM events").all()) + JSON.stringify(out.query("SELECT * FROM act_artifact").all());
      expect(json).not.toContain("private_verifier");
      expect(json).not.toContain("owner_local_recipe");
      expect(json).not.toContain("OWNER_LOCAL");
      expect(json).not.toContain("owner secret words");
      expect(json).not.toContain("raw corpus text");
      expect(json).not.toContain("KP_PRIVATE_TEXT");
      const forbiddenKinds = out.query(
        "SELECT COUNT(*) AS c FROM events WHERE kind IN ('owner_input_received','owner_decision_recorded','owner_observed_outcome_recorded','owner_profile_recorded','owner_insight_candidate','rendered_owner_message_recorded','telegram_chat_dump','google_drive_doc_dump','google_drive_doc_comments')",
      ).get() as { c: number };
      expect(forbiddenKinds.c).toBe(0);
    } finally {
      out.close();
    }
  });

  test("command refuses without --yes and admin dispatch routes export-canonical", async () => {
    const { db, outPath } = fixture();
    const err: string[] = [];
    const refused = await runExportCanonicalCmd([outPath], {
      out: () => {},
      err: (line) => err.push(line),
      openSubstrate: () => db,
      yes: false,
    });
    expect(refused).toBe(1);
    expect(err.join("\n")).toContain("missing --yes");

    const out: string[] = [];
    const routed = await runAdmin(["export-canonical", outPath, "--yes"], {
      version: { spawnSync: () => ({ status: 0, stdout: "", stderr: "" }) },
      stopDaemon: async () => false,
      startDaemon: async () => undefined,
      prompt: async () => "y",
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      yes: false,
      openSubstrate: () => db,
      stateDbPath: join(tmpRoot, "state.db"),
    });
    expect(routed).toBe(0);
    expect(out.join("\n")).toContain("export-canonical: wrote");
  });

  test("source audit event records mode, shipped/denied counts, and sha256", async () => {
    const { db, outPath } = fixture();
    const result = await runExportCanonical({ outputPath: outPath, sourceDb: db });
    expect(result.ok).toBe(true);
    const audit = db.query("SELECT payload FROM events WHERE kind = 'state_exported' ORDER BY ts DESC LIMIT 1").get() as { payload: string };
    const payload = JSON.parse(audit.payload) as Record<string, unknown>;
    expect(payload.mode).toBe("canonical");
    expect(payload.sha256).toBe(result.sha256);
    expect(payload.rows_shipped).toBeGreaterThan(0);
    expect(payload.rows_denied).toBeGreaterThan(0);
  });
});
