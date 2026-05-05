#!/usr/bin/env node
/**
 * research-mcp — unified MCP server for research workflows
 *
 * Filesystem tools (scoped to ALLOWED_ROOT env var):
 *   fs_read, fs_write, fs_move, fs_copy, fs_delete, fs_list, fs_mkdir, fs_exists
 *
 * Research tools:
 *   fetch_pdf, list_literature, add_paper
 *
 * LaTeX/Overleaf tools (configured via projects.json):
 *   list_projects, list_files, read_file, get_sections, get_section_content,
 *   status_summary, write_file, str_replace, delete_file, pull, commit_and_push
 *
 * All LaTeX write operations are local only — call commit_and_push to publish.
 *
 * claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "research": {
 *         "command": "node",
 *         "args": ["/path/to/research_mcp/src/index.js"],
 *         "env": { "ALLOWED_ROOT": "/path/to/your/research/directory" }
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "node-fetch";
import fs from "fs";
import { readFile, access, readdir, mkdir, writeFile, chmod, unlink } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { promisify } from "util";
import { exec as execCallback } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const exec = promisify(execCallback);

// ---------------------------------------------------------------------------
// Config — both optional; missing config disables the relevant tool group
// ---------------------------------------------------------------------------

const ALLOWED_ROOT = process.env.ALLOWED_ROOT;
if (!ALLOWED_ROOT) {
  process.stderr.write(
    "WARN: ALLOWED_ROOT not set — filesystem tools (fs_*) will be unavailable\n"
  );
}

let projectsConfig = null;
try {
  const configPath = path.join(__dirname, "..", "projects.json");
  projectsConfig = JSON.parse(await readFile(configPath, "utf-8"));
} catch {
  process.stderr.write(
    "WARN: projects.json not found — LaTeX/Overleaf tools will be unavailable\n"
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertAllowed(filePath) {
  if (!ALLOWED_ROOT) throw new Error("ALLOWED_ROOT is not configured");
  const resolved = path.resolve(filePath);
  const root = path.resolve(ALLOWED_ROOT);
  if (!resolved.startsWith(root + path.sep) && resolved !== root)
    throw new Error(`Path '${resolved}' is outside allowed root '${root}'`);
  return resolved;
}

function sanitizeError(message) {
  if (!message) return message;
  return String(message)
    .replace(/https:\/\/[^:]+:[^@\s]+@/g, "https://[REDACTED]@")
    .replace(/olp_[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]");
}

// ---------------------------------------------------------------------------
// LaTeX/Overleaf git client
// ---------------------------------------------------------------------------

class LatexGitClient {
  constructor(projectId, gitToken) {
    this.projectId = projectId;
    this.gitToken = gitToken;
    this.repoPath = path.join(os.tmpdir(), `overleaf-${projectId}`);
    this.gitUrl = `https://git.overleaf.com/${projectId}`;
    this._askpassPath = null;
  }

  async _ensureAskpass() {
    if (this._askpassPath) return this._askpassPath;
    const isWindows = process.platform === "win32";
    const dir = path.join(os.tmpdir(), `overleaf-askpass-${this.projectId}`);
    await mkdir(dir, { recursive: true });
    if (isWindows) {
      const p = path.join(dir, "askpass.cmd");
      await writeFile(p, `@echo off\r\necho ${this.gitToken}\r\n`, "utf8");
      this._askpassPath = p;
    } else {
      const p = path.join(dir, "askpass.sh");
      await writeFile(p, `#!/bin/sh\necho "${this.gitToken}"\n`, "utf8");
      await chmod(p, 0o700);
      this._askpassPath = p;
    }
    return this._askpassPath;
  }

  async _gitEnv() {
    return { ...process.env, GIT_ASKPASS: await this._ensureAskpass(), GIT_TERMINAL_PROMPT: "0" };
  }

  async _safeExec(cmd, opts = {}) {
    try {
      return await exec(cmd, opts);
    } catch (err) {
      const safe = new Error(sanitizeError(err.message));
      safe.code = err.code;
      throw safe;
    }
  }

  async _ensureClone() {
    let exists = false;
    try { await access(path.join(this.repoPath, ".git")); exists = true; } catch {}
    if (!exists) {
      const env = await this._gitEnv();
      await this._safeExec(`git clone "${this.gitUrl}" "${this.repoPath}"`, { env });
    }
  }

  _resolve(filePath) {
    const full = path.resolve(this.repoPath, filePath);
    const root = path.resolve(this.repoPath);
    if (full !== root && !full.startsWith(root + path.sep))
      throw new Error(`Path outside repo: ${filePath}`);
    return full;
  }

  _parseSections(content) {
    const sections = [];
    const re = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^}]+)\}/g;
    let m;
    while ((m = re.exec(content)) !== null)
      sections.push({ type: m[1], title: m[2], index: m.index });
    return sections;
  }

  async listFiles(extension = ".tex") {
    await this._ensureClone();
    const results = [];
    const walk = async (dir) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name === ".git") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && (!extension || e.name.endsWith(extension))) results.push(full);
      }
    };
    await walk(this.repoPath);
    return results.map(f => path.relative(this.repoPath, f));
  }

  async readFile(filePath) {
    await this._ensureClone();
    return await readFile(this._resolve(filePath), "utf-8");
  }

  async getSections(filePath) {
    return this._parseSections(await this.readFile(filePath));
  }

  async getSectionContent(filePath, sectionTitle) {
    const content = await this.readFile(filePath);
    const sections = this._parseSections(content);
    const target = sections.find(s => s.title === sectionTitle);
    if (!target) throw new Error(`Section "${sectionTitle}" not found in ${filePath}`);
    const next = sections.find(s => s.index > target.index);
    return content.substring(target.index, next ? next.index : content.length);
  }

  async statusSummary() {
    const files = await this.listFiles();
    const mainFile = files.find(f => f.includes("main.tex")) || files[0];
    const sections = mainFile ? this._parseSections(await this.readFile(mainFile)) : [];
    return { totalFiles: files.length, mainFile, totalSections: sections.length, files: files.slice(0, 10) };
  }

  async writeFile(filePath, content) {
    await this._ensureClone();
    const full = this._resolve(filePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    return { written: true, filePath, message: "Written locally. Use commit_and_push to publish." };
  }

  async strReplace(filePath, oldStr, newStr) {
    if (!oldStr) throw new Error("old_str must be non-empty");
    if (typeof newStr !== "string") throw new Error("new_str must be a string");
    await this._ensureClone();
    const full = this._resolve(filePath);
    let content;
    try { content = await readFile(full, "utf-8"); }
    catch (e) { if (e.code === "ENOENT") throw new Error(`File not found: ${filePath}`); throw e; }
    const i = content.indexOf(oldStr);
    if (i === -1) throw new Error(`old_str not found in ${filePath}`);
    if (content.indexOf(oldStr, i + 1) !== -1)
      throw new Error(`old_str appears multiple times in ${filePath}; use a longer unique snippet`);
    if (oldStr === newStr) return { edited: false, filePath, message: "No-op: strings are equal" };
    await writeFile(full, content.slice(0, i) + newStr + content.slice(i + oldStr.length), "utf8");
    return { edited: true, filePath, message: "Edit applied locally. Use commit_and_push to publish." };
  }

  async deleteFile(filePath) {
    await this._ensureClone();
    const full = this._resolve(filePath);
    try { await unlink(full); }
    catch (e) { if (e.code === "ENOENT") throw new Error(`File not found: ${filePath}`); throw e; }
    return { deleted: true, filePath, message: "Deleted locally. Use commit_and_push to publish." };
  }

  async pull() {
    const env = await this._gitEnv();
    let exists = false;
    try { await access(path.join(this.repoPath, ".git")); exists = true; } catch {}
    const { stdout } = exists
      ? await this._safeExec(`git -C "${this.repoPath}" pull`, { env })
      : await this._safeExec(`git clone "${this.gitUrl}" "${this.repoPath}"`, { env });
    return { pulled: true, message: "Local clone synced with remote", git: stdout?.trim() || "" };
  }

  async commitAndPush(message) {
    const env = await this._gitEnv();
    const msg = (message || "Update from MCP").replace(/"/g, '\\"');
    await this._safeExec(`git -C "${this.repoPath}" add -A`, { env });
    let hasChanges = false;
    try { await this._safeExec(`git -C "${this.repoPath}" diff --cached --quiet`, { env }); }
    catch { hasChanges = true; }
    if (!hasChanges) return { committed: false, pushed: false, message: "No changes to commit" };
    await this._safeExec(`git -C "${this.repoPath}" commit -m "${msg}"`, { env });
    try {
      await this._safeExec(`git -C "${this.repoPath}" pull --rebase`, { env });
    } catch (err) {
      throw new Error(
        `Pull-rebase before push failed (conflict with Overleaf web UI edits). ` +
        `Resolve manually in the temp clone or re-clone. Original error: ${err.message}`
      );
    }
    await this._safeExec(`git -C "${this.repoPath}" push`, { env });
    return { committed: true, pushed: true, message };
  }
}

function getProject(name = "default") {
  if (!projectsConfig) throw new Error("projects.json not configured");
  const p = projectsConfig.projects[name];
  if (!p) throw new Error(`Project "${name}" not found in projects.json`);
  return new LatexGitClient(p.projectId, p.gitToken);
}

const PROJ = z.string().optional().describe('Project identifier (optional, defaults to "default")');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "research-mcp",
  version: "3.0.0",
});

// ===========================================================================
// FILESYSTEM TOOLS
// ===========================================================================

server.tool(
  "fs_read",
  "Read the text content of a file within ALLOWED_ROOT.",
  {
    path: z.string().describe("Absolute path to the file"),
    head: z.number().int().positive().optional().describe("Return only first N lines"),
    tail: z.number().int().positive().optional().describe("Return only last N lines"),
  },
  async ({ path: filePath, head, tail }) => {
    const resolved = assertAllowed(filePath);
    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
    let lines = fs.readFileSync(resolved, "utf8").split("\n");
    if (head !== undefined) lines = lines.slice(0, head);
    if (tail !== undefined) lines = lines.slice(-tail);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "fs_write",
  "Write text to a file within ALLOWED_ROOT, creating parent directories as needed.",
  {
    path: z.string().describe("Absolute path to the file"),
    content: z.string().describe("Text content to write"),
  },
  async ({ path: filePath, content }) => {
    const resolved = assertAllowed(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    return { content: [{ type: "text", text: `Written ${bytes} bytes to ${resolved}` }] };
  }
);

server.tool(
  "fs_move",
  "Move or rename a file or directory within ALLOWED_ROOT.",
  {
    source: z.string().describe("Absolute path of source"),
    destination: z.string().describe("Absolute path of destination"),
  },
  async ({ source, destination }) => {
    const src = assertAllowed(source);
    const dst = assertAllowed(destination);
    if (!fs.existsSync(src)) throw new Error(`Source not found: ${src}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    return { content: [{ type: "text", text: `Moved ${src} → ${dst}` }] };
  }
);

server.tool(
  "fs_copy",
  "Copy a file within ALLOWED_ROOT.",
  {
    source: z.string().describe("Absolute path of source file"),
    destination: z.string().describe("Absolute path of destination file"),
  },
  async ({ source, destination }) => {
    const src = assertAllowed(source);
    const dst = assertAllowed(destination);
    if (!fs.existsSync(src)) throw new Error(`Source not found: ${src}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const kb = Math.round(fs.statSync(dst).size / 1024);
    return { content: [{ type: "text", text: `Copied ${src} → ${dst} (${kb} KB)` }] };
  }
);

server.tool(
  "fs_delete",
  "Delete a file or directory (recursive) within ALLOWED_ROOT. No undo.",
  { path: z.string().describe("Absolute path to delete") },
  async ({ path: filePath }) => {
    const resolved = assertAllowed(filePath);
    if (!fs.existsSync(resolved))
      return { content: [{ type: "text", text: `Already gone: ${resolved}` }] };
    const isDir = fs.statSync(resolved).isDirectory();
    if (isDir) fs.rmSync(resolved, { recursive: true, force: true });
    else fs.unlinkSync(resolved);
    return { content: [{ type: "text", text: `Deleted ${isDir ? "directory" : "file"}: ${resolved}` }] };
  }
);

server.tool(
  "fs_list",
  "List contents of a directory within ALLOWED_ROOT with file sizes.",
  { path: z.string().describe("Absolute path to the directory") },
  async ({ path: dirPath }) => {
    const resolved = assertAllowed(dirPath);
    if (!fs.existsSync(resolved)) throw new Error(`Directory not found: ${resolved}`);
    const lines = fs.readdirSync(resolved, { withFileTypes: true }).map(e => {
      if (e.isDirectory()) return `[DIR]  ${e.name}`;
      const kb = Math.round(fs.statSync(path.join(resolved, e.name)).size / 1024);
      return `[FILE] ${e.name} (${kb} KB)`;
    });
    return { content: [{ type: "text", text: `Contents of ${resolved}:\n\n${lines.join("\n")}` }] };
  }
);

server.tool(
  "fs_mkdir",
  "Create a directory and all parent directories within ALLOWED_ROOT.",
  { path: z.string().describe("Absolute path of the directory to create") },
  async ({ path: dirPath }) => {
    const resolved = assertAllowed(dirPath);
    fs.mkdirSync(resolved, { recursive: true });
    return { content: [{ type: "text", text: `Created directory: ${resolved}` }] };
  }
);

server.tool(
  "fs_exists",
  "Check whether a path exists within ALLOWED_ROOT.",
  { path: z.string().describe("Absolute path to check") },
  async ({ path: filePath }) => {
    const resolved = assertAllowed(filePath);
    const exists = fs.existsSync(resolved);
    const type = exists ? (fs.statSync(resolved).isDirectory() ? "directory" : "file") : "none";
    return {
      content: [{ type: "text", text: exists ? `Exists as ${type}: ${resolved}` : `Does not exist: ${resolved}` }],
    };
  }
);

// ===========================================================================
// RESEARCH TOOLS
// ===========================================================================

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/pdf,*/*",
};

