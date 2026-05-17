// Tests for `acc admin export-knowledge` — anonymised cross-install export.
// Brain design 5JE82MP9TN1ZB3T1DPSYWK614G (distribution-readiness).

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import {
  buildAnonymisedExport,
  collectPromotedKnowledge,
  collectRecipes,
  runExportKnowledge,
} from "./admin_export_knowledge";

afterAll(() => closeDb());

const insertEvent = (db: ReturnType<typeof openDb>, fields: { id: string; kind: string; payload: unknown; context_refs?: string[]; substrate_origin?: string; ts?: string }): void => {
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.id,
      fields.ts ?? new Date().toISOString(),
      "d_test",
      "t_test",
      "loop_t",
      fields.substrate_origin ?? "substrate_auto",
      fields.kind,
      JSON.stringify(fields.payload),
      JSON.stringify(fields.context_refs ?? []),
    ],
  );
};

describe("admin export-knowledge — collectPromotedKnowledge", () => {
  test("collects law-tier promoted knowledge with claim + tags + score", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "K001", kind: "knowledge_candidate", payload: { claim: "Residual is the universal score.", text: "Residual is the universal score.", tags: ["substrate", "verifier"], proposed_tier: "law" } });
    insertEvent(db, { id: "P001", kind: "knowledge_promoted", payload: { candidate_id: "K001", score: 0.95, confidence: 0.95 }, context_refs: ["K001"] });
    const rows = collectPromotedKnowledge(db);
    expect(rows.length).toBe(1);
    expect(rows[0]?.tier).toBe("law");
    expect(rows[0]?.claim).toBe("Residual is the universal score.");
    expect(rows[0]?.tags).toEqual(["substrate", "verifier"]);
    expect(rows[0]?.score).toBe(0.95);
  });

  test("classifies policy_bundle tier with surface/section/body", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "K002", kind: "knowledge_candidate", payload: { claim: "exit_invariant", proposed_tier: "policy_bundle" } });
    insertEvent(db, { id: "P002", kind: "knowledge_promoted", payload: { type: "policy_bundle", candidate_id: "K002", score: 0.95, confidence: 0.9, surface: "brain_prompt", section_name: "exit_invariant", priority: 100, version: 1, body: "EXIT INVARIANT: ..." } });
    const rows = collectPromotedKnowledge(db);
    expect(rows.length).toBe(1);
    expect(rows[0]?.tier).toBe("policy_bundle");
    expect(rows[0]?.surface).toBe("brain_prompt");
    expect(rows[0]?.section_name).toBe("exit_invariant");
    expect(rows[0]?.body).toContain("EXIT INVARIANT");
  });
});

describe("admin export-knowledge — buildAnonymisedExport redaction invariants", () => {
  test("owner_input_received rows are NEVER in the export", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "OWN1", kind: "owner_input_received", payload: { text: "the secret owner words" }, substrate_origin: "claude_root" });
    insertEvent(db, { id: "K003", kind: "knowledge_candidate", payload: { claim: "public claim", tags: ["public"] } });
    insertEvent(db, { id: "P003", kind: "knowledge_promoted", payload: { candidate_id: "K003", score: 0.7, confidence: 0.5 } });
    const out = buildAnonymisedExport(db);
    const json = JSON.stringify(out);
    expect(json).not.toContain("the secret owner words");
    expect(json).not.toContain("OWN1");
    expect(out.counts.skipped_owner_local).toBe(1);
  });

  test("owner_decision_recorded + owner_observed_outcome_recorded redacted", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "OD1", kind: "owner_decision_recorded", payload: { decision: "decline", note: "secret note" } });
    insertEvent(db, { id: "OO1", kind: "owner_observed_outcome_recorded", payload: { observation: "the outcome was bad" } });
    const out = buildAnonymisedExport(db);
    expect(JSON.stringify(out)).not.toContain("secret note");
    expect(JSON.stringify(out)).not.toContain("the outcome was bad");
    expect(out.counts.skipped_owner_local).toBe(2);
  });

  test("directive_id / task_id / evidence_event_ids never appear in exported rows", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    // Knowledge candidate with evidence_event_ids and a directive_id-like context_ref.
    insertEvent(db, { id: "K004", kind: "knowledge_candidate", payload: { claim: "shared insight", tags: ["pattern"], evidence_event_ids: ["LEAK1", "LEAK2"], directive_id: "LEAKDIR" } });
    insertEvent(db, { id: "P004", kind: "knowledge_promoted", payload: { candidate_id: "K004", score: 0.6, confidence: 0.5 } });
    const out = buildAnonymisedExport(db);
    const json = JSON.stringify(out);
    expect(json).toContain("shared insight");
    expect(json).not.toContain("LEAK1");
    expect(json).not.toContain("LEAK2");
    expect(json).not.toContain("LEAKDIR");
  });

  test("source_install_id_hash is stable across calls (same install)", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "FIRST_EV", kind: "directive_opened", payload: { directive_text: "anything" } });
    const a = buildAnonymisedExport(db);
    const b = buildAnonymisedExport(db);
    expect(a.source_install_id_hash).toBe(b.source_install_id_hash);
    expect(a.source_install_id_hash.length).toBe(16);
  });
});

describe("admin export-knowledge — owner approval gate", () => {
  test("refuses without --yes", async () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    const outs: string[] = [];
    const errs: string[] = [];
    const code = await runExportKnowledge(["/tmp/_neverwritten.json"], {
      out: (s) => outs.push(s),
      err: (s) => errs.push(s),
      openSubstrate: () => db,
      yes: false,
    });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("missing --yes");
  });

  test("--yes writes the file with the expected schema", async () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "K005", kind: "knowledge_candidate", payload: { claim: "public claim", tags: [] } });
    insertEvent(db, { id: "P005", kind: "knowledge_promoted", payload: { candidate_id: "K005", score: 0.5, confidence: 0.5 } });
    const path = `/tmp/_export_knowledge_test_${Date.now()}.json`;
    const code = await runExportKnowledge([path, "--yes"], {
      out: () => {},
      err: () => {},
      openSubstrate: () => db,
    });
    expect(code).toBe(0);
    const written = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
    expect(written.schema_version).toBe("anonymized_knowledge_v1");
    expect(Array.isArray(written.knowledge)).toBe(true);
    expect((written.knowledge as unknown[]).length).toBe(1);
    await Bun.write(path, ""); // cleanup
  });
});

describe("admin export-knowledge — recipe collection", () => {
  test("collectRecipes returns empty when recipe table is empty", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    expect(collectRecipes(db)).toEqual([]);
  });
});
