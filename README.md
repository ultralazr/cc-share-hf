# cc-share-hf

Publish [Claude Code](https://claude.ai/code) coding agent sessions from one OSS project to a Hugging Face dataset.

This is a fork of [badlogic/pi-share-hf](https://github.com/badlogic/pi-share-hf) adapted to work with Claude Code session logs instead of Pi coding agent logs.

It is an incremental pipeline for:

1. collecting sessions for one project
2. **PII discovery** via LLM pre-pass (Haiku) — finds names, emails, credentials, URLs
3. **attribution redaction** — auto-redacts cwd, project slug, git remote, and more from workspace config
4. redacting exact secrets from your env file and `--secret`
5. rejecting sessions that match user-provided deny patterns via `--deny`
6. scanning redacted output with [TruffleHog](https://github.com/trufflesecurity/trufflehog) to detect and verify surviving secrets
7. running LLM review on the remaining sessions
8. uploading only sessions that pass all checks

Use it if you want to:

- publish a public dataset of your Claude Code traces
- share real agent traces for analysis or training data
- keep project-specific sessions on Hugging Face over time without reprocessing everything on every run

It keeps state in a workspace, so repeated runs only process what changed (updated sessions, new sessions).

## Supported input

- [Claude Code](https://claude.ai/code) session JSONL files from `~/.claude/projects/<project>/`
- Session entries typed as `user`, `assistant`, `system`, `custom-title`, etc.

## Changes from upstream (pi-share-hf)

- **Session source**: reads from `~/.claude/projects/` instead of `~/.pi/`
- **Project dir naming**: `C:\DATA\projects\foo` → `C--DATA-projects-foo` (colons, backslashes, and spaces → dashes)
- **Session format**: handles Claude Code JSONL format (`user`/`assistant` roles, `tool_use`/`tool_result`/`thinking` content blocks, `media_type` for images) instead of Pi format
- **Redactor**: detects images via `media_type` field (Claude Code) in addition to `mimeType` (Pi)
- **PII discovery**: new LLM-assisted pre-pass using Haiku to dynamically find and redact sensitive data — see [PII discovery](#pii-discovery) below
- **Attribution redaction**: new deterministic module that auto-derives redaction rules from workspace config — see [Attribution redaction](#attribution-redaction) below
- **`--visibility` flag**: controls whether OSS-public or private-project attribution rules are applied
- **Review runner**: uses `claude` CLI instead of Anthropic SDK; passes review prompt via stdin to avoid Windows cmd.exe 32k character argument limit; uses `--system-prompt` to prevent global CLAUDE.md auto-load from interfering with review
- **Context files**: defaults to `README.md`, `CLAUDE.md`, `AGENTS.md` in project root; falls back to `~/.claude/CLAUDE.md` if none found
- **`approve` command**: new command to manually approve sessions that failed LLM review after manual inspection
- **Dataset format**: uploads single-row-per-session JSONL with columns `harness`, `session_id`, `traces`, `file_name` to produce the same Parquet structure as the Pi dataset
- **No `--provider` flag**: Claude Code review only uses the `claude` CLI, so provider selection is not exposed

## Install

```bash
npm install -g cc-share-hf
```

Install TruffleHog:

```bash
brew install trufflehog
```

For Linux and Windows, use the upstream install instructions:

- https://github.com/trufflesecurity/trufflehog

Install Claude Code (required for LLM review):

```bash
npm install -g @anthropic-ai/claude-code
```

For Hugging Face auth, create a write token and either:

```bash
export HF_TOKEN=hf_xxx
```

or save it to:

```text
~/.cache/huggingface/token
```

The CLI checks startup requirements and exits with install or auth instructions if something is missing.

## Workflow

Use one workspace per OSS project. In your OSS project directory:

1. add `.claude/hf-sessions/` to `.gitignore`
2. run `cc-share-hf init` once
3. run `cc-share-hf collect` to gather changed and new sessions, run PII discovery, apply attribution redaction, redact known secrets, filter by `--deny`, scan with TruffleHog, and run LLM review
4. inspect what would be uploaded with `cc-share-hf list --uploadable`, `cc-share-hf grep`, and the images folder if images are enabled
5. reject anything you do not want published; manually approve sessions that LLM review wrongly blocked
6. run `cc-share-hf upload`
7. repeat from step 3 whenever you want to publish new sessions

The workspace is incremental. It keeps the collected state so repeated runs only process what changed.

## Quick start

Inside your OSS project:

```bash
cd /path/to/my-project
echo ".claude/hf-sessions/" >> .gitignore
```

Initialize once:

```bash
# personal namespace, OSS project (public git remote is fine to keep)
cc-share-hf init --repo myuser/my-project-sessions --visibility oss

# private project (also redacts git remote, GitHub user/repo, commit SHAs)
cc-share-hf init --repo myuser/my-sessions --visibility private
```

Collect sessions:

```bash
cc-share-hf collect \
  --secret secrets.txt \
  --deny deny.txt \
  --model claude-sonnet-4-6 --thinking medium \
  --parallel 4 \
  README.md CLAUDE.md
```

Recommended inputs:

- `secrets.txt`: one known secret per line. Generate it just before `collect`, do not commit it, and delete it after use.
- `deny.txt`: one regex per line for names, topics, or projects that should never be published
- `README.md CLAUDE.md`: project context for the LLM review so it can distinguish OSS work from unrelated work

You can also repeat flags directly:

- `--secret <file>` or `--secret <literal>`
- `--deny <file>` or `--deny <regex>`

If you do not want a secrets file on disk, pass repeated `--secret <literal>` values instead.

Check what would be uploaded:

```bash
cc-share-hf list --uploadable
```

Search only the uploadable set:

```bash
cc-share-hf grep -i 'my-private-project|counterparty-name|finance'
```

Reject anything you do not want published:

```bash
cc-share-hf reject 2026-01-16T11-03-04-216Z_b8b30402-d134-4f0d-9e6e-e2f72ada5a2f.jsonl
```

Manually approve a session that passed your manual inspection but failed LLM review:

```bash
cc-share-hf approve 2026-01-16T11-03-04-216Z_b8b30402-d134-4f0d-9e6e-e2f72ada5a2f.jsonl
```

Upload:

```bash
cc-share-hf upload --dry-run
cc-share-hf upload
```

## Dataset format

Each uploaded row has four columns matching the Pi dataset structure:

| Column | Type | Description |
| --- | --- | --- |
| `harness` | string | Always `claude-code` |
| `session_id` | string | UUID matching the session filename (without `.jsonl`) |
| `traces` | list | Array of parsed JSONL entries from the redacted session |
| `file_name` | string | Original session filename (e.g. `abc123.jsonl`) |

## Redaction pipeline

cc-share-hf applies four distinct redaction layers in order. Each is independent; together they cover different classes of leaks.

### 1. PII discovery

**Not present in the original pi-share-hf.**

Before any redaction, a Haiku pre-pass scans the natural language content of every session and extracts sensitive values it finds, including:

- real person names (first, last, full)
- company and client names — including abbreviations, domain variants, and derived identifiers (e.g. "Acme", "acmecorp", "acme.com" all captured as separate entries)
- internal project codenames
- email addresses and phone numbers
- private or internal URLs (corporate dashboards, internal APIs, cloud console links)
- passwords, API keys, tokens, and hardcoded credentials — even when embedded inside source code, config files, or test scripts (e.g. `TEST_PASSWORD = "..."`, `apiKey: "..."`, `Bearer ...`)

Critically, the scanner also reads **tool call inputs** (what the assistant passed to `Write`, `Bash`, `Edit`, etc.), not just conversational text. This catches credentials that were written to files or executed as commands but never mentioned in plain prose.

Discovered items are merged into `redact.csv` in the workspace with stable placeholders (`[PERSON_1]`, `[COMPANY_2]`, `[CREDENTIAL_1]`, etc.) and cached by session hash so unchanged sessions skip the LLM call on subsequent runs.

The PII scan is skipped with `--no-pii-scan`. The OSS project name can be excluded from redaction with `--keep-project-name`.

Workspace files created:

```text
.claude/hf-sessions/
  redact.csv            discovered + user-defined find/replace pairs
  redact-patterns.csv   regex patterns (email catch-all pre-populated)
  pii/                  per-session discovery cache (*.pii.json)
```

You can also hand-edit `redact.csv` to add known sensitive values before running `collect`. The LLM-discovered items are merged in, not overwritten.

### 2. Attribution redaction

**Not present in the original pi-share-hf.**

A deterministic module auto-derives redaction rules from the workspace config — no manual enumeration needed. Rules are split into two tiers controlled by `--visibility`.

**Tier 1 — always applied (both `oss` and `private`):**

| What | Placeholder | Why |
| --- | --- | --- |
| Raw `cwd` path (all slash variants) | `[PROJECT_ROOT]` | Appears on every session entry; reveals local filesystem layout |
| Claude Code project slug (derived from cwd) | `[PROJECT_SLUG]` | Appears in session file paths and project dirs |
| Vercel Blob storage host tokens | `[BLOB_HOST]` | Embed the project's private blob store ID |

**Tier 2 — applied only for `--visibility private` (default):**

| What | Placeholder | Why |
| --- | --- | --- |
| Git remote URL (`origin`) | `[GIT_REMOTE]` | Reveals repo identity for private repos |
| GitHub `owner/repo` combined | `[GH_REPO]` | Shorter form also visible in git output |
| GitHub owner (standalone) | `[GH_USER]` | Identifiable even without repo name |
| Repo slug (standalone) | `[REPO]` | Same |
| Commit SHA ranges (`abc..def`) | `[GIT_RANGE]` | Links sessions to specific commits in private history |

For public OSS projects (`--visibility oss`), Tier 2 is skipped — the git remote and commit SHAs appear on GitHub anyway, so redacting them adds noise without benefit.

Attribution pairs run before PII pairs. Longer strings always take precedence over shorter ones, so a full URL like `https://github.com/owner/repo.git` is replaced before standalone `owner` or `repo` tokens are processed.

The attribution hash is included in the redaction cache key, so changing `--visibility` (e.g. re-init with `oss` instead of `private`) forces re-processing of all affected sessions.

### 3. Exact-secret redaction

This is the redaction layer present in the original pi-share-hf.

Sources:

- `--env-file` (default: `~/.zshrc`) — all `export VAR=value` assignments
- `--secret <file>` — one secret per line
- `--secret <literal>` — a single literal value

Matched values are replaced with `[SECRET_VAR_NAME]` using exact string matching. This is high-precision and zero-noise. It only catches what you explicitly provided.

### 4. TruffleHog scan

TruffleHog runs against the **already-redacted** output, not the raw session. At that point, exact secrets and LLM-discovered PII should already be gone. TruffleHog acts as a backstop for anything secret-like (API keys, tokens, credentials) that slipped through the earlier layers.

Any TruffleHog finding blocks the session from upload automatically.

Per-session reports are stored in:

```text
.claude/hf-sessions/reports/<session>.trufflehog.json
```

### Redaction approach rationale & differences to pi-share-hf

The original pi-share-hf relies on layers 3 and 4 — static secret extraction from declared env vars and TruffleHog pattern matching. Both catch what was anticipated in advance.

cc-share-hf adds layers 1 and 2 on top, which are adaptive: PII discovery reads what is actually in the session content (including tool inputs) and extracts sensitive values the user never declared. Attribution redaction handles structural identifiers that are universal to every Claude Code session but invisible to pattern-based scanners.

On a real-world session, these two additional layers produced **2,537 additional redactions** in a session that had already passed exact-secret and TruffleHog checks — including 2,499 occurrences of the raw filesystem path, 28 Vercel Blob host tokens, 4 git push URLs, and 4 commit SHA ranges.

## What the LLM review does

The LLM sees project context files plus a plain-text transcript of the redacted session.

It answers:

- is this about the target OSS project?
- is it fit to publish publicly?
- does it still appear to contain sensitive data?

Review output includes:

- `about_project`: `yes | no | mixed`
- `shareable`: `yes | no | manual_review`
- `missed_sensitive_data`: `yes | no | maybe`
- `flagged_parts`
- `summary`

Review files are stored in:

```text
.claude/hf-sessions/review/<session>.review.json
```

## What `upload` does

`upload` pushes only sessions that passed deterministic checks, TruffleHog, and LLM review (or were manually approved).

It skips sessions that are manually rejected, missing review data, failed review, or already unchanged on the remote dataset.

Use `upload --dry-run` first if you want counts without pushing anything.

## Review before upload

Before uploading, inspect what is currently uploadable:

```bash
cc-share-hf list --uploadable
```

Useful checks:

- search the uploadable set with `cc-share-hf grep`
- review `deny.txt` and rerun `collect` if you discover a new never-publish topic
- inspect `.claude/hf-sessions/reports/*.trufflehog.json` to debug or audit why a session was blocked by TruffleHog
- reject anything suspicious manually with `cc-share-hf reject`
- manually approve a session with `cc-share-hf approve` after inspecting it yourself

Typical grep checks:

```bash
cc-share-hf grep -i 'private-project|counterparty|finance|agreement|royalt'
cc-share-hf grep -i 'gmail|calendar|drive|slack'
```

## Commands

### `init`

Creates `.claude/hf-sessions/`, writes `workspace.json`, and records which project directory maps to which Hugging Face dataset repo. Also creates starter `redact.csv` and `redact-patterns.csv` files.

```bash
cc-share-hf init --repo user/dataset
cc-share-hf init --repo dataset-name --organization myorg
```

Main options:

- `--cwd <dir>` project directory to map to Claude Code session storage
- `--repo <id>` HF dataset repo
- `--organization <name>` optional namespace when `--repo` is a bare name
- `--workspace <dir>` workspace dir, default `.claude/hf-sessions`
- `--no-images` strip embedded images from redacted output
- `--visibility <mode>` `private` (default) or `oss` — controls Tier 2 attribution rules

### `collect`

Collects sessions for the configured project, runs PII discovery, applies attribution redaction, redacts literal secrets, runs TruffleHog on changed redacted files, and runs the LLM review to write or update review sidecars.

```bash
cc-share-hf collect [context-files...]
```

Main options:

- `--workspace <dir>` workspace, default `.claude/hf-sessions`
- `--env-file <path>` secret source file, default `~/.zshrc`
- `--secret <file>|<text>` repeatable
- `--force` reprocess all sessions
- `--model <id>` review model override
- `--thinking <level>` review thinking override
- `--parallel <n>` concurrent LLM reviews
- `--deny <file>|<regex>` reject sessions matching this pattern
- `--session <file>` process one session only
- `--no-pii-scan` skip the Haiku PII discovery pre-pass
- `--keep-project-name` exclude the OSS project name from PII redaction

### `review`

Reruns only the LLM review step on already-redacted sessions in the workspace.

```bash
cc-share-hf review [context-files...]
```

Uses the same review-related flags as `collect`.

### `reject`

Marks a session as never uploadable by adding it to `reject.txt`.

```bash
cc-share-hf reject <session.jsonl>
```

### `approve`

Manually marks a session as uploadable, overriding LLM review. Use this after inspecting a session yourself.

```bash
cc-share-hf approve <session.jsonl>
```

### `list`

Lists sessions from the workspace.

```bash
cc-share-hf list --uploadable
```

### `grep`

Searches only the currently uploadable sessions.

```bash
cc-share-hf grep -i 'finance|counterparty|private-project'
```

### `upload`

Uploads the current uploadable sessions and updates the remote dataset manifest.

```bash
cc-share-hf upload --dry-run
cc-share-hf upload
```

## Workspace layout

```text
.claude/hf-sessions/
  workspace.json
  manifest.local.jsonl
  remote-manifest.jsonl
  manifest.jsonl
  redact.csv            LLM-discovered + user-defined PII pairs
  redact-patterns.csv   regex redaction patterns
  redacted/       public candidate files
  reports/        private deterministic + TruffleHog reports
  review/         private LLM review sidecars
  review-chunks/  private transcript chunks
  pii/            per-session PII discovery cache
  images/         extracted images (if not stripped)
  reject.txt
  approve.txt
```

## Development

```bash
npm run check
```
