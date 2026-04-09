-- migrations/008_published_views.sql
-- Creates the published read model that dator.se / WordPress consumes.
-- WordPress must only query these views, never raw scraper tables.
-- Views are lightweight (no materialisation needed at MVP scale).

SET NAMES utf8mb4;

-- ─── dsc_view_live_offers ─────────────────────────────────────────────────────
-- One row per canonical product × retailer that is currently in stock.
-- Suitable for "buy now" widgets and retailer comparison tables.
CREATE OR REPLACE VIEW dsc_view_live_offers AS
SELECT
    p.id AS product_id,
    p.ean,
    p.source_id AS canonical_source,
    p.external_id AS canonical_external_id,
    p.name,
    p.brand,
    p.category,
    p.image_url,
    pr.retailer,
    pr.price_sek,
    pr.previous_price,
    pr.in_stock,
    pr.affiliate_url,
    pr.scraped_at
FROM dsc_products p
    JOIN dsc_prices pr ON pr.product_id = p.id
WHERE
    pr.in_stock = 1;

-- ─── dsc_view_best_price ─────────────────────────────────────────────────────
-- One row per canonical product: the lowest in-stock price across all retailers.
-- Suitable for product listing pages, compare widgets, and price badges.
CREATE OR REPLACE VIEW dsc_view_best_price AS
SELECT
    p.id AS product_id,
    p.ean,
    p.name,
    p.brand,
    p.category,
    p.image_url,
    MIN(pr.price_sek) AS best_price_sek,
    COUNT(pr.id) AS offer_count,
    MAX(pr.scraped_at) AS last_updated
FROM dsc_products p
    JOIN dsc_prices pr ON pr.product_id = p.id
WHERE
    pr.in_stock = 1
GROUP BY
    p.id,
    p.ean,
    p.name,
    p.brand,
    p.category,
    p.image_url;

-- ─── dsc_view_product_summary ────────────────────────────────────────────────
-- Canonical product catalogue enriched with best-price snapshot.
-- Suitable as the primary product list for WordPress queries.
CREATE OR REPLACE VIEW dsc_view_product_summary AS
SELECT
    p.id AS product_id,
    p.ean,
    p.source_id AS canonical_source,
    p.external_id AS canonical_external_id,
    p.name,
    p.brand,
    p.category,
    p.image_url,
    bp.best_price_sek,
    bp.offer_count,
    bp.last_updated,
    p.first_seen_source,
    p.created_at,
    p.updated_at
FROM
    dsc_products p
    LEFT JOIN dsc_view_best_price bp ON bp.product_id = p.id;

-- ─── dsc_view_recent_price_history ───────────────────────────────────────────
-- Price-change events for the last 30 days.
-- Suitable for price-history charts on product detail pages.
CREATE OR REPLACE VIEW dsc_view_recent_price_history AS
SELECT ph.product_id, p.name AS product_name, p.ean, ph.retailer, ph.price_sek, ph.in_stock, ph.source_id, ph.recorded_at
FROM
    dsc_price_history ph
    JOIN dsc_products p ON p.id = ph.product_id
WHERE
    ph.recorded_at >= NOW() - INTERVAL 30 DAY;

-- ─── dsc_view_source_health ──────────────────────────────────────────────────
-- Per-source run health summary; useful for monitoring and alerting dashboards.
-- Shows last-run status and ratio of matched vs unmatched source rows.
CREATE OR REPLACE VIEW dsc_view_source_health AS
SELECT
    sl.source_id,
    MAX(sl.started_at) AS last_run_at,
    MAX(sl.finished_at) AS last_finished_at,
    (
        SELECT status
        FROM dsc_scrape_log s2
        WHERE
            s2.source_id = sl.source_id
        ORDER BY s2.started_at DESC
        LIMIT 1
    ) AS last_run_status,
    SUM(sl.records_found) AS total_found,
    SUM(sl.records_upserted) AS total_upserted,
    COUNT(sl.id) AS total_runs
FROM dsc_scrape_log sl
GROUP BY
    sl.source_id;