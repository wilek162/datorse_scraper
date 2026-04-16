dator.se / datorsc-scraper

**Database Architecture &**

**CI/CD Operations Playbook**

MySQL 8.0 · Node.js · Zyte & scrape.do pipelines

Version 1.0 · April 2026

# **1\. Executive Summary**

This document defines the complete database design, operational procedures, and CI/CD strategy for the datorsc price-aggregation scraper. It covers MySQL 8.0 schema design (including the existing tables), schema evolution via versioned migrations, backup and recovery, monitoring, and deployment automation. The recommendations are calibrated to a small-to-medium SaaS running on a single primary MySQL instance - cost-effective today, with a documented upgrade path to replication and read replicas as traffic grows.

## **1.1 Guiding Principles**

- Data integrity over scraper speed - foreign keys, constraints, and transactions are non-negotiable.
- Schema-as-code - every DDL change lives in a versioned .sql file, committed before deployment.
- Append-only audit trails - price history is never mutated; scrape_log is never deleted.
- Zero-downtime migrations - large table alterations use pt-online-schema-change or MySQL 8 instant DDL.
- Least-privilege access - scraper runtime uses a write-only role; reporting uses read-only.

## **1.2 Requirements, Use Cases, Caveats, and Mitigations**

### **Core requirements**

- The scraper must support low-cost, source-specific runs so expensive targets can be sampled with explicit page and item caps.
- Current-price writes must remain transactional and idempotent at the `(product_id, retailer)` level.
- Price history must scale independently from the rest of the schema because it is the only table expected to grow into the tens-of-millions range.
- Raw scraped payloads must remain replayable for debugging, matching, and parser improvement without re-scraping.
- Operational checks must be simple enough to run after migrations, restores, and future partition maintenance.

### **Primary use cases**

- Frequent scheduler runs update `dsc_prices` and append only true price or stock-state changes to `dsc_price_history`.
- Manual smoke runs such as `prisjakt --pageLimit 1 --itemLimit 5` validate parser health while keeping proxy credit burn low.
- Reporting queries read recent history by product, retailer, and time window for price charts, staleness checks, and alerts.
- Operations staff add future partitions ahead of time and verify schema health after migrations or backup restores.

### **Important caveats**

- MySQL `InnoDB` user-defined partitioning is incompatible with foreign keys on the partitioned table. A partitioned `dsc_price_history` table therefore cannot keep `fk_history_product`.
- Every unique key on a partitioned table must include the partition column. For `dsc_price_history`, the primary key must include `recorded_at`.
- Partition maintenance must preserve a trailing catch-all partition such as `p_future`, otherwise new writes can fail when time moves past the last explicit boundary.
- Automated partition creation must be idempotent because it will run on a schedule.

### **Mitigations**

- Keep strict FK enforcement on `dsc_prices` and preserve application-level transactional integrity when inserting history rows.
- Use `PRIMARY KEY (id, recorded_at)` plus composite history indexes on `(product_id, recorded_at)` and `(retailer, recorded_at)`.
- Add a dedicated partition-maintenance script that reorganises `p_future` into the next half-year partition plus a new `p_future`.
- Add DB smoke checks that assert partition presence, index shape, and the intentional absence of a history FK.

# **2\. Database Technology Decision**

The existing codebase uses mysql2 and the schema is already written in MySQL DDL. The analysis below confirms MySQL 8.0 as the correct choice, with no migration to another engine warranted.

## **2.1 Evaluation Matrix**

| **Engine**    | **Notes**                                                                                                                                                                                                                                        | **Verdict**                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| MySQL 8.0     | Full JSON column support, window functions, CTE, invisible indexes, instant DDL for most ALTER ops. InnoDB row-level locking. Excellent Node.js ecosystem (mysql2 driver). Low hosting cost on AWS RDS / managed VMs.                            | ✅ Recommended                  |
| PostgreSQL 16 | Superior JSON/JSONB operators, partial indexes on expressions. Marginally better for analytics. Requires driver change and schema re-testing. No meaningful gain at current scale.                                                               | ⬜ Viable but unnecessary churn |
| ClickHouse    | Columnar OLAP engine ideal for price-history analytics at scale (billions of rows). Not a transactional DB - cannot replace MySQL for upserts. Consider as a read replica / analytics sink if query latency becomes an issue beyond ~100 M rows. | ⬜ Future analytics layer only  |
| SQLite        | Zero-config, good for tests. Not suitable for multi-process concurrent writes from a scraper scheduler.                                                                                                                                          | ❌ Dev/test only                |

