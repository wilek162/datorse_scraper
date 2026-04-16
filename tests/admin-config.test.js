"use strict";

/**
 * Unit tests for admin configuration validation logic.
 * Since the config route is currently embedded in a router with FS side effects,
 * we extract and test the core logic: stripping comments and parsing JSON.
 */

function stripComments(json) {
  // Matches // comments at start of line (optionally indented)
  return json.replace(/^\s*\/\/.*$/gm, "");
}

function validateSources(parsed) {
  if (!Array.isArray(parsed)) {
    throw new Error("Configuration must be a JSON array of source objects.");
  }
  for (const item of parsed) {
    if (!item.id || typeof item.id !== "string") {
      throw new Error(`All source entries must have a string "id" field. Found: ${JSON.stringify(item)}`);
    }
  }
  return true;
}

describe("Admin Config Validation", () => {
  test("stripComments removes single-line comments", () => {
    const input = `{
      // This is a comment
      "id": "test",
      "enabled": true // In-line comments are NOT handled by this regex (by design)
    }`;
    const output = stripComments(input);
    expect(output).not.toContain("// This is a comment");
    expect(output).toContain('"id": "test"');
    // The simple regex only strips comments that start the line
    expect(output).toContain("// In-line comments"); 
  });

  test("validateSources accepts valid source arrays", () => {
    const valid = [
      { id: "amazon", type: "API" },
      { id: "prisjakt", type: "SCRAPER" }
    ];
    expect(validateSources(valid)).toBe(true);
  });

  test("validateSources rejects non-arrays", () => {
    expect(() => validateSources({ id: "single" })).toThrow(/array/);
  });

  test("validateSources rejects sources without IDs", () => {
    const invalid = [
      { id: "ok" },
      { type: "missing-id" }
    ];
    expect(() => validateSources(invalid)).toThrow(/string "id" field/);
  });

  test("full parse flow (strip + parse + validate)", () => {
    const raw = `[
      // Main retailers
      { "id": "inet", "enabled": true },
      { "id": "komplett", "enabled": false }
    ]`;
    const stripped = stripComments(raw);
    const parsed = JSON.parse(stripped);
    expect(parsed).toHaveLength(2);
    expect(validateSources(parsed)).toBe(true);
  });
});
