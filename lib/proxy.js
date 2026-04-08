"use strict";

require("dotenv").config();
const axios = require("axios");
const pRetry = require("p-retry");
const logger = require("./logger");

// ─── Proxy tier constants ─────────────────────────────────────────────────────
const TIER_STANDARD = "standard"; // Scrape.do — moderate-protection sites
const TIER_ASP = "asp"; // Zyte API  — Cloudflare / Akamai protected

// ─── Scrape.do configuration ──────────────────────────────────────────────────
// GET https://api.scrape.do/?token=TOKEN&url=ENCODED_URL[&render=true&super=true&geoCode=se]
// Credits charged only on 2xx responses.
const SCRAPE_DO_BASE = "https://api.scrape.do";
const SCRAPE_DO_TOKEN = process.env.SCRAPE_DO_TOKEN;

// ─── Zyte API configuration ───────────────────────────────────────────────────
// POST https://api.zyte.com/v1/extract  Auth: Basic (API key as username, empty password)
const ZYTE_BASE = "https://api.zyte.com/v1/extract";
const ZYTE_API_KEY = process.env.ZYTE_API_KEY;

// ─── Budget caps (hard stop to prevent runaway cost) ─────────────────────────
const BUDGET_CAP_SCRAPE_DO = Number(
  process.env.PROXY_BUDGET_CAP_SCRAPE_DO || 500,
);
const BUDGET_CAP_ZYTE = Number(process.env.PROXY_BUDGET_CAP_ZYTE || 200);

// In-memory credit counters — reset on pm2 restart / process start
const _usage = { scrapeDo: 0, zyte: 0 };

// HTTP status codes that must never be retried (permanent client/legal errors)
const PERMANENT_ERROR_CODES = new Set([400, 401, 403, 404, 410, 421, 451]);

// ─── Shared axios instance ────────────────────────────────────────────────────
const http = axios.create({
  timeout: 90_000, // 90 s — Zyte browser renders can be slow
  decompress: true,
  headers: { "Accept-Encoding": "gzip, deflate, br" },
});

// ─── Scrape.do URL builder ────────────────────────────────────────────────────
/**
 * Builds a Scrape.do API URL with all supported parameters.
 * New fields (superProxy, waitSelector, sessionId, customWait) are read from
 * sourceConfig in fetch() and forwarded here.
 */
function buildScraperDoUrl(
  targetUrl,
  {
    renderJs = false,
    geoCode = "se",
    superProxy = false,
    waitSelector = null,
    sessionId = null,
    customWait = null,
  } = {},
) {
  const params = new URLSearchParams({
    token: SCRAPE_DO_TOKEN,
    url: targetUrl,
    geoCode,
  });
  if (renderJs) params.set("render", "true");
  if (superProxy) params.set("super", "true");
  if (waitSelector) params.set("waitSelector", waitSelector);
  if (sessionId !== null && sessionId !== undefined) {
    params.set("sessionId", String(sessionId));
  }
  if (customWait !== null && customWait !== undefined) {
    params.set("customWait", String(customWait));
  }
  return `${SCRAPE_DO_BASE}/?${params.toString()}`;
}

function getZyteGeolocation(sourceConfig = {}) {
  return sourceConfig.geolocation ?? "SE";
}

function getZyteIpType(sourceConfig = {}) {
  return sourceConfig.ipType ?? undefined;
}

function getZyteExtractFrom(sourceConfig = {}, optionsKey) {
  const overrideKey =
    optionsKey === "productOptions"
      ? "productExtractFrom"
      : "productNavigationExtractFrom";

  return (
    sourceConfig[overrideKey] ??
    sourceConfig.extractFrom ??
    (sourceConfig.renderJs ? "browserHtml" : "httpResponseBody")
  );
}

function getZyteOptions(sourceConfig, optionsKey) {
  const extractFrom = getZyteExtractFrom(sourceConfig, optionsKey);
  return extractFrom ? { [optionsKey]: { extractFrom } } : {};
}

function isPermanentStatus(status) {
  return (
    status !== null && status !== undefined && PERMANENT_ERROR_CODES.has(status)
  );
}

