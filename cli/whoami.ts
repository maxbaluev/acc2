import { mcpCall } from "./rpc";
import { type OwnerProfileCard } from "./owner_profile_renderer";

type ViewEnvelope = { ok: true; result: unknown } | { ok: false; error: string };
type OwnerProfileRow = { event_id?: string; ts?: string; payload?: OwnerProfileCard | string; substrate_origin?: string };

export type WhoamiReport = {
  generated_at: string;
  contract: { name: "acc_whoami_profile"; version: 1; sources: string[] };
  source_event_id: string | null;
  source_ts: string | null;
  profile: Required<Pick<OwnerProfileCard, "preferred_terms" | "avoided_terms" | "things_to_never_do" | "hot_topics" | "exposed_concepts" | "declined_concepts">> & {
    detected_language: string | null;
    autonomy_score: number | null;
    autonomy_score_floor: number;
    autonomy_score_with_floor: number;
    rendering_signals: Record<string, number>;
    top_rendering_signals: Array<{ key: string; value: number }>;
    time_window: unknown;
  };
  view_errors: Record<string, string>;
};

const AUTONOMY_FLOOR = 0.4;

const asRows = (env: ViewEnvelope): OwnerProfileRow[] => {
  if (!env.ok || !Array.isArray(env.result)) return [];
  return env.result as OwnerProfileRow[];
};

const parsePayload = (payload: unknown): OwnerProfileCard => {
  if (!payload) return {};
  if (typeof payload === "string") {
    try { return JSON.parse(payload) as OwnerProfileCard; } catch { return {}; }
  }
  return typeof payload === "object" ? payload as OwnerProfileCard : {};
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];

const asSignalMap = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
};

const topSignals = (signals: Record<string, number>): Array<{ key: string; value: number }> =>
  Object.entries(signals).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, value]) => ({ key, value }));

export const buildWhoamiReport = async (): Promise<WhoamiReport> => {
  const generatedAt = new Date().toISOString();
  let env: ViewEnvelope;
  try {
    env = await mcpCall("substrate.read", { view_name: "owner_profile_view" });
  } catch (err) {
    env = { ok: false, error: (err as Error).message };
  }
  const viewErrors: Record<string, string> = {};
  if (!env.ok) viewErrors.owner_profile_view = env.error;
  const row = asRows(env)[0];
  const payload = parsePayload(row?.payload);
  const autonomyScore = typeof payload.autonomy_score === "number" && Number.isFinite(payload.autonomy_score) ? payload.autonomy_score : null;
  const floor = typeof payload.autonomy_score_floor === "number" && Number.isFinite(payload.autonomy_score_floor) ? payload.autonomy_score_floor : AUTONOMY_FLOOR;
  const renderingSignals = asSignalMap(payload.rendering_signals);
  return {
    generated_at: generatedAt,
    contract: { name: "acc_whoami_profile", version: 1, sources: ["owner_profile_view"] },
    source_event_id: row?.event_id ?? null,
    source_ts: row?.ts ?? null,
    profile: {
      detected_language: typeof payload.detected_language === "string" ? payload.detected_language : null,
      autonomy_score: autonomyScore,
      autonomy_score_floor: floor,
      autonomy_score_with_floor: Math.max(autonomyScore ?? floor, floor),
      rendering_signals: renderingSignals,
      top_rendering_signals: topSignals(renderingSignals),
      preferred_terms: asStringArray(payload.preferred_terms),
      avoided_terms: asStringArray(payload.avoided_terms),
      things_to_never_do: asStringArray(payload.things_to_never_do),
      hot_topics: asStringArray(payload.hot_topics),
      time_window: payload.time_window ?? null,
      exposed_concepts: asStringArray(payload.exposed_concepts),
      declined_concepts: asStringArray(payload.declined_concepts),
    },
    view_errors: viewErrors,
  };
};

const fmt = (value: number | null | undefined): string => typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "unset";
const list = (values: string[]): string => values.length > 0 ? values.join(", ") : "none";
const signals = (values: Array<{ key: string; value: number }>): string => values.length > 0 ? values.map((s) => s.key + "=" + s.value.toFixed(2)).join(", ") : "none";

export const renderWhoamiReport = (report: WhoamiReport): string => {
  const profile = report.profile;
  const rows = [
    "acc whoami - owner profile @ " + report.generated_at,
    "source=" + (report.source_event_id ?? "fresh_substrate_default") + " ts=" + (report.source_ts ?? "unset"),
    "detected_language=" + (profile.detected_language ?? "unset"),
    "autonomy_score=" + fmt(profile.autonomy_score) + " floor=" + fmt(profile.autonomy_score_floor) + " with_floor=" + fmt(profile.autonomy_score_with_floor),
    "rendering_signals=" + signals(profile.top_rendering_signals),
    "preferred_terms=" + list(profile.preferred_terms),
    "avoided_terms=" + list(profile.avoided_terms),
    "things_to_never_do=" + list(profile.things_to_never_do),
    "hot_topics=" + list(profile.hot_topics),
    "time_window=" + (profile.time_window == null ? "unset" : JSON.stringify(profile.time_window)),
    "exposed_concepts=" + list(profile.exposed_concepts),
    "declined_concepts=" + list(profile.declined_concepts),
  ];
  if (Object.keys(report.view_errors).length > 0) {
    rows.push("view_errors=" + Object.entries(report.view_errors).map(([name, error]) => name + ":" + error).join(", "));
  }
  return rows.join("\n") + "\n";
};

export const runWhoami = async (argv: string[]): Promise<number> => {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("usage: acc whoami [--json]\n\nInspect the owner_profile_view card used by the future Ink TUI.\n");
    return 0;
  }
  const report = await buildWhoamiReport();
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(renderWhoamiReport(report));
  return 0;
};
