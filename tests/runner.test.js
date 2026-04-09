"use strict";

const path = require("path");

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function makeRecord(overrides = {}) {
  return {
    ean: "1234567890123",
    name: "Test Product SE",
    retailer: "prisjakt",
    price_sek: 1299,
    in_stock: true,
    affiliate_url: "https://www.prisjakt.nu/produkt.php?p=1",
    image_url: "https://cdn.example.com/product.jpg",
    scraped_at: new Date("2026-04-09T10:00:00Z"),
    ...overrides,
  };
}

describe("runSource", () => {
  let dbMock;
  let proxyMock;
  let log;
  let loggerMock;

  beforeEach(() => {
    jest.resetModules();

    dbMock = {
      startScrapeLog: jest.fn().mockResolvedValue(99),
      saveValidationResults: jest.fn().mockResolvedValue(undefined),
      upsertProduct: jest
        .fn()
        .mockResolvedValue({ upserted: true, suspicious: false }),
      finishScrapeLog: jest.fn().mockResolvedValue(undefined),
      getLastFailedRuns: jest.fn().mockResolvedValue([]),
    };

    proxyMock = {
      getUsage: jest
        .fn()
        .mockReturnValueOnce({ scrapeDo: 1, zyte: 0 })
        .mockReturnValueOnce({ scrapeDo: 3, zyte: 1 }),
    };

    log = makeLogger();
    loggerMock = { forSource: jest.fn(() => log) };

    jest.doMock("../lib/db", () => dbMock);
    jest.doMock("../lib/proxy", () => proxyMock);
    jest.doMock("../lib/logger", () => loggerMock);
  });

  test("stores validation results and logs proxy metrics", async () => {
    const modulePath = path.resolve(__dirname, "fixtures", "runner-source.js");
    jest.doMock(
      modulePath,
      () => ({
        run: jest
          .fn()
          .mockResolvedValue([makeRecord(), makeRecord({ ean: "bad-ean" })]),
      }),
      { virtual: true },
    );

    const { runSource } = require("../lib/runner");

    await runSource({
      id: "prisjakt",
      module: "tests/fixtures/runner-source.js",
    });

    expect(dbMock.saveValidationResults).toHaveBeenCalledTimes(1);
    expect(dbMock.upsertProduct).toHaveBeenCalledTimes(1);
    expect(dbMock.finishScrapeLog).toHaveBeenCalledWith(
      99,
      expect.objectContaining({
        recordsFound: 2,
        recordsValid: 1,
        recordsUpserted: 1,
        proxyCreditsUsed: 3,
        pagesFetched: 3,
        proxyCostUsd: null,
      }),
    );
  });

  test("persists unresolved records without attempting canonical upserts", async () => {
    const modulePath = path.resolve(
      __dirname,
      "fixtures",
      "runner-source-unresolved.js",
    );
    jest.doMock(
      modulePath,
      () => ({
        run: jest
          .fn()
          .mockResolvedValue([
            makeRecord({ ean: null, external_id: "prisjakt-1001" }),
          ]),
      }),
      { virtual: true },
    );

    const { runSource } = require("../lib/runner");

    await runSource({
      id: "prisjakt",
      module: "tests/fixtures/runner-source-unresolved.js",
    });

    expect(dbMock.saveValidationResults).toHaveBeenCalledWith(
      99,
      "prisjakt",
      expect.objectContaining({
        valid: [],
        unresolved: [expect.objectContaining({ external_id: "prisjakt-1001" })],
        invalid: [],
      }),
    );
    expect(dbMock.upsertProduct).not.toHaveBeenCalled();
    expect(dbMock.finishScrapeLog).toHaveBeenCalledWith(
      99,
      expect.objectContaining({
        recordsFound: 1,
        recordsValid: 0,
        status: "partial",
        errorMessage:
          "No canonical EAN records; unresolved source records persisted",
      }),
    );
  });

  test("applies runner item-limit fallback when source ignores it", async () => {
    const modulePath = path.resolve(
      __dirname,
      "fixtures",
      "runner-source-limited.js",
    );
    jest.doMock(
      modulePath,
      () => ({
        run: jest
          .fn()
          .mockResolvedValue([
            makeRecord(),
            makeRecord({ ean: "2234567890123" }),
            makeRecord({ ean: "3234567890123" }),
          ]),
      }),
      { virtual: true },
    );

    const { runSource } = require("../lib/runner");

    await runSource({
      id: "prisjakt",
      module: "tests/fixtures/runner-source-limited.js",
      itemLimit: 2,
    });

    expect(dbMock.upsertProduct).toHaveBeenCalledTimes(2);
    expect(dbMock.finishScrapeLog).toHaveBeenCalledWith(
      99,
      expect.objectContaining({
        recordsFound: 2,
        recordsValid: 2,
        recordsUpserted: 2,
      }),
    );
  });
});
