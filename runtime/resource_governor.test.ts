import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import {
  ResourceGovernor,
  actorKey,
  actorFromContext,
  UNKNOWN_ACTOR_KEY,
  ensureGovernorLedgerTable,
  recordGovernorDecision,
  type ActorId,
} from "./resource_governor";

describe("resource governor — actor identity (substrate-native)", () => {
  test("actorKey prefers peer_id > dispatch_id > directive_id, namespaced by origin", () => {
    expect(actorKey({ origin: "opencode", peer_id: "p1", dispatch_id: "d1", directive_id: "dir1" })).toBe("opencode:peer:p1");
    expect(actorKey({ origin: "opencode", dispatch_id: "d1", directive_id: "dir1" })).toBe("opencode:dispatch:d1");
    expect(actorKey({ origin: "opencode", directive_id: "dir1" })).toBe("opencode:directive:dir1");
    expect(actorKey({ origin: "claude_root" })).toBe("claude_root:origin");
  });

  test("null / empty / origin-only-unknown actors collapse to ONE shared 'unknown' bucket", () => {
    expect(actorKey(null)).toBe(UNKNOWN_ACTOR_KEY);
    expect(actorKey(undefined)).toBe(UNKNOWN_ACTOR_KEY);
    expect(actorKey({ origin: "" })).toBe(UNKNOWN_ACTOR_KEY);
    expect(actorKey({ origin: UNKNOWN_ACTOR_KEY })).toBe(UNKNOWN_ACTOR_KEY);
  });

  test("actorFromContext is deterministic — same identity → same key", () => {
    const a = actorFromContext({ origin: "opencode", dispatch_id: "d42" });
    const b = actorFromContext({ origin: "opencode", dispatch_id: "d42" });
    expect(actorKey(a)).toBe(actorKey(b));
  });
});

describe("resource governor — GLOBAL cap (the meltdown-stopper)", () => {
  test("total in-flight across ALL actors cannot exceed the global budget", () => {
    const gov = new ResourceGovernor({ budgets: { global: { brain_slots: 3 }, perActor: { brain_slots: 99 } } });
    const leases: string[] = [];
    // Three different actors each take one brain_slot — exactly fills global cap.
    for (const origin of ["a", "b", "c"]) {
      const r = gov.requestLease({ origin, dispatch_id: origin }, { brain_slots: 1 });
      expect(r.admitted).toBe(true);
      leases.push(r.lease_id!);
    }
    expect(gov.globalUsage().brain_slots).toBe(3);
    // A fourth actor is REFUSED at the global cap — bounded, no crash.
    const refused = gov.requestLease({ origin: "d", dispatch_id: "d" }, { brain_slots: 1 });
    expect(refused.admitted).toBe(false);
    expect(refused.cap_kind).toBe("global");
    expect(refused.exhausted_resource).toBe("brain_slots");
    expect(refused.queued_reason).toBe("global_cap_exhausted");
    expect(typeof refused.retry_after_ms).toBe("number");
    // Releasing one frees the cap; the queued actor is now admitted.
    gov.releaseLease(leases[0]);
    const readmitted = gov.requestLease({ origin: "d", dispatch_id: "d" }, { brain_slots: 1 });
    expect(readmitted.admitted).toBe(true);
  });

  test("admission is bounded under a flood — never grows past the cap", () => {
    const gov = new ResourceGovernor({ budgets: { global: { sql_jobs: 10 }, perActor: { sql_jobs: 10 } } });
    let admitted = 0;
    let refused = 0;
    for (let i = 0; i < 1000; i++) {
      const r = gov.requestLease({ origin: "flood", dispatch_id: `d${i}` }, { sql_jobs: 1 });
      if (r.admitted) admitted++;
      else refused++;
    }
    expect(admitted).toBe(10); // exactly the cap, not 1000
    expect(refused).toBe(990);
    expect(gov.globalUsage().sql_jobs).toBe(10);
    expect(gov.liveLeaseCount()).toBe(10);
  });
});

