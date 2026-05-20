// acc2 Tier -1 floor enforcement workers (remaining 2) — unit tests.
//
// Companion to runtime/tier_minus_1_floors.test.ts which covers the
// first three (event_authenticity, storage_integrity,
// deterministic_computation). This file covers:
//
//   - kernel_sandbox_worker:  clean parity emits kernel_sandbox_check;
//                             >= 25% gap emits sandbox_degraded +
//                             quarantines at least one offending artifact
//   - owner_identity_worker:  stable token sha across ticks ⇒
//                             owner_identity_check (continuity_ok=true);
//                             rotation without admin_token_rotated event
//                             ⇒ owner_identity_discontinuity AND
//                             owner_input_required
//
// Per docs/roadmap.md Tier -1 contract.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { newId } from "./ids";
import { kernelSandboxWorkerTick } from "./kernel_sandbox_worker";
import { ownerIdentityWorkerTick } from "./owner_identity_worker";

const FIXED_NOW = new Date("2026-05-20T12:00:00.000Z");

afterAll(() => closeDb());
beforeEach(() => closeDb());

type Row = { payload: string; kind: string };

const insertRawEvent = (
  db: ReturnType<typeof openDb>,
  opts: {
    id?: string;
    ts?: string;
    kind: string;
    substrate_origin: string;
    payload?: Record<string, unknown>;
    action_artifact_id?: string;
  },
): string => {
  const id = opts.id ?? newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs,
       action_artifact_id, verifier_artifact_id, residual
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.ts ?? FIXED_NOW.toISOString(),
      "directive_test",
      "task_test",
      null,
      "loop_root",
      opts.substrate_origin,
      opts.kind,
      JSON.stringify(opts.payload ?? {}),
      "[]",
      opts.action_artifact_id ?? null,
      null,
      null,
    ],
  );
  return id;
};

const findEvent = (
  db: ReturnType<typeof openDb>,
  kind: string,
): Row | null =>
  db
    .query(`SELECT payload, kind FROM events WHERE kind = ? ORDER BY ts DESC LIMIT 1`)
    .get(kind) as Row | null;

const findEvents = (
  db: ReturnType<typeof openDb>,
  kind: string,
): Row[] =>
  db
    .query(`SELECT payload, kind FROM events WHERE kind = ? ORDER BY ts DESC`)
    .all(kind) as Row[];

const countEvents = (db: ReturnType<typeof openDb>, kind: string): number =>
  (db
    .query(`SELECT COUNT(*) AS c FROM events WHERE kind = ?`)
    .get(kind) as { c: number }).c;

// ── kernel_sandbox_worker ─────────────────────────────────────────────

