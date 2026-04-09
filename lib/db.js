"use strict";

require("dotenv").config();
const mysql = require("mysql2/promise");
const logger = require("./logger");
const { isSuspiciousPriceChange } = require("./validate");

function normaliseSourceEntry(rawRecord, matchStatus) {
  return {
    externalId:
      rawRecord.external_id ??
      rawRecord.externalId ??
      rawRecord.source_product_id ??
      rawRecord.sourceProductId ??
      null,
    ean: rawRecord.ean ?? null,
    rawJson: rawRecord,
    matchStatus,
    scrapedAt:
      rawRecord.scraped_at instanceof Date ? rawRecord.scraped_at : new Date(),
  };
}

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
      `INSERT INTO dsc_products (ean, name, image_url, first_seen_source)
         VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name      = IF(CHAR_LENGTH(VALUES(name)) > CHAR_LENGTH(name), VALUES(name), name),
         image_url = COALESCE(VALUES(image_url), image_url),
         first_seen_source = COALESCE(first_seen_source, VALUES(first_seen_source)),
         updated_at = NOW()`,
      [record.ean, record.name, record.image_url ?? null, sourceId],
    );

    // 2. Fetch product_id
    const [rows] = await conn.execute(
      "SELECT id FROM dsc_products WHERE ean = ?",
      [record.ean],
    );
    const productId = rows[0].id;

    // 3. Check last known price for sanity
    const [priceRows] = await conn.execute(
      `SELECT price_sek, in_stock
       FROM dsc_prices
       WHERE product_id = ? AND retailer = ?`,
      [productId, record.retailer],
    );
    const lastPrice = priceRows[0]?.price_sek ?? null;
    const lastInStock = priceRows[0]?.in_stock ?? null;

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
         (product_id, retailer, price_sek, previous_price, in_stock, affiliate_url, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         previous_price = IF(price_sek <> VALUES(price_sek), price_sek, previous_price),
         price_sek     = VALUES(price_sek),
         in_stock      = VALUES(in_stock),
         affiliate_url = VALUES(affiliate_url),
         scraped_at    = VALUES(scraped_at)`,
      [
        productId,
        record.retailer,
        record.price_sek,
        lastPrice,
        record.in_stock ? 1 : 0,
        record.affiliate_url,
        record.scraped_at,
      ],
    );

    // 5. Append to price history only on price or availability change
    if (
      lastPrice === null ||
      lastPrice !== record.price_sek ||
      lastInStock === null ||
      Boolean(lastInStock) !== Boolean(record.in_stock)
    ) {
      await conn.execute(
        `INSERT INTO dsc_price_history (product_id, retailer, price_sek, in_stock, source_id)
         VALUES (?, ?, ?, ?, ?)`,
        [
          productId,
          record.retailer,
          record.price_sek,
          record.in_stock ? 1 : 0,
          sourceId,
        ],
      );
    }

    await conn.commit();
    return { upserted: true, suspicious: false, productId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─── Resolver helpers ─────────────────────────────────────────────────────────

/**
 * Find or create a canonical product identified by (source_id, external_id).
 * Used for sources like Prisjakt where EAN is often absent.
 * Returns { productId, isNew }.
 */
async function upsertProductByExternalId(record, sourceId) {
  const extId = record.external_id ?? record.externalId ?? null;
  if (!extId) throw new Error("upsertProductByExternalId: no external_id");

  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    // ON DUPLICATE KEY on uq_source_external (source_id, external_id)
    await conn.execute(
      `INSERT INTO dsc_products
         (ean, name, brand, image_url, first_seen_source, source_id, external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name      = IF(CHAR_LENGTH(VALUES(name)) > CHAR_LENGTH(name), VALUES(name), name),
         brand     = COALESCE(brand, VALUES(brand)),
         image_url = COALESCE(image_url, VALUES(image_url)),
         ean       = COALESCE(ean, VALUES(ean)),
         updated_at = NOW()`,
      [
        record.ean ?? null,
        record.name,
        record.brand ?? null,
        record.image_url ?? null,
        sourceId,
        sourceId,
        extId,
      ],
    );

    const [rows] = await conn.execute(
      `SELECT id FROM dsc_products WHERE source_id = ? AND external_id = ?`,
      [sourceId, extId],
    );
    const productId = rows[0]?.id ?? null;
    // affected_rows: 1 = INSERT, 2 = UPDATE in MySQL ON DUPLICATE KEY
    const isNew = conn.lastID > 0;

    await conn.commit();
    return { productId, isNew };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Upserts the current price offer for a canonical product and appends a
 * price-history row when the price or stock status actually changes.
 * This is the offer-update path for external_id-resolved products.
 */
async function upsertOfferPrice(productId, record, sourceId) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    const [priceRows] = await conn.execute(
      `SELECT price_sek, in_stock FROM dsc_prices WHERE product_id = ? AND retailer = ?`,
      [productId, record.retailer],
    );
    const lastPrice = priceRows[0]?.price_sek ?? null;
    const lastInStock = priceRows[0]?.in_stock ?? null;

    if (isSuspiciousPriceChange(record.price_sek, lastPrice)) {
      logger.warn("Suspicious price change on external_id product — skipping", {
        productId,
        sourceId,
        lastPrice,
        newPrice: record.price_sek,
      });
      await conn.rollback();
      return { upserted: false, suspicious: true };
    }

    await conn.execute(
      `INSERT INTO dsc_prices
         (product_id, retailer, price_sek, previous_price, in_stock, affiliate_url, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         previous_price = IF(price_sek <> VALUES(price_sek), price_sek, previous_price),
         price_sek      = VALUES(price_sek),
         in_stock       = VALUES(in_stock),
         affiliate_url  = VALUES(affiliate_url),
         scraped_at     = VALUES(scraped_at)`,
      [
        productId,
        record.retailer,
        record.price_sek,
        lastPrice,
        record.in_stock ? 1 : 0,
        record.affiliate_url,
        record.scraped_at,
      ],
    );

    if (
      lastPrice === null ||
      lastPrice !== record.price_sek ||
      lastInStock === null ||
      Boolean(lastInStock) !== Boolean(record.in_stock)
    ) {
      await conn.execute(
        `INSERT INTO dsc_price_history (product_id, retailer, price_sek, in_stock, source_id)
         VALUES (?, ?, ?, ?, ?)`,
        [
          productId,
          record.retailer,
          record.price_sek,
          record.in_stock ? 1 : 0,
          sourceId,
        ],
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

/**
 * Updates the match_status and matched_product_id for a single
 * dsc_product_sources row that was just inserted in this run.
 * Identifies the row by (scrape_log_id, source_id) + either ean or external_id.
 */
async function markProductSourceMatched(
  logId,
  sourceId,
  ean,
  externalId,
  productId,
) {
  if (ean) {
    await getPool().execute(
      `UPDATE dsc_product_sources
       SET match_status = 'matched', matched_product_id = ?
       WHERE scrape_log_id = ? AND source_id = ? AND ean = ?
       LIMIT 1`,
      [productId, logId, sourceId, ean],
    );
  } else if (externalId) {
    await getPool().execute(
      `UPDATE dsc_product_sources
       SET match_status = 'matched', matched_product_id = ?
       WHERE scrape_log_id = ? AND source_id = ? AND external_id = ?
       LIMIT 1`,
      [productId, logId, sourceId, externalId],
    );
  }
}

async function saveProductSources(logId, sourceId, entries) {
  if (!entries || entries.length === 0) return;

  const placeholders = entries.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
  const values = [];

  for (const entry of entries) {
    values.push(
      logId,
      sourceId,
      entry.externalId,
      entry.ean,
      JSON.stringify(entry.rawJson),
      entry.matchStatus,
      entry.scrapedAt,
    );
  }

  await getPool().query(
    `INSERT INTO dsc_product_sources
       (scrape_log_id, source_id, external_id, ean, raw_json, match_status, scraped_at)
     VALUES ${placeholders}`,
    values,
  );
}

async function saveValidationResults(
  logId,
  sourceId,
  { valid, unresolved, invalid },
) {
  const entries = [
    ...valid.map((record) => normaliseSourceEntry(record, "unmatched")),
    ...unresolved.map((record) => normaliseSourceEntry(record, "unmatched")),
    ...invalid.map(({ record }) => normaliseSourceEntry(record, "skipped")),
  ];

  await saveProductSources(logId, sourceId, entries);
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
  {
    recordsFound,
    recordsValid,
    recordsUpserted,
    status,
    errorMessage,
    proxyCreditsUsed = 0,
    proxyCostUsd = null,
    pagesFetched = 0,
  },
) {
  await getPool().execute(
    `UPDATE dsc_scrape_log
     SET finished_at      = NOW(),
         records_found    = ?,
         records_valid    = ?,
         records_upserted = ?,
         proxy_credits_used = ?,
         proxy_cost_usd   = ?,
         pages_fetched    = ?,
         status           = ?,
         error_message    = ?
     WHERE id = ?`,
    [
      recordsFound,
      recordsValid,
      recordsUpserted,
      proxyCreditsUsed,
      proxyCostUsd,
      pagesFetched,
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
  saveProductSources,
  saveValidationResults,
  upsertProduct,
  upsertProductByExternalId,
  upsertOfferPrice,
  markProductSourceMatched,
  startScrapeLog,
  finishScrapeLog,
  getLastFailedRuns,
  closePool,
};
