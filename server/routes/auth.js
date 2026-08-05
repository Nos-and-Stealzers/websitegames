/* Signup, login, logout, session inspection, password change. */
"use strict";

const express = require("express");
const { db, audit, freshFriendCode, OWNER_USERNAME } = require("../db");
const A = require("../auth");
const S = require("../shape");

const router = express.Router();

/* Generous per-IP cap: a school sits behind one NAT address, so a tight limit
   would lock out a whole building. Still low enough to stop scripted signup
   floods. Override with SIGNUPS_PER_HOUR. */
const signupLimit = A.rateLimit({
  name: "signup",
  windowMs: 3600000,
  max: Number(process.env.SIGNUPS_PER_HOUR || 30)
});
const loginLimit = A.rateLimit({
  name: "login",
  windowMs: 900000, max: 12,
  key: (req) => String((req.body && req.body.username) || "").toLowerCase()
});

/* Rank on creation:
   - the configured owner username always gets `owner`, whenever it signs up
   - otherwise the very first account is admin, so a fresh install has a way in
   - everyone else is a plain user */
function nextRole(username) {
  if (username.toLowerCase() === OWNER_USERNAME) return "owner";
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM users").get();
  return n === 0 ? "admin" : "user";
}

const TERMS_VERSION = String(process.env.TERMS_VERSION || "2026-08-05");

function recordLogin(userId, req, outcome) {
  db.prepare("INSERT INTO logins (user_id, at, ip, agent, outcome) VALUES (?,?,?,?,?)")
    .run(userId, Date.now(), String(req.ip || "").slice(0, 60),
         String(req.headers["user-agent"] || "").slice(0, 200), outcome);
}

router.post("/signup", signupLimit, (req, res, next) => {
  try {
    const name = S.username(req.body.username);
    const pass = S.password(req.body.password);
    const display = req.body.displayName
      ? S.str(req.body.displayName, { field: "Display name", max: 32 })
      : name;

    /* Terms have to be agreed to, and which version is recorded — so a later
       revision can ask again rather than assuming old consent carries. */
    if (req.body.acceptedTerms !== true) {
      throw S.fail("You need to accept the terms and privacy notice to sign up.");
    }

    const taken = db.prepare("SELECT 1 FROM users WHERE username_lower = ?").get(name.toLowerCase());
    if (taken) return res.status(409).json({ error: "That username is taken." });

    const { salt, hash } = A.makePassword(pass);
    const role = nextRole(name);
    const now = Date.now();

    const info = db.prepare(
      `INSERT INTO users (username, username_lower, display_name, pass_hash, pass_salt,
                          role, created_at, last_seen, friend_code,
                          terms_version, terms_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(name, name.toLowerCase(), display, hash, salt, role, now, now,
          freshFriendCode(), TERMS_VERSION, now);

    const token = A.issueSession(info.lastInsertRowid, req.headers["user-agent"]);
    A.setCookie(res, token);
    audit(info.lastInsertRowid, "signup", `${name} as ${role}`);
    recordLogin(info.lastInsertRowid, req, "ok");

    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json({
      user: S.privateUser(row),
      firstAccount: role === "admin" || role === "owner"
    });
  } catch (err) { next(err); }
});

router.post("/login", loginLimit, (req, res, next) => {
  try {
    const name = S.str(req.body.username, { field: "Username", max: 20 });
    const pass = S.str(req.body.password, { field: "Password", max: 200, trim: false });

    const row = db.prepare("SELECT * FROM users WHERE username_lower = ?").get(name.toLowerCase());

    /* Same response either way so the endpoint can't be used to enumerate names. */
    if (!row || !A.checkPassword(pass, row)) {
      /* A failed attempt against a real account is worth recording — that is
         what makes the staff login view useful for spotting an attack. */
      if (row) recordLogin(row.id, req, "failed");
      return res.status(401).json({ error: "Wrong username or password." });
    }
    if (row.state === "suspended") {
      recordLogin(row.id, req, "suspended");
      return res.status(403).json({ error: "This account is suspended." });
    }

    const token = A.issueSession(row.id, req.headers["user-agent"]);
    A.setCookie(res, token);
    db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(Date.now(), row.id);
    recordLogin(row.id, req, "ok");

    res.json({ user: S.privateUser(row), termsVersion: TERMS_VERSION });
  } catch (err) { next(err); }
});

router.post("/logout", (req, res) => {
  A.dropSession(req.token);
  A.clearCookie(res);
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: S.privateUser(req.user) });
});

router.get("/sessions", A.requireUser, (req, res) => {
  const rows = db.prepare(
    "SELECT token, created_at, expires_at, agent FROM sessions WHERE user_id = ? ORDER BY created_at DESC"
  ).all(req.user.id);
  res.json({
    sessions: rows.map((r) => ({
      current: r.token === req.token,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      agent: r.agent
    }))
  });
});

router.post("/password", A.requireUser, (req, res, next) => {
  try {
    const current = S.str(req.body.current, { field: "Current password", max: 200, trim: false });
    const next_ = S.password(req.body.next);

    if (!A.checkPassword(current, req.user)) {
      return res.status(403).json({ error: "Current password is wrong." });
    }

    const { salt, hash } = A.makePassword(next_);
    db.prepare("UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?")
      .run(hash, salt, req.user.id);

    /* Keep this session, cut every other one loose. */
    A.dropAllSessions(req.user.id, req.token);
    audit(req.user.id, "password-change", "");
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post("/signout-everywhere", A.requireUser, (req, res) => {
  A.dropAllSessions(req.user.id, req.token);
  res.json({ ok: true });
});

module.exports = router;
