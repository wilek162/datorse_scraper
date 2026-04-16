"use strict";

function parsePositiveInt(value) {
  if (value === undefined || value === null || value === "") return null;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }

  return Math.floor(parsed);
}

function getPageLimit(sourceConfig, fallback) {
  return parsePositiveInt(sourceConfig.pageLimit) ?? fallback;
}

function getItemLimit(sourceConfig) {
  return parsePositiveInt(sourceConfig.itemLimit);
}

function isItemLimitReached(currentCount, itemLimit) {
  return itemLimit !== null && currentCount >= itemLimit;
}

function takeRemaining(items, currentCount, itemLimit) {
  if (itemLimit === null) return items;

  const remaining = Math.max(itemLimit - currentCount, 0);
  return remaining === 0 ? [] : items.slice(0, remaining);
}

function limitRecords(records, itemLimit) {
  if (itemLimit === null) return records;
  return records.slice(0, itemLimit);
}

function applySourceOverrides(sourceConfig, overrides = {}) {
  const nextConfig = { ...sourceConfig };

  if (overrides.pageLimit !== undefined) {
    nextConfig.pageLimit = parsePositiveInt(overrides.pageLimit);
  }

  if (overrides.itemLimit !== undefined) {
    nextConfig.itemLimit = parsePositiveInt(overrides.itemLimit);
  }

  if (overrides.dryRun !== undefined) {
    nextConfig.dryRun = Boolean(overrides.dryRun);
  }

  return nextConfig;
}

module.exports = {
  applySourceOverrides,
  getItemLimit,
  getPageLimit,
  isItemLimitReached,
  limitRecords,
  parsePositiveInt,
  takeRemaining,
};
