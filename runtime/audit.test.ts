// acc2 Phase Audit invariants — locks every coherence-sweep fix so future
// commits can't silently regress. Each test maps to a finding in
// docs/audit-report.md. Treat this file as the substrate's regression
// vault for §3 / §3.6 / §3.6.1 / §4.1 / §4.2 / §5.5 / §11.5 invariants.
//
// Tests here MUST be fast and hermetic: in-memory DB, no network, no
// subprocess spawn beyond the built-in helpers.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews, lowRiskInlinePatterns } from "../substrate/views";
import { emitEvent } from "./events";
import { newId } from "./ids";
import {
  decideDispatch,
  recordLowRiskInlineOutcome,
} from "./dispatch_decider";
import type { TaskNode } from "./task_topology";
import {
  extractSemanticDedup,
  maybePromoteKnowledge,
} from "../substrate/extractors";
import { encodeEmbeddingBlob } from "./embedder";
import {
  createExternalIngressState,
  registerExternalSource,
} from "./external_ingress";
import { EventKind } from "../substrate/types";

afterAll(() => closeDb());
beforeEach(() => closeDb());

// ── helpers ────────────────────────────────────────────────────────

const emitRawEmbedded = (
  db: ReturnType<typeof openDb>,
  args: {
    id?: string;
    kind: string;
    text: string;
    origin: "claude_root" | "opencode" | "claude_sub";
    embedding: number[];
    ts?: string;
    directiveId?: string;
  },
): string => {
  const id = args.id ?? newId();
  const blob = encodeEmbeddingBlob(args.embedding);
  const ts = args.ts ?? new Date().toISOString();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs,
       embedding, embedding_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ts,
      args.directiveId ?? id,
      args.directiveId ?? id,
      null,
      "loop_root",
      args.origin,
      args.kind,
      JSON.stringify({ text: args.text }),
      JSON.stringify([]),
      blob,
      "v1",
    ],
  );
  return id;
};

// ── A.3.6 dispatch_decider — scored inline-pattern lane ─────────────

