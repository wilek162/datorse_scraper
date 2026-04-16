"use strict";

const pLimit = require("p-limit");
const logger = require("../lib/logger");
const proxy = require("../lib/proxy");
const { zyteProductToRecord: _zyteProductToRecord } = require("./komplett");
const { load } = require("../lib/parse");
const {
  getItemLimit,
  getPageLimit,
  isItemLimitReached,
  takeRemaining,
} = require("../lib/source-controls");
const { ProxyFatalError } = require("../lib/proxy");

// Elgiganten.se is Akamai-protected.
// Strategy: Zyte browserHtml for category pages (productNavigation AI extraction
// returns 0 items on this site), then Zyte product AI extraction per product URL.
//
// Category URL format (updated 2026-04):
//   https://www.elgiganten.se/datorer-kontor/datorer/laptop/windows-laptop
// Product URL format:
//   https://www.elgiganten.se/product/{path}/{name}/{article_id}

const RETAILER = "elgiganten";
const BASE_URL = "https://www.elgiganten.se";

/**
 * Extracts Elgiganten article ID from a product URL.
 * Last numeric path segment is the article ID, e.g. /.../.../982110
 */
function extractArticleId(url, zyteProduct = {}) {
  const fromZyte = zyteProduct.productId || zyteProduct.sku || null;
  if (fromZyte) return String(fromZyte);

  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      if (/^\d{4,}$/.test(segments[i])) return segments[i];
    }
    const last = segments[segments.length - 1];
    if (last && last.length >= 4) return last;
  } catch (_) {
    // ignore malformed URL
  }
  return null;
}

/**
 * Extracts product URLs from a rendered category page HTML.
 * Elgiganten product links: href="/product/{path}/{name}/{id}"
 */
function extractProductLinks($) {
  const links = new Set();
  $('a[href*="/product/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    // Only accept product detail pages (exclude product comparison, etc.)
    if (!href.includes("/product/")) return;
    const full = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    links.add(full.split("?")[0]); // strip query string
  });
  return [...links];
}

/**
 * Extracts the next-page URL from an Elgiganten category page.
 * Pattern: ?page=N or /page-N suffix.
 */
function extractNextPageUrl($, currentUrl) {
  // Strategy 1: rel="next" link
  const relNext = $('a[rel="next"], link[rel="next"]').first();
  if (relNext.length) {
    const href = relNext.attr("href");
    if (href) return href.startsWith("http") ? href : `${BASE_URL}${href}`;
  }

  // Strategy 2: page number in current URL → increment
  const url = new URL(currentUrl);
  const pathMatch = url.pathname.match(/\/page-(\d+)$/);
  const current = pathMatch ? parseInt(pathMatch[1], 10) : 1;
  const next = current + 1;
  // Check if page-N link exists in DOM
  const nextHref = $(`a[href*="page-${next}"]`).first().attr("href");
  if (nextHref) {
    return nextHref.startsWith("http") ? nextHref : `${BASE_URL}${nextHref}`;
  }
  return null;
}

// Wrap Zyte product mapper, override retailer + add external_id
function zyteProductToRecord(zyteProduct, productUrl) {
  const record = _zyteProductToRecord(zyteProduct, productUrl);
  if (!record) return null;
  record.retailer = RETAILER;
  const extId = extractArticleId(productUrl, zyteProduct);
  if (extId) record.external_id = extId;
  return record;
}

/**
 * Entry point called by lib/runner.js
 */
async function run(sourceConfig, ctx = {}) {
  const log = logger.forSource(sourceConfig.id);
  const limit = pLimit(3); // concurrent product fetches — keep Zyte load low
  const pageLimit = getPageLimit(sourceConfig, 5);
  const itemLimit = getItemLimit(sourceConfig);
  const allRecords = []; // fallback only — populated when ctx.flush is absent or fails
  let totalFlushed = 0; // records successfully committed to DB via ctx.flush

  // currentTotal() replaces allRecords.length for item-limit checks so that
  // already-flushed records count toward the run's limit.
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
      log.info("Fetching Elgiganten category", {
        url: pageUrl,
        page: pageCount,
      });

      let html;
      try {
        // Use Zyte browserHtml (proxyTier: asp, renderJs: true)
        html = await proxy.fetch(pageUrl, sourceConfig);
      } catch (err) {
        log.error("Failed to fetch category page", {
          url: pageUrl,
          err: err.message,
        });
        if (err instanceof ProxyFatalError) throw err;
        break;
      }

      const $ = load(html);
      const allLinks = extractProductLinks($);
      const productUrls = takeRemaining(allLinks, currentTotal(), itemLimit);

      log.info("Category page", {
        url: pageUrl,
        totalLinks: allLinks.length,
        kept: productUrls.length,
      });

      if (productUrls.length === 0) {
        log.warn("No product links found on category page", { url: pageUrl });
        break;
      }

      // Zyte AI product extraction per item
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

      pageUrl = extractNextPageUrl($, pageUrl);
    }
  }

  log.info("Elgiganten run complete", {
    totalRecords: currentTotal(),
    flushed: totalFlushed,
    inMemory: allRecords.length,
  });
  return allRecords;
}

module.exports = { run };
