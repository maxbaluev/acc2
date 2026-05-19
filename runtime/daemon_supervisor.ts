// F10 canonical daemon hot-reload supervisor.
//
// Cites:
//   - EJFZER4SBH3C51WF1J6KWX2V6G (git HEAD detector design — bounded
//     supervisor + scheduler boundary comparison; SIGHUP only
//     accelerates).
//   - JQ5339HR1N2CQ6FH59JRJ3Z4NW (outer supervisor design — child owns
//     serving + quiescing; supervisor owns lifecycle).
//   - T9MRX55WX90NFEPHJRE37RC2XC (eligibility predicate — open
//     `brain_dispatched` minus `brain_dispatch_closed` against drain
//     budget remaining).
//   - R2DKSST5SN3BZFF1YH2XK9XF94 (no new event kinds — reuse
//     `daemon_hotreload_*`, `restart_drain_*`, F8 brain dispatch
//     leases, `daemon_started/shutdown`, `action_predicted/scored`).
//   - 7T0Y7EMGPD1BXDF4CR5F7YNYJC (quiescent swap protocol — detect HEAD
//     change → request drain → wait F8 leases → spawn replacement →
//     verify /health → mark old terminal).
//
// Module shape:
//   1. `getCurrentGitHead()` — synchronous `git rev-parse HEAD` in the
//      repo containing this module. Returns null when the resolve
//      fails (detached, missing git, non-repo) so the supervisor can
//      degrade rather than crash.
//   2. `readChildGitHead(stateDir)` / `writeChildGitHead(stateDir,head)`
//      — cross-process state file under `<stateDir>/v2.sock.git_head`.
//      The child writes once at boot; the supervisor reads at every
//      detector tick.
//   3. `isReloadEligible(db, opts)` — ledger-derived predicate. Counts
//      open brain dispatches via `getOpenBrainDispatches`; refuses
//      eligibility when the open count's expected completion would
//      exceed the supervisor's drain budget. Returns the structured
//      breakdown so the caller can emit the refusal evidence.
//   4. `swapChild(opts)` — runs the canonical quiescent swap. Sends
//      the auth-gated `/shutdown` with `drain_budget_ms`, waits for the
//      child process to exit (or the budget to expire), spawns the new
//      child via the existing daemon entry, polls `/health` until the
//      replacement reports `ok`, and returns the swap result.
//   5. `runDaemonSupervisor(opts)` — the foreground supervisor loop.
//      Spawns the first child, records the loaded HEAD, ticks the
//      detector at `ACC2_HOT_RELOAD_TICK_MS` (default 60s), gates
//      swaps on `ACC2_HOT_RELOAD_MIN_AGE_MS` (default 5min) and on
//      `isReloadEligible`. SIGHUP forces an immediate detector check;
//      it does NOT bypass eligibility.
//
// The supervisor itself is a separate process. The child it spawns is
// `runtime/daemon.ts` exactly as `acc daemon start` would launch it.
// Tests drive `isReloadEligible` and the state-file helpers directly
// so the design is verifiable without standing up a real subprocess.

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { emitEvent } from "./events";
import {
  getOpenBrainDispatches,
  type OpenBrainDispatch,
} from "./brain_dispatch_reconciler";
import { resolveStateDir } from "./state_paths";
import { logger } from "./logger";

// ── Cross-process git HEAD state file ──────────────────────────────────

/** Filename (under the state dir) the child writes its loaded git HEAD
 *  to at boot. The supervisor reads it every detector tick to compare
 *  against the current repo HEAD. The path is sibling to the daemon's
 *  `v2.sock` lock so it lives and dies with the same state dir. */
export const CHILD_GIT_HEAD_FILENAME = "v2.sock.git_head";

export const resolveChildGitHeadPath = (stateDir?: string): string =>
  join(stateDir ?? resolveStateDir(), CHILD_GIT_HEAD_FILENAME);

const ensureDir = (path: string): void => {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
};

/** Read the loaded git HEAD persisted by the running child. Returns
 *  null when the file is missing (child not yet booted, child crashed
 *  before writing, or the file was reaped). The reader trims so a
 *  trailing newline from `echo` style writes is forgiven. */
