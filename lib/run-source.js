#!/usr/bin/env node
'use strict';

// Usage: node lib/run-source.js <source_id>
// Example: node lib/run-source.js webhallen

require('dotenv').config();
const path = require('path');
const logger = require('./logger');
const db     = require('./db');
const { runSource } = require('./runner');

function loadSources() {
  const raw = require('fs').readFileSync(
    path.join(__dirname, '..', 'config', 'sources.json'),
    'utf-8',
  );
  return JSON.parse(raw.replace(/\/\/.*$/gm, ''));
}

const sourceId = process.argv[2];

if (!sourceId) {
  console.error('Usage: node lib/run-source.js <source_id>');
  process.exit(1);
}

const sources = loadSources();
const source  = sources.find((s) => s.id === sourceId);

if (!source) {
  console.error(`Unknown source: "${sourceId}". Available: ${sources.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

logger.info(`Manually running source: ${sourceId}`);

runSource(source)
  .then(async () => {
    logger.info('Manual run complete');
    await db.closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error('Manual run failed', { err: err.message });
    await db.closePool();
    process.exit(1);
  });
