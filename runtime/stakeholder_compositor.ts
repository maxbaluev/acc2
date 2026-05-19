// acc2 stakeholder compositor — Phase I (v2-design.md §3.3, §11 module slot).
//
// Multi-stakeholder directives carry one stakeholder_state_recorded event per
// distinct stakeholder. Each event declares that stakeholder's utility (numeric
// goals like target_salary), inferred constraints (free-text), and information
// visibility (full / limited / blind). Later events on the same
// (directive_id, stakeholder_id) supersede the earlier ones (latest-wins per
// §4.4 concurrency contract).
//
// This module:
//   - Folds the event stream into the current per-stakeholder state
//     (`stakeholderStateView`).
//   - Detects pairwise conflict between stakeholders whose declared_utility
//     fields name overlapping numeric goals with contradicting bounds.
//   - Renders the STAKEHOLDER STATE block for prompt_composer.ts when a
//     directive has ≥ 2 distinct stakeholders.
//   - On conflict, emits a `stakeholder_conflict` event plus an
//     `owner_input_required` so the dispatcher / chat surface can route the
//     adjudication back to the owner — per §19 risk 18, the substrate does NOT
//     silently choose a side.
//
// The view function reads stakeholder_state_recorded events directly so the
// same path runs in tests and production without depending on runViews.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent, type EmitEventInput } from "./events";
import { newId } from "./ids";

export type StakeholderVisibility = "full" | "limited" | "blind";

export type StakeholderEntry = {
  directive_id: string;
  stakeholder_id: string;
  declared_utility: JsonValue;
  inferred_constraints: string[];
  information_visibility: StakeholderVisibility;
  last_updated_ts: string;
};

export type StakeholderConflict = {
  pair: [string, string];
  conflicting_field: string;
  detail: string;
};

const parseJson = <T>(value: unknown): T | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const normaliseVisibility = (raw: unknown): StakeholderVisibility => {
  if (raw === "full" || raw === "limited" || raw === "blind") return raw;
  return "full";
};

/** Fold every stakeholder_state_recorded event for `directiveId` into the
 *  current per-stakeholder state (latest-wins). Reads events directly so the
 *  function reads the events table directly, so it works in tests and
 *  production identically without depending on runViews. */
export const stakeholderStateView = (
  db: Database,
  directiveId: string,
): StakeholderEntry[] => {
  const rows = db
    .query(
      // Phase Audit: order by ts ASC then rowid ASC (insertion order). `id`
      // is not monotonic (newId() is UUID-derived) so two events fired in
      // the same millisecond would tie-break randomly — the rowid is
      // SQLite's append-order surrogate and stays strictly monotonic.
      "SELECT id, ts, payload FROM events WHERE directive_id = ? AND kind = 'stakeholder_state_recorded' ORDER BY ts ASC, rowid ASC",
    )
    .all(directiveId) as Array<{ id: string; ts: string; payload: string }>;

  const byStakeholder = new Map<string, StakeholderEntry>();
  for (const r of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
    } catch {
      continue;
    }
    const stakeholderId = (payload.stakeholder_id as string | undefined) ?? "";
    if (!stakeholderId) continue;
    const constraintsRaw = payload.inferred_constraints;
    const constraints = Array.isArray(constraintsRaw)
      ? (constraintsRaw as unknown[]).map((c) => String(c))
      : [];
    byStakeholder.set(stakeholderId, {
      directive_id: directiveId,
      stakeholder_id: stakeholderId,
      declared_utility: (payload.declared_utility as JsonValue) ?? null,
      inferred_constraints: constraints,
      information_visibility: normaliseVisibility(payload.information_visibility),
      last_updated_ts: r.ts,
    });
  }

  return Array.from(byStakeholder.values()).sort((a, b) =>
    a.stakeholder_id < b.stakeholder_id ? -1 : a.stakeholder_id > b.stakeholder_id ? 1 : 0,
  );
};

const NUMERIC_FIELDS_RE = /^(target|max|min|ceiling|floor|deadline|budget|threshold)/i;

/** Compare two stakeholders' declared_utility maps for numeric-bound conflicts.
 *  Heuristic (no LLM call): when both stakeholders name the same numeric field
 *  AND one's `min_*` exceeds the other's `max_*` (or `target` mismatch by > 20%
 *  of the smaller value), call it a conflict. The conflict packet is the
 *  substrate's way of surfacing the disagreement to the owner — adjudication
 *  is human, per §19 risk 18. */
