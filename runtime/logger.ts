// acc2 structured logger — pino-based, JSON-native, low-overhead.
//
// Why pino: it's the canonical Node.js structured-logging library, writes
// JSON lines to stdout by default, and supports child loggers with bound
// context (correlation_id, dispatch_id, task_id, …) — the exact shape we
// need for daemon hot paths. In production (NODE_ENV=production) we emit
// raw JSON to stdout so systemd/journalctl/logshippers can ingest as-is.
// In dev we pipe through pino-pretty for human-readable colored output.
// In test (NODE_ENV=test) we use a silent logger so test output stays
// uncluttered.
//
// Optional file output: when ACC2_LOG_FILE=1, ALSO write JSON lines to
// ~/.accint/logs/daemon.jsonl. Rotation is handled externally via
// logrotate (per docs/ops-guide.md); pino does not handle rotation
// natively. The file stream is opened lazily so unit tests that import
// this module never create the log directory.
//
// Usage:
//   import { logger } from "./logger";
//   logger.info({ task_id: "t_123" }, "dispatched");
//   const child = withContext({ correlation_id: "corr_abc" });
//   child.warn({ retry: 3 }, "transient failure");
//
// Module is fail-soft: if pino fails to initialize for any reason, we
// fall back to a no-op logger that never throws. The daemon must never
// crash because of a logging failure.

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pino from "pino";

export type LogContext = {
  correlation_id?: string;
  dispatch_id?: string;
  task_id?: string;
  directive_id?: string;
  module?: string;
  [k: string]: unknown;
};

/** Resolve the effective log level. Order of precedence:
 *   1. ACC2_LOG_LEVEL env var (explicit override)
 *   2. NODE_ENV=test → silent
 *   3. NODE_ENV=production → info
 *   4. else → debug (developer default)
 *  Returns one of pino's level names. */
export const resolveLogLevel = (): pino.LevelWithSilent => {
  const explicit = process.env.ACC2_LOG_LEVEL;
  if (explicit && ["trace", "debug", "info", "warn", "error", "fatal", "silent"].includes(explicit)) {
    return explicit as pino.LevelWithSilent;
  }
  const env = process.env.NODE_ENV;
  if (env === "test") return "silent";
  if (env === "production") return "info";
  return "debug";
};

/** Default daemon log file path (when ACC2_LOG_FILE=1). */
export const DEFAULT_LOG_FILE = join(homedir(), ".accint", "logs", "daemon.jsonl");

const ensureDirFor = (path: string): void => {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
};

/** Build the canonical daemon logger. Exported as a factory so tests can
 *  build isolated loggers with explicit options without touching the
 *  module-level singleton. */
export const createLogger = (overrides?: { level?: pino.LevelWithSilent; file?: string | null }): pino.Logger => {
  const level = overrides?.level ?? resolveLogLevel();
  const fileEnabled = overrides?.file !== undefined
    ? overrides.file !== null
    : process.env.ACC2_LOG_FILE === "1";
  const filePath = overrides?.file ?? (fileEnabled ? DEFAULT_LOG_FILE : null);
  const isProd = process.env.NODE_ENV === "production";
  const isTest = process.env.NODE_ENV === "test";

  // Test mode: silent. No I/O, no formatting cost.
  if (isTest && !overrides?.level) {
    return pino({ level: "silent" });
  }

  try {
    // When file output is enabled, use pino's multistream to fan out to
    // stdout + file. Otherwise default destination (stdout).
    if (filePath) {
      ensureDirFor(filePath);
      const streams: pino.StreamEntry[] = [
        { level, stream: pino.destination({ dest: filePath, sync: false }) },
      ];
      // Stdout target: pretty in dev, raw JSON in prod. pino-pretty would
      // require its own transport worker; for the fanout case we keep
      // stdout as raw JSON to avoid the transport-thread complication.
      streams.push({ level, stream: pino.destination(1) });
      return pino({ level }, pino.multistream(streams));
    }
    if (isProd) {
      // Raw JSON to stdout (systemd / journalctl / log-shippers).
      return pino({ level });
    }
    // Dev: pretty stdout output. Falls back to raw JSON if pino-pretty
    // is not installed at runtime.
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
      },
    });
  } catch {
    // Fail-soft: a misconfigured transport must not kill the daemon.
    return pino({ level });
  }
};

/** Canonical daemon-wide logger. Use directly OR wrap with `withContext`
 *  to bind correlation ids. */
export const logger: pino.Logger = createLogger();

/** Create a child logger with bound context. The returned logger emits
 *  every line with the given context merged in — every downstream call
 *  inherits the binding. Use one child per dispatch, one per worker tick,
 *  etc. so log lines can be grouped by correlation_id in log explorers. */
export const withContext = (ctx: LogContext): pino.Logger => {
  return logger.child(ctx);
};
