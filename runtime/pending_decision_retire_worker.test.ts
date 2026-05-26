// Tests for the pending_decision_retire_worker. Semantic apply leaves the
// pending-owner-decision surface as genuine consent only; the worker retires
// stale unresolved consent rows without classifying amendment structure.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { pendingOwnerDecisionQueueLive, runViews } from "../substrate/views";
import { newId } from "./ids";
import { classifyRetire, isStaleMissingEnvProbe, runPendingDecisionRetireWorker, RUNTIME_INJECTED_ENV, STALE_MISSING_ENV_PROBE_AGE_MS, STALE_PENDING_DECISION_AGE_MS } from "./pending_decision_retire_worker";

const FIXED_NOW = new Date("2026-05-19T12:00:00.000Z");
afterAll(() => closeDb());
beforeEach(() => closeDb());

type AmendmentOptions = { id?: string; ts: string; target: string; ownerGateRequired?: boolean };
const insertAmendment = (db: ReturnType<typeof openDb>, opts: AmendmentOptions): string => {
  const id = opts.id ?? newId();
  const payload = { lesson_kind: "doc_update", target_resource: opts.target, owner_consent_required: opts.ownerGateRequired ?? true, proposed_behavior: "apply semantic update" };
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, parent_task_id, loop_id, substrate_origin, kind, payload, context_refs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, opts.ts, "directive_test", "task_test", null, "loop_root", "opencode", "contract_amendment_proposed", JSON.stringify(payload), JSON.stringify([])],
  );
  return id;
};
const recentTs = (offsetMs = 0): string => new Date(FIXED_NOW.getTime() + offsetMs).toISOString();
const oldTs = (ageMs: number): string => new Date(FIXED_NOW.getTime() - ageMs).toISOString();

type EnvProbeOptions = { id?: string; ts: string; missingEnvVars: string[]; reason?: string };
const insertEnvProbe = (db: ReturnType<typeof openDb>, opts: EnvProbeOptions): string => {
  const id = opts.id ?? newId();
  const payload = {
    reason: opts.reason ?? "missing_env_credentials",
    missing_env_vars: opts.missingEnvVars,
    artifact_id: "art_test",
    instruction: `add ${opts.missingEnvVars.join(", ")} to .env`,
  };
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, parent_task_id, loop_id, substrate_origin, kind, payload, context_refs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, opts.ts, "directive_test", "task_test", null, "loop_root", "substrate_auto", "owner_input_required", JSON.stringify(payload), JSON.stringify([])],
  );
  return id;
};
const envProbeRetired = (db: ReturnType<typeof openDb>, sourceId: string): { payload: string } | null =>
  db.query("SELECT payload FROM events WHERE kind = 'pending_decision_retired' AND json_extract(payload, '$.amendment_event_id') = ?").get(sourceId) as { payload: string } | null;


describe("classifyRetire", () => {
  const nowMs = FIXED_NOW.getTime();
  test("non-consent amendment rows are outside the consent surface", () => {
    expect(classifyRetire({ source_event_id: "e2", ts: recentTs(), target: "docs/a.md", owner_gate_required: 0 }, nowMs, STALE_PENDING_DECISION_AGE_MS)).toBeNull();
  });
  test("old genuine owner-consent rows retire as stale", () => {
    expect(classifyRetire({ source_event_id: "e3", ts: oldTs(STALE_PENDING_DECISION_AGE_MS + 1000), target: "docs/a.md", owner_gate_required: 1 }, nowMs, STALE_PENDING_DECISION_AGE_MS)).toBe("stale");
  });
  test("recent genuine owner-consent rows stay live", () => {
    expect(classifyRetire({ source_event_id: "e4", ts: recentTs(), target: "docs/a.md", owner_gate_required: 1 }, nowMs, STALE_PENDING_DECISION_AGE_MS)).toBeNull();
  });
});

describe("runPendingDecisionRetireWorker", () => {
  test("stale genuine owner-consent row is retired", () => {
    const db = openDb(":memory:"); runViews(db);
    const id = insertAmendment(db, { ts: oldTs(STALE_PENDING_DECISION_AGE_MS + 60_000), target: "docs/operator-install.md" });
    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.retired).toBe(1);
    expect(summary.by_reason.stale).toBe(1);
    const ret = db.query("SELECT payload FROM events WHERE kind = 'pending_decision_retired' AND json_extract(payload, '$.amendment_event_id') = ?").get(id) as { payload: string } | null;
    expect(JSON.parse(ret!.payload).reason).toBe("stale");
  });
  test("normal recent owner-consent row is not retired", () => {
    const db = openDb(":memory:"); runViews(db);
    const id = insertAmendment(db, { ts: recentTs(), target: "docs/operator-install.md" });
    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.retired).toBe(0);
    expect(pendingOwnerDecisionQueueLive(db).find((r) => r.representative_event_id === id)).toBeDefined();
  });
  test("mixed batch scans only owner-consent rows and retires stale ones", () => {
    const db = openDb(":memory:"); runViews(db);
    insertAmendment(db, { ts: recentTs(-1000), target: "tests/a.test.ts" });
    insertAmendment(db, { ts: recentTs(-2000), target: "src/internal_helper.ts", ownerGateRequired: false });
    insertAmendment(db, { ts: oldTs(STALE_PENDING_DECISION_AGE_MS + 5000), target: "docs/c.md" });
    insertAmendment(db, { ts: recentTs(-3000), target: "docs/d.md" });
    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.scanned).toBe(3);
    expect(summary.retired).toBe(1);
    expect(summary.by_reason.stale).toBe(1);
  });
});

