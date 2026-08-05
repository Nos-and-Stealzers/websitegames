/* Direct messages and group threads.
   Membership lives in thread_members for every thread, group or not, so
   there is exactly one membership check in the codebase. threads.a_id/b_id
   survive only to keep the one-DM-per-pair unique index working. */
"use strict";

const express = require("express");
const { db } = require("../db");
const A = require("../auth");
const S = require("../shape");
const social = require("./social");
const notify = require("../notify");

const router = express.Router();

const sendLimit = A.rateLimit({ name: "send", windowMs: 60000, max: 30 });
/* Only counts requests that actually carry an image, so ordinary chat isn't
   throttled by the much tighter upload budget. */
const uploadLimit = A.rateLimit({
  name: "upload", windowMs: 300000, max: 20,
  when: (req) => !!(req.body && req.body.image)
});

const MAX_ATTACHMENT = 600 * 1024;      // decoded bytes
const MAX_GROUP = 25;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/* ------------------------------------------------------------ membership */

function memberIds(threadId) {
  return db.prepare("SELECT user_id FROM thread_members WHERE thread_id = ?")
    .all(threadId).map((r) => r.user_id);
}

function isMember(threadId, userId) {
  return !!db.prepare("SELECT 1 FROM thread_members WHERE thread_id = ? AND user_id = ?")
    .get(threadId, userId);
}

function thread(id) {
  return db.prepare("SELECT * FROM threads WHERE id = ?").get(Number(id));
}

function members(threadId) {
  return db.prepare(
    `SELECT u.*, m.role AS member_role FROM thread_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.thread_id = ? ORDER BY u.username`
  ).all(threadId);
}

function otherId(threadId, me) {
  return memberIds(threadId).filter((id) => id !== me)[0] || null;
}

function pair(a, b) { return a < b ? [a, b] : [b, a]; }

function addMember(threadId, userId, role) {
  db.prepare(
    "INSERT OR IGNORE INTO thread_members (thread_id, user_id, role, joined_at) VALUES (?,?,?,?)"
  ).run(threadId, userId, role || "member", Date.now());
}

function openDm(a, b) {
  const [lo, hi] = pair(a, b);
  const found = db.prepare("SELECT * FROM threads WHERE a_id = ? AND b_id = ? AND is_group = 0")
    .get(lo, hi);
  if (found) { addMember(found.id, a); addMember(found.id, b); return found; }

  const now = Date.now();
  const info = db.prepare(
    "INSERT INTO threads (a_id, b_id, is_group, created_at, last_at) VALUES (?,?,0,?,?)"
  ).run(lo, hi, now, now);
  addMember(info.lastInsertRowid, lo);
  addMember(info.lastInsertRowid, hi);
  return thread(info.lastInsertRowid);
}

/* May `me` start or continue a one-to-one conversation with `them`? */
function canMessage(me, them) {
  if (social.isBlocked(me, them)) return "You can't message this person.";
  const target = db.prepare("SELECT accepts_dms, state FROM users WHERE id = ?").get(them);
  if (!target) return "No such user.";
  if (target.state === "suspended") return "That account is suspended.";
  if (!target.accepts_dms && !social.areFriends(me, them)) {
    return "This person only accepts messages from friends.";
  }
  return null;
}

/* In a group, the only gate is membership plus not being blocked by whoever
   you'd be talking to — DM privacy settings don't apply. */
function canPost(me, t) {
  if (!isMember(t.id, me)) return "You're not in this conversation.";
  if (!t.is_group) {
    const them = otherId(t.id, me);
    return them ? canMessage(me, them) : "This conversation has no one else in it.";
  }
  return null;
}

function threadShape(t, me) {
  const people = members(t.id).filter((u) => u.id !== me);
  const base = {
    id: t.id,
    isGroup: !!t.is_group,
    lastAt: t.last_at,
    members: people.map(S.publicUser)
  };
  if (t.is_group) {
    base.title = t.title || people.map((u) => u.display_name || u.username).join(", ") || "Group";
    base.owner = t.owner_id === me;
    base.memberCount = people.length + 1;
  } else {
    base.with = people[0] ? S.publicUser(people[0]) : null;
    base.title = base.with ? (base.with.displayName || base.with.username) : "Conversation";
  }
  return base;
}

/* ------------------------------------------------------------- listings */

