"use strict";

/**
 * Config route — /config
 *
 * GET  /config/sources  — view and edit config/sources.json
 * POST /config/sources  — save updated config/sources.json
 */

const fs = require("fs");
const path = require("path");
const router = require("express").Router();
const { loadSources } = require("../lib/sources");

const SOURCES_PATH = path.resolve(__dirname, "../../config/sources.json");

// ─── GET /config/sources ─────────────────────────────────────────────────────
router.get("/sources", (req, res, next) => {
  try {
    const sources = loadSources();
    const rawJson = fs.readFileSync(SOURCES_PATH, "utf-8");

    res.render("config", {
      title: "Configuration",
      sources,
      rawJson,
      saveMessage: null,
      saveSuccess: false,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /config/sources ────────────────────────────────────────────────────
router.post("/sources", (req, res) => {
  const rawJson = (req.body.sourcesJson || "").trim();
  let saveMessage = null;
  let saveSuccess = false;
  let sources = [];

  // Returns an error string for the first invalid field, or null if the entry is valid.
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

  function renderError(msg) {
    try { sources = loadSources(); } catch (_) {}
    return res.render("config", {
      title: "Configuration",
      sources,
      rawJson,
      saveMessage: msg,
      saveSuccess: false,
    });
  }

  // 1. Validate JSON
  let parsed;
  try {
    const stripped = rawJson.replace(/^\s*\/\/.*$/gm, "");
    parsed = JSON.parse(stripped);
  } catch (err) {
    return renderError(`JSON parse error: ${err.message}`);
  }

  // 2. Must be an array
  if (!Array.isArray(parsed)) {
    return renderError("Configuration must be a JSON array of source objects.");
  }

  // 3. Per-entry validation
  for (const item of parsed) {
    const err = validateSourceEntry(item);
    if (err) return renderError(err);
  }

  // 4. Write file
  try {
    fs.writeFileSync(SOURCES_PATH, rawJson, "utf-8");
    saveSuccess = true;
    saveMessage = `Configuration saved successfully at ${new Date().toLocaleString("sv-SE")}. ${parsed.length} sources configured.`;
    sources = parsed;
  } catch (err) {
    saveMessage = `Failed to write file: ${err.message}`;
  }

  res.render("config", {
    title: "Configuration",
    sources,
    rawJson,
    saveMessage,
    saveSuccess,
  });
});

module.exports = router;
