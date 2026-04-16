"use strict";

/**
 * lib/resolver.js
 *
 * Layer 2: Resolve
 *
 * Turns source observations (from dsc_product_sources) into canonical
 * products and accepted merchant offers.
 *
 * Resolution priority (per architecture doc):
 *   1. Exact EAN/GTIN  → use existing upsertProduct path (already handled by runner)
 *   2. source_id + external_id  → create/find canonical product by source identity
 *   3. Leave unresolved when neither is available (no silent guessing)
 *
 * Caller: lib/runner.js — invoked after validation results are saved.
 *
 * Design notes:
 *   - Idempotent: re-running on the same logId is safe (LIMIT 1 UPDATE)
 *   - Scalable: same resolver handles any future source, not Prisjakt-specific
 *   - No heuristic name-matching at this stage (deferred per architecture doc)
 */

const db = require("./db");
const logger = require("./logger");

/**
 * After runner has:
 *   - saved all source rows to dsc_product_sources (match_status = 'unmatched')
 *   - upserted EAN-valid records into canonical tables via upsertProduct()
 *
 * This function:
 *   1. Updates dsc_product_sources.match_status = 'matched' for EAN records
 *      that were successfully upserted (eanUpserted[]).
 *   2. Promotes unresolved records (no EAN, has external_id) to canonical
 *      products and offers, then marks them matched too.
 *
 * @param {number}   logId         - dsc_scrape_log.id for this run
 * @param {string}   sourceId      - source key (e.g. 'prisjakt')
 * @param {object[]} eanUpserted   - [{record, productId}] from EAN upsert loop
 * @param {object[]} unresolved    - validated records without EAN
 * @returns {{ matched: number, skipped: number }}
 */
async function resolveSourceRecords(logId, sourceId, eanUpserted, unresolved) {
  const log = logger.forSource(sourceId);
  let matched = 0;
  let skipped = 0;

  // ── 1. Mark EAN-based records as matched in dsc_product_sources ────────────
  for (const { record, productId } of eanUpserted) {
    if (!productId) continue;
    try {
      await db.markProductSourceMatched(
        logId,
        sourceId,
        record.ean,
        null,
        productId,
      );
      matched++;
    } catch (err) {
      log.warn("Could not mark EAN record as matched in product_sources", {
        ean: record.ean,
        productId,
        err: err.message,
      });
    }
  }

  // ── 2. Resolve unresolved records via external_id ──────────────────────────
  for (const record of unresolved) {
    const extId = record.external_id ?? record.externalId ?? null;

    if (!extId) {
      log.debug("Unresolved record has no external_id; skipping", {
        name: record.name,
      });
      skipped++;
      continue;
    }

    try {
      // Find or create canonical product by (sourceId, extId)
      const { productId, isNew } = await db.upsertProductByExternalId(
        record,
        sourceId,
      );

      if (!productId) {
        log.warn("upsertProductByExternalId returned no productId", { extId });
        skipped++;
        continue;
      }

      log.debug(`${isNew ? "Created" : "Found"} canonical product`, {
        extId,
        productId,
        name: record.name,
      });

      // Upsert the current price offer and append history if changed
      await db.upsertOfferPrice(productId, record, sourceId);

      // Update source row to matched
      await db.markProductSourceMatched(
        logId,
        sourceId,
        null,
        extId,
        productId,
      );
      matched++;
    } catch (err) {
      log.error("Failed to resolve unresolved record", {
        extId,
        name: record.name,
        err: err.message,
      });
      skipped++;
    }
  }

  log.info("Resolver complete", { matched, skipped });
  return { matched, skipped };
}

module.exports = { resolveSourceRecords };