## **2.2 MySQL 8.0 Features Leveraged**

- **JSON columns** (spec_json on dsc_products) - store volatile, source-specific attributes without schema churn.
- **Window functions** - price trend queries (LAG, LEAD, RANK) without subquery gymnastics.
- **Invisible indexes** - safely test index drops before committing.
- **Instant DDL** - most ADD COLUMN / DROP COLUMN operations on InnoDB are metadata-only at the storage engine level (ALGORITHM=INSTANT), meaning zero table rebuilds.
- **Generated columns** - derive brand_lower or ean_clean from existing columns for index-friendly lookups.

# **3\. Schema Design**

The schema uses the dsc*prefix throughout to coexist with a WordPress installation (wp* tables) on the same database instance. All tables use InnoDB, utf8mb4_unicode_ci, and explicit NOT NULL defaults.

## **3.1 Entity Overview**

The diagram below shows the six core tables and their relationships.

dsc_products (canonical EAN catalogue) │ ├── dsc_prices (current price per retailer) 1:N ├── dsc_price_history (append-only price ledger) 1:N └── dsc_product_sources (raw scraped payload per run) 1:N dsc_scrape_log (job-level audit, no FK to products) dsc_migrations (applied migration tracking)

## **3.2 Table Reference**

The two tables added in this design iteration (dsc_product_sources and extensions to existing tables) are highlighted.

### **3.2.1 dsc_products - Canonical Product Catalogue**

One row per unique EAN/GTIN. This is the source of truth; all prices and history reference it. The spec_json column stores volatile, source-specific attributes (CPU model, RAM, storage, display size) in a schemaless blob so the core table never needs alteration when a new attribute is discovered.

