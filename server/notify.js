/* Notification emitting.
   Kept in one place so every event that deserves a bell goes through the same
   door, with the same de-duplication and the same retention. */
"use strict";

const { db } = require("./db");

const KEEP = 200;                 // per user; older rows are trimmed away
const MESSAGE_QUIET_MS = 300000;  // one "new message" ping per 5 min per sender

/* Never notify someone about their own action, and never pile up dozens of
   identical rows — a chatty friend should produce one bell, not forty. */
function push(userId, kind, { actorId = null, body = "", link = "", dedupeMs = 0 } = {}) {
  if (!userId) return null;
  if (actorId && actorId === userId) return null;

  if (dedupeMs) {
    const recent = db.prepare(
      `SELECT id FROM notifications
        WHERE user_id = ? AND kind = ? AND IFNULL(actor_id, 0) = ? AND created_at > ?
        ORDER BY id DESC LIMIT 1`
    ).get(userId, kind, actorId || 0, Date.now() - dedupeMs);

    if (recent) {
      /* Refresh the existing one instead of adding another. */
      db.prepare("UPDATE notifications SET created_at = ?, read_at = 0, body = ? WHERE id = ?")
        .run(Date.now(), body, recent.id);
      return recent.id;
    }
  }

  const info = db.prepare(
    `INSERT INTO notifications (user_id, kind, actor_id, body, link, created_at)
     VALUES (?,?,?,?,?,?)`
  ).run(userId, kind, actorId, String(body).slice(0, 300), String(link).slice(0, 200), Date.now());

  trim(userId);
  return info.lastInsertRowid;
}

function trim(userId) {
  db.prepare(
    `DELETE FROM notifications
      WHERE user_id = ?
        AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?)`
  ).run(userId, userId, KEEP);
}

function unreadCount(userId) {
  return db.prepare(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at = 0"
  ).get(userId).n;
}

/* --- the specific events, so callers don't hand-write strings --- */

const on = {
  friendRequest(toId, fromUser) {
    return push(toId, "friend-request", {
      actorId: fromUser.id,
      body: `${fromUser.display_name || fromUser.username} sent you a friend request`,
      link: "friends.html"
    });
  },

  friendAccepted(toId, byUser) {
    return push(toId, "friend-accept", {
      actorId: byUser.id,
      body: `${byUser.display_name || byUser.username} accepted your friend request`,
      link: `profile.html?u=${encodeURIComponent(byUser.username)}`
    });
  },

  message(toId, fromUser, threadId) {
    return push(toId, "message", {
      actorId: fromUser.id,
      body: `New message from ${fromUser.display_name || fromUser.username}`,
      link: `messages.html?thread=${threadId}`,
      dedupeMs: MESSAGE_QUIET_MS
    });
  },

  roleChanged(toId, role, actorId) {
    return push(toId, "role", {
      actorId,
      body: role === "user"
        ? "Your staff access was removed"
        : `You were made ${role === "admin" ? "an administrator" : "a moderator"}`,
      link: role === "user" ? "" : "admin.html"
    });
  },

  stateChanged(toId, state, actorId) {
    return push(toId, "state", {
      actorId,
      body: state === "suspended"
        ? "Your account was suspended"
        : "Your account was reinstated",
      link: ""
    });
  },

  reportClosed(toId, target) {
    return push(toId, "report", {
      body: `Your report about ${target} was reviewed`,
      link: ""
    });
  }
};

module.exports = { push, unreadCount, trim, on };
