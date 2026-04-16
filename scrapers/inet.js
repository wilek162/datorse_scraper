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

// inet.se is a Swedish computer retailer.
// Site is a React SPA — requires renderJs: true via Scrape.do.
// Product data is typically available in __NEXT_DATA__ or JSON-LD after rendering.

const RETAILER = "inet";
const BASE_URL = "https://www.inet.se";

// ─── Extract products from __NEXT_DATA__ ─────────────────────────────────────
function extractFromNextData(nextData) {
  if (!nextData) return [];

  const knownPaths = [
    (d) => d?.props?.pageProps?.products,
    (d) => d?.props?.pageProps?.category?.products,
    (d) => d?.props?.pageProps?.searchResult?.products,
    (d) => d?.props?.pageProps?.pageData?.products,
  ];

  for (const fn of knownPaths) {
    try {
      const arr = fn(nextData);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch (_) {}
  }

  return (
    findArrayInObject(
      nextData,
      (arr) =>
        arr.length > 0 &&
        arr[0] &&
        (arr[0].name || arr[0].productName) &&
        arr[0].id !== undefined,
    ) || []
  );
}

// ─── Map __NEXT_DATA__ product to our shape ───────────────────────────────────
function mapNextDataProduct(raw) {
  const name = raw.name || raw.productName || raw.title;
  if (!name) return null;

  let price = null;
  if (typeof raw.price === "number") price = raw.price;
  else if (raw.price?.current !== undefined) price = raw.price.current;
  else if (raw.price?.value !== undefined) price = raw.price.value;
  else if (raw.pricing?.sellingPrice !== undefined)
    price = raw.pricing.sellingPrice;
  else if (typeof raw.salePrice === "number") price = raw.salePrice;
  if (!price) return null;

  const ean = parseEan(raw.ean) || parseEan(raw.gtin) || parseEan(raw.gtin13);

  const rawUrl =
    raw.url || raw.canonicalUrl || raw.slug || raw.productUrl || "";
  const fullUrl = rawUrl.startsWith("http") ? rawUrl : `${BASE_URL}${rawUrl}`;
  if (!fullUrl || fullUrl === BASE_URL) return null;

  const stockRaw =
    raw.status || raw.availability || raw.stockStatus || raw.inStock;
  const in_stock =
    stockRaw === undefined
      ? true
      : typeof stockRaw === "boolean"
        ? stockRaw
        : parseStockStatus(String(stockRaw));

  const imgUrl =
    raw.image?.url ||
    raw.images?.[0]?.url ||
    raw.imageUrl ||
    raw.thumbnailUrl ||
    null;

  return {
    name: String(name).trim().slice(0, 512),
    retailer: RETAILER,
    price_sek: typeof price === "number" ? price : parseFloat(price),
    in_stock,
    affiliate_url: fullUrl,
    image_url: imgUrl,
    ean,
    scraped_at: new Date(),
    _productUrl: fullUrl,
  };
}

// ─── Parse product cards from rendered HTML ───────────────────────────────────
function parseListingViaSelectors($, log) {
  const records = [];

  // inet.se commonly renders product cards with these patterns
  const cardSelectors = [
    '[class*="product-list-item"]',
    '[class*="ProductCard"]',
    '[class*="product-card"]',
    'article[class*="product"]',
    'li[class*="product"]',
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
    cards = $('a[href*="/produkt/"]').closest("li, article, div[class]");
  }

  cards.each((_, el) => {
    try {
      const $el = $(el);
      const link = $el
        .find('a[href*="/produkt/"], a[href*="/product/"]')
        .first();
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

      const priceRaw = $el
        .find('[class*="price"], [itemprop="price"]')
        .first()
        .text()
        .trim();
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
      log.debug("Skipping card", { err: err.message });
    }
  });

  return records;
}

// ─── Fetch EAN from individual product page ───────────────────────────────────
async function fetchProductEan(productUrl, sourceConfig, log) {
  try {
    // Product pages need JS render too (same SPA)
    const html = await proxy.fetch(productUrl, {
      ...sourceConfig,
      renderJs: true,
    });
    const $ = load(html);

    // 1. __NEXT_DATA__
    const nextData = parseNextData($);
    if (nextData) {
      const paths = [
        (d) => d?.props?.pageProps?.product,
        (d) => d?.props?.pageProps?.pageData,
      ];
      for (const fn of paths) {
        try {
          const p = fn(nextData);
          if (p) {
            const ean =
              parseEan(p.ean) || parseEan(p.gtin) || parseEan(p.gtin13);
            if (ean) return ean;
          }
        } catch (_) {}
      }
    }

    // 2. JSON-LD
    const schemas = parseJsonLd($);
    for (const schema of schemas) {
      const items = Array.isArray(schema["@graph"])
        ? schema["@graph"]
        : [schema];
      for (const item of items) {
        const ean =
          parseEan(item.gtin13) || parseEan(item.gtin8) || parseEan(item.gtin);
        if (ean) return ean;
      }
    }

    // 3. Meta / data attributes
    const metaEan = $('meta[itemprop="gtin13"], meta[itemprop="gtin"]').attr(
      "content",
    );
    if (parseEan(metaEan)) return parseEan(metaEan);
  } catch (err) {
    log.debug("Could not fetch inet product page", {
      url: productUrl,
      err: err.message,
    });
  }
  return null;
}

// ─── Next-page URL ────────────────────────────────────────────────────────────
function extractNextPageUrl($, currentUrl) {
  const nextLink = $('a[rel="next"]').first();
  if (nextLink.length) {
    const href = nextLink.attr("href");
    if (href) return href.startsWith("http") ? href : `${BASE_URL}${href}`;
  }

  // inet.se uses query: ?page=N
  try {
    const url = new URL(currentUrl);
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const hasNext =
      $('a[href*="page=' + (page + 1) + '"]').length > 0 ||
      $('[class*="next"]').length > 0;
    if (hasNext) {
      url.searchParams.set("page", String(page + 1));
      return url.toString();
    }
  } catch (_) {}

  return null;
}

/**
 * Entry point called by lib/runner.js
 */
async function run(sourceConfig, ctx = {}) {
  const log = logger.forSource(sourceConfig.id);
  const limit = pLimit(3);
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
      log.info("Scraping inet listing", { url: pageUrl, page: pageCount });

      let html;
      try {
        html = await proxy.fetch(pageUrl, sourceConfig);
      } catch (err) {
        log.error("Failed to fetch inet listing", {
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
        const raw = extractFromNextData(nextData);
        products = takeRemaining(
          raw.map(mapNextDataProduct).filter(Boolean),
          currentTotal(),
          itemLimit,
        );
        if (products.length > 0)
          log.debug("Got products from __NEXT_DATA__", {
            count: products.length,
          });
      }

      // ── Strategy 2: JSON-LD ──
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
                const full = url.startsWith("http") ? url : `${BASE_URL}${url}`;
                return {
                  name: String(item.name).trim().slice(0, 512),
                  retailer: RETAILER,
                  price_sek: price,
                  in_stock: true,
                  affiliate_url: full,
                  image_url: typeof item.image === "string" ? item.image : null,
                  ean,
                  scraped_at: new Date(),
                  _productUrl: full,
                };
              })
              .filter(Boolean);
            if (mapped.length > 0) {
              products = takeRemaining(mapped, currentTotal(), itemLimit);
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
      }

      // Enrich EAN
      const needsEan = products.filter((p) => !p.ean && p._productUrl);
      if (needsEan.length > 0) {
        await Promise.all(
          needsEan.map((p) =>
            limit(async () => {
              p.ean = await fetchProductEan(p._productUrl, sourceConfig, log);
            }),
          ),
        );
      }

      const pageRecords = products.map(({ _productUrl: _, ...rest }) => rest);
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

  log.info("inet run complete", {
    totalRecords: currentTotal(),
    flushed: totalFlushed,
    inMemory: allRecords.length,
  });
  return allRecords;
}

module.exports = { run };
