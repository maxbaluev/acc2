#!/usr/bin/env bun
// `acc verify <directive_id_prefix>` — orchestrator-side merger
// verification. Aggregates contract_amendment_proposed events under a
// directive, joins to contract_amendment_applied (via context_refs or
// payload.source_event_id), and verifies the named commit_sha exists in
// git, touches the proposed target, and contains the expected text.
// Closes the operator-side auditability gap for the k_555 four-link
// credit chain at the directive level.
//
// Exit: 0 clean / 1 stranded proposal(s) / 2 drift|missing commit.
// SQL-direct via openDb (mirrors trust.ts). Legacy plain-string
// proposed_behavior verifies on target-touch alone, not text.

import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { openDb } from "../substrate/db";
import { resolveDbPath } from "../runtime/state_paths";
import { mcpCall } from "./rpc";

const HELP = `acc verify <directive_id_prefix>

  Orchestrator-side intelligence-merger verification.

  Aggregates every contract_amendment_proposed under <directive_id>,
  joins to contract_amendment_applied (via context_refs or
  payload.source_event_id), and verifies each applied commit_sha
  actually touches the proposed target with the expected text.

  Exit: 0 clean; 1 stranded proposal(s); 2 drift/missing commit.

Flags:
  --repo PATH   Repo root for git checks (default: cwd-walk to .git).
  --help        Show this help.
`;

type Row = { id: string; ts: string; directive_id: string; task_id: string; kind: string; payload: string; context_refs: string };

