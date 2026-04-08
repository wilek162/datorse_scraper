'use strict';

const { z } = require('zod');
const logger = require('./logger');

// ─── Canonical product record schema ─────────────────────────────────────────

const ProductRecordSchema = z.object({
  ean:           z.string().regex(/^\d{8,14}$/, 'EAN must be 8–14 digits'),
  name:          z.string().min(3).max(512),
  retailer:      z.string().min(2).max(64),
  price_sek:     z.number().positive().max(500_000),
  in_stock:      z.boolean(),
  affiliate_url: z.string().url(),
  image_url:     z.string().url().optional().nullable(),
  scraped_at:    z.date(),
});

/**
 * Validates and normalises an array of raw parsed records.
 *
 * Returns { valid: ProductRecord[], invalid: { record, errors }[] }
 *
 * The caller is responsible for logging the summary; individual rejection
 * reasons are logged here at debug level so they don't flood logs.
 */
function validateRecords(rawRecords, sourceId) {
  const log = logger.forSource(sourceId);
  const valid = [];
  const invalid = [];

  for (const raw of rawRecords) {
    const result = ProductRecordSchema.safeParse(raw);
    if (result.success) {
      valid.push(result.data);
    } else {
      const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      log.debug('Record failed validation', { ean: raw.ean, name: raw.name, errors });
      invalid.push({ record: raw, errors });
    }
  }

  return { valid, invalid };
}

/**
 * Price sanity check: returns true if new price is suspiciously different
 * from the last known price (> 40% change in either direction).
 */
function isSuspiciousPriceChange(newPrice, lastPrice) {
  if (!lastPrice || lastPrice <= 0) return false;
  const ratio = Math.abs(newPrice - lastPrice) / lastPrice;
  return ratio > 0.40;
}

module.exports = { validateRecords, isSuspiciousPriceChange, ProductRecordSchema };
