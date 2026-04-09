-- migrations/009_prices_via_source.sql
-- Adds via_source to dsc_prices so the priority rule can be enforced:
--   A price row written by a dedicated scraper (via_source != 'prisjakt') is
--   immune to being overwritten by Prisjakt-sourced data.
--   A Prisjakt row (via_source = 'prisjakt') can be upgraded to a dedicated row.
-- This enables Prisjakt to populate price rows for retailers with no dedicated
-- scraper while preventing it from corrupting rows owned by dedicated scrapers.

SET NAMES utf8mb4;

SET
    @add_col = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_prices'
                        AND column_name = 'via_source'
                ), 'SELECT 1', 'ALTER TABLE dsc_prices ADD COLUMN via_source VARCHAR(64) DEFAULT NULL AFTER affiliate_url'
            )
    );

PREPARE stmt FROM @add_col;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

-- Backfill: rows that already exist get via_source = retailer (they were written
-- by a dedicated scraper or by the prisjakt aggregate path).
-- For safety we only set NULL rows to 'prisjakt' for the prisjakt retailer,
-- and leave all others as NULL (treated as non-prisjakt = protected).
SET
    @backfill = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_prices'
                        AND column_name = 'via_source'
                ), 'UPDATE dsc_prices SET via_source = ''prisjakt'' WHERE retailer = ''prisjakt'' AND via_source IS NULL', 'SELECT 1'
            )
    );

PREPARE stmt FROM @backfill;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;