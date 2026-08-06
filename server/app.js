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
  /* self, not () — calling needs getUserMedia and getDisplayMedia, and an
     empty allowlist here blocks them before the permission prompt appears.
     Games run in an iframe and are not granted any of it. */
  res.setHeader("Permissions-Policy",
    "geolocation=(), microphone=(self), camera=(self), display-capture=(self)");
  next();
});

/* The API is cookie-authenticated, so an unrecognised Origin on a
   state-changing request is a CSRF attempt. Same origin always passes; other
   origins must be named explicitly in ALLOWED_ORIGINS — that's what lets the
   static site live on Vercel while the API lives here.
     ALLOWED_ORIGINS=https://websitegames.vercel.app,https://arcadecampushub.online */
const ALLOWED = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

function originAllowed(origin, host) {
  if (!origin) return true;                     // same-origin fetch, curl, app
  try {
    if (new URL(origin).host === host) return true;
  } catch { return false; }                     // malformed Origin
  return ALLOWED.includes(origin.replace(/\/+$/, ""));
}

app.use("/api", (req, res, next) => {
  const origin = req.headers.origin;
  const allowed = originAllowed(origin, req.headers.host);

  if (origin && allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  /* Vary regardless, so a cached response for one origin is never reused. */
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(allowed ? 204 : 403).end();
  if (req.method === "GET" || req.method === "HEAD") return next();
  if (!allowed) return res.status(403).json({ error: "Cross-origin requests are not allowed." });
  next();
});

/* Two things arrive base64'd and so inflate ~4/3: chat images (capped at
   600 KB decoded) and game saves (capped at 4 MB, because IndexedDB saves
   carry binary). This has to clear the larger of the two. */
app.use(express.json({ limit: "6mb" }));
app.use(A.attachUser);

/* ------------------------------------------------------------------ routes */

app.use("/api/auth", require("./routes/auth"));
app.use("/api", require("./routes/social"));
app.use("/api", require("./routes/messages"));
app.use("/api", require("./routes/notifications"));
app.use("/api", require("./routes/sync"));
app.use("/api", require("./routes/feedback"));
app.use("/api", require("./routes/support"));
app.use("/api", require("./routes/calls"));
app.use("/api", require("./routes/catalog"));
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
    if (ALLOWED.length) {
      console.log("Cross-origin frontends allowed: " + ALLOWED.join(", "));
      console.log("Session cookies are SameSite=None; Secure — HTTPS required.");
    }
  });
}

module.exports = app;
