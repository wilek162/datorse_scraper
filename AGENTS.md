# Repository Guidelines

## Project Structure & Module Organization
The project implements a four-layer data pipeline for price aggregation:
- **Ingest**: `scrapers/` (retailer HTML scrapers) and `feeds/` (affiliate CSV/JSON consumers) fetch raw data.
- **Resolve**: `lib/resolver.js` maps raw observations to canonical products using EAN or stable external IDs.
- **Publish**: SQL views in `migrations/008_published_views.sql` expose stable data for WordPress.
- **Admin**: `admin/` contains an Express server for monitoring and manual source triggering.

Core utilities reside in `lib/`: `db.js` (MySQL pool/transactions), `proxy.js` (routed requests), and `validate.js` (Zod schemas).

## Build, Test, and Development Commands
- **Setup**: `npm install`
- **Database**: `npm run migrate` (runs pending migrations), `npm run db:smoke` (connectivity check)
- **Development**: `npm run dev` (scheduler with watch mode), `npm run admin:dev` (admin UI with watch mode)
- **Manual Run**: `node lib/run-source.js <source_id>` or `npm run run:prisjakt:smoke`
- **Quality**: `npm run lint` (ESLint), `npm run test:full` (lint + unit tests)

## Coding Style & Naming Conventions
- **Strict Mode**: Every file MUST start with `"use strict";`.
- **Module System**: Use CommonJS (`require`/`module.exports`).
- **Validation**: Always use `zod` for validating data from external sources or config files.
- **Logging**: Use `lib/logger.js` (Winston); avoid `console.log` in core logic. Use `logger.child({ source })` within scrapers.
- **Rules**: ESLint enforces `no-var`, `prefer-const`, and `eqeqeq` (always).

## Testing Guidelines
- **Framework**: Jest.
- **Execution**: `npm test` for unit tests; `npm run test:integration` for DB and E2E tests.
- **Mocks**: Use `nock` for intercepting external HTTP calls in scraper tests.
- **Location**: All tests are located in the `tests/` directory.

## Commit & Pull Request Guidelines
- **Commit Style**: Use descriptive prefixes like `feat:`, `fix:`, or `update`.
- **Atomic Commits**: Group related changes (e.g., `update scrapers for safe batch upsert`).
- **Pre-flight**: Run `npm run test:full` before submitting changes.
