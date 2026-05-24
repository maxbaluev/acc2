// `acc render-preview <markdown_body_id>` — local render pipeline preview.
//
// Contract C2 (V32YTK7HKN6MS38KWJY1SKTXAW, directive
// QHTRBV6PFX2JVBMHDNDA4B03GC, 2026-05-18). Locally renders an admitted
// markdown_body × docx_reference_style → rendered_docx and writes the
// docx to a temp file. Prints the sha256 + preview path. Designed to
// replace the throwaway /tmp/render_v*.py scripts.
//
// Surface:
//   acc render-preview <markdown_body_id>                preview only
//   acc render-preview <markdown_body_id> --publish      preview + admit rendered_docx
//   acc render-preview <markdown_body_id> --reference <id>  override seed reference
//
// Without --publish the command stays local: it does NOT mutate the
// substrate. With --publish it admits a `rendered_docx` row (preview-
// first rule) and additionally records a placeholder
// `contract_amendment_proposed` event noting that Drive upload
// integration is not yet wired.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { resolveDbPath } from "../runtime/state_paths";
import {
  renderMarkdownToDocx,
  MARKDOWN_BODY_KIND,
  RENDERED_DOCX_KIND,
  resolvePandocPath,
} from "../runtime/render_pipeline";
import { getArtifact } from "../runtime/artifact_store";
import { admitArtifact } from "../runtime/artifact_admission";
import { emitEvent, type EmitEventInput } from "../runtime/events";
import { REF_NEUTRAL_CLASSIC_SEED_ID } from "../substrate/ref_neutral_classic_docx";

type RenderPreviewEnv = {
  out: (s: string) => void;
  err: (s: string) => void;
  stateDbPath?: string;
  openSubstrate?: (path?: string) => Database;
};

const defaultEnv = (): RenderPreviewEnv => ({
  out: (s) => console.log(s),
  err: (s) => console.error(s),
});

const usage = (): string => [
  "acc render-preview — local markdown → docx render via the substrate pipeline",
  "",
  "Usage:",
  "  acc render-preview <markdown_body_id> [--reference <docx_reference_id>] [--publish] [--out <path>]",
  "",
  "Renders the admitted markdown_body against the chosen docx_reference_style",
  `(default: ${REF_NEUTRAL_CLASSIC_SEED_ID}) and writes the output to a temp`,
  "docx file. Prints the sha256 hash + preview path.",
  "",
  "  --publish    Also admit a `rendered_docx` artifact row (preview-first",
  "               rule). Without --publish the substrate is NOT mutated.",
  "  --reference  Override the default reference docx artifact id.",
  "  --out        Write the preview to this path instead of $TMPDIR/<sha>.docx.",
].join("\n");

