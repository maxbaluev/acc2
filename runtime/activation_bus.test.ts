import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  activationListenerCount,
  clearAllActivationListeners,
  onEvent,
  publishActivation,
  waitForActivation,
} from "./activation_bus";
import { newId } from "./ids";

// The activation bus is a process-wide SINGLETON. In the full suite, other
// files (notably runtime/daemon.test.ts) start real daemons whose workers
// subscribe via onEvent("*"); stopDaemon() returns before the async
// startWorkers() background task finishes draining those subscriptions, so
// leftover listeners can survive into THIS file and break the absolute-count
// assertions below. Reset the singleton both before AND after every case so
// these tests are robust to any prior leak regardless of file ordering.
beforeEach(() => clearAllActivationListeners());
afterEach(() => clearAllActivationListeners());

const samplePayload = (kind: string) => ({
  event_id: newId(),
  ts: new Date().toISOString(),
  kind: kind as never,
  directive_id: newId(),
  task_id: newId(),
});

describe("activation_bus", () => {
  test("onEvent subscribes to a single kind and disposer removes the listener", () => {
    const calls: string[] = [];
    const dispose = onEvent("task_committed" as never, (p) => { calls.push(p.kind); });
    expect(activationListenerCount()).toBe(1);
    publishActivation(samplePayload("task_committed"));
    expect(calls).toEqual(["task_committed"]);
    dispose();
    expect(activationListenerCount()).toBe(0);
    publishActivation(samplePayload("task_committed"));
    expect(calls).toEqual(["task_committed"]);
  });

  test("wildcard listener receives every event kind", () => {
    const calls: string[] = [];
    onEvent("*", (p) => { calls.push(p.kind); });
    publishActivation(samplePayload("directive_opened"));
    publishActivation(samplePayload("task_committed"));
    publishActivation(samplePayload("bridge_health_degraded"));
    expect(calls).toEqual(["directive_opened", "task_committed", "bridge_health_degraded"]);
  });

  test("waitForActivation resolves when a watched kind fires", async () => {
    const promise = waitForActivation(["task_committed" as never, "task_failed" as never]);
    publishActivation(samplePayload("task_committed"));
    const payload = await promise;
    expect(payload).not.toBeNull();
    expect(payload!.kind).toBe("task_committed");
  });

  test("waitForActivation honors abort signal", async () => {
    const ctrl = new AbortController();
    const promise = waitForActivation(["task_committed" as never], ctrl.signal);
    ctrl.abort();
    const payload = await promise;
    expect(payload).toBeNull();
  });

  test("waitForActivation cleans up listeners on resolve", async () => {
    const before = activationListenerCount();
    const promise = waitForActivation(["task_committed" as never, "task_failed" as never]);
    expect(activationListenerCount()).toBe(before + 2);
    publishActivation(samplePayload("task_committed"));
    await promise;
    expect(activationListenerCount()).toBe(before);
  });

  test("subscriber that throws does not break sibling listeners", () => {
    const calls: string[] = [];
    onEvent("task_committed" as never, () => { throw new Error("boom"); });
    onEvent("task_committed" as never, (p) => { calls.push(p.kind); });
    publishActivation(samplePayload("task_committed"));
    expect(calls).toEqual(["task_committed"]);
  });

  test("publish on a kind with no listeners is a no-op", () => {
    expect(() => publishActivation(samplePayload("knowledge_promoted"))).not.toThrow();
  });
});
