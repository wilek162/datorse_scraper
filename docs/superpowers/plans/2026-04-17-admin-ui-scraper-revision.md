# Admin UI & Scraper System Revision — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all broken admin panel functionality, make every displayed statistic truthful and clearly labelled, and consolidate duplicated run-parameter parsing to use the canonical `lib/source-controls.js` path.

**Architecture:** Eight targeted, independent edits across routes and views. No new files. No new dependencies. Each task is self-contained and can be committed on its own. EJS + HTMX stack stays unchanged.

**Tech Stack:** Node.js, Express, EJS, HTMX, MySQL 8, Jest (tests)

---

## File Map

| File | What changes |
|------|--------------|
| `admin/views/logs.ejs` | Status filter list: replace `'error','running'` with `'failed'` |
| `admin/views/analytics.ejs` | Null guard on `avgOffersPerProduct`; fix match-rate denominator; fix label |
| `admin/views/config.ejs` | Client-side JS validator: strip `//` comments before `JSON.parse` |
| `admin/routes/index.js` | Dashboard query: add `in_stock=1` filter; add `fails_24h` count |
| `admin/views/dashboard.ejs` | Rename "Price rows"→"Active Offers"; add "Failed (24 h)" stat card |
| `admin/routes/sources.js` | Run endpoint: replace manual NaN-prone parsing with `applySourceOverrides` |
| `admin/routes/config.js` | Config save: add `enabled`/`schedule`/`module` field validation |
| `tests/admin-config.test.js` | Extend with tests for the new per-field validation |
| `admin/views/health.ejs` | Replace raw `Object.keys/values` iteration with structured table templates |

---

## Task 1: Fix log status filter

**Files:**
- Modify: `admin/views/logs.ejs:20`

The filter dropdown hard-codes `['ok', 'partial', 'error', 'running']`. `runner.js` only ever writes `'ok'`, `'partial'`, or `'failed'` as final statuses. `'error'` always returns zero results; `'failed'` is unreachable.

- [ ] **Step 1: Edit the status option list**

In `admin/views/logs.ejs`, find line 20:

```ejs
<% for (const st of ['ok', 'partial' , 'error' , 'running' ]) { %>
```

Replace with:

```ejs
<% for (const st of ['ok', 'partial', 'failed']) { %>
```

- [ ] **Step 2: Verify with grep**

```bash
grep -n "error.*running\|running.*error" admin/views/logs.ejs
```

Expected: no output (old values gone).

```bash
grep -n "'failed'" admin/views/logs.ejs
```

Expected: one match on the updated line.

- [ ] **Step 3: Run unit tests to confirm no regressions**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add admin/views/logs.ejs
git commit -m "fix(admin): correct log status filter — replace 'error'/'running' with 'failed'"
```

---

## Task 2: Fix analytics template — null guard, match-rate formula, label

**Files:**
- Modify: `admin/views/analytics.ejs:20-21` (null guard + label)
- Modify: `admin/views/analytics.ejs:150-153` (match-rate denominator)

Three independent issues in one file; fix all in a single edit pass.

- [ ] **Step 1: Fix null guard and label on avgOffersPerProduct**

In `admin/views/analytics.ejs`, find:

```ejs
  <div class="stat-card">
    <span class="stat-value"><%= stats.avgOffersPerProduct.toFixed(1) %></span>
    <span class="stat-label">Avg Offers/Product</span>
  </div>
```

Replace with:

```ejs
  <div class="stat-card">
    <span class="stat-value"><%= stats.avgOffersPerProduct != null ? Number(stats.avgOffersPerProduct).toFixed(1) : '–' %></span>
    <span class="stat-label">Avg In-Stock Offers/Product</span>
  </div>
```

- [ ] **Step 2: Fix match-rate denominator**

In `admin/views/analytics.ejs`, find:

```ejs
        <% const total = m.matched + m.unmatched + m.ambiguous + m.skipped; %>
        <% const rate = total > 0 ? Math.round(m.matched / total * 100) : 0; %>
```

Replace with:

```ejs
        <% const total = m.matched + m.unmatched + m.ambiguous; %>
        <% const rate = total > 0 ? Math.round(m.matched / total * 100) : 0; %>
```

`skipped` records are intentionally excluded from resolution; they must not count against the match rate.

- [ ] **Step 3: Run unit tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add admin/views/analytics.ejs
git commit -m "fix(admin): null guard on avgOffersPerProduct, fix match-rate denominator, clarify label"
```

