-- requires MySQL 8.0 with RANGE COLUMNS support on DATETIME columns

SET
    @has_history_table = (
        SELECT COUNT(*)
        FROM information_schema.tables
        WHERE
            table_schema = DATABASE()
            AND table_name = 'dsc_price_history'
    );

SET
    @is_partitioned = (
        SELECT COUNT(*)
        FROM information_schema.partitions
        WHERE
            table_schema = DATABASE()
            AND table_name = 'dsc_price_history'
            AND partition_name IS NOT NULL
    );

SET
    @drop_history_fk = (
        SELECT IF(
                @has_history_table = 0, 'SELECT 1', IF(
                    EXISTS (
                        SELECT 1
                        FROM information_schema.referential_constraints
                        WHERE
                            constraint_schema = DATABASE()
                            AND table_name = 'dsc_price_history'
                            AND constraint_name = 'fk_history_product'
                    ), 'ALTER TABLE dsc_price_history DROP FOREIGN KEY fk_history_product', 'SELECT 1'
                )
            )
    );

PREPARE stmt FROM @drop_history_fk;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

SET
    @drop_idx_ph_product = (
        SELECT IF(
                @has_history_table = 0, 'SELECT 1', IF(
                    EXISTS (
                        SELECT 1
                        FROM information_schema.statistics
                        WHERE
                            table_schema = DATABASE()
                            AND table_name = 'dsc_price_history'
                            AND index_name = 'idx_ph_product'
                    ), 'ALTER TABLE dsc_price_history DROP INDEX idx_ph_product', 'SELECT 1'
                )
            )
    );

PREPARE stmt FROM @drop_idx_ph_product;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

SET
    @ensure_history_pk = (
        SELECT IF(
                @has_history_table = 0, 'SELECT 1', IF(
                    EXISTS (
                        SELECT 1
                        FROM information_schema.statistics
                        WHERE
                            table_schema = DATABASE()
                            AND table_name = 'dsc_price_history'
                            AND index_name = 'PRIMARY'
                        GROUP BY
                            index_name
                        HAVING
                            COUNT(*) = 2
                            AND SUM(column_name = 'id') = 1
                            AND SUM(column_name = 'recorded_at') = 1
                    ), 'SELECT 1', 'ALTER TABLE dsc_price_history DROP PRIMARY KEY, ADD PRIMARY KEY (id, recorded_at)'
                )
            )
    );

PREPARE stmt FROM @ensure_history_pk;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

SET
    @ensure_idx_ph_product = (
        SELECT IF(
                @has_history_table = 0, 'SELECT 1', IF(
                    EXISTS (
                        SELECT 1
                        FROM information_schema.statistics
                        WHERE
                            table_schema = DATABASE()
                            AND table_name = 'dsc_price_history'
                            AND index_name = 'idx_ph_product'
                        GROUP BY
                            index_name
                        HAVING
                            COUNT(*) = 2
                            AND SUM(column_name = 'product_id') = 1
                            AND SUM(column_name = 'recorded_at') = 1
                    ), 'SELECT 1', 'CREATE INDEX idx_ph_product ON dsc_price_history (product_id, recorded_at)'
                )
            )
    );

PREPARE stmt FROM @ensure_idx_ph_product;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

SET
    @apply_partitioning = (
        SELECT IF(
                @has_history_table = 0
                OR @is_partitioned > 0, 'SELECT 1', "ALTER TABLE dsc_price_history PARTITION BY RANGE COLUMNS(recorded_at) ( PARTITION p2024_h2 VALUES LESS THAN ('2025-01-01 00:00:00'), PARTITION p2025_h1 VALUES LESS THAN ('2025-07-01 00:00:00'), PARTITION p2025_h2 VALUES LESS THAN ('2026-01-01 00:00:00'), PARTITION p2026_h1 VALUES LESS THAN ('2026-07-01 00:00:00'), PARTITION p_future VALUES LESS THAN (MAXVALUE) )"
            )
    );

PREPARE stmt FROM @apply_partitioning;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;