describe("kernel_sandbox_worker (Tier -1, floor 4)", () => {
  test("clean parity (10 invoked + 10 enforced) emits kernel_sandbox_check with residual=0", () => {
    const db = openDb(":memory:");
    // Seed 10 distinct artifact_invoked + matching sandbox_enforced rows
    for (let i = 0; i < 10; i++) {
      const artifactId = `act_${i}`;
      insertRawEvent(db, {
        kind: "artifact_invoked",
        substrate_origin: "substrate_auto",
        action_artifact_id: artifactId,
        payload: { runtime: "uv" },
      });
      insertRawEvent(db, {
        kind: "sandbox_enforced",
        substrate_origin: "substrate_auto",
        action_artifact_id: artifactId,
        payload: { runtime: "uv", nsjail_path: "/usr/bin/nsjail" },
      });
    }

    const summary = kernelSandboxWorkerTick(db, { now: FIXED_NOW, minGapMs: 0 });
    expect(summary.emitted_kind).toBe("kernel_sandbox_check");
    expect(summary.sampled).toBe(10);
    expect(summary.enforced).toBe(10);
    expect(summary.missing).toBe(0);
    expect(summary.quarantined_artifact_ids.length).toBe(0);

    const row = findEvent(db, "kernel_sandbox_check");
    expect(row).not.toBeNull();
    const payload = JSON.parse(row!.payload);
    expect(payload.residual).toBe(0);
    expect(payload.predicate).toBe("kernel_sandbox_integrity_predicate");
    expect(payload.sampled).toBe(10);
    expect(payload.enforced).toBe(10);
    expect(payload.missing).toBe(0);

    // No sandbox_degraded should have been emitted by the worker
    expect(countEvents(db, "sandbox_degraded")).toBe(0);
  });

  test("50% gap (10 invoked + 5 enforced) emits sandbox_degraded + quarantines offenders", () => {
    const db = openDb(":memory:");
    // 10 artifacts invoked; only the first 5 have sandbox_enforced rows.
    for (let i = 0; i < 10; i++) {
      const artifactId = `act_gap_${i}`;
      insertRawEvent(db, {
        kind: "artifact_invoked",
        substrate_origin: "substrate_auto",
        action_artifact_id: artifactId,
        payload: { runtime: "uv" },
      });
      if (i < 5) {
        insertRawEvent(db, {
          kind: "sandbox_enforced",
          substrate_origin: "substrate_auto",
          action_artifact_id: artifactId,
          payload: { runtime: "uv" },
        });
      }
    }

    const summary = kernelSandboxWorkerTick(db, { now: FIXED_NOW, minGapMs: 0 });
    expect(summary.emitted_kind).toBe("sandbox_degraded");
    expect(summary.sampled).toBe(10);
    expect(summary.enforced).toBe(5);
    expect(summary.missing).toBe(5);
    expect(summary.quarantined_artifact_ids.length).toBeGreaterThanOrEqual(1);

    // sandbox_degraded payload cites the floor + predicate
    const degraded = findEvent(db, "sandbox_degraded");
    expect(degraded).not.toBeNull();
    const dpayload = JSON.parse(degraded!.payload);
    expect(dpayload.floor).toBe("kernel_sandbox_integrity");
    expect(dpayload.predicate).toBe("kernel_sandbox_integrity_predicate");
    expect(dpayload.missing).toBe(5);
    expect(dpayload.marker).toBe("kernel_sandbox_floor_violation_v1");

    // At least one act_artifact_quarantined row points to a missing-evidence artifact
    const quarantines = findEvents(db, "act_artifact_quarantined");
    expect(quarantines.length).toBeGreaterThanOrEqual(1);
    const reasons = quarantines.map((q) => JSON.parse(q.payload).reason);
    expect(reasons).toContain("kernel_sandbox_enforcement_missing");
  });

  test("idempotency — second tick within minGapMs is a no-op (skipped)", () => {
    const db = openDb(":memory:");
    insertRawEvent(db, {
      kind: "artifact_invoked",
      substrate_origin: "substrate_auto",
      action_artifact_id: "act_idem",
      payload: {},
    });
    insertRawEvent(db, {
      kind: "sandbox_enforced",
      substrate_origin: "substrate_auto",
      action_artifact_id: "act_idem",
      payload: {},
    });

    const realNow = new Date();
    const first = kernelSandboxWorkerTick(db, { now: realNow, minGapMs: 0 });
    expect(first.emitted_kind).toBe("kernel_sandbox_check");
    const second = kernelSandboxWorkerTick(db, { now: realNow });
    expect(second.emitted_kind).toBe("skipped");
    expect(countEvents(db, "kernel_sandbox_check")).toBe(1);
  });
});

// ── owner_identity_worker ─────────────────────────────────────────────