export const readChildGitHead = (stateDir?: string): string | null => {
  const path = resolveChildGitHeadPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
};

/** Persist the child's loaded git HEAD so the supervisor (a separate
 *  process) can read it at every detector tick. Called once at child
 *  boot, AFTER the lock file is written. Best-effort: a failure here
 *  must not block the daemon from serving. */
export const writeChildGitHead = (head: string, stateDir?: string): void => {
  const path = resolveChildGitHeadPath(stateDir);
  ensureDir(path);
  writeFileSync(path, head, { mode: 0o600 });
};

/** Reap the child git HEAD file. Called by the supervisor right before
 *  spawning a replacement so the new child's write is the only one the
 *  next tick observes. Tolerant of missing file. */
export const removeChildGitHead = (stateDir?: string): void => {
  const path = resolveChildGitHeadPath(stateDir);
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
};

// ── git rev-parse helper ───────────────────────────────────────────────

/** Resolve the current HEAD commit hash. Synchronous (boot path uses
 *  it once, supervisor tick uses it at a bounded cadence). Returns
 *  null when the command fails — the supervisor degrades to "no
 *  detection possible" rather than crashing. */
export const getCurrentGitHead = (cwd?: string): string | null => {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: cwd ?? process.cwd(),
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.status !== 0) return null;
    const out = (result.stdout ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};

// ── Reload eligibility predicate (ledger-derived) ──────────────────────

export type ReloadEligibilityOptions = {
  /** Total drain budget the supervisor would honour for this swap. The
   *  predicate refuses when the projected drain exceeds this budget. */
  drainBudgetMs: number;
  /** Estimated typical dispatch completion in ms. Production default
   *  comes from prior posterior evidence; the predicate ships a
   *  conservative 5min when callers do not supply one. */
  estimatedCompletionMs?: number;
  /** Override `Date.now()` for tests. */
  nowMs?: () => number;
};

export type ReloadEligibilityResult = {
  eligible: boolean;
  open_brain_dispatch_count: number;
  drain_budget_ms: number;
  estimated_completion_ms: number;
  oldest_lease_age_ms: number | null;
  refusal_reason: string | null;
  open_dispatches: OpenBrainDispatch[];
};

const DEFAULT_ESTIMATED_COMPLETION_MS = 5 * 60 * 1000;

/** Compute whether a hot-reload swap is eligible right now. The
 *  decision is read off the ledger:
 *    - 0 open brain dispatches → always eligible.
 *    - N > 0 open dispatches → eligible only when the estimated
 *      completion (= max(estimatedCompletionMs, oldest_lease_age))
 *      fits within `drainBudgetMs`. Otherwise the supervisor would
 *      either kill an active brain or block past its own budget; both
 *      paths are refused so the operator/scheduler can retry later.
 *
 *  The result carries the breakdown axes the brain knowledge entry
 *  T9MRX55WX90NFEPHJRE37RC2XC enumerates: open count, drain budget,
 *  estimated completion, oldest lease age. Callers emit the refusal
 *  evidence as a `daemon_hotreload_rejected` row + an `action_scored`
 *  breakdown — neither requires a new event kind. */
export const isReloadEligible = (
  db: Database,
  opts: ReloadEligibilityOptions,
): ReloadEligibilityResult => {
  const now = opts.nowMs ?? (() => Date.now());
  const estimatedCompletionMs = opts.estimatedCompletionMs ?? DEFAULT_ESTIMATED_COMPLETION_MS;
  const open = getOpenBrainDispatches(db);
  const openCount = open.length;
  let oldestAge: number | null = null;
  if (openCount > 0) {
    const nowMs = now();
    for (const row of open) {
      if (row.started_at_ms === null) continue;
      const age = nowMs - row.started_at_ms;
      if (oldestAge === null || age > oldestAge) oldestAge = age;
    }
  }
  if (openCount === 0) {
    return {
      eligible: true,
      open_brain_dispatch_count: 0,
      drain_budget_ms: opts.drainBudgetMs,
      estimated_completion_ms: estimatedCompletionMs,
      oldest_lease_age_ms: null,
      refusal_reason: null,
      open_dispatches: [],
    };
  }
  // Worst-case projected drain: the longer of the canonical estimate
  // and the oldest still-open lease's wall age. The latter matters
  // when a dispatch has already been running longer than the estimate
  // — its tail is more likely to be near completion, but the
  // supervisor still cannot prove it without the close event landing.
  const projected = Math.max(estimatedCompletionMs, oldestAge ?? 0);
  if (projected > opts.drainBudgetMs) {
    return {
      eligible: false,
      open_brain_dispatch_count: openCount,
      drain_budget_ms: opts.drainBudgetMs,
      estimated_completion_ms: estimatedCompletionMs,
      oldest_lease_age_ms: oldestAge,
      refusal_reason: "drain_budget_insufficient",
      open_dispatches: open,
    };
  }
  return {
    eligible: true,
    open_brain_dispatch_count: openCount,
    drain_budget_ms: opts.drainBudgetMs,
    estimated_completion_ms: estimatedCompletionMs,
    oldest_lease_age_ms: oldestAge,
    refusal_reason: null,
    open_dispatches: open,
  };
};

