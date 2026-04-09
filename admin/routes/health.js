"use strict";

/**
 * Health route — /health
 *
 * Queries the published read-model views defined in migration 008.
 * Adding new views to the DB automatically shows them on this page via
 * the generic view-health query.
 */

const router = require("express").Router();
const db = require("../../lib/db");

router.get("/", async (req, res, next) => {
  try {
    // Source health view (one row per source)
    let sourceHealth = [];
    try {
      sourceHealth = await db.query(
        `SELECT * FROM dsc_view_source_health ORDER BY source_id`,
      );
    } catch {
      // View may not exist in older DB versions — gracefully degrade
    }

    // DB row counts
    const [counts] = await db.query(
      `SELECT
        (SELECT COUNT(*) FROM dsc_products)      AS products,
        (SELECT COUNT(*) FROM dsc_prices)        AS prices,
        (SELECT COUNT(*) FROM dsc_price_history) AS price_history,
        (SELECT COUNT(*) FROM dsc_product_sources
         WHERE match_status = 'unmatched')       AS unmatched_sources,
        (SELECT COUNT(*) FROM dsc_product_sources
         WHERE match_status = 'matched')         AS matched_sources`,
    );

    // Recent failures (last 7 days)
    const recentErrors = await db.query(
      `SELECT source_id, status, error_message, started_at
       FROM dsc_scrape_log
       WHERE status IN ('error', 'partial')
         AND started_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       ORDER BY started_at DESC
       LIMIT 30`,
    );

    // Best price view sample (top 10 cheapest)
    let bestPrices = [];
    try {
      bestPrices = await db.query(
        `SELECT * FROM dsc_view_best_price ORDER BY best_price_sek ASC LIMIT 10`,
      );
    } catch {
      // View may not exist
    }

    res.render("health", {
      title: "Health",
      sourceHealth,
      counts,
      recentErrors,
      bestPrices,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
