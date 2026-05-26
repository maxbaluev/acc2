import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../../substrate/db";
import { runViews } from "../../substrate/views";
import { handleMcpRequest } from "./index";
import {
  PEER_ID_HEADER,
  PEER_KIND_HEADER,
  type McpContext,
} from "./types";
import { UNKNOWN_PEER_ID } from "../peer_registry";

// FVW2E0YH — peer identity as an INGRESS INVARIANT. Every MCP request resolves
// a peer envelope (peer_id + kind) BEFORE it touches the ledger, registers /
// updates the peer in the live registry, and attributes the request's ledger
// writes to that peer's origin — NOT the static hardcoded `claude_root`.
// Absent identity resolves to the well-defined `unknown` peer.

const baseCtx = (db: ReturnType<typeof openDb>): McpContext =>
  ({ db, invoker: "claude_root", peer: null } as McpContext);

const emitReq = (peerId: string | null, kind: string | null): Request => {
  const headers = new Headers();
  if (peerId) headers.set(PEER_ID_HEADER, peerId);
  if (kind) headers.set(PEER_KIND_HEADER, kind);
  return new Request("http://localhost/mcp/substrate.emit", {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "owner_input_received",
      payload: { note: "ingress-peer-probe" },
    }),
  });
};

describe("MCP ingress peer identity (FVW2E0YH)", () => {
  let tmpDir = "";
  let dbPath = "";

  afterEach(() => {
    if (dbPath) closeDb(dbPath);
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ } }
    tmpDir = "";
    dbPath = "";
  });

  const open = (label: string): ReturnType<typeof openDb> => {
    tmpDir = mkdtempSync(join(tmpdir(), `acc2-ingress-${label}-`));
    dbPath = join(tmpDir, "ingress.db");
    const db = openDb(dbPath);
    runViews(db);
    return db;
  };

  test("a self-identified terminal peer is resolved + registered at ingress and attributes its ledger write", async () => {
    const db = open("self");
    const res = await handleMcpRequest(baseCtx(db), emitReq("peer-terminal-77", "claude_terminal"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { id: string } };
    expect(body.ok).toBe(true);

    // The peer was registered/updated in the live registry at ingress.
    const peerRows = db
      .query("SELECT peer_id, kind FROM peer_registry_view WHERE peer_id = ?")
      .all("peer-terminal-77") as Array<{ peer_id: string; kind: string }>;
    expect(peerRows.length).toBe(1);
    expect(peerRows[0]!.kind).toBe("claude_terminal");

    // The emitted event is attributed to the resolved peer's origin — NOT the
    // hardcoded claude_root default sitting on the shared context. For a
    // claude_terminal peer the origin maps to claude_root, but the proof that
    // ingress (not the static default) drove it is the registered peer row +
    // the matching substrate_origin written through the request-scoped ctx.
    const ev = db
      .query("SELECT substrate_origin FROM events WHERE id = ?")
      .get(body.result.id) as { substrate_origin: string };
    expect(ev.substrate_origin).toBe("claude_root");
  });

  test("a request WITHOUT a peer header resolves to the well-defined unknown peer — never silently claude_root", async () => {
    const db = open("unknown");
    const res = await handleMcpRequest(baseCtx(db), emitReq(null, null));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { id: string } };
    expect(body.ok).toBe(true);

    // The unknown peer was registered at ingress.
    const peerRows = db
      .query("SELECT peer_id, kind FROM peer_registry_view WHERE peer_id = ?")
      .all(UNKNOWN_PEER_ID) as Array<{ peer_id: string; kind: string }>;
    expect(peerRows.length).toBe(1);
    expect(peerRows[0]!.kind).toBe("unknown");

    // The anonymous request's ledger write is attributed to the unknown peer's
    // origin (peer-unknown), proving ingress resolution overrode the static
    // claude_root default rather than impersonating the orchestrator root.
    const ev = db
      .query("SELECT substrate_origin FROM events WHERE id = ?")
      .get(body.result.id) as { substrate_origin: string };
    expect(ev.substrate_origin).toBe(UNKNOWN_PEER_ID);
    expect(ev.substrate_origin).not.toBe("claude_root");
  });

  test("two distinct terminals on the same checkout get distinct ingress peer identities", async () => {
    const db = open("multi");
    await handleMcpRequest(baseCtx(db), emitReq("peer-term-A", "claude_terminal"));
    await handleMcpRequest(baseCtx(db), emitReq("peer-term-B", "claude_terminal"));
    const rows = db
      .query("SELECT DISTINCT peer_id FROM peer_registry_view WHERE peer_id IN (?, ?)")
      .all("peer-term-A", "peer-term-B") as Array<{ peer_id: string }>;
    expect(new Set(rows.map((r) => r.peer_id))).toEqual(new Set(["peer-term-A", "peer-term-B"]));
  });
});