// ─── Budget guard ─────────────────────────────────────────────────────────────
function _guardBudget(tier, log) {
  const cap = tier === "scrapeDo" ? BUDGET_CAP_SCRAPE_DO : BUDGET_CAP_ZYTE;
  const used = _usage[tier];
  const label = tier === "scrapeDo" ? "Scrape.do" : "Zyte";

  if (used >= cap) {
    throw new Error(
      `${label} budget cap reached (${used}/${cap}). Halting requests.`,
    );
  }
  if (used >= cap * 0.8) {
    log.warn(
      `${label} budget at ${Math.round((used / cap) * 100)}% (${used}/${cap})`,
    );
  }
}

// ─── Internal fetch via Scrape.do ────────────────────────────────────────────
async function _fetchViaScrapeDo(url, renderJs, log, sourceConfig) {
  if (!SCRAPE_DO_TOKEN) throw new Error("SCRAPE_DO_TOKEN is not configured");

  _guardBudget("scrapeDo", log);

  const apiUrl = buildScraperDoUrl(url, {
    renderJs,
    superProxy: sourceConfig.superProxy ?? false,
    waitSelector: sourceConfig.waitSelector ?? null,
    sessionId: sourceConfig.sessionId ?? null,
    customWait: sourceConfig.customWait ?? null,
  });

  return pRetry(
    async (attempt) => {
      try {
        const res = await http.get(apiUrl);
        if (res.status !== 200) {
          const err = new Error(`scrape.do HTTP ${res.status}`);
          if (PERMANENT_ERROR_CODES.has(res.status))
            throw new pRetry.AbortError(err);
          throw err;
        }
        _usage.scrapeDo++;
        log.debug("scrape.do success", { status: res.status, attempt });
        return res.data;
      } catch (axiosErr) {
        if (axiosErr instanceof pRetry.AbortError) throw axiosErr;
        const status = axiosErr.response?.status;
        if (status && PERMANENT_ERROR_CODES.has(status))
          throw new pRetry.AbortError(axiosErr);
        throw axiosErr;
      }
    },
    {
      retries: 3,
      minTimeout: 2000,
      factor: 2,
      onFailedAttempt: (e) =>
        log.warn("scrape.do retry", {
          attempt: e.attemptNumber,
          err: e.message,
        }),
    },
  );
}

