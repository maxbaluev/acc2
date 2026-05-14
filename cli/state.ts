// `acc state {me,directives,tasks,focus,search,artifacts,knowledge,recipes,daemon}` —
// thin MCP client over `substrate.read` + `substrate.search`. Wire is fastmcp
// StreamableHTTP (see cli/rpc.ts:mcpCall). The CLI never opens SQLite directly.
//
// Per v2-design.md §21, the v2 unit of work is the directive + its DAG of tasks;
// the v1 'contracts' surface is dropped (§22 + Appendix A.1).

import { mcpCall, auxBaseUrl, rpcGet } from "./rpc";

const SCOPES = [
  "me",
  "directives",
  "tasks",
  "focus",
  "search",
  "artifacts",
  "knowledge",
  "recipes",
  "daemon",
] as const;
type Scope = (typeof SCOPES)[number];

const usage = (): string =>
  `acc state — thin RPC scopes\n` +
  `  me          Recent events summary (last 20).\n` +
  `  directives  Recent directive_opened rows (the v2 unit of work).\n` +
  `  tasks       Ready + in-progress DAG nodes (task_node_opened).\n` +
  `  focus       Current active directives + ready tasks.\n` +
  `  search "q"  Embedding-reranked retrieval (Phase F: stub returns recent events).\n` +
  `  artifacts   Code artifact registry (admitted + promoted).\n` +
  `  knowledge   Promoted knowledge entries.\n` +
  `  recipes     Tier-0 recipes available for replay.\n` +
  `  daemon      Daemon health, uptime, event counts.\n` +
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
    const dir = (h.directive_id as string | null) ?? "";
    console.log(`  ${ts}  ${k.padEnd(28)}  dir=${dir.slice(0, 12)}…`);
  }
  return 0;
};

const stateDirectives = async (): Promise<number> => {
  const hits = await callRecent(50);
  const dirs = hits.filter((h) => h.kind === "directive_opened");
  if (dirs.length === 0) { console.log("acc state directives: no recent directives."); return 0; }
  console.log(`recent directives (${dirs.length}):`);
  for (const d of dirs) {
    const payload = (d.payload ?? {}) as Record<string, unknown>;
    const text = (payload.text as string | undefined) ?? "(no text)";
    console.log(`  ${d.ts}  ${(d.id as string).slice(0, 12)}  ${text.slice(0, 80)}`);
  }
  return 0;
};

const stateTasks = async (): Promise<number> => {
  const env = await mcpCall("substrate.read", { view_name: "ready_tasks_view" });
  if (!env.ok && env.error.startsWith("view_not_implemented")) {
    console.log("acc state tasks: ready_tasks_view dispatch pending (substrate wired Phase B2; CLI dispatch TODO).");
    return 0;
  }
  print(env);
  return env.ok ? 0 : 1;
};

const stateFocus = async (): Promise<number> => {
  const env = await mcpCall("substrate.read", { view_name: "task_graph_view" });
  if (!env.ok && env.error.startsWith("view_not_implemented")) {
    console.log("acc state focus: task_graph_view dispatch pending.");
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

const stateArtifacts = async (): Promise<number> => {
  const env = await mcpCall("substrate.read", { view_name: "code_artifact_registry_view" });
  if (!env.ok && env.error.startsWith("view_not_implemented")) {
    console.log("acc state artifacts: code_artifact_registry_view dispatch pending.");
    return 0;
  }
  print(env);
  return env.ok ? 0 : 1;
};

const stateKnowledge = async (): Promise<number> => {
  const hits = await callRecent(100);
  const promoted = hits.filter((h) => h.kind === "knowledge_promoted");
  if (promoted.length === 0) { console.log("acc state knowledge: no promoted knowledge yet."); return 0; }
  console.log(`promoted knowledge (${promoted.length}):`);
  for (const k of promoted) {
    const payload = (k.payload ?? {}) as Record<string, unknown>;
    const text = (payload.text as string | undefined) ?? "(no text)";
    console.log(`  ${k.ts}  ${text.slice(0, 100)}`);
  }
  return 0;
};

const stateRecipes = async (): Promise<number> => {
  const hits = await callRecent(100);
  const recipes = hits.filter((h) => h.kind === "recipe_extracted");
  if (recipes.length === 0) { console.log("acc state recipes: no Tier-0 recipes extracted yet."); return 0; }
  console.log(`recipes (${recipes.length}):`);
  for (const r of recipes) {
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    const goalShape = (payload.goal_shape as string | undefined) ?? "?";
    const confidence = (payload.confidence as number | undefined) ?? 0;
    console.log(`  ${r.ts}  shape=${goalShape.slice(0, 16)}  confidence=${confidence.toFixed(2)}`);
  }
  return 0;
};

const stateDaemon = async (): Promise<number> => {
  const base = auxBaseUrl();
  if (!base) { console.log("acc state daemon: daemon not running"); return 1; }
  const health = await rpcGet<Record<string, unknown>>(`${base}/health`);
  console.log(JSON.stringify(health, null, 2));
  return 0;
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
    case "directives": return stateDirectives();
    case "tasks":      return stateTasks();
    case "focus":      return stateFocus();
    case "search":     return stateSearch(argv.slice(1).join(" ").trim());
    case "artifacts":  return stateArtifacts();
    case "knowledge":  return stateKnowledge();
    case "recipes":    return stateRecipes();
    case "daemon":     return stateDaemon();
  }
};

if (import.meta.main) {
  void runState(process.argv.slice(2)).then((code) => process.exit(code));
}
