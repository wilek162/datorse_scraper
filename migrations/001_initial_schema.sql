-- migrations/001_initial_schema.sql
-- Run once: mysql -u dsc_user -p datorsc < migrations/001_initial_schema.sql
-- All tables use the dsc_ prefix to avoid collision with WordPress (wp_) tables.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ─── Products ──────────────────────────────────────────────────────────────────
-- Canonical product catalogue, deduped by EAN/GTIN.
CREATE TABLE IF NOT EXISTS dsc_products (
  id         INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  ean        VARCHAR(20)      NOT NULL,
  name       VARCHAR(512)     NOT NULL,
  brand      VARCHAR(128)     DEFAULT NULL,
  category   VARCHAR(128)     DEFAULT NULL,
  image_url  VARCHAR(1024)    DEFAULT NULL,
  spec_json  JSON             DEFAULT NULL,
  created_at DATETIME         NOT NULL DEFAULT NOW(),
  updated_at DATETIME         NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ean (ean),
  KEY idx_name (name(64))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─── Current prices ───────────────────────────────────────────────────────────
-- One active price row per product+retailer combination.
CREATE TABLE IF NOT EXISTS dsc_prices (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  product_id    INT UNSIGNED     NOT NULL,
  retailer      VARCHAR(64)      NOT NULL,
  price_sek     DECIMAL(10,2)    NOT NULL,
  in_stock      TINYINT(1)       NOT NULL DEFAULT 1,
  affiliate_url VARCHAR(1024)    NOT NULL,
  scraped_at    DATETIME         NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_product_retailer (product_id, retailer),
  KEY idx_retailer (retailer),
  KEY idx_scraped  (scraped_at),
  CONSTRAINT fk_prices_product
    FOREIGN KEY (product_id) REFERENCES dsc_products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─── Price history ────────────────────────────────────────────────────────────
-- Append-only log; a new row is inserted whenever price changes.
CREATE TABLE IF NOT EXISTS dsc_price_history (
  id          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  product_id  INT UNSIGNED     NOT NULL,
  retailer    VARCHAR(64)      NOT NULL,
  price_sek   DECIMAL(10,2)    NOT NULL,
  recorded_at DATETIME         NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  KEY idx_ph_product  (product_id),
  KEY idx_ph_recorded (recorded_at),
  CONSTRAINT fk_history_product
    FOREIGN KEY (product_id) REFERENCES dsc_products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─── Scrape log ───────────────────────────────────────────────────────────────
-- Job-level audit trail for monitoring and alerting.
CREATE TABLE IF NOT EXISTS dsc_scrape_log (
  id               INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  source_id        VARCHAR(64)      NOT NULL,
  started_at       DATETIME         NOT NULL,
  finished_at      DATETIME         DEFAULT NULL,
  records_found    INT              DEFAULT 0,
  records_valid    INT              DEFAULT 0,
  records_upserted INT              DEFAULT 0,
  error_message    TEXT             DEFAULT NULL,
  status           ENUM('running','ok','partial','failed') NOT NULL DEFAULT 'running',
  PRIMARY KEY (id),
  KEY idx_source_started (source_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
