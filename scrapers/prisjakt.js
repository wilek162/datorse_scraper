"use strict";

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

// Prisjakt is a price comparison site.
// Primary value: accurate EAN + product names in their catalogue.
// Price is the best (lowest) price shown across all retailers.
// Affiliate URL: Prisjakt product page (tracking through Prisjakt's program if joined).

const RETAILER = "prisjakt";
const BASE_URL = "https://www.prisjakt.nu";

function getDefaultSeedUrls() {
  return [
    "https://www.prisjakt.nu/kategori/laptopsdatorer",
    "https://www.prisjakt.nu/kategori/processorer",
    "https://www.prisjakt.nu/kategori/grafikkort",
  ];
}

// ─── Extract product links from a category listing page ───────────────────────
function extractProductLinks($) {
  const links = new Set();

  // Prisjakt uses Next.js — product links go to /produkt/{id}-{slug}
  $('a[href*="/produkt/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const clean = href.split("?")[0]; // strip query string
    const full = clean.startsWith("http") ? clean : `${BASE_URL}${clean}`;
    links.add(full);
  });

  // Swedish variant /product/
  $('a[href*="/product/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const clean = href.split("?")[0];
    const full = clean.startsWith("http") ? clean : `${BASE_URL}${clean}`;
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
    scraped_at: new Date(),
    _productUrl: fullUrl,
  };
}

// ─── Parse a single product page for EAN + price ─────────────────────────────
async function parseProductPage(productUrl, sourceConfig, log) {
  let html;
  try {
    html = await proxy.fetch(productUrl, { ...sourceConfig, renderJs: false });
  } catch (err) {
    log.debug("Failed to fetch Prisjakt product page", {
      url: productUrl,
      err: err.message,
    });
    return null;
  }

  const $ = load(html);

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
            mapped.affiliate_url = productUrl;
            return mapped;
          }
        }
      } catch (_) {}
    }
  }

  // 2. JSON-LD Product schema
  const schemas = parseJsonLd($);
  for (const schema of schemas) {
    const items = Array.isArray(schema["@graph"]) ? schema["@graph"] : [schema];
    for (const item of items) {
      if (item["@type"] !== "Product") continue;
      const ean =
        parseEan(item.gtin13) || parseEan(item.gtin8) || parseEan(item.gtin);
      const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
      const price = offers ? parsePrice(String(offers.price || "0")) : null;
      const name = item.name;
      if (!name || !price) continue;
      return {
        name: String(name).trim().slice(0, 512),
        retailer: RETAILER,
        price_sek: price,
        in_stock: true,
        affiliate_url: productUrl,
        image_url:
          typeof item.image === "string"
            ? item.image
            : (item.image?.url ?? null),
        ean,
        scraped_at: new Date(),
      };
    }
  }

  return null;
}

// ─── Extract next-page URL from Prisjakt listing page ─────────────────────────
function extractNextPageUrl($, currentUrl) {
  const nextLink = $('a[rel="next"]').first();
  if (nextLink.length) {
    const href = nextLink.attr("href");
    if (href) return href.startsWith("http") ? href : `${BASE_URL}${href}`;
  }

  // Prisjakt may use ?page=N or /page/N
  const url = new URL(currentUrl);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const totalText = $('[class*="total"], [class*="pagination"]').text();
  const totalMatch = totalText.match(/(\d+)\s*(sidor|pages)/i);
  if (totalMatch && page < parseInt(totalMatch[1], 10)) {
    url.searchParams.set("page", String(page + 1));
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
  const pageLimit = sourceConfig.pageLimit ?? 3;
  const allRecords = [];

  const seedUrls = sourceConfig.startUrls ?? getDefaultSeedUrls();

  for (const seedUrl of seedUrls) {
    let pageUrl = seedUrl;
    let pageCount = 0;

    while (pageUrl && pageCount < pageLimit) {
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
      const products = rawProducts.map(mapNextDataProduct).filter(Boolean);

      if (products.length > 0) {
        log.debug("Got products from __NEXT_DATA__", {
          count: products.length,
        });
        // Enrich ones missing EAN
        const needsEan = products.filter((p) => !p.ean);
        await Promise.all(
          needsEan.map((p) =>
            limit(async () => {
              const enriched = await parseProductPage(
                p._productUrl,
                sourceConfig,
                log,
              );
              if (enriched?.ean) p.ean = enriched.ean;
            }),
          ),
        );
        allRecords.push(...products.map(({ _productUrl: _, ...rest }) => rest));
      } else {
        // ── Strategy 2: Collect product links, fetch each product page ──
        const productLinks = extractProductLinks($);
        log.debug("Found product links to visit", {
          count: productLinks.length,
        });

        const batch = await Promise.all(
          productLinks.map((url) =>
            limit(() => parseProductPage(url, sourceConfig, log)),
          ),
        );
        allRecords.push(...batch.filter(Boolean));
      }

      pageUrl = extractNextPageUrl($, pageUrl);
    }
  }

  log.info("Prisjakt run complete", { totalRecords: allRecords.length });
  return allRecords;
}

module.exports = { run };
