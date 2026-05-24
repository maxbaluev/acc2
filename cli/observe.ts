#!/usr/bin/env bun
// `acc events` / `acc tail` / `acc graph` / `acc inspect` — operator-side
// observability surface. Replaces the inline `bun -e 'import {…}…'`
// FastMCP-client boilerplate every diagnostic session used to need.
//
// Read-only subcommands use the daemon's session-free auxiliary HTTP read
// endpoints, not FastMCP. Writes stay on the substrate write path so
// multi-process safety, schema migration, and embedding-index hygiene remain
// the daemon's problem, not the CLI's.
//
// Output shape: one event per line, formatter pinned per-kind so a downstream
// consumer (Claude Code background-task stream, log aggregator, grep) can
// parse the structured prefix. Format:
//   <ts> <kind-glyph> <task-id-or-->  <key=val key=val …>
//
// `acc task --follow` reuses `tailEvents` to stream brain progress as
// Claude-native background-task stdout: every emit becomes a notification.

import { auxRead, auxRecentEvents, sseConnect } from "./rpc";
import { EVENT_KINDS, MIRROR_INLINE_EVENT_TYPES } from "../substrate/event_kinds";

// ── panel-friendly format invariants ───────────────────────────────
//
// The Claude Code background_tasks shell-details panel shows the last ~5
// lines of stdout. During the first ~minute of an `acc task` dispatch the
// brain hasn't emitted anything yet, so the panel was eaten by the long
// directive_opened prompt echo. Three load-bearing constants now govern
// the panel UX:
//
//  - MAX_EVENT_LINE_CHARS — every narrative renderer collapses to ONE line
//    ≤120 chars. Tail any multi-line payload to `→ id=<event_short>` so
//    `--verbose` / `acc inspect <id>` can pull the full detail.
//  - FOLLOW_HEARTBEAT_MS — heartbeat cadence (5s). Fires while no new
//    narrative event has arrived for ≥5s.
//  - FOLLOW_HEARTBEAT_WINDOW_MS — drop the heartbeat after this much idle
//    time (60s). After a minute of silence the brain is likely wedged; the
//    operator should switch to `acc events --verbose` or `acc doctor`.
//
// Crucially, the heartbeat clock starts at DISPATCH START — not at the
// first event — so the trailing-5-line window has brain-progress signal
// during the pre-event window. That is the structural fix for the
// "panel shows stale prompt echo for the entire first minute" bug.
export const MAX_EVENT_LINE_CHARS = 120;
// 2026-05-19: heartbeat lines removed entirely. The SSE event push is
// already real-time AND the transport carries `: keepalive\n\n` comments
// every 15s, so the "system is alive" signal is at the transport layer,
// not the synthetic line layer. Pre-fix the 5s heartbeat lines crowded
// the panel and created a "waiting" feel even when real events were
// arriving every ~500ms. Constants kept (= 0) so any caller that still
// reads them by name gets a no-op cadence; the heartbeatEnabled flag in
// runTailStream short-circuits emission unconditionally.
export const FOLLOW_HEARTBEAT_MS = 0;
export const FOLLOW_HEARTBEAT_WINDOW_MS = 0;

// ── one-line formatter per event kind ──────────────────────────────

type EventLike = {
  id?: string;
  event_id?: string;  // runtime.recent_events returns `event_id` (the canonical row id renamed at the API edge); we accept both.
  ts?: string;
  kind?: string;
  directive_id?: string;
  task_id?: string;
  substrate_origin?: string;
  failure_kind?: string | null;
  payload?: unknown;
};

const eventId = (e: EventLike): string | undefined => e.event_id ?? e.id;

const TERMINAL_KINDS = new Set([
  "task_committed", "task_failed", "dispatcher_violation",
]);

const FRAME_KINDS = new Set([
  "bridge_frame_received",
]);

/** Strategic-narrative event kinds — the ones an operator needs to
 *  understand WHAT the brain is doing, not HOW the substrate is running it.
 *  `acc tail` defaults to this filter so the chat doesn't drown in
 *  bridge_frame_received / runtime_subprocess_started / embedding_computed
 *  chatter. `--verbose` opts out and shows every kind.
 *
 *  Inclusion rule: changes the operator's MODEL of progress. If two reads
 *  ten minutes apart would look identical without this kind, suppress it.
 *  Anything substrate-internal (admission, scoring, score-update, embedding,
 *  Father heartbeats, daemon lifecycle, candidate confirm/contradict, sub-
 *  process spawn lifecycle, gate-decision audit rows, prompt budget) is
 *  noise from the operator's perspective. Bridge handshake / frames /
 *  subprocess detail are diagnostic surfaces, not narrative.
 *
 *  Derived from the canonical EVENT_KINDS registry's `narrative: true` flag
 *  so the operator-stream filter cannot drift from the kind registry. To
 *  add a kind to the narrative surface, set `narrative: true` on its entry
 *  in `substrate/event_kinds.ts` — there is no parallel hand-maintained
 *  list to update. */
export const NARRATIVE_KINDS = new Set(
  Object.entries(EVENT_KINDS).filter(([, meta]) => meta.narrative).map(([kind]) => kind),
);

const trunc = (s: string | undefined, n: number): string => {
  if (s === undefined || s === null) return "";
  // Defensive coerce — brain payloads occasionally carry non-string values
  // (objects, numbers) under keys we expect strings on (e.g. structured
  // knowledge_candidate.claim). Without this guard `.replace` blows up the
  // entire follow tail mid-stream.
  const raw = typeof s === "string" ? s : JSON.stringify(s);
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};

const idPrefix = (id: string | undefined, n = 8): string => {
  if (!id) return "—";
  return id.length > n ? id.slice(0, n) : id;
};

const parsePayload = (p: unknown): Record<string, unknown> => {
  if (!p) return {};
  if (typeof p === "string") {
    try { return JSON.parse(p) as Record<string, unknown>; } catch { return {}; }
  }
  if (typeof p === "object") return p as Record<string, unknown>;
  return {};
};

/** Kind → short glyph for visual scanning. */
const GLYPHS: Record<string, string> = {
  directive_opened: "📨",
  directive_amended: "✎",
  task_node_opened: "▸",
  task_edge_recorded: "→",
  brain_dispatched: "🧠↑",
  brain_dispatch_closed: "🧠↓",
  bridge_invoked: "B↑",
  bridge_mcp_connected: "🤝",
  bridge_frame_received: "·",
  bridge_completed: "B✓",
  bridge_failed: "B✗",
  bridge_stuck: "B⏸",
  action_predicted: "⚡",
  artifact_invoked: "▶",
  artifact_observed: "👁",
  runtime_subprocess_started: "+",
  runtime_subprocess_completed: "✓",
  runtime_subprocess_soft_terminated: "⊘",
  runtime_subprocess_hard_killed: "✗",
  action_scored: "Σ",
  task_committed: "✅",
  task_failed: "❌",
  dispatcher_violation: "⚠️",
  knowledge_candidate: "📚",
  knowledge_promoted: "📚+",
  candidate_confirmed: "📚✓",
  candidate_contradicted: "📚✗",
  // recipe-shape knowledge rows render through the knowledge_candidate /
  // knowledge_promoted icons; recipe_shape.enabled distinguishes them in
  // the detailed render case below.
  act_artifact_admitted: "📦+",
  act_artifact_promoted: "📦⬆",
  act_artifact_admission_rejected: "📦✗",
  embedding_computed: "Ε",
  external_event_received: "🌐",
  daemon_started: "🟢",
  daemon_ready: "🟢✓",
  daemon_index_rebuilt: "Ι",
  daemon_stopped: "🔴",
  father_cycle_recorded: "👤",
  father_drift_detected: "👤⚠",
  task_deferred_for_interference: "⏸",
  constitutional_gate_decision: "⚖",
  prompt_truncated: "✂",
  integrity_check_completed: "🩺",
  sandbox_unenforced_warning: "🛡⚠",
  task_closure_audited: "🎓",
  lesson_extracted: "💡",
  contract_amendment_proposed: "📝",
  pre_apply_adjudication_recorded: "⚖?",
  lesson_apply_requested: "Δ?",
  applied_change_committed: "Δ✓",
  // Brain convergence axis D (2026-05-15): brain observability glyphs.
  // NOT added to NARRATIVE_KINDS — too chatty for the default surface;
  // visible via `acc events --kind brain_message_emitted` or `--verbose`.
  brain_prompt_composed: "🧠📝",
  brain_message_emitted: "🧠💬",
  brain_reasoning_recorded: "🧠💭",
  // Pathology budget (axis B/H): debits + exhausted.
  pathology_budget_debited: "⚠️-",
  pathology_budget_exhausted: "⚠️✗",
  // Hot-reload telemetry.
  daemon_hotreload_triggered: "♻︎↑",
  daemon_hotreload_completed: "♻︎✓",
  daemon_hotreload_failed: "♻︎✗",
  // Hot-reload deep-improvement (2026-05-17): truth-in-audit kinds —
  // swapped = the reloadable registry accepted the new module and
  // every consumer reading through getReloadable(...).current() now
  // sees the new code; no_op = import succeeded but no consumer reads
  // through an indirection (live behavior unchanged); rejected =
  // validation refused the new module (missing exports or smoke
  // probe failed) — previous reference stays active; unmapped =
  // changed file under a watched directory matched no manifest entry;
  // rate_limited = save-loop storm protection kicked in.
  daemon_hotreload_swapped: "♻︎⇆",
  daemon_hotreload_no_op: "♻︎○",
  daemon_hotreload_rejected: "♻︎⊘",
  daemon_hotreload_unmapped: "♻︎?",
  daemon_hotreload_rate_limited: "♻︎⏸",
  // Restart-pending = normal state (operator runs `acc daemon restart`
  // when convenient); not a failure. Distinct emoji + own renderer
  // below so the tail surface stops conflating "needs restart" with
  // "fault".
  daemon_hotreload_restart_pending: "♻︎↻",
  // δ-mem follow-up (2026-05-17): substrate emit-time dedup refused
  // a knowledge_candidate as near-duplicate of a recent prior. Brain
  // sees the refusal in tail.
  knowledge_candidate_redundant: "📚⊘",
  // Prompt cache telemetry.
  prompt_composition_cache_hit: "💾✓",
  prompt_composition_cache_miss: "💾·",
  // Worker tick liveness.
  worker_tick_completed: "·",
  lesson_applied: "💡✓",
  contract_amendment_applied: "📝✓",
  hidl_action_required: "🔐",
  owner_profile_recorded: "👤✓",
  auto_apply_signaled: "Δ!",
  applied_change_failed: "Δ✗",
};

