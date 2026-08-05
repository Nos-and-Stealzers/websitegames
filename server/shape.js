/* Input validation and the shapes sent back to the browser.
   Nothing here ever emits pass_hash / pass_salt. */
"use strict";

const ONLINE_WINDOW = 150000;   // 2.5 min since last authed request

const RULES = {
  username: /^[a-z][a-z0-9_]{2,19}$/i,
  reserved: new Set([
    "admin", "administrator", "root", "system", "moderator", "mod", "staff",
    "support", "help", "null", "undefined", "me", "you", "everyone", "here"
  ])
};

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function str(value, { field, min = 0, max = 1000, trim = true } = {}) {
  if (typeof value !== "string") throw fail(`${field} is required.`);
  const out = trim ? value.trim() : value;
  if (out.length < min) throw fail(`${field} must be at least ${min} characters.`);
  if (out.length > max) throw fail(`${field} must be ${max} characters or fewer.`);
  return out;
}

function username(value) {
  const name = str(value, { field: "Username", min: 3, max: 20 });
  if (!RULES.username.test(name)) {
    throw fail("Usernames are 3–20 characters, letters/numbers/underscore, starting with a letter.");
  }
  if (RULES.reserved.has(name.toLowerCase())) throw fail("That username is reserved.");
  return name;
}

function password(value) {
  if (typeof value !== "string") throw fail("Password is required.");
  if (value.length < 8) throw fail("Password must be at least 8 characters.");
  if (value.length > 200) throw fail("Password is too long.");
  if (!/[a-z]/i.test(value) || !/[0-9]/.test(value)) {
    throw fail("Password needs at least one letter and one number.");
  }
  return value;
}

function online(user) {
  return !!user.last_seen && Date.now() - user.last_seen < ONLINE_WINDOW;
}

/* What any signed-in visitor may see about someone else. */
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    bio: row.bio || "",
    role: row.role,
    state: row.state,
    online: online(row),
    lastSeen: row.last_seen || 0,
    createdAt: row.created_at
  };
}

/* Extra fields only the account owner gets. The friend code is deliberately
   private — it's a share-with-who-you-choose handle, not a public one. */
function privateUser(row) {
  return Object.assign(publicUser(row), {
    acceptsDms: !!row.accepts_dms,
    showActivity: !!row.show_activity,
    friendCode: row.friend_code || ""
  });
}

/* Friend codes are typed by hand, so accept any casing, spacing or missing
   dash and normalise to the canonical ABC-123 form. */
function friendCode(value) {
  const raw = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 6) throw fail("Friend codes are six characters, like ABC-123.");
  return raw.slice(0, 3) + "-" + raw.slice(3);
}

/* Admin listing adds moderation context; still no credential material. */
function adminUser(row) {
  return Object.assign(publicUser(row), {
    acceptsDms: !!row.accepts_dms,
    sessions: row.sessions ?? 0,
    friends: row.friends ?? 0,
    messages: row.messages ?? 0
  });
}

module.exports = {
  fail, str, username, password, friendCode,
  online, publicUser, privateUser, adminUser,
  ONLINE_WINDOW
};
