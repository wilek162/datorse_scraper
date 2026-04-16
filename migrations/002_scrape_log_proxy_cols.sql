SET
    @add_previous_price = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_prices'
                        AND column_name = 'previous_price'
                ), 'SELECT 1', 'ALTER TABLE dsc_prices ADD COLUMN previous_price DECIMAL(10,2) DEFAULT NULL AFTER price_sek'
            )
    );

PREPARE stmt FROM @add_previous_price;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

SET
    @add_idx_stock = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.statistics
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_prices'
                        AND index_name = 'idx_stock'
                ), 'SELECT 1', 'CREATE INDEX idx_stock ON dsc_prices (in_stock)'
            )
    );

PREPARE stmt FROM @add_idx_stock;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

SET
    @add_proxy_credits = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_scrape_log'
                        AND column_name = 'proxy_credits_used'
                ), 'SELECT 1', 'ALTER TABLE dsc_scrape_log ADD COLUMN proxy_credits_used INT NOT NULL DEFAULT 0 AFTER error_message'
            )
    );

PREPARE stmt FROM @add_proxy_credits;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

SET
    @add_proxy_cost = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_scrape_log'
                        AND column_name = 'proxy_cost_usd'
                ), 'SELECT 1', 'ALTER TABLE dsc_scrape_log ADD COLUMN proxy_cost_usd DECIMAL(8,4) DEFAULT NULL AFTER proxy_credits_used'
            )
    );

PREPARE stmt FROM @add_proxy_cost;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;

SET
    @add_pages_fetched = (
        SELECT IF(
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE
                        table_schema = DATABASE()
                        AND table_name = 'dsc_scrape_log'
                        AND column_name = 'pages_fetched'
                ), 'SELECT 1', 'ALTER TABLE dsc_scrape_log ADD COLUMN pages_fetched INT NOT NULL DEFAULT 0 AFTER proxy_cost_usd'
            )
    );

PREPARE stmt FROM @add_pages_fetched;

EXECUTE stmt;

DEALLOCATE PREPARE stmt;