const formatPayload = (kind: string, p: Record<string, unknown>): string => {
  // Per-kind structured rendering. Returns a "key=value key=value" suffix.
  switch (kind) {
    case "directive_opened": {
      const lifecycle = p.lifecycle as string | undefined;
      const urgency = p.urgency as string | undefined;
      return [
        "opened",
        lifecycle ? `lifecycle=${lifecycle}` : "",
        urgency && urgency !== "normal" ? `urgency=${urgency}` : "",
      ].filter(Boolean).join(" ");
    }
    case "task_node_opened": {
      const goal = p.goal as string | undefined;
      const rank = p.rank;
      const urgency = p.urgency as string | undefined;
      return [
        rank !== undefined ? `rank=${rank}` : "",
        urgency && urgency !== "normal" ? `urgency=${urgency}` : "",
        goal ? `goal=${JSON.stringify(trunc(goal, 56))}` : "",
      ].filter(Boolean).join(" ");
    }
    case "task_edge_recorded": {
      const edgeKind = (p.kind as string) ?? "?";
      const from = idPrefix((p.from_task as string) ?? (p.from as string), 16);
      const to = idPrefix((p.to_task as string) ?? (p.to as string), 16);
      return `kind=${edgeKind} ${from}→${to}`;
    }
    case "bridge_mcp_connected": {
      const tool = p.first_tool as string | undefined;
      return tool ? `first_tool=${tool}` : "";
    }
    case "bridge_failed": {
      const reason = (p.reason as string) ?? "?";
      const hint = p.hint as string | undefined;
      return `reason=${reason}${hint ? ` hint=${JSON.stringify(trunc(hint, 80))}` : ""}`;
    }
    case "bridge_stuck": {
      const reason = (p.reason as string) ?? "?";
      const elapsed = p.elapsed_ms as number | undefined;
      return `reason=${reason}${elapsed ? ` elapsed_ms=${elapsed}` : ""}`;
    }
    case "action_predicted": {
      const action = idPrefix(p.action_artifact_id as string, 12);
      const verifier = idPrefix(p.verifier_artifact_id as string, 12);
      const residual = p.predicted_residual;
      const intent = p.intent as string | undefined;
      return [
        `action=${action} verifier=${verifier}`,
        residual !== undefined ? `predicted_residual=${residual}` : "",
        intent ? `intent=${JSON.stringify(trunc(intent, 42))}` : "",
      ].filter(Boolean).join(" ");
    }
    case "artifact_invoked":
    case "artifact_observed":
      return `artifact=${idPrefix(p.artifact_id as string, 12)}${p.runtime ? ` runtime=${p.runtime}` : ""}`;
    case "action_scored": {
      const residual = p.residual ?? p.observed_residual;
      return `residual=${residual}`;
    }
    case "task_committed": {
      const ec = p.events_count;
      return ec !== undefined ? `events_count=${ec}` : "";
    }
    case "task_failed":
    case "dispatcher_violation": {
      const ownerSummary = p.owner_summary as string | undefined;
      const suggested = p.suggested_action as string | undefined;
      if (ownerSummary) {
        return `${trunc(ownerSummary, 120)}${suggested ? ` → ${trunc(suggested, 80)}` : ""}`;
      }
      const reason = (p.reason as string) ?? "?";
      return `reason=${reason}`;
    }
    case "knowledge_candidate":
    case "knowledge_promoted": {
      const claim = (p.claim as string) ?? (p.text as string) ?? "";
      const score = p.score;
      const learnedFromOwner = p.learned_from_owner as string | undefined;
      const ownerTag = learnedFromOwner ? ` ← owner: ${JSON.stringify(trunc(learnedFromOwner, 80))}` : "";
      return `${claim ? `claim=${JSON.stringify(trunc(claim, 54))}` : ""}${score !== undefined ? ` score=${score}` : ""}${ownerTag}`.trim();
    }
    // recipe-shape knowledge absorbed into knowledge_candidate / knowledge_promoted
    // carrying payload.recipe_shape.enabled; render is handled inline by
    // the knowledge_* cases above.
    case "act_artifact_admitted": {
      const runtime = (p.runtime as string) ?? "?";
      const intent = (p.intent as string) ?? (p.slug as string) ?? "";
      return `runtime=${runtime}${intent ? ` intent=${JSON.stringify(trunc(intent, 80))}` : ""}`;
    }
    case "father_cycle_recorded": {
      const action = (p.action as string) ?? "?";
      const detail = p.detail as Record<string, unknown> | undefined;
      const directive = idPrefix(detail?.directive_id as string, 16);
      return `action=${action}${directive !== "—" ? ` directive=${directive}` : ""}`;
    }
    case "constitutional_gate_decision": {
      const gate = (p.gate as string) ?? "?";
      const reason = p.reason as string | undefined;
      return `gate=${gate}${reason ? ` reason=${trunc(reason, 60)}` : ""}`;
    }
    case "sandbox_unenforced_warning": {
      const runtime = p.runtime as string | undefined;
      const warning = (p.warning as string) ?? "";
      return `${runtime ? `runtime=${runtime} ` : ""}${trunc(warning, 100)}`;
    }
    case "task_closure_audited": {
      // Defensive render: closure_residual may be missing (the emitter
      // skipped it) — surface that explicitly instead of leaking
      // "undefined" through the template. The substrate-side normalizer
      // in runtime/events.ts injects a classification_source marker
      // when this happens so audit trails still capture the provenance.
      const residualRaw = p.closure_residual;
      const residual = typeof residualRaw === "number" && Number.isFinite(residualRaw)
        ? residualRaw.toFixed(2)
        : "<unset>";
      // T0.1 (brain dispatch TFZ6AJXNPS6655QMFWT6KPB3QM): augmented
      // payload shape now carries `brain_claims` + `substrate_verifications`.
      // Substrate-truth gate wins — show claims=N/M (brain advisory) vs
      // verified=K/M (substrate truth) + discrepancies count. Renderer
      // branches on presence of substrate_verifications so legacy rows
      // without the field still hit the checks=/covered= paths below.
      const substrateVerifications = p.substrate_verifications as
        | Record<string, { verified?: unknown }>
        | undefined;
      const brainClaims = p.brain_claims as Record<string, unknown> | undefined;
      if (substrateVerifications && typeof substrateVerifications === "object") {
        const claimEntries = brainClaims && typeof brainClaims === "object"
          ? Object.values(brainClaims)
          : [];
        const verifyEntries = Object.values(substrateVerifications);
        const totalClaims = claimEntries.length;
        const passedClaims = claimEntries.filter((v) => v === true).length;
        const totalVerified = verifyEntries.length;
        const passedVerified = verifyEntries.filter(
          (v) => v && typeof v === "object" && (v as { verified?: unknown }).verified === true,
        ).length;
        const discrepancyCount = Array.isArray(p.discrepancies)
          ? (p.discrepancies as unknown[]).length
          : 0;
        return `closure_residual=${residual} claims=${passedClaims}/${totalClaims} verified=${passedVerified}/${totalVerified} discrepancies=${discrepancyCount}`;
      }
      // Live payload shape is { checks: Record<string, boolean>, breakdown: Record<string, number> }.
      const checks = p.checks as Record<string, unknown> | undefined;
      if (checks && typeof checks === "object") {
        const entries = Object.values(checks);
        const total = entries.length;
        const passed = entries.filter((v) => v === true).length;
        const failed = total - passed;
        return `closure_residual=${residual} checks=${passed}/${total}${failed > 0 ? ` failed=${failed}` : ""}`;
      }
      const breakdown = p.breakdown as Record<string, number> | undefined;
      if (breakdown && typeof breakdown === "object") {
        const axes = Object.keys(breakdown).length;
        const top = Object.entries(breakdown)
          .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
          .sort((a, b) => (b[1] as number) - (a[1] as number))
          .slice(0, 3)
          .map(([k, v]) => `${k}:${(v as number).toFixed(2)}`)
          .join(",");
        const verifierKind = typeof p.verifier_kind === "string" ? p.verifier_kind : undefined;
        return `closure_residual=${residual} axes=${axes}${top ? ` top=${top}` : ""}${verifierKind ? ` verifier=${verifierKind}` : ""}`;
      }
      return `closure_residual=${residual} summary-only (no structured checks/verifications)`;
    }
    case "hidl_action_required": {
      const reason = (p.reason as string) ?? "owner action required";
      const summary = p.summary as string | undefined;
      const action = p.suggested_action as string | undefined;
      return `reason=${reason}${summary ? ` summary=${JSON.stringify(trunc(summary, 80))}` : ""}${action ? ` action=${JSON.stringify(trunc(action, 80))}` : ""}`;
    }
    case "owner_profile_recorded": {
      const lang = p.detected_language as string | undefined;
      const score = typeof p.autonomy_score === "number" ? p.autonomy_score : undefined;
      const sigs = p.rendering_signals as Record<string, number> | undefined;
      const sigSummary = sigs && Object.keys(sigs).length > 0
        ? `signals=${Object.entries(sigs).map(([k, v]) => `${k}:${(v as number).toFixed(2)}`).join(",")}`
        : "";
      return [
        lang ? `language=${lang}` : "",
        score !== undefined ? `autonomy_score=${score.toFixed(2)}` : "",
        sigSummary,
      ].filter(Boolean).join(" ");
    }
    case "auto_apply_signaled": {
      const src = p.source_event_id as string | undefined;
      const target = p.target as string | undefined;
      const next = p.next_action as string | undefined;
      return `${src ? `source=${idPrefix(src, 12)} ` : ""}${target ? `target=${target} ` : ""}${next ? `next=${JSON.stringify(trunc(next, 100))}` : ""}`.trim();
    }
    case "applied_change_failed": {
      const src = p.source_event_id as string | undefined;
      const target = p.target as string | undefined;
      const reason = (p.reason as string) ?? "unknown";
      return `${src ? `source=${idPrefix(src, 12)} ` : ""}${target ? `target=${target} ` : ""}reason=${JSON.stringify(trunc(reason, 80))}`.trim();
    }
    case "lesson_extracted": {
      // When lesson_kind is missing the substrate emit-boundary
      // normalizer (runtime/events.ts normalizeLessonExtractedPayload)
      // injects a classification_source marker. Surface that here
      // instead of the meaningless "?" so the operator knows the
      // emitter didn't classify (vs. the kind being unknown).
      const kind = p.lesson_kind as string | undefined;
      const classification = (p.classification_source as { basis?: string } | undefined);
      const summary = p.summary as string | undefined;
      const kindLabel = kind ?? (classification?.basis ? `<unclassified:${classification.basis}>` : "<unclassified>");
      return `lesson_kind=${kindLabel} ${summary ? `summary=${JSON.stringify(trunc(summary, 54))}` : ""}`;
    }
    case "pre_apply_adjudication_recorded": {
      const verdict = (p.verdict as string) ?? "?";
      const target = p.target_event_id as string | undefined;
      const authority = p.owner_authority_level as string | undefined;
      return `verdict=${verdict}${target ? ` target=${idPrefix(target, 12)}` : ""}${authority ? ` authority=${authority}` : ""}`;
    }
    case "contract_amendment_proposed": {
      // Canonical target grammar (v2): exactly ONE of `target_resource` (single
      // URI), `target_resources` (array), or `resource_uri` (single URI).
      // No legacy `target` / `file_path` fallback — clean break per the v2
      // operating contract ("No legacy/fallback/backward-compatibility code").
      const target = (p.target_resource as string | undefined)
        ?? (p.resource_uri as string | undefined)
        ?? (Array.isArray(p.target_resources) ? (p.target_resources as string[]).join(",") : undefined);
      const anchor = p.anchor as string | undefined;
      const proposed = (p.proposed_behavior as string) ?? (p.summary as string) ?? "";
      return `target=${target ?? "?"}${anchor ? ` anchor=${JSON.stringify(trunc(anchor, 60))}` : ""}${proposed ? ` → ${JSON.stringify(trunc(proposed, 100))}` : ""}`;
    }
    case "lesson_apply_requested": {
      const src = p.source_event_id as string | undefined;
      const status = (p.status as string) ?? "requested";
      return `${src ? `source=${idPrefix(src, 12)} ` : ""}status=${status}`;
    }
    case "applied_change_committed": {
      const src = p.source_event_id as string | undefined;
      const status = (p.status as string) ?? "applied";
      const commit = p.commit_sha as string | undefined;
      const residual = typeof p.residual === "number" ? p.residual : undefined;
      const subagentId = p.subagent_task_id as string | undefined;
      const summary = p.summary as string | undefined;
      return [
        status !== "applied" ? `status=${status}` : "applied",
        src ? `source=${idPrefix(src, 12)}` : "",
        commit ? `commit=${commit.slice(0, 10)}` : "",
        residual !== undefined ? `residual=${residual}` : "",
        subagentId ? `subagent=${idPrefix(subagentId, 10)}` : "",
        summary ? `summary=${JSON.stringify(trunc(summary, 100))}` : "",
      ].filter(Boolean).join(" ");
    }
    // Hot-reload deep-improvement (2026-05-17): every truth-in-audit
    // kind gets a renderer so operators see WHAT happened, not just an
    // emoji. module + outcome + reason fit one panel-friendly line.
    case "daemon_hotreload_triggered": {
      const mod = p.module as string | undefined;
      const fp = p.file_path as string | undefined;
      const strategy = p.strategy as string | undefined;
      const slot = p.reloadable_slot as string | null | undefined;
      return [
        mod ? `module=${mod}` : "",
        strategy ? `strategy=${strategy}` : "",
        slot ? `slot=${slot}` : "slot=(none)",
        fp ? `file=${fp}` : "",
      ].filter(Boolean).join(" ");
    }
    case "daemon_hotreload_swapped": {
      const mod = p.module as string | undefined;
      const slot = p.reloadable_slot as string | undefined;
      const version = p.registry_version as number | undefined;
      const caches = p.invalidated_caches as string[] | undefined;
      return [
        "swapped",
        mod ? `module=${mod}` : "",
        slot ? `slot=${slot}` : "",
        typeof version === "number" ? `version=${version}` : "",
        caches && caches.length > 0 ? `invalidated=${caches.join(",")}` : "",
      ].filter(Boolean).join(" ");
    }
    case "daemon_hotreload_no_op": {
      const mod = p.module as string | undefined;
      const reason = p.reason as string | undefined;
      return [
        "no_op",
        mod ? `module=${mod}` : "",
        reason ? `reason=${reason}` : "",
      ].filter(Boolean).join(" ");
    }
    case "daemon_hotreload_rejected": {
      const mod = p.module as string | undefined;
      const reason = p.reason as string | undefined;
      const expected = p.expected_exports as string[] | undefined;
      return [
        "rejected",
        mod ? `module=${mod}` : "",
        reason ? `reason=${JSON.stringify(trunc(reason, 100))}` : "",
        expected && expected.length > 0 ? `expected=${expected.join(",")}` : "",
      ].filter(Boolean).join(" ");
    }
    case "daemon_hotreload_unmapped": {
      const fp = p.file_path as string | undefined;
      return [
        "unmapped",
        fp ? `file=${fp}` : "",
        "hint=extend HOTRELOAD_MANIFEST",
      ].filter(Boolean).join(" ");
    }
    case "daemon_hotreload_rate_limited": {
      const mod = p.module as string | undefined;
      const rl = p.rate_limit as { count?: number; window_ms?: number } | undefined;
      return [
        "rate_limited",
        mod ? `module=${mod}` : "",
        rl ? `cap=${rl.count}/${rl.window_ms}ms` : "",
      ].filter(Boolean).join(" ");
    }
    case "daemon_hotreload_failed": {
      const mod = p.module as string | undefined;
      const reason = p.reason as string | undefined;
      const strategy = p.strategy as string | undefined;
      return [
        "failed",
        mod ? `module=${mod}` : "",
        strategy ? `strategy=${strategy}` : "",
        reason ? `reason=${JSON.stringify(trunc(reason, 100))}` : "",
      ].filter(Boolean).join(" ");
    }
    case "daemon_hotreload_restart_pending": {
      const mod = p.module as string | undefined;
      const fp = p.file_path as string | undefined;
      return [
        "restart_pending",
        mod ? `module=${mod}` : "",
        fp ? `file=${fp}` : "",
        "hint=run `acc daemon restart` when convenient",
      ].filter(Boolean).join(" ");
    }
    case "knowledge_candidate_redundant": {
      const matched = p.matched_event_id as string | undefined;
      const sim = p.similarity as number | undefined;
      const author = p.refused_author as string | undefined;
      const preview = p.refused_claim_preview as string | undefined;
      return [
        "refused",
        author ? `author=${author}` : "",
        matched ? `matched=${matched.slice(0, 12)}` : "",
        typeof sim === "number" ? `sim=${sim.toFixed(2)}` : "",
        preview ? `claim=${JSON.stringify(trunc(preview, 80))}` : "",
      ].filter(Boolean).join(" ");
    }
    // ── Hole 1: renderers for 10 high-volume kinds that previously fell
    // through to the default renderer. Each renderer is defensive against
    // missing payload fields and stays ≤ MAX_EVENT_LINE_CHARS via the
    // outer `trunc(line, MAX_EVENT_LINE_CHARS)` failsafe. Kinds below
    // are sorted alphabetically.
    case "brain_message_emitted": {
      const text = p.text as string | undefined;
      return text ? `text=${JSON.stringify(trunc(text, 80))}` : "text=<unset>";
    }
    case "brain_reasoning_recorded": {
      const summary = p.summary as string | undefined;
      return summary ? `summary=${JSON.stringify(trunc(summary, 80))}` : "summary=<unset>";
    }
    case "bridge_frame_received": {
      const frame = (p.frame_type as string) ?? "<unset>";
      const tool = p.tool_name as string | undefined;
      return `frame=${frame}${tool ? ` tool=${trunc(tool, 40)}` : ""}`;
    }
    case "candidate_confirmed": {
      const candidate = idPrefix(p.candidate_id as string, 12);
      const delta = p.confidence_delta;
      const knowledge = p.knowledge_id as string | undefined;
      return [
        `candidate=${candidate}`,
        typeof delta === "number" ? `conf+=${delta}` : "",
        knowledge ? `knowledge=${idPrefix(knowledge, 12)}` : "",
      ].filter(Boolean).join(" ");
    }
    case "embedding_computed": {
      const ids = p.source_event_ids as string[] | undefined;
      const count = p.count as number | undefined;
      const subject = idPrefix(Array.isArray(ids) ? ids[0] : undefined, 12);
      const model = (p.model as string) ?? "default";
      const dims = p.dims as number | undefined;
      const batchSize = typeof count === "number" ? count : (Array.isArray(ids) ? ids.length : 0);
      return `subject=${subject}${batchSize > 1 ? ` batch=${batchSize}` : ""} model=${model}${typeof dims === "number" ? ` dims=${dims}` : ""}`;
    }
    case "knowledge_propagated": {
      const candidate = idPrefix(p.candidate_id as string, 12);
      const fanoutRaw = p.fanout;
      const targets = p.target_directives as unknown[] | undefined;
      const fanout = typeof fanoutRaw === "number"
        ? fanoutRaw
        : (Array.isArray(targets) ? targets.length : undefined);
      return `candidate=${candidate}${fanout !== undefined ? ` fanout=${fanout}` : ""}`;
    }
    case "origin_calibration_recorded": {
      const origin = (p.origin as string) ?? "<unset>";
      const shape = idPrefix(p.goal_shape as string, 10);
      const alpha = p.alpha_delta;
      const beta = p.beta_delta;
      return [
        `origin=${origin}`,
        shape !== "—" ? `shape=${shape}` : "",
        typeof alpha === "number" ? `Δα=${alpha}` : "",
        typeof beta === "number" ? `Δβ=${beta}` : "",
      ].filter(Boolean).join(" ");
    }
    case "recipe_promotion_deferred": {
      const recipe = idPrefix(p.recipe_id as string, 12);
      const reason = p.reason as string | undefined;
      return `recipe=${recipe}${reason ? ` reason=${trunc(reason, 60)}` : ""}`;
    }
    case "retrieval_binding": {
      const source = idPrefix(p.source_event_id as string, 12);
      const retrieved = p.retrieved_event_ids as unknown[] | undefined;
      const hits = Array.isArray(retrieved) ? retrieved.length : 0;
      const score = p.score;
      return [
        `source=${source}`,
        `hits=${hits}`,
        typeof score === "number" ? `top_score=${score}` : "",
      ].filter(Boolean).join(" ");
    }
    case "worker_tick_completed": {
      const worker = (p.worker_name as string) ?? "<unset>";
      const elapsed = p.elapsed_ms ?? p.tick_ms;
      const status = p.status as string | undefined;
      return [
        `worker=${worker}`,
        typeof elapsed === "number" ? `elapsed=${elapsed}ms` : "",
        status ? `status=${status}` : "ok",
      ].filter(Boolean).join(" ");
    }
    default:
      return "";
  }
};

