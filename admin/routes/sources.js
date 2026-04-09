"use strict";

/**
 * Sources route — /sources
 *
 * Reads sources.json at runtime, joins with dsc_source_flags from the DB.
 * No manual update needed when config/sources.json changes.
 *
 * POST /sources/:id/toggle  — pause / resume (returns HTMX row swap)
 * POST /sources/:id/run     — trigger an immediate run via child_process
 * GET  /sources             — full sources page
 */

const { execFile } = require("child_process");
const path = require("path");
const router = require("express").Router();
const db = require("../../lib/db");
const { loadSources } = require("../lib/sources");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findSource(id) {
  const source = loadSources().find((s) => s.id === id);
  if (!source) {
    const err = new Error(`Unknown source: ${id}`);
    err.status = 404;
    throw err;
  }
  return source;
}

async function buildSourceRows() {
  const sources = loadSources();
  const flags = await db.query(
    `SELECT source_id, paused, updated_at FROM dsc_source_flags`,
  );
  const flagMap = Object.fromEntries(flags.map((f) => [f.source_id, f]));

  const lastRuns = await db.query(
    `SELECT sl.source_id, sl.status, sl.started_at, sl.records_upserted, sl.error_message
     FROM dsc_scrape_log sl
     JOIN (
       SELECT source_id, MAX(id) AS max_id
       FROM dsc_scrape_log GROUP BY source_id
     ) latest ON sl.id = latest.max_id AND sl.source_id = latest.source_id`,
  );
  const runMap = Object.fromEntries(lastRuns.map((r) => [r.source_id, r]));

  return sources.map((s) => ({
    ...s,
    paused: flagMap[s.id]?.paused === 1,
    flagUpdated: flagMap[s.id]?.updated_at ?? null,
    lastRun: runMap[s.id] ?? null,
  }));
}

// ─── GET /sources ─────────────────────────────────────────────────────────────

router.get("/", async (req, res, next) => {
  try {
    const rows = await buildSourceRows();
    res.render("sources", { title: "Sources", rows });
  } catch (err) {
    next(err);
  }
});

// ─── POST /sources/:id/toggle ─────────────────────────────────────────────────

router.post("/:id/toggle", async (req, res, next) => {
  try {
    const source = findSource(req.params.id);
    const current = await db.isSourcePaused(source.id);
    await db.setSourcePaused(source.id, !current, "admin-ui");

    const rows = await buildSourceRows();
    const row = rows.find((r) => r.id === source.id);

    if (req.headers["hx-request"]) {
      // Return just the updated <tr> so HTMX can swap it in-place
      res.render("partials/source-row", { row });
    } else {
      res.redirect("/sources");
    }
  } catch (err) {
    next(err);
  }
});

// ─── POST /sources/:id/run ────────────────────────────────────────────────────
// Accepts optional body fields: pageLimit (int), itemLimit (int), dryRun (bool)

router.post("/:id/run", async (req, res, next) => {
  try {
    const source = findSource(req.params.id);

    // Parse optional run overrides from body (sent by run-options form)
    const pageLimit = req.body.pageLimit
      ? Math.max(1, parseInt(req.body.pageLimit, 10))
      : null;
    const itemLimit = req.body.itemLimit
      ? Math.max(1, parseInt(req.body.itemLimit, 10))
      : null;
    const dryRun = req.body.dryRun === "true" || req.body.dryRun === "1";

    const extraArgs = [];
    if (pageLimit && !Number.isNaN(pageLimit))
      extraArgs.push("--pageLimit", String(pageLimit));
    if (itemLimit && !Number.isNaN(itemLimit))
      extraArgs.push("--itemLimit", String(itemLimit));
    if (dryRun) extraArgs.push("--dryRun");

    const runScript = path.resolve(__dirname, "../../lib/run-source.js");
    // Fire and forget — the run writes its own scrape_log entry
    execFile(
      process.execPath,
      [runScript, source.id, ...extraArgs],
      { cwd: path.resolve(__dirname, "../.."), timeout: 0 },
      (err) => {
        if (err) {
          const logger = require("../../lib/logger");
          logger.error(`Admin-triggered run failed: ${source.id}`, {
            err: err.message,
          });
        }
      },
    );

    // Build a label that reflects which overrides were applied
    const optParts = [];
    if (pageLimit) optParts.push(`${pageLimit}p`);
    if (itemLimit) optParts.push(`${itemLimit}i`);
    if (dryRun) optParts.push("dry");
    const opts = optParts.length ? ` (${optParts.join(", ")})` : "";

    if (req.headers["hx-request"]) {
      res.send(
        `<span class="run-feedback run-feedback--ok">✓ Queued${opts}</span>`,
      );
    } else {
      res.redirect("/sources");
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
