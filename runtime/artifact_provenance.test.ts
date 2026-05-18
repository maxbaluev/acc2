// acc2 artifact provenance tests — graph walk + markSuperseded
// idempotency + Lakeland backfill verification (C5,
// HJJS1665H961B2SRYHC5J85D14, 2026-05-18).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { getProvenanceChain, markSuperseded } from "./artifact_provenance";
import { insertArtifact, getArtifact } from "./artifact_store";
import {
  seedLakelandDriveProvenance,
  LAKELAND_PROVENANCE_HEAD_ID,
  LAKELAND_PROVENANCE_SEED_IDS,
} from "../substrate/seed";
import type { EmitEventInput } from "./events";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const captureEmit = (sink: EmitEventInput[]) => (event: EmitEventInput) => {
  sink.push(event);
};

const insertStub = (db: ReturnType<typeof openDb>, id: string, kind = "published_drive_doc", driveId?: string) =>
  insertArtifact(db, {
    id,
    runtime: "bun",
    kind,
    body: `// stub ${id}`,
    declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
    stateRoot: "test",
    posteriorAlpha: 1, posteriorBeta: 1, score: 0.5, confidence: 0.3,
    recentResidualMean: 0, recentKillCount: 0,
    status: "admitted",
    name: id,
    fixtureInput: null,
    fixtureExpectedResidual: 0.2,
    intent: null,
    summary: null,
    targetFiles: null,
    targetResources: driveId ? [`drive://document/${driveId}`] : null,
    sourceCandidateId: null,
    ownerGateVerdict: "auto",
  });

describe("getProvenanceChain — graph walk", () => {
  test("walks ancestors (oldest → most recent) and descendants (nearest → newest)", () => {
    const db = openDb(":memory:");
    insertStub(db, "art_v1", "published_drive_doc", "doc1");
    insertStub(db, "art_v2", "published_drive_doc", "doc2");
    insertStub(db, "art_v3", "published_drive_doc", "doc3");
    // Wire chain: v1 ← v2 ← v3.
    db.run("UPDATE code_artifact SET supersedes = ? WHERE id = ?", ["art_v1", "art_v2"]);
    db.run("UPDATE code_artifact SET supersedes = ?, superseded_by = NULL WHERE id = ?", ["art_v2", "art_v3"]);
    db.run("UPDATE code_artifact SET superseded_by = ? WHERE id = ?", ["art_v2", "art_v1"]);
    db.run("UPDATE code_artifact SET superseded_by = ? WHERE id = ?", ["art_v3", "art_v2"]);

    const fromHead = getProvenanceChain(db, "art_v3")!;
    expect(fromHead.head.artifact_id).toBe("art_v3");
    expect(fromHead.ancestors.map((a) => a.artifact_id)).toEqual(["art_v1", "art_v2"]);
    expect(fromHead.descendants.length).toBe(0);

    const fromMiddle = getProvenanceChain(db, "art_v2")!;
    expect(fromMiddle.ancestors.map((a) => a.artifact_id)).toEqual(["art_v1"]);
    expect(fromMiddle.descendants.map((d) => d.artifact_id)).toEqual(["art_v3"]);

    const fromRoot = getProvenanceChain(db, "art_v1")!;
    expect(fromRoot.ancestors.length).toBe(0);
    expect(fromRoot.descendants.map((d) => d.artifact_id)).toEqual(["art_v2", "art_v3"]);
  });

  test("returns null for unknown artifact_id", () => {
    const db = openDb(":memory:");
    expect(getProvenanceChain(db, "missing")).toBeNull();
  });

  test("bounds cycles defensively (no infinite loop)", () => {
    const db = openDb(":memory:");
    insertStub(db, "cyc_a", "published_drive_doc", "doc_a");
    insertStub(db, "cyc_b", "published_drive_doc", "doc_b");
    // Author a cycle on purpose (substrate has no integrity gate yet).
    db.run("UPDATE code_artifact SET supersedes = ?, superseded_by = ? WHERE id = ?", ["cyc_b", "cyc_b", "cyc_a"]);
    db.run("UPDATE code_artifact SET supersedes = ?, superseded_by = ? WHERE id = ?", ["cyc_a", "cyc_a", "cyc_b"]);
    const chain = getProvenanceChain(db, "cyc_a")!;
    // Walk stops at first repeated id; the cycle isn't surfaced as
    // infinite recursion.
    expect(chain.ancestors.length).toBeLessThanOrEqual(2);
    expect(chain.descendants.length).toBeLessThanOrEqual(2);
  });
});

