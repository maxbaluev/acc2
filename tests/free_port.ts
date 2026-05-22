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
