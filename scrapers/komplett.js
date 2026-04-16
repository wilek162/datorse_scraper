"use strict";

const pLimit = require("p-limit");
const logger = require("../lib/logger");
const proxy = require("../lib/proxy");
const { parseEan, parsePrice } = require("../lib/parse");
const {
  getItemLimit,
  getPageLimit,
  isItemLimitReached,
  takeRemaining,
} = require("../lib/source-controls");
const { ProxyFatalError } = require("../lib/proxy");

// Komplett.se is Cloudflare-protected.
// Strategy: Zyte AI extraction — no CSS selectors needed.
//   1. fetchProductList(categoryUrl) → list of product URLs + next-page
//   2. fetchProduct(productUrl)      → structured product data (name, price, gtin, availability)
//   3. Map to ProductRecord
//
// If AI extraction returns low-confidence (probability < 0.5), the record is skipped.

const RETAILER = "komplett";
const MIN_AI_PROBABILITY = 0.5;

// ─── Map Zyte Product AI response → ProductRecord ────────────────────────────
/**
 * @param {object} zyteProduct - Zyte AI product object
 * @param {string} productUrl  - Canonical product URL
 * @returns {object|null}      - ProductRecord or null if incomplete
 */
function zyteProductToRecord(zyteProduct, productUrl) {
  if (!zyteProduct) return null;

  // Confidence check — skip low-quality extractions
  const probability = zyteProduct.metadata?.probability ?? 1;
  if (probability < MIN_AI_PROBABILITY) return null;

  const name = zyteProduct.name;
  if (!name) return null;

  // Price — Zyte returns price as a string (e.g. "9990.00")
  const price = parsePrice(String(zyteProduct.price || "0"));
  if (!price || price <= 0) return null;

  // EAN — Zyte provides gtin array with type+value
  let ean = null;
  if (Array.isArray(zyteProduct.gtin)) {
    const preferred =
      zyteProduct.gtin.find(
        (g) => g.type === "gtin13" || g.type === "gtin14" || g.type === "gtin8",
      ) || zyteProduct.gtin[0];
    if (preferred?.value) ean = parseEan(preferred.value);
  }

  // Fallback EAN: derive from SKU if available (store as SKU: prefix)
  if (!ean && zyteProduct.sku) {
    ean = `SKU:${zyteProduct.sku}`; // Will fail EAN validation but stored in invalid bucket
  }

  const availability = (zyteProduct.availability || "").toLowerCase();
  const in_stock =
    availability.includes("instock") ||
    availability.includes("in_stock") ||
    availability === "";

  const imageUrl =
    zyteProduct.mainImage?.url ||
    (Array.isArray(zyteProduct.images) ? zyteProduct.images[0]?.url : null) ||
    null;

  return {
    ean,
    name: String(name).trim().slice(0, 512),
    retailer: RETAILER,
    price_sek: price,
    in_stock,
    affiliate_url: productUrl,
    image_url: imageUrl,
    scraped_at: new Date(),
  };
}

/**
 * Entry point called by lib/runner.js
 */
async function run(sourceConfig, ctx = {}) {
  const log = logger.forSource(sourceConfig.id);
  const limit = pLimit(6); // Zyte concurrency — stay within reqPerMin
  const pageLimit = getPageLimit(sourceConfig, 5);
  const itemLimit = getItemLimit(sourceConfig);
  const allRecords = []; // fallback only — populated when ctx.flush is absent or fails
  let totalFlushed = 0; // records successfully committed to DB via ctx.flush
  const currentTotal = () => allRecords.length + totalFlushed;

  const seedUrls = Array.isArray(sourceConfig.startUrls)
    ? sourceConfig.startUrls.filter(Boolean)
    : [];
  if (seedUrls.length === 0) {
    log.warn("No startUrls configured in sources.json; skipping source");
    return [];
  }

  for (const seedUrl of seedUrls) {
    let pageUrl = seedUrl;
    let pageCount = 0;

    while (
      pageUrl &&
      pageCount < pageLimit &&
      !isItemLimitReached(currentTotal(), itemLimit)
    ) {
      pageCount++;
      log.info("Fetching Komplett category", { url: pageUrl, page: pageCount });

      // Zyte productNavigation: returns product URLs + next page
      let nav;
      try {
        nav = await proxy.fetchProductList(pageUrl, sourceConfig);
      } catch (err) {
        log.error("fetchProductList failed", {
          url: pageUrl,
          err: err.message,
        });
        if (err instanceof ProxyFatalError) throw err;
        break;
      }

      const productUrls = takeRemaining(
        (nav?.items || []).map((item) => item.url).filter(Boolean),
        currentTotal(),
        itemLimit,
      );
      log.info("Category page", { url: pageUrl, products: productUrls.length });

      if (productUrls.length === 0) break;

      // AI-extract each product in parallel (rate-limited)
      const records = await Promise.all(
        productUrls.map((pUrl) =>
          limit(async () => {
            let zyteProduct;
            try {
              zyteProduct = await proxy.fetchProduct(pUrl, sourceConfig);
            } catch (err) {
              if (err instanceof ProxyFatalError) throw err;
              log.debug("fetchProduct failed", { url: pUrl, err: err.message });
              return null;
            }
            const record = zyteProductToRecord(zyteProduct, pUrl);
            if (!record)
              log.debug("Skipping low-confidence Zyte result", { url: pUrl });
            return record;
          }),
        ),
      );

      const pageRecords = records.filter(Boolean);
      if (pageRecords.length > 0) {
        const flushed = ctx.flush ? await ctx.flush(pageRecords) : false;
        if (flushed) {
          totalFlushed += pageRecords.length;
        } else {
          allRecords.push(...pageRecords);
        }
      }

      // Pagination: nextPage from Zyte navigation result
      pageUrl = nav?.nextPage?.url || null;
    }
  }

  log.info("Komplett run complete", {
    totalRecords: currentTotal(),
    flushed: totalFlushed,
    inMemory: allRecords.length,
  });
  return allRecords;
}

module.exports = { run, zyteProductToRecord };
