"use strict";

const nock = require("nock");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const HTML_FIXTURE = "<html><body>Test page</body></html>";
const ZYTE_HTML_RESPONSE = {
  browserHtml: HTML_FIXTURE,
};
const ZYTE_RAW_RESPONSE = {
  httpResponseBody: Buffer.from(HTML_FIXTURE).toString("base64"),
};
const ZYTE_PRODUCT_RESPONSE = {
  product: {
    name: "Test Laptop",
    price: "9990.00",
    currency: "SEK",
    gtin: [{ type: "gtin13", value: "1234567890123" }],
    availability: "InStock",
    mainImage: { url: "https://example.com/img.jpg" },
    sku: "COMP-001",
    metadata: { probability: 0.95 },
  },
};
const ZYTE_NAV_RESPONSE = {
  productNavigation: {
    items: [{ url: "https://www.komplett.se/product/1" }],
    nextPage: { url: "https://www.komplett.se/category/1?page=2" },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function loadProxy() {
  // Always require fresh module so _usage counters reset
  jest.resetModules();
  return require("../lib/proxy");
}

beforeAll(() => {
  process.env.SCRAPE_DO_TOKEN = "test-scrape-token";
  process.env.ZYTE_API_KEY = "test-zyte-key";
  process.env.PROXY_BUDGET_CAP_SCRAPE_DO = "100";
  process.env.PROXY_BUDGET_CAP_ZYTE = "50";
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

// Prevent any real HTTP calls during tests
beforeEach(() => {
  nock.disableNetConnect();
});

// ─── fetch() routing ──────────────────────────────────────────────────────────
describe("fetch() routing", () => {
  test("standard tier uses Scrape.do", async () => {
    nock("https://api.scrape.do").get("/").query(true).reply(200, HTML_FIXTURE);

    const proxy = loadProxy();
    const html = await proxy.fetch("https://example.com", {
      proxyTier: "standard",
      id: "test",
    });
    expect(html).toBe(HTML_FIXTURE);
  });

  test("asp tier uses Zyte (httpResponseBody)", async () => {
    nock("https://api.zyte.com")
      .post("/v1/extract", (body) => body.httpResponseBody === true)
      .reply(200, ZYTE_RAW_RESPONSE);

    const proxy = loadProxy();
    const html = await proxy.fetch("https://example.com", {
      proxyTier: "asp",
      renderJs: false,
      id: "test",
    });
    expect(html).toBe(HTML_FIXTURE);
  });

  test("asp tier with renderJs uses Zyte browserHtml", async () => {
    nock("https://api.zyte.com")
      .post("/v1/extract", (body) => body.browserHtml === true)
      .reply(200, ZYTE_HTML_RESPONSE);

    const proxy = loadProxy();
    const html = await proxy.fetch("https://example.com", {
      proxyTier: "asp",
      renderJs: true,
      id: "test",
    });
    expect(html).toBe(HTML_FIXTURE);
  });
});

// ─── Zyte geolocation ──────────────────────────────────────────────────────────
describe("Zyte includes geolocation: SE", () => {
  test("httpResponseBody request includes geolocation SE", async () => {
    let capturedBody = null;
    nock("https://api.zyte.com")
      .post("/v1/extract", (body) => {
        capturedBody = body;
        return true;
      })
      .reply(200, ZYTE_RAW_RESPONSE);

    const proxy = loadProxy();
    await proxy.fetch("https://example.com", {
      proxyTier: "asp",
      renderJs: false,
      id: "test",
    });

    expect(capturedBody.geolocation).toBe("SE");
  });

  test("browserHtml request includes geolocation SE", async () => {
    let capturedBody = null;
    nock("https://api.zyte.com")
      .post("/v1/extract", (body) => {
        capturedBody = body;
        return true;
      })
      .reply(200, ZYTE_HTML_RESPONSE);

    const proxy = loadProxy();
    await proxy.fetch("https://example.com", {
      proxyTier: "asp",
      renderJs: true,
      id: "test",
    });

    expect(capturedBody.geolocation).toBe("SE");
  });
});

// ─── Scrape.do extended params ─────────────────────────────────────────────────
describe("Scrape.do extended parameters", () => {
  test("super param is sent when superProxy: true", async () => {
    let capturedUrl = "";
    nock("https://api.scrape.do")
      .get("/")
      .query(true)
      .reply(function () {
        capturedUrl = this.req.path;
        return [200, HTML_FIXTURE];
      });

    const proxy = loadProxy();
    await proxy.fetch("https://example.com", {
      proxyTier: "standard",
      superProxy: true,
      id: "test",
    });
    expect(capturedUrl).toContain("super=true");
  });

  test("waitSelector param is sent when configured", async () => {
    let capturedUrl = "";
    nock("https://api.scrape.do")
      .get("/")
      .query(true)
      .reply(function () {
        capturedUrl = this.req.path;
        return [200, HTML_FIXTURE];
      });

    const proxy = loadProxy();
    await proxy.fetch("https://example.com", {
      proxyTier: "standard",
      waitSelector: ".product-list",
      id: "test",
    });
    expect(capturedUrl).toContain("waitSelector=");
    expect(decodeURIComponent(capturedUrl)).toContain(".product-list");
  });

  test("render param is sent when renderJs: true", async () => {
    let capturedUrl = "";
    nock("https://api.scrape.do")
      .get("/")
      .query(true)
      .reply(function () {
        capturedUrl = this.req.path;
        return [200, HTML_FIXTURE];
      });

    const proxy = loadProxy();
    await proxy.fetch("https://example.com", {
      proxyTier: "standard",
      renderJs: true,
      id: "test",
    });
    expect(capturedUrl).toContain("render=true");
  });
});

// ─── fetchProduct ──────────────────────────────────────────────────────────────
describe("fetchProduct()", () => {
  test("calls Zyte with product: true and geolocation: SE", async () => {
    let capturedBody = null;
    nock("https://api.zyte.com")
      .post("/v1/extract", (body) => {
        capturedBody = body;
        return true;
      })
      .reply(200, ZYTE_PRODUCT_RESPONSE);

    const proxy = loadProxy();
    const product = await proxy.fetchProduct(
      "https://www.komplett.se/product/1",
      { id: "komplett" },
    );

    expect(capturedBody.product).toBe(true);
    expect(capturedBody.geolocation).toBe("SE");
    expect(product.name).toBe("Test Laptop");
    expect(product.gtin[0].value).toBe("1234567890123");
  });

  test("passes ipType and extractFrom for product extraction", async () => {
    let capturedBody = null;
    nock("https://api.zyte.com")
      .post("/v1/extract", (body) => {
        capturedBody = body;
        return true;
      })
      .reply(200, ZYTE_PRODUCT_RESPONSE);

    const proxy = loadProxy();
    await proxy.fetchProduct("https://www.komplett.se/product/1", {
      id: "komplett",
      ipType: "residential",
      renderJs: true,
      productExtractFrom: "browserHtmlOnly",
    });

    expect(capturedBody.ipType).toBe("residential");
    expect(capturedBody.productOptions).toEqual({
      extractFrom: "browserHtmlOnly",
    });
  });
});

// ─── fetchProductList ─────────────────────────────────────────────────────────
describe("fetchProductList()", () => {
  test("calls Zyte with productNavigation: true", async () => {
    let capturedBody = null;
    nock("https://api.zyte.com")
      .post("/v1/extract", (body) => {
        capturedBody = body;
        return true;
      })
      .reply(200, ZYTE_NAV_RESPONSE);

    const proxy = loadProxy();
    const nav = await proxy.fetchProductList(
      "https://www.komplett.se/category/1",
      { id: "komplett" },
    );

    expect(capturedBody.productNavigation).toBe(true);
    expect(capturedBody.geolocation).toBe("SE");
    expect(nav.items).toHaveLength(1);
    expect(nav.nextPage.url).toContain("page=2");
  });

  test("defaults product navigation extractFrom from renderJs flag", async () => {
    let capturedBody = null;
    nock("https://api.zyte.com")
      .post("/v1/extract", (body) => {
        capturedBody = body;
        return true;
      })
      .reply(200, ZYTE_NAV_RESPONSE);

    const proxy = loadProxy();
    await proxy.fetchProductList("https://www.komplett.se/category/1", {
      id: "komplett",
      renderJs: false,
    });

    expect(capturedBody.productNavigationOptions).toEqual({
      extractFrom: "httpResponseBody",
    });
  });
});

// ─── Budget enforcement ────────────────────────────────────────────────────────
describe("Budget cap enforcement", () => {
  test("throws when scrapeDo budget cap is reached", async () => {
    await jest.isolateModulesAsync(async () => {
      process.env.PROXY_BUDGET_CAP_SCRAPE_DO = "0";
      const proxy = require("../lib/proxy");
      const { ProxyFatalError: PFE } = require("../lib/proxy");
      await expect(
        proxy.fetch("https://example.com", {
          proxyTier: "standard",
          id: "test",
        }),
      ).rejects.toMatchObject({
        name: "ProxyFatalError",
        message: expect.stringMatching(/budget cap reached/i),
      });
      await expect(
        proxy.fetch("https://example.com", {
          proxyTier: "standard",
          id: "test",
        }),
      ).rejects.toThrow(PFE);
    });
    process.env.PROXY_BUDGET_CAP_SCRAPE_DO = "100";
  });

  test("throws when Zyte budget cap is reached", async () => {
    await jest.isolateModulesAsync(async () => {
      process.env.PROXY_BUDGET_CAP_ZYTE = "0";
      const proxy = require("../lib/proxy");
      const { ProxyFatalError: PFE } = require("../lib/proxy");
      await expect(
        proxy.fetch("https://example.com", { proxyTier: "asp", id: "test" }),
      ).rejects.toMatchObject({
        name: "ProxyFatalError",
        message: expect.stringMatching(/budget cap reached/i),
      });
      await expect(
        proxy.fetch("https://example.com", { proxyTier: "asp", id: "test" }),
      ).rejects.toThrow(PFE);
    });
    process.env.PROXY_BUDGET_CAP_ZYTE = "50";
  });
});

// ─── getUsage ─────────────────────────────────────────────────────────────────
describe("getUsage()", () => {
  test("returns usage counters object", async () => {
    const proxy = loadProxy();
    const usage = proxy.getUsage();
    expect(usage).toHaveProperty("scrapeDo");
    expect(usage).toHaveProperty("zyte");
    expect(typeof usage.scrapeDo).toBe("number");
  });

  test("counter increments after successful Scrape.do fetch", async () => {
    nock("https://api.scrape.do").get("/").query(true).reply(200, HTML_FIXTURE);

    const proxy = loadProxy();
    const before = proxy.getUsage().scrapeDo;
    await proxy.fetch("https://example.com", {
      proxyTier: "standard",
      id: "test",
    });
    const after = proxy.getUsage().scrapeDo;
    expect(after).toBe(before + 1);
  });
});

// ─── Exports ──────────────────────────────────────────────────────────────────
describe("module exports", () => {
  test("exports TIER_STANDARD and TIER_ASP constants", () => {
    const proxy = loadProxy();
    expect(proxy.TIER_STANDARD).toBe("standard");
    expect(proxy.TIER_ASP).toBe("asp");
  });
});
