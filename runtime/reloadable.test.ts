// Tests for the reloadable module registry — the indirection layer
// that makes hot-reload actually swap behavior, not just re-import a
// detached module. Pre-2026-05-17 hot reload was theatre; this primitive
// is what makes it real.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetReloadableRegistryForTests,
  getReloadable,
  listReloadables,
  registerReloadable,
  reloadableVersions,
} from "./reloadable";

beforeEach(() => __resetReloadableRegistryForTests());

describe("registerReloadable", () => {
  test("first .current() boots from loader and starts at version 1", async () => {
    const slot = registerReloadable<{ value: number }>({
      name: "demo",
      load: async () => ({ value: 42 }),
    });
    expect(slot.version()).toBe(0);
    const mod = await slot.current();
    expect(mod.value).toBe(42);
    expect(slot.version()).toBe(1);
  });

  test("refresh swaps the cached reference and bumps version", async () => {
    let counter = 0;
    const slot = registerReloadable<{ value: number }>({
      name: "demo",
      load: async () => ({ value: ++counter }),
    });
    await slot.current(); // v1, value=1
    const r = await slot.refresh("file:///fake?ts=1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.version).toBe(2);
      expect(r.previous_kept).toBe(true);
    }
    expect(slot.version()).toBe(2);
    const after = await slot.current();
    expect(after.value).toBe(2);
  });

  test("validate rejects bad module shape; previous reference stays active", async () => {
    let pinned: { call: () => string } = { call: () => "good" };
    const slot = registerReloadable<{ call: () => string }>({
      name: "demo",
      load: async () => pinned,
      validate: (mod) => typeof mod.call === "function" ? true : "missing call export",
    });
    await slot.current();
    expect(slot.version()).toBe(1);
    pinned = ({} as unknown as { call: () => string }); // simulate a broken new module
    const r = await slot.refresh("file:///fake?ts=2");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("validation_failed");
      expect(r.error).toBe("missing call export");
    }
    expect(slot.version()).toBe(1); // unchanged
    // Old reference still callable.
    const mod = await slot.current();
    expect(mod.call()).toBe("good");
  });

  test("smokeProbe failure also refuses the swap", async () => {
    let pinned = { call: () => "good" };
    const slot = registerReloadable<{ call: () => string }>({
      name: "demo",
      load: async () => pinned,
      smokeProbe: (mod) => {
        try {
          const v = mod.call();
          return v === "good" ? { ok: true } : { ok: false, error: `unexpected:${v}` };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },
    });
    await slot.current();
    pinned = { call: () => "broken" };
    const r = await slot.refresh("file:///fake?ts=3");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("smoke_probe_failed");
    expect(slot.version()).toBe(1);
  });

  test("loader exception surfaces as load_threw", async () => {
    const slot = registerReloadable<unknown>({
      name: "demo",
      load: async (url) => {
        if (url) throw new Error("syntax error in new module");
        return {};
      },
    });
    await slot.current();
    const r = await slot.refresh("file:///fake?ts=4");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("load_threw");
      expect(r.error).toContain("syntax error");
    }
  });

  test("rollback restores the previous reference + bumps version", async () => {
    let pinned: { value: number } = { value: 1 };
    const slot = registerReloadable<{ value: number }>({
      name: "demo",
      load: async () => pinned,
    });
    await slot.current(); // v1, value=1
    pinned = { value: 2 };
    await slot.refresh("file:///fake?ts=5"); // v2, value=2
    expect((await slot.current()).value).toBe(2);
    const rolled = slot.rollback();
    expect(rolled).toBe(true);
    expect(slot.version()).toBe(3);
    expect((await slot.current()).value).toBe(1);
  });

  test("rollback returns false when no previous reference is held", async () => {
    const slot = registerReloadable<{ value: number }>({
      name: "demo",
      load: async () => ({ value: 1 }),
    });
    await slot.current();
    expect(slot.rollback()).toBe(false);
  });

  test("listReloadables + reloadableVersions enumerate live slots", async () => {
    registerReloadable<unknown>({ name: "a", load: async () => ({}) });
    registerReloadable<unknown>({ name: "b", load: async () => ({}) });
    await getReloadable("a")!.current();
    await getReloadable("b")!.current();
    await getReloadable("a")!.refresh("file:///x?ts=1");
    expect(listReloadables().sort()).toEqual(["a", "b"]);
    const vs = reloadableVersions();
    expect(vs.a).toBe(2);
    expect(vs.b).toBe(1);
  });
});
