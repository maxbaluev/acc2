import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent, type EmittedEvent } from "./events";
import { newId } from "./ids";

export type ClaudeAgentJobRequest = {
  directive_id: string;
  task_id: string;
  intent: string;
  target_files?: string[];
  acceptance_predicate?: JsonValue;
  job_id?: string;
};

export type ClaudeAgentJobClaim = {
  job_id: string;
  claimant_peer_id: string;
  directive_id?: string;
  task_id?: string;
};

export type ClaudeAgentActTuple = {
  intent: string;
  reasoning_summary: string;
  effect_summary: string;
  verifier_kind: string;
  action_artifact_id: string;
  verifier_artifact_id: string;
  predicted_residual: number;
  observed_residual: number;
  cited_knowledge_ids?: string[];
  cited_artifact_ids?: string[];
  affected_resources?: string[];
  candidate_event_ids?: string[];
  co_actors?: string[];
};

export type ClaudeAgentJobCompletion = {
  job_id: string;
  directive_id: string;
  task_id: string;
  claimant_peer_id: string;
  act: ClaudeAgentActTuple;
};

export type ClaudeAgentPendingJob = {
  job_id: string;
  directive_id: string;
  task_id: string;
  intent: string;
  target_files: string[];
  acceptance_predicate: JsonValue;
  request_event_id: string;
  requested_ts: string;
  queue_status: "pending" | "stale_claim_requeued" | string;
  claim_event_id: string | null;
  claimant_peer_id: string | null;
};

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const requestJob = (db: Database, request: ClaudeAgentJobRequest): EmittedEvent & { job_id: string } => {
  const job_id = request.job_id ?? newId();
  const event = emitEvent(db, {
    kind: "claude_agent_job_requested",
    substrate_origin: "substrate_auto",
    directive_id: request.directive_id,
    task_id: request.task_id,
    payload: {
      job_id,
      directive_id: request.directive_id,
      task_id: request.task_id,
      intent: request.intent,
      target_files: request.target_files ?? [],
      acceptance_predicate: request.acceptance_predicate ?? {},
    },
  });
  return { ...event, job_id };
};

export const readPendingJobs = (db: Database, limit = 50): ClaudeAgentPendingJob[] => {
  const rows = db
    .query(`SELECT * FROM claude_agent_job_queue_view ORDER BY requested_ts ASC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    job_id: String(row.job_id),
    directive_id: String(row.directive_id),
    task_id: String(row.task_id),
    intent: String(row.intent ?? ""),
    target_files: parseJson<string[]>(row.target_files, []),
    acceptance_predicate: parseJson<JsonValue>(row.acceptance_predicate, {}),
    request_event_id: String(row.request_event_id),
    requested_ts: String(row.requested_ts),
    queue_status: String(row.queue_status),
    claim_event_id: typeof row.claim_event_id === "string" ? row.claim_event_id : null,
    claimant_peer_id: typeof row.claimant_peer_id === "string" ? row.claimant_peer_id : null,
  }));
};

export const claimJob = (db: Database, claim: ClaudeAgentJobClaim): EmittedEvent => {
  const pending = readPendingJobs(db, 200).find((job) => job.job_id === claim.job_id);
  if (!pending) throw new Error(`claude_agent_job_not_pending:${claim.job_id}`);
  return emitEvent(db, {
    kind: "claude_agent_job_claimed",
    substrate_origin: "claude_agent",
    directive_id: claim.directive_id ?? pending.directive_id,
    task_id: claim.task_id ?? pending.task_id,
    payload: {
      job_id: claim.job_id,
      claimant_peer_id: claim.claimant_peer_id,
      directive_id: claim.directive_id ?? pending.directive_id,
      task_id: claim.task_id ?? pending.task_id,
    },
  });
};

export const completeJob = (db: Database, completion: ClaudeAgentJobCompletion): { act: EmittedEvent; completed: EmittedEvent } => {
  const act = emitEvent(db, {
    kind: "act_tuple_recorded",
    substrate_origin: "claude_agent",
    directive_id: completion.directive_id,
    task_id: completion.task_id,
    action_artifact_id: completion.act.action_artifact_id,
    verifier_artifact_id: completion.act.verifier_artifact_id,
    predicted_residual: completion.act.predicted_residual,
    residual: completion.act.observed_residual,
    payload: {
      ...completion.act,
      co_actors: Array.from(new Set([...(completion.act.co_actors ?? []), completion.claimant_peer_id])),
      source_act_id: `claude_agent_job:${completion.job_id}`,
    },
  });
  const completed = emitEvent(db, {
    kind: "claude_agent_job_completed",
    substrate_origin: "claude_agent",
    directive_id: completion.directive_id,
    task_id: completion.task_id,
    context_refs: [act.id],
    payload: {
      job_id: completion.job_id,
      act_id: act.id,
      claimant_peer_id: completion.claimant_peer_id,
      directive_id: completion.directive_id,
      task_id: completion.task_id,
    },
  });
  return { act, completed };
};