/** Format one event as a single line suitable for piped consumption.
 *  Returns "" when the event should be suppressed:
 *    - bridge_frame_received always (unless --verbose explicit)
 *    - everything outside NARRATIVE_KINDS unless --verbose
 *  --verbose is the diagnostic dump; default is the narrative an operator
 *  needs to understand WHAT the brain is doing. */
export const formatEvent = (ev: EventLike, opts: { verbose?: boolean } = {}): string => {
  const k = ev.kind ?? "";
  if (!opts.verbose) {
    if (FRAME_KINDS.has(k)) return "";
    if (!NARRATIVE_KINDS.has(k)) return "";
  }
  const ts = (ev.ts ?? "").slice(11, 19);
  const kind = ev.kind ?? "?";
  const glyph = GLYPHS[kind] ?? " ";
  const task = idPrefix(ev.task_id, 16);
  const payload = parsePayload(ev.payload);
  // Merge top-level event columns into the payload view so renderers
  // (e.g. action_predicted reading action_artifact_id) see canonical
  // top-level fields directly. Substrate stores the act-loop tuple +
  // outcome/residual as dedicated columns; brain emitters set them at
  // top-level, not inside payload.
  const merged = {
    ...payload,
    action_artifact_id: (payload.action_artifact_id ?? (ev as Record<string, unknown>).action_artifact_id),
    verifier_artifact_id: (payload.verifier_artifact_id ?? (ev as Record<string, unknown>).verifier_artifact_id),
    predicted_residual: (payload.predicted_residual ?? (ev as Record<string, unknown>).predicted_residual),
    outcome: (payload.outcome ?? (ev as Record<string, unknown>).outcome),
    residual: (payload.residual ?? (ev as Record<string, unknown>).residual),
  };
  const suffix = formatPayload(kind, merged);
  const failureKind = ev.failure_kind ? ` failure_kind=${ev.failure_kind}` : "";
  const line = `${ts} ${glyph.padEnd(3)} ${kind.padEnd(28)} task=${task.padEnd(16)} ${suffix}${failureKind}`.trimEnd();
  return trunc(line, MAX_EVENT_LINE_CHARS);
};