server.tool(
  "fetch_pdf",
  "Download a PDF from a URL and save to disk. Handles arxiv redirects.",
  {
    url: z.string().url().describe("URL of the PDF"),
    dest_path: z.string().describe("Absolute local path to save the PDF"),
  },
  async ({ url, dest_path }) => {
    const resolved = assertAllowed(dest_path);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const response = await fetch(url, { headers: FETCH_HEADERS, redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const ct = response.headers.get("content-type") || "";
    if (!ct.includes("pdf") && !ct.includes("octet-stream"))
      throw new Error(`URL did not return a PDF (content-type: ${ct})`);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(resolved, Buffer.from(buffer));
    return { content: [{ type: "text", text: `Downloaded ${Math.round(buffer.byteLength / 1024)} KB to ${resolved}` }] };
  }
);

server.tool(
  "list_literature",
  "List all paper folders in a literature directory, showing which have summaries and PDFs.",
  { literature_dir: z.string().describe("Absolute path to the literature directory") },
  async ({ literature_dir }) => {
    const resolved = assertAllowed(literature_dir);
    if (!fs.existsSync(resolved)) throw new Error(`Directory not found: ${resolved}`);
    const lines = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(folder => {
        const files = fs.readdirSync(path.join(resolved, folder.name));
        const pdfs = files.filter(f => f.endsWith(".pdf"));
        return `  ${folder.name}: ${files.includes("summary.txt") ? "✓" : "✗"} summary | ${pdfs.length ? `✓ ${pdfs[0]}` : "✗ pdf"}`;
      });
    return { content: [{ type: "text", text: `Literature folders in ${resolved}:\n\n${lines.join("\n")}` }] };
  }
);

server.tool(
  "add_paper",
  "Create a literature folder with summary.txt and optionally download the PDF.",
  {
    literature_dir: z.string().describe("Absolute path to the literature directory"),
    folder_name: z.string().describe("Folder name, e.g. tang_et_al_2026"),
    summary: z.string().describe("Full text content for summary.txt"),
    pdf_url: z.string().url().optional().describe("Optional direct PDF URL to download"),
    pdf_filename: z.string().optional().describe("Optional PDF filename (defaults to paper.pdf)"),
  },
  async ({ literature_dir, folder_name, summary, pdf_url, pdf_filename }) => {
    const folderPath = assertAllowed(path.join(literature_dir, folder_name));
    fs.mkdirSync(folderPath, { recursive: true });
    const summaryPath = path.join(folderPath, "summary.txt");
    fs.writeFileSync(summaryPath, summary, "utf8");
    const results = [`Created/updated ${summaryPath}`];
    if (pdf_url) {
      const pdfPath = path.join(folderPath, pdf_filename || "paper.pdf");
      const response = await fetch(pdf_url, { headers: FETCH_HEADERS, redirect: "follow" });
      if (!response.ok) {
        results.push(`Warning: PDF download failed (HTTP ${response.status}). Summary was saved.`);
      } else {
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(pdfPath, Buffer.from(buffer));
        results.push(`Downloaded ${Math.round(buffer.byteLength / 1024)} KB to ${pdfPath}`);
      }
    }
    return { content: [{ type: "text", text: results.join("\n") }] };
  }
);

// ===========================================================================
// LATEX / OVERLEAF TOOLS
// ===========================================================================

server.tool(
  "list_projects",
  "List all configured Overleaf projects.",
  {},
  async () => {
    if (!projectsConfig) throw new Error("projects.json not configured");
    const projects = Object.entries(projectsConfig.projects).map(([k, p]) => ({
      id: k, name: p.name, projectId: p.projectId,
    }));
    return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
  }
);

server.tool(
  "list_files",
  "List files in the local Overleaf clone. Call pull first if you need the latest remote state.",
  {
    extension: z.string().optional().describe('File extension filter (optional, e.g. ".tex")'),
    projectName: PROJ,
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
    filePath: z.string().describe("Path relative to project root"),
    projectName: PROJ,
  },
  async ({ filePath, projectName }) => {
    return { content: [{ type: "text", text: await getProject(projectName).readFile(filePath) }] };
  }
);

server.tool(
  "get_sections",
  "Get all LaTeX section headings from a file in the local clone.",
  {
    filePath: z.string().describe("Path to the LaTeX file"),
    projectName: PROJ,
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
    filePath: z.string().describe("Path to the LaTeX file"),
    sectionTitle: z.string().describe("Exact section title to extract"),
    projectName: PROJ,
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
    filePath: z.string().describe("Path relative to project root"),
    content: z.string().describe("Full file content"),
    projectName: PROJ,
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
    filePath: z.string().describe("Path relative to project root"),
    old_str: z.string().describe("String to replace; must appear exactly once"),
    new_str: z.string().describe('Replacement (use "" to delete)'),
    projectName: PROJ,
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
    filePath: z.string().describe("Path relative to project root"),
    projectName: PROJ,
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

server.tool(
  "commit_and_push",
  "Stage all local changes, commit, and push to Overleaf. The only operation that writes to the remote.",
  {
    message: z.string().describe("Commit message"),
    projectName: PROJ,
  },
  async ({ message, projectName }) => {
    const result = await getProject(projectName).commitAndPush(message);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("research-mcp running on stdio");
