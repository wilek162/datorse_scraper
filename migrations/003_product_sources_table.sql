CREATE TABLE IF NOT EXISTS dsc_product_sources (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    scrape_log_id INT UNSIGNED NOT NULL,
    source_id VARCHAR(64) NOT NULL,
    external_id VARCHAR(255) DEFAULT NULL,
    ean VARCHAR(20) DEFAULT NULL,
    matched_product_id INT UNSIGNED DEFAULT NULL,
    raw_json JSON NOT NULL,
    match_status ENUM(
        'matched',
        'unmatched',
        'ambiguous',
        'skipped'
    ) NOT NULL DEFAULT 'unmatched',
    scraped_at DATETIME NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id),
    KEY idx_ps_source (source_id, scraped_at),
    KEY idx_ps_ean (ean),
    KEY idx_ps_match (match_status),
    KEY idx_ps_log (scrape_log_id),
    CONSTRAINT fk_ps_log FOREIGN KEY (scrape_log_id) REFERENCES dsc_scrape_log (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

DROP EVENT IF EXISTS evt_purge_product_sources;

CREATE EVENT IF NOT EXISTS evt_purge_product_sources
ON SCHEDULE EVERY 1 DAY
STARTS '2026-01-01 03:30:00'
DO
  DELETE FROM dsc_product_sources
  WHERE scraped_at < NOW() - INTERVAL 90 DAY
  LIMIT 5000;