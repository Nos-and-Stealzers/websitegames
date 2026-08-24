/* A small stand-in for PostgREST and GoTrue, over a real Postgres.
 *
 * It exists so js/api-supabase.js — the code the live site actually runs —
 * can be exercised end to end without a Supabase project. Every request is
 * translated to SQL and executed as the `authenticated` role with the
 * caller's id in `test.uid`, so row-level security decides what comes back,
 * exactly as it does in production.
 *
 * It implements the subset of PostgREST the adapter uses and nothing else.
 * An unsupported query throws rather than guessing, so a new query shape in
 * the adapter shows up as a loud failure here instead of a silent pass.
 */
"use strict";

const { Client } = require("../server/node_modules/pg");

const OPS = {
  eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=", neq: "<>"
};

function quote(v) {
  if (v === null) return "null";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

class Stub {
  constructor(conn) {
    this.client = new Client(conn);
    this.users = new Map();     // email -> { id, password }
    this.tokens = new Map();    // access_token -> user id
    this.meta = new Map();      // id -> { email }
    this.calls = [];            // every request, for assertions
  }

  async connect() { await this.client.connect(); }
  async end() { await this.client.end(); }

  /* One connection, one caller at a time. `set role` and `test.uid` are
     session state, so two overlapping requests would answer each other's
     questions as the wrong person — and the adapter fires plenty of them in
     parallel. */
  serial(job) {
    this.queue = (this.queue || Promise.resolve()).then(job, job);
    return this.queue;
  }

  /* Run SQL the way a request would: as `authenticated`, with RLS on. */
  asUser(uid, sql, params) {
    return this.serial(async () => {
      await this.client.query("set role authenticated");
      await this.client.query("select set_config('test.uid', $1, false)", [uid || ""]);
      try {
        return await this.client.query(sql, params);
      } finally {
        await this.client.query("reset role");
      }
    });
  }

  asOwnerRole(sql, params) {
    return this.serial(async () => {
      await this.client.query("reset role");
      return this.client.query(sql, params);
    });
  }

  /* ------------------------------------------------------------ columns */

  async columnsOf(table) {
    if (!this._cols) this._cols = new Map();
    if (this._cols.has(table)) return this._cols.get(table);
    const r = await this.asOwnerRole(
      "select column_name from information_schema.columns " +
      "where table_schema='public' and table_name=$1", [table]);
    const set = new Set(r.rows.map((x) => x.column_name));
    this._cols.set(table, set);
    return set;
  }

  async fkTo(parent, child) {
    const r = await this.asOwnerRole(`
      select (select attname from pg_attribute
               where attrelid = conrelid and attnum = conkey[1]) as col
        from pg_constraint
       where contype='f' and conrelid = ('public.'||$1)::regclass
         and confrelid = ('public.'||$2)::regclass`, [parent, child]);
    return r.rows.map((x) => x.col);
  }

  /* ------------------------------------------------------------- select */

  /* Turns a PostgREST select= list into SQL, resolving embedded resources
     into json subqueries the way PostgREST resolves them into joins. */
  async projection(table, select, alias, depth) {
    alias = alias || "t";
    depth = depth || 0;
    if (!select || select === "*") return `to_jsonb(${alias})`;

    const parts = splitTop(select);
    const pieces = [];

    for (const raw of parts) {
      const part = raw.trim();
      if (part === "*") { pieces.push(`to_jsonb(${alias})`); continue; }

      const embed = part.match(/^(?:([a-z_]+):)?([a-z_]+)(!inner)?\((.*)\)$/);
      if (!embed) {
        pieces.push(`jsonb_build_object(${quote(part)}, to_jsonb(${alias})->${quote(part)})`);
        continue;
      }

      const [, aliasName, name, , inner] = embed;
      const key = aliasName || name;
      const child = "e" + depth;

      /* `profiles:user_id(...)` names the foreign key column and aliases the
         result with the target table's name. Anything else is resolved from
         the foreign keys, in whichever direction they run. */
      let target = name;
      let localCol = null;
      const parentCols = await this.columnsOf(table);
      if (aliasName && parentCols.has(name)) { target = aliasName; localCol = name; }

      if (!localCol) {
        const cols = await this.fkTo(table, target);
        if (cols.length === 1) localCol = cols[0];
      }

      if (localCol) {
        const sub = inner.trim() === "count"
          ? `jsonb_build_array(jsonb_build_object('count', 1))`
          : `(select ${await this.projection(target, inner, child, depth + 1)}
                from public.${target} ${child} where ${child}.id = ${alias}.${localCol})`;
        pieces.push(`jsonb_build_object(${quote(key)}, ${sub})`);
        continue;
      }

      const back = await this.fkTo(target, table);
      if (!back.length) throw new Error(`no relationship ${table} -> ${target}`);
      const childCol = back[0];
      const sub = inner.trim() === "count"
        ? `(select jsonb_build_array(jsonb_build_object('count', count(*)))
              from public.${target} ${child} where ${child}.${childCol} = ${alias}.id)`
        : `(select coalesce(jsonb_agg(${await this.projection(target, inner, child, depth + 1)}), '[]'::jsonb)
              from public.${target} ${child} where ${child}.${childCol} = ${alias}.id)`;
      pieces.push(`jsonb_build_object(${quote(key)}, ${sub})`);
    }

    return pieces.join(" || ");
  }

  filters(table, params) {
    const where = [];
    for (const [key, value] of params) {
      if (["select", "order", "limit", "offset"].includes(key)) continue;
      if (key === "or") {
        const inner = value.replace(/^\(|\)$/g, "");
        where.push("(" + splitTop(inner).map((c) => this.one(c)).join(" or ") + ")");
        continue;
      }
      where.push(this.one(key + "." + value));
    }
    return where.length ? where.join(" and ") : "true";
  }

  one(clause) {
    const at = clause.indexOf(".");
    const col = clause.slice(0, at);
    const rest = clause.slice(at + 1);
    const dot = rest.indexOf(".");
    const op = dot === -1 ? rest : rest.slice(0, dot);
    const val = dot === -1 ? "" : rest.slice(dot + 1);

    if (op === "in") {
      const list = val.replace(/^\(|\)$/g, "");
      if (!list) return "false";
      return `t.${col}::text = any(array[${list.split(",").map((v) => quote(v)).join(",")}]::text[])`;
    }
    if (op === "ilike") return `t.${col}::text ilike ${quote(val)}`;
    if (op === "is") return `t.${col} is ${val === "null" ? "null" : val}`;
    if (!OPS[op]) throw new Error("unsupported operator: " + op);
    return `t.${col}::text ${OPS[op]} ${quote(val)}`;
  }

  /* --------------------------------------------------------------- rest */

  async rest(uid, method, table, params, body, prefer) {
    const cols = await this.columnsOf(table);
    if (!cols.size) return { status: 404, body: { message: "relation not found" } };

    const where = this.filters(table, params);

    if (method === "GET") {
      const proj = await this.projection(table, params.get("select"));
      let sql = `select ${proj} as row from public.${table} t where ${where}`;
      const order = params.get("order");
      if (order) {
        sql += " order by " + order.split(",").map((o) => {
          const [c, dir] = o.split(".");
          return `t.${c} ${dir === "desc" ? "desc" : "asc"}`;
        }).join(", ");
      }
      if (params.get("limit")) sql += " limit " + Number(params.get("limit"));
      const r = await this.asUser(uid, sql);
      return { status: 200, body: r.rows.map((x) => x.row) };
    }

    if (method === "POST") {
      const rows = Array.isArray(body) ? body : [body];
      const keys = Object.keys(rows[0] || {});
      const values = rows.map((row) =>
        "(" + keys.map((k) => literal(row[k])).join(",") + ")").join(",");
      const back = /return=representation/.test(prefer || "");
      const sql = `insert into public.${table} (${keys.join(",")}) values ${values}` +
                  (back ? " returning to_jsonb(public." + table + ".*) as row" : "");
      const r = await this.asUser(uid, sql);
      return { status: 201, body: back ? r.rows.map((x) => x.row) : null };
    }

    if (method === "PATCH") {
      const sets = Object.keys(body).map((k) => `${k} = ${literal(body[k])}`).join(", ");
      const back = /return=representation/.test(prefer || "");
      const sql = `update public.${table} t set ${sets} where ${where}` +
                  (back ? " returning to_jsonb(t) as row" : "");
      const r = await this.asUser(uid, sql);
      return { status: 200, body: back ? r.rows.map((x) => x.row) : null };
    }

    if (method === "DELETE") {
      await this.asUser(uid, `delete from public.${table} t where ${where}`);
      return { status: 204, body: null };
    }

    throw new Error("unsupported method " + method);
  }

  /* ---------------------------------------------------------------- rpc */

  async rpc(uid, fn, args) {
    const keys = Object.keys(args || {});
    const named = keys.map((k) => `${k} => ${rpcLiteral(args[k])}`).join(", ");
    const r = await this.asUser(uid, `select public.${fn}(${named}) as out`);
    const value = r.rows.length ? r.rows[0].out : null;
    return { status: 200, body: value === undefined ? null : value };
  }

  /* --------------------------------------------------------------- auth */

  async signup(email, password, meta) {
    if (this.users.has(email)) {
      return { status: 400, body: { message: "User already registered" } };
    }
    let id;
    try {
      const r = await this.asOwnerRole(
        "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
        [email, JSON.stringify(meta || {})]);
      id = r.rows[0].id;
    } catch (e) {
      return { status: 400, body: { message: e.message } };
    }
    this.users.set(email, { id, password });
    return { status: 200, body: this.token(id, email) };
  }

  async password(email, pass) {
    const row = this.users.get(email);
    if (!row || row.password !== pass) {
      return { status: 400, body: { error: "invalid_grant", message: "Invalid login credentials" } };
    }
    return { status: 200, body: this.token(row.id, email) };
  }

  token(id, email) {
    const access = "tok-" + id + "-" + Math.random().toString(16).slice(2);
    this.tokens.set(access, id);
    this.meta.set(id, { email });
    return {
      access_token: access,
      refresh_token: "ref-" + id,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id, email }
    };
  }

  /* --------------------------------------------------------------- fetch */

  fetch() {
    const stub = this;
    return async function (url, opts) {
      opts = opts || {};
      const u = new URL(url);
      const headers = opts.headers || {};
      const auth = String(headers.Authorization || "");
      const token = auth.replace(/^Bearer\s+/, "");
      const uid = stub.tokens.get(token) || null;
      const body = opts.body ? JSON.parse(opts.body) : undefined;
      stub.calls.push({ method: opts.method || "GET", path: u.pathname + u.search });

      let out;
      try {
        out = await stub.route(u, opts.method || "GET", uid, token, body, headers.Prefer);
      } catch (e) {
        out = { status: 400, body: { message: e.message } };
      }

      return {
        ok: out.status < 400,
        status: out.status,
        headers: { get: () => "application/json" },
        json: async () => out.body,
        text: async () => JSON.stringify(out.body)
      };
    };
  }

  async route(u, method, uid, token, body, prefer) {
    const path = u.pathname;

    if (path === "/auth/v1/signup") {
      return this.signup(body.email, body.password, body.data);
    }
    if (path === "/auth/v1/token") {
      if (u.searchParams.get("grant_type") === "password") {
        return this.password(body.email, body.password);
      }
      const id = String(body.refresh_token || "").replace(/^ref-/, "");
      if (!this.meta.has(id)) return { status: 401, body: { message: "bad refresh" } };
      return { status: 200, body: this.token(id, this.meta.get(id).email) };
    }
    if (path === "/auth/v1/logout") { this.tokens.delete(token); return { status: 204, body: null }; }
    if (path === "/auth/v1/user") {
      if (!uid) return { status: 401, body: { message: "not signed in" } };
      if (body && body.password) {
        const email = this.meta.get(uid).email;
        this.users.get(email).password = body.password;
      }
      return { status: 200, body: { id: uid } };
    }

    const rpcHit = path.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (rpcHit) return this.rpc(uid, rpcHit[1], body || {});

    const table = path.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (table) {
      return this.rest(uid, method, table[1], u.searchParams, body, prefer);
    }

    return { status: 404, body: { message: "no route " + path } };
  }
}

