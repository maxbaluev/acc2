// `acc state {me,focus,search,contracts,entity,portfolio,govern}` — thin MCP
// client over `substrate.read` + `substrate.search`. Wire is fastmcp
// StreamableHTTP (see cli/rpc.ts:mcpCall). The CLI never opens SQLite directly.

import { mcpCall } from "./rpc";

const SCOPES = ["me", "focus", "search", "contracts", "entity", "portfolio", "govern"] as const;
type Scope = (typeof SCOPES)[number];

const usage = (): string =>
  `acc state — thin RPC scopes\n` +
  `  me         Recent events summary (last 20).\n` +
  `  focus      Active directives + ready tasks.\n` +
  `  search "q" Embedding-based retrieval (Phase F: stub returns recent events).\n` +
  `  contracts  Recent directive_opened rows (v2 has no contract analogue yet).\n` +
  `available subcommands: ${SCOPES.join(", ")}`;

const print = (v: unknown): void => console.log(JSON.stringify(v, null, 2));

const callRecent = async (limit: number): Promise<Array<Record<string, unknown>>> => {
  const env = await mcpCall("substrate.search", { query: "recent", opts: { k: limit } });
  if (!env.ok) return [];
  const r = env.result as { hits?: Array<Record<string, unknown>> };
  return r.hits ?? [];
};

const stateMe = async (): Promise<number> => {
  const hits = await callRecent(20);
  if (hits.length === 0) { console.log("acc state me: (no events yet)"); return 0; }
  console.log(`recent events (${hits.length}):`);
  for (const h of hits) {
    const k = h.kind as string;
    const ts = h.ts as string;
    const dir = h.directive_id as string;
    console.log(`  ${ts}  ${k.padEnd(28)}  dir=${dir.slice(0, 12)}…`);
  }
  return 0;
};

const stateFocus = async (): Promise<number> => {
  const env = await mcpCall("substrate.read", { view_name: "focus" });
  if (!env.ok && env.error.startsWith("view_not_implemented")) {
    console.log("acc state focus: view pending (Phase B2/F substrate/views.ts dispatch).");
    return 0;
  }
  print(env);
  return env.ok ? 0 : 1;
};

const stateSearch = async (query: string): Promise<number> => {
  if (!query) { console.error("acc state search: missing query"); return 1; }
  const env = await mcpCall("substrate.search", { query, opts: { k: 10 } });
  print(env);
  return env.ok ? 0 : 1;
};

const stateContracts = async (): Promise<number> => {
  const hits = await callRecent(50);
  const dirs = hits.filter((h) => h.kind === "directive_opened");
  if (dirs.length === 0) { console.log("acc state contracts: no recent directives."); return 0; }
  console.log(`recent directives (${dirs.length}):`);
  for (const d of dirs) {
    const payload = (d.payload ?? {}) as Record<string, unknown>;
    const text = (payload.text as string | undefined) ?? "(no text)";
    console.log(`  ${d.ts}  ${(d.id as string).slice(0, 12)}  ${text.slice(0, 80)}`);
  }
  return 0;
};

const stateEntity = async (id: string): Promise<number> => {
  if (!id) { console.error("acc state entity: missing entity id"); return 1; }
  const env = await mcpCall("substrate.read", { view_name: "entity", args: { id } });
  if (!env.ok && env.error.startsWith("view_not_implemented")) {
    console.log(`acc state entity ${id}: view pending (Phase B2/F).`); return 0;
  }
  print(env);
  return env.ok ? 0 : 1;
};

const statePortfolio = async (): Promise<number> => {
  const env = await mcpCall("substrate.read", { view_name: "portfolio" });
  if (!env.ok && env.error.startsWith("view_not_implemented")) {
    console.log("acc state portfolio: view pending (Phase B2/F)."); return 0;
  }
  print(env);
  return env.ok ? 0 : 1;
};

const stateGovern = async (): Promise<number> => {
  const env = await mcpCall("substrate.read", { view_name: "govern" });
  if (!env.ok && env.error.startsWith("view_not_implemented")) {
    console.log("acc state govern: view pending (Phase B2/F)."); return 0;
  }
  print(env);
  return env.ok ? 0 : 1;
};

const isScope = (s: string): s is Scope => (SCOPES as readonly string[]).includes(s);

/** Programmatic entry — argv is everything AFTER `acc state`. */
export const runState = async (argv: string[]): Promise<number> => {
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(usage()); return 0;
  }
  if (!isScope(sub)) {
    console.error(`acc state: unknown scope '${sub}'`);
    console.error(usage());
    return 1;
  }
  switch (sub) {
    case "me":         return stateMe();
    case "focus":      return stateFocus();
    case "search":     return stateSearch(argv.slice(1).join(" ").trim());
    case "contracts":  return stateContracts();
    case "entity":     return stateEntity(argv[1] ?? "");
    case "portfolio":  return statePortfolio();
    case "govern":     return stateGovern();
  }
};

if (import.meta.main) {
  void runState(process.argv.slice(2)).then((code) => process.exit(code));
}
