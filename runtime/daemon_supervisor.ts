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
//      detector at the canonical 60s cadence, gates swaps on
//      `ACC2_HOT_RELOAD_MIN_AGE_MS` (default 5min) and on
//      `isReloadEligible`. SIGHUP forces an immediate detector check;
//      it does NOT bypass eligibility.
//
// The supervisor itself is a separate process. The child it spawns is
// `runtime/daemon.ts` exactly as `acc daemon start` would launch it.
// Tests drive `isReloadEligible` and the state-file helpers directly
// so the design is verifiable without standing up a real subprocess.

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { emitEvent } from "./events";
import {
  getOpenBrainDispatches,
  type OpenBrainDispatch,
} from "./brain_dispatch_reconciler";
import {
  resolveStateDir,
  resolveSocketFile,
  resolveTokenFile,
  resolveDaemonPorts,
  detectStaleLock,
  defaultPidAlive,
  type StaleLockVerdict,
} from "./state_paths";
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

// ── Runtime supervisor loop ────────────────────────────────────────────
//
// The pure decision function above is the falsifiability surface; the
// loop below is the procedural wiring around it. Every external effect
// (git rev-parse, /shutdown POST, child spawn, /health poll, clock,
// sleep) is overridable via SupervisorLoopDeps so tests can exercise
// the swap protocol without spawning a real daemon subprocess.
// Production callers pass nothing and get the canonical implementations.

/** Pluggable effect surface for the supervisor loop. */
export type SupervisorLoopDeps = {
  getCurrentGitHead?: () => string | null;
  readChildGitHead?: (stateDir: string) => string | null;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  spawnChild?: (entry: string, stateDir: string) => SupervisorChildHandle;
  requestChildShutdown?: (stateDir: string, drainBudgetMs: number) => Promise<boolean>;
  pollChildHealth?: (stateDir: string, deadlineMs: number) => Promise<boolean>;
  waitChildExit?: (handle: SupervisorChildHandle, budgetMs: number) => Promise<boolean>;
};

/** Minimal child handle the loop tracks. */
export type SupervisorChildHandle = {
  pid: number | null;
  exited: boolean;
  exitCode: number | null;
  raw?: ChildProcess;
};

export type SupervisorLoopOptions = SupervisorOptions & {
  /** Cap on the number of ticks the loop runs before returning. */
  maxTicks?: number;
  /** Abort signal — the loop exits on receipt. */
  abortSignal?: AbortSignal;
};

// The discriminant is named `outcome`, not `kind`. The event-kind
// registry coverage test in substrate/event_kinds.test.ts scans every
// `kind: "<literal>"` occurrence in production code and treats each
// literal as a candidate event kind. Supervisor outcomes are in-process
// control values, not ledger event kinds; using `outcome` keeps them
// out of that scan.
export type SupervisorTickOutcome =
  | { outcome: "no_op"; reason: string }
  | { outcome: "defer"; reason: string; eligibility: ReloadEligibilityResult }
  | { outcome: "swap_succeeded"; previousHead: string; newHead: string; durationMs: number; leasesDrained: number }
  | { outcome: "swap_failed"; previousHead: string; newHead: string; reason: string };

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_DAEMON_ENTRY_RELATIVE = "daemon.ts";

const resolveDaemonEntry = (override?: string): string => {
  if (override) return override;
  const here = import.meta?.dirname ?? process.cwd();
  return resolvePath(here, DEFAULT_DAEMON_ENTRY_RELATIVE);
};

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => { setTimeout(r, ms); });

const realSpawnChild = (entry: string, _stateDir: string): SupervisorChildHandle => {
  const child = spawn("bun", [entry], {
    detached: false,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });
  const handle: SupervisorChildHandle = {
    pid: child.pid ?? null,
    exited: false,
    exitCode: null,
    raw: child,
  };
  child.on("exit", (code) => {
    handle.exited = true;
    handle.exitCode = code;
  });
  return handle;
};

const realWaitChildExit = async (
  handle: SupervisorChildHandle,
  budgetMs: number,
): Promise<boolean> => {
  if (handle.exited) return true;
  return await new Promise<boolean>((resolveExit) => {
    if (!handle.raw) {
      const start = Date.now();
      const poll = setInterval(() => {
        if (handle.exited) { clearInterval(poll); resolveExit(true); return; }
        if (Date.now() - start >= budgetMs) { clearInterval(poll); resolveExit(false); }
      }, 50);
      return;
    }
    const timer = setTimeout(() => resolveExit(false), budgetMs);
    handle.raw.on("exit", () => { clearTimeout(timer); resolveExit(true); });
  });
};

