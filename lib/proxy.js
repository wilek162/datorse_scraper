'use strict';

require('dotenv').config();
const axios = require('axios');
const logger = require('./logger');

// ─── Proxy tier constants (match sources.json proxyTier values) ───────────────
const TIER_STANDARD = 'standard'; // Scrape.do — moderate-protection sites
const TIER_ASP      = 'asp';      // Zyte API  — Cloudflare / Akamai protected

// ─── Scrape.do client ─────────────────────────────────────────────────────────
// API mode: GET https://api.scrape.do/?token=TOKEN&url=ENCODED_URL[&render=true&super=true]
// Charges credits only on 2xx responses.

const SCRAPE_DO_BASE = 'https://api.scrape.do';
const SCRAPE_DO_TOKEN = process.env.SCRAPE_DO_TOKEN;

function buildScraperDoUrl(targetUrl, { renderJs = false, geoCode = 'se' } = {}) {
  const params = new URLSearchParams({
    token:   SCRAPE_DO_TOKEN,
    url:     targetUrl,           // URLSearchParams encodes automatically
    geoCode,
  });
  if (renderJs) params.set('render', 'true');
  // 'super' enables residential IP pool (costs more credits) — only use when needed
  return `${SCRAPE_DO_BASE}/?${params.toString()}`;
}

// ─── Zyte API client ──────────────────────────────────────────────────────────
// POST https://api.zyte.com/v1/extract
// Auth: Basic (API key as username, empty password)
// Returns base64-encoded httpResponseBody or browserHtml string.

const ZYTE_BASE    = 'https://api.zyte.com/v1/extract';
const ZYTE_API_KEY = process.env.ZYTE_API_KEY;

// ─── Shared axios instance with reasonable defaults ───────────────────────────

const http = axios.create({
  timeout: 90_000,   // 90 s — Zyte browser renders can be slow
  decompress: true,
  headers: { 'Accept-Encoding': 'gzip, deflate, br' },
});

// ─── Main fetch function ──────────────────────────────────────────────────────

/**
 * Fetches a URL through the appropriate proxy tier.
 *
 * @param {string} url          - Target URL to fetch
 * @param {object} sourceConfig - Entry from sources.json
 * @returns {Promise<string>}   - HTML string of the fetched page
 */
async function fetch(url, sourceConfig = {}) {
  const tier      = sourceConfig.proxyTier ?? TIER_STANDARD;
  const renderJs  = sourceConfig.renderJs  ?? false;
  const sourceId  = sourceConfig.id        ?? 'unknown';
  const log       = logger.forSource(sourceId);

  log.debug('Fetching via proxy', { tier, url: url.slice(0, 80) });

  if (tier === TIER_ASP) {
    return _fetchViaZyte(url, renderJs, log);
  }
  return _fetchViaScrapeDo(url, renderJs, log);
}

async function _fetchViaScrapeDo(url, renderJs, log) {
  if (!SCRAPE_DO_TOKEN) throw new Error('SCRAPE_DO_TOKEN is not set');

  const apiUrl = buildScraperDoUrl(url, { renderJs });
  const res = await http.get(apiUrl);

  if (res.status !== 200) {
    throw new Error(`scrape.do returned HTTP ${res.status}`);
  }

  log.debug('scrape.do OK', { status: res.status });
  return res.data;
}

async function _fetchViaZyte(url, renderJs, log) {
  if (!ZYTE_API_KEY) throw new Error('ZYTE_API_KEY is not set');

  // Zyte API: use browserHtml for JS-rendered pages, httpResponseBody for plain HTML
  const body = renderJs
    ? { url, browserHtml: true }
    : { url, httpResponseBody: true };

  const res = await http.post(ZYTE_BASE, body, {
    auth: { username: ZYTE_API_KEY, password: '' },
    headers: { 'Content-Type': 'application/json' },
  });

  if (res.status !== 200) {
    throw new Error(`Zyte API returned HTTP ${res.status}`);
  }

  let html;
  if (renderJs) {
    // browserHtml returns the rendered HTML directly as a string
    html = res.data.browserHtml;
  } else {
    // httpResponseBody is base64-encoded binary
    html = Buffer.from(res.data.httpResponseBody, 'base64').toString('utf-8');
  }

  log.debug('Zyte API OK', { renderJs });
  return html;
}

module.exports = { fetch, TIER_STANDARD, TIER_ASP };
