// F4b falsifying test for the zero-knowledge seed + universal lessons
// install. The substrate-self-knowledge lessons land as lesson_extracted
// events; the substrate ships exactly the 10 named lessons and nothing
// else under the substrate_operating_principle class.

import { describe, test, expect, beforeEach } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { seedUniversalLessons, UNIVERSAL_LESSON_NAMES } from "../substrate/seed";

beforeEach(() => closeDb());

describe("F4b universal lessons (substrate-self-knowledge only)", () => {
  test("seedUniversalLessons installs exactly 10 lessons with the expected names", () => {
    const db = openDb(":memory:");
    const summary = seedUniversalLessons(db);
    expect(summary.imported).toBe(10);

    const rows = db
      .query(
        "SELECT payload FROM events WHERE kind = 'lesson_extracted' AND json_extract(payload, '$.lesson_class') = 'substrate_operating_principle' ORDER BY ts ASC",
      )
      .all() as Array<{ payload: string }>;
    expect(rows.length).toBe(10);

    const names = rows.map((r) => {
      const p = JSON.parse(r.payload) as { name?: string };
      return p.name ?? "";
    });
    expect(new Set(names)).toEqual(new Set(UNIVERSAL_LESSON_NAMES));
  });

  test("the 10 canonical lesson names are the substrate-operating-principle set", () => {
    expect(UNIVERSAL_LESSON_NAMES).toEqual([
      "act_loop_invariant",
      "ledger_state_invariant",
      "open_verifier_residual_packet",
      "retrieval_binding_and_citation_credit_rule",
      "total_mediation_rule",
      "closure_output_versus_outcome_rule",
      "posterior_credit_rule",
      "zero_domain_seed_leakage_rule",
      "owner_profile_as_learned_vector_rule",
      "feedback_window_rule",
    ]);
  });

  test("seedUniversalLessons is idempotent — a second pass imports 0", () => {
    const db = openDb(":memory:");
    const first = seedUniversalLessons(db);
    const second = seedUniversalLessons(db);
    expect(first.imported).toBe(10);
    expect(second.imported).toBe(0);
    const total = (
      db
        .query(
          "SELECT COUNT(*) AS n FROM events WHERE kind = 'lesson_extracted' AND json_extract(payload, '$.lesson_class') = 'substrate_operating_principle'",
        )
        .get() as { n: number }
    ).n;
    expect(total).toBe(10);
  });

  test("every seeded lesson payload carries lesson_class = substrate_operating_principle", () => {
    const db = openDb(":memory:");
    seedUniversalLessons(db);
    const rows = db
      .query(
        "SELECT payload FROM events WHERE kind = 'lesson_extracted' ORDER BY ts ASC",
      )
      .all() as Array<{ payload: string }>;
    for (const r of rows) {
      const p = JSON.parse(r.payload) as { lesson_class?: string; lesson_id?: string };
      expect(p.lesson_class).toBe("substrate_operating_principle");
      expect(p.lesson_id?.startsWith("universal_")).toBe(true);
    }
  });
});
