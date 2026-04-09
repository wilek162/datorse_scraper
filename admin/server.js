"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const { requireAuth } = require("./middleware/auth");
const db = require("../lib/db");
const logger = require("../lib/logger");

const app = express();

// ─── Static + body parsing ───────────────────────────────────────────────────
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use("/static", express.static(path.join(__dirname, "public")));

// ─── View engine (EJS) ───────────────────────────────────────────────────────
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

// ─── Auth on all routes ──────────────────────────────────────────────────────
app.use(requireAuth);

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use("/", require("./routes/index"));
app.use("/sources", require("./routes/sources"));
app.use("/logs", require("./routes/logs"));
app.use("/health", require("./routes/health"));

// ─── Error handler ───────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error("Admin panel error", { err: err.message, stack: err.stack });
  const status = err.status || 500;
  if (req.headers["hx-request"]) {
    // HTMX partial error — return an inline error fragment
    res.status(status).send(`<span class="error">Error: ${err.message}</span>`);
  } else {
    res.status(status).render("error", { message: err.message, status });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = Number(process.env.ADMIN_PORT || 3001);

app.listen(PORT, "127.0.0.1", () => {
  logger.info(`Admin panel listening on http://127.0.0.1:${PORT}`);
});

// Graceful shutdown
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    await db.closePool();
    process.exit(0);
  });
}

module.exports = app; // export for testing
