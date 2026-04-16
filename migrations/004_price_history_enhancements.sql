SET
    @add_in_stock = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_price_history'
                        AND column_name = 'in_stock'
                ), 'SELECT 1', 'ALTER TABLE dsc_price_history ADD COLUMN in_stock TINYINT(1) NOT NULL DEFAULT 1 AFTER price_sek'
            )
    );

PREPARE stmt FROM @add_in_stock;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

SET
    @add_source_id = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_price_history'
                        AND column_name = 'source_id'
                ), 'SELECT 1', 'ALTER TABLE dsc_price_history ADD COLUMN source_id VARCHAR(64) DEFAULT NULL AFTER in_stock'
            )
    );

PREPARE stmt FROM @add_source_id;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

SET
    @add_idx_retailer_recorded = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.statistics
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_price_history'
                        AND index_name = 'idx_ph_retailer'
                ), 'SELECT 1', 'CREATE INDEX idx_ph_retailer ON dsc_price_history (retailer, recorded_at)'
            )
    );

PREPARE stmt FROM @add_idx_retailer_recorded;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;