describe("markSuperseded — idempotency + edge maintenance", () => {
  test("first call flips prior.superseded_by and emits code_artifact_superseded", () => {
    const db = openDb(":memory:");
    insertStub(db, "prior", "published_drive_doc", "p");
    insertStub(db, "successor", "published_drive_doc", "s");
    const events: EmitEventInput[] = [];
    const ok = markSuperseded(db, "prior", "successor", captureEmit(events));
    expect(ok).toBe(true);
    expect(getArtifact(db, "prior")?.supersededBy).toBe("successor");
    expect(events.filter((e) => e.kind === "code_artifact_superseded").length).toBe(1);
  });

  test("second call with same pair is a no-op (no duplicate event)", () => {
    const db = openDb(":memory:");
    insertStub(db, "prior", "published_drive_doc", "p");
    insertStub(db, "successor", "published_drive_doc", "s");
    const events: EmitEventInput[] = [];
    markSuperseded(db, "prior", "successor", captureEmit(events));
    const second = markSuperseded(db, "prior", "successor", captureEmit(events));
    expect(second).toBe(false);
    expect(events.filter((e) => e.kind === "code_artifact_superseded").length).toBe(1);
  });

  test("returns false if prior artifact missing", () => {
    const db = openDb(":memory:");
    insertStub(db, "successor", "published_drive_doc", "s");
    const events: EmitEventInput[] = [];
    expect(markSuperseded(db, "missing_prior", "successor", captureEmit(events))).toBe(false);
    expect(events.length).toBe(0);
  });
});

describe("Lakeland Drive backfill", () => {
  test("inserts 4 rows linked in a chain with lost_version_count=3 on head", () => {
    const db = openDb(":memory:");
    const summary = seedLakelandDriveProvenance(db);
    expect(summary.inserted).toBe(4);
    // All four ids present.
    for (const id of LAKELAND_PROVENANCE_SEED_IDS) {
      expect(getArtifact(db, id)).not.toBeNull();
    }
    const chain = getProvenanceChain(db, LAKELAND_PROVENANCE_HEAD_ID)!;
    expect(chain.head.artifact_id).toBe(LAKELAND_PROVENANCE_HEAD_ID);
    expect(chain.ancestors.map((a) => a.artifact_id)).toEqual([
      "seed_lakeland_drive_doc_v4_trashed",
      "seed_lakeland_drive_doc_v5_trashed",
      "seed_lakeland_drive_doc_v6_trashed",
    ]);
    expect(chain.lost_version_count).toBe(3);
    // Head is the surviving artifact (lost_version_count=0); each trashed
    // ancestor carries lost_version_count=1.
    expect(chain.head.lost_version_count).toBe(0);
    for (const a of chain.ancestors) expect(a.lost_version_count).toBe(1);
  });

  test("is idempotent — re-running does not duplicate rows", () => {
    const db = openDb(":memory:");
    const first = seedLakelandDriveProvenance(db);
    const second = seedLakelandDriveProvenance(db);
    expect(first.inserted).toBe(4);
    expect(second.inserted).toBe(0);
    const count = (db.query("SELECT COUNT(*) AS n FROM code_artifact WHERE id LIKE 'seed_lakeland_drive_doc_%'").get() as { n: number }).n;
    expect(count).toBe(4);
  });

  test("each backfill row stores the Drive doc id in target_resources as drive:// URI", () => {
    const db = openDb(":memory:");
    seedLakelandDriveProvenance(db);
    const head = getArtifact(db, LAKELAND_PROVENANCE_HEAD_ID)!;
    expect(head.targetResources?.length).toBe(1);
    expect(head.targetResources?.[0]!.scheme).toBe("drive");
    expect(head.targetResources?.[0]!.uri).toBe(
      "drive://document/15eF5ACjcP8oVaZC5t8PtRw1_CtT4diK0sn5d9IPgfxU",
    );
  });
});
