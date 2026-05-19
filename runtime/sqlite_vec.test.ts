// sqlite-vec smoke — proves the extension loads and the vec_events virtual
// table behaves the way runtime/embedder.ts and runtime/embedding_index.ts
// rely on. Hermetic (in-memory db, no API calls).
//
// Coverage:
//   1. The extension loads at openDb time (db.ts loads it before runSchema).
//   2. The vec_events virtual table exists with the expected dim (1536).
//   3. INSERT + KNN ordering is correct over a small synthetic set.
//   4. Aux/metadata WHERE filters work in MATCH queries.
//   5. Dim mismatch insert raises an error — this is the contract that the
//      EmbeddingIndex wrapper's try/catch relies on for its JS-fallback path.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";

afterAll(() => closeDb());
beforeEach(() => closeDb());
afterEach(() => closeDb());

const makeUnitVec = (dims: number, axis: number): number[] => {
  const v = new Array<number>(dims).fill(0);
  v[axis] = 1;
  return v;
};

describe("sqlite-vec extension + vec_events virtual table", () => {
  test("vec_version() reports a non-empty string", () => {
    const db = openDb(":memory:");
    const row = db.query("SELECT vec_version() AS v").get() as { v: string };
    expect(typeof row.v).toBe("string");
    expect(row.v.length).toBeGreaterThan(0);
  });

  test("vec_events exists as a virtual table", () => {
    const db = openDb(":memory:");
    const row = db
      .query("SELECT name, sql FROM sqlite_master WHERE name = 'vec_events'")
      .get() as { name: string; sql: string } | null;
    expect(row).not.toBeNull();
    expect(row!.name).toBe("vec_events");
    // The declared dim must be 1536 (the OpenAI text-embedding-3-small dim).
    expect(row!.sql).toContain("float[1536]");
  });

  test("INSERT + KNN MATCH returns nearest first (cosine-shaped ordering)", () => {
    const db = openDb(":memory:");
    // Seed three 1536-dim vectors: axis-0, axis-1, near-axis-0.
    db.run(
      "INSERT INTO vec_events(event_id, embedding, kind, ts, embedding_version) VALUES (?, ?, ?, ?, ?)",
      ["axis0", JSON.stringify(makeUnitVec(1536, 0)), "k", "2026-01-01", "v1"],
    );
    db.run(
      "INSERT INTO vec_events(event_id, embedding, kind, ts, embedding_version) VALUES (?, ?, ?, ?, ?)",
      ["axis1", JSON.stringify(makeUnitVec(1536, 1)), "k", "2026-01-02", "v1"],
    );
    const near = makeUnitVec(1536, 0);
    near[1] = 0.1;
    db.run(
      "INSERT INTO vec_events(event_id, embedding, kind, ts, embedding_version) VALUES (?, ?, ?, ?, ?)",
      ["near0", JSON.stringify(near), "k", "2026-01-03", "v1"],
    );

    const queryVec = JSON.stringify(makeUnitVec(1536, 0));
    const rows = db
      .query(
        "SELECT event_id, distance FROM vec_events WHERE embedding MATCH ? AND k = 3 ORDER BY distance",
      )
      .all(queryVec) as Array<{ event_id: string; distance: number }>;
    expect(rows.length).toBe(3);
    expect(rows[0].event_id).toBe("axis0");
    expect(rows[0].distance).toBeLessThan(0.0001);
    // near0 should beat axis1 because their L2 distance from axis-0 differs:
    // near0 has 0.1 on axis-1 vs axis1 fully orthogonal.
    expect(rows[1].event_id).toBe("near0");
    expect(rows[2].event_id).toBe("axis1");
  });

  test("metadata-column WHERE filter scopes the KNN result", () => {
    const db = openDb(":memory:");
    db.run(
      "INSERT INTO vec_events(event_id, embedding, kind, ts, embedding_version) VALUES (?, ?, ?, ?, ?)",
      ["k_kc", JSON.stringify(makeUnitVec(1536, 0)), "knowledge_candidate", "2026-01-01", "v1"],
    );
    db.run(
      "INSERT INTO vec_events(event_id, embedding, kind, ts, embedding_version) VALUES (?, ?, ?, ?, ?)",
      ["k_aa", JSON.stringify(makeUnitVec(1536, 0)), "act_artifact_admitted", "2026-01-02", "v1"],
    );
    const queryVec = JSON.stringify(makeUnitVec(1536, 0));
    const rows = db
      .query(
        "SELECT event_id FROM vec_events " +
          "WHERE embedding MATCH ? AND k = 5 AND kind = ? ORDER BY distance",
      )
      .all(queryVec, "act_artifact_admitted") as Array<{ event_id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].event_id).toBe("k_aa");
  });

  test("embedding_version WHERE filter scopes the KNN result", () => {
    const db = openDb(":memory:");
    db.run(
      "INSERT INTO vec_events(event_id, embedding, kind, ts, embedding_version) VALUES (?, ?, ?, ?, ?)",
      ["cur", JSON.stringify(makeUnitVec(1536, 0)), "k", "2026-01-01", "v1"],
    );
    db.run(
      "INSERT INTO vec_events(event_id, embedding, kind, ts, embedding_version) VALUES (?, ?, ?, ?, ?)",
      ["old", JSON.stringify(makeUnitVec(1536, 0)), "k", "2026-01-02", "v_OLD"],
    );
    const queryVec = JSON.stringify(makeUnitVec(1536, 0));
    const rows = db
      .query(
        "SELECT event_id, embedding_version FROM vec_events " +
          "WHERE embedding MATCH ? AND k = 5 AND embedding_version = ? ORDER BY distance",
      )
      .all(queryVec, "v1") as Array<{ event_id: string; embedding_version: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].event_id).toBe("cur");
    expect(rows[0].embedding_version).toBe("v1");
  });

  test("dim mismatch INSERT raises an error (contract relied on by EmbeddingIndex fallback)", () => {
    const db = openDb(":memory:");
    // The schema declares float[1536]; an 8-dim insert must throw.
    expect(() => {
      db.run(
        "INSERT INTO vec_events(event_id, embedding, kind, ts, embedding_version) VALUES (?, ?, ?, ?, ?)",
        ["short", JSON.stringify(makeUnitVec(8, 0)), "k", "2026-01-01", "v1"],
      );
    }).toThrow();
  });
});
