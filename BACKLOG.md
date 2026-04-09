# Datorse Scraper – Backlog & Project Status

> Last updated: 2025-07  
> Architecture reference: [SCRAPER_ARCHITECTURE.md](SCRAPER_ARCHITECTURE.md)  
> DB playbook: [datorsc_db_playbook.md](datorsc_db_playbook.md)

---

## Navigation

- [Project Status](#project-status)
- [Phases](#phases)
  - [Phase 1 – Foundation & Prisjakt MVP](#phase-1--foundation--prisjakt-mvp)
  - [Phase 2 – Resolver Layer & Published Views](#phase-2--resolver-layer--published-views)
  - [Phase 3 – Elgiganten Integration](#phase-3--elgiganten-integration)
  - [Phase 4 – Remaining Scrapers](#phase-4--remaining-scrapers)
  - [Phase 5 – WordPress / Publish Layer](#phase-5--wordpress--publish-layer)
  - [Phase 6 – Scheduler & Monitoring](#phase-6--scheduler--monitoring)
- [Source Status](#source-status)
- [Architecture Decisions](#architecture-decisions)
- [Known Issues & Findings](#known-issues--findings)
- [Backlog Items](#backlog-items)

---

## Project Status

| Layer | Status |
|-------|--------|
| Ingest (scrapers) | ✅ Prisjakt, Elgiganten live · ⏳ Komplett, Inet, Webhallen built but untested against resolver |
| Resolve (resolver.js) | ✅ Live (EAN path + external_id path) |
| Publish (SQL views) | ✅ 5 views created (migration 008) |
| Consume (WordPress) | ❌ Not started |
| Scheduler | ⚠️ Exists (scheduler.js) but not auto-triggered |

---

## Phases

### Phase 1 – Foundation & Prisjakt MVP

**Status: ✅ COMPLETE**

- Node.js + MySQL pipeline. Scrapers use Zyte API (`asp` tier) or Scrape.do (`standard` tier).
- Prisjakt scraper uses Zyte `product` AI extraction per URL.
- DB schema: `dsc_products`, `dsc_prices`, `dsc_price_history`, `dsc_product_sources`, `dsc_scrape_log`.
- Migrations 001–006 applied (including partitioned price history).
- Prisjakt smoke test: **5 canonical products created, status: ok**.

**Deliverables:**
- `scrapers/prisjakt.js`
- `migrations/001–006_*.sql`
- `lib/runner.js`, `lib/db.js`, `lib/proxy.js`, `lib/logger.js`

---

### Phase 2 – Resolver Layer & Published Views

**Status: ✅ COMPLETE**

**Problem solved:** Phase 1 products were EAN-only. Prisjakt rarely provides EAN, so all rows landed in `dsc_product_sources` as `unresolved`. New resolver layer promotes source rows to canonical products using EAN (path 1) or `(source_id, external_id)` compound key (path 2).

**DB changes:**
- Migration 007: `dsc_products.ean` made nullable; added `source_id VARCHAR(64)`, `external_id VARCHAR(255)`, unique key `uq_source_external`.
- Migration 008: 5 published views for WordPress consumption.

**Published views created:**
| View | Purpose |
|------|---------|
| `dsc_view_live_offers` | In-stock offers per product × retailer |
| `dsc_view_best_price` | Lowest current price per canonical product |
| `dsc_view_product_summary` | Full catalogue with best-price snapshot |
| `dsc_view_recent_price_history` | Last 30 days price changes |
| `dsc_view_source_health` | Per-source run health summary |

**Deliverables:**
- `lib/resolver.js` (new)
- `lib/db.js` — new functions: `upsertProductByExternalId`, `upsertOfferPrice`, `markProductSourceMatched`
- `lib/runner.js` — integrated resolver call after upsert loop
- `migrations/007_product_external_id.sql`
- `migrations/008_published_views.sql`

---

### Phase 3 – Elgiganten Integration

**Status: ✅ COMPLETE**

**Problem solved:** Elgiganten is protected by Akamai. Zyte's `productNavigation` AI returns 0 items despite valid HTML. Switched to `proxy.fetch` (Zyte browserHtml) + cheerio HTML parsing for category pages.

**Findings:**
- Old URL format `/category/...` returns 404; new format is `/datorer-kontor/datorer/laptop/windows-laptop`.
- Zyte `fetchProduct` AI does extract valid EAN from Elgiganten product pages.
- 48 product links found on category page via `a[href*="/product/"]` selector.
- Pagination: `rel="next"` link or `/page-N` URL suffix.

**Smoke test result:**
```
totalLinks: 48, kept: 2
totalRecords: 2, eanLinked: 2, extIdResolved: 0
status: ok
```

**DB state after run:**
- `dsc_products`: 2 new EAN-identified products (Samsung Galaxy Book4, HP Laptop 15)
- `dsc_prices`: 2 price rows (SEK 4490, SEK 5490)
- `dsc_product_sources`: 2 rows, `match_status = matched`
- `dsc_scrape_log`: `status = ok`, log_id 22

**Deliverables:**
- `scrapers/elgiganten.js` — rewritten (browserHtml + cheerio + fetchProduct)
- `config/sources.json` — Elgiganten startUrls updated

---

### Phase 4 – Remaining Scrapers

**Status: ⏳ PENDING**

Existing scrapers built but NOT yet tested against the resolver layer (created after them):

| Scraper | File | Tier | Notes |
|---------|------|------|-------|
| Komplett | `scrapers/komplett.js` | asp | Exports `zyteProductToRecord` (used by Elgiganten); needs resolver test |
| Inet | `scrapers/inet.js` | asp | Unknown resolver compatibility |
| Webhallen | `scrapers/webhallen.js` | asp | Unknown resolver compatibility |

**Backlog items for this phase:**
- [ ] Run Komplett smoke test against resolver, verify canonical products
- [ ] Run Inet smoke test against resolver, verify canonical products
- [ ] Run Webhallen smoke test against resolver, verify canonical products
- [ ] Verify `external_id` extraction for all three scrapers
- [ ] Update `sources.json` if any start URLs are stale (same issue as Elgiganten)

---

### Phase 5 – WordPress / Publish Layer

**Status: ❌ NOT STARTED**

**Goal:** WordPress plugin or REST endpoint reads from published views (`dsc_view_best_price`, `dsc_view_product_summary`) and renders price comparison widgets.

**Prerequisites:** Phase 4 complete (all scrapers working).

**Backlog items:**
- [ ] Design WordPress data flow (REST API vs. direct DB connection vs. JSON export)
- [ ] Create/choose WP plugin or theme integration point
- [ ] Build product listing page template consuming `dsc_view_product_summary`
- [ ] Build product detail page consuming `dsc_view_live_offers` + `dsc_view_recent_price_history`
- [ ] Implement price alert logic (optional)
- [ ] Define caching strategy (transient, object cache, CDN)

---

### Phase 6 – Scheduler & Monitoring

**Status: ⚠️ PARTIAL**

`lib/scheduler.js` exists and is referenced in `ecosystem.config.js` (PM2). Not tested for production use.

**Backlog items:**
- [ ] Validate PM2 ecosystem config (cron schedule, restart policy, log rotation)
- [ ] Add alerting on repeated `status: failed` scrape logs
- [ ] Add `dsc_view_source_health` check to dashboards / CI
- [ ] Implement proxy fallback rotation (standard → asp on 403/429)
- [ ] Add per-source circuit breaker (skip source after N consecutive failures)
- [ ] Add source-controls UI or CLI wrapper (`lib/source-controls.js` exists but unused)

---

## Source Status

| Source | Tier | Resolver Path | Last Run Status | Records (last run) |
|--------|------|---------------|-----------------|--------------------|
| prisjakt | asp | external_id | ✅ ok | 5 found, 5 upserted |
| elgiganten | asp | EAN | ✅ ok | 2 found, 2 upserted |
| komplett | asp | — | ❌ not tested | — |
| inet | asp | — | ❌ not tested | — |
| webhallen | asp | — | ❌ not tested | — |
| adtraction | — | — | ❌ feed stub only | — |
| amazon | — | — | ❌ feed stub only | — |
| awin | — | — | ❌ feed stub only | — |

---

## Architecture Decisions

| Decision | Reasoning |
|----------|-----------|
| EAN as primary canonical key | EAN is the universal product identifier across all retailers/feeds |
| `(source_id, external_id)` as fallback key | Enables canonical products even when EAN is unavailable (e.g. Prisjakt) |
| `ean` nullable in `dsc_products` | Required to support external_id-only path |
| Separate `dsc_product_sources` table | Decouples raw ingest from canonical layer; enables resolver replay |
| Published views (not materialized) | Low maintenance; acceptable for read-only WP consumption at low volume |
| Partitioned `dsc_price_history` | Future-proofing for large datasets; currently single partition |
| Zyte `browserHtml` over `productNavigation` AI | Elgiganten finding: AI nav fails on Akamai sites; raw HTML is reliable |
| Cheerio HTML parsing for category pages | More durable than AI extraction for navigation-only scraping |
| Zyte `fetchProduct` AI for product detail | Works reliably for all tested ASP sites including Elgiganten |

---

## Known Issues & Findings

### Zyte productNavigation AI
- Fails for Elgiganten category pages (returns `items: []`) even when Zyte CAN access the page.
- `browserHtml` + cheerio is the reliable alternative for Akamai-protected category pages.
- All ASP sources should be verified with a raw HTML debug run before relying on Zyte AI extraction.

### Stale start URLs
- Elgiganten old URL `/category/datorer-tillbehor/laptops/LAPTOPS` returns 404.
- Always verify start URLs before enabling a source. Check via `curl -I` or Zyte raw fetch.

### Komplett `zyteProductToRecord` shared by Elgiganten
- `scrapers/elgiganten.js` imports and calls Komplett's named export.
- If Komplett's mapper is changed, Elgiganten must be tested again.

### `external_id` column not populated for EAN-matched products
- When Zyte `fetchProduct` returns a valid EAN, the resolver takes path 1 (EAN match).  
- The `dsc_products` row gets an EAN but `source_id` and `external_id` remain NULL.
- This is by design — EAN is the canonical key. The `dsc_product_sources` row stores `external_id`.

---

## Backlog Items

### High priority
- [ ] Phase 4: Run smoke tests for Komplett, Inet, Webhallen against resolver
- [ ] Phase 4: Verify `external_id` field populated for all scrapers
- [ ] Add a workspace Copilot skill for managing this backlog document

### Medium priority
- [ ] Phase 6: Test PM2 ecosystem.config.js with live scheduler
- [ ] Phase 6: Add `dsc_view_source_health` monitoring alert
- [ ] Implement proxy fallback (standard → asp)

### Low priority
- [ ] Phase 5: WordPress publish layer design
- [ ] Feed scrapers (adtraction, amazon, awin) — currently stubs
- [ ] Add partition automation via `scripts/add-partition.js`
- [ ] Source-controls CLI for enabling/disabling scrapers without code changes
