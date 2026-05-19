// acc2 F1 — decorative citation refusal tests (2026-05-18).
//
// Validates the emit-side screen for act_artifact_candidate:
//   (a) all citations resolve to real events.id → no lane_routing_refused.
//   (b) some citations are unresolvable string labels → admit + emit
//       lane_routing_refused reason="decorative_citation" with the
//       unresolved labels in payload; the candidate event itself
//       still lands on the ledger so audit/replay see what was tried.
//   (c) zero citations on a substantive artifact (audience set or
//       body > 200 chars) → admit + emit lane_routing_refused
//       reason="artifact_citation_underrooted".
//
// Cites substrate audit evidence: 60% of recent
// act_artifact_candidate citations were string labels not real
// events.id; 310/323 substantive candidates cited NOTHING at all.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const refusalsFor = (db: ReturnType<typeof openDb>, eventId: string) =>
  db
    .query<{ payload: string; kind: string }, [string]>(
      `SELECT kind, payload FROM events
        WHERE kind = 'lane_routing_refused' AND context_refs LIKE ?`,
    )
    .all(`%${eventId}%`);

describe("decorative_citation_refusal — act_artifact_candidate", () => {
  test("(a) all citations resolve to real events.id → no decorative refusal", () => {
    const db = openDb(":memory:");
    // Seed a real knowledge_candidate whose id we can cite.
    const real = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      payload: { claim: "real_grounded_claim_alpha" },
    });
    const candidate = emitEvent(db, {
      kind: "act_artifact_candidate",
      substrate_origin: "opencode",
      payload: {
        kind: "research_note",
        name: "research_note_well_cited",
        body: "padding ".repeat(40), // > 200 chars to mark substantive
        audience: "cofounder_technical_reviewer",
        cited_knowledge_ids: [real.id],
      },
    });
    const decorative = refusalsFor(db, candidate.id).filter((r) => {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      return p.reason === "decorative_citation" || p.reason === "artifact_citation_underrooted";
    });
    expect(decorative.length).toBe(0);
  });

  test("(b) mixed real + label citations → decorative_citation fires with unresolved_labels", () => {
    const db = openDb(":memory:");
    const real = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      payload: { claim: "real_grounded_claim_beta" },
    });
    const candidate = emitEvent(db, {
      kind: "act_artifact_candidate",
      substrate_origin: "opencode",
      payload: {
        kind: "research_note",
        name: "research_note_mixed_cites",
        body: "padding ".repeat(40),
        audience: "cofounder_technical_reviewer",
        cited_knowledge_ids: [
          real.id,
          "decorative_proof_of_alex", // label, not a real id
          "lake_v8_predicate_audit_proof", // label, not a real id
        ],
      },
    });
    // The candidate row itself MUST still exist — surfacing is the signal.
    const candidateRow = db
      .query<{ id: string }, [string]>("SELECT id FROM events WHERE id = ?")
      .get(candidate.id);
    expect(candidateRow).not.toBeNull();
    // And one lane_routing_refused with reason=decorative_citation.
    const refusals = refusalsFor(db, candidate.id);
    const decorative = refusals.find((r) => {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      return p.reason === "decorative_citation";
    });
    expect(decorative).toBeDefined();
    const payload = JSON.parse(decorative!.payload) as Record<string, unknown>;
    const unresolved = payload.unresolved_labels as string[];
    expect(unresolved).toContain("decorative_proof_of_alex");
    expect(unresolved).toContain("lake_v8_predicate_audit_proof");
    const resolved = payload.resolved_ids as string[];
    expect(resolved).toContain(real.id);
  });

  test("(c) substantive candidate with zero citations → artifact_citation_underrooted", () => {
    const db = openDb(":memory:");
    const candidate = emitEvent(db, {
      kind: "act_artifact_candidate",
      substrate_origin: "opencode",
      payload: {
        kind: "research_note",
        name: "research_note_no_citations",
        body: "padding ".repeat(40), // > 200 chars
        audience: "cofounder_technical_reviewer",
        cited_knowledge_ids: [],
      },
    });
    const refusals = refusalsFor(db, candidate.id);
    const underrooted = refusals.find((r) => {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      return p.reason === "artifact_citation_underrooted";
    });
    expect(underrooted).toBeDefined();
    const payload = JSON.parse(underrooted!.payload) as Record<string, unknown>;
    expect(payload.audience).toBe("cofounder_technical_reviewer");
    expect(payload.refused_kind).toBe("act_artifact_candidate");
  });

  test("short body without audience → not substantive → no underrooted refusal", () => {
    // Pre-fix: the screen would refuse anything; F1 scopes to substantive
    // candidates only so internal worker stubs aren't refused.
    const db = openDb(":memory:");
    const candidate = emitEvent(db, {
      kind: "act_artifact_candidate",
      substrate_origin: "opencode",
      payload: {
        runtime: "bun",
        purpose: "internal_worker_stub",
      },
    });
    const refusals = refusalsFor(db, candidate.id);
    const decorative = refusals.find((r) => {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      return p.reason === "decorative_citation" || p.reason === "artifact_citation_underrooted";
    });
    expect(decorative).toBeUndefined();
  });

  test("placeholder kinds with audience set still trigger decorative refusal on labels", () => {
    // published_drive_doc is a structural placeholder body — the
    // underrooted path is exempt — but if its citations list contains
    // labels they MUST still trip decorative_citation.
    const db = openDb(":memory:");
    const candidate = emitEvent(db, {
      kind: "act_artifact_candidate",
      substrate_origin: "opencode",
      payload: {
        kind: "published_drive_doc",
        name: "lakeland_drive_v10",
        body: "Drive doc placeholder body — short on purpose.",
        target_resources: ["drive://document/xyz"],
        audience: "cofounder_technical_reviewer",
        cited_knowledge_ids: ["bare_label_not_an_event_id"],
      },
    });
    const refusals = refusalsFor(db, candidate.id);
    const decorative = refusals.find((r) => {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      return p.reason === "decorative_citation";
    });
    expect(decorative).toBeDefined();
  });
});
