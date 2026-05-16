/**
 * literature.js — paper summaries with enforced schema.
 *
 * Registers: add_paper, write_summary, get_summary, list_summaries.
 *
 * Two-tool flow:
 *   1. add_paper        — secures the paper's existence (folder + PDF)
 *   2. write_summary    — writes the four-field schema-validated summary.md
 *
 * Splitting these out makes each tool atomic, prevents PDF-fetch failures
 * from blocking summary writes, and forces the agent to acknowledge having
 * the PDF before it can record a summary (write_summary requires a .pdf
 * file present in the paper folder).
 *
 * Failure stickiness:
 *   When a PDF fetch fails (HTTP error, non-PDF content-type, network error),
 *   add_paper writes .fetch_failed.json into the paper folder. While that
 *   marker exists:
 *     - add_paper and write_summary refuse for that citation_key.
 *     - MODIFYING fs_* tools (fs_write, fs_mkdir, fs_delete, fs_move, fs_copy)
 *       refuse to touch anything in or under the folder.
 *     - READ fs_* tools (fs_read, fs_list, fs_exists) remain available so the
 *       agent can inspect the locked state and report it to the user.
 *   The marker can only be cleared from outside the MCP — the user runs
 *   `rm <path>` in a terminal. The MCP itself has no way to remove the
 *   marker, by design. This prevents agent-driven retries on a broken URL.
 *
 * Schema enforcement strategy:
 *   - Zod requires all four summary fields at the MCP tool boundary
 *     (the LLM cannot call write_summary without providing each one).
 *   - Each field is capped at MAX_FIELD_CHARS (1000) and must be non-empty
 *     after trimming.
 *   - The rendered summary.md contains human-readable markdown sections AND
 *     a machine-readable JSON block in an HTML comment. The JSON comment is
 *     the SOURCE OF TRUTH for validation. Hand-edits to the markdown body
 *     are clobbered on the next write_summary call.
 *
 * File format:
 *   # <citation_key>
 *
 *   <!-- research-mcp-schema: v1 -->
 *
 *   ## Contributions
 *   <text>
 *
 *   ## Weaknesses
 *   <text>
 *
 *   ## Relevance
 *   <text>
 *
 *   ## Key Result
 *   <text>
 *
 *   <!-- research-mcp-data
 *   {"contributions": "...", "weaknesses": "...", "relevance": "...", "key_result": "..."}
 *   -->
 */

import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { z } from "zod";
import { getResearchFolder, assertAllowed, PROTECTED_MARKER_FILENAME } from "./config.js";

export const SCHEMA_VERSION = "v1";
export const MAX_FIELD_CHARS = 1000;
export const REQUIRED_FIELDS = ["contributions", "weaknesses", "relevance", "key_result"];
// Re-exported for any external consumer; canonical definition lives in config.js.
export const FETCH_FAILED_MARKER = PROTECTED_MARKER_FILENAME;

const FIELD_TITLES = {
  contributions: "Contributions",
  weaknesses: "Weaknesses",
  relevance: "Relevance",
  key_result: "Key Result",
};

const DATA_COMMENT_RE = /<!--\s*research-mcp-data\s*([\s\S]*?)\s*-->/;

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/pdf,*/*",
};

// projectName REQUIRED on all literature tools — no default. See latex_tools.js.
const PROJ = z.string().min(1).describe("Project identifier (required, no default)");

const CITE_KEY = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9_\-:.+]+$/,
    "citation_key must match \\cite{} key syntax (letters, digits, _ - : . +)"
  )
  .describe("BibTeX citation key, e.g. vaswani2017attention");

// ---------------------------------------------------------------------------
// Rendering / parsing
// ---------------------------------------------------------------------------

export function renderSummaryMarkdown(citationKey, summary) {
  const lines = [`# ${citationKey}`, "", `<!-- research-mcp-schema: ${SCHEMA_VERSION} -->`, ""];
  for (const field of REQUIRED_FIELDS) {
    lines.push(`## ${FIELD_TITLES[field]}`);
    lines.push("");
    lines.push(summary[field]);
    lines.push("");
  }
  const dataObj = {};
  for (const field of REQUIRED_FIELDS) dataObj[field] = summary[field];
  lines.push("<!-- research-mcp-data");
  lines.push(JSON.stringify(dataObj));
  lines.push("-->");
  lines.push("");
  return lines.join("\n");
}

/**
 * Parse a summary.md file. Returns { ok: true, summary } or { ok: false, reason }.
 * The JSON comment is canonical.
 */