// Heartbeat formatter — produces the panel-friendly "waiting on brain" line.
// Pre-event window: `[t+<s>s] waiting on brain · cycle <c>/<max> · <e> events · <n> nodes · <p> proposals`.
// Post-event window: append ` · last <kind> <age>s ago`.
// Capped at MAX_EVENT_LINE_CHARS so the trailing-5-line background_tasks panel
// stays readable.
export type HeartbeatCounters = {
  events: number;
  nodes: number;
  proposals: number;
  cycle: number;
  maxCycles: number;
  lastKind?: string;
  lastEventAt?: number;
};
export const formatFollowHeartbeat = (
  startedAt: number,
  counters: HeartbeatCounters,
  now: number = Date.now(),
): string => {
  const ageS = Math.max(0, Math.floor((now - startedAt) / 1000));
  const cycle = counters.cycle > 0 ? counters.cycle : 1;
  const max = counters.maxCycles > 0 ? counters.maxCycles : 1;
  const base = `[t+${ageS}s] waiting on brain · cycle ${cycle}/${max} · ${counters.events} events · ${counters.nodes} nodes · ${counters.proposals} proposals`;
  let line = base;
  if (counters.lastKind && counters.lastEventAt) {
    const lastAgeS = Math.max(0, Math.floor((now - counters.lastEventAt) / 1000));
    line = `${base} · last ${counters.lastKind} ${lastAgeS}s ago`;
  }
  return trunc(line, MAX_EVENT_LINE_CHARS);
};