router.get("/messages/threads", A.requireUser, (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(
    `SELECT t.* FROM threads t
       JOIN thread_members m ON m.thread_id = t.id AND m.user_id = ?
      WHERE t.last_at > 0
      ORDER BY t.last_at DESC LIMIT 100`
  ).all(me);

  const lastOf = db.prepare(
    `SELECT m.body, m.sender_id, m.created_at, m.kind, u.username, u.display_name
       FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.thread_id = ? AND m.deleted = 0 ORDER BY m.id DESC LIMIT 1`
  );
  const unreadOf = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND sender_id != ? AND read_at = 0 AND deleted = 0"
  );

  res.json({
    threads: rows.map((t) => {
      const last = lastOf.get(t.id);
      const shape = threadShape(t, me);
      shape.unread = unreadOf.get(t.id, me).n;
      shape.preview = last ? {
        body: last.kind === "image" && !last.body ? "sent an image" : last.body.slice(0, 140),
        mine: last.sender_id === me,
        who: last.display_name || last.username,
        at: last.created_at
      } : null;
      return shape;
    })
  });
});

/* Everything the rail needs to paint its badges, in one round trip. */
router.get("/messages/unread", A.requireUser, (req, res) => {
  const me = req.user.id;
  const { n } = db.prepare(
    `SELECT COUNT(*) AS n FROM messages m
       JOIN thread_members tm ON tm.thread_id = m.thread_id AND tm.user_id = ?
      WHERE m.sender_id != ? AND m.read_at = 0 AND m.deleted = 0`
  ).get(me, me);

  const { r } = db.prepare(
    "SELECT COUNT(*) AS r FROM friendships WHERE addressee_id = ? AND state = 'pending'"
  ).get(me);

  res.json({ messages: n, requests: r, notifications: notify.unreadCount(me) });
});

router.post("/messages/with/:username", A.requireUser, (req, res) => {
  const target = db.prepare("SELECT * FROM users WHERE username_lower = ?")
    .get(String(req.params.username).toLowerCase());
  if (!target) return res.status(404).json({ error: "No such user." });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't message yourself." });

  const denied = canMessage(req.user.id, target.id);
  if (denied) return res.status(403).json({ error: denied });

  const t = openDm(req.user.id, target.id);
  res.json({ threadId: t.id, with: S.publicUser(target) });
});

/* ---------------------------------------------------------------- groups */

router.post("/threads/group", A.requireUser, (req, res, next) => {
  try {
    const title = req.body.title
      ? S.str(req.body.title, { field: "Group name", max: 60 }) : "";
    const names = Array.isArray(req.body.usernames) ? req.body.usernames.slice(0, MAX_GROUP) : [];
    if (!names.length) throw S.fail("Pick at least one person.");

    const invited = [];
    for (const raw of names) {
      const u = db.prepare("SELECT * FROM users WHERE username_lower = ?")
        .get(String(raw).toLowerCase().replace(/^@/, ""));
      if (!u) throw S.fail(`No user called ${raw}.`);
      if (u.id === req.user.id) continue;
      if (social.isBlocked(req.user.id, u.id)) throw S.fail(`You can't add ${u.username}.`);
      /* Groups are friends-only: otherwise they'd be a way around DM privacy. */
      if (!social.areFriends(req.user.id, u.id)) {
        throw S.fail(`You can only add friends to a group — ${u.username} isn't one yet.`);
      }
      invited.push(u);
    }
    if (!invited.length) throw S.fail("Pick at least one person.");

    const now = Date.now();
    const info = db.prepare(
      "INSERT INTO threads (is_group, title, owner_id, created_at, last_at) VALUES (1,?,?,?,?)"
    ).run(title, req.user.id, now, now);
    const id = info.lastInsertRowid;

    addMember(id, req.user.id, "owner");
    invited.forEach((u) => {
      addMember(id, u.id);
      notify.push(u.id, "group", {
        actorId: req.user.id,
        body: `${req.user.display_name || req.user.username} added you to ${title || "a group"}`,
        link: "messages.html?thread=" + id
      });
    });

    res.status(201).json({ thread: threadShape(thread(id), req.user.id) });
  } catch (err) { next(err); }
});

router.patch("/threads/:id", A.requireUser, (req, res, next) => {
  try {
    const t = thread(req.params.id);
    if (!t || !isMember(t.id, req.user.id)) return res.status(404).json({ error: "No such thread." });
    if (!t.is_group) throw S.fail("Only groups can be renamed.");
    if (t.owner_id !== req.user.id) return res.status(403).json({ error: "Only the owner can rename this." });

    const title = S.str(req.body.title, { field: "Group name", max: 60 });
    db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, t.id);
    res.json({ thread: threadShape(thread(t.id), req.user.id) });
  } catch (err) { next(err); }
});

