/**
 * literature.js — paper summaries with enforced schema and read attestation.
 *
 * Registers: add_paper, pdf_read_check, write_summary, get_summary, list_summaries.
 *
 * Four-step flow (the actual READING happens outside the MCP — the agent
 * uses its client's native PDF-handling capability, typically a user-uploaded
 * PDF in the conversation):
 *   1. add_paper       — downloads the PDF and persists it to the paper folder.
 *   2. (user uploads the PDF to the conversation so the agent can read it.)
 *   3. pdf_read_check  — agent attests it read the paper via a paper-specific
 *                        sentence; writes .read_log.json.
 *   4. write_summary   — refuses unless a current, matching read log exists.
 *
 * The read log is an HONOR-SYSTEM attestation: the MCP cannot verify the
 * agent actually consumed the PDF, only that it claimed to and supplied a
 * paper-specific attestation sentence. This raises the cost of skipping the
 * read step. The agent must produce paper-specific content to pass the
 * attestation; combined with write_summary's schema, this is the strongest
 * enforcement achievable without a side channel into the agent's processing.
 *
 * Stale-read detection: write_summary recomputes the current PDF's size and
 * mtime and compares to the log. If the PDF was replaced or touched since
 * the read, the log is stale and a fresh pdf_read_check is required.
 *
 * Failure stickiness:
 *   When add_paper's PDF fetch fails, it writes .fetch_failed.json into the
 *   paper folder. While that marker exists:
 *     - add_paper, pdf_read_check, and write_summary refuse for that citation_key.
 *     - Modifying fs_* tools refuse to touch anything in or under the folder.
 *     - Read fs_* tools remain available so the agent can diagnose.
 *   The marker can only be cleared by the user from outside the MCP.
 *
 * Schema enforcement strategy:
 *   - Zod requires all four summary fields at the MCP tool boundary.
 *   - Each field is capped at MAX_FIELD_CHARS (1000), non-empty after trimming.
 *   - summary.md contains human-readable markdown sections AND a machine-
 *     readable JSON block in an HTML comment. The JSON comment is the
 *     SOURCE OF TRUTH for validation.
 *
 * Read log format (.read_log.json):
 *   {
 *     "pdf_filename":   "paper.pdf",
 *     "pdf_size":       1797405,
 *     "pdf_mtime_ms":   1700000000000,
 *     "attestation":    "I read the paper. The main result is...",
 *     "timestamp":      "2026-05-16T...",
 *     "schema_version": "v1"
 *   }
 */

import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { z } from "zod";
import { getResearchFolder, assertAllowed, PROTECTED_MARKER_FILENAME } from "./config.js";

export const SCHEMA_VERSION = "v1";
export const MAX_FIELD_CHARS = 1000;
export const REQUIRED_FIELDS = ["contributions", "weaknesses", "relevance", "key_result"];
export const FETCH_FAILED_MARKER = PROTECTED_MARKER_FILENAME;
export const READ_LOG_FILENAME = ".read_log.json";
export const ATTESTATION_MIN_CHARS = 30;
export const ATTESTATION_MAX_CHARS = 500;

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
// Rendering / parsing of summary.md
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
 * Return the list of .pdf filenames in `dir` (case-insensitive, non-recursive).
 * Returns [] if dir doesn't exist or isn't a directory.
 */
function listPdfFilenames(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".pdf"))
    .map((e) => e.name);
}

function folderHasPdf(dir) {
  return listPdfFilenames(dir).length > 0;
}

function markerPath(paperDir) {
  return path.join(paperDir, FETCH_FAILED_MARKER);
}

function readMarker(paperDir) {
  const p = markerPath(paperDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { error: "marker_unreadable", detail: "marker file exists but is not valid JSON" };
  }
}

