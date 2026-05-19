#!/usr/bin/env bun
// scripts/retrieval-binding-hook.ts — Claude Code UserPromptSubmit hook
// that auto-retrieves top-K substrate knowledge for every owner prompt.
//
// Fundamental fix for k_252 / k_201:
//   - k_201 (retrieval binding) says knowledge compounds ONLY when
//     retrieval is behaviorally binding — citation without retrieval is
//     decorative memory (k_554).
//   - Opencode brain has an automatic prompt_composer that retrieves
//     top-K per cycle. Claude (orchestrator) had no equivalent — every
//     owner turn started "fresh" with no auto-injection of prior
//     promoted knowledge / lessons / contract_amendments on the topic.
//   - The substrate accumulates intelligence but the orchestrator
//     does NOT compound it. The merge breaks at the orchestrator's
//     input boundary.
//
// This hook fires at UserPromptSubmit, reads the owner's words, runs
// substrate.search via the local daemon's MCP surface, and emits the
// top-K retrieval as a system reminder Claude sees BEFORE composing
// any response. Fail-closed: if the daemon is unreachable, the hook
// degrades silently — owner workflow never blocked.
//
// Output contract: stdout is injected into Claude's context as a
// system block. Stderr is ignored by the hook runner. Exit 0 always
// (even on no hits / daemon down) so the prompt is never rejected.

import { mcpCall } from "../cli/rpc";

type HookInput = {
  hook_event_name?: string;
  prompt?: string;
  user_prompt?: string;
  cwd?: string;
};

type SearchHit = {
  event_id?: string;
  kind?: string;
  distance?: number;
  posterior?: number;
  rerank_score?: number;
  origin?: string;
  snippet?: string;
};

const INTERESTING_KINDS = new Set([
  "knowledge_candidate",
  "lesson_extracted",
  "contract_amendment_proposed",
  "knowledge_promoted",
  "owner_observed_outcome_recorded",
]);

const main = async (): Promise<void> => {
  // Read JSON input from stdin (Claude Code hook protocol).
  let raw = "";
  for await (const chunk of Bun.stdin.stream()) {
    raw += new TextDecoder().decode(chunk);
  }
  let input: HookInput = {};
  try { input = JSON.parse(raw) as HookInput; } catch { /* keep default */ }
  const promptText = (input.prompt ?? input.user_prompt ?? "").trim();
  if (promptText.length === 0) return;

  // Use the first ~400 chars as the retrieval query. Longer prompts
  // get truncated because the embedding is dominated by the first few
  // sentences anyway.
  const query = promptText.slice(0, 400);

  // Bounded retrieval — we ask for 12 hits, then filter to interesting
  // kinds (knowledge / lessons / amendments / promoted / negative owner
  // observations). Hits ranked by rerank_score (embedding × posterior).
  const env = await mcpCall("substrate.search", {
    query,
    limit: 12,
  }, { timeoutMs: 10_000 });
  if (!env.ok) return;
  const hits = ((env.result as { hits?: SearchHit[]; results?: SearchHit[] } | null)?.hits
    ?? (env.result as { results?: SearchHit[] } | null)?.results
    ?? []) as SearchHit[];
  const filtered = hits.filter((h) => INTERESTING_KINDS.has(h.kind ?? ""));
  if (filtered.length === 0) return;

  const surfaced = filtered.slice(0, 8);
  for (let rank = 0; rank < surfaced.length; rank++) {
    const h = surfaced[rank]!;
    if (!h.event_id) continue;
    await mcpCall("substrate.emit", {
      kind: "retrieval_binding",
      substrate_origin: "claude_root",
      context_refs: [h.event_id],
      payload: {
        query,
        source_event_id: h.event_id,
        rendered_snippet: h.snippet,
        rank,
        rerank_score: h.rerank_score,
        posterior: h.posterior,
        binding_surface: "claude_user_prompt_hook",
        source_actor: "claude_root",
        hook_event_name: input.hook_event_name ?? "UserPromptSubmit",
      },
    }, { timeoutMs: 10_000 });
  }

  // Compact format — Claude already has the prompt; just surface the
  // retrieved evidence handles + snippets so reasoning binds to them.
  const lines: string[] = [];
  lines.push("<retrieval-binding>");
  lines.push("Top substrate retrievals for this prompt (auto-injected by retrieval-binding-hook to close the k_201 advisory loop on the orchestrator side). Cite event_ids when they shape your response; citation without using is decorative memory (k_554).");
  lines.push("");
  for (const h of surfaced) {
    const snip = (h.snippet ?? "").replace(/\s+/g, " ").slice(0, 200);
    const score = typeof h.rerank_score === "number" ? h.rerank_score.toFixed(2)
      : typeof h.distance === "number" ? `d=${h.distance.toFixed(3)}` : "?";
    const id = (h.event_id ?? "").slice(0, 12);
    lines.push(`  - ${h.kind} ${id} score=${score} origin=${h.origin ?? "?"}: ${snip}`);
  }
  lines.push("");
  lines.push("If any retrieval directly answers the prompt, lead with it (and cite the event_id). If they conflict, surface the contradiction. If none match, say so explicitly — that itself is signal the substrate lacks coverage on this topic.");
  lines.push("</retrieval-binding>");
  process.stdout.write(lines.join("\n") + "\n");
};

main().catch(() => { /* degrade silently — never block the owner */ });
