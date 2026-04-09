"use strict";

/**
 * Logs route — /logs
 *
 * Reads dsc_scrape_log.  No changes needed when sources are added.
 *
 * GET /logs            — paginated log list
 * GET /logs/:id        — single log entry with full JSON detail
 */

const router = require("express").Router();
const db = require("../../lib/db");

const PAGE_SIZE = 50;

router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const source = req.query.source || "";
    const status = req.query.status || "";
    const offset = (page - 1) * PAGE_SIZE;

    const conditions = [];
    const params = [];

    if (source) {
      conditions.push("source_id = ?");
      params.push(source);
    }
    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [countRow] = await db.query(
      `SELECT COUNT(*) AS total FROM dsc_scrape_log ${where}`,
      params,
    );
    const total = countRow.total;

    // LIMIT/OFFSET must be interpolated as integers — mysql2 prepared statements
    // reject numeric binding for LIMIT/OFFSET on some MySQL 8 versions.
    const logs = await db.query(
      `SELECT id, source_id, status, records_found, records_valid, records_upserted,
              proxy_credits_used, proxy_cost_usd, pages_fetched, error_message,
              started_at, finished_at,
              TIMESTAMPDIFF(SECOND, started_at, COALESCE(finished_at, NOW())) AS duration_s
       FROM dsc_scrape_log ${where}
       ORDER BY started_at DESC
       LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      params.length ? params : undefined,
    );

    // Distinct source IDs for filter dropdown (auto-populated from real data)
    const sources = await db.query(
      `SELECT DISTINCT source_id FROM dsc_scrape_log ORDER BY source_id`,
    );

    res.render("logs", {
      title: "Scrape Logs",
      logs,
      sources,
      page,
      total,
      pageSize: PAGE_SIZE,
      filters: { source, status },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const [log] = await db.query(`SELECT * FROM dsc_scrape_log WHERE id = ?`, [
      req.params.id,
    ]);

    if (!log) {
      return res.status(404).render("error", {
        message: "Log entry not found",
        status: 404,
      });
    }

    // Product sources rows for this log
    const sources = await db.query(
      `SELECT external_id, ean, match_status, scraped_at
       FROM dsc_product_sources
       WHERE scrape_log_id = ?
       ORDER BY scraped_at DESC
       LIMIT 200`,
      [log.id],
    );

    res.render("log-detail", { title: `Log #${log.id}`, log, sources });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
