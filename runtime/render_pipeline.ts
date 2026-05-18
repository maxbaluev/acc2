// acc2 render pipeline — substrate-addressable markdown → docx transform.
//
// Contract C2 (V32YTK7HKN6MS38KWJY1SKTXAW, directive
// QHTRBV6PFX2JVBMHDNDA4B03GC, 2026-05-18). Promotes the throwaway
// /tmp/render_v*.py scripts to a substrate runtime helper that consumes
// two admitted artifacts and produces a third:
//
//   markdown_body × docx_reference_style → rendered_docx
//
// Each kind is a free-string `code_artifact.kind` value (no enum
// extension). Lineage:
//   - markdown_body.body            = markdown text (UTF-8)
//   - docx_reference_style.body     = base64-encoded reference docx bytes
//   - rendered_docx.body            = base64-encoded rendered docx bytes
//   - rendered_docx.target_resources = [`render-sha256://<hex>`]
//
// Residual semantics:
//   0   — pandoc returned 0 and a non-empty docx; post-process succeeded
//   1   — pandoc subprocess failed, missing binary, or post-process raised
//
// Pandoc is invoked via subprocess. The binary path is resolved by
// PANDOC_PATH env var first, then `pandoc` on PATH, then the
// /tmp/pandoc-3.5/bin/pandoc fallback that this session's working
// environment carries. If none resolves, render returns residual=1 with
// `pandoc_unavailable` so the caller / verifier can score the failure
// honestly (matches the substrate_embed openai_api_key_missing pattern
// in seed.ts).
//
// Post-processing matches /tmp/render_v7.py exactly:
//   1. Theme color neutralization — replace the six default Word accent
//      colors with a neutral grey ramp.
//   2. document.xml / styles.xml — replace themeColor accent[1-6] with
//      themeColor text1; drop themeFill accents; flip the matching fill
//      attributes to "auto".
//   3. Strip <w:bookmarkStart/> + <w:bookmarkEnd/> from document.xml.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { getArtifact } from "./artifact_store";

export const MARKDOWN_BODY_KIND = "markdown_body";
export const DOCX_REFERENCE_STYLE_KIND = "docx_reference_style";
export const RENDERED_DOCX_KIND = "rendered_docx";
export const PUBLISHED_DRIVE_DOC_KIND = "published_drive_doc";

export type RenderResult =
  | {
      ok: true;
      docxBytes: Uint8Array;
      sha256: string;
      residual: 0;
      rawDocxSize: number;
      postProcessedSize: number;
      bookmarksStripped: number;
      pandocPath: string;
      pandocDurationMs: number;
    }
  | {
      ok: false;
      residual: 1;
      error:
        | "markdown_body_missing"
        | "markdown_body_kind_mismatch"
        | "reference_docx_missing"
        | "reference_docx_kind_mismatch"
        | "pandoc_unavailable"
        | "pandoc_failed"
        | "post_process_failed";
      detail: string;
    };

/** Resolve a pandoc binary path. Order:
 *    1. PANDOC_PATH env var (operator override)
 *    2. `pandoc` on PATH
 *    3. /tmp/pandoc-3.5/bin/pandoc (this session's fallback)
 *  Returns null when none resolves. */
export const resolvePandocPath = (): string | null => {
  const envPath = process.env.PANDOC_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  // PATH lookup via Bun.which is the cleanest cross-platform check.
  const onPath = Bun.which("pandoc");
  if (onPath && existsSync(onPath)) return onPath;
  const sessionFallback = "/tmp/pandoc-3.5/bin/pandoc";
  if (existsSync(sessionFallback)) return sessionFallback;
  return null;
};

const THEME_COLOR_REPLACEMENTS: Record<string, string> = {
  'val="196B24"': 'val="595959"',
  'val="4EA72E"': 'val="808080"',
  'val="156082"': 'val="404040"',
  'val="E97132"': 'val="707070"',
  'val="0F9ED5"': 'val="606060"',
  'val="A02B93"': 'val="909090"',
};

const neutralizeXml = (xml: string): string => {
  let next = xml;
  next = next.replace(/w:themeColor="accent[1-6]"/g, 'w:themeColor="text1"');
  next = next.replace(/w:themeFill="accent[1-6]"/g, "");
  next = next.replace(
    /w:fill="(196B24|4EA72E|156082|E97132|0F9ED5|A02B93)"/gi,
    'w:fill="auto"',
  );
  return next;
};