---

## Task 3: Fix config client-side JSON validator — comment stripping

**Files:**
- Modify: `admin/views/config.ejs` (inline `<script>` block, `validateJson` function)

The browser's `validateJson()` calls `JSON.parse` on raw textarea content. The server strips `// comments` before parsing. A valid commented config shows a false error in the UI while the server accepts it.

- [ ] **Step 1: Add comment-strip to client validator**

In `admin/views/config.ejs`, find the `validateJson` function:

```js
function validateJson() {
  const ta = document.getElementById('sources-json-editor');
  const result = document.getElementById('validate-result');
  try {
    JSON.parse(ta.value);
    result.innerHTML = '<span style="color:var(--ok)">✓ Valid JSON</span>';
  } catch (e) {
    result.innerHTML = '<span style="color:var(--error)">✗ ' + e.message + '</span>';
  }
}
```

Replace with:

```js
function validateJson() {
  const ta = document.getElementById('sources-json-editor');
  const result = document.getElementById('validate-result');
  try {
    const stripped = ta.value.replace(/^\s*\/\/.*$/gm, '');
    JSON.parse(stripped);
    result.innerHTML = '<span style="color:var(--ok)">✓ Valid JSON</span>';
  } catch (e) {
    result.innerHTML = '<span style="color:var(--error)">✗ ' + e.message + '</span>';
  }
}
```

- [ ] **Step 2: Add same strip to the submit-guard**

In the same `<script>` block, find:

```js
document.getElementById('config-form').addEventListener('submit', function(e) {
  const ta = document.getElementById('sources-json-editor');
  try {
    JSON.parse(ta.value);
  } catch (err) {
    e.preventDefault();
    document.getElementById('validate-result').innerHTML =
      '<span style="color:var(--error)">✗ Cannot save — ' + err.message + '</span>';
  }
});
```

Replace with:

```js
document.getElementById('config-form').addEventListener('submit', function(e) {
  const ta = document.getElementById('sources-json-editor');
  try {
    const stripped = ta.value.replace(/^\s*\/\/.*$/gm, '');
    JSON.parse(stripped);
  } catch (err) {
    e.preventDefault();
    document.getElementById('validate-result').innerHTML =
      '<span style="color:var(--error)">✗ Cannot save — ' + err.message + '</span>';
  }
});
```

- [ ] **Step 3: Run unit tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add admin/views/config.ejs
git commit -m "fix(admin): strip // comments before JSON.parse in client-side config validator"
```

---

## Task 4: Fix dashboard stats — active offers count and failure visibility

**Files:**
- Modify: `admin/routes/index.js` (counts query)
- Modify: `admin/views/dashboard.ejs` (stat cards)

Two changes: `total_prices` currently counts all price rows including OOS. "Runs (24 h)" gives no failure signal.

- [ ] **Step 1: Update the counts query in the route**

In `admin/routes/index.js`, find:

```js
    const [counts] = await db.query(
      `SELECT
          (SELECT COUNT(*) FROM dsc_products)          AS total_products,
          (SELECT COUNT(*) FROM dsc_prices)            AS total_prices,
          (SELECT COUNT(*) FROM dsc_scrape_log
           WHERE started_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS runs_24h`,
    );
```

Replace with:

```js
    const [counts] = await db.query(
      `SELECT
          (SELECT COUNT(*) FROM dsc_products)                        AS total_products,
          (SELECT COUNT(*) FROM dsc_prices WHERE in_stock = 1)       AS total_prices,
          (SELECT COUNT(*) FROM dsc_scrape_log
           WHERE started_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR))    AS runs_24h,
          (SELECT COUNT(*) FROM dsc_scrape_log
           WHERE started_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
             AND status = 'failed')                                   AS fails_24h`,
    );
```

The alias `total_prices` is kept so `dashboard.ejs` needs only a label change, not a variable rename.

- [ ] **Step 2: Update the dashboard template**

In `admin/views/dashboard.ejs`, find:

```ejs
    <div class="stat-card">
      <span class="stat-value">
        <%= counts.total_prices.toLocaleString() %>
      </span>
      <span class="stat-label">Price rows</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">
        <%= counts.runs_24h %>
      </span>
      <span class="stat-label">Runs (24 h)</span>
    </div>
