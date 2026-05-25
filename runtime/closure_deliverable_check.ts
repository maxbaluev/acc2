// acc2 closure deliverable check — substrate-side helper for the
// brain_prompt workflow policy step-7 closure verifier. Resolves the verifier_gap lesson
// from brain audit QQEHAW97GS0AX7TEQ717Y3P174: the closure audit previously
// only verified subtree STRUCTURE (task_node_opened + task_edge_recorded
// presence). Deliverable-shaped leaves could close without ever emitting
// concrete artifacts (act_artifact_candidate / contract_amendment_proposed
// / lesson_extracted{proposed_action}). Symptom: dispatch CBKDWYRN
// closure_residual=0.05 while B3-style leaves "expose a concise growth
// report..." committed empty.
//
// This helper mirrors the deliverable-check semantics of
// runtime/proposal_grounding.ts (same imperative-verb set, same subtree
// algorithm) but applies at CLOSURE time over the WHOLE subtree and ONLY
// the DEEPEST tasks (leaves with no refines children). Structural
// (non-leaf) tasks are exempt — their concrete output is the children.
//
// Wiring into the closure_audited emit path is a follow-on amendment;
// this commit establishes the verifiable helper.

import type { Database } from "bun:sqlite";
import { ARTIFACT_CANDIDATE_KINDS } from "../substrate/event_kinds";
import type { JsonValue } from "../substrate/types";

export interface ClosureDeliverableResult {
  ok: boolean;
  uncovered_leaves: string[]; // task_ids whose goal verb implied a deliverable but none was emitted
}

const parsePayload = (raw: string): Record<string, JsonValue> => {
  try { return JSON.parse(raw ?? "{}") as Record<string, JsonValue>; } catch { return {}; }
};

// Universal-workflow replacement (brain amendment WDENAD6W4X62S53EQNVS2ZB4VR
// from regex anti-pattern audit, 2026-05-16): a task is "deliverable-shaped"
// when its task_node_opened payload DECLARES it — not when its English goal
// text matches a hand-rolled keyword regex. Three structural signals:
//   - payload.requires_deliverable === true
//   - payload.deliverable_required === true (alternate spelling for older recipes)
//   - payload.expected_outputs is a non-empty array
// Brain-authored task_node_opened payloads now set these explicitly; the
// closure verifier doesn't have to guess from natural language. (The
// DELIVERABLE_VERBS English-keyword regex + isDeliverableGoal(goal) function
// was removed in the same commit.)
const taskRequiresDeliverable = (payload: Record<string, JsonValue>): boolean => {
  if (payload.requires_deliverable === true) return true;
  if (payload.deliverable_required === true) return true;
  const expected = payload.expected_outputs;
  return Array.isArray(expected) && expected.length > 0;
};

// amendment #5 deliverable_body_verifier_hard_gate
// ------------------------------------------------
// PROBLEM: a declared deliverable leaf was treated as "covered" by the mere
// PRESENCE of an act_artifact_candidate — the body was never inspected. So a
// document-production leaf could commit a plan/outline/summary stub and still
// pass closure at residual < 0.3. (Observed: inline-report runs committed a
// plan instead of a real report and the verifier accepted it.)
//
// FIX (scoped to DOCUMENT leaves only): for a leaf that the brain declared as
// a document-production deliverable, resolve the emitted artifact BODY and
// require a real, full, multi-section body. A document leaf whose only
// artifact is a summary/outline/stub stays UNCOVERED → flows into
// missing_deliverables → closure refused. NON-document deliverable leaves keep
// the existing presence check unchanged — we do NOT raise the bar for every
// deliverable, only document ones.
//
// DOCUMENT-LEAF DETECTION SIGNAL (structural, payload-declared — never an
// English-keyword regex, per the WDENAD6W universal-workflow amendment):
//   1. payload.deliverable_kind === "document" | "report" | "doc"
//      (explicit goal-declared document output), OR
//   2. payload.expected_outputs names a document/report/doc — i.e. at least
//      one expected_outputs entry is a string OR a { name|kind|type } object
//      whose value mentions one of DOCUMENT_OUTPUT_TOKENS. expected_outputs is
//      ALREADY a structural declaration the brain authors (not free-prose
//      goal text), so reading it here is reading a declared signal, not
//      guessing intent.
// A leaf that declares requires_deliverable but is NOT a document leaf by
// either signal keeps the presence-only check.
const DOCUMENT_DELIVERABLE_KINDS = new Set(["document", "report", "doc"]);
const DOCUMENT_OUTPUT_TOKENS = ["document", "report", "doc"];

// Body-quality thresholds for the document hard gate. Named so they are tuned
// in one place and cited by tests.
const DOC_MIN_BODY_CHARS = 400; // a real multi-section doc body, not a stub
const DOC_MIN_BODY_WORDS = 60;
const DOC_MIN_SECTIONS = 2; // more than one section/heading or paragraph block
// Markers that, when they DOMINATE the body, mean it is a plan/outline/summary
// substitute or placeholder rather than a finished document.
const DOC_STUB_MARKERS = [
  "summary:",
  "outline:",
  "plan:",
  "todo",
  "[insert",
  "placeholder",
  "tbd",
  "<fill",
  "lorem ipsum",
];

