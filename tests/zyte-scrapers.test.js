"use strict";

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function makeZyteProduct(overrides = {}) {
  return {
    name: "RTX 4070",
    price: "6990.00",
    gtin: [{ type: "gtin13", value: "1234567890123" }],
    availability: "InStock",
    mainImage: { url: "https://example.com/gpu.jpg" },
    metadata: { probability: 0.93 },
    ...overrides,
  };
}

describe("Zyte-backed scrapers", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.dontMock("../lib/proxy");
    jest.dontMock("../lib/logger");
  });

  test("komplett zyteProductToRecord maps a valid Zyte product", () => {
    const { zyteProductToRecord } = require("../scrapers/komplett");

    const record = zyteProductToRecord(
      makeZyteProduct(),
      "https://www.komplett.se/product/123",
    );

    expect(record).toMatchObject({
      ean: "1234567890123",
      name: "RTX 4070",
      retailer: "komplett",
      price_sek: 6990,
      in_stock: true,
      affiliate_url: "https://www.komplett.se/product/123",
      image_url: "https://example.com/gpu.jpg",
    });
    expect(record.scraped_at).toBeInstanceOf(Date);
  });

  test("komplett zyteProductToRecord skips low-confidence extraction", () => {
    const { zyteProductToRecord } = require("../scrapers/komplett");

    const record = zyteProductToRecord(
      makeZyteProduct({ metadata: { probability: 0.2 } }),
      "https://www.komplett.se/product/123",
    );

    expect(record).toBeNull();
  });

  test("komplett run paginates category navigation and collects records", async () => {
    const proxyMock = {
      fetchProductList: jest
        .fn()
        .mockResolvedValueOnce({
          items: [{ url: "https://www.komplett.se/product/1" }],
          nextPage: { url: "https://www.komplett.se/category/1?page=2" },
        })
        .mockResolvedValueOnce({
          items: [{ url: "https://www.komplett.se/product/2" }],
          nextPage: null,
        }),
      fetchProduct: jest
        .fn()
        .mockResolvedValueOnce(makeZyteProduct({ name: "GPU One" }))
        .mockResolvedValueOnce(
          makeZyteProduct({
            name: "GPU Two",
            gtin: [{ type: "gtin13", value: "2234567890123" }],
          }),
        ),
    };
    const log = makeLogger();

    jest.doMock("../lib/proxy", () => proxyMock);
    jest.doMock("../lib/logger", () => ({ forSource: () => log }));

    const { run } = require("../scrapers/komplett");
    const records = await run({
      id: "komplett",
      pageLimit: 2,
      startUrls: ["https://www.komplett.se/category/1"],
      renderJs: true,
    });

    expect(proxyMock.fetchProductList).toHaveBeenCalledTimes(2);
    expect(proxyMock.fetchProduct).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(2);
    expect(records[0].retailer).toBe("komplett");
    expect(records[1].ean).toBe("2234567890123");
  });

  test("komplett run respects itemLimit to cap token usage", async () => {
    const proxyMock = {
      fetchProductList: jest.fn().mockResolvedValue({
        items: [
          { url: "https://www.komplett.se/product/1" },
          { url: "https://www.komplett.se/product/2" },
        ],
        nextPage: null,
      }),
      fetchProduct: jest.fn().mockResolvedValue(makeZyteProduct()),
    };
    const log = makeLogger();

    jest.doMock("../lib/proxy", () => proxyMock);
    jest.doMock("../lib/logger", () => ({ forSource: () => log }));

    const { run } = require("../scrapers/komplett");
    const records = await run({
      id: "komplett",
      pageLimit: 2,
      itemLimit: 1,
      startUrls: ["https://www.komplett.se/category/1"],
      renderJs: true,
    });

    expect(proxyMock.fetchProductList).toHaveBeenCalledTimes(1);
    expect(proxyMock.fetchProduct).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
  });

  test("elgiganten run re-labels mapped products to elgiganten", async () => {
    // Elgiganten uses proxy.fetch() for category listing pages (to parse HTML
    // for product links), then proxy.fetchProduct() for AI extraction per item.
    const listingHtml = `<html><body>
      <a href="/product/1">Product 1</a>
    </body></html>`;
    const proxyMock = {
      fetch: jest.fn().mockResolvedValue(listingHtml),
      fetchProduct: jest.fn().mockResolvedValue(makeZyteProduct()),
    };
    const log = makeLogger();

    jest.doMock("../lib/proxy", () => proxyMock);
    jest.doMock("../lib/logger", () => ({ forSource: () => log }));

    const { run } = require("../scrapers/elgiganten");
    const records = await run({
      id: "elgiganten",
      pageLimit: 1,
      startUrls: ["https://www.elgiganten.se/category/1"],
      renderJs: true,
    });

    expect(records).toHaveLength(1);
    expect(records[0].retailer).toBe("elgiganten");
    expect(records[0].affiliate_url).toBe(
      "https://www.elgiganten.se/product/1",
    );
  });
});
