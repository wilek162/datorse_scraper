# Datorse Scraper — System Assessment & Fix Plan

> Generated: 2026-04-16  
> Scope: Full system audit — admin panel, scrapers, resolver, DB schema, tests  
> Backup: `/home/wille/backups/datorse_scraper_2026-04-16_164335.tar.gz`

---

## Table of Contents

1. [System Architecture Assessment](#1-system-architecture-assessment)
2. [Admin Panel Binding Analysis](#2-admin-panel-binding-analysis)
3. [Current System Status](#3-current-system-status)
4. [Confirmed Bugs](#4-confirmed-bugs)
5. [Improvement Findings](#5-improvement-findings)
6. [Fix Plan — Prioritized](#6-fix-plan--prioritized)
7. [Database State & Cleanup SQL](#7-database-state--cleanup-sql)
8. [Verification Checklist](#8-verification-checklist)

---

## 1. System Architecture Assessment

The pipeline follows a clean four-layer design:

```
Ingest  →  Resolve  →  Publish  →  Consume
scrapers/  resolver.js  008_views  WordPress (not started)
feeds/
```

### Layer Status

| Layer | Status | Notes |
|-------|--------|-------|
| **Ingest** — scrapers | ⚠️ Partially working | Elgiganten works but has reliability issues; Prisjakt works |
| **Resolve** — `lib/resolver.js` | ✅ Working | EAN path + external_id path both live |
| **Publish** — SQL views | ✅ Working | 5 views in migration 008 |
| **Admin** — `admin/` | ✅ Well-architected | 2 bugs confirmed (see below) |
| **Consume** — WordPress | ❌ Not started | Out of scope for this plan |
| **Scheduler** | ⚠️ Exists but not auto-triggered | `scheduler.js` present but not managed by systemd/pm2 |

### Key Files

| File | Role |
|------|------|
| `lib/runner.js` | Orchestrates runs, flush mechanism, status logic |
| `lib/proxy.js` | Wraps Zyte API + Scrape.do; rate limiting, budget caps |
| `lib/resolver.js` | Resolves source rows to canonical products |
| `lib/validate.js` | Zod schemas for records |
| `lib/db.js` | MySQL pool, all DB operations |
| `scrapers/elgiganten.js` | Akamai-protected site via Zyte browserHtml + AI |
| `scrapers/prisjakt.js` | Scrape.do + schema.org JSON-LD extraction |
| `config/sources.json` | Source configuration (read at runtime, no restart needed) |
| `admin/server.js` | Express + EJS admin panel |
| `admin/lib/sources.js` | `loadSources()` — reads `sources.json` at request time |
| `migrations/` | 011 migrations applied; sequential SQL files |

---

## 2. Admin Panel Binding Analysis

### Architecture Resilience: ✅ Already Well-Designed

The admin panel is intentionally decoupled from hardcoded source lists:

- **`loadSources()`** (`admin/lib/sources.js`) reads `config/sources.json` on every request — adding or removing a source in JSON is immediately reflected in the admin UI with zero code changes.
- **Sources page** (`admin/routes/sources.js`) joins runtime config with live DB state (`dsc_source_flags` + `dsc_scrape_log`) dynamically.
- **Config editor** (`admin/routes/config.js`) allows editing `sources.json` in-browser, with JSON validation and comment stripping.
- **Health page** (`admin/routes/health.js`) queries `dsc_view_source_health` SQL view — new sources appear automatically as they produce run log entries.
- **Manual triggers** pass source IDs from config, not hardcoded strings.
- **HTMX row-swap** on toggle/run keeps UI reactive without full page reloads.

### Confirmed Admin Panel Bug

The health page uses `status IN ('error', 'partial')` but the DB enum is `('running','ok','partial','failed')` — `'error'` never matches. See Bug 2 below.

---

## 3. Current System Status

### DB Run Log Summary (as of 2026-04-16)

| Source | Last Status | Total Runs | ok | partial | failed |
|--------|-------------|------------|----|---------|--------|
| elgiganten | ok (96 records, 12 min run) | 12 | 2 | 9 | 1 |
| prisjakt | ok (669 records, 14 min run) | 10 | 6 | 4 | 0 |

### Elgiganten Timeline Analysis

```
12:36:41  failed   "Zyte Account Suspended (403): Your account has been suspended..."
12:40:00  partial  "No records fetched"  ← 8 seconds → non-fatal error broke the loop
12:12:29  partial  "No records fetched"  ← same pattern
(earlier partials follow same 8-second pattern — Zyte errors silently breaking loop)
16:00:31  ok       0 records (8 sec)    ← dryRun triggered from admin panel
16:00:45  partial  "No records fetched"  ← 8 seconds
16:05:37  partial  "No records fetched"  ← 8 seconds
16:08:31  ok       96 records (12 min)  ← first real successful run ✅
```

**Root cause chain**: Zyte account suspension → subsequent Zyte errors (non-fatal) break the category page loop silently → `recordsFound=0` → `partial/No records fetched`. The actual error reason is never written to `dsc_scrape_log.error_message`.

### Products Database State

```
Total products: ~771
dsc_prices:     live price rows across retailers
Leaked test data: 2 products (id 695, 700) — "Prisjakt E2E Invalid Product"
  └─ source_id: prisjakt_e2e_1776340929754_2yfmzf
  └─ source_id: prisjakt_e2e_1776341057024_7xqasn
  └─ ean: NULL, external_id: 1002 (test fixture)
  └─ 2 orphan rows in dsc_prices referencing them
```

---

## 4. Confirmed Bugs

### Bug 1 — `_guardBudget` throws plain `Error`, not `ProxyFatalError` 🔴 P0

**File**: `lib/proxy.js` — `_guardBudget()` function (~line 218)

**What happens**:
```js
// CURRENT (broken):
throw new Error(`${label} budget cap reached (${used}/${cap}). Halting requests.`);

// In elgiganten.js catch block:
if (err instanceof ProxyFatalError) throw err;  // ← plain Error, NOT re-thrown
break;  // silently breaks loop → 0 records → partial/No records fetched
```

**Impact**: When the in-memory Zyte credit counter reaches the budget cap, the scraper silently breaks and returns 0 records. The run is logged as `partial/No records fetched` instead of `failed` with the actual budget reason. Operators cannot distinguish "Zyte is broken" from "Zyte is too expensive" from this status.

**Fix**: Change `throw new Error(...)` → `throw new ProxyFatalError(...)` in `_guardBudget`.

`ProxyFatalError` is defined in the same file — no imports needed.

---

### Bug 2 — Health route queries non-existent status `'error'` 🔴 P0

**File**: `admin/routes/health.js` — line ~43

**What happens**:
```sql
-- CURRENT (broken):
WHERE status IN ('error', 'partial')

-- DB enum: ('running','ok','partial','failed') — 'error' does not exist
-- Result: 'failed' runs are NEVER shown in Recent Errors panel
```

**Impact**: The Zyte account suspension at 12:36:41 (status=`failed`) is invisible in the admin panel. Operators see only `partial` runs, missing the root cause. This makes debugging scraper outages extremely difficult.

**Fix**: Change `'error'` → `'failed'` in the health route query.

---

### Bug 3 — E2E tests run against production database 🔴 P0/P1

**File**: `tests/prisjakt-e2e.test.js`

**What happens**: `require("dotenv").config()` loads `.env` which sets `DB_NAME=datorsc` (production). Test creates "Prisjakt E2E Invalid Product" and "Prisjakt E2E Valid Product" rows. Cleanup runs in `afterEach`, but if the test process crashes, is killed, or Jest fails before `afterEach` completes, test data leaks to production.

**Evidence**: Products id 695 and 700 in production DB are E2E test fixtures. They appear in the admin Data page as "Prisjakt E2E Invalid Product" with no brand/EAN — confusing and invalid data.

**Caveats with current cleanup**:
- `cleanupRecords` queries `matched_product_id` before deleting `dsc_product_sources` rows (correct order)
- But if `activeContext` is null (crash before assignment) the `afterEach` cleanup is skipped entirely
- No `afterAll` sweep exists for stale `prisjakt_e2e_*` artifacts

**Fixes**: See P0-3 (immediate cleanup SQL) and P1-1/P1-2 (prevention).

---

## 5. Improvement Findings

### Finding 4 — Non-fatal category page errors produce misleading `error_message` 🟡 P1

When `proxy.fetch()` throws a non-fatal error (HTTP 5xx, temporary block, etc.) in `scrapers/elgiganten.js`, the scraper logs the error and `break`s the loop. The runner then sees `recordsFound=0` and writes `error_message='No records fetched'` — losing the actual failure reason.

**Improvement**: Expose `ctx.lastError` on the context object. Scrapers set it on non-fatal errors. Runner incorporates it into `error_message` when `recordsFound=0`.

---

### Finding 5 — `dry_run` runs not distinguishable in DB 🟡 P1

The run at `16:00:31` with `status='ok'` and `0 records` was a dryRun triggered from the admin panel. The `dsc_scrape_log` table has no `dry_run` column, making it indistinguishable from a real 0-record success. This pollutes the `dsc_view_source_health` "last_run_status=ok" display.

**Improvement**: Add `dry_run TINYINT(1) NOT NULL DEFAULT 0` column to `dsc_scrape_log` via a new migration.

---

### Finding 6 — Admin panel cannot show run error trends 🟢 P2

The health page shows only the latest run per source. A failed Zyte account → multiple partial runs pattern is invisible unless you query the DB directly. An error-trend sparkline (last 5 run statuses) per source would immediately surface recurring failures.

---

### Finding 7 — No per-source run history page 🟢 P2

There is no `/health/source/:id` route. Diagnosing elgiganten's failure pattern required direct SQL queries. A detail page with the last 20 run log entries per source (with `error_message`, `proxy_credits_used`, `pages_fetched`, `dry_run`) would be valuable.

---

## 6. Fix Plan — Prioritized

### P0 — Fix Immediately (confirmed broken, safe changes)

---

#### P0-1 · Fix `_guardBudget` to throw `ProxyFatalError`

**File**: `lib/proxy.js`

```js
// BEFORE (~line 223):
throw new Error(`${label} budget cap reached (${used}/${cap}). Halting requests.`);

// AFTER:
throw new ProxyFatalError(`${label} budget cap reached (${used}/${cap}). Halting requests.`);
```

- `ProxyFatalError` is defined on line 155 of the same file — no import needed.
- Risk: **None**. The class exists, the catch sites in scrapers already re-throw `ProxyFatalError`, the runner outer catch sets `status='failed'` with `err.message`.
- Verify: Set `PROXY_BUDGET_CAP_ZYTE=0` in env, run elgiganten → `dsc_scrape_log` should have `status='failed'` and `error_message='Zyte budget cap reached ...'`.

---

#### P0-2 · Fix health route status query

**File**: `admin/routes/health.js`

```sql
-- BEFORE (~line 43):
WHERE status IN ('error', 'partial')

-- AFTER:
WHERE status IN ('failed', 'partial')
```

- Risk: **None**. `'failed'` is a valid enum value. This only adds previously missing rows.
- Verify: Navigate to `/health` → the Zyte account suspension run (2026-04-16 12:36) should now appear in Recent Errors.

---

#### P0-3 · One-time production DB cleanup for leaked test data

**Run in a transaction against `datorsc`:**

```sql
START TRANSACTION;

-- Step 1: Verify what we're deleting
SELECT p.id, p.name, p.source_id FROM dsc_products p WHERE p.id IN (695, 700);

-- Step 2: Delete prices referencing test products
DELETE FROM dsc_prices WHERE product_id IN (695, 700);

-- Step 3: Delete product_sources rows
DELETE FROM dsc_product_sources WHERE source_id LIKE 'prisjakt_e2e_%';

-- Step 4: Delete scrape_log rows
DELETE FROM dsc_scrape_log WHERE source_id LIKE 'prisjakt_e2e_%';

-- Step 5: Delete the orphan products
DELETE FROM dsc_products WHERE id IN (695, 700);

-- Step 6: Verify
SELECT COUNT(*) AS should_be_0 FROM dsc_products WHERE id IN (695, 700);
SELECT COUNT(*) AS should_be_0 FROM dsc_product_sources WHERE source_id LIKE 'prisjakt_e2e_%';

COMMIT; -- Only if both counts are 0
```

- Risk: **Medium** (production write). Use a transaction. Verify counts before committing.
- Caveat: `dsc_price_history WHERE source_id LIKE 'prisjakt_e2e_%'` — check if column exists in price_history. If not, skip that step (it was 0 rows confirmed above).

---

### P1 — MVP Stability (needed before next production incident)

---

#### P1-1 · Guard E2E tests against production DB

**File**: `tests/prisjakt-e2e.test.js` — add after line 3 (`require("dotenv").config()`)

```js
const PRODUCTION_DB = "datorsc";
if (process.env.DB_NAME === PRODUCTION_DB) {
  throw new Error(
    `E2E tests must not run against production DB '${PRODUCTION_DB}'. ` +
    `Set DB_NAME to a test database or unset DB_NAME to skip.`
  );
}
```

- This throws at module load time — Jest fails immediately with a clear message.
- Risk: **None** to production. Only blocks test execution.
- Verify: `DB_NAME=datorsc npm test tests/prisjakt-e2e.test.js` → error message shown. Run with `DB_NAME=datorsc_test` → proceeds (or skips if no DB config).

---

#### P1-2 · Add `afterAll` sweep for stale E2E artifacts

**File**: `tests/prisjakt-e2e.test.js` — add after `afterEach` block

```js
afterAll(async () => {
  // Sweep any artifacts that leaked if activeContext was never set
  // (e.g. test crashed before activeContext = { sourceId, ean } assignment)
  try {
    const staleSources = await db.query(
      "SELECT DISTINCT source_id FROM dsc_product_sources WHERE source_id LIKE 'prisjakt_e2e_%'"
    );
    for (const { source_id } of staleSources) {
      await cleanupRecords(db, { sourceId: source_id, ean: null });
    }
  } catch (_) {}
  await db.closePool();
});
```

- Risk: **None**. Only deletes `prisjakt_e2e_*` rows, only in the test environment (guarded by P1-1).

---

#### P1-3 · Surface last non-fatal error in scrape log

**File 1**: `lib/runner.js` — add `lastError: null` to `ctx` object

```js
// In runSource(), where ctx is constructed (~line 188):
const ctx = {
  logId,
  lastError: null,   // scrapers set this on non-fatal caught errors
  flush: async (batch) => { ... },
};
```

Then in status determination (~line 273):
```js
} else if (recordsFound === 0) {
  status = "partial";
  errorMessage = ctx.lastError
    ? `No records fetched: ${ctx.lastError}`
    : "No records fetched";
```

**File 2**: `scrapers/elgiganten.js` — set `ctx.lastError` before breaking on non-fatal category error

```js
// In the category page catch block (~line 143):
} catch (err) {
  log.error("Failed to fetch category page", { url: pageUrl, err: err.message });
  if (err instanceof ProxyFatalError) throw err;
  if (ctx) ctx.lastError = err.message;   // ← add this line
  break;
}
```

- Risk: **Low**. `ctx` is runner-owned. Scrapers that don't set `lastError` are unaffected.
- Verify: Point elgiganten `startUrls` at a bad URL in a test run → `dsc_scrape_log.error_message` should contain the actual HTTP error, not just "No records fetched".

---

#### P1-4 · Add `dry_run` column to `dsc_scrape_log`

**File 1**: Create `migrations/012_scrape_log_dry_run.sql`
```sql
ALTER TABLE dsc_scrape_log
  ADD COLUMN dry_run TINYINT(1) NOT NULL DEFAULT 0
  AFTER pages_fetched;
```

**File 2**: `lib/db.js` — update `finishScrapeLog` to accept and write `dryRun`
- Add `dryRun = false` to destructured params
- Add `dry_run = ?` to the `SET` clause of the UPDATE
- Add `dryRun ? 1 : 0` to values array

**File 3**: `lib/runner.js` — pass `dryRun` to `finishScrapeLog`
```js
await db.finishScrapeLog(logId, {
  ...existingFields,
  dryRun: Boolean(sourceConfig.dryRun),
});
```

- Risk: **Low**. Migration is additive with `DEFAULT 0`. All historical rows read as `dry_run=0`. Run `npm run migrate` then `npm run db:smoke`.
- Verify: Trigger dryRun from admin panel → `SELECT dry_run FROM dsc_scrape_log ORDER BY id DESC LIMIT 1` should return `1`.

---

### P2 — Admin Panel Enhancements (nice-to-have)

---

#### P2-1 · Show run status trend per source in health page

**File**: `admin/routes/health.js` — add a second query for last 5 runs per source

```sql
SELECT source_id, status, error_message, started_at,
       ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY id DESC) AS rn
FROM dsc_scrape_log
HAVING rn <= 5
ORDER BY source_id, id DESC
```

Pass as `recentRunsBySource` to the template. Render a status history per source row (✅/⚠️/❌ badges).

---

#### P2-2 · Per-source run history detail route

Add `/health/source/:id` route showing last 20 run log entries with `error_message`, `pages_fetched`, `proxy_credits_used`, `dry_run`. Read-only, no schema change. Gives operators a full audit trail without SQL access.

---

#### P2-3 · Update `dsc_view_source_health` to include `dry_run`

After P1-4 lands, update `migrations/008_published_views.sql` (`CREATE OR REPLACE VIEW`) to include the `dry_run` flag from the latest log row, so dryRun runs can be visually distinguished from real failures in the health table.

---

## 7. Database State & Cleanup SQL

### Current Table Summary

| Table | Row Count (approx) |
|-------|-------------------|
| `dsc_products` | ~771 (including 2 test leaks) |
| `dsc_prices` | live price rows |
| `dsc_price_history` | partitioned; history rows |
| `dsc_product_sources` | audit rows from all runs |
| `dsc_scrape_log` | 22 rows confirmed |
| `dsc_source_flags` | pause/resume flags |

### Schema Notes

- `dsc_products.ean` is nullable (migration 007) — required for external_id resolution path
- `dsc_products` has unique key `uq_source_external (source_id, external_id)` — correct for resolver
- `dsc_scrape_log.status` enum: `('running','ok','partial','failed')` — **no 'error' value exists**
- `dsc_price_history` is partitioned (migration 006)
- Views: `dsc_view_source_health`, `dsc_view_best_price`, `dsc_view_product_summary`, `dsc_view_live_offers`, `dsc_view_recent_price_history`

### Immediate Cleanup (run P0-3 SQL above)

Products to delete: id 695, 700 ("Prisjakt E2E Invalid Product")  
Source rows to delete: `source_id LIKE 'prisjakt_e2e_%'` (2 source IDs confirmed)  
Prices to delete: 2 rows in `dsc_prices` referencing products 695/700

---

## 8. Verification Checklist

Run after implementing each fix:

```bash
# After P0-1 (budget cap fix):
PROXY_BUDGET_CAP_ZYTE=0 node lib/run-source.js elgiganten 2>&1 | grep -E 'failed|budget'
mysql -udsc_user -pdatorsc_pass datorsc -e "SELECT status, error_message FROM dsc_scrape_log ORDER BY id DESC LIMIT 1;"
# Expected: status=failed, error_message contains 'budget cap reached'

# After P0-2 (health route fix):
# Navigate to /health in admin panel → Zyte suspension run now visible in Recent Errors

# After P0-3 (cleanup SQL):
mysql -udsc_user -pdatorsc_pass datorsc -e "SELECT COUNT(*) FROM dsc_products WHERE id IN (695,700);"
# Expected: 0

# After P1-1 (E2E guard):
DB_NAME=datorsc npx jest tests/prisjakt-e2e.test.js 2>&1 | grep -i 'production'
# Expected: error about production DB

# After P1-4 (dry_run column):
npm run migrate
node lib/run-source.js elgiganten --dryRun
mysql -udsc_user -pdatorsc_pass datorsc -e "SELECT dry_run, status FROM dsc_scrape_log ORDER BY id DESC LIMIT 1;"
# Expected: dry_run=1, status=ok

# Full test suite:
npm run test:full
```

---

## Execution Order

| # | Priority | Task | Files | Risk |
|---|----------|------|-------|------|
| 1 | **P0** | Fix `_guardBudget` → `ProxyFatalError` | `lib/proxy.js` | None |
| 2 | **P0** | Fix health route `'error'` → `'failed'` | `admin/routes/health.js` | None |
| 3 | **P0** | Run cleanup SQL on prod DB | *(one-time SQL)* | Medium |
| 4 | **P1** | Add E2E DB guard | `tests/prisjakt-e2e.test.js` | None |
| 5 | **P1** | Add `afterAll` E2E sweep | `tests/prisjakt-e2e.test.js` | None |
| 6 | **P1** | `ctx.lastError` error surfacing | `lib/runner.js`, `scrapers/elgiganten.js` | Low |
| 7 | **P1** | `dry_run` column + migration | `migrations/012_*.sql`, `lib/db.js`, `lib/runner.js` | Low |
| 8 | **P2** | Run trend in health page | `admin/routes/health.js` + template | Low |
| 9 | **P2** | Per-source detail route | `admin/routes/health.js` + new template | Low |
| 10 | **P2** | `dry_run` in `dsc_view_source_health` | `migrations/008_*.sql` | Low |

Run `npm run test:full` before committing any change.
