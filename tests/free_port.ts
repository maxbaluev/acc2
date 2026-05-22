// acc2 test helper — OS-assigned free-port allocation.
//
// Random ports in a fixed band collide (birthday-collision across many
// servers + parallel test files), producing flaky "Failed to start server.
// Is port X in use?" failures and making the suite unsafe to run alongside
// a live daemon. The robust fix is to let the OS assign a guaranteed-free
// ephemeral port: bind a throwaway listener on port 0, read the assigned
// port, release it, and hand it back. The OS never assigns a port already
// in use, so this is collision-free by construction (a tiny close→reuse
// window remains, which callers cover with a bind-retry).
//
// This is strictly better than the prior random/monotonic schemes: no band
// bookkeeping, no cross-file coordination, no collision with the live
// daemon's fixed ports (9387/9388), and faster (no retry storms).

/** Ask the OS for a currently-free TCP port. Collision-free by construction. */
export const getFreePort = (): number => {
  const srv = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  const port = srv.port;
  srv.stop(true);
  return port;
};

/** A free (mcp, aux) pair. Allocated independently so they never coincide. */
export const getFreePortPair = (): { mcp: number; aux: number } => {
  const mcp = getFreePort();
  let aux = getFreePort();
  // Vanishingly unlikely, but guarantee distinctness.
  while (aux === mcp) aux = getFreePort();
  return { mcp, aux };
};

/**
 * Resilient daemon boot for tests.
 *
 * `getFreePortPair()` is collision-free by construction EXCEPT for a tiny
 * close→reuse window: between releasing the throwaway listener and the daemon
 * binding, another parallel test file can grab the same OS port, producing the
 * intermittent "Failed to start server. Is port NNNNN in use?" flake under
 * `bun test --parallel`. This helper loops up to 4 times, picking a FRESH
 * port pair each attempt, and only retries on an in-use/EADDRINUSE bind error
 * — any other failure rethrows immediately. The integration harness
 * (tests/integration/scenarios.ts:bootDaemon) used to inline this pattern;
 * it now delegates here so there is one canonical resilient-boot path.
 *
 * `startDaemon` is passed in (rather than imported) so this helper stays in
 * the test-only module without pulling the daemon into every importer.
 * `baseOpts` carries everything except the ports; `port` / `auxPort` are
 * overwritten on each attempt.
 */
export async function startDaemonOnFreePorts<
  H,
  O extends { port?: number; auxPort?: number },
>(
  startDaemon: (opts: O) => Promise<H>,
  baseOpts: Omit<O, "port" | "auxPort">,
): Promise<H> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { mcp, aux } = getFreePortPair();
    try {
      return await startDaemon({ ...(baseOpts as O), port: mcp, auxPort: aux });
    } catch (err) {
      lastErr = err;
      const msg = (err as Error)?.message ?? String(err);
      if (!/in use|EADDRINUSE/i.test(msg)) throw err;
    }
  }
  throw lastErr;
}