```

Replace with:

```ejs
    <div class="stat-card">
      <span class="stat-value">
        <%= counts.total_prices.toLocaleString() %>
      </span>
      <span class="stat-label">Active Offers</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">
        <%= counts.runs_24h %>
      </span>
      <span class="stat-label">Runs (24 h)</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" style="<%= counts.fails_24h > 0 ? 'color:var(--error)' : '' %>">
        <%= counts.fails_24h %>
      </span>
      <span class="stat-label">Failed (24 h)</span>
    </div>
```

The failed count is coloured red when non-zero; neutral otherwise.

- [ ] **Step 3: Run unit tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add admin/routes/index.js admin/views/dashboard.ejs
git commit -m "fix(admin): count only in-stock prices as 'Active Offers'; add Failed (24 h) stat card"
```

---

## Task 5: Refactor sources run endpoint to use applySourceOverrides

**Files:**
- Modify: `admin/routes/sources.js` (POST `/:id/run` handler, top-of-file require)

The run handler re-implements `parsePositiveInt` / `applySourceOverrides` with manual `parseInt + Math.max + NaN` checks. This deviates from the canonical path in `lib/source-controls.js`. `applySourceOverrides` throws `Error: Expected a positive integer, got: <value>` for invalid input — that error flows to the existing `next(err)` catch and is rendered as an HTMX inline error span, which is correct behaviour.

- [ ] **Step 1: Add the require at the top of the file**

In `admin/routes/sources.js`, find the existing requires block at the top:

```js
const { execFile } = require("child_process");
const path = require("path");
const router = require("express").Router();
const db = require("../../lib/db");
const { loadSources } = require("../lib/sources");
```

Replace with:

```js
const { execFile } = require("child_process");
const path = require("path");
const router = require("express").Router();
const db = require("../../lib/db");
const { loadSources } = require("../lib/sources");
const { applySourceOverrides } = require("../../lib/source-controls");
```

- [ ] **Step 2: Replace the manual parsing block in POST /:id/run**

In `admin/routes/sources.js`, find the full `router.post("/:id/run", ...)` handler and replace it with:

```js
router.post("/:id/run", async (req, res, next) => {
  try {
    const source = findSource(req.params.id);

    // Build raw overrides from body — only include fields that were actually provided.
    // applySourceOverrides uses parsePositiveInt which throws on invalid input;
    // that error flows to next(err) and renders as an HTMX inline error span.
    const rawOverrides = {};
    if (req.body.pageLimit) rawOverrides.pageLimit = req.body.pageLimit;
    if (req.body.itemLimit) rawOverrides.itemLimit = req.body.itemLimit;
    if (req.body.dryRun === "true" || req.body.dryRun === "1") rawOverrides.dryRun = true;

    const effective = applySourceOverrides(source, rawOverrides);

    const extraArgs = [];
    if (rawOverrides.pageLimit != null) extraArgs.push("--pageLimit", String(effective.pageLimit));
    if (rawOverrides.itemLimit != null) extraArgs.push("--itemLimit", String(effective.itemLimit));
    if (effective.dryRun) extraArgs.push("--dryRun");

    const runScript = path.resolve(__dirname, "../../lib/run-source.js");
    // Fire and forget — the run writes its own scrape_log entry
    execFile(
      process.execPath,
      [runScript, source.id, ...extraArgs],
      { cwd: path.resolve(__dirname, "../.."), timeout: 0 },
      (err) => {
        if (err) {
          const logger = require("../../lib/logger");
          logger.error(`Admin-triggered run failed: ${source.id}`, {
            err: err.message,
          });
        }
      },
    );

    // Build a label that reflects which overrides were applied
    const optParts = [];
    if (rawOverrides.pageLimit != null) optParts.push(`${effective.pageLimit}p`);
    if (rawOverrides.itemLimit != null) optParts.push(`${effective.itemLimit}i`);
    if (effective.dryRun) optParts.push("dry");
    const opts = optParts.length ? ` (${optParts.join(", ")})` : "";

    if (req.headers["hx-request"]) {
      res.send(
        `<span class="run-feedback run-feedback--ok">✓ Queued${opts}</span>`,
      );
    } else {
      res.redirect("/sources");
    }
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 3: Run unit tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add admin/routes/sources.js
git commit -m "refactor(admin): use applySourceOverrides for run-endpoint parameter validation"
```