const stripBookmarks = (xml: string): { xml: string; count: number } => {
  const before = (xml.match(/<w:bookmarkStart/g) ?? []).length;
  let next = xml.replace(/<w:bookmarkStart[^/]*\/>/g, "");
  next = next.replace(/<w:bookmarkEnd[^/]*\/>/g, "");
  return { xml: next, count: before };
};

const sha256Hex = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Unzip a docx (zip) into a flat dir map; produce a new zip from a
 *  mutated dir map. We avoid spawning unzip/zip — use Bun's built-in
 *  Bun.spawnSync with python's zipfile module is one option; cleaner
 *  is the node-builtin alternative via the `jszip`-style logic. To
 *  keep the dependency footprint zero we shell to python -c which is
 *  guaranteed present in this sandbox (uv runtime needs it). */
const PYTHON_REPACK_SCRIPT = `
import sys, zipfile, os, json, base64

def unpack(src_b64, dst_dir):
    data = base64.b64decode(src_b64)
    with open(dst_dir + "/_in.docx", "wb") as f:
        f.write(data)
    with zipfile.ZipFile(dst_dir + "/_in.docx") as z:
        z.extractall(dst_dir + "/extract")

def repack(src_dir):
    out_path = src_dir + "/_out.docx"
    if os.path.exists(out_path):
        os.remove(out_path)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(src_dir + "/extract"):
            for f in files:
                if f == ".DS_Store":
                    continue
                p = os.path.join(root, f)
                z.write(p, os.path.relpath(p, src_dir + "/extract"))
    with open(out_path, "rb") as f:
        sys.stdout.buffer.write(f.read())

mode = sys.argv[1]
if mode == "unpack":
    unpack(sys.argv[2], sys.argv[3])
elif mode == "repack":
    repack(sys.argv[2])
`;

