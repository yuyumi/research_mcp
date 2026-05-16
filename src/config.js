/**
 * config.js — read-only configuration for the MCP.
 *
 * Loads ALLOWED_ROOT from env and projects.json from disk at startup.
 * projects.json is NEVER written by the MCP. Users edit it by hand.
 *
 * Exports:
 *   ALLOWED_ROOT                  — string | undefined
 *   projectsConfig                — parsed projects.json (or null if missing)
 *   PROTECTED_MARKER_FILENAME     — name of the sticky failure marker
 *   assertAllowed(p)              — throws if p is outside ALLOWED_ROOT
 *   assertNotInMarkedFolder(p)    — throws if any ANCESTOR of p contains the marker
 *   assertDoesNotContainMarker(p) — throws if p (if a dir) contains the marker within
 *   assertMarkerSafe(p)           — runs both ancestor and descendant checks
 *   sanitizeError(msg)            — strips git tokens from error messages
 *   getProjectEntry(n)            — returns raw projects.json entry for project name
 *   getResearchFolder(n)          — returns absolute, existing research_folder path or throws
 *
 * Marker-guard policy: the guards below are applied to MODIFYING operations
 * only. Read operations (fs_read, fs_list, fs_exists) are unguarded so the
 * agent can still inspect locked folders for diagnostics. See fs_tools.js
 * for the full per-tool routing.
 */

import { readFile } from "fs/promises";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// ALLOWED_ROOT (env)
// ---------------------------------------------------------------------------

export const ALLOWED_ROOT = process.env.ALLOWED_ROOT;
if (!ALLOWED_ROOT) {
  process.stderr.write(
    "WARN: ALLOWED_ROOT not set — filesystem tools (fs_*) will be unavailable\n"
  );
}

export function assertAllowed(filePath) {
  if (!ALLOWED_ROOT) throw new Error("ALLOWED_ROOT is not configured");
  const resolved = path.resolve(filePath);
  const root = path.resolve(ALLOWED_ROOT);
  if (!resolved.startsWith(root + path.sep) && resolved !== root)
    throw new Error(`Path '${resolved}' is outside allowed root '${root}'`);
  return resolved;
}

// ---------------------------------------------------------------------------
// projects.json (read-only; anchored to this file's location, not cwd)
// ---------------------------------------------------------------------------

const projectsConfigPath = path.join(__dirname, "..", "projects.json");

export let projectsConfig = null;
try {
  projectsConfig = JSON.parse(await readFile(projectsConfigPath, "utf-8"));
} catch {
  process.stderr.write(
    "WARN: projects.json not found — LaTeX/Overleaf tools will be unavailable\n"
  );
}

// ---------------------------------------------------------------------------
// Protected marker filename
// ---------------------------------------------------------------------------

/**
 * Sticky-failure marker dropped by literature tools when a PDF fetch fails.
 * Any folder containing this file is locked against MODIFYING operations:
 * fs_write, fs_mkdir, fs_delete, fs_move (source and dest), fs_copy (source
 * and dest). Read operations (fs_read, fs_list, fs_exists) remain available
 * so the agent can diagnose the failure and report it to the user.
 *
 * The user must remove the marker from outside the MCP (e.g. `rm` in a
 * terminal) before modifying operations on the folder become available again.
 * This prevents agent-driven retries on a known-broken acquisition.
 */
export const PROTECTED_MARKER_FILENAME = ".fetch_failed.json";

// ---------------------------------------------------------------------------
// Marker guards (used by modifying operations only)
// ---------------------------------------------------------------------------

function makeProtectedPathError(filePath, markerPath, kind) {
  const lockedFolder = path.dirname(markerPath);
  const err = new Error(
    `Path '${filePath}' is blocked by a '.fetch_failed.json' marker ` +
    `(${kind}: '${markerPath}'). Modifying operations on this folder are ` +
    `refused by design — read operations remain available. ` +
    `Ask the user to run \`rm ${markerPath}\` in a terminal to clear it.`
  );
  err.structured = {
    error: "protected_path",
    path: filePath,
    locked_folder: lockedFolder,
    marker_path: markerPath,
    kind, // "ancestor" or "descendant"
    action_required: `User must run \`rm ${markerPath}\` in a terminal.`,
  };
  return err;
}

/**
 * Refuse modifying operations on anything in or under a folder that contains
 * the marker.
 *
 * Walks UP from `filePath` to `ALLOWED_ROOT`, checking each ancestor for the
 * marker. Throws on first hit. Strict-ancestor: does NOT check whether
 * `filePath` itself contains the marker — that's the descendant guard's job,
 * and modifying tools always run both.
 *
 * The path itself need not exist; ancestors are still checked. Necessary for
 * fs_write to a fresh path inside a locked folder.
 */
