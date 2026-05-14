// acc2 logger tests — level resolution + child-context bindings.
//
// We do NOT assert on the literal pino transport output (formats vary
// across versions) — instead we exercise the factory's contract:
//   - resolveLogLevel honors ACC2_LOG_LEVEL, then NODE_ENV.
//   - createLogger returns a pino instance with the resolved level.
//   - child loggers carry their bound context to downstream calls.

import { describe, expect, test } from "bun:test";
import { createLogger, resolveLogLevel, withContext, logger } from "./logger";

describe("resolveLogLevel — env-driven", () => {
  const original = { LEVEL: process.env.ACC2_LOG_LEVEL, NODE: process.env.NODE_ENV };
  const restore = () => {
    if (original.LEVEL === undefined) delete process.env.ACC2_LOG_LEVEL;
    else process.env.ACC2_LOG_LEVEL = original.LEVEL;
    if (original.NODE === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original.NODE;
  };

  test("ACC2_LOG_LEVEL override wins over NODE_ENV", () => {
    process.env.ACC2_LOG_LEVEL = "trace";
    process.env.NODE_ENV = "production";
    try {
      expect(resolveLogLevel()).toBe("trace");
    } finally {
      restore();
    }
  });

  test("NODE_ENV=test → silent", () => {
    delete process.env.ACC2_LOG_LEVEL;
    process.env.NODE_ENV = "test";
    try {
      expect(resolveLogLevel()).toBe("silent");
    } finally {
      restore();
    }
  });

  test("NODE_ENV=production → info", () => {
    delete process.env.ACC2_LOG_LEVEL;
    process.env.NODE_ENV = "production";
    try {
      expect(resolveLogLevel()).toBe("info");
    } finally {
      restore();
    }
  });

  test("unknown ACC2_LOG_LEVEL value falls through to NODE_ENV", () => {
    process.env.ACC2_LOG_LEVEL = "bogus";
    process.env.NODE_ENV = "production";
    try {
      expect(resolveLogLevel()).toBe("info");
    } finally {
      restore();
    }
  });
});

describe("createLogger — explicit overrides", () => {
  test("builds a pino instance with the override level", () => {
    const log = createLogger({ level: "warn", file: null });
    expect(log.level).toBe("warn");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  test("silent level produces a no-op logger that doesn't throw", () => {
    const log = createLogger({ level: "silent", file: null });
    // None of these should throw.
    log.info("hello");
    log.warn({ ctx: "x" }, "warn msg");
    log.error({ err: "oops" }, "error msg");
    expect(log.level).toBe("silent");
  });
});

describe("withContext — child loggers carry binding", () => {
  test("child logger has correlation_id baked in", () => {
    const child = withContext({ correlation_id: "corr_test_123", module: "test" });
    expect(typeof child.info).toBe("function");
    // pino exposes .bindings() for inspection.
    const bindings = (child as unknown as { bindings: () => Record<string, unknown> }).bindings();
    expect(bindings.correlation_id).toBe("corr_test_123");
    expect(bindings.module).toBe("test");
  });

  test("nested child preserves parent bindings", () => {
    const c1 = withContext({ correlation_id: "outer" });
    const c2 = c1.child({ task_id: "t_42" });
    const bindings = (c2 as unknown as { bindings: () => Record<string, unknown> }).bindings();
    expect(bindings.correlation_id).toBe("outer");
    expect(bindings.task_id).toBe("t_42");
  });
});

describe("module logger smoke", () => {
  test("module-level `logger` exists and is callable", () => {
    expect(typeof logger.info).toBe("function");
    // Must not throw when called with a binding-style argument.
    logger.debug({ probe: "smoke" }, "module logger smoke probe");
  });
});
