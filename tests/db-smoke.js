#!/usr/bin/env node
"use strict";

require("dotenv").config();
const mysql = require("mysql2/promise");

async function scalar(connection, sql) {
  const [rows] = await connection.query(sql);
  const firstRow = rows[0] || {};
  const firstValue = firstRow[Object.keys(firstRow)[0]];
  return firstValue;
}

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "datorsc",
  });

  const checks = [
    {
      name: "dsc_products exists",
      sql: `SELECT COUNT(*) AS value
            FROM information_schema.tables
            WHERE table_schema = DATABASE()
              AND table_name = 'dsc_products'`,
    },
    {
      name: "dsc_price_history partitioned",
      sql: `SELECT COUNT(*) AS value
            FROM information_schema.partitions
            WHERE table_schema = DATABASE()
              AND table_name = 'dsc_price_history'
              AND partition_name IS NOT NULL`,
    },
    {
      name: "history primary key includes recorded_at",
      sql: `SELECT COUNT(*) AS value
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = 'dsc_price_history'
              AND index_name = 'PRIMARY'
              AND column_name = 'recorded_at'`,
    },
    {
      name: "history has product index",
      sql: `SELECT COUNT(*) AS value
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = 'dsc_price_history'
              AND index_name = 'idx_ph_product'`,
    },
    {
      name: "history intentionally has no foreign key",
      sql: `SELECT COUNT(*) = 0 AS value
            FROM information_schema.referential_constraints
            WHERE constraint_schema = DATABASE()
              AND table_name = 'dsc_price_history'`,
    },
    {
      name: "raw payload purge event exists",
      sql: `SELECT COUNT(*) AS value
            FROM information_schema.events
            WHERE event_schema = DATABASE()
              AND event_name = 'evt_purge_product_sources'`,
    },
  ];

  let failed = false;

  for (const check of checks) {
    const value = await scalar(connection, check.sql);
    const ok = Boolean(Number(value));
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${check.name}: ${value}\n`);
    if (!ok) failed = true;
  }

  await connection.end();

  if (failed) {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
