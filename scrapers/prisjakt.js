"use strict";

const path = require("path");
const pLimit = require("p-limit");
const logger = require("../lib/logger");
const proxy = require("../lib/proxy");
const {
  load,
  parsePrice,
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

const MERCHANT_ALIASES = require(path.resolve(__dirname, "../config/merchant-aliases.json"));

// Prisjakt is a price comparison site.
// Primary value: accurate EAN + product names in their catalogue.
// Per-store price data is extracted from the rendered price rows on each product page.
// The aggregate "prisjakt" row (lowPrice) is also kept as a fallback/catalogue record.

const RETAILER = "prisjakt";
const BASE_URL = "https://www.prisjakt.nu";

// ─── Merchant name normalisation ──────────────────────────────────────────────
function slugifyMerchant(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Maps a Prisjakt-displayed store name to our canonical retailer slug.
 * Matches against config/merchant-aliases.json first, then auto-slugifies.
 */
function normalizeRetailerSlug(storeName) {
  return MERCHANT_ALIASES[storeName] ?? slugifyMerchant(storeName);
}

// ─── Extract per-store offer rows from a rendered product page ────────────────
/**
 * Parses the rendered Prisjakt product page HTML for individual merchant offers.
 * Each .pj-ui-price-row contains one store's offer.
 *
 * Returns an array of partial offer objects (no EAN/name — caller appends those).
 */
function parsePriceRows($, _productUrl) {
  const rows = [];

  $(".pj-ui-price-row").each((_, el) => {
    const row = $(el);
    const storeName = row.find('[class*="StoreInfoTitle"]').first().text().trim();
    if (!storeName) return;

    const priceText = row.find('[data-test="PriceLabel"]').first().text().trim();
    const price = parsePrice(priceText);
    if (!price || price <= 0) return;

    const affiliateHref = row.find('a[href*="go-to-shop"]').first().attr("href");
    if (!affiliateHref) return;
    const affiliateUrl = affiliateHref.startsWith("http")
      ? affiliateHref
      : `${BASE_URL}${affiliateHref}`;

    // Derive a Prisjakt-internal shop ID from the URL: /go-to-shop/{shopId}/...
    const shopIdMatch = affiliateHref.match(/\/go-to-shop\/(\d+)\//);
    const prisjaktShopId = shopIdMatch ? shopIdMatch[1] : null;

    const rowText = row.text();
    const outOfStock =
      rowText.toLowerCase().includes("slut") ||
      rowText.toLowerCase().includes("ej i lager") ||
      rowText.toLowerCase().includes("utgå");

    rows.push({
      retailer: normalizeRetailerSlug(storeName),
      price_sek: price,
      affiliate_url: affiliateUrl,
      in_stock: !outOfStock,
      via_source: RETAILER,
      prisjakt_shop_id: prisjaktShopId, // informational — not persisted
    });
  });

  return rows;
}

function extractExternalIdFromProductUrl(productUrl) {
  try {
    const url = new URL(productUrl);
    const queryId = url.searchParams.get("p");
    if (queryId) return queryId;

    const pathMatch = url.pathname.match(/\/(?:produkt|product)\/(\d+)/i);
    return pathMatch?.[1] ?? null;
  } catch (_) {
    return null;
  }
}

// ─── Extract product links from a category listing page ───────────────────────
function extractProductLinks($) {
  const links = new Set();

  // Prisjakt uses two URL formats:
  //   Legacy PHP: /produkt.php?p={id}   ← MUST preserve query string
  //   Slug style: /produkt/{id}-{slug}  ← strip query string
  // Selector uses *="/produkt" (no trailing slash) to match both.
  $('a[href*="/produkt"], a[href*="/product/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    // Preserve ?p=ID for legacy PHP URLs; strip for slug-style URLs.
    const clean = href.includes("/produkt.php")
      ? href // keep full URL including query string
      : href.split("?")[0];
    const full = clean.startsWith("http") ? clean : `${BASE_URL}${clean}`;
    // Guard: only accept recognisable product URL patterns.
    if (!full.includes("/produkt.php") && !full.match(/\/produkt\/[\d-]/))
      return;
    links.add(full);
  });

  return [...links];
}

// ─── Try to get products from __NEXT_DATA__ on category page ──────────────────
function extractFromNextData(nextData) {
  if (!nextData) return [];

  const knownPaths = [
    (d) => d?.props?.pageProps?.products,
    (d) => d?.props?.pageProps?.categoryProducts,
    (d) => d?.props?.pageProps?.searchResult?.products,
    (d) => d?.props?.pageProps?.initialState?.products,
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
        (arr[0].name || arr[0].title) &&
        arr[0].url !== undefined,
    ) || []
  );
}

// ─── Map __NEXT_DATA__ product to our shape ───────────────────────────────────
function mapNextDataProduct(raw) {
  const name = raw.name || raw.title;
  if (!name) return null;

  const ean = parseEan(raw.ean) || parseEan(raw.gtin) || parseEan(raw.gtin13);
  const price =
    raw.bestPrice || raw.lowestPrice || raw.price?.amount || raw.price;

  const rawUrl = raw.url || raw.canonicalUrl || raw.slug || "";
  const fullUrl = rawUrl.startsWith("http") ? rawUrl : `${BASE_URL}${rawUrl}`;

  if (!price) return null;

  return {
    name: String(name).trim().slice(0, 512),
    retailer: RETAILER,
    price_sek:
      typeof price === "number"
        ? price
        : parseFloat(String(price).replace(/[^\d.]/g, "")),
    in_stock: true, // Prisjakt only lists products with at least one offer
    affiliate_url: fullUrl,
    image_url: raw.image?.url || raw.imageUrl || null,
    ean,
    external_id: raw.id
      ? String(raw.id)
      : extractExternalIdFromProductUrl(fullUrl),
    scraped_at: new Date(),
    _productUrl: fullUrl,
  };
}

// ─── Parse a single product page for EAN + per-store offers ──────────────────
/**
 * Fetches a Prisjakt product page and returns an array of ProductRecord.
 * - With JS rendering: extracts individual merchant offer rows (N records).
 * - Also always emits one aggregate record with retailer='prisjakt' (lowPrice).
 * - Returns [] on fetch failure.
 */
async function parseProductPage(productUrl, sourceConfig, log) {
  let html;
  try {
    // renderJs required to load the dynamic .pj-ui-price-row components
    html = await proxy.fetch(productUrl, { ...sourceConfig, renderJs: true });
  } catch (err) {
    log.debug("Failed to fetch Prisjakt product page", {
      url: productUrl,
      err: err.message,
    });
    return [];
  }

  const $ = load(html);

  // ── Base product fields (name, EAN, brand, image, external_id) ─────────────
  let baseName = null;
  let baseEan = null;
  let baseBrand = null;
  let baseImage = null;
  let aggregatePrice = null;

  // 1. __NEXT_DATA__ on product page
  const nextData = parseNextData($);
  if (nextData) {
    const knownPaths = [
      (d) => d?.props?.pageProps?.product,
      (d) => d?.props?.pageProps?.pageData?.product,
    ];
    for (const fn of knownPaths) {
      try {
        const p = fn(nextData);
        if (p && (p.name || p.title)) {
          const mapped = mapNextDataProduct(p);
          if (mapped) {
            baseName = mapped.name;
            baseEan = mapped.ean ?? null;
            baseBrand = mapped.brand ?? null;
            baseImage = mapped.image_url ?? null;
            aggregatePrice = mapped.price_sek;
          }
          break;
        }
      } catch (_) {}
    }
  }

  // 2. JSON-LD Product schema (always present on prisjakt, even without NEXT_DATA)
  if (!baseName || !aggregatePrice) {
    const schemas = parseJsonLd($);
    for (const schema of schemas) {
      const items = Array.isArray(schema["@graph"]) ? schema["@graph"] : [schema];
      for (const item of items) {
        if (item["@type"] !== "Product") continue;
        if (!baseName) baseName = item.name ?? null;
        if (!baseEan) {
          baseEan =
            parseEan(item.gtin13) || parseEan(item.gtin8) || parseEan(item.gtin) || null;
        }
        if (!baseBrand) {
          baseBrand =
            typeof item.brand === "string"
              ? item.brand
              : (item.brand?.name ?? null);
        }
        if (!baseImage) {
          baseImage =
            typeof item.image === "string"
              ? item.image
              : (item.image?.url ?? null);
        }
        if (!aggregatePrice) {
          const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          const rawPrice = offers?.price ?? offers?.lowPrice ?? offers?.highPrice;
          if (rawPrice !== null && rawPrice !== undefined) {
            aggregatePrice =
              typeof rawPrice === "number" ? rawPrice : parsePrice(String(rawPrice));
          }
        }
        if (baseName && aggregatePrice) break;
      }
    }
  }

  if (!baseName || !aggregatePrice) return [];

  const externalId = extractExternalIdFromProductUrl(productUrl);
  const baseFields = {
    name: baseName,
    ean: baseEan ?? undefined,
    brand: baseBrand,
    image_url: baseImage,
    external_id: externalId,
    scraped_at: new Date(),
    in_stock: true,
  };

  // ── Per-store merchant offer rows ───────────────────────────────────────────
  const offerRows = parsePriceRows($, productUrl);

  const records = offerRows.map((offer) => ({
    ...baseFields,
    retailer: offer.retailer,
    price_sek: offer.price_sek,
    affiliate_url: offer.affiliate_url,
    in_stock: offer.in_stock,
    via_source: RETAILER,
  }));

  // ── Aggregate "prisjakt" record (always present as catalogue/fallback row) ──
  records.push({
    ...baseFields,
    retailer: RETAILER,
    price_sek: aggregatePrice,
    affiliate_url: productUrl,
    in_stock: true,
    via_source: RETAILER,
  });

  return records;
}

// ─── Extract next-page URL from Prisjakt listing page ─────────────────────────
function extractNextPageUrl($, currentUrl) {
  // Strategy 1: standard rel="next" link in <head> or inline
  const relNext = $('a[rel="next"], link[rel="next"]').first();
  if (relNext.length) {
    const href = relNext.attr("href");
    if (href) return href.startsWith("http") ? href : `${BASE_URL}${href}`;
  }

  // Derive next page number from the current URL
  const url = new URL(currentUrl);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const nextPageNum = page + 1;

  // Strategy 2: Prisjakt renders numbered page buttons (?page=N).
  // If an anchor for the next page number exists in the DOM, follow it.
  const nextPageAnchor = $(`a[href*="page=${nextPageNum}"]`).first();
  if (nextPageAnchor.length) {
    url.searchParams.set("page", String(nextPageNum));
    return url.toString();
  }

  return null;
}

/**
 * Entry point called by lib/runner.js
 */
async function run(sourceConfig) {
  const log = logger.forSource(sourceConfig.id);
  const limit = pLimit(3); // max concurrent product page fetches
  const pageLimit = getPageLimit(sourceConfig, 3);
  const itemLimit = getItemLimit(sourceConfig);
  const allRecords = [];

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
      !isItemLimitReached(allRecords.length, itemLimit)
    ) {
      pageCount++;
      log.info("Scraping Prisjakt listing", { url: pageUrl, page: pageCount });

      let html;
      try {
        html = await proxy.fetch(pageUrl, sourceConfig);
      } catch (err) {
        log.error("Failed to fetch listing", {
          url: pageUrl,
          err: err.message,
        });
        break;
      }

      const $ = load(html);

      // ── Strategy 1: __NEXT_DATA__ product list ──
      const nextData = parseNextData($);
      const rawProducts = extractFromNextData(nextData);
      const products = takeRemaining(
        rawProducts.map(mapNextDataProduct).filter(Boolean),
        allRecords.length,
        itemLimit,
      );

      if (products.length > 0) {
        log.debug("Got products from __NEXT_DATA__", {
          count: products.length,
        });
        // For every product, fetch the product page to get offer rows + EAN.
        // parseProductPage now returns ProductRecord[]; flatten into allRecords.
        const batches = await Promise.all(
          products.map((p) =>
            limit(() => parseProductPage(p._productUrl, sourceConfig, log)),
          ),
        );
        const flatRecords = batches.flat();
        log.debug("Prisjakt offer records from NEXT_DATA batch", {
          products: products.length,
          merchantOffers: flatRecords.length,
        });
        allRecords.push(...flatRecords);
      } else {
        // ── Strategy 2: Collect product links, fetch each product page ──
        const productLinks = takeRemaining(
          extractProductLinks($),
          allRecords.length,
          // Divide itemLimit by ~5 since each product yields ~5 records
          itemLimit ? Math.ceil(itemLimit / 5) : itemLimit,
        );
        log.debug("Found product links to visit", {
          count: productLinks.length,
        });

        const batches = await Promise.all(
          productLinks.map((url) =>
            limit(() => parseProductPage(url, sourceConfig, log)),
          ),
        );
        const flatRecords = batches.flat();
        log.debug("Prisjakt offer records from link batch", {
          links: productLinks.length,
          merchantOffers: flatRecords.length,
        });
        allRecords.push(...flatRecords);
      }

      pageUrl = extractNextPageUrl($, pageUrl);
    }
  }

  const uniqueProducts = new Set(allRecords.map((r) => r.external_id).filter(Boolean)).size;
  log.info("Prisjakt run complete", {
    totalRecords: allRecords.length,
    uniqueProducts,
  });
  return allRecords;
}

module.exports = { run };
