// acc2 Tier -1 floor — owner identity continuity worker.
//
// Per docs/roadmap.md Tier -1: spoofed or discontinuous owner
// authority can optimize the wrong goal. Contract: owner input
// remains bound to the same authority channel before irreversible or
// high-control actions. This worker tracks the SHA of the canonical
// actor identity files across ticks. Mid-flight rotation WITHOUT a
// preceding `admin_token_rotated` event indicates the authority
// channel changed under us — emit `owner_identity_discontinuity`
// + `owner_input_required` so autonomous commit pauses.
//
// Sources of identity (any present file contributes to the combined
// SHA — the floor watches the union so rotating EITHER without an
// explicit event triggers the discontinuity signal):
//   1. `<state_dir>/v2.sock.token`            — substrate admin token
//   2. `<repo_root>/.ralph/.session-token`    — minted session token
//      (canonical claimer identity per orchestrator-runtime.md)
//
// Emit cadence: 5 minutes. Idempotent (at most one emit per interval).
// Predicate row: owner_identity_continuity_predicate (substrate/seed.ts).
//
// On clean continuity (current sha == prior sha, OR prior sha unset on
// first tick): emit `owner_identity_check` with continuity_ok=true,
// residual=0.
// On discontinuity (current sha != prior sha AND no preceding
// admin_token_rotated since prior tick): emit
// `owner_identity_discontinuity` + `owner_input_required`.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emitEvent } from "./events";
import { logger } from "./logger";
import { resolveStateDir, resolveTokenFile } from "./state_paths";

export const OWNER_IDENTITY_TICK_MS = 5 * 60 * 1000;
const MIN_GAP_MS = 5 * 60 * 1000;

export type OwnerIdentityOptions = {
  now?: Date;
  minGapMs?: number;
  /** Override identity sources (used by tests). When omitted, the
   *  worker reads from the canonical paths. */
  tokenPath?: string;
  sessionTokenPath?: string;
};

export type OwnerIdentitySummary = {
  current_sha: string;
  prior_sha: string | null;
  continuity_ok: boolean;
  emitted_kind:
    | "owner_identity_check"
    | "owner_identity_discontinuity"
    | "skipped";
  emitted_event_id?: string;
  emitted_owner_input_required_id?: string;
};