const findConflicts = (entries: StakeholderEntry[]): StakeholderConflict[] => {
  const conflicts: StakeholderConflict[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      const ua = (a.declared_utility ?? {}) as Record<string, unknown>;
      const ub = (b.declared_utility ?? {}) as Record<string, unknown>;
      if (typeof ua !== "object" || typeof ub !== "object") continue;

      // 1. Same key, different scalar — flag if numeric and differs by > 20%.
      for (const key of Object.keys(ua)) {
        if (!(key in ub)) continue;
        const va = ua[key];
        const vb = ub[key];
        if (typeof va === "number" && typeof vb === "number") {
          if (va === vb) continue;
          const denom = Math.max(1e-9, Math.min(Math.abs(va), Math.abs(vb)));
          const delta = Math.abs(va - vb) / denom;
          if (NUMERIC_FIELDS_RE.test(key) && delta > 0.2) {
            conflicts.push({
              pair: [a.stakeholder_id, b.stakeholder_id],
              conflicting_field: key,
              detail: `${a.stakeholder_id}.${key}=${va} vs ${b.stakeholder_id}.${key}=${vb} (>20% delta)`,
            });
          }
        } else if (typeof va === "string" && typeof vb === "string" && va !== vb) {
          if (NUMERIC_FIELDS_RE.test(key)) {
            conflicts.push({
              pair: [a.stakeholder_id, b.stakeholder_id],
              conflicting_field: key,
              detail: `${a.stakeholder_id}.${key}="${va}" vs ${b.stakeholder_id}.${key}="${vb}"`,
            });
          }
        }
      }

      // 2. Min/max disagreement: one stakeholder's `min_X` exceeds another's `max_X`.
      for (const key of Object.keys(ua)) {
        if (!key.startsWith("min_")) continue;
        const counterKey = "max_" + key.slice(4);
        if (!(counterKey in ub)) continue;
        const minA = ua[key];
        const maxB = ub[counterKey];
        if (typeof minA === "number" && typeof maxB === "number" && minA > maxB) {
          conflicts.push({
            pair: [a.stakeholder_id, b.stakeholder_id],
            conflicting_field: key,
            detail: `${a.stakeholder_id}.${key}=${minA} exceeds ${b.stakeholder_id}.${counterKey}=${maxB}`,
          });
        }
      }
      for (const key of Object.keys(ub)) {
        if (!key.startsWith("min_")) continue;
        const counterKey = "max_" + key.slice(4);
        if (!(counterKey in ua)) continue;
        const minB = ub[key];
        const maxA = ua[counterKey];
        if (typeof minB === "number" && typeof maxA === "number" && minB > maxA) {
          conflicts.push({
            pair: [a.stakeholder_id, b.stakeholder_id],
            conflicting_field: key,
            detail: `${b.stakeholder_id}.${key}=${minB} exceeds ${a.stakeholder_id}.${counterKey}=${maxA}`,
          });
        }
      }
    }
  }
  return conflicts;
};

/** Find every pairwise conflict between the stakeholders attached to one
 *  directive. Returns an empty array when ≤1 stakeholder or no conflict
 *  detected. The chat orchestrator forwards conflicts to the owner via
 *  `owner_input_required`. */
export const detectStakeholderConflicts = (
  db: Database,
  directiveId: string,
): StakeholderConflict[] => {
  const entries = stakeholderStateView(db, directiveId);
  if (entries.length < 2) return [];
  return findConflicts(entries);
};

/** Render the STAKEHOLDER STATE block for prompt_composer.ts (priority P3).
 *  Returns the empty string when the directive has fewer than 2 stakeholders —
 *  prompt_composer keeps a default fallback line in that case. */
export const renderStakeholderBlock = (
  db: Database,
  directiveId: string,
): string => {
  const entries = stakeholderStateView(db, directiveId);
  if (entries.length < 2) return "";
  const lines: string[] = [
    "STAKEHOLDER STATE (latest declared utility per stakeholder; conflicts surfaced separately):",
  ];
  for (const e of entries) {
    const utility = (() => {
      try {
        return JSON.stringify(e.declared_utility);
      } catch {
        return "(unserialisable)";
      }
    })();
    const constraintLine = e.inferred_constraints.length > 0
      ? ` constraints=[${e.inferred_constraints.map((c) => JSON.stringify(c)).join(", ")}]`
      : "";
    lines.push(
      `  [${e.stakeholder_id}] visibility=${e.information_visibility} utility=${utility}${constraintLine}`,
    );
  }
  const conflicts = findConflicts(entries);
  if (conflicts.length > 0) {
    lines.push("  CONFLICTS (require owner adjudication):");
    for (const c of conflicts) {
      lines.push(`    - ${c.pair[0]} vs ${c.pair[1]} on ${c.conflicting_field}: ${c.detail}`);
    }
  }
  return lines.join("\n");
};

