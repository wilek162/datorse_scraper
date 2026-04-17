"use strict";

/**
 * Dashboard route — GET /
 *
 * Aggregates source health, recent scrape logs and DB counts in one page.
 * Everything is read from the DB at runtime so adding a new source requires
 * zero changes here.
 */

const router = require("express").Router();
const db = require("../../lib/db");
const { loadSources } = require("../lib/sources");

router.get("/", async (req, res, next) => {
  try {
    const sources = loadSources();

    // Recent 20 scrape log entries (all sources)
    const recentLogs = await db.query(
      `SELECT id, source_id, status, records_found, records_upserted,
              proxy_credits_used, proxy_cost_usd, started_at, finished_at,
              TIMESTAMPDIFF(SECOND, started_at, COALESCE(finished_at, NOW())) AS duration_s
       FROM dsc_scrape_log
       ORDER BY started_at DESC
       LIMIT 20`,
    );

    // Per-source last run summary (join flags)
    const sourceSummary = await db.query(
      `SELECT sl.source_id,
              sl.status        AS last_status,
              sl.started_at    AS last_run,
              sl.records_upserted,
              sf.paused,
              sf.updated_at    AS flag_updated
       FROM dsc_scrape_log sl
       JOIN (
         SELECT source_id, MAX(id) AS max_id
         FROM dsc_scrape_log
         GROUP BY source_id
       ) latest ON sl.id = latest.max_id AND sl.source_id = latest.source_id
       LEFT JOIN dsc_source_flags sf ON sf.source_id = sl.source_id`,
    );

    // DB row counts from published views
    const [counts] = await db.query(
      `SELECT
          (SELECT COUNT(*) FROM dsc_products)                        AS total_products,
          (SELECT COUNT(*) FROM dsc_prices WHERE in_stock = 1)       AS total_prices,
          (SELECT COUNT(*) FROM dsc_scrape_log
           WHERE started_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR))    AS runs_24h,
          (SELECT COUNT(*) FROM dsc_scrape_log
           WHERE started_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
             AND status = 'failed')                                   AS fails_24h`,
    );

    res.render("dashboard", {
      title: "Dashboard",
      sources,
      sourceSummary,
      recentLogs,
      counts,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
