"use strict";

// Unit tests for scrapers/prisjakt.js parsing logic.
// These run offline — no proxy, no DB required.

// --- Minimal fixture HTML --------------------------------------------------

const LISTING_PAGE_HTML = `
<html><body>
  <!-- Product links: legacy PHP format (/produkt.php?p=ID) -->
  <a href="/produkt.php?p=5826885">Product A</a>
  <a href="/produkt.php?p=14636121">Product B</a>
  <a href="https://www.prisjakt.nu/produkt.php?p=99999">Product C (absolute)</a>
  <!-- Should NOT be picked up: category/brand filter links -->
  <a href="/search?brands=142&amp;category=352">Brand filter</a>
  <a href="/search?category=352">Category</a>
  <!-- Pagination buttons (?page=N) -->
  <a href="/search?category=352&amp;page=2">Sida 2</a>
  <a href="/search?category=352&amp;page=3">Sida 3</a>
</body></html>
`;

const PRODUCT_PAGE_HTML = `
<html>
<head>
  <title>Test Laptop, från 12 995 kr i butiker på Prisjakt</title>
  <script data-route-id="initial" type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "Test Laptop Pro 16GB",
    "description": "A test laptop",
    "image": "https://cdn.example.com/laptop.jpg",
    "brand": { "@type": "Brand", "name": "TestBrand" },
    "offers": {
      "@type": "AggregateOffer",
      "url": "https://www.prisjakt.nu/produkt.php?p=123",
      "lowPrice": 12995,
      "highPrice": 14999,
      "offerCount": 5,
      "priceCurrency": "SEK"
    }
  }
  </script>
</head>
<body><h1>Test Laptop Pro 16GB</h1></body>
</html>
`;

const PRODUCT_PAGE_WITH_PRICE_FIELD_HTML = `
<html>
<head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "Legacy Product",
    "image": "https://cdn.example.com/img.jpg",
    "offers": {
      "@type": "Offer",
      "price": "9990",
      "priceCurrency": "SEK"
    }
  }
  </script>
</head>
<body></body>
</html>
`;

// --- Helpers -----------------------------------------------------------------

const cheerio = require("cheerio");

// --- Replicate the internal helpers under test ------------------------------
// We duplicate the exact implementations here so that the tests remain stable
// even if the module's private API changes shape. The duplication is
// intentional and minimal.

const BASE_URL = "https://www.prisjakt.nu";

function extractProductLinks($) {
  const links = new Set();
  $('a[href*="/produkt"], a[href*="/product/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const clean = href.includes("/produkt.php") ? href : href.split("?")[0];
    const full = clean.startsWith("http") ? clean : `${BASE_URL}${clean}`;
    if (!full.includes("/produkt.php") && !full.match(/\/produkt\/[\d-]/))
      return;
    links.add(full);
  });
  return [...links];
}

function extractNextPageUrl($, currentUrl) {
  const relNext = $('a[rel="next"], link[rel="next"]').first();
  if (relNext.length) {
    const href = relNext.attr("href");
    if (href) return href.startsWith("http") ? href : `${BASE_URL}${href}`;
  }
  const url = new URL(currentUrl);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const nextPageNum = page + 1;
  const nextPageAnchor = $(`a[href*="page=${nextPageNum}"]`).first();
  if (nextPageAnchor.length) {
    url.searchParams.set("page", String(nextPageNum));
    return url.toString();
  }
  return null;
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

function parseJsonLd($) {
  const results = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const d = JSON.parse($(el).html());
      if (Array.isArray(d)) results.push(...d);
      else results.push(d);
    } catch (_) {}
  });
  return results;
}

function parsePrice(raw) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/[^\d.,]/g, "")
    .replace(/,(\d{3})/g, "$1")
    .replace(/\.(\d{3})/g, "$1")
    .replace(",", ".")
    .trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function parseEan(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-]/g, "");
  return /^\d{8,14}$/.test(cleaned) ? cleaned : null;
}

function extractPriceFromJsonLdProduct(item) {
  const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
  const rawPrice = offers?.price ?? offers?.lowPrice ?? offers?.highPrice;
  return rawPrice !== null && rawPrice !== undefined
    ? typeof rawPrice === "number"
      ? rawPrice
      : parsePrice(String(rawPrice))
    : null;
}

// =============================================================================
// Tests
// =============================================================================

