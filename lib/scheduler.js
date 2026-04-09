"use strict";

require("dotenv").config();
const cron = require("node-cron");
const path = require("path");
const logger = require("./logger");
const db = require("./db");
const { runSource } = require("./runner");

// Strip JS comments from JSON (sources.json uses //-style comments)
function loadSources() {
  const raw = require("fs").readFileSync(
    path.join(__dirname, "..", "config", "sources.json"),
    "utf-8",
  );
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(stripped);
}

async function main() {
  logger.info("datorsc-scraper scheduler starting");

  const sources = loadSources();
  const enabled = sources.filter((s) => s.enabled);

  logger.info(`Loaded ${enabled.length}/${sources.length} enabled sources`);

  for (const source of enabled) {
    if (!cron.validate(source.schedule)) {
      logger.error(
        `Invalid cron expression for source "${source.id}": ${source.schedule}`,
      );
      continue;
    }

    cron.schedule(source.schedule, async () => {
      // Check live pause flag before every tick so UI toggles take effect
      // without requiring a process restart.
      const paused = await db.isSourcePaused(source.id).catch(() => false);
      if (paused) {
        logger.info(`Source ${source.id} is paused — skipping tick`);
        return;
      }
      logger.info(`Cron fired for source: ${source.id}`);
      await runSource(source).catch((err) => {
        logger.error(`Unhandled error in source ${source.id}`, {
          err: err.message,
        });
      });
    });

    logger.info(`Scheduled ${source.id} → ${source.schedule}`);
  }

  // Graceful shutdown
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, async () => {
      logger.info(`Received ${signal}, shutting down`);
      await db.closePool();
      process.exit(0);
    });
  }

  logger.info("Scheduler running. Waiting for jobs...");
}

main().catch((err) => {
  logger.error("Fatal scheduler error", { err: err.message, stack: err.stack });
  process.exit(1);
});