export function parseSummaryMarkdown(content) {
  if (typeof content !== "string" || !content.trim())
    return { ok: false, reason: "summary.md is empty" };

  const match = content.match(DATA_COMMENT_RE);
  if (!match)
    return { ok: false, reason: "research-mcp-data JSON block missing" };

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (e) {
    return { ok: false, reason: `research-mcp-data JSON is malformed: ${e.message}` };
  }

  if (!data || typeof data !== "object")
    return { ok: false, reason: "research-mcp-data is not a JSON object" };

  for (const field of REQUIRED_FIELDS) {
    if (!(field in data))
      return { ok: false, reason: `required field "${field}" missing` };
    if (typeof data[field] !== "string")
      return { ok: false, reason: `field "${field}" is not a string` };
    if (!data[field].trim())
      return { ok: false, reason: `field "${field}" is empty` };
    if (data[field].length > MAX_FIELD_CHARS)
      return { ok: false, reason: `field "${field}" exceeds ${MAX_FIELD_CHARS} chars` };
  }

  return { ok: true, summary: data };
}

export function readSummary(projectName, citationKey) {
  const folder = getResearchFolder(projectName);
  const folderPath = path.join(folder, citationKey);
  if (!fs.existsSync(folderPath))
    return { ok: false, reason: `folder for "${citationKey}" does not exist` };
  const file = path.join(folderPath, "summary.md");
  if (!fs.existsSync(file))
    return { ok: false, reason: `summary.md missing for "${citationKey}"` };
  const content = fs.readFileSync(file, "utf8");
  return parseSummaryMarkdown(content);
}

// ---------------------------------------------------------------------------
// Folder state helpers
// ---------------------------------------------------------------------------

/**
 * Return true iff `dir` contains at least one regular file ending in ".pdf"
 * (case-insensitive). Does NOT recurse into subdirectories.
 */
function folderHasPdf(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.some(
    (e) => e.isFile() && e.name.toLowerCase().endsWith(".pdf")
  );
}

/**
 * Path to the fetch-failed marker for a given paper folder.
 */
function markerPath(paperDir) {
  return path.join(paperDir, FETCH_FAILED_MARKER);
}

/**
 * Read the fetch-failed marker if present. Returns the parsed object or null.
 * If the file is present but malformed, returns a stub so the caller still
 * treats the folder as blocked.
 */
function readMarker(paperDir) {
  const p = markerPath(paperDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { error: "marker_unreadable", detail: "marker file exists but is not valid JSON" };
  }
}

/**
 * Write a fetch-failed marker, creating the folder if it doesn't exist.
 */