const expectedOutputEntries = (payload: Record<string, JsonValue>): JsonValue[] => {
  const expected = payload.expected_outputs;
  return Array.isArray(expected) ? expected : [];
};

const entryText = (entry: JsonValue): string => {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const o = entry as Record<string, JsonValue>;
    const parts = [o.name, o.kind, o.type, o.title, o.section]
      .filter((v): v is string => typeof v === "string");
    return parts.join(" ");
  }
  return "";
};

const isDocumentLeaf = (payload: Record<string, JsonValue>): boolean => {
  const dk = payload.deliverable_kind;
  if (typeof dk === "string" && DOCUMENT_DELIVERABLE_KINDS.has(dk.trim().toLowerCase())) {
    return true;
  }
  for (const entry of expectedOutputEntries(payload)) {
    const text = entryText(entry).toLowerCase();
    if (DOCUMENT_OUTPUT_TOKENS.some((tok) => text.includes(tok))) return true;
  }
  return false;
};

// expected_outputs may name required SECTIONS the finished document must
// contain. We treat a named section as an expected_outputs entry (string or
// {name|title|section}) that is NOT itself just a document/report/doc-kind
// marker — i.e. it names actual content the body must cover. When such
// sections are named, hasRealDocumentBody requires each to appear in the body.
const expectedSectionNames = (payload: Record<string, JsonValue>): string[] => {
  const names: string[] = [];
  for (const entry of expectedOutputEntries(payload)) {
    if (typeof entry === "string") {
      const t = entry.trim();
      if (t.length === 0) continue;
      // A bare "document"/"report"/"doc" token is a TYPE marker, not a section.
      if (DOCUMENT_OUTPUT_TOKENS.includes(t.toLowerCase())) continue;
      names.push(t);
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const o = entry as Record<string, JsonValue>;
      const sec = [o.section, o.title, o.name].find((v): v is string => typeof v === "string" && v.trim().length > 0);
      if (sec && !DOCUMENT_OUTPUT_TOKENS.includes(sec.trim().toLowerCase())) names.push(sec.trim());
    }
  }
  return names;
};

