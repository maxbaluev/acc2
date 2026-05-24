// acc2 post-commit projection queue
// (directive NHY908W0EX5Q72KGWXMASPFEY0, amendment B0DVM2APWX +
//  watchdog amendment 9J0CSDP7ND, 2026-05-24).
//
// ROOT CAUSE this module fixes: `emitEvent` (runtime/events.ts) used to run
// its full post-insert projection cascade — recordInternalAct for closure
// verdicts + lesson extraction, dense-closure DAG backprop, action_scored →
// credit/artifact-score projectors, the act_artifact_candidate refusal
// screen, verifier auto-admit, and entity/owner-profile attribute writes —
// SYNCHRONOUSLY on the single bun event loop, in the same call stack as the
// MCP `substrate.emit` handler. Over a large ledger (130k+ events, 687+
// activation listeners) one heavy write cascade could monopolize the loop
// for longer than the MCP client deadline, so the SDK returned "Request
// timed out" while the daemon was perfectly alive and the row was already
// durable.
//
// DEADLOCK-SAFETY CONTRACT (each invariant maps to the directive's a–d):
//
//   (a) DURABILITY BEFORE ACK. The queue is only ever enqueued AFTER the
//       event row has been INSERTed and the synchronous bus/activation
//       notification fired. emitEvent returns its {id, ts} ack the instant
//       the row is durable. We never ack a write that is not persisted, and
//       the deferred projections operate on an already-committed row, so a
//       crash between ack and drain loses only *derived* projections — which
//       are idempotent and re-derivable from the durable source row.
//
//   (b) NO DROPPED EVENTS ON OVERLAP. A single `running` flag serializes
//       drains: a second emit whose cascade arrives while the first drain is
//       mid-slice only APPENDS to the FIFO tail; it never starts a second
//       concurrent drainer and never loses listeners. Nested enqueues from
//       inside a projection likewise append to the tail and are picked up by
//       the same drain loop. Ordering is strict FIFO.
//
//   (c) FIRE-ONCE WATCHDOG. While a drain is in flight a single watchdog
//       timer is armed. If a slice stops making progress (the drained
//       counter does not advance within the budget) the watchdog fires
//       EXACTLY ONCE, emits mcp_operation_watchdog_fired, and surfaces the
//       wedge instead of letting it hang silently. It never cancels a
//       SQLite write mid-flight; it only observes + reports.
//
//   (d) BOUNDED QUEUE WITH BACKPRESSURE. The queue has a hard depth cap. An
//       enqueue past the cap is REJECTED and emits post_commit_projection_
//       overflow naming the dropped projection — a clear, auditable overflow
//       signal, never a silent drop and never an unbounded OOM-risk buffer.
//
// The projections themselves keep their existing projection_key idempotency
// guards (existingProjection SELECT-before-INSERT), so a re-enqueue or a
// duplicate drain cannot double-write. This module only changes WHEN the
// projection runs (deferred, bounded), never WHETHER its idempotency holds.

import type { Database } from "bun:sqlite";
import { logger } from "./logger";

/** One deferred unit of post-commit projection work. The closure captures
 *  the already-durable source event id + db handle. It MUST be fail-soft on
 *  its own (the prior synchronous branches were wrapped in try/catch); the
 *  drain loop adds a second outer guard so one bad item cannot wedge the
 *  rest of the FIFO. */
export type PostCommitProjectionTask = {
  /** Stable label for diagnostics + watchdog payloads (e.g. the source
   *  event kind). */
  readonly label: string;
  /** The durable source event id this projection derives from. */
  readonly sourceEventId: string;
  /** The deferred work. Sync or async; the drain awaits async work but
   *  bounds total wall time per slice. */
  readonly run: () => void | Promise<void>;
};

export type PostCommitQueueConfig = {
  /** Max projection tasks drained before yielding the event loop. */
  maxEventsPerSlice: number;
  /** Max wall-clock ms spent in one slice before yielding. */
  maxWallMsPerSlice: number;
  /** Hard depth cap. Enqueue past this is rejected with an overflow signal. */
  maxQueueDepth: number;
  /** Watchdog budget: if a drain makes zero progress for this long, fire
   *  the fire-once watchdog. High enough to mean "no progress", not "slow". */
  watchdogMs: number;
};

export const DEFAULT_POST_COMMIT_QUEUE_CONFIG: PostCommitQueueConfig = {
  maxEventsPerSlice: 25,
  maxWallMsPerSlice: 20,
  maxQueueDepth: 50_000,
  watchdogMs: 30_000,
};

/** Injected so tests can drive a deterministic clock + timers. Production
 *  uses the global wall clock and real timers. */
