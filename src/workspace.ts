import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JsonObject, LocalManifestEntry, RemoteManifestEntry, WorkspaceConfig } from "./types.ts";
import { LOCAL_MANIFEST_FILE, REMOTE_MANIFEST_CACHE_FILE, REMOTE_MANIFEST_FILE, WORKSPACE_CONFIG_FILE } from "./types.ts";
import { downloadDatasetTextFile } from "./hf.ts";

export { LOCAL_MANIFEST_FILE, REMOTE_MANIFEST_CACHE_FILE, REMOTE_MANIFEST_FILE, WORKSPACE_CONFIG_FILE };

export function cwdToSessionDirName(cwd: string): string {
  // Claude Code names project dirs by replacing path separators, colons, and spaces with dashes.
  // e.g., C:\DATA\projects\foo -> C--DATA-projects-foo
  //       C:\DATA\Coding Projects\CPQ Webtester -> C--DATA-Coding-Projects-CPQ-Webtester
  //       /home/user/foo -> -home-user-foo
  return cwd.replace(/[:\\/\s]/g, "-");
}

export function workspacePath(workspace: string, ...segments: string[]): string {
  return path.join(workspace, ...segments);
}

export function ensureWorkspaceDirs(workspace: string): void {
  fs.mkdirSync(workspacePath(workspace, "redacted"), { recursive: true });
  fs.mkdirSync(workspacePath(workspace, "reports"), { recursive: true });
  fs.mkdirSync(workspacePath(workspace, "review"), { recursive: true });
  fs.mkdirSync(workspacePath(workspace, "review-chunks"), { recursive: true });
  fs.mkdirSync(workspacePath(workspace, "images"), { recursive: true });
  fs.mkdirSync(workspacePath(workspace, "pii"), { recursive: true });
}

export function createExamplePiiCsvFiles(workspace: string): void {
  const redactCsv = workspacePath(workspace, "redact.csv");
  if (!fs.existsSync(redactCsv)) {
    fs.writeFileSync(redactCsv, [
      "find,replace,case_sensitive",
      "# Add literal find/replace pairs here. Longest match wins.",
      "# Example: John Smith,[PERSON_1],true",
      "# Example: Acme Corp,[COMPANY_1],true",
    ].join("\n") + "\n");
  }

  const patternsCsv = workspacePath(workspace, "redact-patterns.csv");
  if (!fs.existsSync(patternsCsv)) {
    fs.writeFileSync(patternsCsv, [
      "pattern,replace,flags",
      "# Deterministic regex redactions applied to every session.",
      "# Email addresses — catches any email regardless of LLM PII scan coverage.",
      '"\\b[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}\\b",[EMAIL_REDACTED],g',
    ].join("\n") + "\n");
  }
}

export function resetWorkspaceForCollect(workspace: string): void {
  fs.mkdirSync(workspace, { recursive: true });
  ensureWorkspaceDirs(workspace);
}

export function resetReviewDir(workspace: string): void {
  fs.mkdirSync(workspacePath(workspace, "review"), { recursive: true });
  fs.mkdirSync(workspacePath(workspace, "review-chunks"), { recursive: true });
}

export function writeWorkspaceConfig(workspace: string, config: WorkspaceConfig): void {
  fs.writeFileSync(workspacePath(workspace, WORKSPACE_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

export function readWorkspaceConfig(workspace: string): WorkspaceConfig {
  const file = workspacePath(workspace, WORKSPACE_CONFIG_FILE);
  if (!fs.existsSync(file)) throw new Error(`Missing workspace config: ${file}`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  if (!isWorkspaceConfig(parsed)) throw new Error(`Invalid workspace config: ${file}`);
  return parsed;
}

export function isWorkspaceConfig(value: unknown): value is WorkspaceConfig {
  if (!isRecord(value)) return false;
  if (typeof value.cwd !== "string" || typeof value.repo !== "string") return false;
  if (value.visibility !== undefined && value.visibility !== "oss" && value.visibility !== "private") return false;
  return true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function readJsonlFile<T>(filePath: string, parser: (value: unknown) => T | undefined): T[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter((line) => line.trim() !== "");
  const results: T[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      const value = parser(parsed);
      if (value) results.push(value);
    } catch {
      // Ignore malformed lines in manifests or sidecars.
    }
  }
  return results;
}

export function writeJsonlFile(filePath: string, values: unknown[]): void {
  const content = values.map((value) => JSON.stringify(value)).join("\n");
  fs.writeFileSync(filePath, content.length > 0 ? `${content}\n` : "");
}

export function loadRemoteManifest(filePath: string): Map<string, RemoteManifestEntry> {
  const entries = readJsonlFile(filePath, parseRemoteManifestEntry);
  return new Map(entries.map((entry) => [entry.file, entry]));
}

export function loadLocalManifest(filePath: string): Map<string, LocalManifestEntry> {
  const entries = readJsonlFile(filePath, parseLocalManifestEntry);
  return new Map(entries.map((entry) => [entry.file, entry]));
}

export function parseRemoteManifestEntry(value: unknown): RemoteManifestEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.file !== "string") return undefined;
  if (typeof value.source_hash !== "string") return undefined;
  if (typeof value.redacted_hash !== "string") return undefined;
  if (value.redaction_key !== undefined && typeof value.redaction_key !== "string") return undefined;
  return {
    file: value.file,
    source_hash: value.source_hash,
    redaction_key: typeof value.redaction_key === "string" ? value.redaction_key : undefined,
    redacted_hash: value.redacted_hash,
  };
}

export function parseLocalManifestEntry(value: unknown): LocalManifestEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.file !== "string") return undefined;
  if (typeof value.source_file !== "string") return undefined;
  if (typeof value.source_hash !== "string") return undefined;
  if (typeof value.redaction_key !== "string") return undefined;
  if (typeof value.redacted_hash !== "string") return undefined;
  if (typeof value.entry_count !== "number") return undefined;
  if (typeof value.findings !== "number") return undefined;
  if (typeof value.lines_with_findings !== "number") return undefined;
  return {
    file: value.file,
    source_file: value.source_file,
    source_hash: value.source_hash,
    redaction_key: value.redaction_key,
    redacted_hash: value.redacted_hash,
    entry_count: value.entry_count,
    findings: value.findings,
    lines_with_findings: value.lines_with_findings,
  };
}

export async function downloadRemoteManifest(repo: string, outputPath: string): Promise<Map<string, RemoteManifestEntry>> {
  fs.rmSync(outputPath, { force: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const manifest = await downloadDatasetTextFile(repo, REMOTE_MANIFEST_FILE);
  if (!manifest) {
    return new Map();
  }

  fs.writeFileSync(outputPath, manifest);
  return loadRemoteManifest(outputPath);
}
