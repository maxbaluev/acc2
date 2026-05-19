// acc2 Prometheus metrics — prom-client backed.
//
// Per docs/production-readiness.md §Top-2 + §audit, the daemon's metrics
// surface must expose:
//   - Counters: dispatches, artifact_invocations, embeddings, events,
//     external_pushes.
//   - Histograms: dispatch_duration, action_residual, artifact_duration,
//     embedding_duration.
//   - Gauges: daemon_uptime, substrate_events, act_artifacts_admitted,
//     act_artifacts_promoted, act_artifacts_quarantined.
//
// Wire scheme:
//   - Recording helpers (recordDispatch, recordEvent, …) are the only
//     surface call sites should touch — no direct register / histogram
//     manipulation from outside this module.
//   - The aux Bun.serve handles `/metrics` by calling `metricsHandler`
//     which returns the Prometheus text-format exposition.
//   - `refreshGauges(db)` is invoked from a daemon-side interval (every
//     30s) to snapshot SQLite-backed gauges (event count, artifact
//     counts) — this avoids `SELECT count(*)` on every scrape.
//
// Process model:
//   - One global `register` per process — prom-client's `register` is
//     a singleton. We clear it on test reset via `resetMetrics()` so
//     repeated daemon spinups don't double-register metrics (prom-client
//     throws "metric already registered" otherwise).
//   - Metrics are created lazily on first import — same module identity
//     guarantees the singletons survive across daemon restarts within
//     the same Bun process.

import type { Database } from "bun:sqlite";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

// ── Registry (singleton) ───────────────────────────────────────────

/** The canonical metrics registry. Tests can call `resetMetrics()` to
 *  clear and re-register the canonical set. */
export const register = new Registry();

// Collect default Node.js metrics (event-loop lag, CPU, GC, heap). This
// is the "free" Node-process visibility the operator gets without
// instrumenting anything else.
collectDefaultMetrics({ register });

// ── Counters ──────────────────────────────────────────────────────

export const dispatchesTotal = new Counter({
  name: "acc2_dispatches_total",
  help: "Total brain dispatches by route and outcome.",
  labelNames: ["route", "outcome"] as const,
  registers: [register],
});

export const artifactInvocationsTotal = new Counter({
  name: "acc2_artifact_invocations_total",
  help: "Total code-artifact invocations by runtime and outcome.",
  labelNames: ["runtime", "outcome"] as const,
  registers: [register],
});

export const embeddingsComputedTotal = new Counter({
  name: "acc2_embeddings_computed_total",
  help: "Total successful embedding computations.",
  registers: [register],
});

export const eventsEmittedTotal = new Counter({
  name: "acc2_events_emitted_total",
  help: "Total events emitted by kind.",
  labelNames: ["kind"] as const,
  registers: [register],
});

export const externalPushesTotal = new Counter({
  name: "acc2_external_pushes_total",
  help: "Total external pushes received by source.",
  labelNames: ["source"] as const,
  registers: [register],
});

// ── Histograms ────────────────────────────────────────────────────

