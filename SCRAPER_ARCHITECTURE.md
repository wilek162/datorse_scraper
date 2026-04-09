# dator.se Scraper Architecture

## Purpose

This repository is not just a collection of scrapers. Its job is to produce a reliable, queryable product-and-price dataset that dator.se can consume without coupling the WordPress site to scraper internals.

The correct end goal is:

- collect source observations cheaply and repeatably
- preserve raw source evidence for debugging and reprocessing
- resolve source observations into canonical products and merchant offers
- publish a stable, read-oriented interface for dator.se
- make scraper success depend on useful data reaching the canonical and published layers, not merely on a scraper run finishing

## Current State

The current codebase already has a solid ingestion foundation:

- source definitions live in `config/sources.json`
- source runs are orchestrated through `lib/run-source.js`, `lib/runner.js`, and `lib/scheduler.js`
- validation is handled in `lib/validate.js`
- persistence and transactional upserts live in `lib/db.js`
- raw source observations are stored in `dsc_product_sources`
- canonical products are stored in `dsc_products`
- current merchant offers are stored in `dsc_prices`
- append-only price changes are stored in `dsc_price_history`
- operational audit is stored in `dsc_scrape_log`

That is good enough to call the project a real ingestion system.

It is not yet correct to call it a finished data pipeline for dator.se.

## What Works Today

### Ingestion Flow

The actual runtime flow is:

1. A source is selected manually or by cron.
2. The source module fetches pages or feed data.
3. The runner normalises and validates records.
4. Records are classified into `valid`, `unresolved`, and `invalid`.
5. All buckets can be written to `dsc_product_sources` for audit.
6. Only canonical records with usable EAN/GTIN are promoted into `dsc_products`, `dsc_prices`, and `dsc_price_history`.
7. The scrape run is finalised in `dsc_scrape_log`.

### Strengths

- The repo is modular. Scrapers, validation, proxying, orchestration, and DB writes are separated cleanly.
- The DB write path for canonical products and prices is transactional.
- Raw-source persistence now exists, which is essential for debugging and later matching.
- Partitioning of `dsc_price_history` has been corrected for real MySQL 8.0 constraints.
- Source-specific page and item limits make smoke testing cheap.
- Tests now cover runner behavior, DB integration, CLI controls, proxy logic, and mocked end-to-end scraping.

## What Is Still Wrong

The central misconception to remove is this:

Raw-source persistence is not the same thing as successful ingestion for dator.se.

Today, the pipeline is strongest at landing source data and weakest at turning that data into a stable published catalogue.

### Issue 1: Canonical identity is still too EAN-centric

The current canonical layer effectively assumes that a product becomes usable only when the scraper can provide EAN/GTIN.

That is too strict for real-world retailer pages and comparison pages. Live verification already showed the practical result: Prisjakt can produce useful product observations, but many of them remain unresolved because no canonical EAN is present in the fetched payload.

### Issue 2: `dsc_product_sources` is a landing zone, not a completed matching system

The table contains the right kind of evidence, but the system does not yet have a full resolver stage that turns `unmatched` rows into canonical products or confirmed offers.

This means the pipeline currently stops at:

- raw observation captured
- canonical promotion blocked

That is acceptable as an intermediate state, but not as the finished architecture.

### Issue 3: The meaning of success is too weak

Operationally, a run can look healthy because it fetched pages, parsed records, and wrote audit rows.

For dator.se, that is not enough.

A source should be considered healthy only when it produces one of these outcomes:

- canonical products and offers updated
- unresolved rows increased for an expected, monitored reason

Anything else is partial at best.

### Issue 4: Merchant identity is underspecified

The current schema uses a retailer string in `dsc_prices` and `dsc_price_history`, but source identity and merchant identity are not clearly separated.

That will become a problem when:

- affiliate feeds and direct scrapers refer to the same merchant differently
- dator.se needs stable merchant pages, merchant filters, and merchant logos or metadata

### Issue 5: The scheduler is fine for a single process, not for durable operations

`lib/scheduler.js` uses in-process cron. That is acceptable while the system is small, but it lacks:

- overlap protection per source
- durable leases
- recovery state for interrupted jobs
- cross-process coordination

This should be treated as an operational limitation, not a mystery bug.

### Issue 6: WordPress has no stable read model yet

The current project ends at ingestion tables. There is no explicit publication layer for dator.se.

Without that layer, WordPress would be forced to either:

- query scraper tables directly
- learn scraper-specific semantics
- absorb canonical vs unresolved ambiguity itself

That would be the wrong boundary.

