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

// ─── validateSourceEntry ───────────────────────────────────────────────────
// Mirrors the per-entry validation function in admin/routes/config.js.
// Keep in sync if the route validation changes.

function validateSourceEntry(item) {
  if (!item.id || typeof item.id !== "string") {
    return `All source entries must have a string "id" field. Found: ${JSON.stringify(item).slice(0, 80)}`;
  }
  if (typeof item.enabled !== "boolean") {
    return `Source "${item.id}": "enabled" must be true or false, got: ${JSON.stringify(item.enabled)}`;
  }
  if (!item.schedule || typeof item.schedule !== "string") {
    return `Source "${item.id}": "schedule" must be a non-empty string`;
  }
  if (!item.module || typeof item.module !== "string") {
    return `Source "${item.id}": "module" must be a non-empty string`;
  }
  return null;
}

describe("validateSourceEntry", () => {
  const base = { id: "prisjakt", enabled: true, schedule: "0 */4 * * *", module: "scrapers/prisjakt.js" };

  test("returns null for a fully valid entry", () => {
    expect(validateSourceEntry(base)).toBeNull();
  });

  test("rejects missing id", () => {
    const { id: _id, ...noId } = base;
    expect(validateSourceEntry(noId)).toMatch(/string "id" field/);
  });

  test("rejects enabled as string", () => {
    expect(validateSourceEntry({ ...base, enabled: "yes" })).toMatch(/"enabled" must be true or false/);
  });

  test("rejects enabled as number", () => {
    expect(validateSourceEntry({ ...base, enabled: 1 })).toMatch(/"enabled" must be true or false/);
  });

  test("rejects missing schedule", () => {
    const { schedule: _s, ...noSched } = base;
    expect(validateSourceEntry(noSched)).toMatch(/"schedule" must be a non-empty string/);
  });

  test("rejects empty schedule", () => {
    expect(validateSourceEntry({ ...base, schedule: "" })).toMatch(/"schedule" must be a non-empty string/);
  });

  test("rejects missing module", () => {
    const { module: _m, ...noMod } = base;
    expect(validateSourceEntry(noMod)).toMatch(/"module" must be a non-empty string/);
  });

  test("rejects empty module", () => {
    expect(validateSourceEntry({ ...base, module: "" })).toMatch(/"module" must be a non-empty string/);
  });
});

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