describe("audit A.3.6: low_risk_inline_patterns_view drives the scored inline lane", () => {
  test("empty view → fail-closed, decider falls through to opencode_brain", () => {
    const db = openDb(":memory:");
    runViews(db);
    const task: TaskNode = {
      id: "t_a",
      directive_id: "d_a",
      parent_id: null,
      goal: "edit README.md",
      status: "pending",
    };
    const decision = decideDispatch(db, task);
    expect(decision.route).toBe("opencode_brain");
  });

  test("promoted low_risk_inline_pattern row surfaces in low_risk_inline_patterns_view", () => {
    const db = openDb(":memory:");
    runViews(db);
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      payload: {
        tags: ["low_risk_inline_pattern"],
        pattern_kind: "extension",
        pattern: "repo:.md",
        score: 0.92,
        confidence: 0.8,
      },
    });
    const rows = lowRiskInlinePatterns(db);
    expect(rows.length).toBe(1);
    expect(rows[0]!.pattern_kind).toBe("extension");
    expect(rows[0]!.pattern).toBe("repo:.md");
    expect(rows[0]!.score).toBeGreaterThanOrEqual(0.7);
    expect(rows[0]!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test("decider returns claude_inline when EVERY target_resource matches a promoted pattern", () => {
    const db = openDb(":memory:");
    runViews(db);
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      payload: {
        tags: ["low_risk_inline_pattern"],
        pattern_kind: "extension",
        pattern: "repo:.md",
        score: 0.95,
        confidence: 0.9,
      },
    });
    const task = {
      id: "t_inline",
      directive_id: "d_inline",
      parent_id: null,
      goal: "edit README.md and CHANGELOG.md",
      status: "pending" as const,
      target_resources: ["repo:README.md", "repo:docs/CHANGELOG.md"],
    };
    const decision = decideDispatch(db, task as TaskNode);
    expect(decision.route).toBe("claude_inline");
    if (decision.route === "claude_inline") {
      expect(decision.cited_artifact_ids.length).toBe(2);
    }
  });

  test("decider rejects inline when ANY target_resource misses the pattern (fail-closed)", () => {
    const db = openDb(":memory:");
    runViews(db);
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      payload: {
        tags: ["low_risk_inline_pattern"],
        pattern_kind: "extension",
        pattern: "repo:.md",
        score: 0.95,
        confidence: 0.9,
      },
    });
    const task = {
      id: "t_partial",
      directive_id: "d_partial",
      parent_id: null,
      goal: "edit README.md and runtime/foo.ts",
      status: "pending" as const,
      target_resources: ["repo:README.md", "repo:runtime/foo.ts"],
    };
    const decision = decideDispatch(db, task as TaskNode);
    expect(decision.route).toBe("opencode_brain");
  });

  test("recordLowRiskInlineOutcome emits a candidate_confirmed/contradicted citing the knowledge id", () => {
    const db = openDb(":memory:");
    runViews(db);
    const knowledgeId = newId();
    recordLowRiskInlineOutcome(db, knowledgeId, "success");
    const confirmed = db
      .query("SELECT context_refs FROM events WHERE kind = 'candidate_confirmed'")
      .all() as Array<{ context_refs: string }>;
    expect(confirmed.length).toBe(1);
    const refs = JSON.parse(confirmed[0]!.context_refs) as string[];
    expect(refs).toContain(knowledgeId);

    recordLowRiskInlineOutcome(db, knowledgeId, "failure");
    const contradicted = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'candidate_contradicted'")
      .get() as { c: number };
    expect(contradicted.c).toBe(1);
  });

  test("Batch 4 Hole 3 — inline-lane Beta posterior refresh: outcomes stamp updated score/confidence on the promotion row", () => {
    const db = openDb(":memory:");
    runViews(db);
    // Seed: a knowledge_candidate row (the truth-bearing source) and a
    // knowledge_promoted row tagged as a low_risk_inline_pattern but whose
    // payload starts BELOW the inline thresholds (score 0.6, confidence 0.5)
    // so the view excludes it initially.
    const candidateId = newId();
    db.run(
      `INSERT INTO events (id, ts, directive_id, task_id, parent_task_id, loop_id,
         substrate_origin, kind, payload, context_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        candidateId,
        new Date(Date.now() - 1000).toISOString(),
        candidateId,
        candidateId,
        null,
        "loop_root",
        "claude_root",
        "knowledge_candidate",
        JSON.stringify({ text: "TypeScript runtime files are low-risk inline targets" }),
        JSON.stringify([]),
      ],
    );
    const promotion = emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      context_refs: [candidateId],
      payload: {
        candidate_id: candidateId,
        tags: ["low_risk_inline_pattern"],
        pattern_kind: "extension",
        pattern: "repo:.ts",
        score: 0.6,
        confidence: 0.5,
        alpha: 1,
        beta: 1,
        wins: 0,
        losses: 0,
      },
    });

    // Pre-refresh: the view filters by score ≥ 0.7 AND confidence ≥ 0.6 → row
    // excluded → dispatcher returns opencode_brain.
    expect(lowRiskInlinePatterns(db).length).toBe(0);
    const taskBefore = {
      id: "t_before",
      directive_id: "d_before",
      parent_id: null,
      goal: "edit runtime/foo.ts",
      status: "pending" as const,
      target_resources: ["repo:runtime/foo.ts"],
    } as const;
    expect(decideDispatch(db, taskBefore as TaskNode).route).toBe("opencode_brain");

    // Drive eight successes. Beta(α=9, β=1) → mean 0.9, confidence
    // 1 − 1/√(9) ≈ 0.667. Both thresholds satisfied.
    for (let i = 0; i < 8; i++) {
      recordLowRiskInlineOutcome(db, promotion.id, "success");
    }

    // Post-refresh: the promotion row's payload should carry the new score
    // and confidence, and the view should now surface the pattern.
    const refreshed = db
      .query("SELECT payload FROM events WHERE id = ?")
      .get(promotion.id) as { payload: string };
    const payload = JSON.parse(refreshed.payload) as Record<string, number>;
    expect(payload.alpha).toBe(9);
    expect(payload.beta).toBe(1);
    expect(payload.wins).toBe(8);
    expect(payload.losses).toBe(0);
    expect(payload.score).toBeCloseTo(0.9, 3);
    expect(payload.confidence).toBeGreaterThanOrEqual(0.6);
    expect(payload.score).toBeGreaterThanOrEqual(0.7);

    const rows = lowRiskInlinePatterns(db);
    expect(rows.length).toBe(1);
    expect(rows[0]!.score).toBeCloseTo(0.9, 3);
    expect(rows[0]!.confidence).toBeGreaterThanOrEqual(0.6);

    // Dispatcher's inline lane should now flip to claude_inline for a task
    // whose every target_file matches the .ts pattern.
    const taskAfter = {
      id: "t_after",
      directive_id: "d_after",
      parent_id: null,
      goal: "edit runtime/foo.ts",
      status: "pending" as const,
      target_resources: ["repo:runtime/foo.ts"],
    } as const;
    expect(decideDispatch(db, taskAfter as TaskNode).route).toBe("claude_inline");

    // A failure outcome flips wins/losses → score drops; dispatcher must
    // immediately respond on the next read (no stale frozen value).
    for (let i = 0; i < 30; i++) {
      recordLowRiskInlineOutcome(db, promotion.id, "failure");
    }
    const dropped = db
      .query("SELECT payload FROM events WHERE id = ?")
      .get(promotion.id) as { payload: string };
    const droppedPayload = JSON.parse(dropped.payload) as Record<string, number>;
    expect(droppedPayload.losses).toBe(30);
    expect(droppedPayload.score).toBeLessThan(0.7);
    expect(decideDispatch(db, taskAfter as TaskNode).route).toBe("opencode_brain");
  });
});

// ── A.3.6.1 semantic merger — Rules 1/2/3 ──────────────────────────

describe("audit A.3.6.1: semantic merger rules 1/2/3 actually execute", () => {
  test("Rule 1 — embedding dedup attaches corroborating evidence", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const dirId = newId();
    // Two near-identical embeddings (cosine ≈ 1.0).
    const vec = Array.from({ length: 32 }, (_, i) => Math.sin(i + 0.1));
    const vec2 = vec.map((v) => v + 0.0001);
    emitRawEmbedded(db, {
      kind: "knowledge_candidate",
      text: "The brain dispatches once per cycle",
      origin: "claude_root",
      embedding: vec,
      ts: "2026-01-01T00:00:00.000Z",
      directiveId: dirId,
    });
    emitRawEmbedded(db, {
      kind: "knowledge_candidate",
      text: "The brain dispatches once per cycle",
      origin: "opencode",
      embedding: vec2,
      ts: "2026-01-01T00:00:01.000Z",
      directiveId: dirId,
    });
    const summary = await extractSemanticDedup(db);
    expect(summary.merged).toBeGreaterThanOrEqual(1);

    // Filter by reason so the F6 internal-act projection's
    // candidate_confirmed (reason='act_tuple_lifecycle_projection')
    // does not inflate the count we care about here: the merger's
    // direct dedup emission carries reason='embedding_dedup'.
    const confirmed = db
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'candidate_confirmed' AND substrate_origin = 'substrate_auto' AND json_extract(payload, '$.reason') = 'embedding_dedup'",
      )
      .get() as { c: number };
    expect(confirmed.c).toBe(1);
  });

  test("Rule 2 — opposite polarity at high cosine emits contradictory_candidates", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const dirId = newId();
    // Two near-identical embeddings but opposite-polarity claim text.
    const vec = Array.from({ length: 32 }, (_, i) => Math.cos(i + 0.5));
    const vec2 = vec.map((v) => v + 0.0005);
    emitRawEmbedded(db, {
      kind: "knowledge_candidate",
      text: "Refinement edges replace iteration",
      origin: "claude_root",
      embedding: vec,
      ts: "2026-01-01T00:00:00.000Z",
      directiveId: dirId,
    });
    emitRawEmbedded(db, {
      kind: "knowledge_candidate",
      text: "Not refinement edges replace iteration",
      origin: "opencode",
      embedding: vec2,
      ts: "2026-01-01T00:00:01.000Z",
      directiveId: dirId,
    });
    const summary = await extractSemanticDedup(db);
    expect(summary.contradicted).toBeGreaterThanOrEqual(1);
    const row = db
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'contradictory_candidates'",
      )
      .get() as { c: number };
    expect(row.c).toBeGreaterThanOrEqual(1);
  });

  test("Rule 3 — multi-origin corroboration emits knowledge_synthesized with both origins", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const dirId = newId();
    const vec = Array.from({ length: 32 }, (_, i) => Math.tan(i / 7 + 0.2));
    const vec2 = vec.map((v) => v + 0.0001);
    const vec3 = vec.map((v) => v + 0.0002);
    emitRawEmbedded(db, {
      kind: "knowledge_candidate",
      text: "Verifiers are code returning a scalar residual",
      origin: "claude_root",
      embedding: vec,
      ts: "2026-01-01T00:00:00.000Z",
      directiveId: dirId,
    });
    emitRawEmbedded(db, {
      kind: "knowledge_candidate",
      text: "Verifiers are code returning a scalar residual",
      origin: "opencode",
      embedding: vec2,
      ts: "2026-01-01T00:00:01.000Z",
      directiveId: dirId,
    });
    emitRawEmbedded(db, {
      kind: "knowledge_candidate",
      text: "Verifiers are code returning a scalar residual",
      origin: "claude_sub",
      embedding: vec3,
      ts: "2026-01-01T00:00:02.000Z",
      directiveId: dirId,
    });
    const summary = await extractSemanticDedup(db);
    expect(summary.merged).toBeGreaterThanOrEqual(2);
    const synth = db
      .query(
        "SELECT payload FROM events WHERE kind = 'knowledge_synthesized' ORDER BY ts ASC",
      )
      .all() as Array<{ payload: string }>;
    expect(synth.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(synth[0]!.payload) as { origins?: string[]; corroboration_count?: number };
    expect(parsed.origins!.length).toBeGreaterThanOrEqual(2);
  });
});

// ── A.7 knowledge promotion — single-row API ───────────────────────

describe("audit A.7: maybePromoteKnowledge mirrors maybePromote for act_artifact", () => {
  test("emits knowledge_promoted when wins ≥ 5 AND beta-mean ≥ 0.85", () => {
    const db = openDb(":memory:");
    runViews(db);
    const candidateId = newId();
    db.run(
      `INSERT INTO events (
         id, ts, directive_id, task_id, parent_task_id, loop_id,
         substrate_origin, kind, payload, context_refs
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        candidateId,
        "2026-01-01T00:00:00.000Z",
        "d_k",
        "t_k",
        null,
        "loop_root",
        "claude_root",
        "knowledge_candidate",
        JSON.stringify({ text: "law of judgment binding" }),
        JSON.stringify([]),
      ],
    );
    for (let i = 0; i < 6; i++) {
      emitEvent(db, {
        kind: "candidate_confirmed",
        substrate_origin: "substrate_auto",
        context_refs: [candidateId],
        payload: { round: i },
      });
    }
    const verdict = maybePromoteKnowledge(db, candidateId);
    expect(verdict.kind).toBe("promoted");
    const promoted = db
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_promoted'",
      )
      .get() as { c: number };
    expect(promoted.c).toBe(1);
  });

  test("is idempotent — re-running on the same candidate returns no_action", () => {
    const db = openDb(":memory:");
    runViews(db);
    const candidateId = newId();
    db.run(
      `INSERT INTO events (
         id, ts, directive_id, task_id, parent_task_id, loop_id,
         substrate_origin, kind, payload, context_refs
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        candidateId,
        "2026-01-01T00:00:00.000Z",
        "d_k",
        "t_k",
        null,
        "loop_root",
        "claude_root",
        "knowledge_candidate",
        JSON.stringify({ text: "law two" }),
        JSON.stringify([]),
      ],
    );
    for (let i = 0; i < 6; i++) {
      emitEvent(db, {
        kind: "candidate_confirmed",
        substrate_origin: "substrate_auto",
        context_refs: [candidateId],
        payload: { round: i },
      });
    }
    expect(maybePromoteKnowledge(db, candidateId).kind).toBe("promoted");
    expect(maybePromoteKnowledge(db, candidateId).kind).toBe("no_action");
  });
});

// ── A.5.2 external source registration ─────────────────────────────

describe("audit A.5.2: substrate.register_external_source mutates ingress state + emits event", () => {
  test("registers a new source name, stores per-source token, emits external_source_registered", () => {
    const db = openDb(":memory:");
    runViews(db);
    const state = createExternalIngressState({ ownerDefaultToken: "owner-default" });
    const r = registerExternalSource(db, state, {
      name: "weather.example.com",
      bearer_token: "abc12345-secret",
      schema_hint: "{lat, lon, temp_c}",
      rate_limit_per_min: 30,
      default_sensitivity: "internal",
    });
    expect(r.ok).toBe(true);
    expect(state.registeredSources.has("weather.example.com")).toBe(true);
    expect(state.tokens.perSource["weather.example.com"]).toBe("abc12345-secret");
    const ev = db
      .query("SELECT payload FROM events WHERE kind = 'external_source_registered'")
      .all() as Array<{ payload: string }>;
    expect(ev.length).toBe(1);
    const p = JSON.parse(ev[0]!.payload) as Record<string, unknown>;
    expect(p.source).toBe("weather.example.com");
  });

  test("rejects under-length bearer tokens", () => {
    const db = openDb(":memory:");
    runViews(db);
    const state = createExternalIngressState();
    const r = registerExternalSource(db, state, {
      name: "short",
      bearer_token: "abc",
    });
    expect(r.ok).toBe(false);
  });
});

// ── A.5.5 runtime supervision — design-named events fire ────────────

describe("audit A.5.5: runtime_subprocess_* events fire from the bun runtime", () => {
  test("a successful bun artifact emits runtime_subprocess_started + completed", async () => {
    const { runBunArtifact } = await import("./runtimes/bun");
    const events: any[] = [];
    const observation = await runBunArtifact({
      artifactId: "art_test",
      body: "process.stdout.write('@@RESULT@@ ' + JSON.stringify({ok:true}) + '\\n');",
      declaredSandbox: {
        runtime: "bun",
        cpu_ms: 5000,
        wall_ms: 5000,
        memory_mb: 128,
      },
      inputs: {},
      emit: (ev) => events.push(ev),
    });
    expect(observation.ok).toBe(true);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("runtime_subprocess_started");
    expect(kinds).toContain("runtime_subprocess_completed");
  });
});

// ── A.4.1 EventKind ↔ design parity check ──────────────────────────

describe("audit A.4.1: design-named event kinds exist as EventKind union members", () => {
  // Each of these is referenced in v2-design.md §4.1 / §5.5 / §3.6.1.
  const must: EventKind[] = [
    "runtime_subprocess_started",
    "runtime_subprocess_resource_warning",
    "runtime_subprocess_soft_terminated",
    "runtime_subprocess_hard_killed",
    "runtime_subprocess_orphaned",
    "runtime_subprocess_completed",
    "knowledge_synthesized",
    "external_source_registered",
    "sandbox_unenforced_warning",
  ];
  test.each(must)("EventKind union admits '%s'", (k) => {
    // Compile-time guarantee — assignment must type-check.
    const x: EventKind = k;
    expect(typeof x).toBe("string");
  });
});

// ── A.4.2 substrate.read view dispatch lights named views ──────────

describe("audit A.4.2: substrate.read routes named views (not view_not_implemented)", () => {
  test("ready_tasks_view, act_artifact_registry_view, etc. resolve", async () => {
    // Use the in-process dispatcher (handleMcpRequest) so the test does not
    // need an MCP transport.
    const { handleMcpRequest } = await import("./mcp_server");
    const db = openDb(":memory:");
    runViews(db);
    const ctx = { db, invoker: "claude_root" as const, index: null, ingressState: null };
    const post = (view: string) =>
      handleMcpRequest(
        ctx,
        new Request("http://localhost/mcp/substrate.read", {
          method: "POST",
          body: JSON.stringify({ view_name: view, args: {} }),
        }),
      );
    for (const v of [
      "act_artifact_registry_view",
      "ready_tasks_view",
      "failure_view",
      "active_objectives_view",
      "directive_conflicts_view",
      "irreversible_effects_view",
      "embedding_index_view",
      "origin_promotion_view",
      "owner_conversation_view",
      "contradictory_candidates_view",
      "low_risk_inline_patterns_view",
      "rolling_review_due_view",
      "pending_contract_amendments_view",
    ]) {
      const res = await post(v);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(true);
    }
  });

  test("unknown views still report view_not_implemented", async () => {
    const { handleMcpRequest } = await import("./mcp_server");
    const db = openDb(":memory:");
    runViews(db);
    const ctx = { db, invoker: "claude_root" as const, index: null, ingressState: null };
    const res = await handleMcpRequest(
      ctx,
      new Request("http://localhost/mcp/substrate.read", {
        method: "POST",
        body: JSON.stringify({ view_name: "judgment_packet_view" }),
      }),
    );
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("view_not_implemented");
  });
});
