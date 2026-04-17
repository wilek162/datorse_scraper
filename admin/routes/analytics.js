"use strict";

/**
 * Analytics route — /analytics
 *
 * Aggregates data from the scraper DB for reporting:
 *   - price distribution
 *   - source run performance
 *   - retailer coverage
 *   - match status breakdown
 */

const router = require("express").Router();
const db = require("../../lib/db");

router.get("/", async (req, res, next) => {
  try {
    // ── Top-level stats ──────────────────────────────────────────────────────
    const [statsRow] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM dsc_products) AS totalProducts,
        (SELECT COUNT(*) FROM dsc_products WHERE ean IS NOT NULL AND ean != '') AS productsWithEan,
        (SELECT COUNT(DISTINCT product_id) FROM dsc_prices WHERE in_stock = 1) AS productsWithPrice,
        (SELECT ROUND(AVG(cnt),1) FROM (
          SELECT COUNT(*) AS cnt FROM dsc_prices GROUP BY product_id
        ) t) AS avgOffersPerProduct,
        (SELECT COUNT(*) FROM dsc_product_sources WHERE match_status = 'unmatched') AS unmatchedSources,
        (SELECT COUNT(*) FROM dsc_scrape_log WHERE started_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS totalRuns7d
    `);

    // ── Price distribution buckets ────────────────────────────────────────────
    const bucketRows = await db.query(`
      SELECT
        CASE
          WHEN price_sek < 500    THEN '< 500 kr'
          WHEN price_sek < 1000   THEN '500–999 kr'
          WHEN price_sek < 2000   THEN '1 000–1 999 kr'
          WHEN price_sek < 5000   THEN '2 000–4 999 kr'
          WHEN price_sek < 10000  THEN '5 000–9 999 kr'
          WHEN price_sek < 20000  THEN '10 000–19 999 kr'
          ELSE '20 000+ kr'
        END AS label,
        COUNT(*) AS count,
        CASE
          WHEN price_sek < 500    THEN 1
          WHEN price_sek < 1000   THEN 2
          WHEN price_sek < 2000   THEN 3
          WHEN price_sek < 5000   THEN 4
          WHEN price_sek < 10000  THEN 5
          WHEN price_sek < 20000  THEN 6
          ELSE 7
        END AS sort_order
      FROM dsc_prices
      WHERE in_stock = 1
      GROUP BY label, sort_order
      ORDER BY sort_order
    `);

    // ── Source run performance ────────────────────────────────────────────────
    const sourcePerf = await db.query(`
      SELECT
        source_id,
        COUNT(*) AS total_runs,
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_runs,
        SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial_runs,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
        AVG(records_found) AS avg_records_found,
        AVG(TIMESTAMPDIFF(SECOND, started_at, COALESCE(finished_at, NOW()))) AS avg_duration_s,
        SUM(proxy_credits_used) AS total_credits
      FROM dsc_scrape_log
      WHERE started_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY source_id
      ORDER BY total_runs DESC
    `);

    // ── Retailer coverage ─────────────────────────────────────────────────────
    const retailerStats = await db.query(`
      SELECT
        retailer,
        COUNT(*) AS product_count,
        SUM(in_stock) AS in_stock_count,
        SUM(1 - in_stock) AS out_of_stock,
        AVG(price_sek) AS avg_price,
        MIN(price_sek) AS min_price,
        MAX(scraped_at) AS last_scraped
      FROM dsc_prices
      GROUP BY retailer
      ORDER BY product_count DESC
    `);

    // ── Match status breakdown (last 90 days) ─────────────────────────────────
    const matchStats = await db.query(`
      SELECT
        source_id,
        SUM(CASE WHEN match_status = 'matched'   THEN 1 ELSE 0 END) AS matched,
        SUM(CASE WHEN match_status = 'unmatched' THEN 1 ELSE 0 END) AS unmatched,
        SUM(CASE WHEN match_status = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous,
        SUM(CASE WHEN match_status = 'skipped'   THEN 1 ELSE 0 END) AS skipped
      FROM dsc_product_sources
      WHERE scraped_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
      GROUP BY source_id
      ORDER BY matched DESC
    `);

    res.render("analytics", {
      title: "Analytics",
      stats: statsRow,
      priceBuckets: bucketRows,
      sourcePerf,
      retailerStats,
      matchStats,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
