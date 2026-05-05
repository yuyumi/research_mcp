# research-mcp

A unified MCP server for research workflows. One server handles filesystem access, PDF and literature management, and LaTeX/Overleaf project sync.

## Tools

### Filesystem
All operations are scoped to `ALLOWED_ROOT`.

| Tool | Description |
|------|-------------|
| `fs_read` | Read a file (supports `head`/`tail` for partial reads) |
| `fs_write` | Write text to a file, creating parent directories as needed |
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
| `add_paper` | Create a literature folder with `summary.txt` and optionally download the PDF |

### LaTeX / Overleaf
All write operations are **local only** — the remote is never touched until you explicitly call `commit_and_push`.

| Tool | Description |
|------|-------------|
| `list_projects` | List all configured Overleaf projects |
| `pull` | Sync local clone from Overleaf (git pull). Call at the start of a session |
| `list_files` | List files in the local clone |
| `read_file` | Read a file from the local clone |
| `get_sections` | Get all LaTeX section headings from a file |
| `get_section_content` | Get the full content of a specific section |
| `status_summary` | File count and section headings from `main.tex` |
| `write_file` | Create or overwrite a file locally |
| `str_replace` | Replace a unique string in a file locally. Fails if the string is absent or non-unique |
| `delete_file` | Delete a file locally |
| `commit_and_push` | Stage all local changes, commit, and push to Overleaf |

---

## Setup

### 1. Install dependencies

```bash
cd research_mcp
npm install
```

### 2. Configure Overleaf projects

Copy the example config and fill in your project details:

```bash
cp projects.example.json projects.json
```

Edit `projects.json`:

```json
{
  "projects": {
    "default": {
      "name": "My Paper",
      "projectId": "your_overleaf_project_id",
      "gitToken": "your_overleaf_git_token"
    },
    "another_project": {
      "name": "Another Paper",
      "projectId": "another_project_id",
      "gitToken": "your_overleaf_git_token"
    }
  }
}
```

**Finding your project ID and git token:**

1. Open your Overleaf project
2. Click **Menu** (top left) → **Git**
3. The clone URL looks like: `https://git.overleaf.com/YOUR_PROJECT_ID`
4. Copy `YOUR_PROJECT_ID` into `projectId`
5. For `gitToken`: go to [overleaf.com/user/settings](https://www.overleaf.com/user/settings) → scroll to **Git Integration** → generate a token

`projects.json` is gitignored and never committed — your credentials stay local.

The `"default"` project is used when no `projectName` argument is provided to any tool.

### 3. Add to Claude Desktop config

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

Replace `/path/to/research_mcp` with the absolute path to this repo, and `/path/to/your/research/directory` with the root folder you want Claude to have filesystem access to.

**Windows paths** use double backslashes:

```json
{
  "mcpServers": {
    "research": {
      "command": "node",
      "args": ["C:\\path\\to\\research_mcp\\src\\index.js"],
      "env": {
        "ALLOWED_ROOT": "C:\\path\\to\\your\\research"
      }
    }
  }
}
```

### 4. Restart Claude Desktop

Both `ALLOWED_ROOT` and `projects.json` are optional — if either is missing the server starts with a warning and the relevant tools will throw an error when called. This means you can use filesystem-only or Overleaf-only mode without configuring both.

---

## Typical Overleaf workflow

```
# Start of session — sync from remote
pull

# Make edits (local only, nothing pushed yet)
str_replace sections/theory.tex  ...
write_file sections/new_section.tex  ...

# Review what changed, then publish
commit_and_push "Fix proof of Lemma 3"
```

**Note:** `str_replace` requires the target string to appear exactly once in the file. For large edits, use `write_file` to replace the whole file.

---

## Literature folder structure

```
literature/
├── author_et_al_year/
│   ├── summary.txt
│   └── paper.pdf
└── author_et_al_year/
    ├── summary.txt
    └── paper.pdf
```

Use `add_paper` to create a folder, write a summary, and optionally download the PDF in one step:

```
add_paper(
  literature_dir = "/path/to/literature",
  folder_name    = "gao_et_al_2023",
  summary        = "...",
  pdf_url        = "https://arxiv.org/pdf/2210.10760",
  pdf_filename   = "gao_etal.pdf"
)
```

---

## Security

- All filesystem operations are restricted to `ALLOWED_ROOT` — paths outside it are rejected
- Overleaf credentials live only in `projects.json`, which is gitignored
- Git tokens are passed to git via a one-off `GIT_ASKPASS` script rather than embedded in URLs, keeping them out of process arguments and error messages
- No network access except `fetch_pdf`, `add_paper` PDF downloads, `pull`, and `commit_and_push`

---

## Requirements

- Node.js >= 18