function writeMarker(paperDir, payload) {
  fs.mkdirSync(paperDir, { recursive: true });
  fs.writeFileSync(
    markerPath(paperDir),
    JSON.stringify({ ...payload, timestamp: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const fieldSchema = z
  .string()
  .min(1, "field must be non-empty")
  .max(MAX_FIELD_CHARS, `field must be ≤ ${MAX_FIELD_CHARS} characters`)
  .refine((s) => s.trim().length > 0, "field must be non-empty after trimming");

const summarySchema = z.object({
  contributions: fieldSchema.describe(
    "What the paper contributes: new methods, results, framings, or ideas. ≤1000 chars."
  ),
  weaknesses: fieldSchema.describe(
    "Limitations, gaps, or critiques of the paper. ≤1000 chars."
  ),
  relevance: fieldSchema.describe(
    "How this paper relates to the current research project / problem. ≤1000 chars."
  ),
  key_result: fieldSchema.describe(
    "The single most important result or claim, stated precisely. ≤1000 chars."
  ),
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function register(server) {
  // -------------------------------------------------------------------------
  // add_paper — acquire the paper (folder + PDF). Does NOT write a summary.
  // -------------------------------------------------------------------------
  server.tool(
    "add_paper",
    "Acquire a paper for the project: ensures <research_folder>/<citation_key>/ " +
      "exists and contains a PDF. Does NOT write a summary — call write_summary next. " +
      "Errors: " +
      "(a) previous_fetch_failed — a .fetch_failed.json marker is present from a prior " +
      "failed download; the user must clear it from a terminal (the MCP cannot); " +
      "(b) no_folder_no_pdf_url — folder absent and no pdf_url provided; " +
      "(c) folder_exists_no_pdf — folder exists but has no PDF and no pdf_url provided; " +
      "(d) conflict_detected — folder already contains a PDF and pdf_url was provided " +
      "(refuses to overwrite; delete the existing PDF to re-download); " +
      "(e) pdf_download_failed / not_a_pdf / pdf_download_error — fetch failed; a " +
      "marker is written and further retries are blocked until the user clears it.",
    {
      projectName: PROJ,
      citation_key: CITE_KEY,
      pdf_url: z.string().url().optional().describe("Direct PDF URL (required if folder absent or empty)"),
      pdf_filename: z
        .string()
        .optional()
        .describe('Filename for the downloaded PDF (defaults to "paper.pdf")'),
    },
    async ({ projectName, citation_key, pdf_url, pdf_filename }) => {
      const folder = getResearchFolder(projectName);
      const paperDir = assertAllowed(path.join(folder, citation_key));
      const folderExists = fs.existsSync(paperDir);
      const hasPdf = folderExists && folderHasPdf(paperDir);
      const marker = folderExists ? readMarker(paperDir) : null;

      // PRECHECK: a prior fetch failure has not been cleared.
      // Overrides every other branch. Strict: even pdf_url + present PDF is refused.
      if (marker) {
        const mp = markerPath(paperDir);
        const payload = {
          added: false,
          error: "previous_fetch_failed",
          message:
            `A prior PDF fetch for "${citation_key}" failed and the .fetch_failed.json marker ` +
            `is still in place at ${paperDir}. Retries are blocked. The MCP cannot clear the ` +
            `marker — the user must run \`rm ${mp}\` in a terminal.`,
          paper_dir: paperDir,
          marker,
          marker_path: mp,
          next_action: {
            actor: "user",
            command: `rm ${mp}`,
            hint:
              `The MCP cannot remove this marker by design. Ask the user to run ` +
              `\`rm ${mp}\` in a terminal (or delete the file from Finder). ` +
              `Once cleared, retry add_paper.`,
          },
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      // Case: folder + PDF both present, pdf_url provided → real conflict.
      if (hasPdf && pdf_url) {
        const payload = {
          added: false,
          error: "conflict_detected",
          message:
            `Folder for "${citation_key}" already contains a PDF at ${paperDir}. ` +
            `Refusing to overwrite. Delete the existing PDF manually if you want to re-download.`,
          paper_dir: paperDir,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      // Case: no folder AND no pdf_url → error.
      if (!folderExists && !pdf_url) {
        const payload = {
          added: false,
          error: "no_folder_no_pdf_url",
          message:
            `No folder exists for "${citation_key}" and no pdf_url was provided. ` +
            `Provide pdf_url so the paper can be downloaded.`,
          paper_dir: paperDir,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      // Case: folder exists but empty (no PDF), no pdf_url → error.
      if (folderExists && !hasPdf && !pdf_url) {
        const payload = {
          added: false,
          error: "folder_exists_no_pdf",
          message:
            `Folder ${paperDir} exists but contains no PDF. ` +
            `Provide pdf_url to download, or place a PDF in the folder manually.`,
          paper_dir: paperDir,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      // Download branch: covers two cases —
      //   (a) folder absent, pdf_url provided → create folder, download
      //   (b) folder exists without PDF, pdf_url provided → fill in the PDF
      // On failure, write a .fetch_failed.json marker and KEEP the folder.
      // The folder + marker is the sticky state that blocks all retries.
      if (pdf_url && !hasPdf) {
        fs.mkdirSync(paperDir, { recursive: true });
        const pdfPath = path.join(paperDir, pdf_filename || "paper.pdf");
        const attemptedFilename = pdf_filename || "paper.pdf";

        const recordFailure = (errorCode, detail) => {
          writeMarker(paperDir, {
            url: pdf_url,
            error: errorCode,
            detail,
            pdf_filename_attempted: attemptedFilename,
          });
          const mp = markerPath(paperDir);
          return {
            added: false,
            error: errorCode,
            message:
              `${detail} A .fetch_failed.json marker has been written to ${paperDir}. ` +
              `Further add_paper attempts for this citation_key are blocked, and modifying ` +
              `fs_* tools refuse to touch the folder (reads still work). The user must run ` +
              `\`rm ${mp}\` in a terminal to clear it.`,
            paper_dir: paperDir,
            marker_path: mp,
            next_action: {
              actor: "user",
              command: `rm ${mp}`,
              hint:
                `The MCP cannot remove this marker by design. Ask the user to run ` +
                `\`rm ${mp}\` in a terminal.`,
            },
          };
        };

        try {
          const response = await fetch(pdf_url, { headers: FETCH_HEADERS, redirect: "follow" });
          if (!response.ok) {
            const payload = recordFailure(
              "pdf_download_failed",
              `HTTP ${response.status} fetching ${pdf_url}.`
            );
            return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
          }
          const contentType = response.headers.get("content-type") || "";
          if (!contentType.includes("pdf") && !contentType.includes("octet-stream")) {
            const payload = recordFailure(
              "not_a_pdf",
              `URL did not return a PDF (content-type: ${contentType}).`
            );
            return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
          }
          const buffer = await response.arrayBuffer();
          fs.writeFileSync(pdfPath, Buffer.from(buffer));

          const payload = {
            added: true,
            citation_key,
            paper_dir: paperDir,
            pdf_path: pdfPath,
            pdf_bytes: buffer.byteLength,
            folder_was_pre_existing: folderExists,
            summary_status: "missing",
            next_action: {
              tool: "write_summary",
              required_args: ["projectName", "citation_key", "summary"],
              reason:
                "Paper PDF acquired. Read it and call write_summary with the four-field schema " +
                "(contributions, weaknesses, relevance, key_result). commit_and_push will refuse " +
                "until every cited key has a complete summary.",
            },
          };
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        } catch (e) {
          const payload = recordFailure(
            "pdf_download_error",
            `Error fetching ${pdf_url}: ${e.message}.`
          );
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        }
      }

      // Remaining case: folder exists, has PDF, no pdf_url → already-have report.
      const summaryStatus = readSummary(projectName, citation_key);
      const payload = {
        added: true,
        citation_key,
        paper_dir: paperDir,
        pdf_status: "present",
        summary_status: summaryStatus.ok ? "complete" : "missing",
      };
      if (!summaryStatus.ok) {
        payload.next_action = {
          tool: "write_summary",
          required_args: ["projectName", "citation_key", "summary"],
          reason:
            "Paper folder and PDF already present; summary is " +
            `${summaryStatus.reason ? `incomplete (${summaryStatus.reason})` : "missing"}. ` +
            "Read the PDF and call write_summary.",
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  );

  // -------------------------------------------------------------------------
  // write_summary — record the four-field schema. Requires PDF present + no marker.
  // -------------------------------------------------------------------------
  server.tool(
    "write_summary",
    "Write a schema-validated summary.md for a paper. " +
      "Requires the paper folder to exist AND contain at least one PDF — this enforces " +
      "that the agent has actually read the paper before summarizing. " +
      "Also refuses if a .fetch_failed.json marker is present (user must clear it from " +
      "a terminal first). " +
      "Call add_paper first if the folder/PDF are not yet present. " +
      "Overwrites any existing summary.md.",
    {
      projectName: PROJ,
      citation_key: CITE_KEY,
      summary: summarySchema.describe(
        "Required schema: contributions, weaknesses, relevance, key_result. Each ≤1000 chars."
      ),
    },
    async ({ projectName, citation_key, summary }) => {
      const folder = getResearchFolder(projectName);
      const paperDir = assertAllowed(path.join(folder, citation_key));

      if (!fs.existsSync(paperDir)) {
        const payload = {
          written: false,
          error: "paper_folder_missing",
          message:
            `No folder for "${citation_key}" at ${paperDir}. ` +
            `Call add_paper with pdf_url first.`,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      // Marker blocks summary writes too — the agent shouldn't summarize a
      // paper whose PDF acquisition is in a known-broken state.
      const marker = readMarker(paperDir);
      if (marker) {
        const mp = markerPath(paperDir);
        const payload = {
          written: false,
          error: "previous_fetch_failed",
          message:
            `A .fetch_failed.json marker is present at ${paperDir}. The MCP cannot remove it ` +
            `— the user must run \`rm ${mp}\` in a terminal before a summary can be written.`,
          marker,
          marker_path: mp,
          next_action: {
            actor: "user",
            command: `rm ${mp}`,
            hint:
              `The MCP cannot remove this marker by design. Ask the user to run ` +
              `\`rm ${mp}\` in a terminal.`,
          },
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      if (!folderHasPdf(paperDir)) {
        const payload = {
          written: false,
          error: "no_pdf_in_folder",
          message:
            `Folder ${paperDir} contains no PDF. The agent must have read the paper before ` +
            `writing a summary. Add a PDF via add_paper or place one in the folder manually.`,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      const summaryFile = path.join(paperDir, "summary.md");
      const md = renderSummaryMarkdown(citation_key, summary);
      fs.writeFileSync(summaryFile, md, "utf8");

      const payload = {
        written: true,
        citation_key,
        summary_path: summaryFile,
        schema_version: SCHEMA_VERSION,
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  );

  // -------------------------------------------------------------------------
  // get_summary — read and parse a summary
  // -------------------------------------------------------------------------
  server.tool(
    "get_summary",
    "Read and parse the summary for a citation_key. Returns the parsed fields, or " +
      "a structured reason if the summary is missing or incomplete.",
    {
      projectName: PROJ,
      citation_key: z.string().min(1).describe("BibTeX citation key"),
    },
    async ({ projectName, citation_key }) => {
      const result = readSummary(projectName, citation_key);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ citation_key, ...result }, null, 2),
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // list_summaries — overview of all paper folders in research_folder
  // -------------------------------------------------------------------------
  server.tool(
    "list_summaries",
    "List all citation_keys in the project's research_folder, with their summary status " +
      "(ok / incomplete), PDF presence, and whether a .fetch_failed.json marker is present.",
    { projectName: PROJ },
    async ({ projectName }) => {
      const folder = getResearchFolder(projectName);
      const entries = fs
        .readdirSync(folder, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

      const rows = entries.map((key) => {
        const result = readSummary(projectName, key);
        const paperDir = path.join(folder, key);
        const marker = readMarker(paperDir);
        return {
          citation_key: key,
          status: result.ok ? "ok" : "incomplete",
          reason: result.ok ? undefined : result.reason,
          has_pdf: folderHasPdf(paperDir),
          fetch_failed: marker ? true : false,
        };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                research_folder: folder,
                total: rows.length,
                summaries: rows,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
