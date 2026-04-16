"use strict";

/**
 * Shared helper: loads config/sources.json stripping // comments.
 * Called at request time so config changes are reflected without restarts.
 */

const fs = require("fs");
const path = require("path");

function loadSources() {
  const raw = fs.readFileSync(
    path.resolve(__dirname, "../../config/sources.json"),
    "utf-8",
  );
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
}

module.exports = { loadSources };