const realRequestChildShutdown = async (
  _stateDir: string,
  drainBudgetMs: number,
): Promise<boolean> => {
  try {
    // Lazy import keeps the cli/* dependency edge optional in test
    // contexts that only drive the pure decision function.
    const { auxBaseUrl, readAdminToken, rpcPostAuth } = await import("../cli/rpc");
    const base = auxBaseUrl();
    if (!base) return false;
    const token = readAdminToken();
    if (!token) return false;
    const reply = await rpcPostAuth<{ ok?: boolean; error?: string }>(
      `${base}/shutdown`,
      token,
      { drain_budget_ms: drainBudgetMs },
      { timeoutMs: drainBudgetMs + 10_000 },
    );
    return reply.ok === true;
  } catch (err) {
    logger.debug(
      { where: "daemon_supervisor.requestChildShutdown", err: String(err) },
      "shutdown request failed",
    );
    return false;
  }
};

const realPollChildHealth = async (
  _stateDir: string,
  deadlineMs: number,
): Promise<boolean> => {
  try {
    const { auxBaseUrl, rpcGet } = await import("../cli/rpc");
    while (Date.now() < deadlineMs) {
      const base = auxBaseUrl();
      if (base) {
        const reply = await rpcGet<{ status?: string }>(`${base}/health`).catch(() => null);
        if (reply && reply.status === "ok") return true;
      }
      await realSleep(500);
    }
    return false;
  } catch {
    return false;
  }
};

/** Side-channel handoff for the freshly spawned child. There is at
 *  most one outer supervisor per process and the value is read
 *  synchronously after swapChild resolves, so a module-scoped holder
 *  is sufficient and avoids changing the public swap return shape. */
const lastSpawnedHandle: { current: SupervisorChildHandle | null } = { current: null };

/** Execute the canonical quiescent swap protocol. */
export const swapChild = async (
  db: Database,
  prevHandle: SupervisorChildHandle | null,
  previousHead: string,
  newHead: string,
  eligibility: ReloadEligibilityResult,
  opts: SupervisorOptions,
  deps: SupervisorLoopDeps,
): Promise<SupervisorTickOutcome> => {
  const drainBudgetMs = opts.drainBudgetMs ?? 5 * 60 * 1000;
  const stateDir = opts.stateDir ?? resolveStateDir();
  const entry = resolveDaemonEntry(opts.daemonEntry);
  const now = deps.nowMs ?? (() => Date.now());
  const startedAt = now();

  emitSwapTriggered(db, previousHead, newHead, {
    drain_budget_ms: drainBudgetMs,
    open_brain_dispatch_count: eligibility.open_brain_dispatch_count,
  });

  const requestShutdown = deps.requestChildShutdown ?? realRequestChildShutdown;
  const waitExit = deps.waitChildExit ?? realWaitChildExit;
  const spawnNew = deps.spawnChild ?? realSpawnChild;
  const pollHealth = deps.pollChildHealth ?? realPollChildHealth;

  const shutdownAccepted = await requestShutdown(stateDir, drainBudgetMs);
  if (!shutdownAccepted) {
    const reason = "shutdown_request_refused";
    emitSwapFailed(db, previousHead, newHead, reason, { drain_budget_ms: drainBudgetMs });
    return { outcome: "swap_failed", previousHead, newHead, reason };
  }

  if (prevHandle) {
    const exited = await waitExit(prevHandle, drainBudgetMs);
    if (!exited) {
      const reason = "drain_exceeded_budget";
      emitSwapFailed(db, previousHead, newHead, reason, {
        drain_budget_ms: drainBudgetMs,
      });
      return { outcome: "swap_failed", previousHead, newHead, reason };
    }
  }

  removeChildGitHead(stateDir);

  const newHandle = spawnNew(entry, stateDir);
  lastSpawnedHandle.current = newHandle;

  const healthDeadline = now() + 30_000;
  const healthy = await pollHealth(stateDir, healthDeadline);
  if (!healthy) {
    const reason = "new_child_health_check_failed";
    emitSwapFailed(db, previousHead, newHead, reason, {
      new_child_pid: newHandle.pid,
    });
    return { outcome: "swap_failed", previousHead, newHead, reason };
  }

  const durationMs = now() - startedAt;
  emitSwapCompleted(
    db,
    previousHead,
    newHead,
    durationMs,
    eligibility.open_brain_dispatch_count,
  );
  return {
    outcome: "swap_succeeded",
    previousHead,
    newHead,
    durationMs,
    leasesDrained: eligibility.open_brain_dispatch_count,
  };
};

