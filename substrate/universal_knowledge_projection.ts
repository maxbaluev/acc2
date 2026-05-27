// Universalization stage U1 — ADDITIVE, read-only universal knowledge entity
// projection.
//
// Brain design (U1): "Additive universal knowledge entity projection with open
// capability_properties and scored_entity score lineage." The projection unions
// representatives of the substrate's distinct learnable entity families —
// artifact, knowledge, lesson, amendment, and trajectory — into ONE row shape,
// each carrying an OPEN set of derived capability_properties and a score from
// the USS `scored_entity` lineage (LEFT JOIN; null when unscored).
//
// STRUCTURAL INVARIANTS (Architecture.md):
//   * Read-only. This module NEVER writes/alters a table. It is a pure
//     projection over existing rows.
//   * Capability vocabulary is OPEN. capability_properties is built by
//     appending strings — no fixed enum, no exhaustive switch that throws on an
//     unknown shape. New capabilities are admitted by adding append rules, not
//     by widening a closed type.
//   * Bounded. Every per-family query carries a LIMIT; there is no unbounded
//     full-table scan.
//
// Wiring (a VIEW_DDL row, an MCP read-view case) is a DEFERRED follow-on; this
// module stands alone as an importable function.

import type { Database } from "bun:sqlite";

/** One row of the universal knowledge entity projection. */
export interface UniversalKnowledgeRow {
  /** Stable id of the projected entity (act_artifact.id or source event id). */
  entity_id: string;
  /** The legacy entity family this row was projected from. */
  source_kind: string;
  /** OPEN set of derived capability tags — NOT a fixed enum. */
  capability_properties: string[];
  /** Score from the USS scored_entity lineage; null when unscored. */
  score: number | null;
  /** Confidence from the USS scored_entity lineage; null when unscored. */
  score_confidence: number | null;
  /** ISO timestamp of the underlying row. */
  ts: string;
}

/** Default per-family bound. Never run unbounded. */
const DEFAULT_LIMIT = 500;

/** Append a capability tag if not already present (keeps the set open + deduped). */
const addCapability = (caps: string[], tag: string): void => {
  if (tag && !caps.includes(tag)) caps.push(tag);
};

type ArtifactRow = {
  entity_id: string;
  runtime: string | null;
  declared_sandbox: string | null;
  body: string | null;
  ts: string;
  score: number | null;
  score_confidence: number | null;
};

type EventEntityRow = {
  entity_id: string;
  payload: string | null;
  ts: string;
  score: number | null;
  score_confidence: number | null;
};

/**
 * Additive, read-only universal knowledge entity projection.
 *
 * Unions representatives of the artifact / knowledge / lesson / amendment /
 * trajectory entity families, tagging each with derived OPEN
 * capability_properties and LEFT-JOINing the USS `scored_entity` lineage for
 * score + confidence (null when no scored_entity row exists for the id).
 *
 * Pure read: touches only SELECTs. Bounded by `opts.limit` per family.
 */
export function universalKnowledgeProjection(
  db: Database,
  opts?: { limit?: number },
): UniversalKnowledgeRow[] {
  const limit = Math.max(1, Math.trunc(opts?.limit ?? DEFAULT_LIMIT));
  const rows: UniversalKnowledgeRow[] = [];

  // ── artifact ── act_artifact rows. Capability "artifact" always; "executable"
  //    when the row declares a runtime/sandbox payload; "replayable" when the
  //    body carries replay/recipe linkage. Open append — no closed switch.
  const artifactRows = db
    .query(
      `SELECT a.id            AS entity_id,
              a.runtime       AS runtime,
              a.declared_sandbox AS declared_sandbox,
              a.body          AS body,
              a.updated_at    AS ts,
              s.score         AS score,
              s.confidence    AS score_confidence
         FROM act_artifact a
         LEFT JOIN scored_entity s ON s.entity_id = a.id
        ORDER BY a.updated_at DESC
        LIMIT ?`,
    )
    .all(limit) as ArtifactRow[];
  for (const r of artifactRows) {
    const caps: string[] = [];
    addCapability(caps, "artifact");
    if (
      (typeof r.runtime === "string" && r.runtime.length > 0) ||
      (typeof r.declared_sandbox === "string" && r.declared_sandbox.length > 0)
    ) {
      addCapability(caps, "executable");
    }
    const body = typeof r.body === "string" ? r.body : "";
    if (/replay|recipe/i.test(body)) {
      addCapability(caps, "replayable");
    }
    rows.push({
      entity_id: r.entity_id,
      source_kind: "act_artifact",
      capability_properties: caps,
      score: typeof r.score === "number" ? r.score : null,
      score_confidence: typeof r.score_confidence === "number" ? r.score_confidence : null,
      ts: r.ts,
    });
  }

  // Event-backed families share the same shape: project the event id as the
  // entity_id and LEFT JOIN scored_entity on it. Each family contributes an
  // OPEN capability set built by appending.
  const eventFamily = (
    kinds: string[],
    sourceKind: string,
    capabilities: string[],
  ): void => {
    const placeholders = kinds.map(() => "?").join(", ");
    const eventRows = db
      .query(
        `SELECT e.id      AS entity_id,
                e.payload  AS payload,
                e.ts       AS ts,
                s.score    AS score,
                s.confidence AS score_confidence
           FROM events e
           LEFT JOIN scored_entity s ON s.entity_id = e.id
          WHERE e.kind IN (${placeholders})
          ORDER BY e.ts DESC
          LIMIT ?`,
      )
      .all(...kinds, limit) as EventEntityRow[];
    for (const r of eventRows) {
      const caps: string[] = [];
      for (const cap of capabilities) addCapability(caps, cap);
      rows.push({
        entity_id: r.entity_id,
        source_kind: sourceKind,
        capability_properties: caps,
        score: typeof r.score === "number" ? r.score : null,
        score_confidence: typeof r.score_confidence === "number" ? r.score_confidence : null,
        ts: r.ts,
      });
    }
  };

  // ── knowledge ── promoted + candidate knowledge events. Capability "knowledge".
  eventFamily(["knowledge_promoted", "knowledge_candidate"], "knowledge", ["knowledge"]);

  // ── lesson ── lesson_extracted events. Capability "correction".
  eventFamily(["lesson_extracted"], "lesson", ["correction"]);

  // ── amendment ── contract_amendment_proposed events. "correction" + "proposed".
  eventFamily(["contract_amendment_proposed"], "amendment", ["correction", "proposed"]);

  // ── trajectory ── trajectory_motif observations. Capability "trajectory".
  eventFamily(["trajectory_motif_observed"], "trajectory", ["trajectory"]);

  return rows;
}
