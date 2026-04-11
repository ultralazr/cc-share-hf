import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./process.ts";
import type { PiiPair, RegexPattern } from "./types.ts";
import { workspacePath } from "./workspace.ts";

// Always use Haiku for PII extraction — it's a simple classification task.
const PII_MODEL = "claude-haiku-4-5-20251001";
// Only scan the first N chars of natural language to keep costs predictable.
const MAX_NL_CHARS = 60_000;

interface PiiCacheEntry {
  source_hash: string;
  discovered: Array<{ find: string; type: string }>;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  result.push(current);
  return result;
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public: load workspace CSV files
// ---------------------------------------------------------------------------

export function loadRedactCsv(workspace: string): PiiPair[] {
  const file = workspacePath(workspace, "redact.csv");
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  const pairs: PiiPair[] = [];
  let sawHeader = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!sawHeader) { sawHeader = true; continue; } // skip header row
    const parts = parseCsvLine(line);
    if (parts.length >= 2 && parts[0]) {
      pairs.push({
        find: parts[0],
        replace: parts[1] || "[REDACTED]",
        case_sensitive: parts[2]?.trim() !== "false",
      });
    }
  }
  // Longest first — prevents shorter substrings from shadowing longer ones.
  return pairs.sort((a, b) => b.find.length - a.find.length);
}

export function loadRedactPatternsCsv(workspace: string): RegexPattern[] {
  const file = workspacePath(workspace, "redact-patterns.csv");
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  const patterns: RegexPattern[] = [];
  let sawHeader = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!sawHeader) { sawHeader = true; continue; }
    const parts = parseCsvLine(line);
    if (parts.length >= 2 && parts[0]) {
      patterns.push({
        pattern: parts[0],
        replace: parts[1] || "[REDACTED]",
        flags: parts[2]?.trim() || "g",
      });
    }
  }
  return patterns;
}

// Hash of both CSV files — used as part of the redaction cache key so that
// editing redact.csv causes affected sessions to be re-processed.
export function computePiiConfigHash(workspace: string): string {
  const a = workspacePath(workspace, "redact.csv");
  const b = workspacePath(workspace, "redact-patterns.csv");
  const content = (fs.existsSync(a) ? fs.readFileSync(a, "utf-8") : "")
    + "\n"
    + (fs.existsSync(b) ? fs.readFileSync(b, "utf-8") : "");
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Natural language extraction from a Claude Code session JSONL
// ---------------------------------------------------------------------------

export function extractNaturalLanguage(sessionPath: string): string {
  const lines = fs.readFileSync(sessionPath, "utf-8").split("\n");
  const parts: string[] = [];
  let total = 0;

  for (const raw of lines) {
    if (total >= MAX_NL_CHARS) break;
    const line = raw.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    const text = extractText(entry);
    if (text) {
      parts.push(text);
      total += text.length;
    }
  }
  return parts.join("\n\n");
}

function extractText(entry: Record<string, unknown>): string | undefined {
  const type = entry.type;

  if (type === "custom-title" && typeof entry.value === "string") {
    return `[Title] ${entry.value}`;
  }

  if (type === "user") {
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) return undefined;
    const content = msg.content;
    if (typeof content === "string") return `[User] ${content}`;
    if (Array.isArray(content)) {
      const texts = (content as Record<string, unknown>[])
        .filter(b => b.type === "text" && typeof b.text === "string")
        .map(b => b.text as string);
      return texts.length ? `[User] ${texts.join(" ")}` : undefined;
    }
  }

  if (type === "assistant") {
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) return undefined;
    const content = msg.content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        } else if (block.type === "tool_use" && block.input && typeof block.input === "object") {
          // Extract string values from tool inputs so credentials written via
          // Write/Bash tool calls are visible to the PII scanner.
          const inputStrings = extractStringValues(block.input as Record<string, unknown>);
          if (inputStrings) parts.push(`[ToolInput] ${inputStrings}`);
        }
      }
      return parts.length ? `[Assistant] ${parts.join(" ")}` : undefined;
    }
  }

  return undefined;
}

function extractStringValues(obj: Record<string, unknown>, depth = 0): string {
  if (depth > 2) return "";
  return Object.values(obj)
    .flatMap(v => {
      if (typeof v === "string") return [v];
      if (v && typeof v === "object" && !Array.isArray(v))
        return [extractStringValues(v as Record<string, unknown>, depth + 1)];
      return [];
    })
    .filter(Boolean)
    .join(" ");
}

// ---------------------------------------------------------------------------
// PII discovery via Claude Haiku
// ---------------------------------------------------------------------------

