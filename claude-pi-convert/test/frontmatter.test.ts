import { describe, expect, it } from "vitest";
import {
  asRecord,
  parseFrontmatter,
  parseStructuredText,
  stringifyFrontmatter,
} from "../src/frontmatter.js";

describe("frontmatter", () => {
  it("parses and serializes YAML without losing the body", () => {
    const parsed = parseFrontmatter(
      "---\ndescription: Test\ntools: [Read, Grep]\nenabled: true\n---\n\nBody\n",
      "fixture.md",
    );
    expect(parsed.attributes).toMatchObject({
      description: "Test",
      tools: ["Read", "Grep"],
      enabled: true,
    });
    expect(parsed.body).toBe("\nBody\n");
    expect(parseFrontmatter(stringifyFrontmatter(parsed.attributes, parsed.body)).body).toContain(
      "Body",
    );
  });

  it("parses JSONC with comments and trailing commas", () => {
    const value = asRecord(
      parseStructuredText('{ // comment\n "name": "fixture",\n}', ".jsonc", "fixture"),
      "fixture",
    );
    expect(value.name).toBe("fixture");
  });

  it("rejects prototype pollution keys", () => {
    expect(() => parseStructuredText('{"__proto__":{"polluted":true}}', ".json", "bad"))
      .toThrow(/Forbidden key/);
  });
});
