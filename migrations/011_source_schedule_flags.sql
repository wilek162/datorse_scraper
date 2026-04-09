-- migration 011: source schedule flags
-- Stores per-source pause/resume state in the DB so the admin UI can toggle
-- schedules without editing files or restarting the scraper process.
-- The scheduler checks this table before each cron tick and skips paused sources.

CREATE TABLE IF NOT EXISTS dsc_source_flags (
    source_id VARCHAR(64) NOT NULL,
    paused TINYINT(1) NOT NULL DEFAULT 0,
    paused_by VARCHAR(128) NULL DEFAULT NULL COMMENT 'free-text actor label',
    note VARCHAR(255) NULL DEFAULT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (source_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;