const lastEmitTsMs = (db: Database, kind: string): number => {
  const row = db
    .query<{ ts: string }, [string]>(
      `SELECT ts FROM events WHERE kind = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(kind);
  if (!row?.ts) return 0;
  const t = Date.parse(row.ts);
  return Number.isFinite(t) ? t : 0;
};

type IdentityEventRow = { id: string; ts: string; payload: string };

const lastIdentityEvent = (db: Database): IdentityEventRow | null => {
  try {
    const row = db
      .query<IdentityEventRow, []>(
        `SELECT id, ts, payload FROM events
          WHERE kind IN ('owner_identity_check','owner_identity_discontinuity')
          ORDER BY ts DESC LIMIT 1`,
      )
      .get();
    return row ?? null;
  } catch {
    return null;
  }
};

const lastAdminTokenRotatedTs = (db: Database, sinceIso: string | null): string | null => {
  try {
    if (sinceIso) {
      const row = db
        .query<{ ts: string }, [string]>(
          `SELECT ts FROM events
            WHERE kind = 'admin_token_rotated' AND ts > ?
            ORDER BY ts DESC LIMIT 1`,
        )
        .get(sinceIso);
      return row?.ts ?? null;
    }
    const row = db
      .query<{ ts: string }, []>(
        `SELECT ts FROM events WHERE kind = 'admin_token_rotated' ORDER BY ts DESC LIMIT 1`,
      )
      .get();
    return row?.ts ?? null;
  } catch {
    return null;
  }
};

/** Compute the SHA-256 hex digest over the concatenated contents of
 *  every present identity file. Missing files contribute empty
 *  bytes — the contributing path list is returned alongside so the
 *  emit payload can record exactly which files were folded in. */
export const computeOwnerIdentitySha = (paths: Array<{ label: string; path: string }>): {
  sha: string;
  contributing: Array<{ label: string; path: string; present: boolean; bytes: number }>;
} => {
  const hash = createHash("sha256");
  const contributing: Array<{ label: string; path: string; present: boolean; bytes: number }> = [];
  for (const { label, path } of paths) {
    let present = false;
    let bytes = 0;
    try {
      if (existsSync(path)) {
        const buf = readFileSync(path);
        hash.update(label);
        hash.update("\0");
        hash.update(buf);
        hash.update("\0");
        present = true;
        bytes = buf.length;
      }
    } catch {
      // File unreadable — treat as absent for sha purposes; the
      // emit payload still records the label so operators can see
      // which source was attempted.
    }
    contributing.push({ label, path, present, bytes });
  }
  return { sha: hash.digest("hex"), contributing };
};

const resolveRepoSessionTokenPath = (): string => {
  // The minted session token lives under `<repo_root>/.ralph/.session-token`
  // per orchestrator-runtime.md. We resolve repo root the same way
  // every other runtime helper does: walk up from cwd until we find
  // a `.ralph` directory, falling back to cwd. The fallback is
  // harmless — the file simply won't exist and contributes nothing
  // to the combined sha.
  let cur = process.cwd();
  for (let depth = 0; depth < 16; depth++) {
    if (existsSync(join(cur, ".ralph"))) {
      return join(cur, ".ralph", ".session-token");
    }
    const parent = join(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return join(process.cwd(), ".ralph", ".session-token");
};

/** One worker tick. Computes the current SHA over the canonical
 *  identity files, compares against the prior tick's sha (recovered
 *  from the most recent `owner_identity_check` or
 *  `owner_identity_discontinuity` event payload), and emits either
 *  the clean check or the discontinuity pair. Idempotent within
 *  `minGapMs`. */
export const ownerIdentityWorkerTick = (
  db: Database,
  opts: OwnerIdentityOptions = {},
): OwnerIdentitySummary => {
  const now = opts.now ?? new Date();
  const minGapMs = Math.max(0, opts.minGapMs ?? MIN_GAP_MS);

  const tokenPath = opts.tokenPath ?? resolveTokenFile();
  const sessionTokenPath = opts.sessionTokenPath ?? resolveRepoSessionTokenPath();

  // Idempotency — compare against the worker's own primary emit kinds
  // taken together (the union, since either may be the most recent).
  const lastCheck = lastEmitTsMs(db, "owner_identity_check");
  const lastDiscontinuity = lastEmitTsMs(db, "owner_identity_discontinuity");
  const lastEmit = Math.max(lastCheck, lastDiscontinuity);
  if (lastEmit > 0 && now.getTime() - lastEmit < minGapMs) {
    return {
      current_sha: "",
      prior_sha: null,
      continuity_ok: true,
      emitted_kind: "skipped",
    };
  }

  const { sha: currentSha, contributing } = computeOwnerIdentitySha([
    { label: "admin_token", path: tokenPath },
    { label: "session_token", path: sessionTokenPath },
  ]);

  // Pull the prior sha + ts from the most recent identity event. On
  // first tick (no prior row), continuity_ok defaults to true — the
  // floor only fires when it observes a CHANGE without a recorded
  // rotation event.
  const priorRow = lastIdentityEvent(db);
  let priorSha: string | null = null;
  let priorTs: string | null = null;
  if (priorRow) {
    try {
      const p = JSON.parse(priorRow.payload) as { token_sha?: string; current_sha?: string };
      priorSha = p.current_sha ?? p.token_sha ?? null;
      priorTs = priorRow.ts;
    } catch {
      priorSha = null;
    }
  }

  const continuityOk = priorSha === null || priorSha === currentSha;

  // If sha changed between ticks, look for an admin_token_rotated event
  // between the prior tick's ts and now. Presence => the rotation was
  // explicit/owner-driven; absence => unauthorized identity drift.
  let rotationExplicit = false;
  if (!continuityOk) {
    const rotation = lastAdminTokenRotatedTs(db, priorTs);
    rotationExplicit = rotation !== null;
  }

  const cleanContinuity = continuityOk || rotationExplicit;

  try {
    if (cleanContinuity) {
      const emitted = emitEvent(db, {
        kind: "owner_identity_check",
        substrate_origin: "substrate_auto",
        payload: {
          token_sha: currentSha,
          current_sha: currentSha,
          prior_sha: priorSha,
          continuity_ok: true,
          rotation_observed: rotationExplicit,
          residual: 0,
          contributing,
          predicate: "owner_identity_continuity_predicate",
        } as JsonValue,
      });
      return {
        current_sha: currentSha,
        prior_sha: priorSha,
        continuity_ok: true,
        emitted_kind: "owner_identity_check",
        emitted_event_id: emitted.id,
      };
    }

    // Discontinuity — emit BOTH the discontinuity flag and the
    // owner_input_required prompt so the brain/orchestrator block
    // autonomous commit until the operator confirms.
    const discontinuityEmitted = emitEvent(db, {
      kind: "owner_identity_discontinuity",
      substrate_origin: "substrate_auto",
      payload: {
        floor: "owner_identity_continuity",
        predicate: "owner_identity_continuity_predicate",
        token_sha: currentSha,
        current_sha: currentSha,
        prior_sha: priorSha,
        prior_ts: priorTs,
        contributing,
        residual: 1,
        marker: "owner_identity_discontinuity_v1",
        reason: "token_changed_without_admin_token_rotated_event",
      } as JsonValue,
    });

    let ownerInputRequiredId: string | undefined;
    try {
      const oir = emitEvent(db, {
        kind: "owner_input_required",
        substrate_origin: "substrate_auto",
        payload: {
          reason: "owner_identity_discontinuity",
          floor: "owner_identity_continuity",
          predicate: "owner_identity_continuity_predicate",
          summary:
            "Owner identity token changed mid-flight without an admin_token_rotated event. Pausing autonomous commit until the owner confirms the rotation.",
          current_sha: currentSha,
          prior_sha: priorSha,
          contributing,
          evidence_event_id: discontinuityEmitted.id,
        } as JsonValue,
      });
      ownerInputRequiredId = oir.id;
    } catch (err) {
      logger.warn(
        { where: "owner_identity.emit_owner_input_required", err: (err as Error).message },
        "owner_input_required emit failed (discontinuity still recorded)",
      );
    }

    logger.error(
      { current_sha: currentSha, prior_sha: priorSha },
      "owner identity floor violated — token changed without admin_token_rotated event",
    );
    return {
      current_sha: currentSha,
      prior_sha: priorSha,
      continuity_ok: false,
      emitted_kind: "owner_identity_discontinuity",
      emitted_event_id: discontinuityEmitted.id,
      emitted_owner_input_required_id: ownerInputRequiredId,
    };
  } catch (err) {
    logger.warn(
      { where: "owner_identity.emit", err: (err as Error).message },
      "owner_identity emit failed — report not lost",
    );
    return {
      current_sha: currentSha,
      prior_sha: priorSha,
      continuity_ok: cleanContinuity,
      emitted_kind: "skipped",
    };
  }
};

// Re-export for tests that want to assert on the canonical state dir
// resolution without setting env vars.
export const __resolveStateDir = resolveStateDir;