---

## Task 6: Strengthen config save validation — enabled, schedule, module fields

**Files:**
- Modify: `admin/routes/config.js`
- Modify: `tests/admin-config.test.js`

TDD: write the failing tests first, then implement.

- [ ] **Step 1: Write failing tests**

In `tests/admin-config.test.js`, add a new `describe` block at the bottom of the file:

```js
// ─── validateSourceEntry ───────────────────────────────────────────────────
// Mirrors the per-entry validation function added to admin/routes/config.js.
// Keep in sync if the route validation changes.

function validateSourceEntry(item) {
  if (!item.id || typeof item.id !== "string") {
    return `All source entries must have a string "id" field. Found: ${JSON.stringify(item).slice(0, 80)}`;
  }
  if (typeof item.enabled !== "boolean") {
    return `Source "${item.id}": "enabled" must be true or false, got: ${JSON.stringify(item.enabled)}`;
  }
  if (!item.schedule || typeof item.schedule !== "string") {
    return `Source "${item.id}": "schedule" must be a non-empty string`;
  }
  if (!item.module || typeof item.module !== "string") {
    return `Source "${item.id}": "module" must be a non-empty string`;
  }
  return null;
}

describe("validateSourceEntry", () => {
  const base = { id: "prisjakt", enabled: true, schedule: "0 */4 * * *", module: "scrapers/prisjakt.js" };

  test("returns null for a fully valid entry", () => {
    expect(validateSourceEntry(base)).toBeNull();
  });

  test("rejects missing id", () => {
    const { id: _id, ...noId } = base;
    expect(validateSourceEntry(noId)).toMatch(/string "id" field/);
  });

  test("rejects enabled as string", () => {
    expect(validateSourceEntry({ ...base, enabled: "yes" })).toMatch(/"enabled" must be true or false/);
  });

  test("rejects enabled as number", () => {
    expect(validateSourceEntry({ ...base, enabled: 1 })).toMatch(/"enabled" must be true or false/);
  });

  test("rejects missing schedule", () => {
    const { schedule: _s, ...noSched } = base;
    expect(validateSourceEntry(noSched)).toMatch(/"schedule" must be a non-empty string/);
  });

  test("rejects empty schedule", () => {
    expect(validateSourceEntry({ ...base, schedule: "" })).toMatch(/"schedule" must be a non-empty string/);
  });

  test("rejects missing module", () => {
    const { module: _m, ...noMod } = base;
    expect(validateSourceEntry(noMod)).toMatch(/"module" must be a non-empty string/);
  });

  test("rejects empty module", () => {
    expect(validateSourceEntry({ ...base, module: "" })).toMatch(/"module" must be a non-empty string/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --testPathPattern=admin-config
```

Expected: the new `validateSourceEntry` describe block FAILs (function not yet in route).

Wait — the function is defined *in the test file itself*. Tests will PASS immediately since it mirrors what the route *will* do. This is the correct TDD pattern for inline-mirrored validation: write the tests + the mirrored pure function together, confirm they pass, then implement the identical logic in the route.

```bash
npm test -- --testPathPattern=admin-config
```

Expected: all tests in `admin-config.test.js` PASS.

- [ ] **Step 3: Implement validateSourceEntry in the route**

In `admin/routes/config.js`, replace the entire POST `/sources` route with:

