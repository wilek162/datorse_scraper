"use strict";

const pLimit = require("p-limit");
const logger = require("../lib/logger");
const proxy = require("../lib/proxy");
const {
  load,
  parsePrice,
  parseStockStatus,
  parseEan,
  parseJsonLd,
  parseNextData,
  findArrayInObject,
} = require("../lib/parse");
const {
  getItemLimit,
  getPageLimit,
  isItemLimitReached,
  takeRemaining,
} = require("../lib/source-controls");
const { ProxyFatalError } = require("../lib/proxy");

const RETAILER = "webhallen";
const BASE_URL = "https://www.webhallen.com";

// ─── Scrape a single product page for EAN ────────────────────────────────────
async function fetchProductEan(productUrl, sourceConfig, log) {
  try {
    const html = await proxy.fetch(productUrl, {
      ...sourceConfig,
      renderJs: false,
    });
    const $ = load(html);
    return extractEanFromPage($);
  } catch (err) {
    log.debug("Could not fetch product page for EAN", {
      url: productUrl,
      err: err.message,
    });
    return null;
  }
}

// ─── Extract EAN from a product or listing page ───────────────────────────────
function extractEanFromPage($) {
  // 1. JSON-LD (most reliable)
  const schemas = parseJsonLd($);
  for (const schema of schemas) {
    const items = Array.isArray(schema["@graph"]) ? schema["@graph"] : [schema];
    for (const item of items) {
      for (const key of ["gtin13", "gtin8", "gtin14", "gtin", "isbn"]) {
        const ean = parseEan(item[key]);
        if (ean) return ean;
      }
    }
  }

  // 2. Meta tags (itemprop, og:upc)
  const metaEan = $(
    'meta[itemprop="gtin13"], meta[itemprop="gtin8"], meta[itemprop="gtin"]',
  ).attr("content");
  if (parseEan(metaEan)) return parseEan(metaEan);

  // 3. data-ean or data-gtin attributes on any element
  const dataEan =
    $("[data-ean], [data-gtin]").first().attr("data-ean") ||
    $("[data-ean], [data-gtin]").first().attr("data-gtin");
  if (parseEan(dataEan)) return parseEan(dataEan);

  return null;
}