## Correct Architecture For dator.se

The correct shape is a four-layer pipeline:

1. Ingest
2. Resolve
3. Publish
4. Consume

### Layer 1: Ingest

This layer already exists.

Its responsibilities are:

- fetch source data
- normalise source records into a predictable internal format
- store source evidence in `dsc_product_sources`
- log operational outcomes in `dsc_scrape_log`

Tables in this layer:

- `dsc_scrape_log`
- `dsc_product_sources`

Important rule:

`dsc_product_sources` must be treated as the landing table for source observations, not as the final data contract for dator.se.

### Layer 2: Resolve

This is the missing layer.

Its responsibilities should be:

- match source observations to canonical products
- create new canonical products when confidence is high enough
- keep ambiguous observations out of the published layer
- populate `matched_product_id` and a truthful `match_status`

The resolver should start simple, not ambitious.

Resolution priority should be:

1. exact EAN/GTIN
2. stable source `external_id` for already-known products
3. high-confidence URL or merchant product ID recurrence
4. controlled heuristics using brand, normalized name, capacity, and model tokens
5. leave unresolved when confidence is not high enough

The resolver should not silently guess.

### Layer 3: Publish

This layer is what dator.se should actually depend on.

Its responsibilities should be:

- expose only canonical products and accepted merchant offers
- hide raw-source ambiguity
- provide fast read patterns for lists, detail pages, best-price widgets, and history charts
- protect WordPress from scraper-specific table semantics

This can be implemented as read-oriented SQL views first, and materialized read tables later if scale requires it.

Recommended first published objects:

- `dsc_view_live_offers`
- `dsc_view_best_price`
- `dsc_view_product_summary`
- `dsc_view_recent_price_history`

These should only contain rows that are safe for front-end usage.

### Layer 4: Consume

This is the WordPress and dator.se layer.

WordPress should consume only the published read model, not raw scraper tables.

## Recommended WordPress Interface

The lowest-risk near-term design is:

- keep the scraper and WordPress in separate codebases
- keep the data in MySQL with the existing `dsc_` namespace
- expose read-only SQL views or read tables for published data
- add a small WordPress plugin that reads the published layer and exposes a custom REST namespace for the site

That gives dator.se a stable contract without making WordPress understand the entire scraper schema.

### Why this is the right first interface

This follows WordPress’s documented patterns:

- WordPress supports custom data tables for plugin-managed data where post meta is not the right fit.
- WordPress supports custom REST endpoints through `register_rest_route()` and a namespaced route design.

For this project, product-price aggregation is not a natural fit for post meta. It is operational data with its own schema, update cadence, and query patterns. A separate published data layer is the correct boundary.

### Recommended plugin contract

The WordPress plugin should expose a dedicated namespace, for example:

- `/wp-json/dator/v1/products`
- `/wp-json/dator/v1/products/{id}`
- `/wp-json/dator/v1/products/{id}/offers`
- `/wp-json/dator/v1/products/{id}/history`
- `/wp-json/dator/v1/merchants`

The plugin should:

- read only from the published views or read tables
- validate request parameters strictly
- return `WP_REST_Response` or `WP_Error`
- use caching for list and detail endpoints
- keep write operations out of WordPress entirely

### What WordPress should not do

WordPress should not:

- query `dsc_product_sources` directly for front-end rendering
- infer matching logic from raw rows
- write into scraper tables
- decide whether an unresolved source row is good enough to publish

That logic belongs in the scraper pipeline.

## Database Strategy Going Forward

### Keep

The following parts of the current DB design should be kept:

- `dsc_products` as the canonical product catalogue
- `dsc_prices` as the current accepted merchant offer snapshot
- `dsc_price_history` as append-only change history
- `dsc_product_sources` as raw-source landing and audit storage
- `dsc_scrape_log` as the operational audit table

### Change

The following strategy changes are needed:

#### 1. Treat `dsc_product_sources` as a true workflow table

`match_status` must become truthful and operationally useful.

Recommended meanings:

- `matched`: source row resolved to a canonical product
- `unmatched`: usable source row awaiting resolution
- `ambiguous`: source row matched multiple possible products
- `skipped`: malformed or intentionally ignored row

`matched_product_id` should only be null when the row is truly unresolved.

#### 2. Separate source identity from merchant identity

The system should not assume that `source_id` is the same thing as the merchant shown on dator.se.

The clean solution is to add a merchant dimension later, for example:

- `dsc_merchants`
- merchant key on `dsc_prices`
- source-to-merchant mapping in configuration or a dedicated table