function writeMarker(paperDir, payload) {
  fs.mkdirSync(paperDir, { recursive: true });
  fs.writeFileSync(
    markerPath(paperDir),
    JSON.stringify({ ...payload, timestamp: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// Read-log helpers
// ---------------------------------------------------------------------------

function readLogPath(paperDir) {
  return path.join(paperDir, READ_LOG_FILENAME);
}

/**
 * Read and parse .read_log.json. Returns the parsed object or null.
 * If the file is present but malformed, returns a stub with an error flag.
 */
function readReadLog(paperDir) {
  const p = readLogPath(paperDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { error: "read_log_unreadable", detail: "read log file exists but is not valid JSON" };
  }
}

/**
 * Compare the read log against the current PDF in `paperDir`. Returns:
 *   { ok: true, log, pdf_filename }                  — log is current
 *   { ok: false, reason: "no_log" }                  — no read log on disk
 *   { ok: false, reason: "log_unreadable" }          — JSON parse failed
 *   { ok: false, reason: "wrong_pdf_count", count }  — 0 or >1 PDFs in folder
 *   { ok: false, reason: "filename_mismatch", log_fn, current_fn }
 *   { ok: false, reason: "size_or_mtime_changed", log, current_size, current_mtime_ms }
 *   { ok: false, reason: "missing_field", field }    — log is shaped wrong
 */
function checkReadLog(paperDir) {
  const log = readReadLog(paperDir);
  if (!log) return { ok: false, reason: "no_log" };
  if (log.error === "read_log_unreadable") return { ok: false, reason: "log_unreadable" };

  for (const field of ["pdf_filename", "pdf_size", "pdf_mtime_ms", "attestation"]) {
    if (!(field in log)) return { ok: false, reason: "missing_field", field };
  }

  const pdfs = listPdfFilenames(paperDir);
  if (pdfs.length !== 1) return { ok: false, reason: "wrong_pdf_count", count: pdfs.length };
  const currentPdf = pdfs[0];

  if (currentPdf !== log.pdf_filename) {
    return { ok: false, reason: "filename_mismatch", log_fn: log.pdf_filename, current_fn: currentPdf };
  }

  const stat = fs.statSync(path.join(paperDir, currentPdf));
  if (stat.size !== log.pdf_size || stat.mtimeMs !== log.pdf_mtime_ms) {
    return {
      ok: false,
      reason: "size_or_mtime_changed",
      log: { size: log.pdf_size, mtime_ms: log.pdf_mtime_ms },
      current_size: stat.size,
      current_mtime_ms: stat.mtimeMs,
    };
  }

  return { ok: true, log, pdf_filename: currentPdf };
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

const attestationSchema = z
  .string()
  .min(ATTESTATION_MIN_CHARS, `attestation must be ≥ ${ATTESTATION_MIN_CHARS} characters`)
  .max(ATTESTATION_MAX_CHARS, `attestation must be ≤ ${ATTESTATION_MAX_CHARS} characters`)
  .refine((s) => s.trim().length >= ATTESTATION_MIN_CHARS, "attestation must be non-empty after trimming")
  .describe(
    `Paper-specific sentence proving you read it (${ATTESTATION_MIN_CHARS}-${ATTESTATION_MAX_CHARS} chars). ` +
    `e.g. "Read InstructGPT. Three-stage RLHF: SFT, RM training on preferences, PPO. 1.3B model preferred over 175B GPT-3."`
  );

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
      "exists and contains a PDF. After this succeeds, ask the user to upload the PDF " +
      "to the conversation so you can read it, then call pdf_read_check. " +
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

      // Download branch.
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
            read_status: "not_read",
            summary_status: "missing",
            next_action: {
              tool: "pdf_read_check",
              required_args: ["projectName", "citation_key", "attestation"],
              reason:
                `Paper PDF acquired at ${pdfPath}. Ask the user to upload paper.pdf to the ` +
                `conversation so you can read it natively. Once you've read it, call ` +
                `pdf_read_check with a short (${ATTESTATION_MIN_CHARS}-${ATTESTATION_MAX_CHARS} char) ` +
                `paper-specific attestation. write_summary will refuse until this is done.`,
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
      const readCheck = checkReadLog(paperDir);
      const payload = {
        added: true,
        citation_key,
        paper_dir: paperDir,
        pdf_status: "present",
        read_status: readCheck.ok ? "current" : `stale_or_missing (${readCheck.reason})`,
        summary_status: summaryStatus.ok ? "complete" : "missing",
      };
      if (!summaryStatus.ok) {
        if (!readCheck.ok) {
          payload.next_action = {
            tool: "pdf_read_check",
            required_args: ["projectName", "citation_key", "attestation"],
            reason:
              `Paper folder and PDF already present; no current read log. Ask the user to ` +
              `upload the PDF to the conversation, read it, then call pdf_read_check.`,
          };
        } else {
          payload.next_action = {
            tool: "write_summary",
            required_args: ["projectName", "citation_key", "summary"],
            reason:
              `Paper folder, PDF, and read log all present; summary is ` +
              `${summaryStatus.reason ? `incomplete (${summaryStatus.reason})` : "missing"}. ` +
              `Call write_summary.`,
          };
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  );

  // -------------------------------------------------------------------------
  // pdf_read_check — agent attests it read the paper. Writes .read_log.json.
  // -------------------------------------------------------------------------
  server.tool(
    "pdf_read_check",
    "Attest that you have read the paper's PDF. Writes .read_log.json with the current " +
      "PDF's size/mtime and your attestation. write_summary will refuse until this is " +
      "present and matches the current PDF. Re-call to refresh after the PDF is updated. " +
      "Requires the paper folder to contain exactly one PDF. Refuses if a .fetch_failed.json " +
      "marker is present.",
    {
      projectName: PROJ,
      citation_key: CITE_KEY,
      attestation: attestationSchema,
    },
    async ({ projectName, citation_key, attestation }) => {
      const folder = getResearchFolder(projectName);
      const paperDir = assertAllowed(path.join(folder, citation_key));

      if (!fs.existsSync(paperDir)) {
        const payload = {
          checked: false,
          error: "paper_folder_missing",
          message:
            `No folder for "${citation_key}" at ${paperDir}. ` +
            `Call add_paper with pdf_url first.`,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      const marker = readMarker(paperDir);
      if (marker) {
        const mp = markerPath(paperDir);
        const payload = {
          checked: false,
          error: "previous_fetch_failed",
          message:
            `A .fetch_failed.json marker is present at ${paperDir}. The MCP cannot remove it ` +
            `— the user must run \`rm ${mp}\` in a terminal before pdf_read_check can run.`,
          marker,
          marker_path: mp,
          next_action: {
            actor: "user",
            command: `rm ${mp}`,
            hint: `Ask the user to run \`rm ${mp}\` in a terminal.`,
          },
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      const pdfs = listPdfFilenames(paperDir);
      if (pdfs.length === 0) {
        const payload = {
          checked: false,
          error: "no_pdf_in_folder",
          message:
            `Folder ${paperDir} contains no PDF. Cannot attest a read for a paper that ` +
            `isn't on disk. Call add_paper with pdf_url first.`,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }
      if (pdfs.length > 1) {
        const payload = {
          checked: false,
          error: "multiple_pdfs_in_folder",
          message:
            `Folder ${paperDir} contains ${pdfs.length} PDFs (${pdfs.join(", ")}). ` +
            `Exactly one PDF is required. Ask the user to remove the extras.`,
          pdfs,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      const pdfFilename = pdfs[0];
      const stat = fs.statSync(path.join(paperDir, pdfFilename));
      const log = {
        pdf_filename: pdfFilename,
        pdf_size: stat.size,
        pdf_mtime_ms: stat.mtimeMs,
        attestation,
        timestamp: new Date().toISOString(),
        schema_version: SCHEMA_VERSION,
      };
      fs.writeFileSync(readLogPath(paperDir), JSON.stringify(log, null, 2), "utf8");

      const payload = {
        checked: true,
        citation_key,
        pdf_filename: pdfFilename,
        pdf_size: stat.size,
        read_log_path: readLogPath(paperDir),
        next_action: {
          tool: "write_summary",
          required_args: ["projectName", "citation_key", "summary"],
          reason:
            `Read attested. Call write_summary with the four-field schema ` +
            `(contributions, weaknesses, relevance, key_result).`,
        },
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  );

  // -------------------------------------------------------------------------
  // write_summary — requires PDF present, no marker, and a current read log.
  // -------------------------------------------------------------------------
  server.tool(
    "write_summary",
    "Write a schema-validated summary.md for a paper. Requires: the paper folder exists, " +
      "contains exactly one PDF, has no .fetch_failed.json marker, AND has a current " +
      ".read_log.json matching the PDF's size/mtime. If the PDF was replaced or modified " +
      "after the last pdf_read_check, the log is stale and a fresh pdf_read_check is " +
      "required. Overwrites any existing summary.md.",
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

      // Marker check.
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
            hint: `Ask the user to run \`rm ${mp}\` in a terminal.`,
          },
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      // PDF presence + count + read log all checked by checkReadLog.
      const check = checkReadLog(paperDir);
      if (!check.ok) {
        let errorCode, message;
        switch (check.reason) {
          case "no_log":
            errorCode = "pdf_not_read";
            message =
              `No .read_log.json found at ${paperDir}. The agent must read the PDF and ` +
              `call pdf_read_check before write_summary will run.`;
            break;
          case "log_unreadable":
            errorCode = "read_log_unreadable";
            message =
              `.read_log.json at ${paperDir} is present but malformed. Delete it and ` +
              `re-run pdf_read_check.`;
            break;
          case "missing_field":
            errorCode = "read_log_incomplete";
            message =
              `.read_log.json at ${paperDir} is missing required field '${check.field}'. ` +
              `Delete it and re-run pdf_read_check.`;
            break;
          case "wrong_pdf_count":
            errorCode = check.count === 0 ? "no_pdf_in_folder" : "multiple_pdfs_in_folder";
            message =
              check.count === 0
                ? `Folder ${paperDir} contains no PDF. Call add_paper first.`
                : `Folder ${paperDir} contains ${check.count} PDFs. Exactly one is required.`;
            break;
          case "filename_mismatch":
            errorCode = "pdf_changed_since_read";
            message =
              `Read log references "${check.log_fn}" but the current PDF is "${check.current_fn}". ` +
              `The PDF was replaced after the last read. Call pdf_read_check again.`;
            break;
          case "size_or_mtime_changed":
            errorCode = "pdf_changed_since_read";
            message =
              `PDF at ${paperDir} has changed since the last pdf_read_check ` +
              `(logged size=${check.log.size}, mtime=${check.log.mtime_ms}; ` +
              `current size=${check.current_size}, mtime=${check.current_mtime_ms}). ` +
              `Call pdf_read_check again.`;
            break;
          default:
            errorCode = "read_log_invalid";
            message = `Read log validation failed: ${check.reason}.`;
        }

        const payload = {
          written: false,
          error: errorCode,
          message,
          paper_dir: paperDir,
          next_action: {
            tool: "pdf_read_check",
            required_args: ["projectName", "citation_key", "attestation"],
            reason:
              `Ask the user to upload the PDF to the conversation if needed, read it, ` +
              `then call pdf_read_check with a paper-specific attestation.`,
          },
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      // All checks passed — write the summary.
      const summaryFile = path.join(paperDir, "summary.md");
      const md = renderSummaryMarkdown(citation_key, summary);
      fs.writeFileSync(summaryFile, md, "utf8");

      const payload = {
        written: true,
        citation_key,
        summary_path: summaryFile,
        schema_version: SCHEMA_VERSION,
        read_log_attestation: check.log.attestation,
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  );

  // -------------------------------------------------------------------------
  // get_summary
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
  // list_summaries — adds pdf_read and fetch_failed flags per row.
  // -------------------------------------------------------------------------
  server.tool(
    "list_summaries",
    "List all citation_keys in the project's research_folder, with their summary status " +
      "(ok / incomplete), PDF presence, read-log freshness, and fetch-failed marker presence.",
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
        const readCheck = checkReadLog(paperDir);
        return {
          citation_key: key,
          status: result.ok ? "ok" : "incomplete",
          reason: result.ok ? undefined : result.reason,
          has_pdf: folderHasPdf(paperDir),
          pdf_read: readCheck.ok,
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
