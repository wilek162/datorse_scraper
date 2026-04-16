"use strict";

/**
 * Data route — /data
 *
 * Read-only browser for the scraped product database.
 *
 * GET /data                  — paginated products list with name/EAN search
 * GET /data/product/:id      — single product with current prices + history
 */

const router = require("express").Router();
const db = require("../../lib/db");

const PAGE_SIZE = 25;

// ─── GET /data ────────────────────────────────────────────────────────────────

router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const q = (req.query.q || "").trim();
    const offset = (page - 1) * PAGE_SIZE;

    const conditions = [];
    const params = [];

    if (q) {
      conditions.push("(p.name LIKE ? OR p.ean LIKE ? OR p.brand LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [countRow] = await db.query(
      `SELECT COUNT(*) AS total FROM dsc_products p ${where}`,
      params,
    );
    const total = countRow.total;

    const products = await db.query(
      `SELECT
          p.id,
          p.ean,
          p.name,
          p.brand,
          p.category,
          p.image_url,
          COUNT(pr.id)        AS price_count,
          MIN(pr.price_sek)   AS best_price,
          MAX(pr.scraped_at)  AS last_price_at
       FROM dsc_products p
       LEFT JOIN dsc_prices pr ON pr.product_id = p.id AND pr.in_stock = 1
       ${where}
       GROUP BY p.id, p.ean, p.name, p.brand, p.category, p.image_url
       ORDER BY p.updated_at DESC
       LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      params.length ? params : undefined,
    );

    res.render("data", {
      title: "Database",
      products,
      page,
      total,
      pageSize: PAGE_SIZE,
      q,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /data/product/:id ────────────────────────────────────────────────────

router.get("/product/:id", async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!productId || Number.isNaN(productId)) {
      const e = new Error("Invalid product ID");
      e.status = 400;
      throw e;
    }

    const [product] = await db.query(
      `SELECT id, ean, name, brand, category, image_url, spec_json, created_at, updated_at
       FROM dsc_products WHERE id = ?`,
      [productId],
    );

    if (!product) {
      const e = new Error("Product not found");
      e.status = 404;
      throw e;
    }

    // Current prices from all retailers
    const prices = await db.query(
      `SELECT retailer, price_sek, in_stock, affiliate_url, scraped_at
       FROM dsc_prices
       WHERE product_id = ?
       ORDER BY price_sek ASC`,
      [productId],
    );

    // Price history (newest first, capped at 100 rows)
    const history = await db.query(
      `SELECT retailer, price_sek, recorded_at
       FROM dsc_price_history
       WHERE product_id = ?
       ORDER BY recorded_at DESC
       LIMIT 100`,
      [productId],
    );

    // Product sources matched to this product
    const sources = await db.query(
      `SELECT ps.external_id, ps.ean AS src_ean, ps.match_status, ps.scraped_at,
              ps.source_id
       FROM dsc_product_sources ps
       WHERE ps.ean = ?
       ORDER BY ps.scraped_at DESC
       LIMIT 50`,
      [product.ean],
    );

    res.render("data-product", {
      title: product.name,
      product,
      prices,
      history,
      sources,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
