# research-mcp

A unified MCP server for research workflows. One server handles filesystem access, paper acquisition with enforced summaries, and LaTeX/Overleaf project sync — with a citation gate that refuses to push uncited or unsummarized work.

## What this enforces

When you cite something in your .tex, you must have read it. When you've read it, you must have summarized it. The MCP enforces both:

- `add_paper` acquires the PDF into a per-paper folder under the project's `research_folder`. The folder is the proof of acquisition.
- `write_summary` records a four-field schema (contributions, weaknesses, relevance, key result) into `summary.md`. It refuses to run unless a PDF is present — you can't summarize what you haven't downloaded.
- `commit_and_push` scans every `\cite*{}` in your .tex files and refuses to push if any cited key lacks a complete summary.
- A failed PDF fetch is sticky: a `.fetch_failed.json` marker is dropped and the paper folder becomes read-only to the MCP (modifying tools refuse; reads still work for diagnostics). Only the user can clear the marker, from outside the MCP.

The goal is to make "I cited a paper I didn't read" impossible to do accidentally.

---

## Tools

### Filesystem
All operations are scoped to `ALLOWED_ROOT`. Modifying operations are additionally blocked from touching folders containing `.fetch_failed.json` — see the failure-marker section below.

| Tool | Description | Op type |
|------|-------------|---------|
| `fs_read` | Read a file (supports `head`/`tail` for partial reads) | read |
| `fs_list` | List directory contents with file sizes | read |
| `fs_exists` | Check whether a path exists | read |
| `fs_write` | Write text to a file, creating parent directories as needed | modify |
| `fs_mkdir` | Create a directory and all parent directories | modify |
| `fs_delete` | Delete a file or directory (recursive) | modify |
| `fs_move` | Move or rename a file or directory | modify |
| `fs_copy` | Copy a file | modify |

### Literature
All four require `projectName` (no default). The paper folder for `citation_key` lives at `<projects[projectName].research_folder>/<citation_key>/`.

| Tool | Description |
|------|-------------|
| `add_paper` | Acquire a paper: ensures the folder exists and contains a PDF. Does NOT write a summary. |
| `write_summary` | Write a schema-validated `summary.md`. Requires the folder + a PDF to be present. |
| `get_summary` | Read and parse the summary for a citation_key. |
| `list_summaries` | List every paper folder in the project's `research_folder` with summary/PDF/marker status. |

### LaTeX / Overleaf
All require `projectName` (no default). All write operations are **local only** — the remote is never touched until you explicitly call `commit_and_push`.

| Tool | Description |
|------|-------------|
| `list_projects` | List all configured Overleaf projects, including each `research_folder` |
| `pull` | Sync local clone from Overleaf (git pull). Call at the start of a session |
| `list_files` | List files in the local clone |
| `read_file` | Read a file from the local clone |
| `get_sections` | Get all LaTeX section headings from a file |
| `get_section_content` | Get the full content of a specific section |
| `status_summary` | File count and section headings from `main.tex` |
| `write_file` | Create or overwrite a file locally |
| `str_replace` | Replace a unique string in a file locally. Fails if the string is absent or non-unique |
| `delete_file` | Delete a file locally |
| `validate_citations` | Scan all .tex files, extract `\cite*{}` keys, report which lack a complete summary |
| `commit_and_push` | Stage, commit, push to Overleaf. **Refuses if `validate_citations` reports any incomplete keys.** |

---

## Setup

### 1. Install dependencies

```bash
cd research_mcp
npm install
```

### 2. Configure projects

Copy the example config and fill in your project details:

```bash
cp projects.example.json projects.json
```

Edit `projects.json`:

```json
{
  "projects": {
    "myproject": {
      "name": "My Paper",
      "projectId": "your_overleaf_project_id",
      "gitToken": "your_overleaf_git_token",
      "research_folder": "/absolute/path/to/myproject_literature"
    },
    "another_project": {
      "name": "Another Paper",
      "projectId": "another_project_id",
      "gitToken": "your_overleaf_git_token",
      "research_folder": "/absolute/path/to/another_literature_folder"
    }
  }
}
```

**Required fields per project:**
- `name` — display name
- `projectId` — Overleaf project ID (see below)
- `gitToken` — Overleaf personal git token
- `research_folder` — absolute path (under `ALLOWED_ROOT`) where paper folders for this project live. Must exist on disk; the MCP will NOT create it.

`projectName` is required on every tool — there is no default project. This is deliberate: a typo on the project argument should fail loudly, not silently write to the wrong project.

**Finding your project ID and git token:**