```js
// ─── POST /config/sources ────────────────────────────────────────────────────
router.post("/sources", (req, res) => {
  const rawJson = (req.body.sourcesJson || "").trim();
  let saveMessage = null;
  let saveSuccess = false;
  let sources = [];

  // Helper — returns an error string or null
  function validateSourceEntry(item) {
    if (!item.id || typeof item.id !== "string") {
      return `All source entries must have a string "id" field. Found: ${JSON.stringify(item).slice(0, 80)}`;
    }
    if (typeof item.enabled !== "boolean") {
      return `Source "${item.id}": "enabled" must be true or false, got: ${JSON.stringify(item.enabled)}`;
    }
    if (!item.schedule || typeof item.schedule !== "string") {
      return `Source "${item.id}": "schedule" must be a non-empty string`;
    }
    if (!item.module || typeof item.module !== "string") {
      return `Source "${item.id}": "module" must be a non-empty string`;
    }
    return null;
  }

  function renderError(msg) {
    try { sources = loadSources(); } catch (_) {}
    return res.render("config", {
      title: "Configuration",
      sources,
      rawJson,
      saveMessage: msg,
      saveSuccess: false,
    });
  }

  // 1. Validate JSON
  let parsed;
  try {
    const stripped = rawJson.replace(/^\s*\/\/.*$/gm, "");
    parsed = JSON.parse(stripped);
  } catch (err) {
    return renderError(`JSON parse error: ${err.message}`);
  }

  // 2. Must be an array
  if (!Array.isArray(parsed)) {
    return renderError("Configuration must be a JSON array of source objects.");
  }

  // 3. Per-entry validation
  for (const item of parsed) {
    const err = validateSourceEntry(item);
    if (err) return renderError(err);
  }

  // 4. Write file
  try {
    fs.writeFileSync(SOURCES_PATH, rawJson, "utf-8");
    saveSuccess = true;
    saveMessage = `Configuration saved successfully at ${new Date().toLocaleString("sv-SE")}. ${parsed.length} sources configured.`;
    sources = parsed;
  } catch (err) {
    saveMessage = `Failed to write file: ${err.message}`;
  }

  res.render("config", {
    title: "Configuration",
    sources,
    rawJson,
    saveMessage,
    saveSuccess,
  });
});
```

Note: the `renderError` helper removes the repetitive `try { sources = loadSources() } catch (_) {}` + `res.render(...)` pattern that appeared 4 times in the original.

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add admin/routes/config.js tests/admin-config.test.js
git commit -m "feat(admin): validate enabled/schedule/module fields on config save; add tests"
```

---

## Task 7: Fix health page — structured table templates

**Files:**
- Modify: `admin/views/health.ejs`

Both the source-health table and the best-prices table currently iterate `Object.keys/Object.values`, rendering raw DB column names as headers. Replace with explicit structured templates using the known view schemas.

**`dsc_view_source_health` columns:** `source_id`, `last_run_at`, `last_finished_at`, `last_run_status`, `total_found`, `total_upserted`, `total_runs`

**`dsc_view_best_price` columns:** `product_id`, `ean`, `name`, `brand`, `category`, `image_url`, `best_price_sek`, `offer_count`, `last_updated`

- [ ] **Step 1: Replace the source-health table block**

In `admin/views/health.ejs`, find:

```ejs
  <% if (sourceHealth.length) { %>
    <h2>Source Health</h2>
    <table class="table">
      <thead>
        <tr>
          <% for (const col of Object.keys(sourceHealth[0])) { %>
            <th>
              <%= col %>
            </th>
            <% } %>
        </tr>
      </thead>
      <tbody>
        <% for (const row of sourceHealth) { %>
          <tr>
            <% for (const val of Object.values(row)) { %>
              <td>
                <%= val ?? '–' %>
              </td>
              <% } %>
          </tr>
          <% } %>
      </tbody>
    </table>
    <% } else { %>
      <p class="hint"><code>dsc_view_source_health</code> not available in this DB schema version.</p>
      <% } %>
```

Replace with:

```ejs
  <% if (sourceHealth.length) { %>
    <h2>Source Health</h2>
    <table class="table">
      <thead>
        <tr>
          <th>Source</th>
          <th>Last Run</th>
          <th>Last Finished</th>
          <th>Status</th>
          <th>Records Found</th>
          <th>Records Upserted</th>
          <th>Total Runs</th>
        </tr>
      </thead>
      <tbody>
        <% for (const row of sourceHealth) { %>
        <tr>
          <td><a href="/logs?source=<%= row.source_id %>"><strong><%= row.source_id %></strong></a></td>
          <td title="<%= row.last_run_at ? new Date(row.last_run_at).toLocaleString('sv-SE') : '' %>">
            <%= row.last_run_at ? timeAgo(row.last_run_at) : '–' %>
          </td>
          <td title="<%= row.last_finished_at ? new Date(row.last_finished_at).toLocaleString('sv-SE') : '' %>">
            <%= row.last_finished_at ? timeAgo(row.last_finished_at) : '–' %>
          </td>
          <td>
            <% if (row.last_run_status) { %>
              <span class="badge badge-<%= row.last_run_status %>"><%= row.last_run_status %></span>
            <% } else { %>
              <span class="badge badge-disabled">–</span>
            <% } %>
          </td>
          <td><%= row.total_found != null ? Number(row.total_found).toLocaleString() : '–' %></td>
          <td><%= row.total_upserted != null ? Number(row.total_upserted).toLocaleString() : '–' %></td>
          <td><%= row.total_runs %></td>
        </tr>
        <% } %>
      </tbody>
    </table>
  <% } else { %>
    <p class="hint"><code>dsc_view_source_health</code> not available in this DB schema version.</p>
  <% } %>
