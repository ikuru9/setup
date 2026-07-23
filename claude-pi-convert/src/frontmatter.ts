import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  parse as parseJsonc,
  type ParseError,
  printParseErrorCode,
  visit,
} from "jsonc-parser";
import YAML from "yaml";

export interface ParsedFrontmatter {
  attributes: Record<string, unknown>;
  body: string;
  raw: string | undefined;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseFrontmatter(content: string, source = "document"): ParsedFrontmatter {
  const normalized = content.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return { attributes: {}, body: normalized, raw: undefined };
  }

  const close = normalized.indexOf("\n---\n", 4);
  const eofClose = normalized.endsWith("\n---") ? normalized.length - 4 : -1;
  const closingIndex = close >= 0 ? close : eofClose;
  if (closingIndex < 0) throw new Error(`Unclosed YAML frontmatter in ${source}`);

  const raw = normalized.slice(4, closingIndex);
  const bodyStart = closingIndex + (close >= 0 ? 5 : 4);
  const parsed = parseYaml(raw, `${source} frontmatter`);
  if (parsed === null || parsed === undefined) {
    return { attributes: {}, body: normalized.slice(bodyStart), raw };
  }
  if (!isRecord(parsed)) throw new Error(`Frontmatter must be a mapping in ${source}`);
  return {
    attributes: sanitizeValue(parsed, `${source} frontmatter`) as Record<string, unknown>,
    body: normalized.slice(bodyStart),
    raw,
  };
}

export function stringifyFrontmatter(
  attributes: Record<string, unknown>,
  body: string,
): string {
  const clean = sanitizeValue(attributes, "generated frontmatter") as Record<string, unknown>;
  const yaml = YAML.stringify(clean, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, "")}`;
}

export function parseStructuredText(text: string, extension: string, source = "configuration"): unknown {
  const ext = extension.toLocaleLowerCase("en-US");
  if (ext === ".yaml" || ext === ".yml") return parseYaml(text, source);
  if (ext === ".json" || ext === ".jsonc" || ext === "") return parseJsonWithComments(text, source);
  throw new Error(`Unsupported structured file type ${extension} in ${source}`);
}

export function stringifyStructuredText(value: unknown, extension: string): string {
  const clean = sanitizeValue(value, "generated structured content");
  const ext = extension.toLocaleLowerCase("en-US");
  if (ext === ".yaml" || ext === ".yml") return YAML.stringify(clean, { lineWidth: 0 });
  return `${JSON.stringify(clean, null, 2)}\n`;
}

export async function readStructuredFile(filePath: string): Promise<unknown> {
  return parseStructuredText(await readFile(filePath, "utf8"), path.extname(filePath), filePath);
}

export function asRecord(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${source} must contain an object`);
  return value;
}

function parseJsonWithComments(text: string, source: string): unknown {
  // jsonc-parser builds regular JavaScript objects. Assigning an own
  // `__proto__` property while parsing can mutate that object's prototype and
  // make a later Object.entries() sanitization miss the key entirely, so scan
  // syntax-level property tokens before constructing the value.
  let forbiddenProperty: { key: string; offset: number } | undefined;
  visit(
    text,
    {
      onObjectProperty(property, offset) {
        if (!forbiddenProperty && FORBIDDEN_KEYS.has(property)) {
          forbiddenProperty = { key: property, offset };
        }
      },
    },
    { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false },
  );
  if (forbiddenProperty) {
    throw new Error(
      `Forbidden key ${forbiddenProperty.key} in ${source} at offset ${forbiddenProperty.offset}`,
    );
  }
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  if (errors.length > 0) {
    const first = errors[0];
    if (!first) throw new Error(`Invalid JSONC in ${source}`);
    throw new Error(
      `Invalid JSONC in ${source} at offset ${first.offset}: ${printParseErrorCode(first.error)}`,
    );
  }
  return sanitizeValue(value, source);
}

function parseYaml(text: string, source: string): unknown {
  const document = YAML.parseDocument(text, {
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`Invalid YAML in ${source}: ${document.errors[0]?.message ?? "unknown error"}`);
  }
  let forbiddenKey: string | undefined;
  YAML.visit(document, {
    Pair(_key, pair) {
      if (YAML.isScalar(pair.key)) {
        const key = String(pair.key.value);
        if (!forbiddenKey && FORBIDDEN_KEYS.has(key)) forbiddenKey = key;
      }
    },
  });
  if (forbiddenKey) throw new Error(`Forbidden key ${forbiddenKey} in ${source}`);
  return sanitizeValue(document.toJS({ maxAliasCount: 0 }), source);
}

function sanitizeValue(value: unknown, source: string, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error(`Cyclic value in ${source}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, source, seen));
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new Error(`Forbidden key ${key} in ${source}`);
      output[key] = sanitizeValue(child, source, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
