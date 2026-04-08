'use strict';

const cheerio = require('cheerio');

/**
 * Load HTML into a Cheerio instance.
 * @param {string} html
 * @returns {CheerioAPI}
 */
function load(html) {
  return cheerio.load(html, { decodeEntities: true });
}

/**
 * Safely extracts text from a selector, returning null if not found.
 * Trims whitespace and collapses internal whitespace.
 * @param {CheerioAPI} $ 
 * @param {string} selector
 * @returns {string|null}
 */
function text($, selector) {
  const el = $(selector).first();
  if (!el.length) return null;
  return el.text().replace(/\s+/g, ' ').trim() || null;
}

/**
 * Extracts a numeric price from a string like "1 299 kr", "2,499.00 SEK", "1299:-"
 * Returns null if parsing fails.
 * @param {string} rawPrice
 * @returns {number|null}
 */
function parsePrice(rawPrice) {
  if (!rawPrice) return null;
  // Remove currency symbols, spaces (including non-breaking), colons, dashes
  const cleaned = rawPrice
    .replace(/[^\d.,]/g, '')   // keep only digits, dots, commas
    .replace(/,(\d{3})/g, '$1') // 1,299 → 1299 (thousands separator comma)
    .replace(/\.(\d{3})/g, '$1') // 1.299 → 1299 (thousands separator dot)
    .replace(',', '.')           // 1299,50 → 1299.50 (decimal comma)
    .trim();

  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/**
 * Extracts stock status from common Swedish in-stock/out-of-stock text.
 * Returns true (in stock) or false (out of stock). Defaults to true if ambiguous.
 */
function parseStockStatus(rawText) {
  if (!rawText) return true;
  const lower = rawText.toLowerCase();
  const outPatterns = [
    'slut', 'slutsåld', 'ej i lager', 'out of stock', 'not available',
    'beställningsvara', 'restorder', '0 i lager',
  ];
  return !outPatterns.some((p) => lower.includes(p));
}

/**
 * Cleans an EAN string — strips hyphens and whitespace.
 * Returns null if result isn't 8–14 digits.
 */
function parseEan(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-]/g, '');
  return /^\d{8,14}$/.test(cleaned) ? cleaned : null;
}

/**
 * Parses JSON-LD structured data from a page if present.
 * Useful as a first-pass attempt before falling back to CSS selectors.
 */
function parseJsonLd($) {
  const scripts = $('script[type="application/ld+json"]');
  const results = [];
  scripts.each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      if (Array.isArray(data)) results.push(...data);
      else results.push(data);
    } catch (_) { /* malformed LD+JSON — skip */ }
  });
  return results;
}

module.exports = { load, text, parsePrice, parseStockStatus, parseEan, parseJsonLd };