describe("isStaleMissingEnvProbe", () => {
  const nowMs = FIXED_NOW.getTime();
  test("runtime-injected-only vars older than 1h are stale probes", () => {
    expect(RUNTIME_INJECTED_ENV.has("ACC2_INPUTS")).toBe(true);
    expect(isStaleMissingEnvProbe({ source_event_id: "e1", ts: oldTs(STALE_MISSING_ENV_PROBE_AGE_MS + 1000), missing_env_vars: JSON.stringify(["ACC2_INPUTS"]) }, nowMs, STALE_MISSING_ENV_PROBE_AGE_MS)).toBe(true);
  });
  test("younger than 1h is NOT a stale probe", () => {
    expect(isStaleMissingEnvProbe({ source_event_id: "e2", ts: oldTs(STALE_MISSING_ENV_PROBE_AGE_MS - 60_000), missing_env_vars: JSON.stringify(["ACC2_INPUTS"]) }, nowMs, STALE_MISSING_ENV_PROBE_AGE_MS)).toBe(false);
  });
  test("a genuine non-injected missing var is never auto-retired even when old", () => {
    expect(isStaleMissingEnvProbe({ source_event_id: "e3", ts: oldTs(STALE_MISSING_ENV_PROBE_AGE_MS + 5000), missing_env_vars: JSON.stringify(["OPENAI_API_KEY"]) }, nowMs, STALE_MISSING_ENV_PROBE_AGE_MS)).toBe(false);
  });
  test("mixed injected + genuine var is not auto-retired", () => {
    expect(isStaleMissingEnvProbe({ source_event_id: "e4", ts: oldTs(STALE_MISSING_ENV_PROBE_AGE_MS + 5000), missing_env_vars: JSON.stringify(["ACC2_INPUTS", "STRIPE_KEY"]) }, nowMs, STALE_MISSING_ENV_PROBE_AGE_MS)).toBe(false);
  });
});

describe("runPendingDecisionRetireWorker missing-env probe path", () => {
  test("missing_env_credentials(ACC2_INPUTS) older than 1h is retired", () => {
    const db = openDb(":memory:"); runViews(db);
    const id = insertEnvProbe(db, { ts: oldTs(STALE_MISSING_ENV_PROBE_AGE_MS + 60_000), missingEnvVars: ["ACC2_INPUTS"] });
    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.by_reason.stale_missing_env_probe).toBe(1);
    expect(summary.retired).toBe(1);
    const ret = envProbeRetired(db, id);
    expect(ret).not.toBeNull();
    expect(JSON.parse(ret!.payload).reason).toBe("stale_missing_env_probe");
  });
  test("missing_env_credentials(ACC2_INPUTS) younger than 1h is NOT retired", () => {
    const db = openDb(":memory:"); runViews(db);
    const id = insertEnvProbe(db, { ts: oldTs(STALE_MISSING_ENV_PROBE_AGE_MS - 60_000), missingEnvVars: ["ACC2_INPUTS"] });
    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.by_reason.stale_missing_env_probe).toBe(0);
    expect(envProbeRetired(db, id)).toBeNull();
  });
  test("a non-env owner-consent decision still follows the 7-day path, not the 1h probe path", () => {
    const db = openDb(":memory:"); runViews(db);
    // Owner-consent amendment: only the 7-day path applies. Older than 1h but
    // younger than 7d → must NOT be retired by either path.
    const consentId = insertAmendment(db, { ts: oldTs(STALE_MISSING_ENV_PROBE_AGE_MS + 60_000), target: "docs/operator-install.md" });
    // Old env probe → 1h probe path retires it.
    const probeId = insertEnvProbe(db, { ts: oldTs(STALE_MISSING_ENV_PROBE_AGE_MS + 60_000), missingEnvVars: ["ACC2_INPUTS"] });
    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.by_reason.stale).toBe(0);
    expect(summary.by_reason.stale_missing_env_probe).toBe(1);
    expect(envProbeRetired(db, consentId)).toBeNull();
    expect(envProbeRetired(db, probeId)).not.toBeNull();
    // And the consent row DOES retire once aged past 7 days.
    const db2 = openDb(":memory:"); runViews(db2);
    const consentId2 = insertAmendment(db2, { ts: oldTs(STALE_PENDING_DECISION_AGE_MS + 60_000), target: "docs/operator-install.md" });
    const summary2 = runPendingDecisionRetireWorker(db2, { now: FIXED_NOW });
    expect(summary2.by_reason.stale).toBe(1);
    expect(envProbeRetired(db2, consentId2)).not.toBeNull();
  });
  test("an already-retired env probe is not re-retired (idempotent)", () => {
    const db = openDb(":memory:"); runViews(db);
    const id = insertEnvProbe(db, { ts: oldTs(STALE_MISSING_ENV_PROBE_AGE_MS + 60_000), missingEnvVars: ["ACC2_INPUTS"] });
    const first = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(first.by_reason.stale_missing_env_probe).toBe(1);
    const second = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(second.by_reason.stale_missing_env_probe).toBe(0);
    expect(second.env_probe_scanned).toBe(0);
    const count = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'pending_decision_retired' AND json_extract(payload, '$.amendment_event_id') = ?").get(id) as { c: number };
    expect(count.c).toBe(1);
  });
});