describe("owner_identity_worker (Tier -1, floor 5)", () => {
  /** Materialize a temp dir + token file; return its path. */
  const makeTokenFile = (contents: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "acc2-identity-"));
    const path = join(dir, "v2.sock.token");
    writeFileSync(path, contents);
    return path;
  };

  const makeSessionTokenFile = (contents: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "acc2-session-"));
    const path = join(dir, ".session-token");
    writeFileSync(path, contents);
    return path;
  };

  test("same token across two ticks → owner_identity_check (continuity_ok=true)", () => {
    const db = openDb(":memory:");
    const tokenPath = makeTokenFile("admin-token-stable-abc123");
    const sessionTokenPath = makeSessionTokenFile("session-token-stable-def456");

    // First tick — use real-time so the emitted row's ts (stamped by
    // emitEvent via nowIso()) is consistent with the worker's `now`.
    // Otherwise the lastEmitTsMs lookup on the second tick reads a
    // ts in the FUTURE relative to FIXED_NOW and the idempotency
    // guard short-circuits the tick.
    const t0 = new Date();
    const first = ownerIdentityWorkerTick(db, {
      now: t0,
      tokenPath,
      sessionTokenPath,
      minGapMs: 0,
    });
    expect(first.emitted_kind).toBe("owner_identity_check");
    expect(first.continuity_ok).toBe(true);
    expect(first.current_sha.length).toBeGreaterThan(0);

    // Second tick — same files, same sha, must STILL be a clean check.
    // Use a `now` strictly after t0 + 1ms so the gap check is positive.
    const second = ownerIdentityWorkerTick(db, {
      now: new Date(Date.now() + 60 * 60 * 1000),
      tokenPath,
      sessionTokenPath,
      minGapMs: 0,
    });
    expect(second.emitted_kind).toBe("owner_identity_check");
    expect(second.continuity_ok).toBe(true);
    expect(second.current_sha).toBe(first.current_sha);
    expect(second.prior_sha).toBe(first.current_sha);

    // Exactly two check rows, no discontinuity
    expect(countEvents(db, "owner_identity_check")).toBe(2);
    expect(countEvents(db, "owner_identity_discontinuity")).toBe(0);
    expect(countEvents(db, "owner_input_required")).toBe(0);

    const row = findEvent(db, "owner_identity_check");
    expect(row).not.toBeNull();
    const payload = JSON.parse(row!.payload);
    expect(payload.continuity_ok).toBe(true);
    expect(payload.residual).toBe(0);
    expect(payload.predicate).toBe("owner_identity_continuity_predicate");
  });

  test("token changes WITHOUT admin_token_rotated event → owner_identity_discontinuity + owner_input_required", () => {
    const db = openDb(":memory:");
    const tokenPath = makeTokenFile("admin-token-v1");
    const sessionTokenPath = makeSessionTokenFile("session-token-v1");

    // First tick — real-time baseline (see "same token" test above
    // for the rationale; emitEvent stamps real-time ts).
    const first = ownerIdentityWorkerTick(db, {
      now: new Date(),
      tokenPath,
      sessionTokenPath,
      minGapMs: 0,
    });
    expect(first.emitted_kind).toBe("owner_identity_check");

    // Rotate the admin token file out-of-band — no admin_token_rotated
    // event emitted, so the floor must fire on the next tick
    writeFileSync(tokenPath, "admin-token-v2-ROTATED-WITHOUT-CONSENT");

    const second = ownerIdentityWorkerTick(db, {
      now: new Date(Date.now() + 60 * 60 * 1000),
      tokenPath,
      sessionTokenPath,
      minGapMs: 0,
    });
    expect(second.emitted_kind).toBe("owner_identity_discontinuity");
    expect(second.continuity_ok).toBe(false);
    expect(second.current_sha).not.toBe(first.current_sha);
    expect(second.prior_sha).toBe(first.current_sha);

    // Both the discontinuity event AND owner_input_required must be emitted
    const discRow = findEvent(db, "owner_identity_discontinuity");
    expect(discRow).not.toBeNull();
    const dpayload = JSON.parse(discRow!.payload);
    expect(dpayload.floor).toBe("owner_identity_continuity");
    expect(dpayload.predicate).toBe("owner_identity_continuity_predicate");
    expect(dpayload.marker).toBe("owner_identity_discontinuity_v1");
    expect(dpayload.residual).toBe(1);

    const oirRow = findEvent(db, "owner_input_required");
    expect(oirRow).not.toBeNull();
    const oirPayload = JSON.parse(oirRow!.payload);
    expect(oirPayload.reason).toBe("owner_identity_discontinuity");
    expect(oirPayload.predicate).toBe("owner_identity_continuity_predicate");
    expect(typeof oirPayload.evidence_event_id).toBe("string");
  });

  test("token changes WITH admin_token_rotated event in window → clean continuity", () => {
    const db = openDb(":memory:");
    const tokenPath = makeTokenFile("admin-token-x1");
    const sessionTokenPath = makeSessionTokenFile("session-token-x1");

    // First tick — emitted at real-time (emitEvent stamps nowIso())
    const first = ownerIdentityWorkerTick(db, {
      now: new Date(),
      tokenPath,
      sessionTokenPath,
      minGapMs: 0,
    });
    expect(first.emitted_kind).toBe("owner_identity_check");

    // Owner-driven rotation: emit admin_token_rotated AFTER the first
    // tick row landed, with a ts strictly after the first check's ts
    // so the worker's lookahead finds it. Use real-time + small offset.
    const rotationTs = new Date(Date.now() + 1000).toISOString();
    insertRawEvent(db, {
      kind: "admin_token_rotated",
      substrate_origin: "claude",
      ts: rotationTs,
      payload: { reason: "scheduled_rotation" },
    });
    writeFileSync(tokenPath, "admin-token-x2-OWNER-DRIVEN");

    const second = ownerIdentityWorkerTick(db, {
      now: new Date(Date.now() + 2000),
      tokenPath,
      sessionTokenPath,
      minGapMs: 0,
    });
    expect(second.emitted_kind).toBe("owner_identity_check");
    expect(second.continuity_ok).toBe(true);
    // Sha did change, but rotation was authorized — no discontinuity row
    expect(second.current_sha).not.toBe(first.current_sha);
    expect(countEvents(db, "owner_identity_discontinuity")).toBe(0);
    expect(countEvents(db, "owner_input_required")).toBe(0);

    const row = findEvent(db, "owner_identity_check");
    const payload = JSON.parse(row!.payload);
    expect(payload.rotation_observed).toBe(true);
  });

  test("idempotency — second tick within minGapMs is a no-op (skipped)", () => {
    const db = openDb(":memory:");
    const tokenPath = makeTokenFile("admin-token-idem");
    const sessionTokenPath = makeSessionTokenFile("session-token-idem");

    const realNow = new Date();
    const first = ownerIdentityWorkerTick(db, {
      now: realNow,
      tokenPath,
      sessionTokenPath,
      minGapMs: 0,
    });
    expect(first.emitted_kind).toBe("owner_identity_check");

    const second = ownerIdentityWorkerTick(db, {
      now: realNow,
      tokenPath,
      sessionTokenPath,
    });
    expect(second.emitted_kind).toBe("skipped");
    expect(countEvents(db, "owner_identity_check")).toBe(1);
  });
});
