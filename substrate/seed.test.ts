// acc2 substrate seed tests — proves the seed entrypoints are
// idempotent and respect the owner-approval gate for foundational
// knowledge.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "./db";
import { seedArtifactIds, seedCodeArtifacts, seedFoundationalKnowledge } from "./seed";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("seedCodeArtifacts", () => {
  test("inserts every seed artifact on first run", () => {
    const db = openDb(":memory:");
    const summary = seedCodeArtifacts(db);
    expect(summary.inserted).toBeGreaterThanOrEqual(10);
    expect(summary.skipped).toBe(0);

    const rows = db.query("SELECT id, runtime, status, name FROM code_artifact ORDER BY id").all() as Array<{
      id: string;
      runtime: string;
      status: string;
      name: string | null;
    }>;
    const ids = rows.map((r) => r.id);
    for (const expectedId of seedArtifactIds()) {
      expect(ids).toContain(expectedId);
    }
    // Every seed starts at status 'admitted'.
    for (const r of rows) expect(r.status).toBe("admitted");
  });

  test("idempotent — running twice does not duplicate", () => {
    const db = openDb(":memory:");
    const first = seedCodeArtifacts(db);
    const second = seedCodeArtifacts(db);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(first.inserted);
    const count = (db.query("SELECT COUNT(*) AS c FROM code_artifact").get() as { c: number }).c;
    expect(count).toBe(first.inserted);
  });

  test("seed ids use the stable seed_<name> prefix", () => {
    const db = openDb(":memory:");
    seedCodeArtifacts(db);
    const ids = (db.query("SELECT id FROM code_artifact").all() as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) {
      expect(id.startsWith("seed_")).toBe(true);
    }
  });

  test("includes every runtime named in §11.4", () => {
    const db = openDb(":memory:");
    seedCodeArtifacts(db);
    const runtimes = new Set(
      (db.query("SELECT DISTINCT runtime FROM code_artifact").all() as Array<{ runtime: string }>).map((r) => r.runtime),
    );
    expect(runtimes.has("bun")).toBe(true);
    expect(runtimes.has("uv")).toBe(true);
    expect(runtimes.has("camofox-browser")).toBe(true);
  });

  test("seed_browser_session_act drives the new session.* facade (Batch 1.α)", () => {
    const db = openDb(":memory:");
    seedCodeArtifacts(db);
    const row = db
      .query("SELECT body, declared_sandbox FROM code_artifact WHERE id = ?")
      .get("seed_browser_session_act") as { body: string; declared_sandbox: string } | null;
    expect(row).not.toBeNull();
    if (!row) return;
    // Body uses the wrapper's session facade (goto / text / url), not raw
    // playwright / chromium identifiers — the body is wrapper-agnostic.
    expect(row.body).toContain("session.goto");
    expect(row.body).toContain("session.text");
    expect(row.body).toContain("session.url");
    expect(row.body).not.toContain("chromium");
    expect(row.body).not.toContain("playwright");
    // Declared sandbox carries the Batch 1.α fingerprint hints.
    const decl = JSON.parse(row.declared_sandbox) as Record<string, unknown>;
    expect(decl.fingerprint_os).toBe("linux");
    expect(decl.fingerprint_locale).toBe("en-US");
    expect(decl.headless).toBe(true);
  });
});

describe("seedFoundationalKnowledge", () => {
  test("no-ops when ownerApproved is false (default)", () => {
    const db = openDb(":memory:");
    const summary = seedFoundationalKnowledge(db, { ownerApproved: false });
    expect(summary.imported).toBe(0);
    const count = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_candidate'")
      .get() as { c: number }).c;
    expect(count).toBe(0);
  });

  test("no-ops when options is undefined", () => {
    const db = openDb(":memory:");
    const summary = seedFoundationalKnowledge(db);
    expect(summary.imported).toBe(0);
  });

  test("inserts on first run when ownerApproved is true; no-ops on second", () => {
    const db = openDb(":memory:");
    const first = seedFoundationalKnowledge(db, { ownerApproved: true });
    expect(first.imported).toBeGreaterThan(0);

    const candidateCount = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_candidate'")
      .get() as { c: number }).c;
    const promoteCount = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_promoted'")
      .get() as { c: number }).c;
    expect(candidateCount).toBe(first.imported);
    expect(promoteCount).toBe(first.imported);

    const second = seedFoundationalKnowledge(db, { ownerApproved: true });
    expect(second.imported).toBe(0);

    // Counts unchanged after second call.
    const candidateCount2 = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_candidate'")
      .get() as { c: number }).c;
    expect(candidateCount2).toBe(candidateCount);
  });

  test("every seeded knowledge event carries substrate_origin='substrate_auto'", () => {
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    const origins = new Set(
      (db
        .query(
          "SELECT DISTINCT substrate_origin FROM events WHERE kind IN ('knowledge_candidate','knowledge_promoted')",
        )
        .all() as Array<{ substrate_origin: string }>).map((r) => r.substrate_origin),
    );
    expect(origins.size).toBe(1);
    expect(origins.has("substrate_auto")).toBe(true);
  });

  test("each promoted event cites its candidate via context_refs", () => {
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    const promotions = db
      .query(
        "SELECT context_refs, payload FROM events WHERE kind = 'knowledge_promoted'",
      )
      .all() as Array<{ context_refs: string; payload: string }>;
    for (const p of promotions) {
      const refs = JSON.parse(p.context_refs) as string[];
      const payload = JSON.parse(p.payload) as { candidate_id?: string };
      expect(refs.length).toBe(1);
      expect(payload.candidate_id).toBeDefined();
      expect(refs[0]).toBe(payload.candidate_id);
    }
  });
});