const countSections = (body: string): number => {
  // Count markdown headings first; if none, fall back to blank-line-separated
  // paragraph blocks. Either signal of multi-section structure suffices.
  const headings = (body.match(/^\s{0,3}#{1,6}\s+\S/gm) ?? []).length;
  if (headings > 0) return headings;
  const blocks = body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  return blocks.length;
};

/** Document-leaf body hard gate. Returns true only when `body` reads as a
 *  real, full, multi-section document — NOT a summary/outline/plan/stub. When
 *  `expectedSections` is non-empty, each named section must be present.
 *
 *  Checks (all must hold):
 *    - length ≥ DOC_MIN_BODY_CHARS and word count ≥ DOC_MIN_BODY_WORDS;
 *    - ≥ DOC_MIN_SECTIONS sections (headings, else paragraph blocks);
 *    - not dominated by stub/placeholder markers (a body whose only
 *      non-trivial content is "summary:"/"outline:"/"plan:"/"TODO"/"[insert"/
 *      placeholder text is rejected);
 *    - every expectedSection name present (case-insensitive substring). */
export const hasRealDocumentBody = (
  body: string | null | undefined,
  expectedSections: readonly string[] = [],
): boolean => {
  if (typeof body !== "string") return false;
  const text = body.trim();
  if (text.length < DOC_MIN_BODY_CHARS) return false;
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < DOC_MIN_BODY_WORDS) return false;
  if (countSections(text) < DOC_MIN_SECTIONS) return false;

  // Stub-dominance check: strip the stub markers and their trailing line; if
  // what remains is too thin to be a real document, the body was a substitute.
  const lower = text.toLowerCase();
  const hasStubMarker = DOC_STUB_MARKERS.some((m) => lower.includes(m));
  if (hasStubMarker) {
    // Remove lines that are dominated by a stub marker, then re-check the
    // residual real content against the char threshold. A finished document
    // that merely mentions the word "summary" in a heading keeps enough real
    // body to pass; a stub that IS a summary/outline collapses below it.
    const residual = text
      .split(/\r?\n/)
      .filter((line) => {
        const ll = line.toLowerCase().trim();
        if (ll.length === 0) return false;
        return !DOC_STUB_MARKERS.some((m) => ll.includes(m));
      })
      .join("\n")
      .trim();
    if (residual.length < DOC_MIN_BODY_CHARS) return false;
  }

  for (const section of expectedSections) {
    if (!lower.includes(section.toLowerCase())) return false;
  }
  return true;
};

// Walk the refines DAG starting from rootTaskId. Mirrors
// proposal_grounding.collectSubtreeTaskIds. Returns:
//   - subtree: every task_id in the refines closure (including root)
//   - children: parent-task_id → list of child task_ids (refines edges only)
const collectSubtree = (
  db: Database,
  rootTaskId: string,
): { subtree: Set<string>; children: Map<string, string[]> } => {
  const subtree = new Set<string>([rootTaskId]);
  const edgeRows = db
    .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded'")
    .all() as Array<{ payload: string }>;
  const children = new Map<string, string[]>();
  for (const e of edgeRows) {
    const p = parsePayload(e.payload);
    if ((p.kind as string) !== "refines") continue;
    const from = p.from_task as string | undefined;
    const to = p.to_task as string | undefined;
    if (!from || !to) continue;
    const list = children.get(from) ?? [];
    list.push(to);
    children.set(from, list);
  }
  const queue = [rootTaskId];
  while (queue.length > 0) {
    const next = queue.shift()!;
    for (const child of children.get(next) ?? []) {
      if (subtree.has(child)) continue;
      subtree.add(child);
      queue.push(child);
    }
  }
  return { subtree, children };
};

const eventsForTasks = (
  db: Database,
  taskIds: Set<string>,
  kind: string,
): Array<{ id: string; task_id: string; payload: Record<string, JsonValue> }> => {
  if (taskIds.size === 0) return [];
  const placeholders = Array.from(taskIds).map(() => "?").join(",");
  const rows = db
    .query(`SELECT id, task_id, payload FROM events WHERE kind = ? AND task_id IN (${placeholders})`)
    .all(kind, ...Array.from(taskIds)) as Array<{ id: string; task_id: string; payload: string }>;
  return rows.map((r) => ({ id: r.id, task_id: r.task_id, payload: parsePayload(r.payload) }));
};

// Resolve the best-available document body for a document leaf's artifact
// candidate. The body lives in the candidate event payload (payload.body); if
// the candidate was admitted, the act_artifact row (linked via
// source_candidate_id = candidate event id) holds the canonical stored body,
// which we prefer when present. Returns the longest resolvable body so a leaf
// that emitted both a stub candidate and a real admitted body is scored on the
// real one.
const resolveDocumentBody = (
  db: Database,
  candidate: { id: string; payload: Record<string, JsonValue> },
): string | null => {
  const bodies: string[] = [];
  const payloadBody = candidate.payload.body;
  if (typeof payloadBody === "string") bodies.push(payloadBody);
  try {
    const admitted = db
      .query<{ body: string }, [string]>(
        "SELECT body FROM act_artifact WHERE source_candidate_id = ? AND body IS NOT NULL",
      )
      .all(candidate.id);
    for (const a of admitted) if (typeof a.body === "string") bodies.push(a.body);
  } catch { /* act_artifact table absent in minimal fixtures — payload body only */ }
  if (bodies.length === 0) return null;
  return bodies.reduce((longest, b) => (b.length > longest.length ? b : longest), "");
};

export const checkClosureDeliverables = (
  db: Database,
  rootTaskId: string,
  _directiveId?: string,
): ClosureDeliverableResult => {
  const { subtree, children } = collectSubtree(db, rootTaskId);

  const nodes = eventsForTasks(db, subtree, "task_node_opened");
  // act_artifact_candidate is canonical; code_artifact_candidate is the
  // pre-rename alias retained for historical events on this directive.
  const artifacts = ARTIFACT_CANDIDATE_KINDS.flatMap((kind) => eventsForTasks(db, subtree, kind));
  const amendments = eventsForTasks(db, subtree, "contract_amendment_proposed");
  const lessons = eventsForTasks(db, subtree, "lesson_extracted");

  const uncovered: string[] = [];
  for (const n of nodes) {
    // Leaf-only check: a task with refines children is structural; its
    // deliverable is the children themselves, not a direct artifact.
    const kids = children.get(n.task_id) ?? [];
    if (kids.length > 0) continue;

    if (!taskRequiresDeliverable(n.payload)) continue;

    // amendment #5: DOCUMENT leaves require a real multi-section body, not the
    // mere presence of an artifact. A document leaf is covered ONLY when at
    // least one of its emitted artifact candidates (or its admitted body)
    // passes hasRealDocumentBody. amendments / lessons do NOT cover a document
    // leaf — a document-production task's deliverable IS the document body.
    if (isDocumentLeaf(n.payload)) {
      const sections = expectedSectionNames(n.payload);
      const leafArtifacts = artifacts.filter((a) => a.task_id === n.task_id);
      const hasRealBody = leafArtifacts.some((a) =>
        hasRealDocumentBody(resolveDocumentBody(db, a), sections),
      );
      if (!hasRealBody) uncovered.push(n.task_id);
      continue;
    }

    // Non-document deliverable leaves keep the existing PRESENCE check.
    const has = artifacts.some((a) => a.task_id === n.task_id)
      || amendments.some((a) => a.task_id === n.task_id)
      || lessons.some((l) => l.task_id === n.task_id && Boolean(l.payload.proposed_action));
    if (!has) uncovered.push(n.task_id);
  }

  return { ok: uncovered.length === 0, uncovered_leaves: uncovered };
};