export const dispatchDurationSeconds = new Histogram({
  name: "acc2_dispatch_duration_seconds",
  help: "Brain dispatch duration in seconds.",
  labelNames: ["route"] as const,
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

export const actionResidualHistogram = new Histogram({
  name: "acc2_action_residual",
  help: "Observed action residuals by runtime.",
  labelNames: ["runtime"] as const,
  buckets: [0, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1],
  registers: [register],
});

export const artifactDurationSeconds = new Histogram({
  name: "acc2_artifact_durations_seconds",
  help: "Code-artifact invocation duration in seconds.",
  labelNames: ["runtime"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [register],
});

export const embeddingDurationSeconds = new Histogram({
  name: "acc2_embedding_duration_seconds",
  help: "Single-embedding compute duration in seconds.",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

// ── Gauges ────────────────────────────────────────────────────────

export const daemonUptimeSeconds = new Gauge({
  name: "acc2_daemon_uptime_seconds",
  help: "Seconds since daemon boot.",
  registers: [register],
});

export const substrateEventsTotal = new Gauge({
  name: "acc2_substrate_events_total",
  help: "Total event rows in the substrate (sampled every 30s).",
  registers: [register],
});

export const codeArtifactsAdmittedTotal = new Gauge({
  name: "acc2_act_artifacts_admitted_total",
  help: "Code artifacts with status='admitted' (sampled).",
  registers: [register],
});

export const codeArtifactsPromotedTotal = new Gauge({
  name: "acc2_act_artifacts_promoted_total",
  help: "Code artifacts with status='promoted' (sampled).",
  registers: [register],
});

export const codeArtifactsQuarantinedTotal = new Gauge({
  name: "acc2_act_artifacts_quarantined_total",
  help: "Code artifacts with status='quarantined' (sampled).",
  registers: [register],
});

// ── Typed recording helpers ───────────────────────────────────────

/** Record a brain dispatch — increments the counter and observes the
 *  duration in the histogram. `outcome` is one of "ok"|"violation"|
 *  "bridge_failed"|"verifier_high_residual"|"refinement_emitted"|
 *  "recipe_replayed". `route` is the effective dispatch route. */
export const recordDispatch = (route: string, outcome: string, durationSeconds: number): void => {
  dispatchesTotal.labels(route, outcome).inc();
  dispatchDurationSeconds.labels(route).observe(durationSeconds);
};

/** Record one artifact invocation outcome. `outcome` is "ok"|"failed"|
 *  "timeout"|"sandbox_violation". */
export const recordArtifactInvocation = (
  runtime: string,
  outcome: string,
  durationSeconds: number,
): void => {
  artifactInvocationsTotal.labels(runtime, outcome).inc();
  artifactDurationSeconds.labels(runtime).observe(durationSeconds);
};

/** Record an observed action residual (post-verifier). */
export const recordActionResidual = (runtime: string, residual: number): void => {
  actionResidualHistogram.labels(runtime).observe(residual);
};

/** Record one successful embedding computation. */
export const recordEmbedding = (durationSeconds: number): void => {
  embeddingsComputedTotal.inc();
  embeddingDurationSeconds.observe(durationSeconds);
};

/** Record one event emission. Called from inside runtime/events.ts:emitEvent
 *  so every event kind contributes to the counter. */
export const recordEventEmission = (kind: string): void => {
  eventsEmittedTotal.labels(kind).inc();
};

/** Record one external-source push by source name. */
export const recordExternalPush = (source: string): void => {
  externalPushesTotal.labels(source).inc();
};

/** Snapshot SQLite-backed gauges. Called from a daemon-side interval
 *  every 30s. Cheap (~3 COUNT queries). */
export const refreshGauges = (db: Database, startedAtMs: number): void => {
  try {
    daemonUptimeSeconds.set((Date.now() - startedAtMs) / 1000);
    const eventsRow = db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number } | null;
    substrateEventsTotal.set(eventsRow?.n ?? 0);
    const admittedRow = db
      .query("SELECT COUNT(*) AS n FROM act_artifact WHERE status = 'admitted'")
      .get() as { n: number } | null;
    codeArtifactsAdmittedTotal.set(admittedRow?.n ?? 0);
    const promotedRow = db
      .query("SELECT COUNT(*) AS n FROM act_artifact WHERE status = 'promoted'")
      .get() as { n: number } | null;
    codeArtifactsPromotedTotal.set(promotedRow?.n ?? 0);
    const quarantinedRow = db
      .query("SELECT COUNT(*) AS n FROM act_artifact WHERE status = 'quarantined'")
      .get() as { n: number } | null;
    codeArtifactsQuarantinedTotal.set(quarantinedRow?.n ?? 0);
  } catch {
    // Gauge sampling is best-effort. A transient SQL error must not crash
    // the daemon.
  }
};

/** GET /metrics handler — returns the Prometheus text exposition. The
 *  content-type follows Prometheus spec 0.0.4 (the de-facto current
 *  version supported by every scraper). */
export const metricsHandler = async (_req: Request): Promise<Response> => {
  const body = await register.metrics();
  return new Response(body, {
    status: 200,
    headers: { "content-type": register.contentType },
  });
};

/** Reset the canonical registry. Test-only — production never calls this
 *  since prom-client expects a single registration per process. */
export const resetMetrics = (): void => {
  register.resetMetrics();
};
