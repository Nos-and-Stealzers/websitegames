/* Arcade Campus Hub — API + static host.
 *
 *   node server/app.js                 serve site + API on :8787
 *   PORT=3000 node server/app.js       different port
 *   ARCADE_DB=/data/a.db node …        database elsewhere
 *
 * The first account created becomes the admin.
 */
"use strict";

const path = require("path");
const express = require("express");

const { db } = require("./db");
const A = require("./auth");

const app = express();
const PORT = Number(process.env.PORT || 8787);
const SITE = path.join(__dirname, "..");

app.set("trust proxy", 1);
app.disable("x-powered-by");

/* --------------------------------------------------------------- hardening */

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});

/* Same-origin only: the API is cookie-authenticated, so a stray Origin header
   on a state-changing request is a CSRF attempt. */
app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const origin = req.headers.origin;
  if (!origin) return next();                       // same-origin fetch or curl
  const host = req.headers.host;
  try {
    if (new URL(origin).host === host) return next();
  } catch { /* malformed Origin falls through to the rejection */ }
  return res.status(403).json({ error: "Cross-origin requests are not allowed." });
});

app.use(express.json({ limit: "1mb" }));
app.use(A.attachUser);

/* ------------------------------------------------------------------ routes */

app.use("/api/auth", require("./routes/auth"));
app.use("/api", require("./routes/social"));
app.use("/api", require("./routes/messages"));
app.use("/api", require("./routes/notifications"));
app.use("/api", require("./routes/sync"));
app.use("/api/admin", require("./routes/admin"));

app.get("/api/health", (req, res) => {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM users").get();
  res.json({ ok: true, users: n, needsSetup: n === 0, uptime: Math.round(process.uptime()) });
});

app.use("/api", (req, res) => res.status(404).json({ error: "No such endpoint." }));

/* --------------------------------------------------------- static frontend */

app.use(express.static(SITE, {
  extensions: ["html"],
  setHeaders(res, file) {
    if (/[\\/]games[\\/]/.test(file)) return;
    if (/\.(css|js|svg)$/.test(file)) res.setHeader("Cache-Control", "public, max-age=300");
  }
}));

app.use((req, res) => res.status(404).sendFile(path.join(SITE, "404.html")));

/* ------------------------------------------------------------ error handler */

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "Something broke on our end." : err.message });
});

/* ------------------------------------------------------------------- start */

if (require.main === module) {
  app.listen(PORT, () => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM users").get();
    console.log(`Arcade Campus Hub → http://localhost:${PORT}`);
    console.log(n === 0
      ? "No accounts yet — the first signup becomes the admin."
      : `${n} account${n === 1 ? "" : "s"} registered.`);
  });
}

module.exports = app;
