// acc2 resource URI parser - domain-neutral provenance handles.

export const RESOURCE_URI_SCHEMES = [
  "repo",
  "url",
  "calendar",
  "sensor",
  "browser_session",
  "ledger",
  "contact",
  // C5 (2026-05-18, contract HJJS1665H961B2SRYHC5J85D14): external Drive
  // doc handle. Canonical form is `drive://document/<doc_id>` so the
  // scheme separator is `:` (split at the first `:`) and the resource
  // `id` becomes `//document/<doc_id>`. Validation requires that prefix
  // — a bare `drive:foo` is refused so provenance URIs are unambiguous.
  "drive",
] as const;

export type ResourceUriScheme = typeof RESOURCE_URI_SCHEMES[number];

export type ResourceUri = {
  uri: string;
  scheme: ResourceUriScheme;
  id: string;
};

export type ResourceRef = ResourceUri;

const SCHEMES = new Set<string>(RESOURCE_URI_SCHEMES);

const normalizeRepoId = (id: string): string | null => {
  const normalized = id.replace(/^\.\//, "");
  if (normalized.length === 0 || normalized.startsWith("/")) return null;
  if (normalized.split("/").some((part) => part === "..")) return null;
  return normalized;
};

export const parseResourceUri = (raw: unknown): ResourceUri | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const sep = trimmed.indexOf(":");
  if (sep <= 0) return null;
  const scheme = trimmed.slice(0, sep).toLowerCase();
  let id = trimmed.slice(sep + 1);
  if (!SCHEMES.has(scheme)) return null;
  if (id.length === 0 || /\s/.test(id)) return null;
  if (scheme === "repo") {
    const normalized = normalizeRepoId(id);
    if (!normalized) return null;
    id = normalized;
  }
  if (scheme === "url") {
    try {
      const u = new URL(id);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      id = u.href;
    } catch { return null; }
  }
  if (scheme === "drive") {
    // Canonical Drive document handle: `drive://document/<doc_id>`. After
    // splitting at the first `:` the remainder is `//document/<doc_id>`.
    // Refuse anything else so provenance citations are unambiguous.
    if (!id.startsWith("//document/")) return null;
    const docId = id.slice("//document/".length);
    if (docId.length === 0 || /\s|\//.test(docId)) return null;
  }
  return { uri: `${scheme}:${id}`, scheme: scheme as ResourceUriScheme, id };
};

export const parseResourceRef = parseResourceUri;

export const parseResourceRefs = (raw: unknown): ResourceRef[] | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { value = [raw]; }
  }
  if (!Array.isArray(value)) return null;
  const refs: ResourceRef[] = [];
  for (const item of value) {
    const parsed = parseResourceUri(typeof item === "object" && item !== null && "uri" in item ? (item as { uri: unknown }).uri : item);
    if (!parsed) return null;
    refs.push(parsed);
  }
  return refs.length > 0 ? refs : null;
};

export const resourcesFromTargetFiles = (targetFiles: string[] | null | undefined): ResourceRef[] | null => {
  if (!targetFiles || targetFiles.length === 0) return null;
  const refs = targetFiles.map((file) => parseResourceUri("repo:" + file));
  return refs.every(Boolean) ? refs as ResourceRef[] : null;
};

export const repoTargetFilesFromResources = (resources: ResourceRef[] | null | undefined): string[] | null => {
  const files = (resources ?? []).filter((r) => r.scheme === "repo").map((r) => r.id);
  return files.length > 0 ? files : null;
};

const globToRegExp = (glob: string): RegExp => new RegExp(
  "^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
);

export const resourceMatchesPattern = (
  target: ResourceRef,
  patternKind: "extension" | "prefix" | "exact" | "glob",
  rawPattern: string,
): boolean => {
  const pattern = parseResourceUri(rawPattern);
  if (!pattern || pattern.scheme !== target.scheme) return false;
  switch (patternKind) {
    case "extension":
      return target.id.endsWith(pattern.id);
    case "prefix":
      return target.id.startsWith(pattern.id);
    case "exact":
      return target.id === pattern.id;
    case "glob":
      return globToRegExp(pattern.id).test(target.id);
    default:
      return false;
  }
};
