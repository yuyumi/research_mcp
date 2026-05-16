/**
 * commit.js — gated commit_and_push.
 *
 * Registers: commit_and_push.
 *
 * Runs validate_citations first. If any cited key has an incomplete/missing
 * summary, refuses to commit and returns the offending keys. Otherwise calls
 * the underlying LatexGitClient.commitAndPush.
 *
 * Bypass: NONE at the tool level. To commit despite missing summaries, the
 * user must either complete the summaries (correct path) or commit by hand
 * outside the MCP (escape hatch the MCP intentionally does not provide).
 */

import { z } from "zod";
import { getProject } from "./latex_client.js";
import { validateCitations } from "./citations.js";

// projectName REQUIRED — no default. See latex_tools.js for rationale.
const PROJ = z.string().min(1).describe("Project identifier (required, no default)");

export function register(server) {
  server.tool(
    "commit_and_push",
    "Stage all local changes, commit, and push to Overleaf. " +
      "REFUSES to commit if any \\cite{} key in the .tex sources lacks a complete summary " +
      "at <research_folder>/<key>/summary.md. Run validate_citations to inspect, " +
      "then add_paper + write_summary to fill in any missing summaries.",
    {
      projectName: PROJ,
      message: z.string().describe("Commit message"),
    },
    async ({ message, projectName }) => {
      const validation = await validateCitations(projectName);
      if (validation.incomplete.length > 0) {
        const payload = {
          committed: false,
          pushed: false,
          error: "citations_incomplete",
          message:
            `Commit blocked: ${validation.incomplete.length} cited key(s) lack complete summaries. ` +
            `Call add_paper (to acquire PDF) and write_summary (to record the schema) for each, then retry.`,
          incomplete: validation.incomplete,
          ok_count: validation.ok.length,
          total_cited: validation.total_cited,
          scanned_files: validation.scanned_files,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      const result = await getProject(projectName).commitAndPush(message);
      const payload = {
        ...result,
        citations_validated: {
          ok_count: validation.ok.length,
          total_cited: validation.total_cited,
          scanned_files: validation.scanned_files,
        },
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  );
}
