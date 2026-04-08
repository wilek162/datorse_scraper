"use strict";

require("dotenv").config();
const mysql = require("mysql2/promise");
const logger = require("./logger");
const { isSuspiciousPriceChange } = require("./validate");

// ─── Connection pool ──────────────────────────────────────────────────────────

let _pool = null;

function getPool() {
  if (!_pool) {
    _pool = mysql.createPool({
      host: process.env.DB_HOST || "127.0.0.1",
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || "datorsc",
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      timezone: "+00:00", // store all datetimes as UTC
      decimalNumbers: true, // DECIMAL → JS number (not string)
    });
    logger.info("MySQL connection pool created", {
      host: process.env.DB_HOST,
      db: process.env.DB_NAME,
    });
  }
  return _pool;
}

async function query(sql, params) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

// ─── Core UPSERT logic ────────────────────────────────────────────────────────

/**
 * Upserts a validated ProductRecord into dsc_products + dsc_prices.
 * Appends to dsc_price_history only when the price actually changes.
 *
 * Returns { upserted: boolean, suspicious: boolean }
 */
async function upsertProduct(record, sourceId) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    // 1. Upsert canonical product (EAN is the dedup key)
    await conn.execute(
      `INSERT INTO dsc_products (ean, name, image_url)
         VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name      = IF(CHAR_LENGTH(VALUES(name)) > CHAR_LENGTH(name), VALUES(name), name),
         image_url = COALESCE(VALUES(image_url), image_url),
         updated_at = NOW()`,
      [record.ean, record.name, record.image_url ?? null],
    );

    // 2. Fetch product_id
    const [rows] = await conn.execute(
      "SELECT id FROM dsc_products WHERE ean = ?",
      [record.ean],
    );
    const productId = rows[0].id;

    // 3. Check last known price for sanity
    const [priceRows] = await conn.execute(
      "SELECT price_sek FROM dsc_prices WHERE product_id = ? AND retailer = ?",
      [productId, record.retailer],
    );
    const lastPrice = priceRows[0]?.price_sek ?? null;

    let suspicious = false;
    if (isSuspiciousPriceChange(record.price_sek, lastPrice)) {
      suspicious = true;
      logger.warn("Suspicious price change detected — skipping update", {
        sourceId,
        ean: record.ean,
        lastPrice,
        newPrice: record.price_sek,
      });
      await conn.rollback();
      return { upserted: false, suspicious };
    }

    // 4. Upsert current price
    await conn.execute(
      `INSERT INTO dsc_prices
         (product_id, retailer, price_sek, in_stock, affiliate_url, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         price_sek     = VALUES(price_sek),
         in_stock      = VALUES(in_stock),
         affiliate_url = VALUES(affiliate_url),
         scraped_at    = VALUES(scraped_at)`,
      [
        productId,
        record.retailer,
        record.price_sek,
        record.in_stock ? 1 : 0,
        record.affiliate_url,
        record.scraped_at,
      ],
    );

    // 5. Append to price history only on actual price change
    if (lastPrice === null || lastPrice !== record.price_sek) {
      await conn.execute(
        `INSERT INTO dsc_price_history (product_id, retailer, price_sek)
         VALUES (?, ?, ?)`,
        [productId, record.retailer, record.price_sek],
      );
    }

    await conn.commit();
    return { upserted: true, suspicious: false };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─── Scrape log helpers ───────────────────────────────────────────────────────

async function startScrapeLog(sourceId) {
  const [result] = await getPool().execute(
    `INSERT INTO dsc_scrape_log (source_id, started_at, status)
     VALUES (?, NOW(), 'running')`,
    [sourceId],
  );
  return result.insertId;
}

async function finishScrapeLog(
  logId,
  { recordsFound, recordsValid, recordsUpserted, status, errorMessage },
) {
  await getPool().execute(
    `UPDATE dsc_scrape_log
     SET finished_at      = NOW(),
         records_found    = ?,
         records_valid    = ?,
         records_upserted = ?,
         status           = ?,
         error_message    = ?
     WHERE id = ?`,
    [
      recordsFound,
      recordsValid,
      recordsUpserted,
      status,
      errorMessage ?? null,
      logId,
    ],
  );
}

async function getLastFailedRuns(sourceId, n = 2) {
  return query(
    `SELECT status FROM dsc_scrape_log
     WHERE source_id = ?
     ORDER BY started_at DESC
     LIMIT ?`,
    [sourceId, n],
  );
}

async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

module.exports = {
  query,
  upsertProduct,
  startScrapeLog,
  finishScrapeLog,
  getLastFailedRuns,
  closePool,
};
