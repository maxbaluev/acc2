// acc2 render pipeline tests — Contract C2 (V32YTK7HKN6MS38KWJY1SKTXAW,
// directive QHTRBV6PFX2JVBMHDNDA4B03GC, 2026-05-18).
//
// Covers the helper validators (validateRenderedDocxAdmission /
// validatePublishedDriveDocAdmission) + an end-to-end
// renderMarkdownToDocx happy path when pandoc is available. The happy
// path test gracefully skips when no pandoc binary resolves so the
// suite stays hermetic on hosts without pandoc installed.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import {
  DOCX_REFERENCE_STYLE_KIND,
  MARKDOWN_BODY_KIND,
  RENDERED_DOCX_KIND,
  renderMarkdownToDocx,
  resolvePandocPath,
  validatePublishedDriveDocAdmission,
  validateRenderedDocxAdmission,
} from "./render_pipeline";
import { insertArtifact } from "./artifact_store";
import { REF_NEUTRAL_CLASSIC_DOCX_B64 } from "../substrate/ref_neutral_classic_docx";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const insertStub = (
  db: ReturnType<typeof openDb>,
  id: string,
  kind: string,
  body = `// stub ${id}`,
) =>
  insertArtifact(db, {
    id,
    runtime: "bun",
    kind,
    body,
    declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
    stateRoot: "test",
    posteriorAlpha: 1, posteriorBeta: 1, score: 0.5, confidence: 0.3,
    recentResidualMean: 0, recentKillCount: 0,
    status: "admitted",
    name: id,
    fixtureInput: null,
    fixtureExpectedResidual: 0.2,
    intent: null,
    summary: null,
    targetFiles: null,
    targetResources: null,
    sourceCandidateId: null,
    ownerGateVerdict: "auto",
  });

