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

import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

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

/** Revert dirty files in the source checkout to match HEAD. Returns the
 *  list of files actually reverted. */
const revertFiles = (sourceCheckoutRoot: string, files: readonly string[]): string[] => {
  const reverted: string[] = [];
  for (const f of files) {
    const res = spawnSync("git", ["checkout", "HEAD", "--", f], {
      cwd: sourceCheckoutRoot,
      encoding: "utf8",
    });
    if (res.status === 0) reverted.push(f);
  }
  return reverted;
};

/** Inspect the source checkout for unexplained mutations after a brain
 *  dispatch returned. When dirty files exist that no
 *  applied_change_committed row from this dispatch claims, emit a
 *  dispatcher_violation and revert. */
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

  let touched: string[] | null;
  let patchPath: string | null = null;
  let revertedFiles: string[] = [];
  if (args.testOverride) {
    touched = args.testOverride.dirtyFiles;
    if (touched.length > 0) {
      try {
        mkdirSync(PATCH_ROOT, { recursive: true });
      } catch { /* ok */ }
      patchPath = join(PATCH_ROOT, `${args.dispatchId}.patch`);
      writeFileSync(patchPath, args.testOverride.patchText, "utf8");
      revertedFiles = touched.slice();
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
    revertedFiles = revertFiles(args.sourceCheckoutRoot, touched);
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
      reverted_files: revertedFiles as unknown as JsonValue,
      patch_path: patchPath ?? null,
      source_checkout_root: args.sourceCheckoutRoot,
    } as JsonValue,
  });

  return {
    ran: true,
    bypass_detected: true,
    touched_files: touched,
    reverted_files: revertedFiles,
    patch_path: patchPath,
  };
};
