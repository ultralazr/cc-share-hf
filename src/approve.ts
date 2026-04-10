import fs from "node:fs";
import path from "node:path";
import type { ApproveOptions } from "./types.ts";
import { APPROVE_FILE } from "./types.ts";
import { workspacePath } from "./workspace.ts";

export async function runApprove(options: ApproveOptions): Promise<void> {
  const sessionFile = normalizeTarget(options.target);
  const approvePath = workspacePath(options.workspace, APPROVE_FILE);
  const existing = fs.existsSync(approvePath)
    ? new Set(fs.readFileSync(approvePath, "utf-8").split("\n").map((line) => line.trim()).filter(Boolean))
    : new Set<string>();

  existing.add(sessionFile);
  const content = [...existing].sort().join("\n");
  fs.writeFileSync(approvePath, content.length > 0 ? `${content}\n` : "");

  console.log(`Approved session: ${sessionFile}`);
  console.log(`Updated: ${approvePath}`);
  console.log(`Note: manual approval overrides LLM review — ensure you have inspected the session.`);
}

function normalizeTarget(target: string): string {
  const base = path.basename(target);
  if (base.endsWith(".jsonl")) return base;
  if (base.endsWith(".review.json")) return base.slice(0, -".review.json".length);
  const marker = base.indexOf("_L");
  if (marker !== -1) return `${base.slice(0, marker)}.jsonl`;
  throw new Error(`Cannot derive session filename from target: ${target}`);
}
