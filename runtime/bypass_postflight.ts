// acc2 bypass postflight — defenses B+C from lesson 20MSGR2A253TN0T60C90AH9Z4G.
//
// Defense A (CWD isolation) ships in runtime/bridge/opencode.ts:340-368: the
// brain subprocess spawns in a per-dispatch tempdir so its filesystem tools
// cannot reach the source checkout. F2 adds the missing two defenses:
//
//   B. Post-dispatch git diff against the source checkout HEAD. If the brain
//      somehow bypassed defense A and mutated files in the source tree, the
//      diff is non-empty. Each touched file is checked against the
//      applied_change_committed rows for this dispatch — files not declared
//      via applied_change_committed are the bypass evidence.
//
//   C. Auto-revert + dispatcher_violation. The diff is saved to
//      /tmp/.acc2/bypass-recovery/<dispatch_id>.patch for forensics, the
//      offending files are reverted with `git checkout HEAD -- <files>`, and
//      a dispatcher_violation event lands with failure_kind=
//      brain_native_filesystem_bypass so the operator sees the breach.
//
// Production-only guard: when the bridge ran under checkoutIsolation (i.e.
// the dispatcher pinned a per-dispatch tempdir / worktree root) defense A
// already covered the path; the postflight is skipped because there is no
// source-checkout diff to inspect. Test fixtures and the mock bridge skip
// the postflight entirely.
//
// F5-companion scoping (2026-05-18): the F2 defense was reverting working
// tree changes whenever no applied_change_committed cited the dispatch,
// which clobbered legitimate developer-side edits that happened to overlap
// the dispatch window. The postflight now:
//
//   1. Skips entirely when ACC2_BYPASS_POSTFLIGHT_DISABLED=1. This is the
//      orchestrator-driven escape hatch for hand-implementation work where
//      the operator and agent share the same checkout; production daemon
//      should leave the flag unset.
//   2. Skips when no brain_dispatched event exists for this dispatch id —
//      Claude-inline / substrate-replay / clarification / deferred lanes
//      never spawn a brain subprocess, so a non-empty working tree must
//      belong to another actor (the operator's own edits).
//   3. Treats committed changes as locked by HEAD: `git diff HEAD` only
//      reports uncommitted working tree changes by design, so a brain
//      bypass that somehow committed its writes already appears in the
//      git log and the postflight does not revert it. This bullet is
//      pinned by an explicit test (no behavior change in code — the diff
//      command already had this property).

import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

/** Returns true when the supplied dispatch id has a matching brain_dispatched
 *  row in the ledger. The F8 commit (30d4ec5) emits this event when the
 *  opencode bridge actually spawns a brain subprocess; lanes that don't
 *  call into the bridge (claude_inline, substrate_replay, clarification,
 *  deferred_blocked) never emit it. */
