# datorsc-scraper — Local Development & Implementation Plan

**Date:** April 2026  
**Status:** Active — Phase 3 (Scrapers)  
**Research source:** Official [Scrape.do docs](https://scrape.do/documentation/) + [Zyte API reference](https://docs.zyte.com/zyte-api/usage/reference.html) (verified April 2026)

---

## 1. Current State Audit

### ✅ Complete & functional

| Component        | File                                | Notes                                                |
| ---------------- | ----------------------------------- | ---------------------------------------------------- |
| Database schema  | `migrations/001_initial_schema.sql` | All 4 tables applied. Verified via `SHOW TABLES`     |
| Migration runner | `migrations/run.js`                 | Idempotent; tracks via `dsc_migrations`              |
| Proxy router     | `lib/proxy.js`                      | Both tiers fully implemented                         |
| DB layer         | `lib/db.js`                         | UPSERT, price history, scrape log, pool              |
| Validation       | `lib/validate.js`                   | Zod schema + price sanity check                      |
| Runner           | `lib/runner.js`                     | End-to-end job runner with repeated-failure alerting |
| Manual trigger   | `lib/run-source.js`                 | `node lib/run-source.js <source_id>`                 |
| Scheduler        | `lib/scheduler.js`                  | node-cron, graceful shutdown                         |
| Logger           | `lib/logger.js`                     | Winston, daily rotation, child loggers               |
| Awin feed        | `feeds/awin.js`                     | Real CSV/XML implementation                          |

### ❌ Stubs (return `[]`) — need implementation

| File                     | Difficulty | Proxy Tier                    |
| ------------------------ | ---------- | ----------------------------- |
| `scrapers/webhallen.js`  | Easy       | Scrape.do standard            |
| `scrapers/prisjakt.js`   | Medium     | Scrape.do standard            |
| `scrapers/inet.js`       | Medium     | Scrape.do standard + render   |
| `scrapers/komplett.js`   | Hard       | Zyte ASP + AI extraction      |
| `scrapers/elgiganten.js` | Hard       | Zyte ASP + AI extraction      |
| `feeds/adtraction.js`    | Medium     | HTTP direct (CSV feed)        |
| `feeds/amazon.js`        | Medium     | PA-API (credentials required) |

---

## 2. Verified API Reference (from official docs, April 2026)

### 2.1 Scrape.do API

**Endpoint:** `GET https://api.scrape.do/?token=TOKEN&url=ENCODED_URL`  
**Billing:** Credits charged only on 2xx responses ✅  
**Token location:** `.env` → `SCRAPE_DO_TOKEN`

#### Key parameters (verified)

| Parameter        | Type   | Default            | Use in our scrapers                                     |
| ---------------- | ------ | ------------------ | ------------------------------------------------------- |
| `token`          | string | —                  | Required, from `.env`                                   |
| `url`            | string | —                  | URL-encoded target                                      |
| `render`         | bool   | false              | `true` for Inet (SPA/JS)                                |
| `geoCode`        | string | —                  | Always `se` for Swedish pricing                         |
| `super`          | bool   | false              | `true` only if blocked on protected sites (costs extra) |
| `sessionId`      | int    | —                  | Sticky IP per category crawl session                    |
| `waitSelector`   | string | —                  | CSS selector to wait for before returning               |
| `customWait`     | int    | 0                  | Extra ms after DOM load (SPAs need 1000-2000ms)         |
| `blockResources` | bool   | true               | Default true; speeds up render                          |
| `waitUntil`      | string | `domcontentloaded` | Use `networkidle0` for heavy SPAs                       |
| `timeout`        | int    | 60000              | Max request timeout ms                                  |
| `disableRetry`   | bool   | false              | Leave default; Scrape.do auto-retries on failure        |

**Current proxy.js gap:** `super=true`, `waitSelector`, `sessionId` not yet wired. Must add to `sourceConfig` in `sources.json` and `buildScraperDoUrl()`.

### 2.2 Zyte API

**Endpoint:** `POST https://api.zyte.com/v1/extract`  
**Auth:** Basic — API key as username, empty password ✅  
**Key field:** `.env` → `ZYTE_API_KEY`

#### Key request fields (verified)

| Field               | Type   | Use in our scrapers                                                           |
| ------------------- | ------ | ----------------------------------------------------------------------------- |
| `url`               | string | Target URL                                                                    |
| `browserHtml`       | bool   | JS-rendered HTML string (Komplett, Elgiganten)                                |
| `httpResponseBody`  | bool   | Base64 raw HTML (for plain-HTTP pages)                                        |
| `product`           | bool   | **AI extraction** of single product (name, price, GTIN, availability, images) |
| `productList`       | bool   | **AI extraction** from listing/category pages                                 |
| `productNavigation` | bool   | Crawl: returns product URLs + next-page links                                 |
| `geolocation`       | string | Set to `"SE"` for Swedish locale/pricing                                      |
| `ipType`            | string | `"residential"` for Cloudflare/Akamai sites                                   |
| `javascript`        | bool   | Force JS on/off (Zyte auto-selects by default)                                |
| `actions`           | array  | Browser automation: click, scroll, wait, type                                 |
| `requestCookies`    | array  | Inject session cookies                                                        |

**Key opportunity — AI auto-extraction:** Using `product: true` or `productList: true` returns a structured object with `name`, `price`, `currency`, `gtin[{type,value}]`, `availability ("InStock"/"OutOfStock")`, `images`, `brand`, `sku` — **no CSS selectors needed**. This is the recommended approach for Komplett and Elgiganten to avoid selector brittleness. Cost is higher per request but saves major maintenance overhead.

**Current proxy.js gap:**

- `geolocation: "SE"` not passed (must be added for correct Swedish prices)
- `product`/`productList` AI extraction not exposed (must add new `fetchProduct()` function)
- `ipType: "residential"` not configurable per-source

---

## 3. Infrastructure Fixes Needed (before scraper work)

These are gaps in the existing infrastructure that **must be fixed first**:

### 3.1 Add `geolocation: "SE"` to Zyte requests

**File:** `lib/proxy.js`  
**Change:** Add `geolocation: "SE"` to all Zyte request bodies. Without it, Zyte may use a non-Swedish IP and return wrong currency/pricing.

```js
// In _fetchViaZyte, modify body:
const body = renderJs
  ? { url, browserHtml: true, geolocation: "SE" }
  : { url, httpResponseBody: true, geolocation: "SE" };
```

### 3.2 Add Scrape.do `super` and `waitSelector` support

**File:** `lib/proxy.js`, `lib/proxy.js` → `buildScraperDoUrl()`  
**Change:** Read `superProxy` and `waitSelector` from `sourceConfig`:

```js
function buildScraperDoUrl(
  targetUrl,
  {
    renderJs = false,
    geoCode = "se",
    superProxy = false,
    waitSelector = null,
  } = {},
) {
  const params = new URLSearchParams({
    token: SCRAPE_DO_TOKEN,
    url: targetUrl,
    geoCode,
  });
  if (renderJs) params.set("render", "true");
  if (superProxy) params.set("super", "true");
  if (waitSelector) params.set("waitSelector", waitSelector);
  return `${SCRAPE_DO_BASE}/?${params.toString()}`;
}
// And in fetch():
const superProxy = sourceConfig.superProxy ?? false;
const waitSelector = sourceConfig.waitSelector ?? null;
return _fetchViaScrapeDo(url, renderJs, log, { superProxy, waitSelector });
```

### 3.3 Add Zyte AI product extraction function

**File:** `lib/proxy.js`  
**Add new function** `fetchProduct(url, sourceConfig)` that uses `product: true` and returns the structured Zyte product object (not raw HTML).

```js
async function fetchProduct(url, sourceConfig = {}) {
  const log = logger.forSource(sourceConfig.id ?? "unknown");
  if (!ZYTE_API_KEY) throw new Error("ZYTE_API_KEY is not set");

  const body = {
    url,
    product: true,
    geolocation: "SE",
    // ipType omitted — Zyte auto-selects optimal; set "residential" if banned
  };

  const res = await http.post(ZYTE_BASE, body, {
    auth: { username: ZYTE_API_KEY, password: "" },
    headers: { "Content-Type": "application/json" },
  });

  if (res.status !== 200)
    throw new Error(`Zyte API returned HTTP ${res.status}`);
  return res.data.product; // structured Product object
}

async function fetchProductList(url, sourceConfig = {}) {
  // Same but with productNavigation: true — returns { items: [{url, name}], nextPage: {url} }
  const body = { url, productNavigation: true, geolocation: "SE" };
  const res = await http.post(ZYTE_BASE, body, {
    auth: { username: ZYTE_API_KEY, password: "" },
    headers: { "Content-Type": "application/json" },
  });
  if (res.status !== 200)
    throw new Error(`Zyte API returned HTTP ${res.status}`);
  return res.data.productNavigation;
}
```

### 3.4 Add budget enforcement to proxy.js

**File:** `lib/proxy.js`  
The `.env` defines `PROXY_BUDGET_CAP_SCRAPE_DO=500` and `PROXY_BUDGET_CAP_ZYTE=200` but proxy.js doesn't enforce them. Add in-memory counters per run and log a warning when within 20% of cap (full hard-stop is complex; log + alert is sufficient for dev).

### 3.5 Wire up p-retry for transient proxy failures

**File:** `lib/proxy.js`  
`p-retry` is installed but never called. Wrap both `_fetchViaScrapeDo` and `_fetchViaZyte` with `pRetry(fn, { retries: 3, minTimeout: 2000 })`. On non-2xx from Zyte (500, 503, 520) retry; on 421/451 throw immediately (permanent).

---

## 4. Implementation Order (priority-ranked)

### Step 1 — Verify tokens work (Day 1, 30 min)

Run quick ad-hoc tests before writing any scraper code:

```bash
# Test Scrape.do token
node -e "
require('dotenv').config();
const axios = require('axios');
const token = process.env.SCRAPE_DO_TOKEN;
const url = encodeURIComponent('https://httpbin.co/anything');
axios.get('https://api.scrape.do/?token=' + token + '&url=' + url)
  .then(r => console.log('Scrape.do OK, status:', r.status))
  .catch(e => console.error('Scrape.do FAIL:', e.message));
"

# Test Zyte API key
node -e "
require('dotenv').config();
const axios = require('axios');
axios.post('https://api.zyte.com/v1/extract',
  { url: 'https://httpbin.co/anything', httpResponseBody: true },
  { auth: { username: process.env.ZYTE_API_KEY, password: '' } }
).then(r => console.log('Zyte OK, status:', r.status))
 .catch(e => console.error('Zyte FAIL:', e.response?.status, e.message));
"
```

### Step 2 — Apply infra fixes (Day 1-2)

Apply the 3.1–3.5 changes above to `lib/proxy.js` before building any scraper.

### Step 3 — Implement `feeds/adtraction.js` (Day 2, ~2h)

**Why first:** No proxy cost, pure CSV HTTP download — lowest risk, confirms the full pipeline (fetch → parse → validate → upsert) works end-to-end.  
**Pattern:** Identical to `feeds/awin.js`. Adtraction feed URL structure:  
`https://api.adtraction.com/v2/partner/feeds/<CHANNEL_ID>?apiKey=<KEY>&format=csv`  
Configure `ADTRACTION_FEED_URLS=...` in `.env` (or derive from `ADTRACTION_API_KEY` + `ADTRACTION_CHANNEL_ID`).  
Test: `node lib/run-source.js adtraction`

### Step 4 — Implement `scrapers/webhallen.js` (Day 2-3, ~4h)

**Why second:** Lowest-traffic scraper, no JS render, plain HTML, Scrape.do standard tier.  
**Strategy:**

1. Use product category URLs (e.g., laptops, CPUs, GPUs) as seed URLs in `sources.json` → `startUrls: [...]`
2. `lib/proxy.js fetch()` with `renderJs: false, geoCode: 'se'`
3. Cheerio parse: product cards → extract `name`, `price`, `in_stock`, `image_url`, `affiliate_url`, EAN (from `data-ean` attribute or product page URL slug)
4. Paginate via `?page=N` param until no more results
5. Return raw records array

**EAN note for Webhallen:** Webhallen typically includes EAN in structured data (`<script type="application/ld+json">`) or in data attributes. If EAN is absent from listing page, fetch individual product page to extract from LD+JSON schema. Budget 2 requests per product.

Test: `node lib/run-source.js webhallen`

### Step 5 — Implement `scrapers/prisjakt.js` (Day 3-4, ~4h)

**Strategy:** Similar to Webhallen.

- Category URLs for price history aggregation
- Use LD+JSON structured data (Prisjakt usually includes it)
- Note: Prisjakt shows prices across multiple retailers — use as supplementary price data, not primary
- EAN available from product page structured data

### Step 6 — Implement `scrapers/inet.js` (Day 4-5, ~6h)

**Strategy:**

1. `renderJs: true`, `geoCode: 'se'`, `waitSelector: '.product-list-item'`
2. Category pages → product listing → Cheerio parse
3. EAN usually in `<meta>` tags or embedded JSON in `<script>` tags
4. Pagination: scroll-based or URL param

### Step 7 — Implement `scrapers/komplett.js` (Day 5-7, ~8h)

**Strategy (CSS-selector-free):**

1. Fetch category page with `fetchProductList(url, source)` → Zyte `productNavigation: true`  
   Returns `{ items: [{url, name, metadata}], nextPage: {url}, subCategories: [...] }`
2. For each product URL in `items`, call `fetchProduct(productUrl, source)` → Zyte `product: true`  
   Returns `{ name, price, currency, gtin: [{type: 'gtin13', value: '...'}, ...], availability, mainImage: {url}, brand: {name}, sku }`
3. Map Zyte product response → our `ProductRecord`:
   ```js
   function zyteProductToRecord(zyteProduct, retailer, affiliateUrl) {
     const gtin = zyteProduct.gtin?.find(
       (g) => g.type === "gtin13" || g.type === "gtin14",
     );
     return {
       ean: gtin?.value ?? deriveEanFromSku(zyteProduct.sku),
       name: zyteProduct.name,
       retailer,
       price_sek: parseFloat(zyteProduct.price),
       in_stock: zyteProduct.availability === "InStock",
       affiliate_url: affiliateUrl,
       image_url: zyteProduct.mainImage?.url ?? null,
       scraped_at: new Date(),
     };
   }
   ```
4. Rate-limit with `p-limit(8)` (config in `sources.json` `rateLimit.reqPerMin: 10` = max ~8 concurrent)
5. Budget control: track request count, stop at `PROXY_BUDGET_CAP_ZYTE`

**EAN fallback strategy for Komplett:**  
If Zyte AI extraction returns no GTIN (happens ~10-15% for some products), fall back to:

- Komplett article number (SKU) lookup in `dsc_products` (link by SKU if EAN absent)
- Or skip and log as invalid

### Step 8 — Implement `scrapers/elgiganten.js` (Day 7-8, ~6h)

**Strategy:** Identical to Komplett (Zyte AI extraction). Akamai is handled automatically by Zyte's residential IP selection.

### Step 9 — Implement `feeds/amazon.js` (Week 2)

**Prerequisite:** Active Amazon Associates SE account + PA-API access approved.  
**Current `.env` values:** `YOUR_AWS_ACCESS_KEY` etc. — placeholders. Cannot be tested without real credentials.  
**Strategy when credentials available:**

- Use `amazon-paapi` npm package (or raw axios to PA-API v5 HMAC-signed requests)
- Search by keyword or ASIN for Swedish computer hardware
- Map PA-API response → `ProductRecord` (ean = ASIN not a real EAN — needs special handling: store as `retailer: 'amazon_se'` with ASIN in EAN field prefixed `ASIN:`)

---

## 5. Scraper Module Template

Every scraper must follow this exact interface so `lib/runner.js` works without changes:

```js
"use strict";

const cheerio = require("cheerio");
const pLimit = require("p-limit");
const logger = require("../lib/logger");
const proxy = require("../lib/proxy");

const RETAILER = "webhallen"; // must match sources.json id

/**
 * Entry point called by lib/runner.js
 * @param {object} sourceConfig - Entry from sources.json
 * @returns {Promise<object[]>} - Raw records (not yet validated)
 */
async function run(sourceConfig) {
  const log = logger.forSource(sourceConfig.id);
  const limit = pLimit(5); // concurrent requests cap
  const allRecords = [];

  // 1. Define category seed URLs
  const seedUrls = sourceConfig.startUrls ?? getDefaultSeedUrls();

  for (const seedUrl of seedUrls) {
    let pageUrl = seedUrl;

    // 2. Paginate through listing pages
    while (pageUrl) {
      const html = await proxy.fetch(pageUrl, sourceConfig);
      const $ = cheerio.load(html);
      const products = parseListingPage($, pageUrl, log);

      // 3. Optionally fetch individual product pages for EAN
      const withDetails = await Promise.all(
        products.map((p) => limit(() => enrichProduct(p, sourceConfig, log))),
      );

      allRecords.push(...withDetails.filter(Boolean));
      pageUrl = extractNextPageUrl($); // null when no more pages
    }
  }

  log.info(`Extracted ${allRecords.length} raw records`);
  return allRecords;
}

function parseListingPage($, pageUrl, log) {
  /* CSS selector logic */
}
async function enrichProduct(product, sourceConfig, log) {
  /* Fetch product page for EAN */
}
function extractNextPageUrl($) {
  /* Return next page URL or null */
}
function getDefaultSeedUrls() {
  /* Fallback list of category URLs */
}

module.exports = { run };
```

---

## 6. `sources.json` Additions Needed

Add `startUrls` to each scraper entry for category seed pages:

```jsonc
{
  "id": "webhallen",
  "type": "scraper",
  "module": "scrapers/webhallen.js",
  "enabled": true,
  "schedule": "0 */6 * * *",
  "proxyTier": "standard",
  "renderJs": false,
  "rateLimit": { "reqPerMin": 15 },
  "startUrls": [
    "https://www.webhallen.com/se/category/1394-laptops",
    "https://www.webhallen.com/se/category/5-cpu",
    "https://www.webhallen.com/se/category/6-grafikkort"
  ]
},
{
  "id": "komplett",
  "type": "scraper",
  "module": "scrapers/komplett.js",
  "enabled": true,
  "schedule": "10 */4 * * *",
  "proxyTier": "asp",
  "renderJs": true,
  "useZyteAiExtraction": true,
  "rateLimit": { "reqPerMin": 10 },
  "startUrls": [
    "https://www.komplett.se/category/11177/laptops",
    "https://www.komplett.se/category/11179/grafikkort",
    "https://www.komplett.se/category/11180/processorer"
  ]
}
```

---

## 7. Local Dev Test Workflow

### Quick test (no API cost)

```bash
# Run the scheduler in dry-run: sources disabled except one stub
node lib/run-source.js webhallen   # stubs return [] — confirms runner/DB pipeline works
```

### First real scrape test (uses Scrape.do credits)

```bash
# 1. Temporarily reduce startUrls to 1 category, 1 page only (add pageLimit: 1 to sourceConfig)
# 2. Run manually:
node lib/run-source.js webhallen
# 3. Check DB:
mysql -u dsc_user -pdatorsc_pass datorsc -e "SELECT COUNT(*) FROM dsc_products; SELECT * FROM dsc_scrape_log ORDER BY id DESC LIMIT 3;"
```

### Check logs

```bash
# Real-time console output is shown when running manually.
# Log files in logs/ directory.
tail -f logs/datorsc-$(date +%Y-%m-%d).log
```

### Disable expensive sources during dev

In `sources.json`, set `"enabled": false` on `komplett`, `elgiganten`, and `amazon_se` during development to avoid burning Zyte/Amazon credits while testing other sources.

---

## 8. Deployment Checklist (live server migration)

When moving from local dev to the production server:

1. Push repo to server (git pull to `/var/www/datorsc-scraper/`)
2. `npm ci --omit=dev` (production install)
3. Copy `.env` to server (never commit to git; transfer via SSH)
4. Run `node migrations/run.js` on production DB
5. `pm2 start ecosystem.config.js --env production`
6. `pm2 save` + `pm2 startup` for auto-start on boot
7. Verify `pm2 list` and `pm2 logs datorsc-scraper`
8. Set `NODE_ENV=production` in ecosystem.config.js (already set)

No containers, no additional infrastructure — runs alongside WordPress on the same server as intended.

---

## 9. Risk Mitigations (active)

| Risk                                 | Mitigation                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Komplett/Elgiganten DOM changes      | Zyte AI extraction (`product: true`) — schema-based, not CSS selectors. Much more resilient        |
| Proxy budget overrun                 | Add budget counters to proxy.js; `PROXY_BUDGET_CAP_SCRAPE_DO=500`, `PROXY_BUDGET_CAP_ZYTE=200`     |
| EAN missing from scraped products    | Fall back to SKU-based dedup (skip Zod validation; store with `ean = 'SKU:' + sku`; improve later) |
| Scrape.do token expiry/account issue | Token is active; test before starting scraper work (Section 4, Step 1)                             |
| Zyte `product:true` returns empty    | Check `metadata.probability` — if < 0.5, fall back to `browserHtml` + Cheerio                      |
| Swedish locale not applied           | Always set `geoCode=se` (Scrape.do) and `geolocation: "SE"` (Zyte) — confirmed in API docs         |

---

## 10. Immediate Next Actions

**Today:**

1. [ ] Apply infra fixes (Section 3.1–3.3) to `lib/proxy.js`
2. [ ] Run token verification tests (Section 4, Step 1)
3. [ ] Confirm `node lib/run-source.js webhallen` completes without errors (even with stub returning `[]`)

**This week:** 4. [ ] `feeds/adtraction.js` — copy awin.js pattern; test with real credentials 5. [ ] `scrapers/webhallen.js` — first real scraper; confirms full pipeline 6. [ ] Add `startUrls` to `sources.json` for webhallen

**Next week:** 7. [ ] `scrapers/prisjakt.js` 8. [ ] `scrapers/inet.js` 9. [ ] `scrapers/komplett.js` (Zyte AI) + `scrapers/elgiganten.js`

**When affiliate accounts approved:** 10. [ ] Add real `AWIN_FEED_URLS` to `.env` — `feeds/awin.js` is already functional 11. [ ] `feeds/amazon.js` — after Associates SE + PA-API approval

---

_Sources: [scrape.do/documentation](https://scrape.do/documentation/) · [docs.zyte.com/zyte-api/usage/reference.html](https://docs.zyte.com/zyte-api/usage/reference.html) · codebase audit April 2026_
