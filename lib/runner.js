'use strict';

const path   = require('path');
const logger = require('./logger');
const db     = require('./db');
const { validateRecords } = require('./validate');

/**
 * Runs a single source job end-to-end:
 *   1. Dynamically require the source module
 *   2. Call module.run(sourceConfig) → raw records[]
 *   3. Validate records
 *   4. UPSERT each valid record into the DB
 *   5. Write a scrape_log entry
 *
 * @param {object} sourceConfig - Entry from sources.json
 */
async function runSource(sourceConfig) {
  const { id } = sourceConfig;
  const log    = logger.forSource(id);
  const logId  = await db.startScrapeLog(id);

  let recordsFound    = 0;
  let recordsValid    = 0;
  let recordsUpserted = 0;
  let status          = 'ok';
  let errorMessage    = null;

  try {
    // Dynamically load the source module (feeds/ or scrapers/)
    const modulePath = path.resolve(__dirname, '..', sourceConfig.module);
    const sourceModule = require(modulePath);

    log.info('Starting run');

    const rawRecords = await sourceModule.run(sourceConfig);
    recordsFound = Array.isArray(rawRecords) ? rawRecords.length : 0;

    log.info(`Fetched ${recordsFound} raw records`);

    const { valid, invalid } = validateRecords(rawRecords, id);
    recordsValid = valid.length;

    if (invalid.length > 0) {
      log.warn(`${invalid.length} records failed validation`);
    }

    // Upsert valid records — collect suspicious/failed counts
    let suspicious = 0;
    let failed     = 0;

    for (const record of valid) {
      try {
        const result = await db.upsertProduct(record, id);
        if (result.upserted)    recordsUpserted++;
        if (result.suspicious)  suspicious++;
      } catch (err) {
        failed++;
        log.error('Failed to upsert record', { ean: record.ean, err: err.message });
      }
    }

    if (suspicious > 0) log.warn(`${suspicious} records had suspicious price changes`);
    if (failed > 0)     log.error(`${failed} records failed DB upsert`);

    if (recordsValid === 0 && recordsFound > 0) {
      status = 'partial';
      errorMessage = 'All records failed validation';
    } else if (failed > 0 && recordsUpserted === 0) {
      status = 'failed';
      errorMessage = `All ${failed} upserts failed`;
    } else if (failed > 0 || suspicious > 0) {
      status = 'partial';
      errorMessage = `suspicious=${suspicious}, failed=${failed}`;
    }

    log.info('Run complete', { recordsFound, recordsValid, recordsUpserted, status });

  } catch (err) {
    status       = 'failed';
    errorMessage = err.message;
    log.error('Run failed', { err: err.message, stack: err.stack });
    await _alertIfRepeatedFailure(id, log);
  } finally {
    await db.finishScrapeLog(logId, {
      recordsFound,
      recordsValid,
      recordsUpserted,
      status,
      errorMessage,
    });
  }
}

/**
 * Checks if the last N runs all failed; if so, triggers an alert.
 * Alert delivery is fire-and-forget (don't let it block the pipeline).
 */
async function _alertIfRepeatedFailure(sourceId, log) {
  try {
    const recent = await db.getLastFailedRuns(sourceId, 2);
    const allFailed = recent.length >= 2 && recent.every((r) => r.status === 'failed');
    if (allFailed) {
      log.error(`ALERT: ${sourceId} has failed 2 consecutive runs`);
      // Future: send email via Nodemailer here
    }
  } catch (e) {
    log.warn('Could not check failure history', { err: e.message });
  }
}

module.exports = { runSource };