describe("validateRenderedDocxAdmission", () => {
  test("rejects when markdownBodyId is missing", () => {
    const db = openDb(":memory:");
    const r = validateRenderedDocxAdmission(db, {
      referenceDocxArtifactId: "ref1",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("rendered_docx_missing_markdown_body_id");
  });

  test("rejects when referenceDocxArtifactId is missing", () => {
    const db = openDb(":memory:");
    const r = validateRenderedDocxAdmission(db, {
      markdownBodyId: "md1",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("rendered_docx_missing_reference_docx_id");
  });

  test("rejects when markdownBodyId does not resolve", () => {
    const db = openDb(":memory:");
    insertStub(db, "ref1", DOCX_REFERENCE_STYLE_KIND);
    const r = validateRenderedDocxAdmission(db, {
      markdownBodyId: "ghost",
      referenceDocxArtifactId: "ref1",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("rendered_docx_unknown_markdown_body_id");
  });

  test("rejects when markdownBodyId resolves to wrong kind", () => {
    const db = openDb(":memory:");
    insertStub(db, "md1", "code_artifact");
    insertStub(db, "ref1", DOCX_REFERENCE_STYLE_KIND);
    const r = validateRenderedDocxAdmission(db, {
      markdownBodyId: "md1",
      referenceDocxArtifactId: "ref1",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("rendered_docx_markdown_body_kind_mismatch");
  });

  test("rejects when referenceDocxArtifactId resolves to wrong kind", () => {
    const db = openDb(":memory:");
    insertStub(db, "md1", MARKDOWN_BODY_KIND);
    insertStub(db, "ref1", "code_artifact");
    const r = validateRenderedDocxAdmission(db, {
      markdownBodyId: "md1",
      referenceDocxArtifactId: "ref1",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("rendered_docx_reference_docx_kind_mismatch");
  });

  test("admits when both inputs resolve to correct kinds", () => {
    const db = openDb(":memory:");
    insertStub(db, "md1", MARKDOWN_BODY_KIND);
    insertStub(db, "ref1", DOCX_REFERENCE_STYLE_KIND);
    const r = validateRenderedDocxAdmission(db, {
      markdownBodyId: "md1",
      referenceDocxArtifactId: "ref1",
    });
    expect(r.ok).toBe(true);
  });
});

describe("validatePublishedDriveDocAdmission — preview-first rule", () => {
  test("rejects when renderedDocxId is missing", () => {
    const db = openDb(":memory:");
    const r = validatePublishedDriveDocAdmission(
      db,
      {},
      ["drive://document/abc123"],
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("published_drive_doc_missing_rendered_docx_id");
  });

  test("rejects when renderedDocxId does not resolve", () => {
    const db = openDb(":memory:");
    const r = validatePublishedDriveDocAdmission(
      db,
      { renderedDocxId: "ghost" },
      ["drive://document/abc123"],
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("published_drive_doc_unknown_rendered_docx_id");
  });

  test("rejects when renderedDocxId resolves to wrong kind", () => {
    const db = openDb(":memory:");
    insertStub(db, "rd1", "code_artifact");
    const r = validatePublishedDriveDocAdmission(
      db,
      { renderedDocxId: "rd1" },
      ["drive://document/abc123"],
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("published_drive_doc_rendered_docx_kind_mismatch");
  });

  test("rejects when target_resources advertises application/pdf via mime=", () => {
    const db = openDb(":memory:");
    insertStub(db, "rd1", RENDERED_DOCX_KIND);
    const r = validatePublishedDriveDocAdmission(
      db,
      { renderedDocxId: "rd1" },
      ["drive://file/xyz?mime=application/pdf"],
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("published_drive_doc_pdf_forbidden_in_alex_path");
  });

  test("rejects when target_resources URI ends in .pdf", () => {
    const db = openDb(":memory:");
    insertStub(db, "rd1", RENDERED_DOCX_KIND);
    const r = validatePublishedDriveDocAdmission(
      db,
      { renderedDocxId: "rd1" },
      ["drive://file/abc.pdf"],
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("published_drive_doc_pdf_forbidden_in_alex_path");
  });

  test("admits when renderedDocxId resolves and target_resources is docx-shaped", () => {
    const db = openDb(":memory:");
    insertStub(db, "rd1", RENDERED_DOCX_KIND);
    const r = validatePublishedDriveDocAdmission(
      db,
      { renderedDocxId: "rd1" },
      ["drive://document/abc123"],
    );
    expect(r.ok).toBe(true);
  });
});

describe("renderMarkdownToDocx — happy path (skipped when pandoc unavailable)", () => {
  test("renders markdown_body × docx_reference_style → docxBytes + sha256 + residual=0", async () => {
    const pandoc = resolvePandocPath();
    if (!pandoc) {
      // Skip cleanly — the substrate scores pandoc_unavailable as a
      // configuration drift, not a test failure, on hosts without
      // pandoc installed. The validator tests above still exercise
      // the structural admission path.
      expect(true).toBe(true);
      return;
    }
    const db = openDb(":memory:");
    insertStub(
      db,
      "md_smoke",
      MARKDOWN_BODY_KIND,
      "# Render smoke\n\nBody paragraph for the C2 fixture test.\n",
    );
    insertStub(db, "ref_smoke", DOCX_REFERENCE_STYLE_KIND, REF_NEUTRAL_CLASSIC_DOCX_B64);
    const r = await renderMarkdownToDocx(db, {
      markdownBodyId: "md_smoke",
      referenceDocxArtifactId: "ref_smoke",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.residual).toBe(0);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.docxBytes.length).toBeGreaterThan(1000);
    expect(r.postProcessedSize).toBe(r.docxBytes.length);
  });

  test("refuses when markdown_body does not resolve", async () => {
    const db = openDb(":memory:");
    insertStub(db, "ref_smoke", DOCX_REFERENCE_STYLE_KIND, REF_NEUTRAL_CLASSIC_DOCX_B64);
    const r = await renderMarkdownToDocx(db, {
      markdownBodyId: "ghost",
      referenceDocxArtifactId: "ref_smoke",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("markdown_body_missing");
    expect(r.residual).toBe(1);
  });

  test("refuses when reference_docx_style does not resolve", async () => {
    const db = openDb(":memory:");
    insertStub(db, "md_smoke", MARKDOWN_BODY_KIND, "# stub\n");
    const r = await renderMarkdownToDocx(db, {
      markdownBodyId: "md_smoke",
      referenceDocxArtifactId: "ghost",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("reference_docx_missing");
    expect(r.residual).toBe(1);
  });

  test("refuses when reference docx kind is wrong", async () => {
    const db = openDb(":memory:");
    insertStub(db, "md_smoke", MARKDOWN_BODY_KIND, "# stub\n");
    insertStub(db, "ref_smoke", "code_artifact", REF_NEUTRAL_CLASSIC_DOCX_B64);
    const r = await renderMarkdownToDocx(db, {
      markdownBodyId: "md_smoke",
      referenceDocxArtifactId: "ref_smoke",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("reference_docx_kind_mismatch");
    expect(r.residual).toBe(1);
  });
});