// ── Supervisor loop options + result types ─────────────────────────────

export type SupervisorOptions = {
  /** Detector tick interval. The supervisor re-reads git HEAD at this
   *  cadence; SIGHUP only accelerates the next tick. Default 60s. */
  tickIntervalMs?: number;
  /** Minimum child age before a swap is even considered. Stops the
   *  supervisor from thrashing immediately after spawning a child on
   *  a noisy filesystem. Default 5min. */
  minChildAgeMs?: number;
  /** Drain budget passed to the child via `/shutdown`. Default 5min. */
  drainBudgetMs?: number;
  /** Estimated completion (ms) the eligibility predicate consults. */
  estimatedCompletionMs?: number;
  /** Path to the daemon entry the supervisor spawns. Defaults to the
   *  canonical `runtime/daemon.ts`. */
  daemonEntry?: string;
  /** State dir the supervisor reads cross-process state from. */
  stateDir?: string;
  /** Override `Date.now()` for tests. */
  nowMs?: () => number;
};

export type SupervisorTickContext = {
  currentGitHead: string | null;
  childGitHead: string | null;
  childBootAtMs: number;
};

/** Pure decision function: given the current detector context, decide
 *  whether the supervisor should attempt a swap. Returns the action
 *  + the reason so the loop emits structured evidence. Eligibility
 *  is consulted only when the HEAD comparison + age gate pass — the
 *  predicate is the LAST gate, the more permissive the gate the more
 *  likely the supervisor is to disturb live brain work for nothing. */
export type SupervisorDecision =
  | { action: "no_op"; reason: "head_unchanged" | "child_too_young" | "git_head_unavailable" | "child_head_unavailable" }
  | { action: "defer"; reason: "drain_budget_insufficient"; eligibility: ReloadEligibilityResult }
  | { action: "swap"; eligibility: ReloadEligibilityResult; previous_git_head: string; new_git_head: string };

export const decideSupervisorAction = (
  db: Database,
  ctx: SupervisorTickContext,
  opts: SupervisorOptions,
): SupervisorDecision => {
  const minAge = opts.minChildAgeMs ?? 5 * 60 * 1000;
  const drainBudgetMs = opts.drainBudgetMs ?? 5 * 60 * 1000;
  const now = opts.nowMs ?? (() => Date.now());
  if (!ctx.currentGitHead) {
    return { action: "no_op", reason: "git_head_unavailable" };
  }
  if (!ctx.childGitHead) {
    return { action: "no_op", reason: "child_head_unavailable" };
  }
  if (ctx.currentGitHead === ctx.childGitHead) {
    return { action: "no_op", reason: "head_unchanged" };
  }
  if (now() - ctx.childBootAtMs < minAge) {
    return { action: "no_op", reason: "child_too_young" };
  }
  const eligibility = isReloadEligible(db, {
    drainBudgetMs,
    estimatedCompletionMs: opts.estimatedCompletionMs,
    nowMs: opts.nowMs,
  });
  if (!eligibility.eligible) {
    return {
      action: "defer",
      reason: "drain_budget_insufficient",
      eligibility,
    };
  }
  return {
    action: "swap",
    eligibility,
    previous_git_head: ctx.childGitHead,
    new_git_head: ctx.currentGitHead,
  };
};