This is especially important once affiliate feeds and direct merchant scrapers overlap.

#### 3. Stop using raw audit volume as a primary health signal

The key health signals for dator.se should be:

- canonical products updated
- offers updated
- unresolved ratio by source
- stale published data by source or merchant

#### 4. Keep price history partitioned and narrow

`dsc_price_history` should remain an append-only ledger for accepted price changes only.

It should not become a dumping ground for unresolved observations.

## Practical Runtime Model

In practice, the system should run like this:

### A. Source ingestion

- Cron or manual CLI triggers a source.
- The source fetches pages or feed data.
- The runner writes a scrape-log row.
- Normalised rows are classified and persisted to `dsc_product_sources`.

### B. Canonical resolution

- Deterministic matching rules try to resolve source rows.
- Resolved rows populate `matched_product_id`.
- Canonical products are created or updated.
- Current offers are upserted into `dsc_prices`.
- Real offer changes append to `dsc_price_history`.

### C. Publication refresh

- Published views or read tables refresh implicitly or by job.
- Staleness checks verify that public data is still fresh enough.

### D. WordPress consumption

- The dator.se plugin queries the published layer.
- The plugin exposes stable REST routes.
- WordPress pages, widgets, or templates render only published product and offer data.

## What Success Means

For this project, source success must be measured in business terms, not crawler terms.

A source is healthy when:

- pages or records are fetched within expected cost limits
- usable rows are produced consistently
- canonical products or accepted offers are updated
- unresolved volume stays within an expected range
- published data for dator.se stays fresh

A source is not healthy just because:

- it ran without crashing
- it wrote raw rows
- it produced logs

## Requirements We Must Strive For

### Data Requirements

- No front-end row should come directly from an unresolved source record.
- Canonical product identity must be stable even when EAN is missing.
- Merchant offers must be attributable to a stable merchant identity.
- Price history must include only accepted offer changes.
- Raw-source evidence must remain available long enough for reprocessing and debugging.

### Operational Requirements

- Every source run must be auditable.
- Every source must support cheap smoke testing.
- Expensive proxy usage must remain measurable and capped.
- Scheduler overlap must be prevented before the system scales beyond one safe process.
- Source health must be monitored with canonical and published outcomes, not just raw counts.

### WordPress Requirements

- WordPress must consume a stable published contract.
- WordPress must not be the place where product resolution happens.
- Public APIs must be namespaced and versioned.
- Read endpoints must be cacheable.
- The WordPress site must tolerate temporary partial scraper failures without exposing raw ambiguity to visitors.

## Minimal Strategy Change Now

The smallest correct change in strategy is:

1. keep the current ingestion layer
2. explicitly acknowledge `dsc_product_sources` as the landing zone
3. add a resolver stage instead of pretending unresolved rows are temporary failures
4. define a published read model for dator.se
5. make WordPress consume only that published layer

This is enough to move from scraper-centric thinking to product-data-pipeline thinking without overengineering the system.

## Deferred Work

The following items are important, but they should come after the publication boundary is clear:

- full merchant dimension and merchant metadata
- stronger duplicate and overlap protection in the scheduler
- richer resolver heuristics and operator review tools
- dedicated API or separate read service if WordPress-side access becomes too limiting
- advanced analytics sinks beyond MySQL if history volume or reporting load grows significantly

## Non-Negotiable Clarifications

- There is currently no implemented `pricerunner` source in this repository. `prisjakt` is present; `pricerunner` is not.
- Live verification has already shown that raw-source persistence can succeed while canonical product writes still fail.
- The current architecture is therefore best described as partially complete: ingestion and audit are in place, but resolution and publication are still incomplete.

## Recommended Next Engineering Steps

1. Add a resolver stage that updates `matched_product_id` and truthful `match_status` values in `dsc_product_sources`.
2. Introduce a first published read layer for dator.se, preferably SQL views backed by canonical products and accepted offers only.
3. Build a small WordPress plugin that exposes versioned read-only REST endpoints against that published layer.
4. Tighten health checks so source success depends on canonical and published outcomes, not only raw rows.
5. Add source-overlap protection to the scheduler before widening the active source set.

## Final Position

The current repo is close to the correct foundation. The main mistake would be to keep adding more scrapers before defining the resolution and publication boundary.

For dator.se, the correct architecture is:

- scraper code collects and audits source data
- resolver code turns source observations into trusted canonical products and offers
- published read models expose only safe front-end data
- WordPress consumes that published interface and never depends on raw scraper semantics

That boundary is what will keep the project maintainable as sources, merchants, and front-end use cases grow.