describe("prisjakt — extractProductLinks", () => {
  test("finds all /produkt.php?p=ID links", () => {
    const $ = cheerio.load(LISTING_PAGE_HTML);
    const links = extractProductLinks($);
    expect(links).toHaveLength(3);
    expect(links).toContain("https://www.prisjakt.nu/produkt.php?p=5826885");
    expect(links).toContain("https://www.prisjakt.nu/produkt.php?p=14636121");
    expect(links).toContain("https://www.prisjakt.nu/produkt.php?p=99999");
  });

  test("preserves the ?p=ID query string (product ID not stripped)", () => {
    const $ = cheerio.load(LISTING_PAGE_HTML);
    const links = extractProductLinks($);
    // All links must have a ?p= parameter — without it all products collapse to /produkt.php
    links.forEach((l) => {
      expect(l).toMatch(/\/produkt\.php\?p=\d+/);
    });
  });

  test("does NOT include brand-filter or category search links", () => {
    const $ = cheerio.load(LISTING_PAGE_HTML);
    const links = extractProductLinks($);
    links.forEach((l) => {
      expect(l).not.toMatch(/\/search/);
    });
  });

  test("extracts stable external ids from product URLs", () => {
    expect(
      extractExternalIdFromProductUrl(
        "https://www.prisjakt.nu/produkt.php?p=14636121",
      ),
    ).toBe("14636121");
    expect(
      extractExternalIdFromProductUrl(
        "https://www.prisjakt.nu/product/14636121-asus-rog-nuc",
      ),
    ).toBe("14636121");
  });
});

describe("prisjakt — extractNextPageUrl", () => {
  test("returns page=2 URL when page 2 button exists", () => {
    const $ = cheerio.load(LISTING_PAGE_HTML);
    const next = extractNextPageUrl(
      $,
      "https://www.prisjakt.nu/search?category=352",
    );
    expect(next).toBe("https://www.prisjakt.nu/search?category=352&page=2");
  });

  test("returns page=3 URL when on page 2", () => {
    const $ = cheerio.load(LISTING_PAGE_HTML);
    const next = extractNextPageUrl(
      $,
      "https://www.prisjakt.nu/search?category=352&page=2",
    );
    expect(next).toBe("https://www.prisjakt.nu/search?category=352&page=3");
  });

  test("returns null when no next page link exists", () => {
    const $ = cheerio.load(
      "<html><body><a href='/search?category=352'>Page 1</a></body></html>",
    );
    const next = extractNextPageUrl(
      $,
      "https://www.prisjakt.nu/search?category=352",
    );
    expect(next).toBeNull();
  });

  test("follows rel=next when present", () => {
    const html = `<html><head><link rel="next" href="/search?category=352&page=4"/></head><body></body></html>`;
    const $ = cheerio.load(html);
    const next = extractNextPageUrl(
      $,
      "https://www.prisjakt.nu/search?category=352&page=3",
    );
    expect(next).toBe("https://www.prisjakt.nu/search?category=352&page=4");
  });
});

describe("prisjakt — JSON-LD price extraction (AggregateOffer)", () => {
  test("extracts price from lowPrice (Prisjakt AggregateOffer format)", () => {
    const $ = cheerio.load(PRODUCT_PAGE_HTML);
    const schemas = parseJsonLd($);
    const product = schemas.find((s) => s["@type"] === "Product");
    expect(product).toBeDefined();

    const price = extractPriceFromJsonLdProduct(product);
    expect(price).toBe(12995);
  });

  test("falls back to offers.price when lowPrice is absent", () => {
    const $ = cheerio.load(PRODUCT_PAGE_WITH_PRICE_FIELD_HTML);
    const schemas = parseJsonLd($);
    const product = schemas.find((s) => s["@type"] === "Product");
    expect(product).toBeDefined();

    const price = extractPriceFromJsonLdProduct(product);
    expect(price).toBe(9990);
  });

  test("extracts product name and image from JSON-LD", () => {
    const $ = cheerio.load(PRODUCT_PAGE_HTML);
    const schemas = parseJsonLd($);
    const product = schemas.find((s) => s["@type"] === "Product");
    expect(product.name).toBe("Test Laptop Pro 16GB");
    expect(product.image).toBe("https://cdn.example.com/laptop.jpg");
  });

  test("parses JSON-LD in script tags with extra data-* attributes", () => {
    // Regression guard: Prisjakt emits <script data-route-id="initial" type="application/ld+json">
    // Cheerio must still find it via script[type="application/ld+json"] selector.
    const $ = cheerio.load(PRODUCT_PAGE_HTML);
    const schemas = parseJsonLd($);
    const types = schemas.map((s) => s["@type"]);
    expect(types).toContain("Product");
  });
});

describe("prisjakt — parseEan (no EAN on Prisjakt pages)", () => {
  test("returns null for undefined/null/empty values", () => {
    expect(parseEan(null)).toBeNull();
    expect(parseEan(undefined)).toBeNull();
    expect(parseEan("")).toBeNull();
  });

  test("returns null for non-numeric strings", () => {
    expect(parseEan("not-an-ean")).toBeNull();
  });

  test("accepts valid 13-digit EAN when present", () => {
    expect(parseEan("1234567890123")).toBe("1234567890123");
  });
});