// ── Evidence emitters (reuse-only event kinds) ─────────────────────────

/** Emit a `daemon_hotreload_rejected` row carrying the eligibility
 *  breakdown. The reuse-only inventory KC R2DKSST5SN3BZFF1YH2XK9XF94
 *  maps eligibility refusal to this existing event kind plus an
 *  `action_scored` breakdown. Reason strings stay open-ended so the
 *  brain can learn new refusal classes without an enum extension. */
export const emitReloadDeferred = (
  db: Database,
  result: ReloadEligibilityResult,
  context: Record<string, unknown>,
): void => {
  try {
    emitEvent(db, {
      kind: "daemon_hotreload_rejected",
      substrate_origin: "substrate_auto",
      payload: {
        reason: result.refusal_reason ?? "ineligible",
        open_brain_dispatch_count: result.open_brain_dispatch_count,
        drain_budget_ms: result.drain_budget_ms,
        estimated_completion_ms: result.estimated_completion_ms,
        oldest_lease_age_ms: result.oldest_lease_age_ms,
        ...context,
      },
    });
  } catch (err) {
    logger.debug(
      { where: "daemon_supervisor.emitReloadDeferred", err: String(err) },
      "could not emit daemon_hotreload_rejected (db likely closed)",
    );
  }
};

/** Emit a `daemon_hotreload_triggered` row marking the supervisor's
 *  intent to swap. The companion completed/failed event lands after
 *  the swap returns. */
export const emitSwapTriggered = (
  db: Database,
  previousHead: string,
  newHead: string,
  context: Record<string, unknown>,
): void => {
  try {
    emitEvent(db, {
      kind: "daemon_hotreload_triggered",
      substrate_origin: "substrate_auto",
      payload: {
        detector: "git_head",
        previous_git_head: previousHead,
        new_git_head: newHead,
        ...context,
      },
    });
  } catch (err) {
    logger.debug(
      { where: "daemon_supervisor.emitSwapTriggered", err: String(err) },
      "could not emit daemon_hotreload_triggered (db likely closed)",
    );
  }
};

/** Emit the terminal completion event for a swap. `swapped` is the
 *  registered event kind that lands when the new generation accepts
 *  the slot per the existing reloadable registry; F10 reuses it for
 *  the supervisor's process-level swap path. */
export const emitSwapCompleted = (
  db: Database,
  previousHead: string,
  newHead: string,
  durationMs: number,
  leasesDrained: number,
): void => {
  try {
    emitEvent(db, {
      kind: "daemon_hotreload_swapped",
      substrate_origin: "substrate_auto",
      payload: {
        detector: "git_head",
        previous_git_head: previousHead,
        new_git_head: newHead,
        swap_duration_ms: durationMs,
        leases_drained_count: leasesDrained,
      },
    });
    emitEvent(db, {
      kind: "daemon_hotreload_completed",
      substrate_origin: "substrate_auto",
      payload: {
        detector: "git_head",
        previous_git_head: previousHead,
        new_git_head: newHead,
        swap_duration_ms: durationMs,
        leases_drained_count: leasesDrained,
      },
    });
  } catch (err) {
    logger.debug(
      { where: "daemon_supervisor.emitSwapCompleted", err: String(err) },
      "could not emit daemon_hotreload swap completion (db likely closed)",
    );
  }
};

/** Emit a swap failure event. Reason strings stay open-ended; the
 *  inventory KC maps drain timeout to `restart_drain_timed_out` (the
 *  drain helper already emits that row from the child); failures in
 *  the spawn/health-probe path map here. */
export const emitSwapFailed = (
  db: Database,
  previousHead: string,
  newHead: string,
  reason: string,
  context: Record<string, unknown>,
): void => {
  try {
    emitEvent(db, {
      kind: "daemon_hotreload_failed",
      substrate_origin: "substrate_auto",
      payload: {
        detector: "git_head",
        previous_git_head: previousHead,
        new_git_head: newHead,
        reason,
        ...context,
      },
    });
  } catch (err) {
    logger.debug(
      { where: "daemon_supervisor.emitSwapFailed", err: String(err) },
      "could not emit daemon_hotreload_failed (db likely closed)",
    );
  }
};