export type QueueClock = {
  now: () => number;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const REAL_CLOCK: QueueClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Overflow + watchdog sinks are injected so the queue does not import
 *  events.ts (which imports this module) — that would be a cycle. emitEvent
 *  wires the real emitEvent-backed sinks at construction. */
export type QueueSinks = {
  /** Emit post_commit_projection_overflow for a rejected enqueue. */
  onOverflow: (info: { droppedLabel: string; droppedEventId: string; queueDepth: number; cap: number }) => void;
  /** Emit mcp_operation_watchdog_fired exactly once per wedged drain. */
  onWatchdog: (info: { watchdogId: string; queueDepth: number; lastDrainedSeq: number; hungForMs: number }) => void;
};

let nextWatchdogSeq = 0;

export class PostCommitProjectionQueue {
  private readonly queue: PostCommitProjectionTask[] = [];
  private running = false;
  private drainedSeq = 0;
  private watchdogHandle: unknown = null;
  private watchdogArmedForSeq = -1;
  private watchdogFired = false;

  constructor(
    private readonly config: PostCommitQueueConfig = DEFAULT_POST_COMMIT_QUEUE_CONFIG,
    private readonly sinks: QueueSinks = { onOverflow: () => {}, onWatchdog: () => {} },
    private readonly clock: QueueClock = REAL_CLOCK,
  ) {}

  /** Current pending depth. Diagnostics only. */
  depth(): number {
    return this.queue.length;
  }

  /** Total tasks drained over the queue's lifetime. Test/diagnostic. */
  drainedCount(): number {
    return this.drainedSeq;
  }

  /** Enqueue one deferred projection. Returns false (and emits an overflow
   *  signal) when the bounded cap is hit — the durable source row already
   *  landed, so only the derived projection is dropped, and the overflow
   *  event makes that loss auditable. Starts the drain loop if idle. */
  enqueue(task: PostCommitProjectionTask): boolean {
    if (this.queue.length >= this.config.maxQueueDepth) {
      // (d) Bounded with a clear overflow signal — never a silent drop,
      // never an unbounded buffer.
      try {
        this.sinks.onOverflow({
          droppedLabel: task.label,
          droppedEventId: task.sourceEventId,
          queueDepth: this.queue.length,
          cap: this.config.maxQueueDepth,
        });
      } catch (err) {
        logger.debug({ where: "post_commit_queue.overflow_sink", err: String(err) }, "overflow sink threw (swallowed)");
      }
      return false;
    }
    this.queue.push(task);
    // (b) One running flag → no second concurrent drainer. A nested enqueue
    // mid-drain only appends; this start is a no-op while running.
    if (!this.running) {
      this.running = true;
      // Yield once before the first slice so the enqueuing emitEvent call
      // returns its ack first (durability-before-ack stays observable even
      // for the very first item).
      this.clock.setTimeout(() => { void this.drain(); }, 0);
    }
    return true;
  }

  private armWatchdog(): void {
    if (this.watchdogHandle !== null) return;
    this.watchdogFired = false;
    this.watchdogArmedForSeq = this.drainedSeq;
    const startedAt = this.clock.now();
    this.watchdogHandle = this.clock.setTimeout(() => {
      // (c) Fire-once: only fire if the drain made ZERO progress since arm
      // and is still running. Slow-but-progressing work re-arms instead.
      this.watchdogHandle = null;
      if (!this.running) return;
      if (this.drainedSeq > this.watchdogArmedForSeq) {
        // Progress happened — re-arm rather than cry wolf.
        this.armWatchdog();
        return;
      }
      if (this.watchdogFired) return;
      this.watchdogFired = true;
      const watchdogId = `pcq_wd_${nextWatchdogSeq++}`;
      try {
        this.sinks.onWatchdog({
          watchdogId,
          queueDepth: this.queue.length,
          lastDrainedSeq: this.drainedSeq,
          hungForMs: this.clock.now() - startedAt,
        });
      } catch (err) {
        logger.debug({ where: "post_commit_queue.watchdog_sink", err: String(err) }, "watchdog sink threw (swallowed)");
      }
    }, this.config.watchdogMs);
  }

  private disarmWatchdog(): void {
    if (this.watchdogHandle !== null) {
      this.clock.clearTimeout(this.watchdogHandle);
      this.watchdogHandle = null;
    }
  }

  /** Drain at most one slice, then reschedule if work remains. Never runs
   *  concurrently with itself (the running flag guards it). */
  private async drain(): Promise<void> {
    this.armWatchdog();
    const sliceStart = this.clock.now();
    let drainedThisSlice = 0;
    while (
      this.queue.length > 0 &&
      drainedThisSlice < this.config.maxEventsPerSlice &&
      this.clock.now() - sliceStart < this.config.maxWallMsPerSlice
    ) {
      const task = this.queue.shift()!;
      try {
        const r = task.run();
        if (r && typeof (r as Promise<void>).then === "function") {
          await r;
        }
      } catch (err) {
        // Fail-soft: one bad projection cannot wedge the FIFO. The source
        // row is durable; the projection's own guard already emitted any
        // projection_error row. This outer guard catches anything else.
        logger.debug(
          { where: "post_commit_queue.task", label: task.label, sourceEventId: task.sourceEventId, err: String(err) },
          "post-commit projection task threw (swallowed)",
        );
      }
      this.drainedSeq++;
      drainedThisSlice++;
    }

    if (this.queue.length > 0) {
      // Budget exhausted with work remaining — yield and continue. Re-arm
      // is implicit: armWatchdog at the top of the next slice sees progress.
      this.clock.setTimeout(() => { void this.drain(); }, 0);
      return;
    }
    // Queue empty — fully quiesced. Disarm the watchdog and release the
    // running flag so a future enqueue restarts a fresh drain loop.
    this.disarmWatchdog();
    this.running = false;
  }

  /** Test helper: hard-reset the queue between cases so a prior test's
   *  un-drained tasks (or a watchdog timer) cannot bleed into the next
   *  test's db. Production never calls this — the queue is process-lived. */
  resetForTest(): void {
    this.queue.length = 0;
    this.disarmWatchdog();
    this.running = false;
    this.drainedSeq = 0;
    this.watchdogArmedForSeq = -1;
    this.watchdogFired = false;
  }

  /** Test helper: drain the queue to empty synchronously-ish by repeatedly
   *  awaiting microtasks. Production never calls this. */
  async flushForTest(): Promise<void> {
    while (this.running || this.queue.length > 0) {
      if (!this.running && this.queue.length > 0) {
        this.running = true;
        // eslint-disable-next-line no-await-in-loop
        await this.drain();
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
}
