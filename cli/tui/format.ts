// Content-rendering helpers for the substrate-content-first TUI.
//
// Brain design D9TBCHADS97DHAMNBC686HE3P0 (2026-05-17): the rebuilt
// TUI MUST never display a bare event_id. Every row is the
// human_summary projected by substrate_narrative_recent_view; this
// module formats that content for a width-bounded terminal.
//
// IDs are demoted to drilldown metadata: the operator presses Enter
// on a row to see the raw payload. Never the other way around.

import type { SubstrateNarrativeRow } from "../../substrate/views";

/** Short relative timestamp ("2s", "12m", "3h", "1d") — operator wants
 *  recency at a glance, not full ISO strings. Falls back to ISO for
 *  rows older than 24h. */
export const formatRelativeTs = (iso: string, nowMs: number = Date.now()): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Math.max(0, nowMs - t);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return iso.slice(0, 10); // YYYY-MM-DD for rows older than a day
};

/** Single-character icon per importance band — drives the row's
 *  visual priority cue without burning column width. */
export const importanceIcon = (importance: SubstrateNarrativeRow["importance"]): string => {
  switch (importance) {
    case "critical": return "!";
    case "high":     return "*";
    case "medium":   return "·";
    case "low":      return " ";
  }
};

/** Ink colour name per importance band. */
export const importanceColor = (importance: SubstrateNarrativeRow["importance"]): string => {
  switch (importance) {
    case "critical": return "red";
    case "high":     return "yellow";
    case "medium":   return "cyan";
    case "low":      return "gray";
  }
};

/** Format one narrative row into a width-bounded line.
 *  Layout: "<rel-ts>  <icon> <kind-short>  <human_summary>"
 *  human_summary takes whatever width remains; kind is truncated to
 *  ~28 chars (long kinds like runtime_self_diagnostic_recorded are
 *  common). */
export const formatNarrativeLine = (row: SubstrateNarrativeRow, width: number, nowMs: number = Date.now()): string => {
  const ts = formatRelativeTs(row.ts, nowMs).padStart(4, " ");
  const icon = importanceIcon(row.importance);
  const kind = row.kind.length > 28 ? row.kind.slice(0, 27) + "…" : row.kind.padEnd(28, " ");
  const summary = row.human_summary ?? `(no content — payload keys: ${Object.keys(row.payload).slice(0, 4).join(",")})`;
  const prefix = `${ts}  ${icon} ${kind}  `;
  const remaining = Math.max(20, width - prefix.length);
  const trimmed = summary.replace(/\s+/g, " ").slice(0, remaining);
  return prefix + trimmed;
};

/** Format the active-task list row (from dispatch_resolved_view). */
export const formatDispatchLine = (row: {
  directive_id: string;
  lifecycle_status?: string;
  status?: string;
  terminal_kind?: string | null;
  residual?: number | null;
  latest_ts?: string;
}, width: number, nowMs: number = Date.now()): string => {
  const ts = formatRelativeTs(row.latest_ts ?? "", nowMs).padStart(4, " ");
  const status = row.lifecycle_status ?? row.status ?? "?";
  const residual = row.residual == null ? "—" : row.residual.toFixed(2);
  // 8-char directive prefix is enough disambiguator; full id available in drilldown.
  const dirShort = row.directive_id.slice(0, 8);
  const prefix = `${ts}  ${status.padEnd(14, " ")}  r=${residual.padStart(4, " ")}  ${dirShort}  `;
  return prefix;
};

/** Pretty-print a payload record for the drilldown overlay. Two-column
 *  view: key right-aligned to a column, value wrapped to remaining
 *  width. Returns an array of lines the caller renders. */
export const formatPayloadLines = (payload: Record<string, unknown>, width: number): string[] => {
  const keyWidth = Math.min(28, Math.max(8, Math.min(28, ...Object.keys(payload).map((k) => k.length + 2))));
  const valWidth = Math.max(20, width - keyWidth - 3);
  const lines: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    const keyCol = (k + ":").padEnd(keyWidth, " ");
    let valStr: string;
    if (v == null) valStr = "(null)";
    else if (typeof v === "string") valStr = v;
    else if (typeof v === "number" || typeof v === "boolean") valStr = String(v);
    else valStr = JSON.stringify(v);
    // Wrap value to valWidth, indent continuation lines so the column stays clean.
    const indent = " ".repeat(keyWidth + 1);
    for (let i = 0; i < valStr.length; i += valWidth) {
      const chunk = valStr.slice(i, i + valWidth);
      lines.push(i === 0 ? `${keyCol} ${chunk}` : `${indent}${chunk}`);
    }
  }
  return lines;
};