export function assertNotInMarkedFolder(filePath) {
  if (!ALLOWED_ROOT) return;
  const root = path.resolve(ALLOWED_ROOT);
  let current = path.resolve(filePath);

  while (current !== root) {
    const parent = path.dirname(current);
    if (parent === current) break; // hit filesystem root without seeing ALLOWED_ROOT
    const markerCandidate = path.join(parent, PROTECTED_MARKER_FILENAME);
    if (fs.existsSync(markerCandidate)) {
      throw makeProtectedPathError(filePath, markerCandidate, "ancestor");
    }
    if (parent === root) break;
    current = parent;
  }
}

/**
 * Refuse operations on a directory whose subtree contains the marker.
 *
 * Two uses:
 *   1. fs_delete or fs_move of a folder that itself contains the marker
 *      directly (the marker IS a descendant of the target). Without this,
 *      the agent could delete the enclosing folder to escape the lock.
 *   2. fs_delete or fs_move of a folder that contains a marked subfolder
 *      somewhere deeper.
 *
 * Behavior:
 *   - If `dirPath` doesn't exist: no-op (nothing to contain).
 *   - If `dirPath` is a file: no-op.
 *   - If `dirPath` is a directory: iterative DFS, throw on first marker.
 *   - Symlinks are NOT followed (dirent.isDirectory() returns false for
 *     symlinks). Prevents loops and "escape via symlink" tricks.
 *
 * Short-circuits on first marker.
 */
export function assertDoesNotContainMarker(dirPath) {
  if (!ALLOWED_ROOT) return;
  const resolved = path.resolve(dirPath);

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;

  const stack = [resolved];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childPath = path.join(dir, e.name);
      if (e.isFile() && e.name === PROTECTED_MARKER_FILENAME) {
        throw makeProtectedPathError(dirPath, childPath, "descendant");
      }
      if (e.isDirectory()) {
        stack.push(childPath);
      }
    }
  }
}

/**
 * Combined guard: refuse if `p` is inside a marked folder OR contains the
 * marker anywhere in its subtree. Used by tools that mutate or remove paths
 * (fs_delete, fs_move source, fs_copy source).
 */
export function assertMarkerSafe(p) {
  assertNotInMarkedFolder(p);
  assertDoesNotContainMarker(p);
}

// ---------------------------------------------------------------------------
// Error sanitizing
// ---------------------------------------------------------------------------

export function sanitizeError(message) {
  if (!message) return message;
  return String(message)
    .replace(/https:\/\/[^:]+:[^@\s]+@/g, "https://[REDACTED]@")
    .replace(/olp_[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]");
}

// ---------------------------------------------------------------------------
// Project lookup
// ---------------------------------------------------------------------------

export function getProjectEntry(name) {
  if (!projectsConfig) throw new Error("projects.json not configured");
  const p = projectsConfig.projects[name];
  if (!p) throw new Error(`Project "${name}" not found in projects.json`);
  return p;
}

export function getResearchFolder(projectName) {
  const entry = getProjectEntry(projectName);
  const folder = entry.research_folder;

  if (!folder || typeof folder !== "string" || !folder.trim()) {
    const err = new Error(
      `research_folder not configured for project "${projectName}". ` +
      `Add a "research_folder" field to projects.${projectName} in projects.json ` +
      `pointing to an absolute path under ALLOWED_ROOT.`
    );
    err.structured = {
      error: "research_folder_not_configured",
      project: projectName,
      action_required: "edit_projects_json",
      hint: `Add "research_folder": "/absolute/path" to projects.${projectName}`,
    };
    throw err;
  }

  let resolved;
  try {
    resolved = assertAllowed(folder);
  } catch (e) {
    const err = new Error(
      `research_folder for project "${projectName}" is outside ALLOWED_ROOT: ${e.message}`
    );
    err.structured = {
      error: "research_folder_outside_allowed_root",
      project: projectName,
      configured_path: folder,
      action_required: "edit_projects_json",
    };
    throw err;
  }

  if (!fs.existsSync(resolved)) {
    const err = new Error(
      `research_folder for project "${projectName}" does not exist: ${resolved}. ` +
      `Create the directory or update projects.json.`
    );
    err.structured = {
      error: "research_folder_missing_on_disk",
      project: projectName,
      configured_path: resolved,
      action_required: "create_directory_or_edit_projects_json",
    };
    throw err;
  }

  if (!fs.statSync(resolved).isDirectory()) {
    const err = new Error(
      `research_folder for project "${projectName}" exists but is not a directory: ${resolved}`
    );
    err.structured = {
      error: "research_folder_not_a_directory",
      project: projectName,
      configured_path: resolved,
      action_required: "edit_projects_json",
    };
    throw err;
  }

  return resolved;
}
