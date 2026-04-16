"use strict";

require("dotenv").config();

const hasDbConfig = Boolean(process.env.DB_USER && process.env.DB_PASSWORD);

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function makeSourceId(label) {
  return `it_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeEan(seed) {
  const digits = String(seed).replace(/\D/g, "").padStart(12, "0").slice(-12);
  return `9${digits}`;
}

async function cleanupRecords(db, { sourceId, eans }) {
  const uniqueEans = [...new Set(eans.filter(Boolean))];

  await db.query("DELETE FROM dsc_product_sources WHERE source_id = ?", [
    sourceId,
  ]);
  await db.query("DELETE FROM dsc_scrape_log WHERE source_id = ?", [sourceId]);
  await db.query("DELETE FROM dsc_price_history WHERE source_id = ?", [
    sourceId,
  ]);

  if (uniqueEans.length === 0) {
    return;
  }

  const placeholders = uniqueEans.map(() => "?").join(", ");
  const productRows = await db.query(
    `SELECT id FROM dsc_products WHERE ean IN (${placeholders})`,
    uniqueEans,
  );
  const productIds = productRows.map((row) => row.id);

  if (productIds.length > 0) {
    const productPlaceholders = productIds.map(() => "?").join(", ");
    await db.query(
      `DELETE FROM dsc_price_history WHERE product_id IN (${productPlaceholders})`,
      productIds,
    );
    await db.query(
      `DELETE FROM dsc_prices WHERE product_id IN (${productPlaceholders})`,
      productIds,
    );
  }

  await db.query(
    `DELETE FROM dsc_products WHERE ean IN (${placeholders})`,
    uniqueEans,
  );
}

(hasDbConfig ? describe : describe.skip)("DB integration", () => {
  let db;
  let activeContext;

  beforeAll(() => {
    jest.resetModules();
    const logger = makeLogger();
    jest.doMock("../lib/logger", () => ({
      ...logger,
      forSource: () => logger,
    }));
    db = require("../lib/db");
  });

  afterEach(async () => {
    if (activeContext) {
      await cleanupRecords(db, activeContext);
      activeContext = null;
    }
  });

  afterAll(async () => {
    await db.closePool();
  });

  test("saveValidationResults writes audit rows for valid, unresolved, and invalid payloads", async () => {
    const sourceId = makeSourceId("audit");
    const validEan = makeEan(Date.now());
    activeContext = { sourceId, eans: [validEan] };

    const logId = await db.startScrapeLog(sourceId);
    const scrapedAt = new Date("2026-04-09T12:00:00Z");
    const valid = [
      {
        external_id: "sku-valid-1",
        ean: validEan,
        name: "Integration Product",
        retailer: sourceId,
        price_sek: 1999,
        in_stock: true,
        affiliate_url: "https://example.com/product/valid",
        image_url: "https://example.com/product.jpg",
        scraped_at: scrapedAt,
      },
    ];
    const unresolved = [
      {
        external_id: "prisjakt-12345",
        ean: null,
        name: "Unresolved Integration Product",
        retailer: sourceId,
        price_sek: 1499,
        in_stock: true,
        affiliate_url: "https://example.com/product/unresolved",
        image_url: "https://example.com/product-unresolved.jpg",
        scraped_at: scrapedAt,
      },
    ];
    const invalid = [
      {
        record: {
          external_id: "sku-invalid-1",
          ean: null,
          name: "Invalid Integration Product",
          retailer: sourceId,
          price_sek: 0,
          in_stock: false,
          affiliate_url: "https://example.com/product/invalid",
          scraped_at: scrapedAt,
        },
        errors: ["ean: required"],
      },
    ];

    await db.saveValidationResults(logId, sourceId, {
      valid,
      unresolved,
      invalid,
    });
    await db.finishScrapeLog(logId, {
      recordsFound: 3,
      recordsValid: 1,
      recordsUpserted: 0,
      status: "partial",
      errorMessage: "integration test",
    });

    const rows = await db.query(
      `SELECT source_id, external_id, ean, match_status
       FROM dsc_product_sources
       WHERE scrape_log_id = ?
       ORDER BY id ASC`,
      [logId],
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      source_id: sourceId,
      external_id: "sku-valid-1",
      ean: validEan,
      match_status: "unmatched",
    });
    expect(rows[1]).toMatchObject({
      source_id: sourceId,
      external_id: "prisjakt-12345",
      ean: null,
      match_status: "unmatched",
    });
    expect(rows[2]).toMatchObject({
      source_id: sourceId,
      external_id: "sku-invalid-1",
      ean: null,
      match_status: "skipped",
    });
  });

  test("upsertProduct persists first_seen_source, previous_price, and history metadata", async () => {
    const sourceId = makeSourceId("upsert");
    const ean = makeEan(Date.now() + 1);
    activeContext = { sourceId, eans: [ean] };

    const baseRecord = {
      ean,
      name: "Tracked Integration Product",
      retailer: sourceId,
      affiliate_url: "https://example.com/product/tracked",
      image_url: "https://example.com/product-tracked.jpg",
    };

    await db.upsertProduct(
      {
        ...baseRecord,
        price_sek: 2500,
        in_stock: true,
        scraped_at: new Date("2026-04-09T12:05:00Z"),
      },
      sourceId,
    );

    await db.upsertProduct(
      {
        ...baseRecord,
        price_sek: 2250,
        in_stock: true,
        scraped_at: new Date("2026-04-09T12:10:00Z"),
      },
      sourceId,
    );

    await db.upsertProduct(
      {
        ...baseRecord,
        price_sek: 2250,
        in_stock: false,
        scraped_at: new Date("2026-04-09T12:15:00Z"),
      },
      sourceId,
    );

    const [product] = await db.query(
      "SELECT id, first_seen_source FROM dsc_products WHERE ean = ?",
      [ean],
    );
    expect(product.first_seen_source).toBe(sourceId);

    const [priceRow] = await db.query(
      `SELECT price_sek, previous_price, in_stock
       FROM dsc_prices
       WHERE product_id = ? AND retailer = ?`,
      [product.id, sourceId],
    );
    expect(priceRow).toMatchObject({
      price_sek: 2250,
      previous_price: 2500,
      in_stock: 0,
    });

    const historyRows = await db.query(
      `SELECT price_sek, in_stock, source_id
       FROM dsc_price_history
       WHERE product_id = ?
       ORDER BY recorded_at ASC, id ASC`,
      [product.id],
    );

    expect(historyRows).toHaveLength(3);
    expect(historyRows.map((row) => row.source_id)).toEqual([
      sourceId,
      sourceId,
      sourceId,
    ]);
    expect(historyRows.map((row) => row.in_stock)).toEqual([1, 1, 0]);
    expect(historyRows.map((row) => row.price_sek)).toEqual([2500, 2250, 2250]);
  });
});
