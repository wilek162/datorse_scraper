#!/usr/bin/env node
"use strict";

require("dotenv").config();
const mysql = require("mysql2/promise");

function getBoundaryForHalfYear(year, half) {
  return half === 1 ? `${year}-07-01 00:00:00` : `${year + 1}-01-01 00:00:00`;
}

function getHalfYearPartitionName(year, half) {
  return `p${year}_${half === 1 ? "h1" : "h2"}`;
}

function getHalfYear(date) {
  return date.getUTCMonth() < 6 ? 1 : 2;
}

function nextHalfYears(startDate, count) {
  const result = [];
  let year = startDate.getUTCFullYear();
  let half = getHalfYear(startDate);

  for (let index = 0; index < count; index += 1) {
    if (half === 1) {
      result.push({ year, half: 1 });
      half = 2;
    } else {
      result.push({ year, half: 2 });
      year += 1;
      half = 1;
    }
  }

  return result;
}

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "datorsc",
  });

  const [existing] = await connection.execute(
    `SELECT partition_name
     FROM information_schema.partitions
     WHERE table_schema = DATABASE()
       AND table_name = 'dsc_price_history'
       AND partition_name IS NOT NULL`,
  );

  const existingNames = new Set(existing.map((row) => row.partition_name));
  const today = new Date();
  const activeHalfYear = {
    year: today.getUTCFullYear(),
    half: getHalfYear(today),
  };
  const targets = nextHalfYears(
    new Date(
      Date.UTC(activeHalfYear.year, activeHalfYear.half === 1 ? 6 : 12, 1),
    ),
    2,
  );

  for (const target of targets) {
    const partitionName = getHalfYearPartitionName(target.year, target.half);
    if (existingNames.has(partitionName)) continue;

    const boundary = getBoundaryForHalfYear(target.year, target.half);
    const sql = `ALTER TABLE dsc_price_history REORGANIZE PARTITION p_future INTO (
      PARTITION ${partitionName} VALUES LESS THAN ('${boundary}'),
      PARTITION p_future VALUES LESS THAN (MAXVALUE)
    )`;

    await connection.execute(sql);
    existingNames.add(partitionName);
    process.stdout.write(`Added partition ${partitionName} < ${boundary}\n`);
  }

  await connection.end();
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