// ─── Internal fetch via Zyte ──────────────────────────────────────────────────
async function _fetchViaZyte(url, renderJs, log, sourceConfig) {
  if (!ZYTE_API_KEY) throw new Error("ZYTE_API_KEY is not configured");

  _guardBudget("zyte", log);

  const ipType = getZyteIpType(sourceConfig);
  const geolocation = getZyteGeolocation(sourceConfig);
  const body = renderJs
    ? { url, browserHtml: true, geolocation, ...(ipType && { ipType }) }
    : { url, httpResponseBody: true, geolocation, ...(ipType && { ipType }) };

  return pRetry(
    async (attempt) => {
      try {
        const res = await http.post(ZYTE_BASE, body, {
          auth: { username: ZYTE_API_KEY, password: "" },
          headers: { "Content-Type": "application/json" },
        });
        if (res.status !== 200) {
          const err = new Error(`Zyte HTTP ${res.status}`);
          if (PERMANENT_ERROR_CODES.has(res.status))
            throw new pRetry.AbortError(err);
          throw err;
        }
        _usage.zyte++;
        log.debug("Zyte success", { renderJs, attempt });
        return renderJs
          ? res.data.browserHtml
          : Buffer.from(res.data.httpResponseBody, "base64").toString("utf-8");
      } catch (axiosErr) {
        if (axiosErr instanceof pRetry.AbortError) throw axiosErr;
        const status = axiosErr.response?.status;
        if (isPermanentStatus(status)) throw new pRetry.AbortError(axiosErr);
        throw axiosErr;
      }
    },
    {
      retries: 3,
      minTimeout: 2000,
      factor: 2,
      onFailedAttempt: (e) =>
        log.warn("Zyte retry", { attempt: e.attemptNumber, err: e.message }),
    },
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetches a URL through the appropriate proxy tier.
 * Returns the HTML string of the fetched page.
 *
 * @param {string} url          - Target URL to fetch
 * @param {object} sourceConfig - Entry from sources.json
 * @returns {Promise<string>}   - Page HTML
 */
async function fetch(url, sourceConfig = {}) {
  const tier = sourceConfig.proxyTier ?? TIER_STANDARD;
  const renderJs = sourceConfig.renderJs ?? false;
  const log = logger.forSource(sourceConfig.id ?? "unknown");

  log.debug("Fetching", { tier, url: url.slice(0, 100) });

  return tier === TIER_ASP
    ? _fetchViaZyte(url, renderJs, log, sourceConfig)
    : _fetchViaScrapeDo(url, renderJs, log, sourceConfig);
}

/**
 * AI-extracts a single product page via Zyte's product: true mode.
 * Returns a structured Zyte Product object (name, price, gtin, availability, etc.)
 * Much more resilient than CSS selectors — no site-specific parsing needed.
 *
 * @param {string} url
 * @param {object} sourceConfig
 * @returns {Promise<object>} Zyte Product object
 */
async function fetchProduct(url, sourceConfig = {}) {
  if (!ZYTE_API_KEY) throw new Error("ZYTE_API_KEY is not configured");

  const log = logger.forSource(sourceConfig.id ?? "unknown");
  _guardBudget("zyte", log);

  const ipType = getZyteIpType(sourceConfig);
  const body = {
    url,
    product: true,
    geolocation: getZyteGeolocation(sourceConfig),
    ...(ipType && { ipType }),
    ...getZyteOptions(sourceConfig, "productOptions"),
  };

  return pRetry(
    async (attempt) => {
      try {
        const res = await http.post(ZYTE_BASE, body, {
          auth: { username: ZYTE_API_KEY, password: "" },
          headers: { "Content-Type": "application/json" },
        });
        if (res.status !== 200) {
          const err = new Error(`Zyte fetchProduct HTTP ${res.status}`);
          if (isPermanentStatus(res.status)) throw new pRetry.AbortError(err);
          throw err;
        }
        _usage.zyte++;
        log.debug("Zyte fetchProduct success", {
          url: url.slice(0, 80),
          attempt,
        });
        return res.data.product;
      } catch (axiosErr) {
        if (axiosErr instanceof pRetry.AbortError) throw axiosErr;
        const status = axiosErr.response?.status;
        if (isPermanentStatus(status)) throw new pRetry.AbortError(axiosErr);
        throw axiosErr;
      }
    },
    {
      retries: 2,
      minTimeout: 3000,
      onFailedAttempt: (e) =>
        log.warn("Zyte fetchProduct retry", {
          attempt: e.attemptNumber,
          err: e.message,
        }),
    },
  );
}

/**
 * AI-navigates a category/listing page via Zyte's productNavigation: true mode.
 * Returns { items: [{url, name}], nextPage: {url}, subCategories: [...] }
 * Use this to discover product URLs before calling fetchProduct() per item.
 *
 * @param {string} url
 * @param {object} sourceConfig
 * @returns {Promise<object>} Zyte ProductNavigation object
 */
async function fetchProductList(url, sourceConfig = {}) {
  if (!ZYTE_API_KEY) throw new Error("ZYTE_API_KEY is not configured");

  const log = logger.forSource(sourceConfig.id ?? "unknown");
  _guardBudget("zyte", log);

  const ipType = getZyteIpType(sourceConfig);
  const body = {
    url,
    productNavigation: true,
    geolocation: getZyteGeolocation(sourceConfig),
    ...(ipType && { ipType }),
    ...getZyteOptions(sourceConfig, "productNavigationOptions"),
  };

  return pRetry(
    async (attempt) => {
      try {
        const res = await http.post(ZYTE_BASE, body, {
          auth: { username: ZYTE_API_KEY, password: "" },
          headers: { "Content-Type": "application/json" },
        });
        if (res.status !== 200) {
          const err = new Error(`Zyte fetchProductList HTTP ${res.status}`);
          if (isPermanentStatus(res.status)) throw new pRetry.AbortError(err);
          throw err;
        }
        _usage.zyte++;
        log.debug("Zyte fetchProductList success", {
          url: url.slice(0, 80),
          attempt,
        });
        return res.data.productNavigation;
      } catch (axiosErr) {
        if (axiosErr instanceof pRetry.AbortError) throw axiosErr;
        const status = axiosErr.response?.status;
        if (isPermanentStatus(status)) throw new pRetry.AbortError(axiosErr);
        throw axiosErr;
      }
    },
    {
      retries: 2,
      minTimeout: 3000,
      onFailedAttempt: (e) =>
        log.warn("Zyte fetchProductList retry", {
          attempt: e.attemptNumber,
          err: e.message,
        }),
    },
  );
}

/** Returns a snapshot of current proxy credit usage (for monitoring/alerting). */
function getUsage() {
  return { ..._usage };
}

module.exports = {
  fetch,
  fetchProduct,
  fetchProductList,
  getUsage,
  TIER_STANDARD,
  TIER_ASP,
};
