/**
 * citations.js — \cite{} extraction and validation against summaries.
 *
 * Registers: validate_citations.
 *
 * Also exports extractCitationKeys / collectAllCitations for use by commit.js.
 *
 * Cite parsing rules:
 *   - Recognizes \cite, \citep, \citet, \citeauthor, \citeyear, \citealt,
 *     \citealp, \Cite, \Citep, \Citet (case variants), plus the starred forms.
 *   - Handles comma-separated keys inside one \cite{a, b, c}.
 *   - Optional bracketed prenote/postnote forms \cite[pre][post]{key} are handled.
 *   - Comment lines (those whose first non-whitespace char is %) are skipped.
 *     We don't handle mid-line %; doing so safely requires real LaTeX tokenizing.
 *   - \nocite{} is explicitly EXCLUDED (per spec: not cited in text).
 */

import { z } from "zod";
import { getProject } from "./latex_client.js";
import { readSummary } from "./literature.js";

// projectName REQUIRED — no default. See latex_tools.js for rationale.
const PROJ = z.string().min(1).describe("Project identifier (required, no default)");

// Match: \cite, \citep, \citet, \citeauthor, \citeyear, \citealt, \citealp,
// \citenum, \citetext, capitalized variants, all with optional star and optional
// [pre][post] bracketed args, then the mandatory {keys} group.
//
// Group 1 captures the comma-separated key list.
const CITE_RE =
  /\\(?:[Cc]ite(?:p|t|author|year|alt|alp|num|text)?\*?)\s*(?:\[[^\]]*\])?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;

/**
 * Strip lines that are pure LaTeX comments (first non-ws char is %).
 * We intentionally do NOT strip mid-line comments — that requires escaping
 * \% handling and full tokenizing. This is good enough for the common case
 * of "% \cite{wip}" sitting on its own line.
 */
function stripCommentLines(content) {
  return content
    .split("\n")
    .map((line) => (/^\s*%/.test(line) ? "" : line))
    .join("\n");
}

/**
 * Extract citation keys from a single .tex file's content.
 * Returns: Array<{ key: string, line: number }>
 */
export function extractCitationKeys(content) {
  const stripped = stripCommentLines(content);
  const results = [];

  let match;
  CITE_RE.lastIndex = 0;
  while ((match = CITE_RE.exec(stripped)) !== null) {
    const keysGroup = match[1];
    const line = stripped.slice(0, match.index).split("\n").length;
    const keys = keysGroup
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    for (const key of keys) {
      results.push({ key, line });
    }
  }
  return results;
}

/**
 * Walk all .tex files in a project and collect every citation key + where it appeared.
 * Returns: Map<key, Array<{file, line}>>
 */
export async function collectAllCitations(projectName) {
  const client = getProject(projectName);
  const files = await client.listFiles(".tex");
  const occurrences = new Map();

  for (const file of files) {
    const content = await client.readFile(file);
    const found = extractCitationKeys(content);
    for (const { key, line } of found) {
      if (!occurrences.has(key)) occurrences.set(key, []);
      occurrences.get(key).push({ file, line });
    }
  }
  return occurrences;
}

/**
 * Validate every cited key against the research folder's summaries.
 * Returns:
 *   {
 *     ok:         [{ key, occurrences: [...] }],
 *     incomplete: [{ key, reason, occurrences: [...] }],
 *     total_cited: number,
 *     scanned_files: number
 *   }
 *
 * "incomplete" covers every variant: folder missing, summary.md missing,
 * JSON block missing/malformed, required field missing/empty/over-cap.
 */
export async function validateCitations(projectName) {
  const client = getProject(projectName);
  const scannedFiles = (await client.listFiles(".tex")).length;
  const occurrences = await collectAllCitations(projectName);

  const ok = [];
  const incomplete = [];

  for (const [key, occs] of occurrences.entries()) {
    const result = readSummary(projectName, key);
    if (result.ok) {
      ok.push({ key, occurrences: occs });
    } else {
      incomplete.push({ key, reason: result.reason, occurrences: occs });
    }
  }

  // Sort for stable output.
  ok.sort((a, b) => a.key.localeCompare(b.key));
  incomplete.sort((a, b) => a.key.localeCompare(b.key));

  return {
    ok,
    incomplete,
    total_cited: occurrences.size,
    scanned_files: scannedFiles,
  };
}

export function register(server) {
  server.tool(
    "validate_citations",
    "Scan all .tex files in the project, extract \\cite{} keys, and verify every cited " +
      "key has a complete summary at <research_folder>/<key>/summary.md. " +
      "Returns { ok: [...], incomplete: [...] }. " +
      "commit_and_push refuses to run when incomplete is non-empty.",
    { projectName: PROJ },
    async ({ projectName }) => {
      const result = await validateCitations(projectName);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