/** Emit a stakeholder_conflict event AND an owner_input_required event so the
 *  orchestrator can route the question to the owner via chat. Used by callers
 *  that detect a conflict during DAG composition or post-amendment review.
 *
 *  Phase DAG additions:
 *   - `stakeholder_conflict_detected` — a typed detection event distinct from
 *     the (legacy) `stakeholder_conflict` adjudication event. Downstream
 *     surfaces (TUI, scenario harness) read this to know a conflict was found
 *     in this iteration vs. carried over from history.
 *   - `task_node_opened` for a `stakeholder_consult` review subtask under the
 *     same directive — gives the brain a concrete DAG node to dispatch when
 *     resolving the disagreement instead of relying on owner chat alone.
 */
export const emitStakeholderConflict = (
  db: Database,
  directiveId: string,
  conflict: StakeholderConflict,
  emit: (input: EmitEventInput) => void = (input) => { emitEvent(db, input); },
): void => {
  emit({
    kind: "stakeholder_conflict",
    substrate_origin: "substrate_auto",
    directive_id: directiveId,
    failure_kind: "stakeholder_conflict",
    payload: {
      pair: conflict.pair,
      conflicting_field: conflict.conflicting_field,
      detail: conflict.detail,
    } as JsonValue,
  });
  emit({
    kind: "stakeholder_conflict_detected",
    substrate_origin: "substrate_auto",
    directive_id: directiveId,
    failure_kind: "stakeholder_conflict",
    payload: {
      pair: conflict.pair,
      conflicting_field: conflict.conflicting_field,
      detail: conflict.detail,
      detected_by: "stakeholder_compositor",
    } as JsonValue,
  });
  const consultTaskId = newId();
  emit({
    kind: "task_node_opened",
    substrate_origin: "substrate_auto",
    directive_id: directiveId,
    task_id: consultTaskId,
    parent_task_id: null,
    payload: {
      goal: `stakeholder_consult: resolve ${conflict.pair[0]} ↔ ${conflict.pair[1]} on ${conflict.conflicting_field}`,
      lifecycle: "finite",
      urgency: "elevated",
      task_kind: "stakeholder_consult",
      pair: conflict.pair,
      conflicting_field: conflict.conflicting_field,
    } as JsonValue,
  });
  emit({
    kind: "owner_input_required",
    substrate_origin: "substrate_auto",
    directive_id: directiveId,
    payload: {
      reason: "stakeholder_conflict",
      pair: conflict.pair,
      conflicting_field: conflict.conflicting_field,
      detail: conflict.detail,
      consult_task_id: consultTaskId,
      prompt:
        `Stakeholders ${conflict.pair[0]} and ${conflict.pair[1]} disagree on ` +
        `${conflict.conflicting_field}. ${conflict.detail}. How should this resolve?`,
    } as JsonValue,
  });
};

/** Record a fresh stakeholder_state_recorded event. Convenience entry point
 *  for the MCP tool wrapper. */
export const recordStakeholderState = (
  db: Database,
  input: {
    directive_id: string;
    stakeholder_id: string;
    declared_utility: JsonValue;
    inferred_constraints?: string[];
    information_visibility?: StakeholderVisibility;
  },
): { event_id: string; conflicts: StakeholderConflict[] } => {
  const emitted = emitEvent(db, {
    kind: "stakeholder_state_recorded",
    substrate_origin: "owner",
    directive_id: input.directive_id,
    payload: {
      stakeholder_id: input.stakeholder_id,
      declared_utility: input.declared_utility ?? null,
      inferred_constraints: input.inferred_constraints ?? [],
      information_visibility: input.information_visibility ?? "full",
    } as JsonValue,
  });
  const conflicts = detectStakeholderConflicts(db, input.directive_id);
  for (const c of conflicts) {
    emitStakeholderConflict(db, input.directive_id, c);
  }
  return { event_id: emitted.id, conflicts };
};
