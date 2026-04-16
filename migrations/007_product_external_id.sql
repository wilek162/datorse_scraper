-- migrations/007_product_external_id.sql
-- Adds external_id + source_id to dsc_products so products without EAN/GTIN
-- can be canonically identified by their original source's product ID.
-- Also makes ean nullable to support this second identity path.

SET NAMES utf8mb4;

-- ─── 1. Make ean nullable (was NOT NULL) ─────────────────────────────────────
SET
    @make_ean_nullable = (
        SELECT IF(
                (
                    SELECT IS_NULLABLE
                    FROM information_schema.columns
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_products'
                        AND column_name = 'ean'
                ) = 'NO', 'ALTER TABLE dsc_products MODIFY ean VARCHAR(20) DEFAULT NULL', 'SELECT 1'
            )
    );

PREPARE stmt FROM @make_ean_nullable;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

-- ─── 2. Add source_id column ──────────────────────────────────────────────────
SET
    @add_source_id = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_products'
                        AND column_name = 'source_id'
                ), 'SELECT 1', 'ALTER TABLE dsc_products ADD COLUMN source_id VARCHAR(64) DEFAULT NULL AFTER first_seen_source'
            )
    );

PREPARE stmt FROM @add_source_id;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

-- ─── 3. Add external_id column ───────────────────────────────────────────────
SET
    @add_ext_id = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_products'
                        AND column_name = 'external_id'
                ), 'SELECT 1', 'ALTER TABLE dsc_products ADD COLUMN external_id VARCHAR(255) DEFAULT NULL AFTER source_id'
            )
    );

PREPARE stmt FROM @add_ext_id;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

-- ─── 4. Add unique key (source_id, external_id) ───────────────────────────────
-- MySQL allows multiple NULLs in a UNIQUE KEY, so rows with NULL source_id/external_id
-- do not conflict.  Only rows where BOTH are non-null must be unique.
SET
    @add_uq_source_ext = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.statistics
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_products'
                        AND index_name = 'uq_source_external'
                ), 'SELECT 1', 'ALTER TABLE dsc_products ADD UNIQUE KEY uq_source_external (source_id, external_id)'
            )
    );

PREPARE stmt FROM @add_uq_source_ext;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

-- ─── 5. Add index on external_id alone for fast reverse lookups ───────────────
SET
    @add_idx_ext_id = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.statistics
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_products'
                        AND index_name = 'idx_external_id'
                ), 'SELECT 1', 'CREATE INDEX idx_external_id ON dsc_products (external_id)'
            )
    );

PREPARE stmt FROM @add_idx_ext_id;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;