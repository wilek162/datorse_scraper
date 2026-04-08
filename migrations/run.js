#!/usr/bin/env node
'use strict';

// Applies all pending SQL migration files in order.
// Tracks applied migrations in a dsc_migrations table.
// Usage: node migrations/run.js

require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const mysql  = require('mysql2/promise');
const logger = require('../lib/logger');

const MIGRATIONS_DIR = __dirname;

async function run() {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || '127.0.0.1',
    port:     Number(process.env.DB_PORT || 3306),
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME     || 'datorsc',
    multipleStatements: true,
  });

  // Ensure tracking table exists
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS dsc_migrations (
      filename    VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at  DATETIME     NOT NULL DEFAULT NOW()
    ) ENGINE=InnoDB
  `);

  const [applied] = await conn.execute('SELECT filename FROM dsc_migrations');
  const appliedSet = new Set(applied.map((r) => r.filename));

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) {
      logger.info(`[migrations] Already applied: ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    logger.info(`[migrations] Applying: ${file}`);
    await conn.query(sql);
    await conn.execute('INSERT INTO dsc_migrations (filename) VALUES (?)', [file]);
    logger.info(`[migrations] Done: ${file}`);
  }

  await conn.end();
  logger.info('[migrations] All migrations applied');
}

run().catch((err) => {
  logger.error('[migrations] Failed', { err: err.message });
  process.exit(1);
});
