"use strict";

require("dotenv").config();

const nock = require("nock");

const hasDbConfig = Boolean(process.env.DB_USER && process.env.DB_PASSWORD);

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function makeSourceId() {
  return `prisjakt_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeEan(seed) {
  const digits = String(seed).replace(/\D/g, "").padStart(12, "0").slice(-12);
  return `8${digits}`;
}

function makeListingHtml() {
  return `
    <html>
      <body>
        <a href="/produkt.php?p=1001">Valid product</a>
        <a href="/produkt.php?p=1002">Invalid product</a>
      </body>
    </html>
  `;
}

function makeProductHtml({ name, price, ean }) {
  const gtin = ean ? `,"gtin13":"${ean}"` : "";
  return `
    <html>
      <head>
        <script type="application/ld+json">{
          "@context":"https://schema.org",
          "@type":"Product",
          "name":"${name}",
          "image":"https://example.com/${encodeURIComponent(name)}.jpg",
          "offers":{
            "@type":"AggregateOffer",
            "lowPrice":${price},
            "priceCurrency":"SEK"
          }
          ${gtin}
        }</script>
      </head>
      <body><h1>${name}</h1></body>
    </html>
  `;
}

async function cleanupRecords(db, { sourceId, ean }) {
  await db.query("DELETE FROM dsc_product_sources WHERE source_id = ?", [
    sourceId,
  ]);
  await db.query("DELETE FROM dsc_scrape_log WHERE source_id = ?", [sourceId]);
  await db.query("DELETE FROM dsc_price_history WHERE source_id = ?", [
    sourceId,
  ]);

  if (!ean) {
    return;
  }

  const productRows = await db.query(
    "SELECT id FROM dsc_products WHERE ean = ?",
    [ean],
  );
  const productIds = productRows.map((row) => row.id);

  for (const productId of productIds) {
    await db.query("DELETE FROM dsc_price_history WHERE product_id = ?", [
      productId,
    ]);
    await db.query("DELETE FROM dsc_prices WHERE product_id = ?", [productId]);
  }

  await db.query("DELETE FROM dsc_products WHERE ean = ?", [ean]);
}

(hasDbConfig ? describe : describe.skip)("Prisjakt e2e", () => {
  let db;
  let runSource;
  let activeContext;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();

    process.env.SCRAPE_DO_TOKEN = "test-scrape-token";
    process.env.PROXY_BUDGET_CAP_SCRAPE_DO = "50";

    const logger = makeLogger();
    jest.doMock("../lib/logger", () => ({
      ...logger,
      forSource: () => logger,
    }));

    db = require("../lib/db");
    ({ runSource } = require("../lib/runner"));
  });

  afterEach(async () => {
    nock.cleanAll();
    nock.enableNetConnect();
    if (activeContext) {
      await cleanupRecords(db, activeContext);
      activeContext = null;
    }
    await db.closePool();
  });

  test("runner writes scrape log metrics, audit rows, and one valid price record", async () => {
    const sourceId = makeSourceId();
    const validEan = makeEan(Date.now());
    activeContext = { sourceId, ean: validEan };

    const listingUrl = "https://www.prisjakt.nu/search?category=352";
    const validProductUrl = "https://www.prisjakt.nu/produkt.php?p=1001";
    const invalidProductUrl = "https://www.prisjakt.nu/produkt.php?p=1002";
    const listingHtml = makeListingHtml();
    const validHtml = makeProductHtml({
      name: "Prisjakt E2E Valid Product",
      price: 12995,
      ean: validEan,
    });
    const invalidHtml = makeProductHtml({
      name: "Prisjakt E2E Invalid Product",
      price: 15995,
      ean: null,
    });

    nock("https://api.scrape.do")
      .get("/")
      .times(3)
      .query(true)
      .reply(function reply() {
        const parsed = new URL(`https://api.scrape.do${this.req.path}`);
        const targetUrl = parsed.searchParams.get("url");

        if (targetUrl === listingUrl) {
          return [200, listingHtml];
        }
        if (targetUrl === validProductUrl) {
          return [200, validHtml];
        }
        if (targetUrl === invalidProductUrl) {
          return [200, invalidHtml];
        }

        return [500, `unexpected target: ${targetUrl}`];
      });

    await runSource({
      id: sourceId,
      module: "scrapers/prisjakt.js",
      proxyTier: "standard",
      renderJs: true,
      pageLimit: 1,
      itemLimit: 2,
      startUrls: [listingUrl],
      rateLimit: { reqPerMin: 1000 },
    });

    const [logRow] = await db.query(
      `SELECT records_found, records_valid, records_upserted, proxy_credits_used, pages_fetched, status
       FROM dsc_scrape_log
       WHERE source_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [sourceId],
    );
    expect(logRow).toMatchObject({
      records_found: 2,
      records_valid: 1,
      records_upserted: 1,
      proxy_credits_used: 3,
      pages_fetched: 3,
      status: "ok",
    });

    const auditRows = await db.query(
      `SELECT external_id, ean, match_status
       FROM dsc_product_sources
       WHERE source_id = ?
       ORDER BY id ASC`,
      [sourceId],
    );
    expect(auditRows).toHaveLength(2);
    expect(auditRows).toEqual([
      { external_id: "1001", ean: validEan, match_status: "unmatched" },
      { external_id: "1002", ean: null, match_status: "unmatched" },
    ]);

    const [product] = await db.query(
      "SELECT id FROM dsc_products WHERE ean = ?",
      [validEan],
    );
    const [priceRow] = await db.query(
      `SELECT retailer, price_sek, previous_price, in_stock
       FROM dsc_prices
       WHERE product_id = ?`,
      [product.id],
    );
    expect(priceRow).toMatchObject({
      retailer: "prisjakt",
      price_sek: 12995,
      previous_price: null,
      in_stock: 1,
    });

    const historyRows = await db.query(
      `SELECT retailer, price_sek, in_stock, source_id
       FROM dsc_price_history
       WHERE product_id = ?`,
      [product.id],
    );
    expect(historyRows).toEqual([
      {
        retailer: "prisjakt",
        price_sek: 12995,
        in_stock: 1,
        source_id: sourceId,
      },
    ]);
  });
});