// ─── Parse product cards from __NEXT_DATA__ ───────────────────────────────────
function extractFromNextData(nextData) {
  if (!nextData) return [];

  // Try known paths first
  const knownPaths = [
    (d) => d?.props?.pageProps?.initialState?.categoryPage?.products,
    (d) => d?.props?.pageProps?.searchResult?.products,
    (d) => d?.props?.pageProps?.category?.articles,
    (d) => d?.props?.pageProps?.products,
    (d) => d?.props?.pageProps?.categoryProducts,
  ];

  for (const pathFn of knownPaths) {
    try {
      const arr = pathFn(nextData);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch (_) {
      /* path doesn't exist */
    }
  }

  // Recursive fallback: find any array with product-like objects
  const found = findArrayInObject(
    nextData,
    (arr) =>
      arr.length > 0 &&
      arr[0] &&
      (arr[0].name || arr[0].productName) &&
      (arr[0].price !== undefined || arr[0].pricing !== undefined),
  );
  return found || [];
}

// ─── Map a __NEXT_DATA__ product object to our canonical shape ────────────────
function mapNextDataProduct(raw) {
  // Name
  const name = raw.name || raw.productName || raw.title;
  if (!name) return null;

  // Price — try common field patterns
  let price = null;
  if (typeof raw.price === "number") price = raw.price;
  else if (raw.price?.current) price = parsePrice(String(raw.price.current));
  else if (raw.price?.price) price = parsePrice(String(raw.price.price));
  else if (raw.pricing?.sellingPrice !== undefined)
    price = raw.pricing.sellingPrice;
  else if (raw.pricing?.price !== undefined) price = raw.pricing.price;
  else if (typeof raw.currentPrice === "number") price = raw.currentPrice;

  if (!price) return null;

  // URL
  const rawUrl =
    raw.url || raw.canonicalUrl || raw.productUrl || raw.slug || "";
  const fullUrl = rawUrl.startsWith("http")
    ? rawUrl
    : `${BASE_URL}${rawUrl.startsWith("/") ? "" : "/se/"}${rawUrl}`;

  // EAN
  const ean =
    parseEan(raw.ean) ||
    parseEan(raw.gtin) ||
    parseEan(raw.gtin13) ||
    parseEan(raw.ean13);

  // Image
  const imageUrl =
    raw.image?.url ||
    raw.images?.[0]?.url ||
    raw.imageUrl ||
    raw.thumbnailUrl ||
    null;

  // Stock
  const stockRaw =
    raw.status ||
    raw.stockStatus ||
    raw.availability ||
    raw.stock?.status ||
    "";
  const in_stock = parseStockStatus(String(stockRaw));

  return {
    name: String(name).trim().slice(0, 512),
    retailer: RETAILER,
    price_sek: typeof price === "number" ? price : parseFloat(price),
    in_stock,
    affiliate_url: fullUrl,
    image_url: imageUrl || null,
    ean,
    scraped_at: new Date(),
    _productUrl: fullUrl, // internal — used for EAN enrichment
  };
}

// ─── Parse product cards via CSS selectors (fallback) ─────────────────────────
function parseListingViaSelectors($, log) {
  const records = [];

  // Webhallen uses article/li product cards — try multiple selector patterns
  const cardSelectors = [
    'article[class*="product"]',
    'li[class*="product"]',
    '[class*="product-list-item"]',
    '[class*="productCard"]',
    '[class*="product-card"]',
  ];

  let cards = null;
  for (const sel of cardSelectors) {
    const found = $(sel);
    if (found.length > 0) {
      cards = found;
      break;
    }
  }

  if (!cards || cards.length === 0) {
    // Last resort: any element with a product link and a price
    cards = $('a[href*="/se/product/"]').closest("li, article, div[class]");
  }

  cards.each((_, el) => {
    try {
      const $el = $(el);
      const link = $el.find('a[href*="/se/product/"]').first();
      const href = link.attr("href") || "";
      if (!href) return;

      const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      const name =
        link.text().trim() ||
        $el
          .find('h2, h3, [class*="title"], [class*="name"]')
          .first()
          .text()
          .trim();
      if (!name) return;

      const priceRaw =
        $el
          .find('[class*="price"], [itemprop="price"]')
          .first()
          .text()
          .trim() || $el.find('[class*="Price"]').first().text().trim();
      const price = parsePrice(priceRaw);
      if (!price) return;

      const stockRaw = $el
        .find('[class*="stock"], [class*="availability"]')
        .first()
        .text()
        .trim();
      const imgUrl =
        $el.find("img").first().attr("src") ||
        $el.find("img").first().attr("data-src") ||
        null;

      records.push({
        name: name.slice(0, 512),
        retailer: RETAILER,
        price_sek: price,
        in_stock: parseStockStatus(stockRaw),
        affiliate_url: fullUrl,
        image_url: imgUrl,
        ean: null,
        scraped_at: new Date(),
        _productUrl: fullUrl,
      });
    } catch (err) {
      log.debug("Skipping card (parse error)", { err: err.message });
    }
  });

  return records;
}

// ─── Extract next-page URL from listing page ──────────────────────────────────
function extractNextPageUrl($, currentUrl) {
  // Webhallen pagination: ?page=N or /page/N
  const nextLink = $(
    'a[rel="next"], [class*="pagination"] a[href*="page"]',
  ).last();
  if (nextLink.length) {
    const href = nextLink.attr("href");
    if (href) return href.startsWith("http") ? href : `${BASE_URL}${href}`;
  }

  // Try incrementing &page= or ?page= parameter
  const url = new URL(currentUrl);
  const currentPage = parseInt(url.searchParams.get("page") || "1", 10);
  const lastPage = parseInt(
    $('[class*="pagination"] [class*="last"], [class*="totalPages"]').text() ||
      "1",
    10,
  );

  if (currentPage < lastPage) {
    url.searchParams.set("page", String(currentPage + 1));
    return url.toString();
  }
  return null;
}

// ─── Entry point ──────────────────────────────────────────────────────────────
/**
 * Entry point called by lib/runner.js
 * @param {object} sourceConfig - Entry from sources.json
 * @returns {Promise<object[]>} - Raw records (not yet validated)
 */
async function run(sourceConfig, ctx = {}) {
  const log = logger.forSource(sourceConfig.id);
  const limit = pLimit(4); // concurrent product page enrichment
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
      log.info("Scraping listing page", { url: pageUrl, page: pageCount });

      let html;
      try {
        html = await proxy.fetch(pageUrl, sourceConfig);
      } catch (err) {
        log.error("Failed to fetch listing page", {
          url: pageUrl,
          err: err.message,
        });
        if (err instanceof ProxyFatalError) throw err;
        break;
      }

      const $ = load(html);

      // ── Strategy 1: __NEXT_DATA__ ──
      let products = [];
      const nextData = parseNextData($);
      if (nextData) {
        const rawProducts = extractFromNextData(nextData);
        products = takeRemaining(
          rawProducts.map((p) => mapNextDataProduct(p)).filter(Boolean),
          currentTotal(),
          itemLimit,
        );
        if (products.length > 0)
          log.debug("Extracted from __NEXT_DATA__", { count: products.length });
      }

      // ── Strategy 2: JSON-LD ItemList on the listing page ──
      if (products.length === 0) {
        const schemas = parseJsonLd($);
        for (const schema of schemas) {
          if (
            schema["@type"] === "ItemList" &&
            Array.isArray(schema.itemListElement)
          ) {
            const mapped = schema.itemListElement
              .map((entry) => {
                const item = entry.item || entry;
                if (item["@type"] !== "Product") return null;
                const ean =
                  parseEan(item.gtin13) ||
                  parseEan(item.gtin8) ||
                  parseEan(item.gtin);
                const offers = Array.isArray(item.offers)
                  ? item.offers[0]
                  : item.offers;
                const price = offers
                  ? parsePrice(String(offers.price || "0"))
                  : null;
                if (!price || !item.name) return null;
                const url = item.url || item["@id"] || "";
                const fullUrl = url.startsWith("http")
                  ? url
                  : `${BASE_URL}${url}`;
                return {
                  name: String(item.name).trim().slice(0, 512),
                  retailer: RETAILER,
                  price_sek: price,
                  in_stock: true,
                  affiliate_url: fullUrl,
                  image_url: item.image || null,
                  ean,
                  scraped_at: new Date(),
                  _productUrl: fullUrl,
                };
              })
              .filter(Boolean);
            if (mapped.length > 0) {
              products = mapped;
              break;
            }
          }
        }
      }

      // ── Strategy 3: CSS selectors ──
      if (products.length === 0) {
        products = takeRemaining(
          parseListingViaSelectors($, log),
          currentTotal(),
          itemLimit,
        );
        log.debug("Extracted via CSS selectors", { count: products.length });
      }

      log.info("Listing page parsed", {
        url: pageUrl,
        productCount: products.length,
      });

      // Enrich products missing EAN by fetching their product pages
      const needsEan = products.filter((p) => !p.ean && p._productUrl);
      if (needsEan.length > 0) {
        log.debug(`Enriching ${needsEan.length} products for EAN`);
        await Promise.all(
          needsEan.map((p) =>
            limit(async () => {
              p.ean = await fetchProductEan(p._productUrl, sourceConfig, log);
            }),
          ),
        );
      }

      // Strip internal _productUrl before flushing/returning
      const clean = products.map(({ _productUrl: _, ...rest }) => rest);
      if (clean.length > 0) {
        const flushed = ctx.flush ? await ctx.flush(clean) : false;
        if (flushed) {
          totalFlushed += clean.length;
        } else {
          allRecords.push(...clean);
        }
      }

      pageUrl = extractNextPageUrl($, pageUrl);
    }
  }

  log.info(`Webhallen run complete`, {
    totalRecords: currentTotal(),
    flushed: totalFlushed,
    inMemory: allRecords.length,
  });
  return allRecords;
}

module.exports = { run };
