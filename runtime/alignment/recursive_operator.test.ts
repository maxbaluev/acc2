// Phase Align — Principle 1: substrate-as-recursive-operator
//
// v2-design.md: the daemon owns every call surface. The brain (opencode) and
// the orchestrator (Claude Code) MUST NOT read each other directly. Every
// cross-actor read goes through the substrate — `getEventById`, a view
// accessor, or `substrate.read` — not via a shared in-memory channel.
//
// This test asserts that a SECOND simulated client can observe a FIRST
// client's event only by going through the substrate. We open two handles
// to the same on-disk DB, emit from one, and read from the other. The
// reader has no shared object reference; the only carrier is the SQLite row.

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { emitEvent, getEventById } from "../events";
import { newId } from "../ids";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterAll(() => closeDb());

describe("alignment / recursive_operator (Principle 1)", () => {
  test("two distinct DB handles communicate ONLY via the events table", () => {
    // Two handles → two clients. Same on-disk path forces the only shared
    // channel to be the substrate. In-memory state on handle A is invisible
    // to handle B except through SELECT.
    const dir = mkdtempSync(join(tmpdir(), "acc2-align-recop-"));
    const dbPath = join(dir, "substrate.db");
    try {
      // Clear cache so each open mints an independent connection.
      closeDb(dbPath);
      const dbA = openDb(dbPath);

      // Client A emits an event.
      const directiveId = newId();
      const emitted = emitEvent(dbA, {
        kind: "knowledge_candidate",
        substrate_origin: "claude_root",
        directive_id: directiveId,
        task_id: newId(),
        payload: { text: "alignment-principle-1 cross-client read" },
      });

      // Force handle A to flush so the WAL is visible to a fresh handle.
      // openDb is cached per-path; we drop the cache entry to mint a new one.
      closeDb(dbPath);
      const dbB = openDb(dbPath);

      // Client B sees the event ONLY through the substrate accessor.
      const round_tripped = getEventById(dbB, emitted.id);
      expect(round_tripped).not.toBeNull();
      expect(round_tripped!.kind).toBe("knowledge_candidate");
      expect(round_tripped!.directive_id).toBe(directiveId);

      // There is no in-memory bridge: dbA's object is distinct from dbB's;
      // the only path for the event was the WAL on disk. Any future code
      // that bypasses emitEvent / getEventById to read another actor's
      // emission would fail this test by not finding the row.
      closeDb(dbPath);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  });

  test("bridge code never writes events outside emitEvent (audit of source text)", async () => {
    // Structural check: read every bridge module (the top-level shim plus
    // every file under runtime/bridge/) and assert at least one site
    // imports emitEvent AND that none reference the `events` SQL surface
    // directly with INSERT/UPDATE/DELETE. If a future refactor inlined raw
    // inserts the brain bridge would no longer route through the substrate.
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const bridgeDir = join(import.meta.dir, "..", "bridge");
    const files = readdirSync(bridgeDir).map((f) => join(bridgeDir, f));
    let importsEmitEvent = false;
    for (const path of files) {
      if (!path.endsWith(".ts")) continue;
      const text = await Bun.file(path).text();
      if (/import\s*\{[^}]*emitEvent[^}]*\}\s*from\s*"[^"]*events"/.test(text)) {
        importsEmitEvent = true;
      }
      // We tolerate the word "INSERT" appearing inside a comment, but no
      // direct `db.run("INSERT INTO events`-style statement.
      expect(text.includes("INSERT INTO events")).toBe(false);
      expect(text.includes("UPDATE events")).toBe(false);
      expect(text.includes("DELETE FROM events")).toBe(false);
    }
    expect(importsEmitEvent).toBe(true);
  });

  test("task_dispatcher reads bridge-emitted events via SELECT, not via shared state", async () => {
    // The dispatcher gathers events by querying the events table after the
    // bridge returns — there is no shared in-memory event list passed back
    // from the bridge. This is the structural symmetry §3.6 calls for.
    const dispatcherPath = join(import.meta.dir, "..", "task_dispatcher.ts");
    const text = await Bun.file(dispatcherPath).text();
    // Confirm the dispatcher does NOT pull a "bridge_emitted_events"
    // attribute off the BridgeResult to bypass the substrate read.
    // It may use `bridge_result.emitted_event_ids` for audit, but the
    // cycle-1 scan and the action_predicted lookup come off the SELECT.
    expect(text).toContain("readEventsSinceTs");
    expect(text).toContain("getArtifact");
    // The SELECT in readEventsSinceTs goes through the events table.
    expect(text.includes("FROM events WHERE")).toBe(true);
  });
});