/* An RPC argument that is a JSON array is a SQL array to PostgREST, not
   jsonb — create_group takes text[] and mark_notifications_read bigint[]. */
function rpcLiteral(v) {
  if (Array.isArray(v)) {
    if (!v.length) return "null";
    const numeric = v.every((x) => typeof x === "number");
    return "array[" + v.map((x) => (numeric ? String(x) : quote(x))).join(",") + "]" +
           (numeric ? "::bigint[]" : "::text[]");
  }
  return literal(v);
}

function literal(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v) || typeof v === "object") return quote(JSON.stringify(v)) + "::jsonb";
  return quote(v);
}

/* Splits on commas that are not inside brackets, so an embed's column list
   survives intact. */
function splitTop(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.filter((x) => x.length);
}

/* The same routes over HTTP, so a real browser can talk to it. Used by
   tools/test-ui.js, which drives the site's own pages against it. */
Stub.prototype.serve = function (port) {
  const http = require("http");
  const stub = this;

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");

    const cors = {
      "Access-Control-Allow-Origin": req.headers.origin || "*",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers": "apikey, authorization, content-type, prefer, accept",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Content-Type": "application/json"
    };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }

    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/, "");
    const uid = stub.tokens.get(token) || null;
    let out;
    try {
      out = await stub.route(u, req.method, uid, token,
                             raw ? JSON.parse(raw) : undefined, req.headers.prefer);
    } catch (e) {
      out = { status: 400, body: { message: e.message } };
    }
    res.writeHead(out.status === 204 ? 200 : out.status, cors);
    res.end(JSON.stringify(out.body === null ? [] : out.body));
  });

  return new Promise((resolve) => server.listen(port, () => resolve(server)));
};

module.exports = { Stub };
