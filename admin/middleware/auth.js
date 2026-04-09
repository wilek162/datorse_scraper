"use strict";

/**
 * Admin Control Panel — HTTP Basic Auth middleware.
 *
 * Reads ADMIN_SECRET_KEY from env. The browser sends a native credential
 * dialog (HTTP 401 WWW-Authenticate). Over HTTPS this is secure and requires
 * zero frontend code.
 *
 * Username: "admin" (any value accepted, only password is checked)
 * Password: ADMIN_SECRET_KEY
 */

const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY;

function requireAuth(req, res, next) {
  if (!ADMIN_SECRET) {
    // Guard: refuse all requests if the env var is not set.
    res.status(503).send("Admin panel not configured: set ADMIN_SECRET_KEY");
    return;
  }

  const header = req.headers.authorization || "";

  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    // format is "username:password" — only check the password half
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (password === ADMIN_SECRET) {
      return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Datorsc Admin"');
  res.status(401).send("Unauthorized");
}

module.exports = { requireAuth };
