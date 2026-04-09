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
  const log = logger.forSource(id);
  const logId = await db.startScrapeLog(id);
  const usageBefore = proxy.getUsage();

  let recordsFound = 0;
  let recordsValid = 0;
  let recordsUpserted = 0;
  let proxyCreditsUsed = 0;
  let proxyCostUsd = null;
  let pagesFetched = 0;
  let status = "ok";
  let errorMessage = null;

  try {
    // Dynamically load the source module (feeds/ or scrapers/)
    const modulePath = path.resolve(__dirname, "..", sourceConfig.module);
    const sourceModule = require(modulePath);

    log.info("Starting run");

    const runResult = await sourceModule.run(sourceConfig);
    const { records: sourceRecords, meta } = normaliseRunResult(runResult);
    const itemLimit = getItemLimit(sourceConfig);
    const rawRecords = limitRecords(sourceRecords, itemLimit);
    recordsFound = Array.isArray(rawRecords) ? rawRecords.length : 0;
    pagesFetched = meta.pagesFetched ?? 0;

    log.info(`Fetched ${recordsFound} raw records`);

    if (
      Array.isArray(sourceRecords) &&
      sourceRecords.length !== rawRecords.length
    ) {
      log.info("Applied runner item limit fallback", {
        sourceRecords: sourceRecords.length,
        keptRecords: rawRecords.length,
      });
    }

    const { valid, unresolved, invalid } = validateRecords(rawRecords, id);
    recordsValid = valid.length;

    await db.saveValidationResults(logId, id, { valid, unresolved, invalid });

    if (unresolved.length > 0) {
      log.warn(
        `${unresolved.length} records missing canonical identifiers; persisted as unmatched`,
      );
    }

    if (invalid.length > 0) {
      log.warn(`${invalid.length} records failed validation`);
    }

    // Upsert EAN-valid records — collect productIds for resolver
    let suspicious = 0;
    let failed = 0;
    const eanUpserted = []; // [{ record, productId }]

    for (const record of valid) {
      if (sourceConfig.dryRun) continue;

      try {
        const result = await db.upsertProduct(record, id);
        if (result.upserted) recordsUpserted++;
        if (result.suspicious) suspicious++;
        if (result.productId) {
          eanUpserted.push({ record, productId: result.productId });
        }
      } catch (err) {
        failed++;
        log.error("Failed to upsert record", {
          ean: record.ean,
          err: err.message,
        });
      }
    }

    if (suspicious > 0)
      log.warn(`${suspicious} records had suspicious price changes`);
    if (failed > 0) log.error(`${failed} records failed DB upsert`);

    // ── Resolver: promote unresolved records + mark EAN records matched ──────
    if (
      !sourceConfig.dryRun &&
      (eanUpserted.length > 0 || unresolved.length > 0)
    ) {
      try {
        const resolveResult = await resolveSourceRecords(
          logId,
          id,
          eanUpserted,
          unresolved,
        );
        recordsUpserted += resolveResult.matched - eanUpserted.length;
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
    // ─────────────────────────────────────────────────────────────────────────

    const totalResolved = recordsUpserted;

    if (sourceConfig.dryRun) {
      status = "ok";
      errorMessage = null;
    } else if (totalResolved > 0) {
      status = "ok";
    } else if (recordsFound === 0) {
      status = "partial";
      errorMessage = "No records fetched";
    } else if (unresolved.length > 0 && recordsValid === 0) {
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
    proxyCreditsUsed = usageDelta.scrapeDo + usageDelta.zyte;
    proxyCostUsd = estimateProxyCostUsd(usageDelta);
    if (pagesFetched === 0 && proxyCreditsUsed > 0) {
      pagesFetched = proxyCreditsUsed;
    }

    await db.finishScrapeLog(logId, {
      recordsFound,
      recordsValid,
      recordsUpserted,
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