router.post("/threads/:id/members", A.requireUser, (req, res, next) => {
  try {
    const t = thread(req.params.id);
    if (!t || !isMember(t.id, req.user.id)) return res.status(404).json({ error: "No such thread." });
    if (!t.is_group) throw S.fail("You can't add people to a direct message — make a group.");
    if (memberIds(t.id).length >= MAX_GROUP) throw S.fail("That group is full.");

    const name = S.str(req.body.username, { field: "Username", max: 20 }).replace(/^@/, "");
    const u = db.prepare("SELECT * FROM users WHERE username_lower = ?").get(name.toLowerCase());
    if (!u) return res.status(404).json({ error: "No such user." });
    if (isMember(t.id, u.id)) throw S.fail("They're already in this group.");
    if (!social.areFriends(req.user.id, u.id)) {
      throw S.fail("You can only add your own friends to a group.");
    }

    addMember(t.id, u.id);
    notify.push(u.id, "group", {
      actorId: req.user.id,
      body: `${req.user.display_name || req.user.username} added you to ${t.title || "a group"}`,
      link: "messages.html?thread=" + t.id
    });
    res.status(201).json({ thread: threadShape(thread(t.id), req.user.id) });
  } catch (err) { next(err); }
});

/* Leave yourself, or — as owner — remove someone else. */
router.delete("/threads/:id/members/:userId", A.requireUser, (req, res) => {
  const t = thread(req.params.id);
  if (!t || !isMember(t.id, req.user.id)) return res.status(404).json({ error: "No such thread." });
  if (!t.is_group) return res.status(400).json({ error: "You can't leave a direct message." });

  const targetId = Number(req.params.userId);
  const self = targetId === req.user.id;
  if (!self && t.owner_id !== req.user.id) {
    return res.status(403).json({ error: "Only the owner can remove people." });
  }

  db.prepare("DELETE FROM thread_members WHERE thread_id = ? AND user_id = ?").run(t.id, targetId);

  const left = memberIds(t.id);
  if (!left.length) {
    db.prepare("DELETE FROM threads WHERE id = ?").run(t.id);
  } else if (self && t.owner_id === req.user.id) {
    /* Hand ownership on rather than leaving the group headless. */
    db.prepare("UPDATE threads SET owner_id = ? WHERE id = ?").run(left[0], t.id);
    db.prepare("UPDATE thread_members SET role = 'owner' WHERE thread_id = ? AND user_id = ?")
      .run(t.id, left[0]);
  }
  res.json({ ok: true });
});

/* ------------------------------------------------------------- messages */

router.get("/messages/threads/:id", A.requireUser, (req, res) => {
  const t = thread(req.params.id);
  if (!t || !isMember(t.id, req.user.id)) return res.status(404).json({ error: "No such thread." });

  const after = Number(req.query.after || 0) || 0;
  const rows = db.prepare(
    `SELECT m.id, m.sender_id, m.body, m.created_at, m.deleted, m.kind, m.attachment_id,
            u.username, u.display_name,
            a.mime, a.width, a.height, a.bytes, a.kind AS shot_kind
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN attachments a ON a.id = m.attachment_id
      WHERE m.thread_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT 200`
  ).all(t.id, after);

  db.prepare(
    "UPDATE messages SET read_at = ? WHERE thread_id = ? AND sender_id != ? AND read_at = 0"
  ).run(Date.now(), t.id, req.user.id);

  res.json(Object.assign(threadShape(t, req.user.id), {
    threadId: t.id,
    canSend: !canPost(req.user.id, t),
    messages: rows.map((m) => ({
      id: m.id,
      mine: m.sender_id === req.user.id,
      from: { username: m.username, displayName: m.display_name || m.username },
      body: m.deleted ? "" : m.body,
      deleted: !!m.deleted,
      at: m.created_at,
      image: m.attachment_id && !m.deleted ? {
        id: m.attachment_id,
        url: "/api/attachments/" + m.attachment_id,
        mime: m.mime, width: m.width, height: m.height,
        bytes: m.bytes, kind: m.shot_kind
      } : null
    }))
  }));
});

