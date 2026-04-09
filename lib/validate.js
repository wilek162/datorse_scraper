"use strict";

const { z } = require("zod");
const logger = require("./logger");

// ─── Canonical product record schema ─────────────────────────────────────────

const BaseSourceRecordSchema = z.object({
  name: z.string().min(3).max(512),
  retailer: z.string().min(2).max(64),
  price_sek: z.number().positive().max(500_000),
  in_stock: z.boolean(),
  affiliate_url: z.string().url(),
  image_url: z.string().url().optional().nullable(),
  scraped_at: z.date(),
  external_id: z.string().min(1).max(255).optional(),
  externalId: z.string().min(1).max(255).optional(),
  brand: z.string().min(1).max(128).optional().nullable(),
});

const ProductRecordSchema = BaseSourceRecordSchema.extend({
  ean: z.string().regex(/^\d{8,14}$/, "EAN must be 8–14 digits"),
});

const UnresolvedProductRecordSchema = BaseSourceRecordSchema.extend({
  ean: z.null().optional(),
});

/**
 * Validates and normalises an array of raw parsed records.
 *
 * Returns {
 *   valid: ProductRecord[],
 *   unresolved: object[],
 *   invalid: { record, errors }[]
 * }
 *
 * The caller is responsible for logging the summary; individual rejection
 * reasons are logged here at debug level so they don't flood logs.
 */
function validateRecords(rawRecords, sourceId) {
  const log = logger.forSource(sourceId);
  const valid = [];
  const unresolved = [];
  const invalid = [];

  for (const raw of rawRecords) {
    const canonicalResult = ProductRecordSchema.safeParse(raw);
    if (canonicalResult.success) {
      valid.push(canonicalResult.data);
    } else {
      const unresolvedResult = UnresolvedProductRecordSchema.safeParse(raw);
      if (unresolvedResult.success) {
        unresolved.push(unresolvedResult.data);
        continue;
      }

      const errors = canonicalResult.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      );
      log.debug("Record failed validation", {
        ean: raw.ean,
        name: raw.name,
        errors,
      });
      invalid.push({ record: raw, errors });
    }
  }

  return { valid, unresolved, invalid };
}

/**
 * Price sanity check: returns true if new price is suspiciously different
 * from the last known price (> 40% change in either direction).
 */
function isSuspiciousPriceChange(newPrice, lastPrice) {
  if (!lastPrice || lastPrice <= 0) return false;
  const ratio = Math.abs(newPrice - lastPrice) / lastPrice;
  return ratio > 0.4;
}

module.exports = {
  validateRecords,
  isSuspiciousPriceChange,
  ProductRecordSchema,
  UnresolvedProductRecordSchema,
};
