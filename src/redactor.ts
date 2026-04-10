import type { Finding, JsonObject, JsonValue, RedactionResult } from "./types.ts";
import { buildLiteralSecrets, countOccurrences } from "./secrets.ts";

export class Redactor {
  private readonly literalSecrets: Array<{ name: string; value: string; replacement: string }>;
  private readonly noImages: boolean;

  constructor(envFile: string, secrets: string[], noImages: boolean) {
    this.literalSecrets = buildLiteralSecrets(envFile, secrets);
    this.noImages = noImages;
  }

  async redactEvent(event: JsonObject): Promise<RedactionResult> {
    return this.redactObject(event, "$", undefined, undefined);
  }

  private async redactValue(
    value: JsonValue,
    jsonPath: string,
    parentKey?: string,
    parentObject?: JsonObject,
  ): Promise<{ value: JsonValue; findings: Finding[] }> {
    if (value === null) return { value, findings: [] };

    if (typeof value === "string") {
      // Detect base64 image payloads.
      // pi format:          { data: "...", mimeType: "image/png" }
      // Claude Code format: { data: "...", media_type: "image/png", type: "base64" }
      const imageMime = typeof parentObject?.mimeType === "string"
        ? parentObject.mimeType
        : typeof parentObject?.media_type === "string"
          ? parentObject.media_type
          : undefined;
      if (parentKey === "data" && imageMime && value.length > 256) {
        if (this.noImages) {
          return {
            value: "[IMAGE_REMOVED]",
            findings: [{
              detector: "image",
              severity: "medium",
              jsonPath,
              replacement: "[IMAGE_REMOVED]",
              count: 1,
              detail: imageMime,
            }],
          };
        }
        return {
          value,
          findings: [{
            detector: "image",
            severity: "medium",
            jsonPath,
            replacement: "[PRESERVED_IMAGE]",
            count: 1,
            detail: imageMime,
            manual_review: true,
          }],
        };
      }
      return this.redactString(value, jsonPath);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return { value, findings: [] };
    }

    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      const findings: Finding[] = [];
      for (let i = 0; i < value.length; i++) {
        const result = await this.redactValue(value[i], `${jsonPath}[${i}]`);
        out.push(result.value);
        findings.push(...result.findings);
      }
      return { value: out, findings };
    }

    const result = await this.redactObject(value, jsonPath, parentKey, parentObject);
    return { value: result.redacted, findings: result.findings };
  }

  private async redactObject(
    value: JsonObject,
    jsonPath: string,
    _parentKey?: string,
    _parentObject?: JsonObject,
  ): Promise<{ redacted: JsonObject; findings: Finding[] }> {
    const out: JsonObject = {};
    const findings: Finding[] = [];

    for (const [key, child] of Object.entries(value)) {
      const childPath = `${jsonPath}${formatObjectKey(key)}`;
      const result = await this.redactValue(child, childPath, key, value);
      out[key] = result.value;
      findings.push(...result.findings);
    }

    return { redacted: out, findings };
  }

  private async redactString(text: string, jsonPath: string): Promise<{ value: JsonValue; findings: Finding[] }> {
    let result = text;
    const findings: Finding[] = [];

    for (const secret of this.literalSecrets) {
      const count = countOccurrences(result, secret.value);
      if (count > 0) {
        result = result.replaceAll(secret.value, secret.replacement);
        findings.push({
          detector: "literal-secret",
          severity: "critical",
          jsonPath,
          replacement: secret.replacement,
          count,
          detail: secret.name,
        });
      }
    }

    return { value: result, findings };
  }
}

function formatObjectKey(key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `.${key}`;
  return `[${JSON.stringify(key)}]`;
}