/** Foreground supervisor loop. SIGHUP accelerates the next tick but
 *  does NOT bypass eligibility. Returns when `opts.maxTicks` is hit,
 *  `opts.abortSignal` aborts, or the process exits. */
export const runSupervisorLoop = async (
  db: Database,
  initialChildHandle: SupervisorChildHandle | null,
  opts: SupervisorLoopOptions = {},
  deps: SupervisorLoopDeps = {},
): Promise<SupervisorTickOutcome[]> => {
  const tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const stateDir = opts.stateDir ?? resolveStateDir();
  const now = deps.nowMs ?? (() => Date.now());
  const sleep = deps.sleep ?? realSleep;
  const readHead = deps.readChildGitHead ?? readChildGitHead;
  const currentHead = deps.getCurrentGitHead ?? (() => getCurrentGitHead());

  let activeChild: SupervisorChildHandle | null = initialChildHandle;
  let childBootAtMs = now();

  let sighupTriggered = false;
  let abortRequested = false;
  const sighupHandler = (): void => { sighupTriggered = true; };
  const abortHandler = (): void => { abortRequested = true; };
  process.on("SIGHUP", sighupHandler);
  opts.abortSignal?.addEventListener("abort", abortHandler);

  const outcomes: SupervisorTickOutcome[] = [];
  let ticks = 0;

  try {
    while (true) {
      if (abortRequested || opts.abortSignal?.aborted) break;
      if (typeof opts.maxTicks === "number" && ticks >= opts.maxTicks) break;

      const ctx: SupervisorTickContext = {
        currentGitHead: currentHead(),
        childGitHead: readHead(stateDir),
        childBootAtMs,
      };
      const decision = decideSupervisorAction(db, ctx, opts);
      if (decision.action === "no_op") {
        outcomes.push({ outcome: "no_op", reason: decision.reason });
      } else if (decision.action === "defer") {
        emitReloadDeferred(db, decision.eligibility, {
          previous_git_head: ctx.childGitHead,
          new_git_head: ctx.currentGitHead,
        });
        outcomes.push({
          outcome: "defer",
          reason: decision.reason,
          eligibility: decision.eligibility,
        });
      } else {
        const swapResult = await swapChild(
          db,
          activeChild,
          decision.previous_git_head,
          decision.new_git_head,
          decision.eligibility,
          opts,
          deps,
        );
        if (swapResult.outcome === "swap_succeeded") {
          activeChild = lastSpawnedHandle.current;
          lastSpawnedHandle.current = null;
          childBootAtMs = now();
        }
        outcomes.push(swapResult);
      }

      ticks += 1;
      if (typeof opts.maxTicks === "number" && ticks >= opts.maxTicks) break;

      // Sleep until next tick OR SIGHUP/abort. Polling cadence is
      // intentionally short so a SIGHUP delivered mid-wait accelerates
      // the next iteration without bypassing eligibility.
      const wakeAt = now() + tickIntervalMs;
      while (now() < wakeAt) {
        if (sighupTriggered) { sighupTriggered = false; break; }
        if (abortRequested || opts.abortSignal?.aborted) break;
        const remaining = Math.min(250, wakeAt - now());
        if (remaining <= 0) break;
        await sleep(remaining);
      }
    }
  } finally {
    process.removeListener("SIGHUP", sighupHandler);
    opts.abortSignal?.removeEventListener("abort", abortHandler);
  }

  return outcomes;
};

// ────────────────────────────────────────────────────────────────────────
// CRASH-RESILIENCE WATCHDOG (resource-spec AHV73KJDK54P3FF7D2NDV9TQ2C)
// ────────────────────────────────────────────────────────────────────────
//
// The hot-reload supervisor above swaps a HEALTHY daemon on a git-HEAD
// change. This section handles the orthogonal failure the spec names: the
// daemon DIED (native Bun SIGILL/SIGSEGV, or any exit that skipped stop()),
// leaving the lock + ports behind, and the system is STUCK because:
//   1. the crashed process never released ports 9387/9388 promptly, so the
//      next `start` failed with EADDRINUSE, and
//   2. the stale lock + token files were never reaped (stop() never ran),
//      so a naive start short-circuits on "already running".
//
// The watchdog detects ONLY the dead-process signature (pid gone / stale
// lock — NEVER slowness or /health unresponsiveness), polls for OS port
// release, reaps the stale lock/token/child-head files, then respawns
// EXACTLY ONE daemon via the canonical entry. The respawn is lock-aware +
// idempotent: it delegates the single-writer guarantee to the daemon's own
// O_CREAT|O_EXCL boot lock (acquireBootLock), so two racing watchdogs can
// never create duplicate daemons — one wins the exclusive create, the other
// gets DaemonAlreadyRunningError and exits 0 as a no-op.