CREATE TABLE dsc_products ( id INT UNSIGNED NOT NULL AUTO_INCREMENT, ean VARCHAR(20) NOT NULL, name VARCHAR(512) NOT NULL, brand VARCHAR(128) DEFAULT NULL, category VARCHAR(128) DEFAULT NULL, image_url VARCHAR(1024) DEFAULT NULL, spec_json JSON DEFAULT NULL, -- NEW: normalised slug for URL / caching slug VARCHAR(255) GENERATED ALWAYS AS (LOWER(REPLACE(TRIM(name), ' ', '-'))) VIRTUAL, -- NEW: source tracking first_seen_source VARCHAR(64) DEFAULT NULL, created_at DATETIME NOT NULL DEFAULT NOW(), updated_at DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(), PRIMARY KEY (id), UNIQUE KEY uq_ean (ean), KEY idx_name (name(64)), KEY idx_brand (brand), KEY idx_category (category), KEY idx_slug (slug(64)) ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

### **3.2.2 dsc_prices - Current Price per Retailer**

One active row per (product_id, retailer) pair. Upserting this table is done via INSERT … ON DUPLICATE KEY UPDATE - keeping it O(1) per product regardless of history depth. The previous price is captured before update to detect changes.

CREATE TABLE dsc_prices ( id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, product_id INT UNSIGNED NOT NULL, retailer VARCHAR(64) NOT NULL, price_sek DECIMAL(10,2) NOT NULL, previous_price DECIMAL(10,2) DEFAULT NULL, -- NEW: for delta alerts in_stock TINYINT(1) NOT NULL DEFAULT 1, affiliate_url VARCHAR(1024) NOT NULL, scraped_at DATETIME NOT NULL, PRIMARY KEY (id), UNIQUE KEY uq_product_retailer (product_id, retailer), KEY idx_retailer (retailer), KEY idx_scraped (scraped_at), KEY idx_stock (in_stock), CONSTRAINT fk_prices_product FOREIGN KEY (product_id) REFERENCES dsc_products(id) ON DELETE CASCADE ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

### **3.2.3 dsc_price_history - Append-Only Price Ledger**

A new row is inserted only when the price or stock status changes - enforced in application logic and optionally by a BEFORE INSERT trigger. Because MySQL `InnoDB` does not support foreign keys on user-partitioned tables, this table is intentionally partitioned without an FK to `dsc_products`; integrity is preserved in application code by inserting history rows only after the canonical product row has been resolved inside the same transaction.

CREATE TABLE dsc_price_history ( id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, product_id INT UNSIGNED NOT NULL, retailer VARCHAR(64) NOT NULL, price_sek DECIMAL(10,2) NOT NULL, in_stock TINYINT(1) NOT NULL DEFAULT 1, -- NEW: track availability too source_id VARCHAR(64) DEFAULT NULL, -- NEW: which scrape job recorded_at DATETIME NOT NULL DEFAULT NOW(), PRIMARY KEY (id, recorded_at), -- partition key must be in every unique key KEY idx_ph_product (product_id, recorded_at), KEY idx_ph_retailer (retailer, recorded_at) ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci PARTITION BY RANGE COLUMNS(recorded_at) ( PARTITION p2024_h2 VALUES LESS THAN ('2025-01-01 00:00:00'), PARTITION p2025_h1 VALUES LESS THAN ('2025-07-01 00:00:00'), PARTITION p2025_h2 VALUES LESS THAN ('2026-01-01 00:00:00'), PARTITION p2026_h1 VALUES LESS THAN ('2026-07-01 00:00:00'), PARTITION p_future VALUES LESS THAN (MAXVALUE) );

### **3.2.4 dsc_product_sources - NEW: Raw Scraped Payload**

Stores the raw, normalised record returned by each scraper module before deduplication. This provides an audit trail independent of the canonical product table, enables re-processing without re-scraping, and is the source for the EAN-matching / fuzzy-merge pipeline. Rows are retained for 90 days then purged by a scheduled event.

CREATE TABLE dsc_product_sources ( id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, scrape_log_id INT UNSIGNED NOT NULL, source_id VARCHAR(64) NOT NULL, -- e.g. "webhallen", "awin" external_id VARCHAR(255) DEFAULT NULL, -- retailer's own product ID ean VARCHAR(20) DEFAULT NULL, matched_product_id INT UNSIGNED DEFAULT NULL, -- NULL = unmatched raw_json JSON NOT NULL, match_status ENUM('matched','unmatched','ambiguous','skipped') NOT NULL DEFAULT 'unmatched', scraped_at DATETIME NOT NULL DEFAULT NOW(), PRIMARY KEY (id), KEY idx_ps_source (source_id, scraped_at), KEY idx_ps_ean (ean), KEY idx_ps_match (match_status), KEY idx_ps_log (scrape_log_id), CONSTRAINT fk_ps_log FOREIGN KEY (scrape_log_id) REFERENCES dsc_scrape_log(id) -- no FK to dsc_products intentionally: unmatched rows are valid ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

### **3.2.5 dsc_scrape_log - Job Audit Trail**

Unchanged in structure from the initial migration, but two columns are added to support cost tracking for Zyte and scrape.do credit consumption.

\-- ALTER (add via migration 002): ALTER TABLE dsc_scrape_log ADD COLUMN proxy_credits_used INT DEFAULT 0 AFTER error_message, ADD COLUMN proxy_cost_usd DECIMAL(8,4) DEFAULT NULL AFTER proxy_credits_used, ADD COLUMN pages_fetched INT DEFAULT 0 AFTER proxy_cost_usd;

## **3.3 Index Strategy**

Indexes are deliberately minimal at launch. The following table documents rationale for each non-PK index:

| **Index**                        | **Purpose**                                                           | **Criticality** |
| -------------------------------- | --------------------------------------------------------------------- | --------------- |
| dsc_products.uq_ean              | Deduplication during upsert - the most frequent write path.           | High            |
| dsc_products.idx_brand           | Filter / facet queries from WordPress product listings.               | Medium          |
| dsc_prices.uq_product_retailer   | INSERT … ON DUPLICATE KEY UPDATE hit rate - critical for correctness. | High            |
| dsc_prices.idx_scraped           | Identify stale rows (last scraped > N hours ago).                     | Medium          |
| dsc_price_history.idx_ph_product | Per-product history chart queries.                                    | High            |
| dsc_product_sources.idx_ps_ean   | EAN-based matching pipeline lookup.                                   | High            |
| dsc_product_sources.idx_ps_match | Queue: SELECT … WHERE match_status = "unmatched".                     | Medium          |

## **3.4 Partitioning Strategy**

**dsc_price_history** is the only table that will exceed tens of millions of rows within 12-18 months of operation. `RANGE COLUMNS(recorded_at)` partitioning on `DATETIME` enables: (a) partition pruning on date-range queries (the dominant access pattern), (b) fast partition maintenance using direct date boundaries instead of `TO_DAYS()` expressions, and (c) future migration of cold partitions to ClickHouse without changing query semantics.

**Design tradeoff:** `dsc_price_history` deliberately does not use a foreign key because MySQL `InnoDB` partitioning does not support it. `dsc_prices` remains the FK-protected current-state table; history integrity is enforced by transactional application code and DB smoke tests.

**⚠️ Partition maintenance** Add a new partition before it becomes the active one. Add the cron job in Section 7.3 to run quarterly and create the next two half-year partitions.

## **3.5 MySQL Scheduled Events (Data Housekeeping)**

\-- Purge raw scrape payloads older than 90 days (runs daily at 03:30) CREATE EVENT IF NOT EXISTS evt_purge_product_sources ON SCHEDULE EVERY 1 DAY STARTS '2026-01-01 03:30:00' DO DELETE FROM dsc_product_sources WHERE scraped_at < NOW() - INTERVAL 90 DAY LIMIT 5000; -- chunked to avoid long lock -- Summarise daily min/max price into a stats table (future) -- CREATE EVENT evt_daily_price_stats ...

# **4\. Migration Strategy**

## **4.1 Versioned Migration Files**

Every schema change is expressed as a numbered SQL file in migrations/. The existing run.js runner tracks applied files in dsc_migrations. Files must be named NNN_description.sql and must be idempotent (use IF NOT EXISTS / IF EXISTS guards).

migrations/ 001_initial_schema.sql ← already applied 002_scrape_log_proxy_cols.sql 003_product_sources_table.sql 004_price_history_enhancements.sql 005_products_generated_cols.sql 006_partition_price_history.sql ...

## **4.2 Safe ALTER TABLE Rules**

MySQL 8.0 supports ALGORITHM=INSTANT for a majority of ADD COLUMN / DROP COLUMN operations at runtime. Always specify the algorithm explicitly and fall back gracefully:

\-- Preferred: instant, no table rebuild, no lock ALTER TABLE dsc_prices ADD COLUMN previous_price DECIMAL(10,2) DEFAULT NULL, ALGORITHM=INSTANT; -- If INSTANT not supported (e.g. changing column type): -- Use pt-online-schema-change (Percona Toolkit) for tables > 1M rows -- pt-online-schema-change --alter "MODIFY price_sek DECIMAL(12,2) NOT NULL" \\ -- --execute D=datorsc,t=dsc_prices

## **4.3 Migration Checklist (per PR)**

- Write the migration SQL file and verify it passes locally with node migrations/run.js.
- Run EXPLAIN on all queries that touch the altered table - confirm index usage unchanged.
- **Never** modify an already-applied migration file. Write a new one.
- If the migration drops a column, verify no application code references it first (grep codebase).
- For tables with > 500k rows, test the migration on a restored backup copy, measure duration.
- Tag the migration file in your PR with the minimum MySQL version required (e.g. # requires MySQL 8.0.29 for ALGORITHM=INSTANT on generated columns).

# **5\. Database Access Control**

## **5.1 Role Architecture**

Three distinct MySQL users are created. Credentials are stored in .env (never in source control) and rotated quarterly.

| **User**           | **Privileges**                                                             | **Used by**                              |
| ------------------ | -------------------------------------------------------------------------- | ---------------------------------------- |
| dsc_user (runtime) | INSERT, UPDATE, SELECT, DELETE on dsc\_\* tables only. No DROP, no CREATE. | Scraper scheduler, Node.js app           |
| dsc_readonly       | SELECT on dsc\_\* tables only. No writes of any kind.                      | Reporting queries, WordPress integration |
| dsc_migrator       | All DDL privileges on the datorsc database. Used only during migrations.   | CI/CD pipeline, run.js                   |

\-- Create runtime user (run as root or admin) CREATE USER 'dsc*user'@'127.0.0.1' IDENTIFIED BY '&lt;strong-password&gt;'; GRANT SELECT, INSERT, UPDATE, DELETE ON datorsc.dsc_products TO 'dsc_user'@'127.0.0.1'; GRANT SELECT, INSERT, UPDATE, DELETE ON datorsc.dsc_prices TO 'dsc_user'@'127.0.0.1'; GRANT SELECT, INSERT, UPDATE, DELETE ON datorsc.dsc_price_history TO 'dsc_user'@'127.0.0.1'; GRANT SELECT, INSERT, UPDATE, DELETE ON datorsc.dsc_product_sources TO 'dsc_user'@'127.0.0.1'; GRANT SELECT, INSERT, UPDATE ON datorsc.dsc_scrape_log TO 'dsc_user'@'127.0.0.1'; -- Read-only for reporting CREATE USER 'dsc_readonly'@'%' IDENTIFIED BY '&lt;strong-password&gt;'; GRANT SELECT ON datorsc.dsc*\* TO 'dsc_readonly'@'%'; -- Migration user (CI only, not in .env.production) CREATE USER 'dsc_migrator'@'127.0.0.1' IDENTIFIED BY '&lt;strong-password&gt;'; GRANT ALL PRIVILEGES ON datorsc.\* TO 'dsc_migrator'@'127.0.0.1';

## **5.2 Connection Security**

- Require TLS for remote connections: ALTER USER … REQUIRE SSL;
- Bind MySQL to 127.0.0.1 only (bind-address = 127.0.0.1 in my.cnf) if the app and DB share a host.
- For cloud deployments, use a private VPC subnet - never expose port 3306 to the public internet.
- Store DB_PASSWORD in your secret manager (AWS Secrets Manager / GitHub Actions secrets), not in .env files checked into the repository.

# **6\. Backup & Recovery**

## **6.1 Backup Strategy**

Two complementary backup methods are used. Together they satisfy RPO ≤ 1 hour and RTO ≤ 4 hours for the database layer.

| **Method**             | **Details**                                                                                                                                                                 | **Purpose**                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Daily logical backup   | mysqldump --single-transaction (InnoDB, consistent snapshot, no table lock). Full dump of datorsc. Compressed with gzip. Uploaded to S3 / object storage. Retained 30 days. | RPO = 24h standalone, supplements binlog    |
| Binary log (binlog)    | MySQL binlog enabled in ROW format. Retained 7 days on server. Shipped to S3 hourly. Enables point-in-time recovery (PITR) to any second within the retention window.       | RPO = ~0 min, RTO = minutes to hours        |
| Pre-migration snapshot | mysqldump of datorsc triggered by the CI pipeline before any migration is applied. Retained 7 days. Named by migration file + timestamp.                                    | Instant rollback if migration corrupts data |

## **6.2 Backup Script**

# !/bin/bash # scripts/backup.sh - run via cron at 01:00 daily set -euo pipefail DB*NAME="\${DB_NAME:-datorsc}" DB_USER="\${DB_USER:-dsc_user}" S3_BUCKET="\${BACKUP_S3_BUCKET}" TIMESTAMP=\$(date +%Y%m%d*%H%M%S) FILENAME="datorsc\_\${TIMESTAMP}.sql.gz" # Consistent InnoDB dump - no table locks mysqldump \\ --single-transaction \\ --routines \\ --triggers \\ --events \\ --hex-blob \\ -u "\${DB_USER}" -p"\${DB_PASSWORD}" \\ "\${DB_NAME}" | gzip -9 > "/tmp/\${FILENAME}" # Upload to S3 with server-side encryption aws s3 cp "/tmp/\${FILENAME}" \\ "s3://\${S3_BUCKET}/daily/\${FILENAME}" \\ --storage-class STANDARD_IA \\ --sse aws:kms rm "/tmp/\${FILENAME}" echo "Backup complete: \${FILENAME}"

## **6.3 Recovery Runbook**

Point-in-time recovery (PITR) procedure - use when: data corruption discovered, accidental DELETE/UPDATE without WHERE clause, or post-incident investigation.

- Stop the scraper scheduler to prevent new writes: pm2 stop scheduler (or systemctl stop datorsc-scraper).
- Identify the target recovery timestamp (UTC) from application logs or dsc_scrape_log.
- Restore the most recent daily backup that predates the corruption:

gunzip -c datorsc_20260409_010000.sql.gz | mysql -u dsc_migrator -p datorsc

- Replay binary logs up to (but not including) the corruption timestamp:

mysqlbinlog --start-datetime="2026-04-09 01:00:01" \\ --stop-datetime="2026-04-09 14:29:59" \\ /var/log/mysql/binlog.\* | mysql -u dsc_migrator -p datorsc

- Verify row counts and spot-check dsc_prices against known values.
- Restart the scheduler.
- Document the incident in a post-mortem with timeline and root cause.

## **6.4 Backup Verification (Monthly)**

An automated job runs on the first Monday of each month in a staging environment:

- Restore the previous night's backup to a throwaway MySQL container.
- Run node migrations/run.js - all migrations should report "already applied".
- Execute a query validation suite (tests/db-smoke.js) verifying row counts, FK integrity, and index existence.
- Destroy the container. Log pass/fail to the ops dashboard.

# **7\. CI/CD Pipeline**

## **7.1 Pipeline Overview**

The pipeline uses GitHub Actions. The same workflow covers unit tests, migration safety checks, and deployment to production. There is no separate staging environment initially; the pre-migration backup serves as the safety net.

Push / PR to main branch │ ▼ ┌─────────────────────────────────────────────────────────┐ │ Job: test │ │ • npm ci │ │ • Start MySQL 8.0 service container │ │ • node migrations/run.js (applies all .sql files) │ │ • npm test (Jest unit + integration) │ └─────────────────────┬───────────────────────────────────┘ │ (only on push to main) ▼ ┌─────────────────────────────────────────────────────────┐ │ Job: deploy │ │ • SSH to production server │ │ • scripts/backup.sh (pre-migration snapshot) │ │ • git pull │ │ • npm ci --omit=dev │ │ • node migrations/run.js (idempotent - safe to run) │ │ • pm2 reload scheduler --update-env │ └─────────────────────────────────────────────────────────┘

## **7.2 GitHub Actions Workflow**

\# .github/workflows/deploy.yml name: Test & Deploy on: push: branches: \[main\] pull_request: branches: \[main\] jobs: test: runs-on: ubuntu-latest services: mysql: image: mysql:8.0 env: MYSQL_ROOT_PASSWORD: rootpass MYSQL_DATABASE: datorsc_test MYSQL_USER: dsc_user MYSQL_PASSWORD: testpass ports: \["3306:3306"\] options: --health-cmd="mysqladmin ping" --health-interval=10s env: DB_HOST: 127.0.0.1 DB_USER: dsc_user DB_PASSWORD: testpass DB_NAME: datorsc_test NODE_ENV: test steps: - uses: actions/checkout@v4 - uses: actions/setup-node@v4 with: { node-version: 20, cache: npm } - run: npm ci - run: node migrations/run.js - run: npm test deploy: needs: test if: github.ref == 'refs/heads/main' && github.event_name == 'push' runs-on: ubuntu-latest steps: - uses: actions/checkout@v4 - name: Deploy to production uses: appleboy/ssh-action@v1 with: host: \${{ secrets.PROD_HOST }} username: \${{ secrets.PROD_USER }} key: \${{ secrets.PROD_SSH_KEY }} script: | cd /srv/datorsc-scraper bash scripts/backup.sh git pull origin main npm ci --omit=dev DB_USER=\${{ secrets.DB_USER }} \\ DB_PASSWORD=\${{ secrets.DB_PASSWORD }} \\ node migrations/run.js pm2 reload scheduler --update-env

## **7.3 Scheduled Operational Jobs (Crontab)**

\# /etc/cron.d/datorsc # Daily DB backup at 01:00 0 1 \* \* \* dsc /srv/datorsc-scraper/scripts/backup.sh >> /var/log/dsc/backup.log 2>&1 # Ship binary logs to S3 hourly 5 \* \* \* \* dsc /srv/datorsc-scraper/scripts/ship-binlogs.sh >> /var/log/dsc/binlog.log 2>&1 # Add next partition to dsc_price_history (quarterly) 0 4 1 1,4,7,10 \* dsc node /srv/datorsc-scraper/scripts/add-partition.js # Monthly backup restore verification (first Monday, 05:00) 0 5 \* \* 1 dsc \[ \$(date +\\%d) -le 7 \] && /srv/datorsc-scraper/scripts/verify-backup.sh

# **8\. Monitoring & Alerting**

## **8.1 Key Metrics to Track**

| **Metric**               | **Source**                                           | **Alert Threshold**                                 |
| ------------------------ | ---------------------------------------------------- | --------------------------------------------------- |
| Scrape job duration      | dsc_scrape_log: finished_at - started_at             | Alert if > 2× median for source                     |
| Records upserted / run   | dsc_scrape_log.records_upserted                      | Alert if drops > 50% from rolling 7-day average     |
| Unmatched product ratio  | dsc_product_sources WHERE match_status = "unmatched" | Alert if > 20% per source run                       |
| Price staleness          | dsc_prices.scraped_at < NOW() - INTERVAL 25 HOUR     | Alert if any enabled source has stale rows          |
| Table row growth         | INFORMATION_SCHEMA.TABLES.TABLE_ROWS                 | Review partitioning if dsc_price_history > 50M rows |
| Replication lag (future) | SHOW REPLICA STATUS                                  | Alert if > 30s behind primary                       |
| Backup completion        | S3 object timestamp / backup.log                     | Alert via CloudWatch or healthchecks.io ping        |
| Proxy credit burn rate   | dsc_scrape_log.proxy_credits_used (sum, daily)       | Alert if > 80% of PROXY_BUDGET_CAP                  |

## **8.2 Useful Operational Queries**

\-- 1. Last run status per source SELECT source_id, status, records_upserted, proxy_credits_used, TIMESTAMPDIFF(MINUTE, started_at, IFNULL(finished_at, NOW())) AS duration_min FROM dsc_scrape_log WHERE started_at > NOW() - INTERVAL 24 HOUR ORDER BY started_at DESC; -- 2. Price drops > 10% in last 24h (for deal alerts) SELECT p.name, pr.retailer, pr.previous_price, pr.price_sek, ROUND((pr.previous_price - pr.price_sek) / pr.previous_price \* 100, 1) AS drop_pct FROM dsc_prices pr JOIN dsc_products p ON p.id = pr.product_id WHERE pr.previous_price IS NOT NULL AND pr.price_sek &lt; pr.previous_price \* 0.90 AND pr.scraped_at &gt; NOW() - INTERVAL 24 HOUR ORDER BY drop_pct DESC LIMIT 50; -- 3. Best price per product right now SELECT p.name, p.ean, MIN(pr.price_sek) AS best_price, (SELECT retailer FROM dsc_prices WHERE product_id = p.id ORDER BY price_sek LIMIT 1) AS cheapest_at FROM dsc_products p JOIN dsc_prices pr ON pr.product_id = p.id AND pr.in_stock = 1 GROUP BY p.id; -- 4. Unmatched sources backlog SELECT source_id, COUNT(\*) AS unmatched_count, MIN(scraped_at) AS oldest FROM dsc_product_sources WHERE match_status = 'unmatched' AND scraped_at > NOW() - INTERVAL 7 DAY GROUP BY source_id ORDER BY unmatched_count DESC;

# **9\. MySQL Server Configuration (my.cnf)**

The following settings are tuned for a dedicated scraper + web host with 8 GB RAM. Adjust innodb_buffer_pool_size to 50-70% of available RAM.

\# /etc/mysql/mysql.conf.d/datorsc.cnf \[mysqld\] # ── Basics ────────────────────────────────────────────────────────────── character-set-server = utf8mb4 collation-server = utf8mb4_unicode_ci default-time-zone = +00:00 bind-address = 127.0.0.1 # change to 0.0.0.0 for RDS-like remote # ── InnoDB ─────────────────────────────────────────────────────────────── innodb_buffer_pool_size = 4G # 50% of 8 GB RAM innodb_buffer_pool_instances = 4 # 1 per GB of pool innodb_log_file_size = 512M innodb_flush_log_at_trx_commit = 1 # full ACID; set to 2 for speed innodb_flush_method = O_DIRECT innodb_file_per_table = ON # ── Binary log (required for PITR) ─────────────────────────────────────── log_bin = /var/log/mysql/binlog binlog_format = ROW binlog_expire_logs_seconds = 604800 # 7 days sync_binlog = 1 server-id = 1 # unique across any future replicas # ── Slow query log ─────────────────────────────────────────────────────── slow_query_log = ON slow_query_log_file = /var/log/mysql/slow.log long_query_time = 1 log_queries_not_using_indexes = ON # ── Connections ────────────────────────────────────────────────────────── max_connections = 150 wait_timeout = 600 interactive_timeout = 600 # ── JSON & misc ────────────────────────────────────────────────────────── sql_mode = STRICT_TRANS_TABLES,NO_ZERO_IN_DATE, NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO, NO_ENGINE_SUBSTITUTION event_scheduler = ON # required for evt_purge_product_sources

# **10\. Scalability Roadmap**

The current single-primary setup comfortably handles the described workload. The following checkpoints indicate when to evolve the architecture:

| **Stage**                                 | **Architecture**                                                                                                     | **Action Required**                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Now → ~5M products                        | Single MySQL primary (current design). Partitioned price history. Optimised indexes.                                 | No change required                                 |
| 5M-20M products / high WP traffic         | Add a MySQL read replica. Point WordPress + dsc_readonly to replica. Primary handles scraper writes only.            | Set up replication, update connection strings      |
| \> 20M products or analytics queries > 5s | Add ClickHouse as an analytics sink. Pipe dsc_price_history via Kafka/Debezium CDC. Run trend queries on ClickHouse. | ClickHouse + CDC pipeline                          |
| Multi-region or >99.9% uptime SLA         | Migrate to AWS Aurora MySQL 8.0-compatible. Multi-AZ deployment, automated failover, managed backups.                | Aurora migration (mostly connection string change) |

# **11\. Security & Compliance**

## **11.1 Secrets Management**

- Never commit .env files. .env is in .gitignore. Use .env.example as the template.
- Production secrets live in GitHub Actions repository secrets or your cloud secret manager.
- Rotate DB_PASSWORD, SCRAPE_DO_TOKEN, and ZYTE_API_KEY quarterly. Update GitHub Secrets and re-deploy.

## **11.2 Data Minimisation (GDPR)**

The scraper processes publicly available product and price data - no personal data is collected. However:

- IP addresses used by Zyte / scrape.do proxies are not stored in the database.
- dsc_product_sources.raw_json may contain PII if a source accidentally includes reviewer data. Audit raw_json column contents quarterly and apply scrubbing if needed.
- The 90-day retention policy on dsc_product_sources limits the window of any incidental data exposure.

## **11.3 Dependency Security**

- Run npm audit in CI. Block deploys if any critical vulnerability is found in production dependencies.
- Pin the MySQL Docker image tag in GitHub Actions (mysql:8.0.39, not mysql:8.0) to prevent unexpected upstream changes.

# **12\. Testing Strategy**

## **12.1 Test Layers**

| **Layer**         | **Description**                                                                                                                                                            | **Location**                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Unit tests        | Jest + nock. Mock HTTP responses from Zyte/scrape.do. Assert that scraped HTML is parsed into the correct schema-valid object. No DB connection required.                  | tests/scrapers/\*.test.js    |
| Integration tests | Jest --runInBand. Spins up a real MySQL 8.0 container (GitHub Actions service). Applies all migrations. Runs upsert logic end-to-end. Asserts row counts and FK integrity. | tests/integration/\*.test.js |
| DB smoke tests    | Plain SQL assertions run post-migration and post-restore. Check table existence, index names, constraint names, and a sample SELECT.                                       | tests/db-smoke.js            |
| Schema validation | Zod schemas defined per-source validate every scraped record before DB write. Invalid records are logged to dsc_product_sources with match_status = "skipped".             | lib/validators/\*.js         |

## **12.2 DB Smoke Test Example**

// tests/db-smoke.js const checks = \[ \['dsc_products exists', 'SELECT COUNT(\*) FROM information_schema.tables WHERE table_name = "dsc_products"'\], \['price history partitioned','SELECT COUNT(\*) FROM information_schema.partitions WHERE table_name = "dsc_price_history"'\], \['FK: prices → products', 'SELECT COUNT(\*) FROM information_schema.key_column_usage WHERE constraint_name = "fk_prices_product"'\], \['event scheduler ON', 'SELECT @@event_scheduler'\], \]; // Each check must return a truthy / non-zero result

# **13\. Fresh Server Quick-Start Checklist**

Use this checklist when provisioning a new server or restoring from scratch.

### **Database setup**

- Install MySQL 8.0: apt install mysql-server-8.0 (Ubuntu) or use managed RDS.
- Apply /etc/mysql/mysql.conf.d/datorsc.cnf from Section 9, then systemctl restart mysql.
- Create database and users from Section 5.2.
- Run node migrations/run.js with DB_USER=dsc_migrator.
- Verify with node tests/db-smoke.js.

### **Application setup**

- Copy .env.example → .env, fill all required variables.
- npm ci --omit=dev
- npm test (will spin up MySQL service container).
- pm2 start lib/scheduler.js --name scheduler.

### **Backup & monitoring**

- Configure BACKUP_S3_BUCKET and AWS credentials.
- Install crontab entries from Section 7.3.
- Run scripts/backup.sh manually once to verify S3 upload.
- Configure your alerting tool to poll dsc_scrape_log.status != "ok" for the last 24h.

**✅ Done** Once all checkboxes are complete, all six core tables exist, binlog is shipping to S3, and the scheduler is running on cron. The system is production-ready.