1. Open your Overleaf project
2. Click **Menu** (top left) → **Git**
3. The clone URL looks like: `https://git.overleaf.com/YOUR_PROJECT_ID`
4. Copy `YOUR_PROJECT_ID` into `projectId`
5. For `gitToken`: go to [overleaf.com/user/settings](https://www.overleaf.com/user/settings) → scroll to **Git Integration** → generate a token

`projects.json` is gitignored and never committed — your credentials stay local. The MCP only reads it; the file is never modified by the MCP. To add or change a research folder, edit the file by hand and restart the MCP.

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

Replace `/path/to/research_mcp` with the absolute path to this repo, and `/path/to/your/research/directory` with the root folder you want Claude to have filesystem access to. Every `research_folder` in `projects.json` must live under `ALLOWED_ROOT`.

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

Both `ALLOWED_ROOT` and `projects.json` are optional — if either is missing the server starts with a warning and the relevant tools will throw when called.

---

## Typical workflow

### Citing a new paper

```
# Acquire the PDF — creates <research_folder>/ouyang2022training/paper.pdf
add_paper(
  projectName  = "myproject",
  citation_key = "ouyang2022training",
  pdf_url      = "https://arxiv.org/pdf/2203.02155"
)

# (Read the PDF)

# Record the schema — writes <research_folder>/ouyang2022training/summary.md
write_summary(
  projectName  = "myproject",
  citation_key = "ouyang2022training",
  summary = {
    contributions: "...",
    weaknesses:    "...",
    relevance:     "...",
    key_result:    "..."
  }
)

# Edit .tex (this is where \cite{ouyang2022training} appears)
str_replace projectName="myproject" filePath="sections/preliminaries.tex" ...

# Publish — gate runs first, refuses if any cite lacks a summary
commit_and_push projectName="myproject" message="Add InstructGPT discussion"
```

### Backfilling for an existing project

```
# See what's missing
validate_citations projectName="myproject"

# Loop add_paper + write_summary for each incomplete key

# Once validate_citations returns no incomplete keys, commit_and_push works
```

---

## Literature folder structure

```
<research_folder>/
├── ouyang2022training/
│   ├── paper.pdf
│   └── summary.md
├── bai2022training/
│   ├── paper.pdf
│   └── summary.md
└── failed_to_fetch/
    └── .fetch_failed.json   <-- folder is locked against modifying ops until user removes this
```

The citation key is the folder name. `summary.md` follows a fixed format with four required sections AND a canonical JSON block in an HTML comment — the JSON block is the source of truth for `validate_citations`. Hand-edits to the markdown body are clobbered on the next `write_summary` call.

---

## Summary schema

`write_summary` requires a `summary` object with four fields, each a non-empty string of ≤1000 characters:

| Field | What it captures |
|-------|------------------|
| `contributions` | What the paper contributes: new methods, results, framings, ideas |
| `weaknesses` | Limitations, gaps, critiques |
| `relevance` | How this paper relates to your project / problem |
| `key_result` | The single most important result or claim, stated precisely |

Validation is at the MCP tool boundary (Zod). A call with a missing or empty field is rejected before any file is written.

---

## Citation gate

`commit_and_push` runs `validate_citations` first. The validator:

- Scans every `.tex` file in the Overleaf clone
- Strips whole-line `%` comments
- Matches `\cite`, `\citep`, `\citet`, `\citeauthor`, `\citeyear`, `\citealt`, `\citealp`, `\citenum`, `\citetext` (plus capitalized and starred variants), with optional `[pre][post]` bracketed args
- Splits comma-separated key lists (`\cite{a, b, c}` → three keys)
- Ignores `\nocite{}` (not cited in text)
- Checks each key against `<research_folder>/<key>/summary.md`

If any key is missing, has an unparseable summary, or has any empty/over-cap field, the commit is refused with a JSON payload listing every offender and where in the .tex it appears.

The only way through the gate is to `add_paper` + `write_summary` for every incomplete key (or remove the citation from the .tex). The MCP intentionally provides no bypass.

---

## Failure marker (`.fetch_failed.json`)

When `add_paper` fails to download a PDF — HTTP error, non-PDF content-type, or network exception — it writes `.fetch_failed.json` into the paper folder containing the URL, error, detail, and timestamp. While that marker exists:

- `add_paper` and `write_summary` refuse for that citation_key.
- **Modifying `fs_*` tools refuse to touch anything in or under the folder.** Specifically `fs_write`, `fs_mkdir`, `fs_delete`, `fs_move` (source and destination), `fs_copy` (source and destination) — all blocked, including deletion or rename of the enclosing folder via descendant detection.
- **Read `fs_*` tools (`fs_read`, `fs_list`, `fs_exists`) remain available.** The agent can still inspect the locked state — read the marker, list the folder, check for the PDF — so it can diagnose the failure and report it to the user clearly.
- `list_summaries` reports `fetch_failed: true` on the row so you can spot stuck folders.

The MCP **cannot** clear the marker. By design, only the user can — by running `rm <path/to/.fetch_failed.json>` in a terminal (or deleting it from Finder/Explorer). This is the only mechanism by which the MCP creates state that an agent loop cannot recover from on its own; the intent is to break runaway-retry loops on broken URLs and force a human in the loop.

To recover:

```bash
# In your terminal
rm /path/to/research_folder/stuck_citation_key/.fetch_failed.json
# Or delete the whole paper folder to start over
rm -rf /path/to/research_folder/stuck_citation_key
```

Then retry `add_paper` with a different URL.

---

## Architecture

```
src/
├── index.js          — server boot, tool registration only
├── config.js         — env, projects.json, path/marker guards
├── fs_tools.js       — fs_* tools (modifying ops gated by marker checks)
├── latex_client.js   — LatexGitClient (git clone/pull/commit/push)
├── latex_tools.js    — Overleaf tools (list_projects, read_file, ...)
├── literature.js     — add_paper, write_summary, get_summary, list_summaries
├── citations.js      — \cite{} regex + validate_citations
└── commit.js         — gated commit_and_push
```

The split is by concern. `index.js` is ~50 lines: import, register, boot. Each tool file exports a `register(server)` function.

---

## Security

- All filesystem operations are restricted to `ALLOWED_ROOT` — paths outside it are rejected
- The `.fetch_failed.json` marker locks any folder containing it against modifying `fs_*` tools; reads remain available for diagnostics
- Overleaf credentials live only in `projects.json`, which is gitignored
- Git tokens are passed to git via a one-off `GIT_ASKPASS` script rather than embedded in URLs, keeping them out of process arguments and error messages
- `projects.json` is read once at startup and never written by the MCP
- Network access is limited to: `add_paper` PDF downloads, `pull`, `commit_and_push`

---

## Requirements

- Node.js >= 18
