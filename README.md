# cc-share-hf

Publish [Claude Code](https://claude.ai/code) coding agent sessions from one OSS project to a Hugging Face dataset.

This is a fork of [badlogic/pi-share-hf](https://github.com/badlogic/pi-share-hf) adapted to work with Claude Code session logs instead of Pi coding agent logs.

It is an incremental pipeline for:

1. collecting sessions for one project
2. redacting exact secrets from your env file and `--secret`
3. rejecting sessions that match user-provided deny patterns via `--deny`
4. scanning redacted output with [TruffleHog](https://github.com/trufflesecurity/trufflehog) to detect and verify surviving secrets
5. running LLM review on the remaining sessions
6. uploading only sessions that pass all checks

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
- **Project dir naming**: `C:\DATA\projects\foo` → `C--DATA-projects-foo` (colons and backslashes → dashes)
- **Session format**: handles Claude Code JSONL format (`user`/`assistant` roles, `tool_use`/`tool_result`/`thinking` content blocks, `media_type` for images) instead of Pi format
- **Redactor**: detects images via `media_type` field (Claude Code) in addition to `mimeType` (Pi)
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
3. run `cc-share-hf collect` to gather changed and new sessions, redact known secrets, filter by `--deny`, scan with TruffleHog, and run LLM review
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
# personal namespace
cc-share-hf init --repo myuser/my-project-sessions

# or org namespace
cc-share-hf init --repo my-project-sessions --organization myorg
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

## What deterministic redaction does

It only knows exact secret values.

Sources:

- `--env-file` (default: `~/.zshrc`)
- `--secret <file>` with one secret per line
- `--secret <literal>`

This is deliberate. Exact values are high precision. Generic token regexes are noisy. TruffleHog handles generic secret detection after redaction.

## What TruffleHog does here

TruffleHog scans the redacted output, not the original raw session.

That means:

- exact secrets should already be gone
- TruffleHog acts as a backstop for anything secret-like that survived

Any TruffleHog finding blocks the session automatically.

Per-session TruffleHog reports are stored in:

```text
.claude/hf-sessions/reports/<session>.trufflehog.json
```

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

Creates `.claude/hf-sessions/`, writes `workspace.json`, and records which project directory maps to which Hugging Face dataset repo.

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

### `collect`

Collects sessions for the configured project, redacts literal secrets, runs TruffleHog on changed redacted files, and runs the LLM review to write or update review sidecars.

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
  redacted/       public candidate files
  reports/        private deterministic + TruffleHog reports
  review/         private LLM review sidecars
  review-chunks/  private transcript chunks
  reject.txt
  approve.txt
```

## Development

```bash
npm run check
```
