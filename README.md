# research-mcp

A lightweight MCP server for academic research workflows. Lets Claude download PDFs from URLs, manage literature folders, and create paper summaries directly on your local filesystem.

## Tools

| Tool | Description |
|------|-------------|
| `fetch_pdf` | Download a PDF from any URL (handles arxiv redirects) and save to disk |
| `list_literature` | List all paper folders showing which have summaries and PDFs |
| `add_paper` | Create a literature folder with summary.txt and optionally download the PDF |

## Setup

### 1. Install dependencies

```bash
cd research_mcp
npm install
```

### 2. Add to Claude Desktop config

Edit your Claude Desktop config file:
- **Windows**: `%LOCALAPPDATA%\Claude\claude_desktop_config.json`
- **Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "@modelcontextprotocol/server-filesystem",
        "/path/to/your/research/directory"
      ]
    },
    "research": {
      "command": "node",
      "args": ["/path/to/research_mcp/src/index.js"],
      "env": {
        "ALLOWED_ROOT": "/path/to/your/research/directory"
      }
    }
  }
}
```

Replace `/path/to/your/research/directory` with the root folder you want Claude to access, and `/path/to/research_mcp` with wherever you cloned this repo.

### 3. Restart Claude Desktop

The research MCP will now be available in all conversations.

## Usage examples

**Download a PDF:**
> "Download the Gao et al. scaling laws paper from https://arxiv.org/pdf/2210.10760 and save it to the literature/gao_et_al_2023 folder"

**List literature status:**
> "List all papers in my literature folder"

**Add a new paper with PDF:**
> "Add a summary and download the PDF for Tang et al. 2026 from arxiv"

## Literature folder structure

The server works best with a consistent folder structure:

```
literature/
├── author_et_al_year/
│   ├── summary.txt
│   └── paper.pdf
├── author_et_al_year/
│   ├── summary.txt
│   └── paper.pdf
```

Each `summary.txt` should contain the paper's key contributions, theorems, and relevance to your research.

## Security

All file writes are restricted to `ALLOWED_ROOT`. Paths outside this directory are rejected. Never set `ALLOWED_ROOT` to a sensitive system directory.

## Requirements

- Node.js >= 18
- Claude Desktop