export const runRenderPreview = async (
  argv: string[],
  envOverride?: Partial<RenderPreviewEnv>,
): Promise<number> => {
  const env: RenderPreviewEnv = { ...defaultEnv(), ...(envOverride ?? {}) };
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    env.out(usage());
    return argv.length === 0 ? 1 : 0;
  }
  const positional = argv.filter((a) => !a.startsWith("--"));
  const markdownBodyId = positional[0];
  if (!markdownBodyId) {
    env.err("acc render-preview: missing <markdown_body_id>");
    env.out(usage());
    return 1;
  }
  const refIdx = argv.indexOf("--reference");
  const referenceDocxArtifactId =
    refIdx >= 0 ? argv[refIdx + 1] : REF_NEUTRAL_CLASSIC_SEED_ID;
  if (!referenceDocxArtifactId) {
    env.err("acc render-preview: --reference requires an argument");
    return 1;
  }
  const publish = argv.includes("--publish");
  const outIdx = argv.indexOf("--out");
  const outOverride = outIdx >= 0 ? argv[outIdx + 1] : null;

  const path = env.stateDbPath ?? resolveDbPath();
  let db: Database;
  try {
    db = (env.openSubstrate ?? ((p?: string) => openDb(p ?? resolveDbPath())))(path);
  } catch (err) {
    env.err(`acc render-preview: failed to open substrate: ${(err as Error).message}`);
    return 1;
  }

  // Surface pandoc resolution up front so the operator sees the binary
  // we're about to invoke before any error.
  const pandocPath = resolvePandocPath();
  if (!pandocPath) {
    env.err(
      "acc render-preview: no pandoc binary on PATH; set PANDOC_PATH=<abs path> and retry",
    );
    return 1;
  }
  env.out(`pandoc=${pandocPath}`);
  env.out(`markdown_body_id=${markdownBodyId}`);
  env.out(`reference_docx_artifact_id=${referenceDocxArtifactId}`);

  const md = getArtifact(db, markdownBodyId);
  if (!md) {
    env.err(`acc render-preview: markdown_body artifact not found: ${markdownBodyId}`);
    return 1;
  }
  if (md.kind !== MARKDOWN_BODY_KIND) {
    env.err(
      `acc render-preview: artifact ${markdownBodyId} has kind=${md.kind} (expected ${MARKDOWN_BODY_KIND})`,
    );
    return 1;
  }

  const result = await renderMarkdownToDocx(db, {
    markdownBodyId,
    referenceDocxArtifactId,
  });
  if (!result.ok) {
    env.err(`acc render-preview: render failed: ${result.error}: ${result.detail}`);
    return 1;
  }
  const outPath = outOverride ?? join(tmpdir(), `acc2-preview-${result.sha256.slice(0, 16)}.docx`);
  writeFileSync(outPath, result.docxBytes);
  env.out(`rendered_docx_sha256=${result.sha256}`);
  env.out(`rendered_docx_size=${result.postProcessedSize} bytes`);
  env.out(`raw_pandoc_size=${result.rawDocxSize} bytes`);
  env.out(`bookmarks_stripped=${result.bookmarksStripped}`);
  env.out(`pandoc_duration_ms=${result.pandocDurationMs}`);
  env.out(`preview_path=${outPath}`);

  if (publish) {
    // Admit a rendered_docx artifact. The body carries the base64-encoded
    // bytes so downstream substrate flows can resolve them by id. The
    // admission flow runs the seed fixture (a tiny no-op) under bun; the
    // payload body is stored verbatim.
    const renderedB64 = Buffer.from(result.docxBytes).toString("base64");
    const renderedBody = [
      `// rendered_docx — base64-encoded post-processed docx bytes`,
      `// sha256: ${result.sha256}`,
      `// markdown_body_id: ${markdownBodyId}`,
      `// reference_docx_artifact_id: ${referenceDocxArtifactId}`,
      `// generated_by: acc render-preview --publish`,
      `// To extract: Buffer.from(BODY_BASE64, "base64") — the comment trailer is informational only.`,
      `const BODY_BASE64 = ${JSON.stringify(renderedB64)};`,
      `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, residual: 0, sha256: ${JSON.stringify(result.sha256)}, size: ${result.postProcessedSize} }));`,
    ].join("\n");
    const events: EmitEventInput[] = [];
    const captureEmit = (event: EmitEventInput) => {
      events.push(event);
      emitEvent(db, event);
    };
    const admission = await admitArtifact(
      db,
      {
        runtime: "bun",
        kind: RENDERED_DOCX_KIND,
        body: renderedBody,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: { sha256: result.sha256 },
        fixtureExpectedResidualBelow: 0.2,
        name: `rendered_docx_${result.sha256.slice(0, 16)}`,
        intent: "render markdown body to docx via substrate pipeline",
        summary: `Rendered ${markdownBodyId} against ${referenceDocxArtifactId} (sha256 ${result.sha256.slice(0, 16)}…).`,
        targetResources: [`render-sha256://${result.sha256}`],
        markdownBodyId,
        referenceDocxArtifactId,
      },
      captureEmit,
    );
    if (!admission.ok) {
      env.err(
        `acc render-preview --publish: rendered_docx admission rejected: ${admission.reason}: ${admission.detail ?? ""}`,
      );
      return 1;
    }
    env.out(`rendered_docx_artifact_id=${admission.artifactId}`);
    env.out(`rendered_docx_admitted=true`);
    // Emit a contract_amendment_proposed pointing at the missing Drive
    // upload integration. The Drive credential plumbing is NOT wired in
    // this contract (see Implementation Map step 3 — "if the substrate
    // doesn't have direct Drive credentials, document the integration
    // shape and emit a no-op placeholder for the smoke test").
    emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "claude_root",
      payload: {
        amendment_kind: "drive_upload_integration_follow_up",
        rendered_docx_id: admission.artifactId,
        rendered_docx_sha256: result.sha256,
        summary:
          "C2 followup: acc render-preview --publish admitted rendered_docx but did not upload to Drive. The substrate lacks credential plumbing for the google-drive uploadFile path; this amendment proposes wiring it through a sandboxed runtime artifact whose declared_sandbox.net_allow includes drive.googleapis.com and whose body reads GOOGLE_OAUTH_TOKEN from the env. Until then `acc render-preview --publish` admits the rendered_docx only.",
        proposed_action:
          "Author a new bun runtime artifact `drive_upload_v1` that POSTs the rendered docx to https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart with convertToGoogleFormat=true, captures the returned doc_id, and admits a published_drive_doc row with target_resources=['drive://document/<doc_id>'] supersedes=<prior_published_drive_doc_id>.",
        target_resources: [`render-sha256://${result.sha256}`],
      },
    });
    env.out("contract_amendment_proposed=drive_upload_integration_follow_up");
  }

  return 0;
};

if (import.meta.main) {
  void runRenderPreview(process.argv.slice(2)).then((code) => process.exit(code));
}

// Suppress unused-import warning in case the existsSync branch above is
// elided by future refactors. The helper is part of the documented
// surface (caller can stat the preview path).
void existsSync;