describe("resource governor — PER-ACTOR quota (fairness)", () => {
  test("one actor cannot exceed its per-actor quota even with global headroom", () => {
    const gov = new ResourceGovernor({ budgets: { global: { brain_slots: 10 }, perActor: { brain_slots: 2 } } });
    const a: ActorId = { origin: "opencode", dispatch_id: "hog" };
    expect(gov.requestLease(a, { brain_slots: 1 }).admitted).toBe(true);
    expect(gov.requestLease(a, { brain_slots: 1 }).admitted).toBe(true);
    const refused = gov.requestLease(a, { brain_slots: 1 });
    expect(refused.admitted).toBe(false);
    expect(refused.cap_kind).toBe("per_actor");
    expect(refused.queued_reason).toBe("per_actor_quota_exhausted");
    // Global cap still has headroom (only 2 of 10 used).
    expect(gov.globalUsage().brain_slots).toBe(2);
  });

  test("FAIR: one actor at its quota cannot starve a different actor", () => {
    const gov = new ResourceGovernor({ budgets: { global: { brain_slots: 10 }, perActor: { brain_slots: 2 } } });
    const hog: ActorId = { origin: "opencode", dispatch_id: "hog" };
    const victim: ActorId = { origin: "opencode", dispatch_id: "victim" };
    // Hog maxes its quota.
    gov.requestLease(hog, { brain_slots: 1 });
    gov.requestLease(hog, { brain_slots: 1 });
    expect(gov.requestLease(hog, { brain_slots: 1 }).admitted).toBe(false);
    // Victim still gets its full fair share — NOT starved.
    expect(gov.requestLease(victim, { brain_slots: 1 }).admitted).toBe(true);
    expect(gov.requestLease(victim, { brain_slots: 1 }).admitted).toBe(true);
    expect(gov.actorUsage(victim).brain_slots).toBe(2);
  });

  test("anonymous 'unknown' flood is bounded to ONE fair share", () => {
    const gov = new ResourceGovernor({ budgets: { global: { sql_jobs: 100 }, perActor: { sql_jobs: 5 } } });
    let admitted = 0;
    for (let i = 0; i < 50; i++) {
      if (gov.requestLease(null, { sql_jobs: 1 }).admitted) admitted++;
    }
    expect(admitted).toBe(5); // anonymous callers share ONE bucket → one fair share
    // An identified actor is unaffected by the anonymous flood.
    expect(gov.requestLease({ origin: "opencode", dispatch_id: "real" }, { sql_jobs: 1 }).admitted).toBe(true);
  });
});

describe("resource governor — graceful admission (no crash at cap)", () => {
  test("refusal does not mutate state and does not throw", () => {
    const gov = new ResourceGovernor({ budgets: { global: { brain_slots: 1 }, perActor: { brain_slots: 1 } } });
    gov.requestLease({ origin: "a", dispatch_id: "a" }, { brain_slots: 1 });
    const before = gov.globalUsage().brain_slots;
    // Many refusals in a row — pure queue/refuse, never crash.
    for (let i = 0; i < 100; i++) {
      const r = gov.requestLease({ origin: "b", dispatch_id: "b" }, { brain_slots: 1 });
      expect(r.admitted).toBe(false);
    }
    expect(gov.globalUsage().brain_slots).toBe(before); // unchanged
  });

  test("release is idempotent and never underflows", () => {
    const gov = new ResourceGovernor();
    const r = gov.requestLease({ origin: "a", dispatch_id: "a" }, { brain_slots: 1 });
    gov.releaseLease(r.lease_id);
    gov.releaseLease(r.lease_id); // double-release
    gov.releaseLease("nonexistent");
    gov.releaseLease(null);
    expect(gov.globalUsage().brain_slots ?? 0).toBe(0);
  });

  test("unknown / unbudgeted dimensions are admitted unbounded by design", () => {
    const gov = new ResourceGovernor({ budgets: { global: { brain_slots: 1 }, perActor: { brain_slots: 1 } } });
    // A dimension with no budget never refuses.
    for (let i = 0; i < 100; i++) {
      expect(gov.requestLease({ origin: "x", dispatch_id: `d${i}` }, { event_streams: 1 }).admitted).toBe(true);
    }
  });
});

describe("resource governor — additive accounting ledger", () => {
  let tmpDir = "";
  let dbPath = "";
  afterEach(() => {
    if (dbPath) closeDb(dbPath);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
    dbPath = "";
  });

  test("ensureGovernorLedgerTable + recordGovernorDecision are additive and queryable", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gov-ledger-"));
    dbPath = join(tmpDir, "state.db");
    const db = openDb(dbPath);
    ensureGovernorLedgerTable(db);
    recordGovernorDecision(db, {
      actor_key: "opencode:dispatch:d1",
      cost: { brain_slots: 1 },
      admitted: true,
      lease_id: "gov-lease-1",
    });
    recordGovernorDecision(db, {
      actor_key: "opencode:dispatch:d2",
      cost: { brain_slots: 1 },
      admitted: false,
      cap_kind: "global",
    });
    const rows = db.query("SELECT actor_key, resource, admitted, cap_kind FROM governor_lease_ledger ORDER BY actor_key").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    expect(rows[0].actor_key).toBe("opencode:dispatch:d1");
    expect(rows[0].admitted).toBe(1);
    expect(rows[1].cap_kind).toBe("global");
  });
});
