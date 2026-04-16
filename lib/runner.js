"use strict";

const path = require("path");
const logger = require("./logger");
const db = require("./db");
const proxy = require("./proxy");
const { validateRecords } = require("./validate");
const { getItemLimit, limitRecords } = require("./source-controls");
const { resolveSourceRecords } = require("./resolver");

function normaliseRunResult(runResult) {
  if (Array.isArray(runResult)) {
    return { records: runResult, meta: {} };
  }

  if (runResult && Array.isArray(runResult.records)) {
    return {
      records: runResult.records,
      meta: runResult.meta || {},
    };
  }

  return { records: [], meta: {} };
}

function diffUsage(before, after) {
  return {
    scrapeDo: Math.max((after.scrapeDo || 0) - (before.scrapeDo || 0), 0),
    zyte: Math.max((after.zyte || 0) - (before.zyte || 0), 0),
  };
}

function estimateProxyCostUsd(usageDelta) {
  const scrapeDoRate = Number(process.env.SCRAPE_DO_COST_PER_CREDIT_USD || 0);
  const zyteRate = Number(process.env.ZYTE_COST_PER_CREDIT_USD || 0);
  const total = usageDelta.scrapeDo * scrapeDoRate + usageDelta.zyte * zyteRate;

  return total > 0 ? Number(total.toFixed(4)) : null;
}

/**
 * Validates one batch of records, saves to dsc_product_sources, upserts
 * canonical tables (dsc_products, dsc_prices, dsc_price_history), and runs
 * the resolver. Called once per flush (page-level) and once at end-of-run
 * for any fallback records returned by run().
 *
 * Does NOT mutate acc.recordsFound — callers manage that counter so that
 * flush failures don't cause double-counting when the batch falls back to
 * the end-of-run path.
 *
 * NOTE: saveValidationResults() is a plain bulk INSERT (not idempotent).
 * Each batch must be passed here exactly once. If _processBatch throws after
 * saveValidationResults but before upserts complete, and the scraper falls
 * back to allRecords, the end-of-run path will call _processBatch again →
 * duplicate rows in dsc_product_sources (audit table only, no data corruption).
 *
 * @param {object} opts
 * @param {number}   opts.logId
 * @param {string}   opts.sourceId
 * @param {object}   opts.sourceConfig
 * @param {object[]} opts.rawBatch
 * @param {object}   opts.log
 * @param {object}   opts.acc  - mutable cross-batch counter accumulator
 */
async function _processBatch({ logId, sourceId, sourceConfig, rawBatch, log, acc }) {
  if (!rawBatch || rawBatch.length === 0) return;

  const { valid, unresolved, invalid } = validateRecords(rawBatch, sourceId);
  acc.recordsValid += valid.length;
  acc.unresolvedCount += unresolved.length;

  await db.saveValidationResults(logId, sourceId, { valid, unresolved, invalid });

  if (unresolved.length > 0) {
    log.warn(
      `${unresolved.length} records missing canonical identifiers; persisted as unmatched`,
    );
  }
  if (invalid.length > 0) {
    log.warn(`${invalid.length} records failed validation`);
  }

  const eanUpserted = [];
  let batchSuspicious = 0;
  let batchFailed = 0;
  let batchSkippedProtected = 0;

  if (!sourceConfig.dryRun) {
    for (const record of valid) {
      try {
        const result = await db.upsertProduct(record, sourceId);
        if (result.upserted) acc.recordsUpserted++;
        if (result.suspicious) batchSuspicious++;
        if (result.skippedProtected) batchSkippedProtected++;
        if (result.productId) {
          eanUpserted.push({ record, productId: result.productId });
        }
      } catch (err) {
        batchFailed++;
        log.error("Failed to upsert record", {
          ean: record.ean,
          err: err.message,
        });
      }
    }

    acc.suspicious += batchSuspicious;
    acc.failed += batchFailed;
    acc.skippedProtected += batchSkippedProtected;

    if (batchSuspicious > 0)
      log.warn(`${batchSuspicious} records had suspicious price changes`);
    if (batchSkippedProtected > 0)
      log.info(
        `${batchSkippedProtected} records skipped (protected by dedicated scraper)`,
      );
    if (batchFailed > 0) log.error(`${batchFailed} records failed DB upsert`);

    if (eanUpserted.length > 0 || unresolved.length > 0) {
      try {
        const resolveResult = await resolveSourceRecords(
          logId,
          sourceId,
          eanUpserted,
          unresolved,
        );
        // resolveResult.matched includes EAN-linked records already counted above;
        // subtract eanUpserted.length to get only the net-new external_id resolutions.
        acc.recordsUpserted += resolveResult.matched - eanUpserted.length;
        if (resolveResult.matched > 0) {
          log.info(
            `Resolver promoted ${resolveResult.matched} records to canonical`,
            {
              eanLinked: eanUpserted.length,
              extIdResolved: resolveResult.matched - eanUpserted.length,
            },
          );
        }
      } catch (err) {
        log.error("Resolver stage failed", { err: err.message });
      }
    }
  }
}

/**
 * Runs a single source job end-to-end:
 *   1. Dynamically require the source module
 *   2. Call module.run(sourceConfig, ctx) — scrapers call ctx.flush(batch) after
 *      each listing page to write records incrementally to the DB
 *   3. Process any records returned from run() (fallback for unmigrated scrapers
 *      or when a flush failed mid-run)
 *   4. Write a scrape_log entry
 *
 * ctx.flush(batch) is the key resilience mechanism: records are committed
 * page-by-page so that a SIGTERM or proxy error mid-run does not lose all
 * previously collected data.
 *
 * @param {object} sourceConfig - Entry from sources.json
 */
