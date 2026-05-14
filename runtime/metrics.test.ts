// acc2 metrics tests — counter increments, histogram observes, /metrics
// returns Prometheus exposition format.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import {
  dispatchesTotal,
  eventsEmittedTotal,
  metricsHandler,
  recordArtifactInvocation,
  recordDispatch,
  recordEmbedding,
  recordEventEmission,
  recordExternalPush,
  refreshGauges,
  register,
  resetMetrics,
  substrateEventsTotal,
} from "./metrics";

describe("counters & histograms increment via typed helpers", () => {
  beforeEach(() => { resetMetrics(); });

  test("recordDispatch — counter + histogram both update", async () => {
    recordDispatch("opencode_brain", "committed", 1.5);
    recordDispatch("opencode_brain", "committed", 2.5);
    const out = await register.metrics();
    expect(out).toContain('acc2_dispatches_total{route="opencode_brain",outcome="committed"} 2');
    expect(out).toContain("acc2_dispatch_duration_seconds_bucket");
    expect(out).toContain('route="opencode_brain"');
  });

  test("recordArtifactInvocation — labelled by runtime + outcome", async () => {
    recordArtifactInvocation("bun", "ok", 0.4);
    recordArtifactInvocation("uv", "failed", 1.2);
    const out = await register.metrics();
    expect(out).toContain('acc2_artifact_invocations_total{runtime="bun",outcome="ok"} 1');
    expect(out).toContain('acc2_artifact_invocations_total{runtime="uv",outcome="failed"} 1');
  });

  test("recordEmbedding — counter + duration both update", async () => {
    recordEmbedding(0.1);
    recordEmbedding(0.2);
    const out = await register.metrics();
    expect(out).toContain("acc2_embeddings_computed_total 2");
    expect(out).toContain("acc2_embedding_duration_seconds_bucket");
  });

  test("recordEventEmission — counter labelled by kind", async () => {
    recordEventEmission("knowledge_candidate");
    recordEventEmission("knowledge_candidate");
    recordEventEmission("task_committed");
    const out = await register.metrics();
    expect(out).toContain('acc2_events_emitted_total{kind="knowledge_candidate"} 2');
    expect(out).toContain('acc2_events_emitted_total{kind="task_committed"} 1');
  });

  test("recordExternalPush — counter labelled by source", async () => {
    recordExternalPush("test_source");
    recordExternalPush("test_source");
    recordExternalPush("other");
    const out = await register.metrics();
    expect(out).toContain('acc2_external_pushes_total{source="test_source"} 2');
    expect(out).toContain('acc2_external_pushes_total{source="other"} 1');
  });
});

describe("metricsHandler returns Prometheus exposition", () => {
  beforeEach(() => { resetMetrics(); });

  test("Content-Type matches Prometheus 0.0.4 spec", async () => {
    recordDispatch("opencode_brain", "committed", 0.5);
    const req = new Request("http://localhost/metrics");
    const res = await metricsHandler(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    // Standard Prometheus help/type lines must be present.
    expect(body).toContain("# HELP acc2_dispatches_total");
    expect(body).toContain("# TYPE acc2_dispatches_total counter");
  });

  test("default Node metrics (event-loop lag, GC) are exposed", async () => {
    const req = new Request("http://localhost/metrics");
    const res = await metricsHandler(req);
    const body = await res.text();
    expect(body).toContain("nodejs_eventloop_lag_seconds");
  });
});

describe("refreshGauges samples SQLite-backed gauges", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    resetMetrics();
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-metrics-"));
    dbPath = join(tmpDir, "test.db");
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("substrate_events_total reflects events table count", async () => {
    const db = openDb(dbPath);
    emitEvent(db, { kind: "directive_opened", payload: { directive_text: "x" } });
    emitEvent(db, { kind: "directive_opened", payload: { directive_text: "y" } });
    refreshGauges(db, Date.now() - 5000);
    const out = await register.metrics();
    expect(out).toMatch(/acc2_substrate_events_total \d+/);
    // Gauge value should reflect the inserted rows (≥2).
    const m = out.match(/acc2_substrate_events_total (\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(2);
  });

  test("daemon_uptime_seconds reflects elapsed time", async () => {
    const db = openDb(dbPath);
    refreshGauges(db, Date.now() - 7500);
    const out = await register.metrics();
    expect(out).toMatch(/acc2_daemon_uptime_seconds [\d.]+/);
  });
});

describe("emitEvent → recordEventEmission integration", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    resetMetrics();
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-metrics-emit-"));
    dbPath = join(tmpDir, "test.db");
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("emitEvent increments acc2_events_emitted_total", async () => {
    const db = openDb(dbPath);
    emitEvent(db, { kind: "directive_opened", payload: { directive_text: "test" } });
    const out = await register.metrics();
    expect(out).toContain('acc2_events_emitted_total{kind="directive_opened"}');
  });
});