const parseJson = (s: unknown): Record<string, unknown> => {
  try { return JSON.parse(String(s ?? "{}")) as Record<string, unknown>; } catch { return {}; }
};
const parseArray = (s: unknown): string[] => {
  try { const v = JSON.parse(String(s ?? "[]")); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};

const resolveDirective = (db: Database, prefix: string): string | null => {
  if (prefix.length < 8) return null;
  const r = db.query(`SELECT DISTINCT directive_id FROM events WHERE directive_id LIKE ? LIMIT 2`).all(`${prefix}%`) as Array<{ directive_id: string }>;
  if (r.length === 0) return null;
  if (r.length > 1) return null;
  return r[0]!.directive_id;
};

const rootStatus = (db: Database, directiveId: string): "task_committed" | "task_failed" | "in-flight" => {
  // Root task = the task_id that matches directive on the directive_opened row.
  const open = db.query(`SELECT task_id FROM events WHERE kind='directive_opened' AND directive_id=? LIMIT 1`).get(directiveId) as { task_id?: string } | null;
  if (!open?.task_id) return "in-flight";
  const term = db.query(
    `SELECT kind FROM events WHERE directive_id=? AND task_id=? AND kind IN ('task_committed','task_failed') ORDER BY ts DESC LIMIT 1`,
  ).get(directiveId, open.task_id) as { kind?: string } | null;
  if (term?.kind === "task_committed") return "task_committed";
  if (term?.kind === "task_failed") return "task_failed";
  return "in-flight";
};

const proposalTarget = (payload: Record<string, unknown>): string => {
  for (const key of ["target_resource", "resource_uri", "target", "file_path"] as const) {
    const v = payload[key]; if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  const proposed = payload.proposed_behavior ?? payload.proposed_action;
  if (proposed && typeof proposed === "object") {
    const p = proposed as Record<string, unknown>;
    for (const key of ["target_resource", "resource_uri", "target", "file_path"] as const) {
      const v = p[key]; if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
  }
  return "";
};

const stripRepoPrefix = (target: string): string => target.startsWith("repo:") ? target.slice(5) : target;

const diffField = (payload: Record<string, unknown>, key: "before" | "after"): string | null => {
  const proposed = payload.proposed_behavior ?? payload.proposed_action;
  if (!proposed || typeof proposed !== "object") return null;
  const d = (proposed as Record<string, unknown>).diff;
  if (!d || typeof d !== "object") return null;
  const v = (d as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
};

const isLegacyStringProposal = (payload: Record<string, unknown>): boolean => {
  const proposed = payload.proposed_behavior ?? payload.proposed_action;
  return typeof proposed === "string";
};

type VerifyResult = "verified" | "drift" | "missing";

export const verifyCommitTouches = (sha: string, target: string, repoRoot: string): { exists: boolean; touchesTarget: boolean; patchText: string } => {
  const filePath = stripRepoPrefix(target);
  const stat = spawnSync("git", ["show", "--stat", "--format=", sha], { cwd: repoRoot, encoding: "utf8" });
  if (stat.status !== 0) return { exists: false, touchesTarget: false, patchText: "" };
  const stdout = String(stat.stdout ?? "");
  const touchesTarget = stdout.includes(filePath);
  const diff = spawnSync("git", ["show", sha, "--", filePath], { cwd: repoRoot, encoding: "utf8" });
  const patchText = String(diff.stdout ?? "");
  return { exists: true, touchesTarget, patchText };
};

export const classifyApply = (
  proposalPayload: Record<string, unknown>,
  commitSha: string | undefined,
  repoRoot: string,
): VerifyResult => {
  if (!commitSha) return "missing";
  const target = proposalTarget(proposalPayload);
  if (!target) return "drift";
  const g = verifyCommitTouches(commitSha, target, repoRoot);
  if (!g.exists) return "missing";
  if (!g.touchesTarget) return "drift";
  if (isLegacyStringProposal(proposalPayload)) return "verified"; // legacy: target-touch suffices
  // Patch should mention the `after` text (additive) or `before` text
  // (`-` line). Either marker corroborates a semantic apply; neither = drift.
  const after = diffField(proposalPayload, "after");
  const before = diffField(proposalPayload, "before");
  if (after && g.patchText.includes(after)) return "verified";
  if (before && g.patchText.includes(before)) return "verified";
  return "drift";
};

type AggregateBucket = {
  applied: number;
  failed: number;
  refused: number;
  stranded: Array<{ event_id: string; target: string; anchor_snip: string }>;
  verified: number;
  drift: number;
  missing: number;
  appliedCommits: string[];
  /** Drifted proposal rows (full event id + sha) — Layer 2 uses these
   *  to emit knowledge_contradiction_observed events so the brain's
   *  posterior updates from drift evidence without re-dispatch. */
  driftCases: Array<{ proposal_id: string; commit_sha: string; verdict: "drift" | "missing" }>;
};

export const aggregateVerify = (db: Database, directiveId: string, repoRoot: string): AggregateBucket => {
  const proposals = db.query(
    `SELECT id, ts, directive_id, task_id, kind, payload, context_refs
       FROM events WHERE kind='contract_amendment_proposed' AND directive_id=? ORDER BY ts ASC`,
  ).all(directiveId) as Row[];
  const applies = db.query(
    `SELECT id, ts, directive_id, task_id, kind, payload, context_refs
       FROM events WHERE kind='contract_amendment_applied' AND directive_id=? ORDER BY ts ASC`,
  ).all(directiveId) as Row[];

  // Build join map: proposal_id → applied row(s)
  const applyByProposal = new Map<string, Row>();
  for (const a of applies) {
    const refs = parseArray(a.context_refs);
    const p = parseJson(a.payload);
    const src = typeof p.source_event_id === "string" ? p.source_event_id : "";
    const candidates = [...refs];
    if (src) candidates.push(src);
    for (const c of candidates) {
      if (!applyByProposal.has(c)) applyByProposal.set(c, a);
    }
  }

  const out: AggregateBucket = {
    applied: 0, failed: 0, refused: 0, stranded: [],
    verified: 0, drift: 0, missing: 0, appliedCommits: [],
    driftCases: [],
  };

  for (const proposal of proposals) {
    const applied = applyByProposal.get(proposal.id);
    if (!applied) {
      const pp = parseJson(proposal.payload);
      const anchor = typeof pp.anchor === "string" ? pp.anchor : "";
      out.stranded.push({
        event_id: proposal.id,
        target: proposalTarget(pp) || "(unspecified)",
        anchor_snip: anchor.length > 30 ? anchor.slice(0, 30) + "..." : anchor,
      });
      continue;
    }
    const ap = parseJson(applied.payload);
    const status = typeof ap.status === "string" ? ap.status : "applied";
    if (status === "failed") { out.failed += 1; continue; }
    if (status === "refused") { out.refused += 1; continue; }
    // applied (or unknown-but-recorded)
    out.applied += 1;
    const sha = typeof ap.commit_sha === "string" ? ap.commit_sha : undefined;
    if (sha) out.appliedCommits.push(sha.slice(0, 10));
    const verdict = classifyApply(parseJson(proposal.payload), sha, repoRoot);
    if (verdict === "verified") out.verified += 1;
    else if (verdict === "drift") {
      out.drift += 1;
      out.driftCases.push({ proposal_id: proposal.id, commit_sha: sha ?? "", verdict: "drift" });
    } else {
      out.missing += 1;
      out.driftCases.push({ proposal_id: proposal.id, commit_sha: sha ?? "", verdict: "missing" });
    }
  }
  return out;
};

const renderReport = (directiveId: string, status: string, totals: AggregateBucket): string => {
  const lines: string[] = [];
  const total = totals.applied + totals.failed + totals.refused + totals.stranded.length;
  lines.push(`directive: ${directiveId}  status: ${status}`);
  lines.push(`amendments: ${total} total`);
  lines.push(`  applied:  ${totals.applied}${totals.appliedCommits.length > 0 ? `  (with commits: ${totals.appliedCommits.join(", ")})` : ""}`);
  lines.push(`  failed:   ${totals.failed}`);
  lines.push(`  refused:  ${totals.refused}`);
  lines.push(`  stranded: ${totals.stranded.length}  (proposed, no contract_amendment_applied event)`);
  lines.push(`diff verification:`);
  lines.push(`  verified: ${totals.verified}  (commit_sha exists + touches the proposed target + contains expected text)`);
  lines.push(`  drift:    ${totals.drift}  (commit_sha exists but diff does not match)`);
  lines.push(`  missing:  ${totals.missing}  (claimed applied but commit_sha not in git)`);
  if (totals.stranded.length > 0) {
    lines.push(`stranded list:`);
    for (const s of totals.stranded) {
      lines.push(`  ${s.event_id}  ${s.target}  ${s.anchor_snip}`);
    }
  }
  lines.push("");
  return lines.join("\n");
};

/** Layer 2 self-healing (brain-symmetric): emit knowledge_contradiction_observed
 *  for every drift/missing case so the substrate's Model D extractor demotes
 *  the brain's posterior on the original proposal. Default-on; suppress with
 *  --no-learn for read-only inspection.
 *
 *  Idempotence: SQL checks for an existing contradiction event citing the
 *  same proposal_id with the same commit_sha; skips re-emit when found.
 *  Multiple verify runs on the same drift therefore push one signal, not N. */
const emitDriftContradictions = async (
  db: Database,
  directiveId: string,
  driftCases: Array<{ proposal_id: string; commit_sha: string; verdict: "drift" | "missing" }>,
): Promise<number> => {
  let emitted = 0;
  for (const c of driftCases) {
    const exists = db.query(
      `SELECT 1 FROM events
       WHERE kind='knowledge_contradiction_observed'
         AND json_extract(payload, '$.knowledge_id')=?
         AND json_extract(payload, '$.commit_sha')=?
       LIMIT 1`,
    ).get(c.proposal_id, c.commit_sha);
    if (exists) continue;
    const reason = c.verdict === "drift"
      ? `diff_verification_drift: claimed apply at ${c.commit_sha.slice(0, 10)} does not contain proposed before/after markers`
      : `diff_verification_missing: claimed apply at ${c.commit_sha.slice(0, 10)} not present in git history`;
    const r = await mcpCall("substrate.emit", {
      kind: "knowledge_contradiction_observed",
      substrate_origin: "claude_root",
      directive_id: directiveId,
      context_refs: [c.proposal_id],
      payload: {
        knowledge_id: c.proposal_id,
        commit_sha: c.commit_sha,
        verdict: c.verdict,
        weight: 0.5,
        reason,
        evidence: [`acc verify ${directiveId.slice(0, 10)} classified the apply as ${c.verdict}`],
      },
    }).catch((err: Error) => ({ ok: false, error: err.message }));
    if (r.ok) emitted += 1;
  }
  return emitted;
};

export const runVerify = async (argv: string[]): Promise<number> => {
  if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(HELP); return 0; }
  const learn = !argv.includes("--no-learn");
  const repoIdx = argv.indexOf("--repo");
  const repoRoot = repoIdx >= 0 && argv[repoIdx + 1] ? resolve(argv[repoIdx + 1]!) : resolve(process.cwd());
  const positional = argv.filter((x, i) => !x.startsWith("--") && argv[i - 1] !== "--repo");
  const prefix = positional[0];
  if (!prefix) { process.stderr.write(`acc verify: missing <directive_id_prefix>\n${HELP}`); return 1; }
  const db = openDb(resolveDbPath());
  const directiveId = resolveDirective(db, prefix);
  if (!directiveId) {
    process.stderr.write(`acc verify: no unique directive matches prefix '${prefix}' (need 8+ chars, must match exactly one)\n`);
    return 1;
  }
  const status = rootStatus(db, directiveId);
  const totals = aggregateVerify(db, directiveId, repoRoot);
  process.stdout.write(renderReport(directiveId, status, totals));
  if (learn && totals.driftCases.length > 0) {
    const emitted = await emitDriftContradictions(db, directiveId, totals.driftCases);
    if (emitted > 0) {
      process.stdout.write(`\nlayer-2 self-healing: emitted ${emitted} knowledge_contradiction_observed event(s); brain posterior will demote on next Model-D tick.\n`);
    }
  }
  if (totals.drift > 0 || totals.missing > 0) return 2;
  if (totals.stranded.length > 0) return 1;
  return 0;
};

if (import.meta.main) {
  void runVerify(process.argv.slice(2)).then((code) => process.exit(code));
}