type DispatchResolvedLike = {
  directive_id?: string;
  root_task_id?: string;
  lifecycle_status?: string;
  status_reason?: string | null;
  terminal_kind?: string | null;
  failure_kind?: string | null;
};

const RESOLVED_TERMINAL_STATUSES = new Set(["completed", "failed"]);

export const resolveRootTaskIdFlag = (flags: Record<string, string | boolean>): string | undefined => {
  const explicit = flags["root-task-id"] ?? flags.root;
  return typeof explicit === "string" && explicit.length > 0 ? explicit : undefined;
};

const resolvedLifecycleStatus = (row: DispatchResolvedLike): string =>
  row.lifecycle_status ?? "unknown";

const resolvedStatusReason = (row: DispatchResolvedLike): string | null =>
  row.status_reason ?? row.terminal_kind ?? row.failure_kind ?? null;

export const formatFollowTerminalSentinel = (row: DispatchResolvedLike): string => {
  const reason = resolvedStatusReason(row);
  const parts = [
    "ACC_DISPATCH_RESOLVED",
    `directive=${idPrefix(row.directive_id, 16)}`,
    `root=${idPrefix(row.root_task_id, 16)}`,
    `status=${resolvedLifecycleStatus(row)}`,
    reason ? `reason=${reason}` : "",
  ].filter(Boolean);
  return trunc(parts.join(" "), MAX_EVENT_LINE_CHARS);
};

const readResolvedTerminalRow = async (opts: TailOpts): Promise<DispatchResolvedLike | null> => {
  if (!opts.directive || !opts.rootTaskId) return null;
  const env = await auxRead("dispatch_resolved_view", { directive_id: opts.directive, root_task_id: opts.rootTaskId }, { timeoutMs: 3_000 }).catch(() => null);
  if (!env?.ok) return null;
  const row = ((env.result as DispatchResolvedLike[] | undefined) ?? [])[0];
  if (!row || !RESOLVED_TERMINAL_STATUSES.has(resolvedLifecycleStatus(row))) return null;
  return row;
};

const emitResolvedTerminalSentinel = async (opts: TailOpts): Promise<boolean> => {
  const row = await readResolvedTerminalRow(opts);
  if (!row) return false;
  console.log(formatFollowTerminalSentinel(row));
  return true;
};

// ── acc events ─────────────────────────────────────────────────────

export type EventsOpts = {
  limit?: number;
  task?: string;      // task_id prefix filter
  directive?: string; // directive_id prefix filter
  kind?: string;      // event kind filter (exact, single)
  /** Multi-kind filter — when set, kind is ignored. Used by `acc notify`
   *  to subscribe to the entire mirror-inline set in one call instead
   *  of running N parallel tails. The MCP `runtime.recent_events` API
   *  already accepts an array on the `kinds` argument; the client-side
   *  filter passes the union through. */
  kinds?: string[];
  verbose?: boolean;
  /** Emit machine-readable JSON of the raw event rows instead of the
   *  human one-line-per-kind narrative. JSON mode bypasses the
   *  NARRATIVE_KINDS suppression in `formatEvent` (so EVERY filtered row
   *  is emitted, never silently dropped) and is the canonical surface for
   *  a downstream consumer that wants to parse the structured events. The
   *  shape matches the acc2 `--json` convention (`acc whoami --json`,
   *  `acc dispatch --json`): a single `JSON.stringify(value, null, 2)`
   *  value — here a JSON array of the (filtered) event rows. */
  json?: boolean;
};

/** Apply the client-side task/directive/kind(s) filters to a raw event
 *  window. Shared by the human-render path and the `--json` path so the
 *  two cannot diverge (the historical `--json` bug was that the render
 *  path silently dropped non-narrative rows; both paths now agree on
 *  WHICH rows match before deciding HOW to print them). */
export const filterEvents = (evs: EventLike[], opts: EventsOpts): EventLike[] =>
  evs.filter((e) => {
    if (opts.task && !(e.task_id ?? "").startsWith(opts.task)) return false;
    if (opts.directive && !(e.directive_id ?? "").startsWith(opts.directive)) return false;
    if (opts.kinds && opts.kinds.length > 0) {
      if (!opts.kinds.includes(e.kind ?? "")) return false;
    } else if (opts.kind && e.kind !== opts.kind) return false;
    return true;
  });

export const runEvents = async (opts: EventsOpts): Promise<number> => {
  const k = Math.min(200, opts.limit ?? 30);  // server caps at 200
  let env;
  try {
    // runtime.recent_events takes `k` (count, ≤200) and optional `kinds` (string[]
    // filter). When `--kind` or `--kinds` is set, pass it to the server so we
    // don't burn the window on irrelevant rows. `kinds[]` takes precedence
    // over `kind` when both are provided.
    const args: Record<string, unknown> = { k };
    if (opts.kinds && opts.kinds.length > 0) args.kinds = opts.kinds;
    else if (opts.kind) args.kinds = [opts.kind];
    env = await auxRecentEvents(args as { kinds?: string[]; k?: number });
  } catch (err) {
    console.error(`acc events: ${(err as Error).message}`);
    return 1;
  }
  if (!env.ok) {
    console.error(`acc events: ${env.error}`);
    return 1;
  }
  const evs = ((env.result as { events?: EventLike[] })?.events ?? []) as EventLike[];
  // Server already returns ts-ascending; no reverse needed.
  // kind/kinds already server-filtered when set; the client-side filter is a
  // no-op in that case but still applies the task/directive prefix filters.
  const matched = filterEvents(evs, opts);
  if (opts.json) {
    // Machine-readable surface: emit the RAW filtered rows as a single JSON
    // array — NOT the narrative one-liner, and NOT subject to NARRATIVE_KINDS
    // suppression. An empty match is a valid `[]`, never a silent drop or an
    // error. This is the documented `--json` contract and matches the acc2
    // `JSON.stringify(value, null, 2)` convention.
    console.log(JSON.stringify(matched, null, 2));
    return 0;
  }
  // `acc events` is the honest bounded ledger-window reader, so every row
  // matching the explicit filters is rendered. Narrative suppression belongs
  // to the live operator stream (`acc tail` / `acc notify`), not to this
  // historical query surface.
  for (const e of matched) {
    const line = formatEvent(e, { verbose: true });
    console.log(line || `${e.ts ?? "?"} ${e.kind ?? "?"} ${e.task_id ?? "-"} id=${eventId(e) ?? "?"}`);
  }
  if (matched.length === 0 && evs.length > 0) {
    console.error(`acc events: no rows matched filters in the bounded ${evs.length}-row window`);
  }
  return 0;
};

