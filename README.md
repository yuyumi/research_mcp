# research-mcp

A lightweight MCP server for research workflows. Provides generic filesystem access plus research-specific tools for managing literature folders and downloading PDFs.

## Tools

### Filesystem

| Tool | Description |
|------|-------------|
| `fs_read` | Read text content of a file (supports `head`/`tail` for partial reads) |
| `fs_write` | Write text content to a file, creating parent directories as needed |
| `fs_move` | Move or rename a file or directory |
| `fs_copy` | Copy a file |
| `fs_delete` | Delete a file or directory (recursive) |
| `fs_list` | List directory contents with file sizes |
| `fs_mkdir` | Create a directory and all parent directories |
| `fs_exists` | Check whether a path exists |

### Research

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

`ALLOWED_ROOT` is required — the server will refuse to start without it. All file operations are restricted to paths under this directory.

### 3. Restart Claude Desktop

## Literature folder structure

```
literature/
├── author_et_al_year/
│   ├── summary.txt
│   └── paper.pdf
├── author_et_al_year/
│   ├── summary.txt
│   └── paper.pdf
```

## Security

- `ALLOWED_ROOT` is required — the server exits on startup if not set
- All file operations reject paths outside `ALLOWED_ROOT`
- No network access except for `fetch_pdf` and `add_paper` PDF downloads

## Requirements

- Node.js >= 18
