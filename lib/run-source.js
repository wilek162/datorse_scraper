#!/usr/bin/env node
"use strict";

// Usage: node lib/run-source.js <source_id>
// Example: node lib/run-source.js webhallen

require("dotenv").config();
const path = require("path");
const logger = require("./logger");
const db = require("./db");
const { runSource } = require("./runner");
const { applySourceOverrides, parsePositiveInt } = require("./source-controls");

function loadSources() {
  const raw = require("fs").readFileSync(
    path.join(__dirname, "..", "config", "sources.json"),
    "utf-8",
  );
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  const parsed = {
    sourceId: null,
    overrides: {},
    help: false,
  };

  while (args.length > 0) {
    const token = args.shift();

    if (!token) continue;

    if (!parsed.sourceId && !token.startsWith("--")) {
      parsed.sourceId = token;
      continue;
    }

    if (token === "--pageLimit" || token === "--page-limit") {
      parsed.overrides.pageLimit = parsePositiveInt(args.shift());
      continue;
    }

    if (token === "--itemLimit" || token === "--item-limit") {
      parsed.overrides.itemLimit = parsePositiveInt(args.shift());
      continue;
    }

    if (token === "--dryRun" || token === "--dry-run") {
      parsed.overrides.dryRun = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return parsed;
}

function usageMessage() {
  return [
    "Usage: node lib/run-source.js <source_id> [--pageLimit N] [--itemLimit N] [--dryRun]",
    "Example: node lib/run-source.js prisjakt --pageLimit 1 --itemLimit 5",
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const { sourceId, overrides, help } = parseCliArgs(argv);

  if (help || !sourceId) {
    console.error(usageMessage());
    process.exit(help ? 0 : 1);
  }

  const sources = loadSources();
  const source = sources.find((s) => s.id === sourceId);

  if (!source) {
    console.error(
      `Unknown source: "${sourceId}". Available: ${sources.map((s) => s.id).join(", ")}`,
    );
    process.exit(1);
  }

  const effectiveSource = applySourceOverrides(source, overrides);

  logger.info(`Manually running source: ${sourceId}`, {
    pageLimit: effectiveSource.pageLimit,
    itemLimit: effectiveSource.itemLimit ?? null,
    dryRun: Boolean(effectiveSource.dryRun),
  });

  await runSource(effectiveSource);
  logger.info("Manual run complete");
  await db.closePool();
  process.exit(0);
}

if (require.main === module) {
  main().catch(async (err) => {
    logger.error("Manual run failed", { err: err.message });
    await db.closePool();
    process.exit(1);
  });
}

module.exports = {
  loadSources,
  main,
  parseCliArgs,
  usageMessage,
};
