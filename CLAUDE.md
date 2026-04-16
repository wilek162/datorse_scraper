# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Automation Rules
- **Pre-flight Backup:** Before performing any major refactors, deleting multiple files, or modifying database schemas, you MUST run the `backup` skill.
- **Criteria:** If a task involves changing more than 3 files or modifying the `.env` configuration, trigger the backup automatically and notify me.

## Project Overview

Price aggregation and affiliate data pipeline for dator.se (Swedish price comparison site). Collects product and price data from multiple retailers and affiliate feeds, normalizes it, validates it, and publishes a stable data layer for WordPress consumption.

## Commands

```bash
# Setup
npm install
npm run migrate                   # Run all pending DB migrations
npm run db:add-partitions         # Create MySQL partitions for price_history
npm run db:smoke                  # Smoke test DB connectivity

# Running
npm start                         # Start production scheduler
npm run dev                       # Start scheduler with --watch
npm run admin                     # Start admin panel (port 3001)
npm run admin:dev                 # Admin panel with --watch

# Manual source triggering
npm run run:prisjakt              # Fetch all pages
npm run run:prisjakt:smoke        # 1 page, 5 items (cheap sanity check)
node lib/run-source.js <source_id> --pageLimit 2 --itemLimit 20 --dryRun

# Testing
npm test                          # Unit tests only (jest)
npm run test:integration          # DB integration + E2E tests
npm run test:e2e                  # Prisjakt scraper E2E only
npm run test:watch                # Watch mode
npm run lint                      # ESLint
npm run test:full                 # lint + unit tests

# Production (PM2)
pm2 start ecosystem.config.js    # Start scheduler + admin as managed processes
pm2 logs datorsc-scraper
```

## Architecture: Four-Layer Pipeline

Described in detail in `SCRAPER_ARCHITECTURE.md`.

1. **Ingest** — Scrapers (`scrapers/`) and feed consumers (`feeds/`) collect raw observations, store everything in `dsc_product_sources` as raw evidence. Proxy tier managed in `lib/proxy.js` (Scrape.do for standard sites, Zyte API for anti-bot).

2. **Resolve** — `lib/resolver.js` maps source observations → canonical products via EAN (exact match) or source+external_id (stable reference). Populates `matched_product_id` and `match_status` on `dsc_product_sources`.

3. **Publish** — SQL views (`dsc_view_live_offers`, `dsc_view_best_price`, etc.) expose only resolved, canonical data. WordPress reads from views only.

4. **Consume** — WordPress REST API integration (not yet implemented).

## Data Flow

```
sources.json → Scheduler (lib/scheduler.js)
                    ↓
            Runner (lib/runner.js)
                    ↓
        Scraper/Feed → Proxy → HTML/JSON
                    ↓
      Validator (lib/validate.js, Zod)
                    ↓
        DB upsert (lib/db.js, transactional)
    ┌───────────┬──────────────┬───────────┐
    ↓           ↓              ↓           ↓
dsc_products dsc_prices  dsc_price_    dsc_product_
(EAN dedup)  (current)   history       sources (raw)
                    ↓
        Resolver (lib/resolver.js)
                    ↓
         Published SQL views
                    ↓
              WordPress
```

## Key Modules

| File | Role |
|------|------|
| `lib/scheduler.js` | Entry point; cron-based orchestration from `config/sources.json` |
| `lib/runner.js` | Per-source execution: fetch → validate → upsert → log |
| `lib/validate.js` | Zod schema validation; classifies records as valid/unresolved/invalid |
| `lib/db.js` | MySQL pool, transactional upserts, price sanity checks |
| `lib/resolver.js` | Source observation → canonical product matching |
| `lib/proxy.js` | Proxy service routing with hard budget caps |
| `lib/parse.js` | Cheerio HTML parsing, price extraction, EAN/JSON-LD detection |
| `lib/logger.js` | Winston + daily rotation; use `logger.child({ source })` for source-scoped logs |
| `admin/server.js` | Express admin panel (Basic Auth via `ADMIN_SECRET_KEY`) |

## Scraper Interface

Each scraper in `scrapers/` and feed in `feeds/` exports a `run(sourceConfig)` function returning an array of validated product records. `sourceConfig` comes from `config/sources.json`.

## Database

- MySQL 8.0+ required
- 11 migrations in `migrations/` — always run `npm run migrate` after pulling
- `dsc_price_history` is partitioned by year; add partitions annually with `npm run db:add-partitions`
- Schema reference: `datorsc_db_playbook.md`

## Environment

Copy `env.example` to `.env`. Key variables:
- `DB_*` — MySQL connection
- `SCRAPE_DO_TOKEN` / `ZYTE_API_KEY` — proxy credentials (budget caps also configurable)
- `AWIN_API_KEY` / `ADTRACTION_API_KEY` — affiliate feed credentials
- `ADMIN_SECRET_KEY` — HTTP Basic Auth for admin panel
- `ADMIN_PORT` — defaults to 3001

## Current Status

- **Ingest:** Prisjakt + Elgiganten live; Komplett/Inet/Webhallen built but not fully validated against resolver
- **Resolve:** Live (EAN path + external_id path)
- **Publish:** 5 SQL views created; not yet consumed by WordPress
- **Consume:** WordPress integration not started

Known constraints: many retailer pages lack EAN data so the resolver falls back to external_id matching; scheduler uses in-process cron (no durable job leases for multi-process deployments).
