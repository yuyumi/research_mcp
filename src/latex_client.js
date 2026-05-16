/**
 * latex_client.js — LatexGitClient class and getProject() helper.
 *
 * Lifted from the original index.js with no behavioral changes.
 * Handles Overleaf clone/pull/commit/push and local file ops on the clone.
 */

import { access, readFile, readdir, mkdir, writeFile, chmod, unlink } from "fs/promises";
import path from "path";
import os from "os";
import { promisify } from "util";
import { exec as execCallback } from "child_process";

import { projectsConfig, sanitizeError } from "./config.js";

const exec = promisify(execCallback);

export class LatexGitClient {
  constructor(projectId, gitToken) {
    this.projectId = projectId;
    this.gitToken = gitToken;
    this.repoPath = path.join(os.tmpdir(), `overleaf-${projectId}`);
    this.gitUrl = `https://git:${gitToken}@git.overleaf.com/${projectId}`;
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

export function getProject(name = "default") {
  if (!projectsConfig) throw new Error("projects.json not configured");
  const p = projectsConfig.projects[name];
  if (!p) throw new Error(`Project "${name}" not found in projects.json`);
  return new LatexGitClient(p.projectId, p.gitToken);
}
