-- migration 012: add dry_run flag to scrape log
-- Distinguishes admin-panel dryRun triggers from real production runs.
-- Historical rows default to 0 (not a dry run) — no data migration needed.

ALTER TABLE dsc_scrape_log
  ADD COLUMN dry_run TINYINT(1) NOT NULL DEFAULT 0
  AFTER pages_fetched;