// ── acc tail ───────────────────────────────────────────────────────
//
// Thin scriptable live stream. Default stdout is NDJSON: one raw event object
// per line after task/directive/kind filtering. Human one-line rendering is an
// explicit --human/--pretty mode for terminals; rich human observation belongs
// to `acc watch`, and bounded historical inspection belongs to `acc events`.
//
// Terminal-exit contract: when directive + rootTaskId are available, exit 0
// only after dispatch_resolved_view confirms a completed/failed lifecycle and
// emit exactly one terminal sentinel. Raw task_committed/task_failed SSE rows
// are evidence to print, not sufficient terminal authority. Without that scope,
// raw terminal rows remain the best available generic-tail signal.
//
// Surface collapse: `acc notify` is not its own stream implementation. It is
// `tail`/`events` with the mirror-inline kind preset. Keep all reconnect,
// filtering, NDJSON, and terminal-exit behavior in the shared tail path.

export type TailOpts = EventsOpts & {
  pollMs?: number;
  /** Stop after the FIRST terminal event matching task/directive scope.
   *  Default true when scope is specified, false otherwise. */
  exitOnTerminal?: boolean;
  /** Absolute deadline (Date.now() + ms). When exceeded, exit non-zero unless detachOnDeadline is set. */
  deadlineMs?: number;
  /** Return success with a detach message when the follow budget elapses. */
  detachOnDeadline?: boolean;
  /** Use SSE push (canonical, ~realtime) instead of polling. Default true.
   *  --no-stream is a diagnostic fallback, not a parallel user-facing mode. */
  stream?: boolean;
  /** When the caller follows a whole directive subtree but still wants to
   *  exit only on the ROOT task's terminal event (not the first sub-task
   *  to commit), pass the root task id here. */
  rootTaskId?: string;
  /** Deprecated no-op. Do not reintroduce synthetic progress lines; scripts
   *  get NDJSON, humans get watch, and transport liveness stays transport-level. */
  heartbeat?: boolean;
  // `json` (default true for `acc tail`; false only for explicit human
  // rendering) is inherited from EventsOpts — see its declaration there.
};

// SSE-backed live stream — canonical implementation for tail and notify.
// Polling must share the same emit/filter/terminal helper so the fallback does
// not drift into a second line protocol.
const runTailStream = async (opts: TailOpts): Promise<number> => {
  const exitOnTerminal = opts.exitOnTerminal ?? Boolean(opts.task || opts.directive);
  // When BOTH directive + rootTaskId are present we can query
  // dispatch_resolved_view — the authoritative substrate projection. In that
  // case a raw task_committed/task_failed/dispatcher_violation SSE event is
  // NOT sufficient evidence to declare the dispatch terminal (orchestrator-
  // runtime.md "don't classify a dispatch terminal without substrate
  // evidence"): the projection must confirm lifecycle_status ∈ {completed,
  // failed}. Only generic `acc tail` scopes that lack the directive/root pair
  // fall back to the raw event as the terminal signal. This mirrors the poll
  // path's `!canReadResolvedDispatch` guard so SSE and poll agree.
  const canReadResolvedDispatch = Boolean(opts.directive && opts.rootTaskId);
  const deadlineMs = opts.deadlineMs;
  const ac = new AbortController();
  let deadlineExpired = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  if (deadlineMs) {
    const ms = deadlineMs - Date.now();
    if (ms <= 0) {
      console.error("acc tail: deadline already exceeded");
      return 2;
    }
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      ac.abort();
    }, ms);
  }
  let sawTerminal = false;
  let terminalCheckInFlight = false;
  let sentinelEmitted = false;
  const startedAt = Date.now();
  // Heartbeat counters surfaced into every `[t+Ns] waiting on brain …` line.
  // `events` = scoped events seen on the SSE stream; `nodes` = task_node_opened
  // events (so the operator sees DAG growth without verbose); `proposals` =
  // contract_amendment_proposed / lesson_extracted (so the operator sees what
  // owner-gated decisions are accumulating). `cycle` / `maxCycles` are pulled
  // from any brain_dispatched payload that arrives.
  const counters: HeartbeatCounters = { events: 0, nodes: 0, proposals: 0, cycle: 1, maxCycles: 1 };
  // Heartbeat removed (2026-05-19) — SSE transport keepalive (`: keepalive`
  // every 15s) carries the "system alive" signal; the synthetic
  // `[t+Ns] waiting on brain` lines created panel noise and a misleading
  // "stuck" feel when real events were arriving on the stream below the
  // narrative filter. The `heartbeat?` flag stays in TailOpts for API
  // compatibility but is effectively a no-op.
  const heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const emitTerminalFromResolvedView = async (): Promise<boolean> => {
    if (!exitOnTerminal || sentinelEmitted || terminalCheckInFlight) return false;
    terminalCheckInFlight = true;
    try {
      const emitted = await emitResolvedTerminalSentinel(opts);
      if (!emitted) return false;
      sentinelEmitted = true;
      sawTerminal = true;
      ac.abort();
      return true;
    } finally {
      terminalCheckInFlight = false;
    }
  };
  const resolvedViewTimer = opts.directive && opts.rootTaskId
    ? setInterval(() => { void emitTerminalFromResolvedView(); }, opts.pollMs ?? 500)
    : null;
  resolvedViewTimer?.unref?.();
  // Also wire process-signal abort so SIGTERM/SIGINT triggers abort cleanly
  // and the exit-code path below reports an honest "didn't see terminal".
  const onSig = () => ac.abort();
  process.once("SIGTERM", onSig);
  process.once("SIGINT", onSig);
  try {
    if (await emitTerminalFromResolvedView()) return 0;
    for await (const ev of sseConnect({ signal: ac.signal, reconnect: true })) {
      // SseEvent shape: { event_id, kind, ts, directive_id?, task_id?, substrate_origin?, payload? }
      // matches EventLike directly — no .data unwrap.
      const e = ev as unknown as EventLike;
      if (opts.task && !(e.task_id ?? "").startsWith(opts.task)) continue;
      if (opts.directive && !(e.directive_id ?? "").startsWith(opts.directive)) continue;
      counters.events++;
      counters.lastKind = e.kind;
      counters.lastEventAt = Date.now();
      if (e.kind === "task_node_opened") counters.nodes++;
      if (e.kind === "contract_amendment_proposed" || e.kind === "lesson_extracted") counters.proposals++;
      if (e.kind === "brain_dispatched") {
        const p = parsePayload(e.payload);
        if (typeof p.cycle === "number") counters.cycle = p.cycle as number;
        if (typeof p.max_cycles === "number") counters.maxCycles = p.max_cycles as number;
      }
      if (opts.kinds && opts.kinds.length > 0) {
        if (!opts.kinds.includes(e.kind ?? "")) continue;
      } else if (opts.kind && e.kind !== opts.kind) continue;
      if (opts.json) {
        // Streaming machine-readable surface: NDJSON — one compact JSON
        // object per line per event (a stream cannot be a single array).
        // Raw row, no NARRATIVE_KINDS suppression. Each line is parseable in
        // isolation by a line-delimited consumer.
        console.log(JSON.stringify(e));
      } else {
        const line = formatEvent(e, { verbose: opts.verbose });
        if (line) console.log(line);
      }
      if (TERMINAL_KINDS.has(e.kind ?? "")) {
        // When a rootTaskId is specified (typical for `acc task` which
        // follows the whole directive subtree but should exit only on
        // the ROOT task's terminal), accept terminal events from
        // sub-tasks as informational and continue. Only the root task's
        // terminal closes the stream.
        const isRootTerminal = !opts.rootTaskId || (e.task_id === opts.rootTaskId);
        if (isRootTerminal && exitOnTerminal) {
          if (!sentinelEmitted) sentinelEmitted = await emitResolvedTerminalSentinel(opts);
          // When the resolved-view projection is queryable, require the
          // sentinel (substrate evidence) before declaring the dispatch
          // terminal. If the projection has not yet flipped to
          // completed/failed, keep following — the resolvedViewTimer emits +
          // aborts once it does. Without the directive/root pair the raw event
          // is the only terminal signal available, so accept it. Only mark
          // sawTerminal (the authoritative success flag the abort/deadline
          // branches read) when we actually have terminal authority.
          if (sentinelEmitted || !canReadResolvedDispatch) {
            sawTerminal = true;
            ac.abort();
            return 0;
          }
        } else if (isRootTerminal) {
          // Not exiting on terminal (generic tail): the raw event is still a
          // legitimate observation for non-exit callers.
          sawTerminal = true;
        }
      }
    }
  } catch (err) {
    if (ac.signal.aborted) {
      if (sawTerminal) return 0;
      if (deadlineExpired && opts.detachOnDeadline) {
        console.log("acc task: follow budget elapsed; detached while the directive continues in the background");
        return 0;
      }
      if (deadlineMs) {
        console.error("acc tail: deadline exceeded (no terminal event)");
        return 2;
      }
      // Aborted (likely SIGTERM/SIGINT) before any terminal event landed.
      // Report this honestly — exit code 0 would imply "directive completed"
      // and confuse callers (live evidence: bd80w5fsx + bj6umku93 reported
      // exit 0 when actually killed mid-flight by the operator).
      console.error("acc tail: aborted before any terminal event (directive may still be in-flight)");
      return 3;
    }
    console.error(`acc tail: ${(err as Error).message}`);
    return 1;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (resolvedViewTimer) clearInterval(resolvedViewTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    process.off("SIGTERM", onSig);
    process.off("SIGINT", onSig);
  }
  // SSE generator returned gracefully without abort — only happens when
  // reconnect=false and a fatal error occurs OR when signal aborts during
  // a backoff sleep. With reconnect=true the generator should not exhaust.
  if (sawTerminal) return 0;
  if (deadlineExpired && opts.detachOnDeadline) {
    console.log("acc task: follow budget elapsed; detached while the directive continues in the background");
    return 0;
  }
  console.error("acc tail: SSE stream closed before any terminal event (daemon may have stopped)");
  return 3;
};

