// acc2 pending contract amendment backlog-selection verifier.
// Deterministic scoring surface for F16-F18 implementation selection.

import type { PendingContractAmendmentRow } from "../substrate/views";

export type PendingAmendmentBacklogSelectionInput = {
  rows: PendingContractAmendmentRow[];
  selected_proposal_id?: string | null;
};

export type PendingAmendmentBacklogSelectionResult = {
  residual: number;
  breakdown: Record<string, number>;
  reliability_profile: Record<string, number>;
  expected_top_proposal_id: string | null;
  selected_proposal_id: string | null;
  expected_triage_state: string | null;
  eligible_for_f16_f18_implementation: boolean;
  reason: string;
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const hasTriageMetadata = (row: PendingContractAmendmentRow): boolean => (
  typeof row.triage_state === "string"
  && typeof row.triage_reason === "string"
  && typeof row.selection_priority === "number"
  && typeof row.selection_rank === "number"
  && Array.isArray(row.missing_fields)
  && typeof row.open_dependency_count === "number"
);

const sortRows = (rows: PendingContractAmendmentRow[]): PendingContractAmendmentRow[] =>
  [...rows].sort((a, b) => (a.selection_rank - b.selection_rank)
    || (b.selection_priority - a.selection_priority)
    || a.ts.localeCompare(b.ts)
    || a.proposal_id.localeCompare(b.proposal_id));

export const evaluatePendingAmendmentBacklogSelection = (
  input: PendingAmendmentBacklogSelectionInput,
): PendingAmendmentBacklogSelectionResult => {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const selectedProposalId = input.selected_proposal_id ?? null;
  if (rows.length === 0) {
    return {
      residual: selectedProposalId === null ? 0 : 0.6,
      breakdown: { metadata_coverage: 0, unsettled_filter: 0, deterministic_order: 0, selected_top_match: selectedProposalId === null ? 0 : 1, implementation_gate: 0 },
      reliability_profile: { row_count: 0, triaged_row_count: 0, implementation_ready_count: 0, evidence_completeness: 1 },
      expected_top_proposal_id: null,
      selected_proposal_id: selectedProposalId,
      expected_triage_state: null,
      eligible_for_f16_f18_implementation: false,
      reason: selectedProposalId === null ? "empty backlog" : "selected a proposal from an empty backlog",
    };
  }

  const metadataMissing = rows.filter((row) => !hasTriageMetadata(row)).length;
  const settledRows = rows.filter((row) => row.latest_closure_verdict !== null || row.has_applied_change).length;
  const ordered = sortRows(rows);
  const deterministicOrderBreaks = rows.filter((row, index) => row.proposal_id !== ordered[index]?.proposal_id).length;
  const expectedTop = ordered[0] ?? null;
  const selectedTopMismatch = selectedProposalId === null || selectedProposalId === expectedTop?.proposal_id ? 0 : 1;
  const implementationGate = expectedTop?.triage_state === "ready_for_implementation" ? 0 : 1;

  const metadataResidual = clamp01(metadataMissing / rows.length);
  const settledResidual = clamp01(settledRows / rows.length);
  const orderResidual = clamp01(deterministicOrderBreaks / rows.length);
  const residual = clamp01(Math.max(metadataResidual, settledResidual, orderResidual, selectedTopMismatch, implementationGate * 0.5));
  const readyCount = rows.filter((row) => row.triage_state === "ready_for_implementation").length;

  return {
    residual,
    breakdown: {
      metadata_coverage: metadataResidual,
      unsettled_filter: settledResidual,
      deterministic_order: orderResidual,
      selected_top_match: selectedTopMismatch,
      implementation_gate: implementationGate,
    },
    reliability_profile: {
      row_count: rows.length,
      triaged_row_count: rows.length - metadataMissing,
      implementation_ready_count: readyCount,
      evidence_completeness: clamp01(1 - metadataResidual),
    },
    expected_top_proposal_id: expectedTop?.proposal_id ?? null,
    selected_proposal_id: selectedProposalId,
    expected_triage_state: expectedTop?.triage_state ?? null,
    eligible_for_f16_f18_implementation: residual < 0.3 && expectedTop?.triage_state === "ready_for_implementation",
    reason: expectedTop
      ? `top backlog proposal ${expectedTop.proposal_id} is ${expectedTop.triage_state}`
      : "empty backlog",
  };
};
