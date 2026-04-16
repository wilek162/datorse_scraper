SET
    @add_first_seen_source = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_products'
                        AND column_name = 'first_seen_source'
                ), 'SELECT 1', 'ALTER TABLE dsc_products ADD COLUMN first_seen_source VARCHAR(64) DEFAULT NULL AFTER spec_json'
            )
    );

PREPARE stmt FROM @add_first_seen_source;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

SET
    @add_idx_brand = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.statistics
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_products'
                        AND index_name = 'idx_brand'
                ), 'SELECT 1', 'CREATE INDEX idx_brand ON dsc_products (brand)'
            )
    );

PREPARE stmt FROM @add_idx_brand;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

SET
    @add_idx_category = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.statistics
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_products'
                        AND index_name = 'idx_category'
                ), 'SELECT 1', 'CREATE INDEX idx_category ON dsc_products (category)'
            )
    );

PREPARE stmt FROM @add_idx_category;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

SET
    @add_slug_column = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_products'
                        AND column_name = 'slug'
                ), 'SELECT 1', 'ALTER TABLE dsc_products ADD COLUMN slug VARCHAR(255) GENERATED ALWAYS AS (LOWER(REPLACE(TRIM(name), '' '', ''-''))) VIRTUAL'
            )
    );

PREPARE stmt FROM @add_slug_column;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

SET
    @add_idx_slug = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.statistics
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_products'
                        AND index_name = 'idx_slug'
                ), 'SELECT 1', 'CREATE INDEX idx_slug ON dsc_products (slug(64))'
            )
    );

PREPARE stmt FROM @add_idx_slug;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;