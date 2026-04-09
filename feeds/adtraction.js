"use strict";

require("dotenv").config();
const axios = require("axios");
const { parse } = require("csv-parse/sync");
const logger = require("../lib/logger");
const { getItemLimit, takeRemaining } = require("../lib/source-controls");

// ─── Adtraction feed configuration ───────────────────────────────────────────
// Feed URL: GET https://api.adtraction.com/v2/partner/feeds/{channelId}?apiKey={key}&format=csv
// One URL per approved advertiser program.
//
// .env format (comma-separated):
//   ADTRACTION_FEED_URLS=https://api.adtraction.com/v2/partner/feeds/12345?apiKey=KEY&format=csv,...
//
// Alternatively derive from credentials if no custom URLs are configured:
//   ADTRACTION_API_KEY + ADTRACTION_CHANNEL_ID → single default feed URL

const ADTRACTION_API_KEY = process.env.ADTRACTION_API_KEY;
const ADTRACTION_CHANNEL_ID = process.env.ADTRACTION_CHANNEL_ID;

function getFeedUrls() {
  const raw = process.env.ADTRACTION_FEED_URLS || "";
  const explicit = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (explicit.length > 0) return explicit;

  // Fallback: derive single URL from credentials
  if (ADTRACTION_API_KEY && ADTRACTION_CHANNEL_ID) {
    return [
      `https://api.adtraction.com/v2/partner/feeds/${ADTRACTION_CHANNEL_ID}?apiKey=${ADTRACTION_API_KEY}&format=csv`,
    ];
  }
  return [];
}

// ─── Column normalisers ───────────────────────────────────────────────────────
// Adtraction feed column names vary by market/advertiser program.
// This covers the most common Swedish feed variants.
function getField(row, ...keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== "") return row[key];
  }
  return null;
}

/**
 * Maps a single Adtraction CSV row to our canonical ProductRecord shape.
 * Returns null if required fields are missing.
 */
function mapAdtractionRow(row, retailer) {
  const rawEan = getField(
    row,
    "EAN",
    "GTIN",
    "ean",
    "gtin",
    "ProductEAN",
    "Ean",
  );
  const rawPrice = getField(
    row,
    "Price",
    "RegularPrice",
    "SalePrice",
    "price",
    "Prisinklusive",
  );
  const rawUrl = getField(
    row,
    "TrackingLink",
    "ProductURL",
    "AffiliateURL",
    "trackingLink",
    "productUrl",
  );
  const rawName = getField(
    row,
    "ProductName",
    "Name",
    "Title",
    "name",
    "title",
  );
  const rawStock = getField(
    row,
    "InStock",
    "Availability",
    "Stock",
    "inStock",
    "availability",
  );
  const rawImage = getField(
    row,
    "ImageURL",
    "Image",
    "image_url",
    "ProductImage",
    "imageUrl",
  );

  if (!rawUrl || !rawName) return null;

  const ean = rawEan ? String(rawEan).replace(/[\s\-]/g, "") : null;
  const price = parseFloat(String(rawPrice || "0").replace(/[^\d.]/g, ""));

  // Stock: treat '1', 'true', 'yes', 'i lager', 'instock' as in-stock
  const stockStr = String(rawStock || "1").toLowerCase();
  const in_stock = ![
    "0",
    "false",
    "no",
    "out of stock",
    "slut",
    "ej i lager",
    "outofstock",
  ].includes(stockStr);

  return {
    ean: ean,
    name: String(rawName).trim().slice(0, 512),
    retailer,
    price_sek: isNaN(price) ? 0 : price,
    in_stock,
    affiliate_url: rawUrl.trim(),
    image_url: rawImage ? rawImage.trim() : null,
    scraped_at: new Date(),
  };
}

async function downloadFeed(url, log) {
  log.debug("Downloading Adtraction feed", { url: url.slice(0, 80) });
  const res = await axios.get(url, {
    responseType: "text",
    timeout: 120_000,
    headers: { "User-Agent": "datorsc-scraper/1.0" },
  });
  return res.data;
}

// ─── Derive retailer slug from feed URL ───────────────────────────────────────
function retailerFromUrl(feedUrl) {
  // Try to get the channelId from the path segment: /feeds/12345?...
  const match = feedUrl.match(/\/feeds\/(\d+)/);
  return match ? `adtraction_${match[1]}` : "adtraction";
}

/**
 * Entry point called by lib/runner.js
 * @param {object} sourceConfig
 * @returns {Promise<object[]>} raw records
 */
async function run(sourceConfig) {
  const log = logger.forSource(sourceConfig.id);
  const feedUrls = getFeedUrls();
  const itemLimit = getItemLimit(sourceConfig);

  if (feedUrls.length === 0) {
    log.warn(
      "No Adtraction feed URLs configured (ADTRACTION_FEED_URLS or ADTRACTION_API_KEY + ADTRACTION_CHANNEL_ID). Skipping.",
    );
    return [];
  }

  const allRecords = [];

  for (const feedUrl of feedUrls) {
    const retailer = retailerFromUrl(feedUrl);

    try {
      const csv = await downloadFeed(feedUrl, log);

      const rows = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_quotes: true,
        relax_column_count: true,
      });

      const records = takeRemaining(
        rows
          .map((row) => mapAdtractionRow(row, retailer))
          .filter((r) => r !== null && /^\d{8,14}$/.test(r.ean || "")),
        allRecords.length,
        itemLimit,
      );

      log.info("Adtraction feed parsed", {
        retailer,
        rowCount: rows.length,
        withEan: records.length,
      });
      allRecords.push(...records);
      if (itemLimit !== null && allRecords.length >= itemLimit) break;
    } catch (err) {
      log.error("Failed to download/parse Adtraction feed", {
        feedUrl: feedUrl.slice(0, 80),
        err: err.message,
      });
    }
  }

  return allRecords;
}

module.exports = { run, mapAdtractionRow };
