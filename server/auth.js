/* Password hashing, session issue/verify, request guards, rate limiting. */
"use strict";

const crypto = require("crypto");
const { db, audit } = require("./db");

const SESSION_DAYS = 30;
const COOKIE = "ach_session";

/* ------------------------------------------------------------- passwords */

/* scrypt with a per-user salt. Node ships it; no native dependency needed. */
function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
}

function makePassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hash(password, salt) };
}

function checkPassword(password, user) {
  const attempt = Buffer.from(hash(password, user.pass_salt), "hex");
  const stored = Buffer.from(user.pass_hash, "hex");
  if (attempt.length !== stored.length) return false;
  return crypto.timingSafeEqual(attempt, stored);   // constant time
}

/* -------------------------------------------------------------- sessions */

function issueSession(userId, agent) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at, agent) VALUES (?,?,?,?,?)"
  ).run(token, userId, now, now + SESSION_DAYS * 864e5, String(agent || "").slice(0, 200));
  return token;
}

function readSession(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.token, s.expires_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return row;
}

function dropSession(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

function dropAllSessions(userId, keepToken) {
  if (keepToken) {
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(userId, keepToken);
  } else {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
}

function sweepSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

/* --------------------------------------------------------------- cookies */

/* When the frontend is served from another origin (static site on Vercel, API
   here), the session cookie has to be SameSite=None — and browsers only accept
   that together with Secure, so cross-site deployments must be HTTPS. */
const CROSS_SITE = !!String(process.env.ALLOWED_ORIGINS || "").trim();

function cookieAttrs() {
  const attrs = ["Path=/", "HttpOnly"];
  if (CROSS_SITE) {
    attrs.push("SameSite=None", "Secure");
  } else {
    attrs.push("SameSite=Lax");
    if (process.env.NODE_ENV === "production") attrs.push("Secure");
  }
  return attrs;
}

function setCookie(res, token) {
  res.setHeader("Set-Cookie",
    [`${COOKIE}=${token}`, ...cookieAttrs(), `Max-Age=${SESSION_DAYS * 86400}`].join("; "));
}

function clearCookie(res) {
  /* Attributes must match the ones it was set with or the browser keeps it. */
  res.setHeader("Set-Cookie", [`${COOKIE}=`, ...cookieAttrs(), "Max-Age=0"].join("; "));
}

function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/* ---------------------------------------------------------------- guards */

/* Attaches req.user when a valid session cookie is present. Never rejects. */
function attachUser(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const row = readSession(token);
  if (row) {
    req.token = token;
    req.user = row;
    const now = Date.now();
    if (now - row.last_seen > 60000) {
      db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(now, row.id);
      row.last_seen = now;
    }
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sign in to do that." });
  if (req.user.state === "suspended") {
    return res.status(403).json({ error: "This account is suspended." });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Sign in to do that." });
    if (!roles.includes(req.user.role)) {
      audit(req.user.id, "denied", `${req.method} ${req.originalUrl}`);
      return res.status(403).json({ error: "You don't have access to that." });
    }
    next();
  };
}

/* ---------------------------------------------------------- rate limiting */

const buckets = new Map();
let limiterSeq = 0;

/* Fixed-window counter per key. Enough for brute-force defence on one box.
   Each limiter gets its own namespace — without it, two limiters with no `key`
   would share a bucket and throttle each other from unrelated endpoints. */
function rateLimit({ windowMs, max, key, name }) {
  const scope = name || "rl" + (++limiterSeq);
  return (req, res, next) => {
    const id = scope + "|" + (key ? key(req) : "") + "|" + (req.ip || "");
    const now = Date.now();
    let b = buckets.get(id);
    if (!b || b.reset < now) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(id, b);
    }
    b.count++;
    if (b.count > max) {
      const wait = Math.ceil((b.reset - now) / 1000);
      res.setHeader("Retry-After", wait);
      return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.` });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
  sweepSessions();
}, 300000).unref();

module.exports = {
  COOKIE,
  makePassword, checkPassword,
  issueSession, readSession, dropSession, dropAllSessions,
  setCookie, clearCookie, parseCookies,
  attachUser, requireUser, requireRole,
  rateLimit
};
