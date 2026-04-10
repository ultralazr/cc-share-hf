import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { JsonObject, JsonValue } from "./types.ts";
import { REVIEW_CHUNK_CHAR_LIMIT, REVIEW_JSON_VALUE_MAX_CHARS, REVIEW_TOOL_RESULT_MAX_CHARS } from "./types.ts";
import { isRecord } from "./workspace.ts";

export async function splitIntoReviewChunks(sessionFile: string, chunkDir: string): Promise<string[]> {
  fs.rmSync(chunkDir, { recursive: true, force: true });
  fs.mkdirSync(chunkDir, { recursive: true });

  const chunkFiles: string[] = [];
  let chunkIndex = 1;
  let current = "";

  // Maps tool_use_id -> tool_name across entries so tool_result blocks can show the tool name.
  const toolNameMap = new Map<string, string>();

  const input = fs.createReadStream(sessionFile, { encoding: "utf-8" });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of reader) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    const blocks = serializeEntryForReview(parsed as JsonObject, toolNameMap);
    for (const block of blocks) {
      if (!block) continue;
      const next = `${block}\n\n`;
      if (current.length > 0 && current.length + next.length > REVIEW_CHUNK_CHAR_LIMIT) {
        const file = path.join(chunkDir, `${String(chunkIndex).padStart(3, "0")}.txt`);
        fs.writeFileSync(file, current);
        chunkFiles.push(file);
        chunkIndex++;
        current = "";
      }
      current += next;
    }
  }

  if (current.length > 0 || chunkFiles.length === 0) {
    const file = path.join(chunkDir, `${String(chunkIndex).padStart(3, "0")}.txt`);
    fs.writeFileSync(file, current);
    chunkFiles.push(file);
  }

  return chunkFiles;
}

export function extractImagesFromSession(sessionPath: string, imagesDir: string, sessionFile: string): string[] {
  fs.mkdirSync(imagesDir, { recursive: true });
  const extracted: string[] = [];
  const content = fs.readFileSync(sessionPath, "utf-8");
  const lines = content.split("\n");

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum].trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const sessionBase = sessionFile.replace(".jsonl", "");
    let imgIndex = 0;

    function walk(val: unknown): void {
      if (val === null || val === undefined) return;
      if (Array.isArray(val)) {
        for (const item of val) walk(item);
        return;
      }
      if (typeof val === "object") {
        const rec = val as Record<string, unknown>;
        if (
          rec.type === "image" &&
          typeof rec.data === "string" &&
          typeof rec.mimeType === "string" &&
          (rec.data as string).length > 256
        ) {
          const mime = rec.mimeType as string;
          const ext = ({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" } as Record<string, string>)[mime] ?? ".bin";
          try {
            const raw = Buffer.from(rec.data as string, "base64");
            const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
            const fname = `${sessionBase}_L${lineNum + 1}_${imgIndex}_${hash}${ext}`;
            const outPath = path.join(imagesDir, fname);
            fs.writeFileSync(outPath, raw);
            extracted.push(outPath);
            imgIndex++;
          } catch {
            // Skip malformed base64
          }
        } else {
          for (const v of Object.values(rec)) walk(v);
        }
      }
    }

    walk(obj);
  }

  return extracted;
}

/**
 * Serialize a single Claude Code JSONL entry into human-readable review blocks.
 * toolNameMap is maintained across calls so tool_result blocks can show the tool name.
 */
export function serializeEntryForReview(entry: JsonObject, toolNameMap?: Map<string, string>): string[] {
  const parts: string[] = [];

  // Infrastructure / metadata entries — skip or emit minimal label.
  if (
    entry.type === "permission-mode"
    || entry.type === "file-history-snapshot"
    || entry.type === "attachment"
    || entry.type === "last-prompt"
    || entry.type === "agent-name"
  ) {
    return parts;
  }

  // System events (hook summaries, local commands, etc.) — skip.
  if (entry.type === "system") {
    return parts;
  }

  // Session title set by the user.
  if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
    parts.push(`[Session title]: ${entry.customTitle}`);
    return parts;
  }

  // User turn.
  if (entry.type === "user" && isRecord(entry.message)) {
    const message = entry.message as JsonObject;
    const content = message.content as JsonValue | undefined;
    serializeUserContent(content, toolNameMap, parts);
    return parts;
  }

  // Assistant turn.
  if (entry.type === "assistant" && isRecord(entry.message)) {
    const message = entry.message as JsonObject;
    const content = Array.isArray(message.content) ? message.content : [];
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: string[] = [];

    for (const block of content) {
      if (!isRecord(block) || typeof block.type !== "string") continue;

      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        // Skip empty thinking blocks (redacted / signature-only).
        if (block.thinking.trim().length > 0) {
          thinkingParts.push(block.thinking);
        }
      } else if (block.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "tool";
        const id = typeof block.id === "string" ? block.id : undefined;
        // Register tool name so we can look it up when the result comes back.
        if (id && toolNameMap) toolNameMap.set(id, name);
        const input = isRecord(block.input) ? block.input : {};
        const argsText = Object.entries(input)
          .map(([key, value]) => `${key}=${truncateForReview(stringifyJson(value as JsonValue), REVIEW_JSON_VALUE_MAX_CHARS)}`)
          .join(", ");
        toolCalls.push(`${name}(${argsText})`);
      }
    }

    if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
    if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
    if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
    return parts;
  }

  return parts;
}

/**
 * Serialize the content field of a user message.
 * Content can be a plain string or an array of content blocks.
 * Tool result blocks are identified by tool_use_id and looked up in toolNameMap.
 */
function serializeUserContent(
  content: JsonValue | undefined,
  toolNameMap: Map<string, string> | undefined,
  parts: string[],
): void {
  // Plain string message.
  if (typeof content === "string") {
    if (content.trim().length > 0) parts.push(`[User]: ${content}`);
    return;
  }

  if (!Array.isArray(content)) return;

  const userTextParts: string[] = [];

  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;

    if (block.type === "text" && typeof block.text === "string") {
      userTextParts.push(block.text);
    } else if (block.type === "image") {
      // Inline image in user message.
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image";
      userTextParts.push(`[Image: ${mimeType}]`);
    } else if (block.type === "tool_result") {
      // Tool result block — look up the tool name by tool_use_id.
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      const toolName = (id && toolNameMap?.get(id)) ?? (id ? id.slice(0, 12) : "tool");
      const resultContent = serializeToolResultContent(block.content as JsonValue | undefined);
      if (resultContent) {
        parts.push(`[Tool result:${toolName}]: ${truncateForReview(resultContent, REVIEW_TOOL_RESULT_MAX_CHARS)}`);
      }
    }
  }

  if (userTextParts.length > 0) {
    parts.push(`[User]: ${userTextParts.join("\n")}`);
  }
}

function serializeToolResultContent(content: JsonValue | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image";
      parts.push(`[Image preserved: ${mimeType}]`);
    }
  }
  return parts.join("\n");
}

function stringifyJson(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function truncateForReview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}
