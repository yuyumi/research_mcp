/**
 * latex_tools.js — Overleaf/LaTeX tools (everything except commit_and_push).
 *
 * Registers: list_projects, list_files, read_file, get_sections,
 *            get_section_content, status_summary, write_file, str_replace,
 *            delete_file, pull.
 *
 * commit_and_push lives in commit.js because it has a validation gate.
 *
 * Change from original: list_projects now surfaces research_folder so the
 * user can see at a glance whether each project has it configured. All other
 * tools require projectName (no default) — this prevents accidental writes
 * to the "default" project when the caller intended a specific one.
 */

import { z } from "zod";
import { projectsConfig } from "./config.js";
import { getProject } from "./latex_client.js";

// projectName is REQUIRED on every tool that operates on a specific project.
// No default — passing the wrong project silently would clobber the wrong
// repo. Forcing the caller to name the project makes mistakes loud.
const PROJ = z.string().min(1).describe("Project identifier (required, no default)");

export function register(server) {
  server.tool(
    "list_projects",
    "List all configured Overleaf projects, including whether research_folder is set.",
    {},
    async () => {
      if (!projectsConfig) throw new Error("projects.json not configured");
      const projects = Object.entries(projectsConfig.projects).map(([k, p]) => ({
        id: k,
        name: p.name,
        projectId: p.projectId,
        research_folder: p.research_folder || null,
      }));
      return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
    }
  );

  server.tool(
    "list_files",
    "List files in the local Overleaf clone. Call pull first if you need the latest remote state.",
    {
      projectName: PROJ,
      extension: z.string().optional().describe('File extension filter (optional, e.g. ".tex")'),
    },
    async ({ extension, projectName }) => {
      const files = await getProject(projectName).listFiles(extension || ".tex");
      return { content: [{ type: "text", text: files.join("\n") }] };
    }
  );

  server.tool(
    "read_file",
    "Read a file from the local Overleaf clone. Call pull first if you need the latest remote state.",
    {
      projectName: PROJ,
      filePath: z.string().describe("Path relative to project root"),
    },
    async ({ filePath, projectName }) => {
      return { content: [{ type: "text", text: await getProject(projectName).readFile(filePath) }] };
    }
  );

  server.tool(
    "get_sections",
    "Get all LaTeX section headings from a file in the local clone.",
    {
      projectName: PROJ,
      filePath: z.string().describe("Path to the LaTeX file"),
    },
    async ({ filePath, projectName }) => {
      const sections = await getProject(projectName).getSections(filePath);
      return { content: [{ type: "text", text: JSON.stringify(sections, null, 2) }] };
    }
  );

  server.tool(
    "get_section_content",
    "Get the full content of a specific LaTeX section from the local clone.",
    {
      projectName: PROJ,
      filePath: z.string().describe("Path to the LaTeX file"),
      sectionTitle: z.string().describe("Exact section title to extract"),
    },
    async ({ filePath, sectionTitle, projectName }) => {
      return { content: [{ type: "text", text: await getProject(projectName).getSectionContent(filePath, sectionTitle) }] };
    }
  );

  server.tool(
    "status_summary",
    "File count, main file, and section headings from the local Overleaf clone.",
    { projectName: PROJ },
    async ({ projectName }) => {
      const summary = await getProject(projectName).statusSummary();
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.tool(
    "write_file",
    "Create or overwrite a file in the local Overleaf clone. Does NOT commit or push — call commit_and_push to publish.",
    {
      projectName: PROJ,
      filePath: z.string().describe("Path relative to project root"),
      content: z.string().describe("Full file content"),
    },
    async ({ filePath, content, projectName }) => {
      const result = await getProject(projectName).writeFile(filePath, content);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "str_replace",
    "Replace a unique string in a local Overleaf file. Does NOT commit or push — call commit_and_push to publish. Fails if old_str is absent or non-unique.",
    {
      projectName: PROJ,
      filePath: z.string().describe("Path relative to project root"),
      old_str: z.string().describe("String to replace; must appear exactly once"),
      new_str: z.string().describe('Replacement (use "" to delete)'),
    },
    async ({ filePath, old_str, new_str, projectName }) => {
      const result = await getProject(projectName).strReplace(filePath, old_str, new_str);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "delete_file",
    "Delete a file from the local Overleaf clone. Does NOT commit or push — call commit_and_push to publish.",
    {
      projectName: PROJ,
      filePath: z.string().describe("Path relative to project root"),
    },
    async ({ filePath, projectName }) => {
      const result = await getProject(projectName).deleteFile(filePath);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "pull",
    "Sync local Overleaf clone from remote (git pull). Call at the start of a session or after web UI edits.",
    { projectName: PROJ },
    async ({ projectName }) => {
      const result = await getProject(projectName).pull();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
