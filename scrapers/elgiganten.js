"use strict";

const pLimit = require("p-limit");
const logger = require("../lib/logger");
const proxy = require("../lib/proxy");
const { zyteProductToRecord: _zyteProductToRecord } = require("./komplett");

// Elgiganten.se is Akamai-protected.
// Identical strategy to komplett.js — Zyte AI extraction handles Akamai transparently
// via its residential IP pool.
//
// ipType: "residential" is set per the sourceConfig if needed; Zyte auto-selects by default.

const RETAILER = "elgiganten";

function getDefaultSeedUrls() {
  return [
    "https://www.elgiganten.se/category/datorer-tillbehor/laptops/LAPTOPS",
    "https://www.elgiganten.se/category/datorer-tillbehor/datorkomponenter/processorer/CPU",
    "https://www.elgiganten.se/category/datorer-tillbehor/datorkomponenter/grafikkort/GRAFIKKORT",
  ];
}

// Reuse the Zyte mapper from komplett.js, override retailer field
function zyteProductToRecord(zyteProduct, productUrl) {
  const record = _zyteProductToRecord(zyteProduct, productUrl);
  if (record) record.retailer = RETAILER;
  return record;
}

/**
 * Entry point called by lib/runner.js
 */
async function run(sourceConfig) {
  const log = logger.forSource(sourceConfig.id);
  const limit = pLimit(5);
  const pageLimit = sourceConfig.pageLimit ?? 5;
  const allRecords = [];

  const seedUrls = sourceConfig.startUrls ?? getDefaultSeedUrls();

  for (const seedUrl of seedUrls) {
    let pageUrl = seedUrl;
    let pageCount = 0;

    while (pageUrl && pageCount < pageLimit) {
      pageCount++;
      log.info("Fetching Elgiganten category", {
        url: pageUrl,
        page: pageCount,
      });

      let nav;
      try {
        nav = await proxy.fetchProductList(pageUrl, sourceConfig);
      } catch (err) {
        log.error("fetchProductList failed", {
          url: pageUrl,
          err: err.message,
        });
        break;
      }

      const productUrls = (nav?.items || [])
        .map((item) => item.url)
        .filter(Boolean);
      log.info("Category page", { url: pageUrl, products: productUrls.length });

      if (productUrls.length === 0) break;

      const records = await Promise.all(
        productUrls.map((pUrl) =>
          limit(async () => {
            let zyteProduct;
            try {
              zyteProduct = await proxy.fetchProduct(pUrl, sourceConfig);
            } catch (err) {
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

      allRecords.push(...records.filter(Boolean));
      pageUrl = nav?.nextPage?.url || null;
    }
  }

  log.info("Elgiganten run complete", { totalRecords: allRecords.length });
  return allRecords;
}

module.exports = { run };