// Polling fallback (kept for when SSE cannot connect — e.g. daemon down at
// start, restricted network). Server caps at k=200; we re-poll every pollMs.
const runTailPoll = async (opts: TailOpts): Promise<number> => {
  const pollMs = opts.pollMs ?? 2000;
  const exitOnTerminal = opts.exitOnTerminal ?? Boolean(opts.task || opts.directive);
  const deadlineMs = opts.deadlineMs;
  const seen = new Set<string>();
  const canReadResolvedDispatch = Boolean(opts.directive && opts.rootTaskId);
  const startedAt = Date.now();
  void startedAt;
  const counters: HeartbeatCounters = { events: 0, nodes: 0, proposals: 0, cycle: 1, maxCycles: 1 };
  void counters;
  // Heartbeat removed (2026-05-19) — see runTailStream rationale; the poll
  // path inherits the same decision. Real events on `runtime.recent_events`
  // poll output are the only operator-visible signal.

  while (true) {
    let env;
    try {
      const args: Record<string, unknown> = { k: Math.min(200, opts.limit ?? 60) };
      if (opts.kinds && opts.kinds.length > 0) args.kinds = opts.kinds;
      else if (opts.kind) args.kinds = [opts.kind];
      env = await auxRecentEvents(args as { kinds?: string[]; k?: number });
    } catch (err) {
      console.error(`acc tail: ${(err as Error).message}`);
      return 1;
    }
    if (!env.ok) {
      console.error(`acc tail: ${env.error}`);
      return 1;
    }
    const evs = ((env.result as { events?: EventLike[] })?.events ?? []) as EventLike[];
    let sawTerminal: EventLike | null = null;
    for (const e of evs) {
      const id = eventId(e);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (opts.task && !(e.task_id ?? "").startsWith(opts.task)) continue;
      if (opts.directive && !(e.directive_id ?? "").startsWith(opts.directive)) continue;
      counters.events++;
      counters.lastKind = e.kind;
      counters.lastEventAt = Date.now();
      if (e.kind === "task_node_opened") counters.nodes++;
      if (e.kind === "contract_amendment_proposed" || e.kind === "lesson_extracted") counters.proposals++;
      if (e.kind === "brain_dispatched") {
        const p = parsePayload(e.payload);
        if (typeof p.cycle === "number") counters.cycle = p.cycle as number;
        if (typeof p.max_cycles === "number") counters.maxCycles = p.max_cycles as number;
      }
      if (opts.kinds && opts.kinds.length > 0) {
        if (!opts.kinds.includes(e.kind ?? "")) continue;
      } else if (opts.kind && e.kind !== opts.kind) continue;
      if (opts.json) {
        // NDJSON streaming surface (poll fallback parity with runTailStream).
        console.log(JSON.stringify(e));
      } else {
        const line = formatEvent(e, { verbose: opts.verbose });
        if (line) console.log(line);
      }
      if (TERMINAL_KINDS.has(e.kind ?? "")) {
        const isRootTerminal = !opts.rootTaskId || (e.task_id === opts.rootTaskId);
        if (isRootTerminal) sawTerminal = e;
      }
    }
    if (exitOnTerminal && await emitResolvedTerminalSentinel(opts)) return 0;
    // For acc task fallback polling, dispatch_resolved_view is authoritative;
    // raw terminal events are only sufficient for generic acc tail scopes that
    // do not carry the directive/root pair needed to query the projection.
    if (sawTerminal && exitOnTerminal && !canReadResolvedDispatch) return 0;
    if (deadlineMs && Date.now() > deadlineMs) {
      if (opts.detachOnDeadline) {
        console.log("acc task: follow budget elapsed; detached while the directive continues in the background");
        return 0;
      }
      console.error("acc tail: deadline exceeded (no terminal event)");
      return 2;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
};

export const runTail = async (opts: TailOpts): Promise<number> => {
  // Default to SSE — Claude-native push, no poll lag, no missed events.
  // Operator can force polling with --no-stream / stream=false.
  if (opts.stream === false) return runTailPoll(opts);
  return runTailStream(opts);
};

// ── acc graph ──────────────────────────────────────────────────────

export const runGraph = async (directiveId: string): Promise<number> => {
  let env;
  try {
    env = await auxRead("task_graph_view", { directive_id: directiveId });
  } catch (err) {
    console.error(`acc graph: ${(err as Error).message}`);
    return 1;
  }
  if (!env.ok) {
    console.error(`acc graph: ${env.error}`);
    return 1;
  }
  const rows = (env.result as Array<Record<string, unknown>>) ?? [];
  const nodes = rows
    .filter((r) => r.row_kind === "node")
    .map((r) => ({
      task_id: r.task_id as string,
      parent_task_id: r.parent_task_id as string | null,
      payload: parsePayload(r.payload),
    }))
    .sort((a, b) => (Number(a.payload.rank ?? 99) - Number(b.payload.rank ?? 99)));
  const edges = rows.filter((r) => r.row_kind === "edge");
  console.log(`directive ${directiveId}`);
  console.log(`nodes: ${nodes.length}  edges: ${edges.length}`);
  console.log();
  for (const n of nodes) {
    const rank = n.payload.rank !== undefined ? `rank=${n.payload.rank}` : "       ";
    const parent = n.parent_task_id ? ` parent=${idPrefix(n.parent_task_id, 16)}` : "";
    const goal = trunc(n.payload.goal as string, 140);
    console.log(`▸ ${n.task_id.padEnd(34)} ${rank}${parent}`);
    if (goal) console.log(`   ${goal}`);
    const docs = n.payload.docs_sections as string[] | undefined;
    if (docs?.length) console.log(`   cites: ${docs.join(" · ")}`);
    const recipes = n.payload.tier0_recipe_refs as string[] | undefined;
    if (recipes?.length) console.log(`   tier-0: ${recipes.slice(0, 4).map((x) => idPrefix(x, 12)).join(", ")}`);
    console.log();
  }
  if (edges.length > 0) {
    console.log("edges:");
    for (const e of edges) {
      const p = parsePayload(e.payload);
      const kind = (p.kind as string) ?? "?";
      const from = idPrefix((p.from_task as string) ?? (p.from as string), 18);
      const to = idPrefix((p.to_task as string) ?? (p.to as string), 18);
      console.log(`  ${kind.padEnd(10)} ${from} → ${to}`);
    }
  }
  return 0;
};

// ── acc inspect ────────────────────────────────────────────────────

// runtime.recent_events caps the window server-side at 200 rows. `acc inspect`
// filters that window client-side by task_id prefix, so on a busy ledger a
// task whose events have scrolled out of the most-recent-200 window matches
// nothing — and the prior code reported that as "no events for task" (a
// false-negative that implies the task never existed). The window edge also
// means a long task's chronology can be silently truncated. Both cases are
// now reported honestly, and the operator is pointed at the indexed,
// directive-scoped substrate-truth surface (`acc dispatch`) which does NOT
// suffer the window limit.
const RECENT_EVENTS_SERVER_CAP = 200;

export const runInspect = async (taskId: string, opts: { json?: boolean } = {}): Promise<number> => {
  let env;
  try {
    env = await auxRecentEvents({ k: RECENT_EVENTS_SERVER_CAP });
  } catch (err) {
    console.error(`acc inspect: ${(err as Error).message}`);
    return 1;
  }
  if (!env.ok) {
    console.error(`acc inspect: ${env.error}`);
    return 1;
  }
  const evs = ((env.result as { events?: EventLike[] })?.events ?? []) as EventLike[];
  // Server returns ts-ascending; no reverse.
  const windowFull = evs.length >= RECENT_EVENTS_SERVER_CAP;
  const taskEvs = evs.filter((e) => (e.task_id ?? "").startsWith(taskId));
  if (opts.json) {
    // Machine-readable surface: emit the raw matched rows as a single JSON
    // array (matches `acc events --json`). An empty match is a valid `[]` —
    // the window-truncation caveats are advisory and stay on stderr so they
    // don't corrupt the parseable stdout payload.
    console.log(JSON.stringify(taskEvs, null, 2));
    if (taskEvs.length === 0 && windowFull) {
      console.error(
        `acc inspect: task ${taskId} not in the most recent ${RECENT_EVENTS_SERVER_CAP} events — ` +
        `it may be older than this window. Use \`acc dispatch <directive_id>\` for an index-backed report.`,
      );
    }
    return taskEvs.length === 0 ? 1 : 0;
  }
  if (taskEvs.length === 0) {
    // Distinguish "task does not exist" from "task is older than the recent
    // window". When the window is full we cannot prove absence — say so and
    // route the operator to the indexed inspector instead of falsely
    // reporting the task as missing.
    if (windowFull) {
      console.error(
        `acc inspect: task ${taskId} not in the most recent ${RECENT_EVENTS_SERVER_CAP} events — ` +
        `it may be older than this window. Use \`acc dispatch <directive_id>\` for a directive-scoped, ` +
        `index-backed report that is not bounded by the recent-events window.`,
      );
    } else {
      console.error(`acc inspect: no events for task starting with ${taskId} (recent window)`);
    }
    return 1;
  }
  console.log(`task ${taskEvs[0]!.task_id}`);
  const kinds: Record<string, number> = {};
  for (const e of taskEvs) kinds[e.kind ?? "?"] = (kinds[e.kind ?? "?"] ?? 0) + 1;
  console.log(`events: ${taskEvs.length}`);
  const counts = Object.entries(kinds).sort((a, b) => b[1] - a[1]);
  for (const [k, n] of counts) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log();
  console.log("chronological:");
  for (const e of taskEvs) {
    const line = formatEvent(e, { verbose: true });
    if (line) console.log("  " + line);
  }
  // When the window was saturated AND the task's oldest matched event sits at
  // the head of the window, earlier events for this task may have been
  // dropped — flag the chronology as potentially partial so the operator does
  // not read it as complete.
  if (windowFull && taskEvs[0] && evs[0] && taskEvs[0]!.task_id === evs[0]!.task_id) {
    console.error(
      `acc inspect: warning — chronology may be truncated; this task reaches the head of the ` +
      `${RECENT_EVENTS_SERVER_CAP}-event window. Use \`acc dispatch <directive_id>\` for the full index-backed trajectory.`,
    );
  }
  return 0;
};

// ── CLI dispatch ───────────────────────────────────────────────────

const parseFlags = (argv: string[]): Record<string, string | boolean> => {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out[a.slice(2)] = next;
          i++;
        } else {
          out[a.slice(2)] = true;
        }
      }
    }
  }
  return out;
};