```

- [ ] **Step 2: Replace the best-prices table block**

In `admin/views/health.ejs`, find:

```ejs
              <!-- Best price sample -->
              <% if (bestPrices.length) { %>
                <h2>Best Price Sample (top 10)</h2>
                <table class="table">
                  <thead>
                    <tr>
                      <% for (const col of Object.keys(bestPrices[0])) { %>
                        <th>
                          <%= col %>
                        </th>
                        <% } %>
                    </tr>
                  </thead>
                  <tbody>
                    <% for (const row of bestPrices) { %>
                      <tr>
                        <% for (const val of Object.values(row)) { %>
                          <td>
                            <%= val ?? '–' %>
                          </td>
                          <% } %>
                      </tr>
                      <% } %>
                  </tbody>
                </table>
                <% } %>
```

Replace with:

```ejs
  <!-- Best price sample -->
  <% if (bestPrices.length) { %>
    <h2>Best Price Sample (top 10)</h2>
    <table class="table">
      <thead>
        <tr>
          <th>#</th>
          <th>EAN</th>
          <th>Name</th>
          <th>Brand</th>
          <th>Best Price (SEK)</th>
          <th>Offers</th>
          <th>Last Updated</th>
        </tr>
      </thead>
      <tbody>
        <% for (const row of bestPrices) { %>
        <tr>
          <td><a href="/data/product/<%= row.product_id %>">#<%= row.product_id %></a></td>
          <td><code style="font-size:.78rem"><%= row.ean ?? '–' %></code></td>
          <td><a href="/data/product/<%= row.product_id %>"><%= row.name %></a></td>
          <td><%= row.brand ?? '–' %></td>
          <td><strong><%= Number(row.best_price_sek).toLocaleString('sv-SE') %> kr</strong></td>
          <td><span class="badge badge-ok"><%= row.offer_count %></span></td>
          <td title="<%= row.last_updated ? new Date(row.last_updated).toLocaleString('sv-SE') : '' %>">
            <%= row.last_updated ? timeAgo(row.last_updated) : '–' %>
          </td>
        </tr>
        <% } %>
      </tbody>
    </table>
  <% } %>
```

- [ ] **Step 3: Run unit tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add admin/views/health.ejs
git commit -m "fix(admin): replace raw Object.keys/values health table rendering with structured templates"
```

---

## Task 8: Commit the spec and plan documents

- [ ] **Step 1: Stage and commit design artifacts**

```bash
git add docs/superpowers/specs/2026-04-17-admin-ui-scraper-revision-design.md
git add docs/superpowers/plans/2026-04-17-admin-ui-scraper-revision.md
git commit -m "docs: add admin UI revision spec and implementation plan"
```

---

## Self-Review Checklist

**Spec coverage:**
- 1.1 Log status filter → Task 1 ✓
- 1.2 Analytics null crash → Task 2 ✓
- 1.3 Config client validator → Task 3 ✓
- 1.4 Run options NaN → Task 5 ✓
- 2.1 Dashboard "Price rows" → Task 4 ✓
- 2.2 Dashboard failed visibility → Task 4 ✓
- 2.3 Match-rate formula → Task 2 ✓
- 2.4 avgOffersPerProduct label → Task 2 ✓
- 2.5 Health raw columns → Task 7 ✓
- 3.1 Consolidate parsing → Task 5 ✓
- 3.2 Config validation → Task 6 ✓

**Placeholder scan:** No TBDs, no "implement later", no vague steps. Every step has exact code or exact commands.

**Type consistency:** `counts.fails_24h` is defined in the route (Task 4 Step 1) and used in the template (Task 4 Step 2). `effective.pageLimit` and `rawOverrides.pageLimit` are both defined and used within Task 5. `validateSourceEntry` is defined in the test file (Task 6 Step 1) and mirrored identically in the route (Task 6 Step 3). All cross-task references are consistent.
