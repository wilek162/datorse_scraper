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
router.post("/sources", (req, res, next) => {
  const rawJson = (req.body.sourcesJson || "").trim();
  let saveMessage = null;
  let saveSuccess = false;
  let sources = [];

  // 1. Validate JSON
  let parsed;
  try {
    // Strip // comments before parsing (same as loadSources does)
    const stripped = rawJson.replace(/^\s*\/\/.*$/gm, "");
    parsed = JSON.parse(stripped);
  } catch (err) {
    saveMessage = `JSON parse error: ${err.message}`;
    // Re-render with error
    try {
      sources = loadSources();
    } catch (_) {}
    return res.render("config", {
      title: "Configuration",
      sources,
      rawJson,
      saveMessage,
      saveSuccess: false,
    });
  }

  // 2. Basic schema validation — must be array of objects with id
  if (!Array.isArray(parsed)) {
    saveMessage = "Configuration must be a JSON array of source objects.";
    try {
      sources = loadSources();
    } catch (_) {}
    return res.render("config", {
      title: "Configuration",
      sources,
      rawJson,
      saveMessage,
      saveSuccess: false,
    });
  }

  for (const item of parsed) {
    if (!item.id || typeof item.id !== "string") {
      saveMessage = `All source entries must have a string "id" field. Found entry without id: ${JSON.stringify(item).slice(0, 80)}`;
      try {
        sources = loadSources();
      } catch (_) {}
      return res.render("config", {
        title: "Configuration",
        sources,
        rawJson,
        saveMessage,
        saveSuccess: false,
      });
    }
  }

  // 3. Write file
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