/** Mirror-inline event kind set — every event the orchestrator MUST
 *  surface to the operator inline per .claude/rules/orchestrator-runtime.md
 *  "Background command observability". `acc notify` is the CLI surface
 *  that subscribes to exactly this set. Sourced from the canonical
 *  registry's `mirror_inline: true` flag so the two cannot drift.
 *  (Imported alongside EVENT_KINDS at the top of this module.) */

/** `acc notify` — Claude Code chat-friendly event stream. Thin alias
 *  over `runTail` with the mirror-inline kind set pre-filled. Defaults
 *  to `--follow` (SSE stream) when invoked without args, since the
 *  whole point is to watch for HIDL / apply / dispatcher-violation
 *  events in real time. Without --follow, prints the most recent N
 *  matching rows and exits. */
export const runNotify = async (argv: string[]): Promise<number> => {
  const flags = parseFlags(argv);
  const kinds = Array.from(MIRROR_INLINE_EVENT_TYPES);
  if (kinds.length === 0) {
    // No kinds registered yet — guidance instead of silent no-op.
    console.error("acc notify: no event kinds are registered with mirror_inline=true. " +
      "Either you're on a very old build (the HIDL kind landed 2026-05-15) or the registry is empty. " +
      "Try `acc events --kind hidl_action_required` to inspect manually.");
    return 1;
  }
  // --no-follow → one-shot; default is follow (the canonical Claude
  // Code chat-stream use). `acc notify --no-follow --limit N` prints
  // the most recent matching rows and exits 0.
  const noFollow = Boolean(flags["no-follow"]);
  if (noFollow) {
    return runEvents({
      kinds,
      limit: flags.limit ? Number(flags.limit) : undefined,
      verbose: Boolean(flags.verbose),
      json: Boolean(flags.json),
    });
  }
  return runTail({
    kinds,
    limit: flags.limit ? Number(flags.limit) : undefined,
    pollMs: flags["poll-ms"] ? Number(flags["poll-ms"]) : undefined,
    deadlineMs: flags.timeout
      ? Date.now() + Number(flags.timeout) * 1000
      : undefined,
    stream: flags["no-stream"] ? false : (flags.stream !== false),
    verbose: Boolean(flags.verbose),
    json: Boolean(flags.json),
  });
};

export const runObserve = async (cmd: string, argv: string[]): Promise<number> => {
  const flags = parseFlags(argv);
  switch (cmd) {
    case "events":
      return runEvents({
        limit: flags.limit ? Number(flags.limit) : undefined,
        task: typeof flags.task === "string" ? flags.task : undefined,
        directive: typeof flags.directive === "string" ? flags.directive : undefined,
        kind: typeof flags.kind === "string" ? flags.kind : undefined,
        verbose: Boolean(flags.verbose),
        json: Boolean(flags.json),
      });
    case "tail":
      return runTail({
        limit: flags.limit ? Number(flags.limit) : undefined,
        task: typeof flags.task === "string" ? flags.task : undefined,
        directive: typeof flags.directive === "string" ? flags.directive : undefined,
        kind: typeof flags.kind === "string" ? flags.kind : undefined,
        verbose: Boolean(flags.verbose),
        json: Boolean(flags.json),
        rootTaskId: resolveRootTaskIdFlag(flags),
        pollMs: flags["poll-ms"] ? Number(flags["poll-ms"]) : undefined,
        deadlineMs: flags.timeout
          ? Date.now() + Number(flags.timeout) * 1000
          : undefined,
        // Default = SSE stream. `--no-stream` forces polling fallback.
        stream: flags["no-stream"] ? false : (flags.stream !== false),
      });
    case "graph": {
      const did = argv.find((a) => !a.startsWith("--"));
      if (!did) {
        console.error("acc graph: requires <directive_id>");
        return 1;
      }
      return runGraph(did);
    }
    case "inspect": {
      const tid = argv.find((a) => !a.startsWith("--"));
      if (!tid) {
        console.error("acc inspect: requires <task_id>");
        return 1;
      }
      return runInspect(tid, { json: Boolean(flags.json) });
    }
    default:
      console.error(`acc observe: unknown subcommand '${cmd}'`);
      return 1;
  }
};

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "";
  void runObserve(cmd, argv.slice(1)).then((code) => process.exit(code));
}
