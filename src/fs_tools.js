/**
 * fs_tools.js — filesystem tools scoped to ALLOWED_ROOT.
 *
 * Registers: fs_read, fs_write, fs_move, fs_copy, fs_delete,
 *            fs_list, fs_mkdir, fs_exists.
 *
 * Marker enforcement (see config.js for the helpers):
 *
 *   Tool      | Path(s) checked            | Guard
 *   --------- | -------------------------- | --------------------------
 *   fs_read   | path                        | none (read-only)
 *   fs_list   | path                        | none (read-only)
 *   fs_exists | path                        | none (read-only)
 *   fs_write  | path                        | assertNotInMarkedFolder
 *   fs_mkdir  | path                        | assertNotInMarkedFolder
 *   fs_delete | path                        | assertMarkerSafe (both)
 *   fs_move   | source                      | assertMarkerSafe (both)
 *             | destination                 | assertNotInMarkedFolder
 *   fs_copy   | source                      | assertMarkerSafe (both)
 *             | destination                 | assertNotInMarkedFolder
 *
 * Read operations are unguarded by design — the agent must be able to
 * inspect locked folders to diagnose failures. Anything that changes
 * filesystem state (including fs_copy, which creates new state at the
 * destination) is gated.
 *
 * The asymmetry on move/copy destinations is deliberate: writing INTO a
 * tree only needs the ancestor check (you can't put something inside a
 * locked folder). The source side needs both — moving/copying out of a
 * marked directory must be refused.
 */

import fs from "fs";
import path from "path";
import { z } from "zod";
import {
  assertAllowed,
  assertNotInMarkedFolder,
  assertMarkerSafe,
} from "./config.js";

/**
 * Ancestor-only gate for modifying ops that don't descend.
 * Use for fs_write, fs_mkdir, and the destination of move/copy.
 */
function gateAncestor(filePath) {
  const resolved = assertAllowed(filePath);
  assertNotInMarkedFolder(resolved);
  return resolved;
}

/**
 * Full gate (ancestor + descendant) for modifying ops on directories.
 * Use for fs_delete, and the source of move/copy.
 */
function gateFull(filePath) {
  const resolved = assertAllowed(filePath);
  assertMarkerSafe(resolved);
  return resolved;
}

export function register(server) {
  // -------------------------------------------------------------------------
  // READ operations — only assertAllowed, no marker guard.
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // MODIFYING operations — guarded.
  // -------------------------------------------------------------------------

  server.tool(
    "fs_write",
    "Write text to a file within ALLOWED_ROOT, creating parent directories as needed.",
    {
      path: z.string().describe("Absolute path to the file"),
      content: z.string().describe("Text content to write"),
    },
    async ({ path: filePath, content }) => {
      const resolved = gateAncestor(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      return { content: [{ type: "text", text: `Written ${bytes} bytes to ${resolved}` }] };
    }
  );

  server.tool(
    "fs_mkdir",
    "Create a directory and all parent directories within ALLOWED_ROOT.",
    { path: z.string().describe("Absolute path of the directory to create") },
    async ({ path: dirPath }) => {
      const resolved = gateAncestor(dirPath);
      fs.mkdirSync(resolved, { recursive: true });
      return { content: [{ type: "text", text: `Created directory: ${resolved}` }] };
    }
  );

  server.tool(
    "fs_delete",
    "Delete a file or directory (recursive) within ALLOWED_ROOT. No undo.",
    { path: z.string().describe("Absolute path to delete") },
    async ({ path: filePath }) => {
      const resolved = gateFull(filePath);
      if (!fs.existsSync(resolved))
        return { content: [{ type: "text", text: `Already gone: ${resolved}` }] };
      const isDir = fs.statSync(resolved).isDirectory();
      if (isDir) fs.rmSync(resolved, { recursive: true, force: true });
      else fs.unlinkSync(resolved);
      return { content: [{ type: "text", text: `Deleted ${isDir ? "directory" : "file"}: ${resolved}` }] };
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
      const src = gateFull(source);
      const dst = gateAncestor(destination);
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
      // fs_copy is a MODIFYING operation despite reading from source — it
      // creates new state at the destination. Block on source-side marker
      // to prevent producing copies that include the marker (or that
      // exfiltrate the contents of locked folders).
      const src = gateFull(source);
      const dst = gateAncestor(destination);
      if (!fs.existsSync(src)) throw new Error(`Source not found: ${src}`);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      const kb = Math.round(fs.statSync(dst).size / 1024);
      return { content: [{ type: "text", text: `Copied ${src} → ${dst} (${kb} KB)` }] };
    }
  );
}
