'use strict';

require('dotenv').config();
const axios   = require('axios');
const { parse } = require('csv-parse/sync');
const logger  = require('../lib/logger');

// Awin publisher feed endpoint
// Each approved advertiser has its own feed URL, typically:
//   https://productdata.awin.com/datafeed/download/apikey/{API_KEY}/language/en/fid/{FEED_ID}/...
//
// The module iterates over all configured feed URLs.
// Add new merchants by appending their feed URL to AWIN_FEED_URLS in .env.
//
// .env format: AWIN_FEED_URLS=https://...url1...,https://...url2...

const AWIN_API_KEY = process.env.AWIN_API_KEY;

function getFeedUrls() {
  const raw = process.env.AWIN_FEED_URLS || '';
  return raw.split(',').map((u) => u.trim()).filter(Boolean);
}

/**
 * Maps an Awin CSV row to our canonical ProductRecord shape.
 * Awin feed column names vary slightly per merchant; we handle common aliases.
 */
function mapAwinRow(row, retailer) {
  const price = parseFloat(row['Selling Price'] || row['Price'] || row['price'] || '0');
  const ean   = (row['EAN'] || row['GTIN'] || row['ean'] || '').replace(/\s/g, '');

  return {
    ean:           ean || null,
    name:          row['Product Name'] || row['Name'] || row['name'],
    retailer,
    price_sek:     price,
    in_stock:      (row['In Stock'] || row['Stock'] || '1').toString() !== '0',
    affiliate_url: row['Affiliate URL'] || row['Deep Link'] || row['deeplink'],
    image_url:     row['Image URL'] || row['image_url'] || null,
    scraped_at:    new Date(),
  };
}

async function downloadFeed(url, log) {
  log.debug('Downloading Awin feed', { url: url.slice(0, 80) });
  const res = await axios.get(url, {
    responseType: 'text',
    timeout: 120_000,
    headers: { 'User-Agent': 'datorsc-scraper/1.0' },
    // Inject API key if URL contains a placeholder
    params: AWIN_API_KEY ? {} : undefined,
  });
  return res.data;
}

/**
 * Entry point called by lib/runner.js
 * @param {object} sourceConfig
 * @returns {Promise<object[]>} raw records
 */
async function run(sourceConfig) {
  const log      = logger.forSource(sourceConfig.id);
  const feedUrls = getFeedUrls();

  if (feedUrls.length === 0) {
    log.warn('No AWIN_FEED_URLS configured. Skipping Awin run.');
    return [];
  }

  const allRecords = [];

  for (const feedUrl of feedUrls) {
    // Derive a retailer slug from the URL (best effort)
    const retailerMatch = feedUrl.match(/fid\/(\d+)/);
    const retailer = retailerMatch ? `awin_${retailerMatch[1]}` : 'awin_unknown';

    try {
      const csv = await downloadFeed(feedUrl, log);

      const rows = parse(csv, {
        columns:          true,
        skip_empty_lines: true,
        trim:             true,
        bom:              true,   // Awin feeds sometimes have UTF-8 BOM
      });

      const records = rows
        .map((row) => mapAwinRow(row, retailer))
        .filter((r) => r.ean);   // Only include records with a valid EAN candidate

      log.info(`Awin feed parsed`, { retailer, rowCount: rows.length, withEan: records.length });
      allRecords.push(...records);

    } catch (err) {
      log.error('Failed to download/parse Awin feed', { feedUrl, err: err.message });
    }
  }

  return allRecords;
}

module.exports = { run };
