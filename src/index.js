#!/usr/bin/env node
/**
 * research-mcp — unified MCP server for research workflows
 *
 * Filesystem tools (scoped to ALLOWED_ROOT env var):
 *   fs_read, fs_write, fs_move, fs_copy, fs_delete, fs_list, fs_mkdir, fs_exists
 *
 * Literature tools (per-project research_folder in projects.json):
 *   add_paper, get_summary, list_summaries, validate_citations
 *
 * LaTeX/Overleaf tools (configured via projects.json):
 *   list_projects, list_files, read_file, get_sections, get_section_content,
 *   status_summary, write_file, str_replace, delete_file, pull, commit_and_push
 *
 * commit_and_push is GATED by validate_citations — refuses if any \cite{} key
 * in the .tex sources lacks a complete summary in the project's research_folder.
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

import * as fsTools from "./fs_tools.js";
import * as latexTools from "./latex_tools.js";
import * as literature from "./literature.js";
import * as citations from "./citations.js";
import * as commit from "./commit.js";

const server = new McpServer({
  name: "research-mcp",
  version: "4.0.0",
});

fsTools.register(server);
latexTools.register(server);
literature.register(server);
citations.register(server);
commit.register(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("research-mcp running on stdio");
