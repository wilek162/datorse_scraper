"use strict";

const {
  validateRecords,
  isSuspiciousPriceChange,
  ProductRecordSchema,
} = require("../lib/validate");

// ─── Valid record fixture ─────────────────────────────────────────────────────
function makeRecord(overrides = {}) {
  return {
    ean: "1234567890123",
    name: "Test Product SE",
    retailer: "webhallen",
    price_sek: 1299.0,
    in_stock: true,
    affiliate_url: "https://www.webhallen.com/se/product/12345-test-product",
    image_url: "https://www.webhallen.com/images/test.jpg",
    scraped_at: new Date(),
    ...overrides,
  };
}

// ─── ProductRecordSchema ──────────────────────────────────────────────────────
describe("ProductRecordSchema", () => {
  test("accepts a valid record", () => {
    const result = ProductRecordSchema.safeParse(makeRecord());
    expect(result.success).toBe(true);
  });

  test("rejects EAN with fewer than 8 digits", () => {
    const result = ProductRecordSchema.safeParse(
      makeRecord({ ean: "1234567" }),
    );
    expect(result.success).toBe(false);
    expect(result.error.issues[0].path).toContain("ean");
  });

  test("rejects EAN with non-digits", () => {
    const result = ProductRecordSchema.safeParse(
      makeRecord({ ean: "SKU:12345" }),
    );
    expect(result.success).toBe(false);
  });

  test("accepts 8-digit EAN", () => {
    const result = ProductRecordSchema.safeParse(
      makeRecord({ ean: "12345678" }),
    );
    expect(result.success).toBe(true);
  });

  test("accepts 14-digit EAN", () => {
    const result = ProductRecordSchema.safeParse(
      makeRecord({ ean: "12345678901234" }),
    );
    expect(result.success).toBe(true);
  });

  test("rejects negative price", () => {
    const result = ProductRecordSchema.safeParse(makeRecord({ price_sek: -1 }));
    expect(result.success).toBe(false);
  });

  test("rejects price above 500000", () => {
    const result = ProductRecordSchema.safeParse(
      makeRecord({ price_sek: 500_001 }),
    );
    expect(result.success).toBe(false);
  });

  test("rejects non-URL affiliate_url", () => {
    const result = ProductRecordSchema.safeParse(
      makeRecord({ affiliate_url: "not-a-url" }),
    );
    expect(result.success).toBe(false);
  });

  test("accepts null image_url", () => {
    const result = ProductRecordSchema.safeParse(
      makeRecord({ image_url: null }),
    );
    expect(result.success).toBe(true);
  });

  test("accepts undefined image_url", () => {
    const { image_url: _, ...withoutImage } = makeRecord();
    const result = ProductRecordSchema.safeParse(withoutImage);
    expect(result.success).toBe(true);
  });

  test("rejects name shorter than 3 chars", () => {
    const result = ProductRecordSchema.safeParse(makeRecord({ name: "AB" }));
    expect(result.success).toBe(false);
  });

  test("rejects non-date scraped_at", () => {
    const result = ProductRecordSchema.safeParse(
      makeRecord({ scraped_at: "2024-01-01" }),
    );
    expect(result.success).toBe(false);
  });
});

// ─── validateRecords ──────────────────────────────────────────────────────────
describe("validateRecords()", () => {
  test("returns valid and invalid arrays", () => {
    const records = [
      makeRecord(),
      makeRecord({ ean: "bad" }),
      makeRecord({ price_sek: 500 }),
    ];
    const { valid, invalid } = validateRecords(records, "test");
    expect(valid).toHaveLength(2);
    expect(invalid).toHaveLength(1);
  });

  test("valid records pass through unchanged", () => {
    const rec = makeRecord();
    const { valid } = validateRecords([rec], "test");
    expect(valid[0].ean).toBe(rec.ean);
    expect(valid[0].price_sek).toBe(rec.price_sek);
  });

  test("returns empty arrays for empty input", () => {
    const { valid, invalid } = validateRecords([], "test");
    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });

  test("invalid record includes error details", () => {
    const { invalid } = validateRecords([makeRecord({ ean: "bad" })], "test");
    expect(invalid[0].errors).toBeDefined();
    expect(invalid[0].errors.length).toBeGreaterThan(0);
    expect(invalid[0].errors[0]).toMatch(/ean/i);
  });
});

// ─── isSuspiciousPriceChange ──────────────────────────────────────────────────
describe("isSuspiciousPriceChange()", () => {
  test("returns false when no previous price", () => {
    expect(isSuspiciousPriceChange(1000, null)).toBe(false);
    expect(isSuspiciousPriceChange(1000, 0)).toBe(false);
  });

  test("returns false for small change (< 40%)", () => {
    expect(isSuspiciousPriceChange(1000, 800)).toBe(false); // 25% increase
    expect(isSuspiciousPriceChange(800, 1000)).toBe(false); // 20% decrease
  });

  test("returns true for large increase (> 40%)", () => {
    expect(isSuspiciousPriceChange(2000, 1000)).toBe(true); // 100% increase
    expect(isSuspiciousPriceChange(1500, 1000)).toBe(true); // 50% increase
  });

  test("returns true for large decrease (> 40%)", () => {
    expect(isSuspiciousPriceChange(500, 1000)).toBe(true); // 50% decrease
    expect(isSuspiciousPriceChange(400, 1000)).toBe(true); // 60% decrease
  });

  test("boundary: exactly 40% change is not suspicious", () => {
    expect(isSuspiciousPriceChange(1400, 1000)).toBe(false); // exactly 40%
    expect(isSuspiciousPriceChange(600, 1000)).toBe(false); // exactly 40% down
  });

  test("boundary: just above 40% is suspicious", () => {
    expect(isSuspiciousPriceChange(1401, 1000)).toBe(true);
    expect(isSuspiciousPriceChange(599, 1000)).toBe(true);
  });
});