const hasBrainDispatchedRow = (db: Database, dispatchId: string): boolean => {
  try {
    const row = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM events
         WHERE kind = 'brain_dispatched'
           AND (json_extract(payload, '$.dispatch_id') = ?
                OR EXISTS (SELECT 1 FROM json_each(context_refs) WHERE value = ?))`,
      )
      .get(dispatchId, dispatchId);
    return (row?.c ?? 0) > 0;
  } catch {
    // Schema variation across versions — fail closed by reporting the row
    // is absent so the postflight skips. Better to miss one bypass than to
    // clobber a developer's working tree on a synthetic event shape.
    return false;
  }
};

export type PostflightResult = {
  ran: boolean;
  bypass_detected: boolean;
  touched_files: string[];
  reverted_files: string[];
  patch_path: string | null;
  skip_reason?: string;
};

const PATCH_ROOT = "/tmp/.acc2/bypass-recovery";

/** Run `git diff HEAD --name-only` against the supplied source checkout
 *  root. Returns the list of files reported by git, or null when git is
 *  not available / the cwd is not a git checkout. */
const collectDirtyFiles = (sourceCheckoutRoot: string): string[] | null => {
  if (!existsSync(join(sourceCheckoutRoot, ".git"))) return null;
  const res = spawnSync("git", ["diff", "HEAD", "--name-only"], {
    cwd: sourceCheckoutRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) return null;
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

/** Capture the unified diff for forensics. Returns the patch file path
 *  on success. */
const savePatch = (sourceCheckoutRoot: string, dispatchId: string): string | null => {
  try {
    mkdirSync(PATCH_ROOT, { recursive: true });
  } catch { /* directory may already exist */ }
  const res = spawnSync("git", ["diff", "HEAD"], {
    cwd: sourceCheckoutRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) return null;
  const path = join(PATCH_ROOT, `${dispatchId}.patch`);
  writeFileSync(path, res.stdout, "utf8");
  return path;
};

/** Inspect the source checkout for unexplained mutations after a brain
 *  dispatch returned. When dirty files exist that no
 *  applied_change_committed row from this dispatch claims, emit a
 *  dispatcher_violation as a learnable signal. The postflight does NOT
 *  revert: in a single-checkout multi-actor world (orchestrator inline,
 *  Agent subagents, peer brain dispatches, operator editor), the
 *  reverter cannot know which of those owns the dirty state, so
 *  auto-revert silently clobbered legitimate concurrent work.
 *  Detection + dispatcher_violation (a health_metric + mirror_inline
 *  event) is the universal substrate response; the orchestrator or
 *  owner decides reversibility from the violation event. The
 *  `reverted_files` field on PostflightResult is now always empty and
 *  retained only for back-compat with callers reading the shape. */
export const runBypassPostflight = (
  db: Database,
  args: {
    dispatchId: string;
    taskId: string;
    directiveId: string;
    sourceCheckoutRoot: string;
    /** When true the dispatch ran under explicit checkout isolation
     *  (worktree or test tempdir); defense A already covered the
     *  filesystem path, so the postflight short-circuits. */
    isolated: boolean;
    /** Test-suite hook: when set, the postflight skips the real git
     *  shellouts and reads the dirty file list + patch text from these
     *  fields. The revert call is also bypassed in that mode. */
    testOverride?: {
      dirtyFiles: string[];
      patchText: string;
    };
  },
): PostflightResult => {
  if (args.isolated) {
    return {
      ran: false,
      bypass_detected: false,
      touched_files: [],
      reverted_files: [],
      patch_path: null,
      skip_reason: "checkout_isolated",
    };
  }

  // Scope to dispatches that actually spawned a brain subprocess. Without
  // brain_dispatched evidence, the working tree state belongs to another
  // actor (the operator's own edits, an Agent subagent on the same
  // checkout, a CI process) and the detection is moot.
  if (!hasBrainDispatchedRow(db, args.dispatchId)) {
    return {
      ran: false,
      bypass_detected: false,
      touched_files: [],
      reverted_files: [],
      patch_path: null,
      skip_reason: "no_brain_dispatch_for_id",
    };
  }

  let touched: string[] | null;
  let patchPath: string | null = null;
  if (args.testOverride) {
    touched = args.testOverride.dirtyFiles;
    if (touched.length > 0) {
      try {
        mkdirSync(PATCH_ROOT, { recursive: true });
      } catch { /* ok */ }
      patchPath = join(PATCH_ROOT, `${args.dispatchId}.patch`);
      writeFileSync(patchPath, args.testOverride.patchText, "utf8");
    }
  } else {
    touched = collectDirtyFiles(args.sourceCheckoutRoot);
    if (touched === null) {
      return {
        ran: false,
        bypass_detected: false,
        touched_files: [],
        reverted_files: [],
        patch_path: null,
        skip_reason: "git_unavailable_or_not_a_checkout",
      };
    }
    if (touched.length === 0) {
      return {
        ran: true,
        bypass_detected: false,
        touched_files: [],
        reverted_files: [],
        patch_path: null,
      };
    }
    patchPath = savePatch(args.sourceCheckoutRoot, args.dispatchId);
  }

  if (!touched || touched.length === 0) {
    return {
      ran: true,
      bypass_detected: false,
      touched_files: [],
      reverted_files: [],
      patch_path: null,
    };
  }

  // Cross-check against applied_change_committed rows for this dispatch:
  // any file declared via an applied_change_committed during the same
  // dispatch is NOT a bypass — it is a sanctioned write. We compare
  // against payload.target_path / payload.path / payload.target_files.
  const declared = new Set<string>();
  try {
    const rows = db
      .query<{ payload: string }, [string]>(
        `SELECT payload FROM events
          WHERE kind = 'applied_change_committed'
            AND task_id = ?`,
      )
      .all(args.taskId);
    for (const row of rows) {
      try {
        const p = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
        if (typeof p.target_path === "string") declared.add(p.target_path);
        if (typeof p.path === "string") declared.add(p.path);
        if (Array.isArray(p.target_files)) {
          for (const f of p.target_files) if (typeof f === "string") declared.add(f);
        }
      } catch { /* malformed payload: skip */ }
    }
  } catch { /* db query failed: treat declared set as empty */ }

  const undeclared = touched.filter((f) => !declared.has(f));
  if (undeclared.length === 0) {
    return {
      ran: true,
      bypass_detected: false,
      touched_files: touched,
      reverted_files: [],
      patch_path: patchPath,
      skip_reason: "all_writes_declared",
    };
  }

  emitEvent(db, {
    kind: "dispatcher_violation",
    substrate_origin: "substrate_auto",
    directive_id: args.directiveId,
    task_id: args.taskId,
    failure_kind: "brain_native_filesystem_bypass",
    payload: {
      dispatch_id: args.dispatchId,
      undeclared_files: undeclared as unknown as JsonValue,
      touched_files: touched as unknown as JsonValue,
      declared_files: Array.from(declared) as unknown as JsonValue,
      patch_path: patchPath ?? null,
      source_checkout_root: args.sourceCheckoutRoot,
    } as JsonValue,
  });

  return {
    ran: true,
    bypass_detected: true,
    touched_files: touched,
    reverted_files: [],
    patch_path: patchPath,
  };
};
