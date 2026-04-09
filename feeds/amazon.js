"use strict";

const { getItemLimit, limitRecords } = require("../lib/source-controls");

// Stub module placeholder until source-specific scraping is implemented.
async function run(sourceConfig = {}) {
  return limitRecords([], getItemLimit(sourceConfig));
}

module.exports = { run };