/* Body, an image, or both. */
router.post("/messages/threads/:id", A.requireUser, sendLimit, uploadLimit, (req, res, next) => {
  try {
    const t = thread(req.params.id);
    if (!t || !isMember(t.id, req.user.id)) return res.status(404).json({ error: "No such thread." });

    const denied = canPost(req.user.id, t);
    if (denied) return res.status(403).json({ error: denied });

    const raw = req.body.body == null ? "" : String(req.body.body).trim();
    const image = req.body.image;

    if (!raw && !image) throw S.fail("Say something or attach an image.");
    if (raw.length > 2000) throw S.fail("Message must be 2000 characters or fewer.");

    let attachmentId = null;
    let stored = null;
    if (image) {
      stored = saveAttachment(req.user.id, t.id, image);
      attachmentId = stored.id;
    }

    const now = Date.now();
    const info = db.prepare(
      `INSERT INTO messages (thread_id, sender_id, body, created_at, kind, attachment_id)
       VALUES (?,?,?,?,?,?)`
    ).run(t.id, req.user.id, raw, now, attachmentId ? "image" : "text", attachmentId);

    db.prepare("UPDATE threads SET last_at = ? WHERE id = ?").run(now, t.id);

    /* Everyone else in the thread hears about it. */
    memberIds(t.id).filter((id) => id !== req.user.id).forEach((id) => {
      notify.on.message(id, req.user, t.id);
    });

    res.status(201).json({
      message: {
        id: info.lastInsertRowid,
        mine: true,
        from: {
          username: req.user.username,
          displayName: req.user.display_name || req.user.username
        },
        body: raw,
        deleted: false,
        at: now,
        image: stored ? {
          id: stored.id, url: "/api/attachments/" + stored.id,
          mime: stored.mime, width: stored.width, height: stored.height,
          bytes: stored.bytes, kind: stored.kind
        } : null
      }
    });
  } catch (err) { next(err); }
});

router.delete("/messages/:id", A.requireUser, (req, res) => {
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Not found." });

  const staff = req.user.role === "admin" || req.user.role === "mod";
  if (row.sender_id !== req.user.id && !staff) {
    return res.status(403).json({ error: "That isn't yours." });
  }
  db.prepare("UPDATE messages SET deleted = 1, body = '' WHERE id = ?").run(row.id);
  if (row.attachment_id) {
    db.prepare("DELETE FROM attachments WHERE id = ?").run(row.attachment_id);
  }
  res.json({ ok: true });
});

/* ---------------------------------------------------------- attachments */

/* Accepts a data URL produced by the browser after it has already downscaled
   and re-encoded the image. Server-side we only validate and cap. */
function saveAttachment(userId, threadId, image) {
  const kind = ["screenshot", "camera", "upload"].includes(image.kind) ? image.kind : "upload";
  const dataUrl = String(image.dataUrl || "");

  const match = dataUrl.match(/^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw S.fail("That image could not be read.");

  const mime = match[1].toLowerCase();
  if (!IMAGE_TYPES.includes(mime)) throw S.fail("Only JPEG, PNG, WebP and GIF images are allowed.");

  const buf = Buffer.from(match[2], "base64");
  if (!buf.length) throw S.fail("That image is empty.");
  if (buf.length > MAX_ATTACHMENT) {
    throw S.fail(`Images must be under ${Math.floor(MAX_ATTACHMENT / 1024)} KB — try a smaller one.`);
  }

  const info = db.prepare(
    `INSERT INTO attachments (uploader_id, thread_id, kind, mime, width, height, bytes, data, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(userId, threadId, kind, mime,
        Math.max(0, Number(image.width) || 0), Math.max(0, Number(image.height) || 0),
        buf.length, buf, Date.now());

  return {
    id: info.lastInsertRowid, mime, kind,
    width: Number(image.width) || 0, height: Number(image.height) || 0,
    bytes: buf.length
  };
}

/* Images are private to the thread they were posted in. */
router.get("/attachments/:id", A.requireUser, (req, res) => {
  const row = db.prepare("SELECT * FROM attachments WHERE id = ?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Not found." });
  if (!isMember(row.thread_id, req.user.id)) {
    return res.status(404).json({ error: "Not found." });
  }
  res.setHeader("Content-Type", row.mime);
  res.setHeader("Content-Length", row.bytes);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("Content-Disposition", "inline");
  res.end(row.data);
});

module.exports = router;
module.exports.isMember = isMember;