async function callPiiDiscovery(naturalLanguage: string): Promise<Array<{ find: string; type: string }>> {
  const systemPrompt =
    "You are a PII extractor for a redaction pipeline. Output only valid JSON — no prose, no markdown fences.";

  const prompt = `Extract all sensitive values that should be redacted from the conversation below.

Output ONLY a JSON array. Each element: {"find": "<exact string as it appears in the text>", "type": "person|company|project|email|url|credential|other"}.

Rules:
- Include: real person names (first/last/full), company or client names, internal project codenames, email addresses, phone numbers, physical addresses
- Include: passwords, API keys, tokens, secrets, and hardcoded credentials — even if they appear inside source code, config files, or test scripts (e.g. TEST_PASSWORD = "...", apiKey: "...", Bearer ...)
- Include: private or internal URLs — e.g. corporate dashboards, internal APIs, private hosted services, cloud console links that expose org/account info
- For companies and persons: output EVERY distinct string that identifies the same entity as a separate entry. Example: if "AGCO" is a company and "agcocorp" and "agco.com" also appear in the text, output all three as separate entries with type "company". Catch domain variants, abbreviations, and derived identifiers.
- Exclude: public GitHub usernames or OSS project names that are clearly public, programming library names, technical terms, placeholder text already in [BRACKET] form
- Exclude: well-known public URLs (github.com, npmjs.com, stackoverflow.com, docs.anthropic.com, huggingface.co, pypi.org, etc.)
- Each unique string exactly once, with exact capitalisation/spelling as it appears in the text
- If nothing found, output []

Conversation:
${naturalLanguage}`;

  const args = [
    "--no-session-persistence",
    "--tools", "",
    "--model", PII_MODEL,
    "--system-prompt", systemPrompt,
    "-p",
  ];

  const result = await runCommand("claude", args, undefined, prompt);
  if (!result.ok) return [];

  try {
    const match = result.stdout.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is { find: string; type: string } =>
        typeof (item as Record<string, unknown>)?.find === "string"
        && (item as Record<string, unknown>).find !== ""
        && typeof (item as Record<string, unknown>)?.type === "string",
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function loadPiiCache(cacheFile: string, sourceHash: string): PiiCacheEntry | undefined {
  if (!fs.existsSync(cacheFile)) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as PiiCacheEntry;
    if (data.source_hash === sourceHash) return data;
  } catch {}
  return undefined;
}

function savePiiCache(cacheFile: string, entry: PiiCacheEntry): void {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, `${JSON.stringify(entry, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Placeholder generation
// ---------------------------------------------------------------------------

function nextPlaceholder(type: string, existing: PiiPair[]): string {
  const prefix = type === "person" ? "PERSON"
    : type === "company" ? "COMPANY"
    : type === "project" ? "PROJECT"
    : type === "email" ? "EMAIL"
    : type === "url" ? "URL"
    : type === "credential" ? "CREDENTIAL"
    : "REDACTED";
  const count = existing.filter(p => p.replace.startsWith(`[${prefix}_`)).length;
  return `[${prefix}_${count + 1}]`;
}

// ---------------------------------------------------------------------------
// Public: main entry point
// ---------------------------------------------------------------------------

/**
 * Discover PII in a session, merge into workspace redact.csv, and return
 * all pairs + patterns to apply during redaction.
 *
 * The result is cached by source_hash — unchanged sessions skip the LLM call.
 */
export async function discoverAndMergePii(
  sessionPath: string,
  sourceHash: string,
  workspace: string,
  excludeTerms: string[] = [],
): Promise<{ pairs: PiiPair[]; patterns: RegexPattern[]; newFindings: number }> {
  const cacheFile = workspacePath(workspace, "pii", `${path.basename(sessionPath)}.pii.json`);
  const cached = loadPiiCache(cacheFile, sourceHash);

  let discovered: Array<{ find: string; type: string }>;
  if (cached) {
    discovered = cached.discovered;
  } else {
    const nl = extractNaturalLanguage(sessionPath);
    discovered = nl.trim() ? await callPiiDiscovery(nl) : [];
    savePiiCache(cacheFile, { source_hash: sourceHash, discovered });
  }

  // Merge newly discovered items into workspace redact.csv.
  const existingPairs = loadRedactCsv(workspace);
  const updatedPairs = [...existingPairs];
  let newFindings = 0;

  const excludeSet = new Set(excludeTerms.map(t => t.toLowerCase()));

  for (const item of discovered) {
    if (excludeSet.has(item.find.toLowerCase())) continue;
    const alreadyKnown = existingPairs.some(
      p => p.find.toLowerCase() === item.find.toLowerCase(),
    );
    if (!alreadyKnown && item.find.trim()) {
      const placeholder = nextPlaceholder(item.type, updatedPairs);
      // Names (person/company/project) are case-insensitive — they appear in
      // many forms (AGCO, agco, Agco). Credentials, emails, and URLs are exact.
      const caseSensitive = item.type === "email"
        || item.type === "credential"
        || item.type === "url";
      updatedPairs.push({ find: item.find, replace: placeholder, case_sensitive: caseSensitive });
      newFindings++;
    }
  }

  if (newFindings > 0) {
    saveRedactCsvFull(workspace, updatedPairs);
  }

  const patterns = loadRedactPatternsCsv(workspace);
  return { pairs: updatedPairs.sort((a, b) => b.find.length - a.find.length), patterns, newFindings };
}

function saveRedactCsvFull(workspace: string, pairs: PiiPair[]): void {
  const file = workspacePath(workspace, "redact.csv");
  const header = "find,replace,case_sensitive\n";
  const rows = pairs.map(p => `${escapeCsv(p.find)},${escapeCsv(p.replace)},${p.case_sensitive}`).join("\n");
  fs.writeFileSync(file, rows.length > 0 ? `${header}${rows}\n` : header);
}