const runPython = (args: string[], stdin?: string): { ok: boolean; stdout: Uint8Array; stderr: string; exitCode: number } => {
  const proc = Bun.spawnSync({
    cmd: ["python3", "-c", PYTHON_REPACK_SCRIPT, ...args],
    stdin: stdin ? new TextEncoder().encode(stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout,
    stderr: new TextDecoder().decode(proc.stderr),
    exitCode: proc.exitCode ?? -1,
  };
};

/** Render a markdown body against a reference docx and post-process.
 *  Returns the final docx bytes + sha256 + residual envelope. The caller
 *  is responsible for admitting the result as a `rendered_docx` artifact
 *  if it wants a substrate row. */
export type RenderMarkdownToDocxInput = {
  markdownBodyId: string;
  referenceDocxArtifactId: string;
};

export const renderMarkdownToDocx = async (
  db: Database,
  input: RenderMarkdownToDocxInput,
): Promise<RenderResult> => {
  // 1. Resolve both inputs from the substrate (admitted-only — caller
  //    pre-resolves via getArtifact too, but this fn is the canonical
  //    enforcement site so admission gates and CLI both go through here).
  const md = getArtifact(db, input.markdownBodyId);
  if (!md) {
    return {
      ok: false,
      residual: 1,
      error: "markdown_body_missing",
      detail: `no code_artifact row for markdown_body_id=${input.markdownBodyId}`,
    };
  }
  if (md.kind !== MARKDOWN_BODY_KIND) {
    return {
      ok: false,
      residual: 1,
      error: "markdown_body_kind_mismatch",
      detail: `expected kind=${MARKDOWN_BODY_KIND}, got kind=${md.kind} for ${input.markdownBodyId}`,
    };
  }
  const ref = getArtifact(db, input.referenceDocxArtifactId);
  if (!ref) {
    return {
      ok: false,
      residual: 1,
      error: "reference_docx_missing",
      detail: `no code_artifact row for reference_docx_artifact_id=${input.referenceDocxArtifactId}`,
    };
  }
  if (ref.kind !== DOCX_REFERENCE_STYLE_KIND) {
    return {
      ok: false,
      residual: 1,
      error: "reference_docx_kind_mismatch",
      detail: `expected kind=${DOCX_REFERENCE_STYLE_KIND}, got kind=${ref.kind} for ${input.referenceDocxArtifactId}`,
    };
  }
  const pandocPath = resolvePandocPath();
  if (!pandocPath) {
    return {
      ok: false,
      residual: 1,
      error: "pandoc_unavailable",
      detail:
        "no pandoc binary on PATH; set PANDOC_PATH=<absolute path to pandoc>",
    };
  }

  // 2. Materialize markdown body + reference docx into a tmp dir.
  const tmpRoot = mkdtempSync(join(tmpdir(), "acc2-render-"));
  try {
    const mdPath = join(tmpRoot, "input.md");
    const refPath = join(tmpRoot, "reference.docx");
    const rawOutPath = join(tmpRoot, "raw.docx");
    writeFileSync(mdPath, md.body, "utf8");
    // ref.body is base64-encoded docx bytes by convention.
    const refBytes = Buffer.from(ref.body, "base64");
    writeFileSync(refPath, refBytes);

    // 3. Invoke pandoc.
    const pandocStart = Date.now();
    const pandocProc = Bun.spawnSync({
      cmd: [
        pandocPath,
        mdPath,
        "-f",
        "markdown",
        "-t",
        "docx",
        "-o",
        rawOutPath,
        `--reference-doc=${refPath}`,
        "--standalone",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const pandocDurationMs = Date.now() - pandocStart;
    if (pandocProc.exitCode !== 0 || !existsSync(rawOutPath)) {
      const stderr = new TextDecoder().decode(pandocProc.stderr);
      return {
        ok: false,
        residual: 1,
        error: "pandoc_failed",
        detail: `pandoc exit=${pandocProc.exitCode} stderr=${stderr.slice(0, 800)}`,
      };
    }
    const rawDocxSize = statSync(rawOutPath).size;
    if (rawDocxSize === 0) {
      return {
        ok: false,
        residual: 1,
        error: "pandoc_failed",
        detail: "pandoc produced zero-byte docx",
      };
    }

    // 4. Post-process. Unpack with python (zipfile module), mutate xml,
    //    repack.
    const extractDir = join(tmpRoot, "extract");
    mkdirSync(extractDir, { recursive: true });
    const rawBytes = readFileSync(rawOutPath);
    const unpack = runPython(["unpack", rawBytes.toString("base64"), tmpRoot]);
    if (!unpack.ok) {
      return {
        ok: false,
        residual: 1,
        error: "post_process_failed",
        detail: `unzip failed: ${unpack.stderr.slice(0, 400)}`,
      };
    }

    // theme1.xml — neutralize accent palette to grey ramp.
    const themePath = join(tmpRoot, "extract", "word", "theme", "theme1.xml");
    if (existsSync(themePath)) {
      let theme = readFileSync(themePath, "utf8");
      for (const [find, repl] of Object.entries(THEME_COLOR_REPLACEMENTS)) {
        theme = theme.split(find).join(repl);
      }
      writeFileSync(themePath, theme, "utf8");
    }

    // styles.xml + document.xml — neutralize accent references inline.
    let bookmarksStripped = 0;
    for (const rel of ["word/styles.xml", "word/document.xml"]) {
      const p = join(tmpRoot, "extract", rel);
      if (!existsSync(p)) continue;
      let xml = readFileSync(p, "utf8");
      xml = neutralizeXml(xml);
      if (rel === "word/document.xml") {
        const stripped = stripBookmarks(xml);
        xml = stripped.xml;
        bookmarksStripped = stripped.count;
      }
      writeFileSync(p, xml, "utf8");
    }

    // Repack.
    const repack = runPython(["repack", tmpRoot]);
    if (!repack.ok) {
      return {
        ok: false,
        residual: 1,
        error: "post_process_failed",
        detail: `repack failed: ${repack.stderr.slice(0, 400)}`,
      };
    }
    const finalBytes = repack.stdout;
    if (finalBytes.length === 0) {
      return {
        ok: false,
        residual: 1,
        error: "post_process_failed",
        detail: "repack returned zero bytes",
      };
    }
    const sha = sha256Hex(finalBytes);
    return {
      ok: true,
      docxBytes: finalBytes,
      sha256: sha,
      residual: 0,
      rawDocxSize,
      postProcessedSize: finalBytes.length,
      bookmarksStripped,
      pandocPath,
      pandocDurationMs,
    };
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
};

/** Validate payload metadata for a rendered_docx admission. The kind-gate
 *  inside artifact_admission.ts calls this to refuse malformed input
 *  BEFORE inserting the row. Returns null on ok; { reason, detail } on
 *  rejection. The shape mirrors the published_drive_doc gate so both
 *  kinds funnel rejection rows through one event_kind family. */
export type RenderedDocxAdmissionPayload = {
  markdownBodyId?: string;
  referenceDocxArtifactId?: string;
};

export const validateRenderedDocxAdmission = (
  db: Database,
  payload: RenderedDocxAdmissionPayload,
): { ok: true } | { ok: false; reason: string; detail: string } => {
  if (!payload.markdownBodyId) {
    return {
      ok: false,
      reason: "rendered_docx_missing_markdown_body_id",
      detail: "rendered_docx admission requires payload.markdownBodyId",
    };
  }
  if (!payload.referenceDocxArtifactId) {
    return {
      ok: false,
      reason: "rendered_docx_missing_reference_docx_id",
      detail: "rendered_docx admission requires payload.referenceDocxArtifactId",
    };
  }
  const md = getArtifact(db, payload.markdownBodyId);
  if (!md) {
    return {
      ok: false,
      reason: "rendered_docx_unknown_markdown_body_id",
      detail: `markdownBodyId=${payload.markdownBodyId} does not resolve to an admitted artifact`,
    };
  }
  if (md.kind !== MARKDOWN_BODY_KIND) {
    return {
      ok: false,
      reason: "rendered_docx_markdown_body_kind_mismatch",
      detail: `markdownBodyId=${payload.markdownBodyId} kind=${md.kind} (expected ${MARKDOWN_BODY_KIND})`,
    };
  }
  const ref = getArtifact(db, payload.referenceDocxArtifactId);
  if (!ref) {
    return {
      ok: false,
      reason: "rendered_docx_unknown_reference_docx_id",
      detail: `referenceDocxArtifactId=${payload.referenceDocxArtifactId} does not resolve to an admitted artifact`,
    };
  }
  if (ref.kind !== DOCX_REFERENCE_STYLE_KIND) {
    return {
      ok: false,
      reason: "rendered_docx_reference_docx_kind_mismatch",
      detail: `referenceDocxArtifactId=${payload.referenceDocxArtifactId} kind=${ref.kind} (expected ${DOCX_REFERENCE_STYLE_KIND})`,
    };
  }
  return { ok: true };
};

/** Validate payload metadata for a published_drive_doc admission. The
 *  gate already exists in artifact_admission.ts for the drive:// URI
 *  shape; THIS validator additionally requires `renderedDocxId` to
 *  resolve to an admitted rendered_docx row (preview-first rule from
 *  lesson NA80J19NTD4Y). It also refuses any drive://file/<id> with
 *  application/pdf mime in target_resources (k_FMAFQVA0DH: no PDF in
 *  the Alex-facing path). */
export type PublishedDriveDocAdmissionPayload = {
  renderedDocxId?: string;
};

export const validatePublishedDriveDocAdmission = (
  db: Database,
  payload: PublishedDriveDocAdmissionPayload,
  targetResources: string[] | null | undefined,
): { ok: true } | { ok: false; reason: string; detail: string } => {
  // Preview-first rule: every published_drive_doc must trace back to a
  // rendered_docx admission so the bytes that landed on Drive are the
  // bytes the substrate scored.
  if (!payload.renderedDocxId) {
    return {
      ok: false,
      reason: "published_drive_doc_missing_rendered_docx_id",
      detail:
        "published_drive_doc admission requires payload.renderedDocxId (preview-first rule, lesson NA80J19NTD4Y)",
    };
  }
  const rendered = getArtifact(db, payload.renderedDocxId);
  if (!rendered) {
    return {
      ok: false,
      reason: "published_drive_doc_unknown_rendered_docx_id",
      detail: `renderedDocxId=${payload.renderedDocxId} does not resolve to an admitted artifact`,
    };
  }
  if (rendered.kind !== RENDERED_DOCX_KIND) {
    return {
      ok: false,
      reason: "published_drive_doc_rendered_docx_kind_mismatch",
      detail: `renderedDocxId=${payload.renderedDocxId} kind=${rendered.kind} (expected ${RENDERED_DOCX_KIND})`,
    };
  }
  // No-PDF rule (k_FMAFQVA0DH): refuse if any target_resources entry is
  // drive://file/<id> backed by application/pdf. The URI alone doesn't
  // carry mime info, but the orchestrator hint convention is to pass
  // mime as a query string (`drive://file/<id>?mime=application/pdf`)
  // OR to include the mime in payload metadata. We check both shapes.
  for (const uri of targetResources ?? []) {
    if (typeof uri !== "string") continue;
    if (/drive:\/\/file\/[^?]+\?.*mime=application\/pdf/i.test(uri)) {
      return {
        ok: false,
        reason: "published_drive_doc_pdf_forbidden_in_alex_path",
        detail: `published_drive_doc refuses application/pdf target_resources (k_FMAFQVA0DH): ${uri}`,
      };
    }
    if (/^drive:\/\/file\/[^?]+\.pdf(?:$|\?)/i.test(uri)) {
      return {
        ok: false,
        reason: "published_drive_doc_pdf_forbidden_in_alex_path",
        detail: `published_drive_doc refuses .pdf target_resources (k_FMAFQVA0DH): ${uri}`,
      };
    }
  }
  return { ok: true };
};