async function runSource(sourceConfig) {
  const { id } = sourceConfig;
  const log = logger.forSource(id);
  const logId = await db.startScrapeLog(id);
  const usageBefore = proxy.getUsage();

  // Shared accumulator across all flush batches and end-of-run fallback.
  // recordsFound is managed by callers (not inside _processBatch) to avoid
  // double-counting when a flush fails and the batch falls back to allRecords.
  const acc = {
    recordsFound: 0,
    recordsValid: 0,
    recordsUpserted: 0,
    suspicious: 0,
    failed: 0,
    skippedProtected: 0,
    unresolvedCount: 0,
  };

  let pagesFetched = 0;
  let status = "ok";
  let errorMessage = null;

  // Build the flush context passed to scrapers.
  // flush() returns true if the batch was saved to DB, false on error.
  // When false, the scraper falls back to allRecords so the end-of-run path
  // can process those records.
  const ctx = {
    logId,
    flush: async (batch) => {
      if (!batch || batch.length === 0) return true;
      try {
        await _processBatch({
          logId,
          sourceId: id,
          sourceConfig,
          rawBatch: batch,
          log,
          acc,
        });
        acc.recordsFound += batch.length;
        return true;
      } catch (err) {
        log.error("Flush failed; batch held in memory for end-of-run save", {
          batchSize: batch.length,
          err: err.message,
        });
        return false;
      }
    },
  };

  try {
    const modulePath = path.resolve(__dirname, "..", sourceConfig.module);
    const sourceModule = require(modulePath);

    log.info("Starting run");

    // Pass ctx as second argument. Scrapers that haven't been migrated to use
    // ctx.flush receive it and ignore it (ctx = {} default), falling back to
    // returning all records at the end of run().
    const runResult = await sourceModule.run(sourceConfig, ctx);
    const { records: sourceRecords, meta } = normaliseRunResult(runResult);
    pagesFetched = meta.pagesFetched ?? 0;

    // End-of-run fallback: process any records the scraper returned.
    // Fully-migrated scrapers return [] here; unmigrated scrapers or ones
    // where some flush calls failed return their accumulated allRecords.
    const itemLimit = getItemLimit(sourceConfig);
    const rawRecords = limitRecords(sourceRecords, itemLimit);

    if (
      Array.isArray(sourceRecords) &&
      sourceRecords.length !== rawRecords.length
    ) {
      log.info("Applied runner item limit fallback", {
        sourceRecords: sourceRecords.length,
        keptRecords: rawRecords.length,
      });
    }

    if (rawRecords.length > 0) {
      log.info(
        `Processing ${rawRecords.length} fallback records from run() return value`,
      );
      acc.recordsFound += rawRecords.length;
      await _processBatch({
        logId,
        sourceId: id,
        sourceConfig,
        rawBatch: rawRecords,
        log,
        acc,
      });
    }

    log.info(`Fetched ${acc.recordsFound} raw records`);

    const {
      recordsFound,
      recordsValid,
      recordsUpserted,
      suspicious,
      failed,
      unresolvedCount,
    } = acc;

    if (sourceConfig.dryRun) {
      status = "ok";
      errorMessage = null;
    } else if (recordsUpserted > 0) {
      status = "ok";
    } else if (recordsFound === 0) {
      status = "partial";
      errorMessage = "No records fetched";
    } else if (unresolvedCount > 0 && recordsValid === 0) {
      status = "partial";
      errorMessage = "Records fetched but none resolved to canonical products";
    } else if (recordsValid === 0 && recordsFound > 0) {
      status = "partial";
      errorMessage = "All records failed validation";
    } else if (failed > 0 && recordsUpserted === 0) {
      status = "failed";
      errorMessage = `All ${failed} upserts failed`;
    } else if (failed > 0 || suspicious > 0) {
      status = "partial";
      errorMessage = `suspicious=${suspicious}, failed=${failed}`;
    }

    log.info("Run complete", {
      recordsFound,
      recordsValid,
      recordsUpserted,
      status,
    });
  } catch (err) {
    status = "failed";
    errorMessage = err.message;
    log.error("Run failed", { err: err.message, stack: err.stack });
    await _alertIfRepeatedFailure(id, log);
  } finally {
    const usageAfter = proxy.getUsage();
    const usageDelta = diffUsage(usageBefore, usageAfter);
    const proxyCreditsUsed = usageDelta.scrapeDo + usageDelta.zyte;
    const proxyCostUsd = estimateProxyCostUsd(usageDelta);
    if (pagesFetched === 0 && proxyCreditsUsed > 0) {
      pagesFetched = proxyCreditsUsed;
    }

    await db.finishScrapeLog(logId, {
      recordsFound: acc.recordsFound,
      recordsValid: acc.recordsValid,
      recordsUpserted: acc.recordsUpserted,
      proxyCreditsUsed,
      proxyCostUsd,
      pagesFetched,
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
    const allFailed =
      recent.length >= 2 && recent.every((r) => r.status === "failed");
    if (allFailed) {
      log.error(`ALERT: ${sourceId} has failed 2 consecutive runs`);
      // Future: send email via Nodemailer here
    }
  } catch (e) {
    log.warn("Could not check failure history", { err: e.message });
  }
}

module.exports = {
  runSource,
  diffUsage,
  estimateProxyCostUsd,
  normaliseRunResult,
};
