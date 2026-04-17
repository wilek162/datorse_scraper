# Admin UI & Scraper System Revision — Design Spec
**Date:** 2026-04-17  
**Stack:** Node.js, Express, EJS, HTMX (no build step)  
**Scope:** Bug fixes + data truthfulness + structural cleanup across the admin panel  

---

## Overview

Three tracks of work across `admin/` routes, views, and `lib/source-controls.js`:

1. **Bug fixes** — broken log filter, null crash, misleading config validator, NaN-prone run-options parsing
2. **Data truthfulness** — mislabelled stats, broken match-rate formula, raw DB column headers
3. **Structural cleanup** — consolidate duplicated parsing logic, strengthen config validation

No tech-stack changes. EJS + HTMX stays as-is.

---

## Track 1 — Bug Fixes

### 1.1 Log status filter (`admin/views/logs.ejs`)
**Problem:** Hard-coded status list is `['ok', 'partial', 'error', 'running']`. The runner (`lib/runner.js`) only ever writes `'ok'`, `'partial'`, or `'failed'` as final statuses. Selecting `'error'` always returns zero results; `'failed'` is unreachable from the UI.  
**Fix:** Change the hard-coded list to `['ok', 'partial', 'failed']`.

### 1.2 Analytics null crash (`admin/views/analytics.ejs`)
**Problem:** `stats.avgOffersPerProduct` is the result of `AVG()` on a subquery. MySQL returns `null` when there are no rows. The template calls `.toFixed(1)` directly on it — this throws a TypeError on an empty DB.  
**Fix:** Guard with `stats.avgOffersPerProduct != null ? Number(stats.avgOffersPerProduct).toFixed(1) : '–'`.

### 1.3 Config page client-side JSON validator (`admin/views/config.ejs`)
**Problem:** The inline JS calls `JSON.parse(ta.value)` on raw textarea content. The server strips `// comments` before parsing (via `loadSources()`). Result: a valid commented config file shows a false parse error in the browser validator, while the server accepts it.  
**Fix:** Apply the same comment-strip regex (`/^\s*\/\/.*$/gm`) in the client validator before calling `JSON.parse`.

### 1.4 Run options NaN handling (`admin/routes/sources.js`)
**Problem:** `Math.max(1, parseInt(req.body.pageLimit, 10))` produces `NaN` for non-numeric input. The subsequent check `if (pageLimit && !Number.isNaN(pageLimit))` catches it only because `NaN` is falsy — accidental correctness. The same parsing logic is already well-tested in `lib/source-controls.js`.  
**Fix:** Replace the manual parsing block with `applySourceOverrides(source, overrides)` from `lib/source-controls.js` (see Section 3.1 for full detail).

---

## Track 2 — Data Truthfulness

### 2.1 Dashboard "Price rows" stat (`admin/routes/index.js`, `admin/views/dashboard.ejs`)
**Problem:** The count queries `SELECT COUNT(*) FROM dsc_prices` — this includes out-of-stock rows. "Price rows" implies active, useful data.  
**Fix:** Add `WHERE in_stock = 1` to the query. Rename the label to **"Active Offers"**.

### 2.2 Dashboard "Runs (24 h)" — no failure visibility (`admin/routes/index.js`, `admin/views/dashboard.ejs`)
**Problem:** A single count gives no signal about run health. Twenty runs could all be failures.  
**Fix:** Split into two stat cards: **"Runs (24 h)"** (total) and **"Failed (24 h)"** (`WHERE status = 'failed' AND started_at >= ...`).

### 2.3 Analytics match-rate formula (`admin/views/analytics.ejs`)
**Problem:** Denominator includes `skipped` records: `matched / (matched + unmatched + ambiguous + skipped)`. Skipped records are intentionally excluded from resolution and should not penalise the rate.  
**Fix:** Denominator becomes `matched + unmatched + ambiguous`.

### 2.4 Analytics "Avg Offers/Product" label clarification (`admin/views/analytics.ejs`)
**Problem:** The underlying query counts only in-stock prices (`WHERE in_stock = 1`), but the label omits this.  
**Fix:** Rename label to **"Avg In-Stock Offers/Product"**.

### 2.5 Health page raw column rendering (`admin/views/health.ejs`)
**Problem:** The source-health view table and best-prices table both iterate `Object.keys/Object.values` — DB column names become headers, values are raw. No formatting, no links, no badges.  
**Fix:** Replace generic iteration with structured table templates. Source-health table: human-readable column headers, `timeAgo` for date columns, status badges. Best-prices table: formatted SEK prices, `timeAgo` for dates, link `product_id` → `/data/product/:id`.  
**Note:** Column set must be read from the actual view schema at design time to hardcode correct names. If the view doesn't exist (graceful-degrade path already in health.js), the hint message continues to show.

---

## Track 3 — Structural Cleanup

### 3.1 Consolidate admin run-endpoint parsing (`admin/routes/sources.js`)
**Problem:** The `/sources/:id/run` handler duplicates `parsePositiveInt` / `applySourceOverrides` from `lib/source-controls.js` with manual `parseInt + Math.max + NaN` logic.  
**Fix:**
1. Build an `overrides` object from `req.body`: `{ pageLimit, itemLimit, dryRun }` as raw values.
2. Call `applySourceOverrides(source, overrides)` — this returns an effective config with validated, coerced values using the canonical `parsePositiveInt`.
3. Read `effectiveConfig.pageLimit`, `effectiveConfig.itemLimit`, `effectiveConfig.dryRun` to build `extraArgs` for `execFile`.  
This makes the admin endpoint and the CLI (`lib/run-source.js`) use identical validation paths.

### 3.2 Strengthen config-save validation (`admin/routes/config.js`)
**Problem:** Only validates that each source has a string `id`. A malformed entry (e.g. `enabled: "yes"`, missing `module`) passes silently and would break the scheduler on next tick.  
**Fix:** After the `id` check, validate each entry for:
- `enabled` is a boolean
- `schedule` is a non-empty string
- `module` is a non-empty string  
Return a descriptive error message naming the offending source `id` and field.

---

## What Is Explicitly Out of Scope

- No tech-stack changes (EJS, HTMX, Express stay as-is)
- No new routes or pages
- No HTMX CDN → local vendoring
- No changes to scraper logic (`lib/runner.js`, `lib/validate.js`, `lib/resolver.js`, etc.)
- No changes to `lib/source-controls.js` itself — it is correct; the admin route just needs to use it
- No changes to unrelated views (`log-detail.ejs`, `data.ejs`, `data-product.ejs`)

---

## Files Changed

| File | Track | Change |
|------|-------|--------|
| `admin/views/logs.ejs` | Bug | Status filter: `'error'` → `'failed'`, remove `'running'` |
| `admin/views/analytics.ejs` | Bug + Truthfulness | Null guard on `avgOffersPerProduct`; fix match-rate denominator; fix label |
| `admin/views/config.ejs` | Bug | Comment-strip in client-side validator |
| `admin/routes/sources.js` | Bug + Structural | Replace manual parsing with `applySourceOverrides` |
| `admin/routes/index.js` | Truthfulness | Add `WHERE in_stock = 1`; add failed-runs count |
| `admin/views/dashboard.ejs` | Truthfulness | Rename "Price rows" → "Active Offers"; add "Failed (24 h)" card |
| `admin/routes/config.js` | Structural | Validate `enabled`, `schedule`, `module` fields on save |
| `admin/views/health.ejs` | Truthfulness | Replace raw column iteration with structured templates |
