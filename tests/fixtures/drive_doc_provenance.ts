// Test-only fixture for the supersedes chain walk. Seeds four
// drive-doc-shaped act_artifact rows wired v1 ← v2 ← v3 ← v4 so the
// chain helpers (`getProvenanceChain`, `markSuperseded`) have a
// deterministic ancestor list to assert against. v1..v3 are flagged
// trashed (lost_version_count=1 each); v4 is the surviving head. The
// fixture is invoked by `cli/artifact.test.ts` and
// `runtime/artifact_provenance.test.ts`; production `acc init` no
// longer seeds these rows so the universal substrate ships with zero
// domain-specific seed data.

import type { Database } from "bun:sqlite";
import { withImmediateTransaction } from "../../substrate/db";

const nowIso = (): string => new Date().toISOString();

export type DriveDocProvenanceFixtureSummary = { inserted: number; linked: number };

type FixtureEntry = {
  artifactId: string;
  driveDocId: string;
  name: string;
  trashed: boolean;
  predecessorOf: number;  // index of the artifact this version supersedes; -1 if root
};

export const DRIVE_DOC_PROVENANCE_FIXTURE_SEEDS: FixtureEntry[] = [
  {
    artifactId: "fixture_drive_doc_v1_trashed",
    driveDocId: "12-3Mv4u0RF8x1w6MGjDd8Vp1KTfZgH3W27tLDKmgWJk",
    name: "Drive doc fixture v1 (trashed)",
    trashed: true,
    predecessorOf: -1,
  },
  {
    artifactId: "fixture_drive_doc_v2_trashed",
    driveDocId: "1dzcacsEVA9LFytGu91Q_OLRGE0YGLhyvDySjCwanAqw",
    name: "Drive doc fixture v2 (trashed)",
    trashed: true,
    predecessorOf: 0,
  },
  {
    artifactId: "fixture_drive_doc_v3_trashed",
    driveDocId: "11nw_4-28eoab0JM5a7Mk_1-y6Mrz_rrN5waEsaYYHhI",
    name: "Drive doc fixture v3 (trashed)",
    trashed: true,
    predecessorOf: 1,
  },
  {
    artifactId: "fixture_drive_doc_v4_current",
    driveDocId: "15eF5ACjcP8oVaZC5t8PtRw1_CtT4diK0sn5d9IPgfxU",
    name: "Drive doc fixture v4 (current)",
    trashed: false,
    predecessorOf: 2,
  },
];

export const FIXTURE_DRIVE_DOC_PROVENANCE_HEAD_ID = "fixture_drive_doc_v4_current";
export const FIXTURE_DRIVE_DOC_PROVENANCE_SEED_IDS = DRIVE_DOC_PROVENANCE_FIXTURE_SEEDS.map((s) => s.artifactId);

/** Seed the fixture chain. Idempotent — INSERT OR IGNORE skips rows
 *  that already exist; the supersede edge is only flipped when not
 *  already set to the canonical successor. */
export const seedDriveDocProvenanceFixture = (
  db: Database,
): DriveDocProvenanceFixtureSummary => {
  let inserted = 0;
  let linked = 0;
  withImmediateTransaction(db, () => {
    const ts = nowIso();
    for (const entry of DRIVE_DOC_PROVENANCE_FIXTURE_SEEDS) {
      const supersedes = entry.predecessorOf >= 0
        ? DRIVE_DOC_PROVENANCE_FIXTURE_SEEDS[entry.predecessorOf]!.artifactId
        : null;
      const driveUri = `drive://document/${entry.driveDocId}`;
      const targetResources = JSON.stringify([driveUri]);
      const declaredSandbox = JSON.stringify({
        runtime: "bun",
        cpu_ms: 1000,
        wall_ms: 5000,
        memory_mb: 64,
      });
      const body =
        `// fixture provenance placeholder for ${driveUri}\n` +
        `// trashed=${entry.trashed}.`;
      const result = db.run(
        `INSERT OR IGNORE INTO act_artifact (
           id, runtime, kind, body, declared_sandbox, state_root,
           posterior_alpha, posterior_beta, score, confidence,
           recent_residual_mean, recent_kill_count, status, name,
           fixture_input, fixture_expected_residual,
           intent, summary, target_files, target_resources, source_candidate_id, owner_gate_verdict,
           supersedes, superseded_by, lost_version_count,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.artifactId,
          "bun",
          "published_drive_doc",
          body,
          declaredSandbox,
          "drive/provenance",
          1.0, 1.0, 0.5, 0.3,
          0, 0,
          "admitted",
          entry.name,
          JSON.stringify(null),
          0.2,
          "fixture_provenance_placeholder",
          `Fixture placeholder for Drive doc ${entry.driveDocId}; chain seeded by tests.`,
          null,
          targetResources,
          null,
          "auto",
          supersedes,
          null,
          entry.trashed ? 1 : 0,
          ts, ts,
        ],
      );
      if ((result as { changes?: number }).changes && (result as { changes: number }).changes > 0) {
        inserted++;
      }
    }
    // Second pass: wire each predecessor's superseded_by to the canonical
    // successor. INSERT OR IGNORE leaves the successor pointer NULL (we
    // don't know the successor at insert time); the second pass flips it
    // once.
    for (const entry of DRIVE_DOC_PROVENANCE_FIXTURE_SEEDS) {
      if (entry.predecessorOf < 0) continue;
      const priorId = DRIVE_DOC_PROVENANCE_FIXTURE_SEEDS[entry.predecessorOf]!.artifactId;
      const result = db.run(
        "UPDATE act_artifact SET superseded_by = ?, updated_at = ? WHERE id = ? AND (superseded_by IS NULL OR superseded_by = ?)",
        [entry.artifactId, ts, priorId, entry.artifactId],
      );
      if ((result as { changes?: number }).changes && (result as { changes: number }).changes > 0) {
        linked++;
      }
    }
  });
  return { inserted, linked };
};
