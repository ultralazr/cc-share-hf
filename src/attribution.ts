import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./process.ts";
import type { PiiPair, RegexPattern, Visibility, WorkspaceConfig } from "./types.ts";
import { cwdToSessionDirName } from "./workspace.ts";

// Attribution redactions are deterministic, derived from workspace config.
// They run alongside the LLM-discovered PII pairs but are NOT persisted to
// redact.csv — they are rebuilt every collect run from the current config.
//
// Tier 1 (always applied) — leaks that always identify the project root,
// regardless of whether the project is OSS or private.
//
// Tier 2 (private only) — leaks that are public for OSS projects (git remote,
// GitHub user/repo, commit SHAs all show up on github.com anyway) but should
// be hidden for private projects.

export interface AttributionConfig {
  pairs: PiiPair[];
  patterns: RegexPattern[];
}

export async function buildAttribution(config: WorkspaceConfig): Promise<AttributionConfig> {
  const visibility: Visibility = config.visibility ?? "private";
  const pairs: PiiPair[] = [];
  const patterns: RegexPattern[] = [];

  // ---- Tier 1 -------------------------------------------------------------

  // Raw cwd path. Both forward- and back-slash variants appear inside JSON
  // strings (Claude Code stores `cwd` and tool inputs reference it many times).
  const cwd = config.cwd;
  const cwdBack = cwd.replace(/\//g, "\\");
  const cwdFwd = cwd.replace(/\\/g, "/");
  for (const variant of unique([cwd, cwdBack, cwdFwd])) {
    pairs.push({ find: variant, replace: "[PROJECT_ROOT]", case_sensitive: false });
  }

  // Claude Code project slug — appears in session file paths and the project
  // dir under ~/.claude/projects.
  pairs.push({
    find: cwdToSessionDirName(cwd),
    replace: "[PROJECT_SLUG]",
    case_sensitive: false,
  });

  // Vercel Blob storage hosts/keys — these embed the project's blob store id.
  patterns.push({
    pattern: "[a-z0-9]{16,}\\.public\\.blob\\.vercel-storage\\.com",
    replace: "[BLOB_HOST]",
    flags: "g",
  });

  // ---- Tier 2 (private only) ---------------------------------------------

  if (visibility === "private") {
    // Git remote URL — stored verbatim if any tool ran `git remote -v` or
    // similar. Resolve from the project's git config.
    const remote = await tryGitRemote(cwd);
    if (remote) {
      pairs.push({ find: remote, replace: "[GIT_REMOTE]", case_sensitive: false });
      const parsed = parseGitHubRemote(remote);
      if (parsed) {
        // owner/repo as standalone tokens.
        pairs.push({ find: `${parsed.owner}/${parsed.repo}`, replace: "[GH_REPO]", case_sensitive: false });
        // owner alone (after the slash) — keep this last so the longer
        // owner/repo pair takes precedence in the longest-first sort.
        pairs.push({ find: parsed.owner, replace: "[GH_USER]", case_sensitive: false });
        pairs.push({ find: parsed.repo, replace: "[REPO]", case_sensitive: false });
      }
    }

    // Commit SHA range — `abc1234..def5678` style appearing in git log/diff.
    patterns.push({
      pattern: "\\b[0-9a-f]{7,40}\\.\\.[0-9a-f]{7,40}\\b",
      replace: "[GIT_RANGE]",
      flags: "g",
    });
  }

  return { pairs, patterns };
}

export function attributionHash(attribution: AttributionConfig, visibility: Visibility): string {
  const payload = JSON.stringify({
    visibility,
    pairs: attribution.pairs.map(p => [p.find, p.replace, p.case_sensitive]),
    patterns: attribution.patterns.map(p => [p.pattern, p.replace, p.flags]),
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

async function tryGitRemote(cwd: string): Promise<string | undefined> {
  if (!fs.existsSync(path.join(cwd, ".git"))) return undefined;
  const result = await runCommand("git", ["remote", "get-url", "origin"], cwd);
  if (!result.ok) return undefined;
  const url = result.stdout.trim();
  return url || undefined;
}

function parseGitHubRemote(url: string): { owner: string; repo: string } | undefined {
  // Handles: git@github.com:owner/repo.git, https://github.com/owner/repo(.git)
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const https = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return { owner: https[1], repo: https[2] };
  return undefined;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
