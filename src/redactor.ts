import type { DetectorName, Finding, JsonObject, JsonValue, PiiPair, RedactionResult, RegexPattern, Severity } from "./types.ts";
import { buildLiteralSecrets, countOccurrences } from "./secrets.ts";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface PairGroup {
  pairs: PiiPair[];
  detector: DetectorName;
  severity: Severity;
}

interface PatternGroup {
  patterns: Array<{ regex: RegExp; replace: string }>;
  detector: DetectorName;
  severity: Severity;
}

export class Redactor {
  private readonly literalSecrets: Array<{ name: string; value: string; replacement: string }>;
  private readonly noImages: boolean;
  private readonly pairGroups: PairGroup[];
  private readonly patternGroups: PatternGroup[];

  constructor(
    envFile: string,
    secrets: string[],
    noImages: boolean,
    piiPairs: PiiPair[] = [],
    regexPatterns: RegexPattern[] = [],
    attributionPairs: PiiPair[] = [],
    attributionPatterns: RegexPattern[] = [],
  ) {
    this.literalSecrets = buildLiteralSecrets(envFile, secrets);
    this.noImages = noImages;
    // Attribution runs BEFORE PII so the deterministic placeholders win when
    // both would match the same span (e.g. cwd path containing the project
    // name).
    this.pairGroups = [
      { pairs: sortLongest(attributionPairs), detector: "attribution-find-replace", severity: "high" },
      { pairs: sortLongest(piiPairs), detector: "pii-find-replace", severity: "high" },
    ];
    this.patternGroups = [
      { patterns: compilePatterns(attributionPatterns), detector: "attribution-regex", severity: "medium" },
      { patterns: compilePatterns(regexPatterns), detector: "pii-regex", severity: "medium" },
    ];
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

    for (const group of this.pairGroups) {
      for (const pair of group.pairs) {
        const flags = pair.case_sensitive ? "g" : "gi";
        const regex = new RegExp(escapeRegex(pair.find), flags);
        let count = 0;
        const newResult = result.replace(regex, () => { count++; return pair.replace; });
        if (count > 0) {
          findings.push({
            detector: group.detector,
            severity: group.severity,
            jsonPath,
            replacement: pair.replace,
            count,
            detail: pair.find,
          });
          result = newResult;
        }
      }
    }

    for (const group of this.patternGroups) {
      for (const { regex, replace } of group.patterns) {
        regex.lastIndex = 0;
        let count = 0;
        const newResult = result.replace(regex, () => { count++; return replace; });
        if (count > 0) {
          findings.push({
            detector: group.detector,
            severity: group.severity,
            jsonPath,
            replacement: replace,
            count,
          });
          result = newResult;
        }
      }
    }

    return { value: result, findings };
  }
}

function sortLongest(pairs: PiiPair[]): PiiPair[] {
  return [...pairs].sort((a, b) => b.find.length - a.find.length);
}

function compilePatterns(patterns: RegexPattern[]): Array<{ regex: RegExp; replace: string }> {
  return patterns.map(({ pattern, replace, flags }) => ({
    regex: new RegExp(pattern, flags),
    replace,
  }));
}

function formatObjectKey(key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `.${key}`;
  return `[${JSON.stringify(key)}]`;
}