/** True when a TCP listener is accepting connections on host:port. The
 *  watchdog polls this to confirm a crashed daemon's port has actually been
 *  released by the OS before respawning (a dead pid can leave a port in
 *  TIME_WAIT / not-yet-reclaimed for a short window). Best-effort: any
 *  non-connect outcome counts as "not listening". */
export const isPortBound = async (port: number, host = "127.0.0.1"): Promise<boolean> => {
  try {
    const socket = await Bun.connect({
      hostname: host,
      port,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
};

export type CrashWatchdogDeps = {
  /** Stale-lock verdict probe. Defaults to the canonical detector. */
  detectStaleLock?: (lockPath?: string, pidAlive?: (pid: number) => boolean) => StaleLockVerdict;
  /** pid-liveness probe injected into the detector. This — and ONLY this — is
   *  the recovery trigger. The watchdog watches the OS process lifecycle, NOT
   *  responsiveness: a pid that is ALIVE is never disturbed, no matter how slow
   *  it is to answer /health (a 20+ min opencode/GPT-5.5 brain cycle keeps the
   *  process alive and is legitimate long-running work — see the hard
   *  constraint in resource-spec AHV73KJDK54P3FF7D2NDV9TQ2C). Recovery fires
   *  exclusively when the pid is GONE (crash / SIGILL / SIGSEGV / clean exit
   *  that skipped lock cleanup) or the lock is structurally stale (no/zero pid,
   *  malformed). There is intentionally NO /health probe and NO time-deadline
   *  "unresponsive → kill" path in this watchdog. */
  pidAlive?: (pid: number) => boolean;
  /** Port-bound probe (override in tests to simulate slow release). */
  isPortBound?: (port: number, host?: string) => Promise<boolean>;
  /** Reap a single file (lock / token / child-head). */
  removeFile?: (path: string) => void;
  /** Spawn the canonical daemon child. Defaults to the lock-aware entry. */
  spawnDaemon?: (entry: string) => SupervisorChildHandle;
  /** Clock + sleep overrides for deterministic tests. */
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type CrashWatchdogOptions = {
  /** Ports the crashed daemon owned. Defaults to resolveDaemonPorts(). */
  ports?: readonly number[];
  /** Max ms to poll for OS port release before giving up and surfacing an
   *  operator diagnostic (a non-child process is holding the port). */
  portReleaseDeadlineMs?: number;
  /** Poll cadence while waiting for port release. */
  portPollIntervalMs?: number;
  /** Lock-file path override. */
  lockPath?: string;
  /** Token-file path override. */
  tokenPath?: string;
  /** State dir (for the child-head sibling file). */
  stateDir?: string;
  /** Daemon entry to spawn. Defaults to runtime/daemon.ts. */
  daemonEntry?: string;
  /** Host the ports are bound on. */
  host?: string;
};

export type CrashRecoveryResult =
  | { action: "no_recovery_needed"; reason: "lock_healthy" | "no_lock"; verdict: StaleLockVerdict }
  | {
      action: "operator_diagnostic_required";
      reason: "port_held_by_non_child";
      ports_still_bound: number[];
      verdict: StaleLockVerdict;
    }
  | {
      action: "recovered";
      verdict: StaleLockVerdict;
      reaped: string[];
      ports_released: number[];
      respawn_pid: number | null;
    };

const removeFileBestEffort = (path: string): void => {
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch (err) {
    logger.debug({ where: "daemon_supervisor.removeFileBestEffort", path, err: String(err) }, "reap failed (best-effort)");
  }
};

/** Poll `ports` until every one is free OR the deadline expires. Returns the
 *  ports STILL bound at deadline (empty array = all released). A crashed
 *  daemon usually releases its ports within a few hundred ms; the poll lets
 *  the OS reclaim them before the respawn tries to bind, eliminating the
 *  EADDRINUSE stuck-state. */
export const waitForPortRelease = async (
  ports: readonly number[],
  opts: { deadlineMs?: number; pollIntervalMs?: number; host?: string } = {},
  deps: { isPortBound?: (port: number, host?: string) => Promise<boolean>; nowMs?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number[]> => {
  const deadlineMs = opts.deadlineMs ?? 10_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 200;
  const host = opts.host ?? "127.0.0.1";
  const bound = deps.isPortBound ?? isPortBound;
  const now = deps.nowMs ?? (() => Date.now());
  const sleep = deps.sleep ?? realSleep;
  const deadline = now() + deadlineMs;
  while (true) {
    const stillBound: number[] = [];
    for (const port of ports) {
      if (await bound(port, host)) stillBound.push(port);
    }
    if (stillBound.length === 0) return [];
    if (now() >= deadline) return stillBound;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
};

const realSpawnDaemon = (entry: string): SupervisorChildHandle => {
  // Canonical start path: spawn `bun runtime/daemon.ts`. The child runs
  // acquireBootLock (O_CREAT|O_EXCL) itself, so the single-daemon guarantee
  // is enforced at the filesystem layer regardless of how many watchdogs
  // call this concurrently. Detached + unref so the watchdog process can
  // exit without taking the daemon with it.
  const child = spawn("bun", [entry], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });
  child.unref();
  const handle: SupervisorChildHandle = {
    pid: child.pid ?? null,
    exited: false,
    exitCode: null,
    raw: child,
  };
  child.on("exit", (code) => {
    handle.exited = true;
    handle.exitCode = code;
  });
  return handle;
};

/**
 * Single-pass crash recovery. CRASH-ONLY: the recovery trigger is the OS
 * process lifecycle (pid liveness), NEVER responsiveness or a time deadline.
 *
 *   - lock present + pid ALIVE  → no_recovery_needed. The incumbent is left
 *     COMPLETELY UNTOUCHED — no kill, no respawn, no /health probe — even if it
 *     is slow or unresponsive. A live process running a 20+ min opencode/
 *     GPT-5.5 brain cycle is legitimate long-running work; the watchdog must
 *     not disturb it. This is the owner's hard constraint
 *     (resource-spec AHV73KJDK54P3FF7D2NDV9TQ2C): NEVER kill live work.
 *   - no lock                   → no_recovery_needed (nothing crashed).
 *   - stale lock — pid GONE (crash / SIGILL / SIGSEGV / exit that skipped
 *     stop()), or structurally stale (no/zero pid, malformed):
 *       1. poll for OS port release (waitForPortRelease).
 *       2. if a port is STILL bound after the deadline AND the lock pid is
 *          dead → a non-child process owns it → surface
 *          operator_diagnostic_required (do NOT thrash spawning into an
 *          occupied port).
 *       3. reap lock + token + child-head files.
 *       4. respawn EXACTLY ONE daemon via the lock-aware canonical entry.
 *
 * There is deliberately NO "/health unresponsive past N seconds → kill"
 * branch. The watchdog watches whether the child PROCESS exists, not whether
 * it answers fast.
 *
 * `db` is optional and used only to attach orphan-count evidence to logs;
 * the respawned daemon's boot reconcileBrainDispatchesAtBoot is what
 * actually recovers orphaned dispatches.
 */
export const recoverCrashedDaemon = async (
  opts: CrashWatchdogOptions = {},
  deps: CrashWatchdogDeps = {},
): Promise<CrashRecoveryResult> => {
  const lockPath = opts.lockPath ?? resolveSocketFile();
  const tokenPath = opts.tokenPath ?? resolveTokenFile();
  const stateDir = opts.stateDir ?? resolveStateDir();
  const ports = opts.ports ?? resolveDaemonPorts();
  const host = opts.host ?? "127.0.0.1";
  const entry = resolveDaemonEntry(opts.daemonEntry);

  const detect = deps.detectStaleLock ?? detectStaleLock;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const removeFile = deps.removeFile ?? removeFileBestEffort;
  const spawnDaemon = deps.spawnDaemon ?? realSpawnDaemon;

  const verdict = detect(lockPath, pidAlive);

  // No lock → nothing crashed; a fresh start is the caller's job, not the
  // watchdog's. (The watchdog respawns only after detecting a crash.)
  if (!verdict.present) {
    return { action: "no_recovery_needed", reason: "no_lock", verdict };
  }

  // Lock present + pid ALIVE → the incumbent is the recovery trigger's ONLY
  // negative: a live process is left completely untouched. No /health probe,
  // no kill, no respawn — a slow-but-alive daemon running a long brain cycle is
  // legitimate work the watchdog must never disturb (owner hard constraint).
  // The watchdog watches the OS PROCESS lifecycle (pid liveness), not
  // responsiveness. Recovery fires ONLY when the pid is gone / the lock is
  // structurally stale (verdict.stale), handled below.
  if (!verdict.stale) {
    return { action: "no_recovery_needed", reason: "lock_healthy", verdict };
  }

  // ── Recovery path: pid GONE (crash / SIGILL / SIGSEGV) or stale lock ──────
  const stillBound = await waitForPortRelease(
    ports,
    {
      deadlineMs: opts.portReleaseDeadlineMs ?? 10_000,
      pollIntervalMs: opts.portPollIntervalMs ?? 200,
      host,
    },
    { isPortBound: deps.isPortBound, nowMs: deps.nowMs, sleep: deps.sleep },
  );

  if (stillBound.length > 0) {
    // A port is held past the release deadline and the lock owner is gone:
    // a NON-CHILD process owns the port. Spinning a respawn into an occupied
    // port just reproduces EADDRINUSE. Surface an operator diagnostic instead
    // (the spec's hidl_action_required), do NOT respawn blindly.
    logger.error(
      { ports_still_bound: stillBound, lock_pid: verdict.pid, reason: verdict.reason },
      "crash-watchdog: ports still bound after release deadline; a non-child process owns them — operator action required",
    );
    return {
      action: "operator_diagnostic_required",
      reason: "port_held_by_non_child",
      ports_still_bound: stillBound,
      verdict,
    };
  }

  // Reap stale lock/token/child-head so the respawn's acquireBootLock sees a
  // clean slate. Idempotent — missing files are tolerated.
  const reaped: string[] = [];
  for (const path of [lockPath, tokenPath, join(stateDir, CHILD_GIT_HEAD_FILENAME)]) {
    if (existsSync(path)) {
      removeFile(path);
      reaped.push(path);
    }
  }

  // Respawn EXACTLY ONE daemon. The child's own O_CREAT|O_EXCL boot lock is
  // the single-writer guarantee — even if two watchdogs reach this line
  // concurrently, only one child wins the lock; the loser exits 0 as a no-op.
  const handle = spawnDaemon(entry);
  logger.info(
    { respawn_pid: handle.pid, reaped, reason: verdict.reason },
    "crash-watchdog: reaped stale daemon state, released ports, respawned single daemon",
  );

  return {
    action: "recovered",
    verdict,
    reaped,
    ports_released: [...ports],
    respawn_pid: handle.pid,
  };
};

export type CrashWatchdogLoopOptions = CrashWatchdogOptions & {
  /** Detector cadence. Default 5s. */
  tickIntervalMs?: number;
  /** Cap on ticks before the loop returns (tests). Unbounded when absent. */
  maxTicks?: number;
  /** Abort signal — the loop exits on receipt. */
  abortSignal?: AbortSignal;
};

/**
 * Long-running crash watchdog. Ticks at `tickIntervalMs`, calling
 * recoverCrashedDaemon each tick. Returns the recovery results (tests cap
 * with maxTicks; production runs until aborted). The loop is intentionally
 * stateless between ticks — the lock file is the single source of truth, so
 * a watchdog restart never loses track of what it was doing.
 */
export const runCrashWatchdogLoop = async (
  opts: CrashWatchdogLoopOptions = {},
  deps: CrashWatchdogDeps = {},
): Promise<CrashRecoveryResult[]> => {
  const tickIntervalMs = opts.tickIntervalMs ?? 5_000;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.nowMs ?? (() => Date.now());

  let abortRequested = false;
  const abortHandler = (): void => { abortRequested = true; };
  opts.abortSignal?.addEventListener("abort", abortHandler);

  const results: CrashRecoveryResult[] = [];
  let ticks = 0;
  try {
    while (true) {
      if (abortRequested || opts.abortSignal?.aborted) break;
      if (typeof opts.maxTicks === "number" && ticks >= opts.maxTicks) break;
      results.push(await recoverCrashedDaemon(opts, deps));
      ticks += 1;
      if (typeof opts.maxTicks === "number" && ticks >= opts.maxTicks) break;
      const wakeAt = now() + tickIntervalMs;
      while (now() < wakeAt) {
        if (abortRequested || opts.abortSignal?.aborted) break;
        const remaining = Math.min(250, wakeAt - now());
        if (remaining <= 0) break;
        await sleep(remaining);
      }
    }
  } finally {
    opts.abortSignal?.removeEventListener("abort", abortHandler);
  }
  return results;
};
