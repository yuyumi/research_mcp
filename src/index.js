#!/usr/bin/env node
/**
 * research-mcp — MCP server for research workflows
 *
 * Tools:
 *   fetch_pdf(url, dest_path)   — Download a PDF from a URL and save to disk
 *   list_literature(root_dir)   — List all literature folders and their contents
 *   add_paper(root_dir, folder, summary, pdf_url?)
 *                               — Create a literature folder with summary.txt
 *                                 and optionally download the PDF
 *
 * Usage in claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "research": {
 *         "command": "node",
 *         "args": ["C:/path/to/research_mcp/src/index.js"],
 *         "env": {
 *           "ALLOWED_ROOT": "C:/Users/cyu/Documents/Princeton/Research"
 *         }
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Security: only allow writes under ALLOWED_ROOT
// ---------------------------------------------------------------------------

const ALLOWED_ROOT = process.env.ALLOWED_ROOT
  || "C:/Users/cyu/Documents/Princeton/Research";

function assertAllowed(filePath) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(ALLOWED_ROOT);
  if (!resolved.startsWith(root)) {
    throw new Error(`Path ${resolved} is outside allowed root ${root}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "research-mcp",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool: fetch_pdf
// ---------------------------------------------------------------------------

server.tool(
  "fetch_pdf",
  "Download a PDF from a URL and save it to a local file path. " +
  "Handles arxiv redirects and sets appropriate headers.",
  {
    url: z.string().url().describe("URL of the PDF to download"),
    dest_path: z.string().describe(
      "Absolute local path to save the PDF, e.g. " +
      "C:/Users/cyu/Documents/Princeton/Research/model_bias/literature/gao_et_al_2023/gao_etal.pdf"
    ),
  },
  async ({ url, dest_path }) => {
    const resolved = assertAllowed(dest_path);

    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(resolved), { recursive: true });

    // Fetch with browser-like headers to avoid 403s from arxiv/semantic scholar
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/pdf,*/*",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("pdf") && !contentType.includes("octet-stream")) {
      throw new Error(
        `URL did not return a PDF (content-type: ${contentType}). ` +
        `Try the direct PDF URL, e.g. https://arxiv.org/pdf/2210.10760`
      );
    }

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(resolved, Buffer.from(buffer));

    const sizeKb = Math.round(buffer.byteLength / 1024);
    return {
      content: [{
        type: "text",
        text: `Downloaded ${sizeKb} KB to ${resolved}`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: list_literature
// ---------------------------------------------------------------------------

server.tool(
  "list_literature",
  "List all paper folders under a literature directory, showing which have PDFs and summaries.",
  {
    literature_dir: z.string().describe(
      "Path to the literature directory, e.g. " +
      "C:/Users/cyu/Documents/Princeton/Research/model_bias/literature"
    ),
  },
  async ({ literature_dir }) => {
    const resolved = assertAllowed(literature_dir);

    if (!fs.existsSync(resolved)) {
      throw new Error(`Directory does not exist: ${resolved}`);
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const folders = entries.filter(e => e.isDirectory());

    const lines = folders.map(folder => {
      const folderPath = path.join(resolved, folder.name);
      const files = fs.readdirSync(folderPath);
      const hasSummary = files.includes("summary.txt");
      const pdfs = files.filter(f => f.endsWith(".pdf"));
      const status = [
        hasSummary ? "✓ summary" : "✗ summary",
        pdfs.length > 0 ? `✓ ${pdfs[0]}` : "✗ pdf",
      ].join(" | ");
      return `  ${folder.name}: ${status}`;
    });

    return {
      content: [{
        type: "text",
        text: `Literature folders in ${resolved}:\n\n${lines.join("\n")}`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: add_paper
// ---------------------------------------------------------------------------

server.tool(
  "add_paper",
  "Create a literature folder with a summary.txt and optionally download the PDF. " +
  "If the folder already exists, updates the summary without overwriting the PDF.",
  {
    literature_dir: z.string().describe(
      "Path to the literature directory"
    ),
    folder_name: z.string().describe(
      "Name for the paper folder, e.g. tang_et_al_2026"
    ),
    summary: z.string().describe(
      "Full text content for summary.txt"
    ),
    pdf_url: z.string().url().optional().describe(
      "Optional: direct PDF URL to download, e.g. https://arxiv.org/pdf/2210.10760"
    ),
    pdf_filename: z.string().optional().describe(
      "Optional: filename for the PDF, e.g. tang_etal.pdf (defaults to paper.pdf)"
    ),
  },
  async ({ literature_dir, folder_name, summary, pdf_url, pdf_filename }) => {
    const folderPath = assertAllowed(path.join(literature_dir, folder_name));
    fs.mkdirSync(folderPath, { recursive: true });

    // Write summary
    const summaryPath = path.join(folderPath, "summary.txt");
    fs.writeFileSync(summaryPath, summary, "utf8");

    const results = [`Created/updated ${summaryPath}`];

    // Optionally download PDF
    if (pdf_url) {
      const filename = pdf_filename || "paper.pdf";
      const pdfPath = path.join(folderPath, filename);

      const response = await fetch(pdf_url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/pdf,*/*",
        },
        redirect: "follow",
      });

      if (!response.ok) {
        results.push(`Warning: PDF download failed (HTTP ${response.status}). Summary was saved.`);
      } else {
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(pdfPath, Buffer.from(buffer));
        const sizeKb = Math.round(buffer.byteLength / 1024);
        results.push(`Downloaded ${sizeKb} KB to ${pdfPath}`);
      }
    }

    return {
      content: [{
        type: "text",
        text: results.join("\n"),
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
