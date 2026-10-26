#!/usr/bin/env node
/**
 * Slide Display Site — single-file, zero-dependency Node server.
 *
 * Run:            node server.js
 * Configure:      PORT=3000 ADMIN_KEY=change-me USER_KEY=viewer-key \
 *                 MS_TENANT_ID=... MS_CLIENT_ID=... ADMIN_EMAILS=a@x.com \
 *                 node server.js
 *
 * Viewer:         http://localhost:3000/            (cycles the active set)
 * Admin:          http://localhost:3000/admin      (sets, uploads, stats)
 *
 * Sets:           slides belong to named sets; the admin picks which set is
 *                  active and every viewer follows it live (SSE push).
 *
 * Stats:          watch time per slide (aggregate) and per signed-in viewer
 *                  (total per set and per slide).
 *
 * Speed:          the viewer has a 0.5x–2x speed slider; 1x = DEFAULT_SECONDS
 *                  (default 20s). Higher speed = shorter time per slide.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "3000", 10);
const ADMIN_KEY = process.env.ADMIN_KEY || "admin123"; // set ADMIN_KEY in production!
const USER_KEY = process.env.USER_KEY || "user123";   // temp viewer key until SSO is set up
const MS_TENANT = process.env.MS_TENANT_ID || "";      // Entra tenant id
const MS_CLIENT = process.env.MS_CLIENT_ID || "";      // Entra app client id
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const DATA_DIR = path.join(__dirname, "slide-data");
const SLIDES_DIR = path.join(DATA_DIR, "slides");
const MANIFEST = path.join(DATA_DIR, "manifest.json");
const STATS = path.join(DATA_DIR, "stats.json");
const ERROR_LOG = path.join(DATA_DIR, "error.log");
const DEFAULT_SECONDS = parseFloat(process.env.DEFAULT_SECONDS || "20"); // 1x speed
const RESYNC_MS = 60000;     // periodic manifest re-check
const STATS_FLUSH_MS = 15000; // viewer batched stat reporting

/* ------------------------------------------------------------------ */
/* Crash safety net: never die from a request/socket/stream error.       */
/* ------------------------------------------------------------------ */

function logError(scope, err) {
  const line = new Date().toISOString() + " [" + scope + "] " +
    (err && err.stack ? err.stack : String(err)) + "\n";
  try { fs.appendFileSync(ERROR_LOG, line); } catch (_) {}
  console.error(line);
}
process.on("uncaughtException", (err) => logError("uncaughtException", err));
process.on("unhandledRejection", (err) => logError("unhandledRejection", err));

/* ------------------------------------------------------------------ */
/* Storage                                                              */
/* ------------------------------------------------------------------ */

function ensureDirs() {
  fs.mkdirSync(SLIDES_DIR, { recursive: true });
  if (!fs.existsSync(MANIFEST)) {
    fs.writeFileSync(MANIFEST, JSON.stringify({ sets: [], activeSetId: null }, null, 2));
  } else {
    // migrate the old flat manifest ({slides:[...]}) to named sets
    const m = readJSON(MANIFEST, null);
    if (m && Array.isArray(m.slides)) {
      const set = { id: crypto.randomBytes(8).toString("hex"), name: "Default Set", slides: m.slides };
      fs.writeFileSync(MANIFEST, JSON.stringify({ sets: [set], activeSetId: set.id }, null, 2));
    }
  }
  if (!fs.existsSync(STATS)) fs.writeFileSync(STATS, JSON.stringify({ perSlide: {}, perUser: {} }));
  else {
    // normalize stats written by older versions (entries may lack sets/slides)
    const s = readJSON(STATS, null);
    if (s && s.perUser) {
      let changed = false;
      for (const u of Object.values(s.perUser)) {
        if (!u.slides) { u.slides = {}; changed = true; }
        if (!u.sets) { u.sets = {}; changed = true; }
      }
      if (changed) fs.writeFileSync(STATS, JSON.stringify(s));
    }
  }
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function readManifest() {
  const m = readJSON(MANIFEST, null);
  if (m && Array.isArray(m.sets)) return m;
  return { sets: [], activeSetId: null };
}

function writeManifest(m) {
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
  broadcastUpdate();
}

function broadcastUpdate() {
  const m = readManifest();
  const active = m.sets.find((s) => s.id === m.activeSetId) || m.sets[0] || null;
  broadcast({
    type: "update",
    set: active ? publicSet(active) : null,
  });
}

function readStats() {
  const s = readJSON(STATS, null);
  return s && s.perSlide ? s : { perSlide: {}, perUser: {} };
}

function writeStats(s) {
  fs.writeFileSync(STATS, JSON.stringify(s, null, 2));
}

function publicSlide(s) {
  return { id: s.id, name: s.name, src: "/slides/" + s.file, kind: s.kind };
}

function publicSet(set) {
  return { id: set.id, name: set.name, slides: set.slides.map(publicSlide) };
}

function findSlide(m, id) {
  for (const set of m.sets) {
    const i = set.slides.findIndex((s) => s.id === id);
    if (i !== -1) return { set, index: i };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* SSE: live update push                                                */
/* ------------------------------------------------------------------ */

const sseClients = new Set();

function broadcast(obj) {
  const data = "data: " + JSON.stringify(obj) + "\n\n";
  for (const res of [...sseClients]) {
    try { res.write(data); } catch (_) { sseClients.delete(res); }
  }
}

/* ------------------------------------------------------------------ */
/* Sessions                                                             */
/* ------------------------------------------------------------------ */

const sessions = new Map(); // token -> { user: string|null, admin: boolean }

function isAuthed(req, wantAdmin) {
  const m = /slide_session=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  return wantAdmin ? (s.admin ? s : null) : s;
}

function setSession(res, s) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, s);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Set-Cookie": "slide_session=" + token + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800",
  });
  res.end(JSON.stringify({ ok: true, admin: s.admin, user: s.user }));
}

/* ------------------------------------------------------------------ */
/* Microsoft SSO (OAuth2 + PKCE)                                         */
/* ------------------------------------------------------------------ */

const pendingOAuth = new Map(); // state -> { verifier, admin: bool }

function msBaseUrl() {
  return "https://login.microsoftonline.com/" + MS_TENANT;
}

function decodeJwtPayload(jwt) {
  try {
    const p = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  } catch (_) { return null; }
}

async function msLogin(req, res, wantAdmin) {
  if (!MS_CLIENT || !MS_TENANT) {
    return sendJSON(res, 400, { error: "Microsoft SSO not configured (set MS_TENANT_ID and MS_CLIENT_ID)" });
  }
  const state = crypto.randomBytes(12).toString("hex");
  const verifier = crypto.randomBytes(40).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  pendingOAuth.set(state, { verifier, admin: wantAdmin });
  const redirect = "http://" + req.headers.host + "/api/ms/callback";
  const url = msBaseUrl() + "/oauth2/v2.0/authorize?" + new URLSearchParams({
    client_id: MS_CLIENT,
    response_type: "code",
    redirect_uri: redirect,
    scope: "openid profile email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  res.writeHead(302, { Location: url });
  res.end();
}

async function msCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const pending = state && pendingOAuth.get(state);
  if (!code || !pending) {
    res.writeHead(302, { Location: "/sso-error?reason=invalid_state" });
    return res.end();
  }
  pendingOAuth.delete(state);
  try {
    const tokenRes = await fetch(msBaseUrl() + "/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: MS_CLIENT,
        grant_type: "authorization_code",
        code,
        code_verifier: pending.verifier,
        redirect_uri: "http://" + req.headers.host + "/api/ms/callback",
      }),
    });
    const tok = await tokenRes.json();
    const claims = tok.id_token ? decodeJwtPayload(tok.id_token) : null;
    const email = claims && (claims.email || claims.preferred_username || "").toLowerCase();
    if (!email) throw new Error("no email claim");
    const isAdmin = ADMIN_EMAILS.length === 0 ? true : ADMIN_EMAILS.includes(email);
    if (pending.admin && !isAdmin) {
      res.writeHead(302, { Location: "/sso-error?reason=not_admin" });
      return res.end();
    }
    setSession(res, { user: email, admin: pending.admin && isAdmin });
    res.writeHead(302, { Location: pending.admin ? "/admin" : "/" });
    res.end();
  } catch (e) {
    logError("msCallback", e);
    res.writeHead(302, { Location: "/sso-error?reason=exchange_failed" });
    res.end();
  }
}

/* ------------------------------------------------------------------ */
/* Multipart upload parsing (no dependencies)                            */
/* ------------------------------------------------------------------ */

function parseMultipart(buffer, boundary) {
  const files = [];
  const fields = {};
  const dash = Buffer.from("--" + boundary);
  let pos = buffer.indexOf(dash);
  while (pos !== -1) {
    const headEnd = buffer.indexOf("\r\n\r\n", pos);
    const next = buffer.indexOf(dash, headEnd);
    if (headEnd === -1 || next === -1) break;
    const head = buffer.slice(pos, headEnd).toString("utf8");
    const body = buffer.slice(headEnd + 4, next - 2); // strip trailing \r\n
    const nameM = /name="([^"]*)"/.exec(head);
    const fileM = /filename="([^"]*)"/.exec(head);
    const typeM = /Content-Type:\s*([^\r\n]+)/i.exec(head);
    if (fileM && fileM[1]) {
      files.push({
        field: nameM ? nameM[1] : "",
        filename: path.basename(fileM[1]),
        contentType: typeM ? typeM[1].trim() : "application/octet-stream",
        data: body,
      });
    } else if (nameM && nameM[1]) {
      fields[nameM[1]] = body.toString("utf8");
    }
    pos = next;
  }
  return { files, fields };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
}

function kindOf(name, type) {
  if (/^image\//.test(type)) return "image";
  if (/\.pdf$/i.test(name) || type === "application/pdf") return "pdf";
  return "other";
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  try {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  } catch (_) { return; }
  res.end(body);
}

/* ------------------------------------------------------------------ */
/* API routes                                                           */
/* ------------------------------------------------------------------ */

function handleApi(req, res, rawBody) {
  const body = rawBody && rawBody.length ? rawBody.toString("utf8") : "";
  let json = {};
  try { json = body ? JSON.parse(body) : {}; } catch (_) {}

  const p = req.url.split("?")[0];

  if (p === "/api/slides" && req.method === "GET") {
    const m = readManifest();
    const active = m.sets.find((s) => s.id === m.activeSetId) || m.sets[0] || null;
    return sendJSON(res, 200, {
      set: active ? publicSet(active) : null,
      sets: m.sets.map((s) => ({ id: s.id, name: s.name })),
      activeSetId: active ? active.id : null,
      defaultSeconds: DEFAULT_SECONDS,
      user: (isAuthed(req, false) || { user: null }).user || null,
      msSso: !!MS_CLIENT,
      userKey: !!USER_KEY,
    });
  }

  if (p === "/api/sets" && req.method === "GET") {
    if (!isAuthed(req, true)) return sendJSON(res, 401, { error: "unauthorized" });
    const m = readManifest();
    return sendJSON(res, 200, {
      sets: m.sets.map(publicSet),
      activeSetId: m.activeSetId || (m.sets[0] ? m.sets[0].id : null),
    });
  }

  if (p === "/api/sets/create" && req.method === "POST") {
    if (!isAuthed(req, true)) return sendJSON(res, 401, { error: "unauthorized" });
    const m = readManifest();
    const name = String(json.name || "").trim().slice(0, 80) || "Untitled Set";
    const set = { id: crypto.randomBytes(8).toString("hex"), name, slides: [] };
    m.sets.push(set);
    if (!m.activeSetId) m.activeSetId = set.id;
    writeManifest(m);
    return sendJSON(res, 200, { id: set.id });
  }

  if (p === "/api/sets/rename" && req.method === "POST") {
    if (!isAuthed(req, true)) return sendJSON(res, 401, { error: "unauthorized" });
    const m = readManifest();
    const set = m.sets.find((s) => s.id === json.id);
    if (set) {
      set.name = String(json.name || "").trim().slice(0, 80) || set.name;
      writeManifest(m);
    }
    return sendJSON(res, 200, { ok: true });
  }

  if (p === "/api/sets/activate" && req.method === "POST") {
    if (!isAuthed(req, true)) return sendJSON(res, 401, { error: "unauthorized" });
    const m = readManifest();
    if (m.sets.some((s) => s.id === json.id)) {
      m.activeSetId = json.id;
      writeManifest(m);
    }
    return sendJSON(res, 200, { ok: true });
  }

  if (p === "/api/sets/delete" && req.method === "POST") {
    if (!isAuthed(req, true)) return sendJSON(res, 401, { error: "unauthorized" });
    const m = readManifest();
    const i = m.sets.findIndex((s) => s.id === json.id);
    if (i !== -1) {
      for (const s of m.sets[i].slides) {
        try { fs.unlinkSync(path.join(SLIDES_DIR, s.file)); } catch (_) {}
      }
      m.sets.splice(i, 1);
      if (m.activeSetId === json.id) m.activeSetId = m.sets[0] ? m.sets[0].id : null;
      writeManifest(m);
    }
    return sendJSON(res, 200, { ok: true });
  }

  if (p === "/api/stats" && req.method === "GET") {
    if (!isAuthed(req, true)) return sendJSON(res, 401, { error: "unauthorized" });
    const stats = readStats();
    const m = readManifest();
    const qSetId = new URL(req.url, "http://x").searchParams.get("setId");
    const setId = qSetId || m.activeSetId;
    const set = m.sets.find((s) => s.id === setId) || m.sets[0] || null;
    if (!set) return sendJSON(res, 200, { set: null, users: [] });

    const slides = set.slides.map((s) => {
      const st = stats.perSlide[s.id] || { ms: 0, views: 0 };
      return { id: s.id, name: s.name, views: st.views, watchMs: st.ms,
        avgMs: st.views ? st.ms / st.views : 0 };
    });
    const setTotal = slides.reduce((a, s) => a + s.watchMs, 0);

    const users = Object.entries(stats.perUser)
      .map(([u, st]) => ({
        user: u,
        totalMs: st.ms,
        setMs: (st.sets && st.sets[set.id]) || 0,
        slides: {},
      }))
      .filter((u) => u.totalMs > 0)
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 25);
    for (const u of users) {
      for (const s of set.slides) {
        const ms = stats.perUser[u.user] &&
          stats.perUser[u.user].slides &&
          stats.perUser[u.user].slides[s.id];
        if (ms) u.slides[s.id] = ms;
      }
    }
    return sendJSON(res, 200, { set: { id: set.id, name: set.name, totalMs: setTotal }, slides, users });
  }

  if (p === "/api/stats" && req.method === "POST") {
    // { events: [{ id, ms, views }] } — watch-time report from viewers.
    const who = (isAuthed(req, false) || { user: null }).user || "anonymous";
    const stats = readStats();
    const m = readManifest();
    for (const ev of (json.events || [])) {
      if (typeof ev.id !== "string") continue;
      const ms = Math.max(0, Math.min(600000, +ev.ms || 0)); // clamp 10 min/report
      const views = Math.max(0, Math.min(100, +ev.views || 0));
      if (!ms && !views) continue;
      const st = stats.perSlide[ev.id] || (stats.perSlide[ev.id] = { ms: 0, views: 0 });
      st.ms += ms; st.views += views;
      if (who !== "anonymous") {
        const found = findSlide(m, ev.id);
        const u = stats.perUser[who] || (stats.perUser[who] = { ms: 0, slides: {}, sets: {} });
        if (!u.slides) u.slides = {};
        if (!u.sets) u.sets = {};
        u.ms += ms;
        u.slides[ev.id] = (u.slides[ev.id] || 0) + ms;
        if (found) u.sets[found.set.id] = (u.sets[found.set.id] || 0) + ms;
      }
    }
    writeStats(stats);
    return sendJSON(res, 200, { ok: true });
  }

  if (p === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    res.write("data: " + JSON.stringify({ type: "hello" }) + "\n\n");
    sseClients.add(res);
    const ping = setInterval(() => {
      try { res.write(": ping\n\n"); } catch (_) {}
    }, 15000);
    // NOTE: res "close" (not req) — req's "close" fires as soon as the request
    // body completes, which would drop every client immediately.
    res.on("close", () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  if (p === "/api/login" && req.method === "POST") {
    if ((json.key || "") === ADMIN_KEY) return setSession(res, { user: "key-admin", admin: true });
    return sendJSON(res, 401, { ok: false });
  }

  // Temporary viewer login (name + shared key) until Microsoft SSO is set up.
  if (p === "/api/viewer-login" && req.method === "POST") {
    const name = String(json.name || "").trim().slice(0, 60) || "guest";
    if ((json.key || "") !== USER_KEY) return sendJSON(res, 401, { ok: false });
    return setSession(res, { user: name, admin: false });
  }

  if (p === "/api/logout" && req.method === "POST") {
    const m = /slide_session=([^;]+)/.exec(req.headers.cookie || "");
    if (m) sessions.delete(m[1]);
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "slide_session=; Path=/" });
    return res.end("{}");
  }

  if (p === "/api/ms/login" && req.method === "GET") {
    const wantAdmin = (req.url.split("?")[1] || "") === "admin=1";
    return msLogin(req, res, wantAdmin);
  }
  if (p === "/api/ms/callback" && req.method === "GET") {
    return msCallback(req, res, new URL(req.url, "http://x"));
  }

  if (p === "/api/upload" && req.method === "POST") {
    if (!isAuthed(req, true)) return sendJSON(res, 401, { error: "unauthorized" });
    const m = /boundary=(.+)$/.exec(req.headers["content-type"] || "");
    if (!m) return sendJSON(res, 400, { error: "bad request" });
    const { files, fields } = parseMultipart(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody), m[1]);
    const manifest = readManifest();
    let set = manifest.sets.find((s) => s.id === fields.setId) ||
      manifest.sets.find((s) => s.id === manifest.activeSetId) || manifest.sets[0];
    if (!set) return sendJSON(res, 400, { error: "no set selected — create a set first" });
    let added = 0;
    for (const f of files) {
      const kind = kindOf(f.filename, f.contentType);
      if (kind === "other") continue;
      const id = crypto.randomBytes(8).toString("hex");
      const file = id + "-" + safeName(f.filename);
      fs.writeFileSync(path.join(SLIDES_DIR, file), f.data);
      set.slides.push({ id, name: f.filename, file, kind });
      added++;
    }
    if (added) writeManifest(manifest);
    return sendJSON(res, 200, { added, setId: set.id });
  }

  if (p === "/api/delete" && req.method === "POST") {
    if (!isAuthed(req, true)) return sendJSON(res, 401, { error: "unauthorized" });
    const manifest = readManifest();
    const found = findSlide(manifest, json.id);
    if (found) {
      try { fs.unlinkSync(path.join(SLIDES_DIR, found.set.slides[found.index].file)); } catch (_) {}
      found.set.slides.splice(found.index, 1);
      writeManifest(manifest);
    }
    return sendJSON(res, 200, { ok: true });
  }

  if (p === "/api/reorder" && req.method === "POST") {
    if (!isAuthed(req, true)) return sendJSON(res, 401, { error: "unauthorized" });
    const manifest = readManifest();
    const set = manifest.sets.find((s) => s.id === json.setId) ||
      manifest.sets.find((s) => s.id === manifest.activeSetId) || manifest.sets[0];
    if (!set) return sendJSON(res, 400, { error: "no set" });
    const byId = new Map(set.slides.map((s) => [s.id, s]));
    const next = (json.ids || []).map((id) => byId.get(id)).filter(Boolean);
    for (const s of set.slides) if (!next.includes(s)) next.push(s);
    set.slides = next;
    writeManifest(manifest);
    return sendJSON(res, 200, { slides: set.slides.map(publicSlide) });
  }

  sendJSON(res, 404, { error: "not found" });
}

/* ------------------------------------------------------------------ */
/* Frontends                                                            */
/* ------------------------------------------------------------------ */

const VIEWER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Slides</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden;font-family:system-ui,sans-serif}
  #stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
  #stage img{width:100%;height:100%;object-fit:contain}
  #stage iframe{width:100%;height:100%;border:0}
  #gate{position:fixed;inset:0;background:#111;display:none;align-items:center;justify-content:center;z-index:10}
  #gate .card{background:#1c1c1e;padding:32px 40px;border-radius:16px;display:flex;flex-direction:column;
    gap:12px;align-items:center;color:#eee;box-shadow:0 10px 40px rgba(0,0,0,.6)}
  #gate input{padding:10px 12px;border-radius:8px;border:1px solid #444;background:#2a2a2c;color:#eee;font-size:14px;width:100%}
  #gate button{background:#0a84ff;color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer;font-size:14px;width:100%}
  #gate .msbtn{background:#2f2f2f}
  #setname{position:fixed;top:10px;left:10px;color:#888;font-size:14px;opacity:.7}
  #hint{position:fixed;bottom:10px;left:10px;color:#888;font-size:12px;opacity:.7}
  #controls{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);display:flex;gap:12px;
    background:rgba(20,20,20,.85);padding:10px 14px;border-radius:999px;opacity:0;transition:opacity .25s;
    box-shadow:0 4px 20px rgba(0,0,0,.5);align-items:center}
  body:hover #controls,#controls.show{opacity:1}
  #controls button{background:#333;color:#fff;border:0;border-radius:999px;padding:8px 14px;
    cursor:pointer;font-size:14px}
  #controls button:hover{background:#555}
  #bar{position:fixed;top:0;left:0;height:3px;background:#0a84ff;width:0%;transition:width .3s linear}
  #who{position:fixed;top:10px;right:10px;color:#ccc;font-size:13px;opacity:.85;text-align:right;
    display:flex;flex-direction:column;gap:6px;align-items:flex-end}
  #who button{background:#2f2f2f;color:#fff;border:0;border-radius:999px;padding:8px 14px;cursor:pointer;font-size:13px}
  #who form{display:flex;gap:6px}
  #who input{padding:6px 8px;border-radius:8px;border:0;font-size:12px}
  #who form button{background:#0a84ff;border-radius:8px;padding:6px 10px}
  #speedwrap{display:flex;align-items:center;gap:8px;color:#bbb;font-size:13px}
  #speedwrap input[type=range]{width:110px;accent-color:#0a84ff}
  #speedwrap label{min-width:86px;text-align:center}
</style></head><body>
<div id="stage"></div>
<div id="gate">
  <div class="card">
    <div style="font-size:20px;font-weight:600">Slides</div>
    <div style="font-size:13px;color:#999">Please sign in to watch</div>
    <div id="gateAuth" style="display:flex;flex-direction:column;gap:10px;width:250px"></div>
  </div>
</div>
<div id="bar"></div>
<div id="setname"></div>
<div id="who"></div>
<div id="controls">
  <button id="prev" title="Back">&#9664;</button>
  <button id="pause" title="Pause">&#10073;&#10073;</button>
  <button id="next" title="Forward">&#9654;</button>
  <span id="speedwrap">
    <span title="Speed">&#9193;</span>
    <input type="range" id="speed" min="0.5" max="4" step="0.1" value="1"
      title="Speed: higher = faster">
    <label id="speedLbl" for="speed">1.0&times;</label>
  </span>
  <span id="count" style="color:#bbb;font-size:12px"></span>
</div>
<div id="hint">Admin: /admin &middot; hover for controls</div>
<script>
(async () => {
  let slides = [], idx = 0, seconds = 20, speed = 1, paused = false, timer = null;
  const stage = document.getElementById("stage");
  const bar = document.getElementById("bar");
  const count = document.getElementById("count");
  const who = document.getElementById("who");
  const speedEl = document.getElementById("speed");
  const speedLbl = document.getElementById("speedLbl");

  /* ---- watch-time tracking ---- */
  let current = null, currentSince = 0;
  const pending = new Map(); // slideId -> { ms, views }
  const accumulating = () => !paused && !document.hidden && current;

  function accrue() {
    if (!accumulating()) { currentSince = Date.now(); return; }
    const ms = Date.now() - currentSince;
    currentSince = Date.now();
    const p = pending.get(current) || { ms: 0, views: 0 };
    p.ms += ms; pending.set(current, p);
  }
  function startTiming(id) {
    accrue();
    const p = pending.get(id) || { ms: 0, views: 0 };
    p.views += 1; pending.set(id, p);
    current = id; currentSince = Date.now();
  }
  function flush(useBeacon) {
    accrue();
    if (!pending.size) return;
    const events = [...pending.entries()].map(([id, v]) => ({ id, ms: Math.round(v.ms), views: v.views }));
    pending.clear();
    const body = JSON.stringify({ events });
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon("/api/stats", new Blob([body], { type: "application/json" }));
    } else {
      fetch("/api/stats", { method: "POST", headers: { "Content-Type": "application/json" },
        body, keepalive: true }).catch(() => {});
    }
  }
  setInterval(() => flush(false), ${STATS_FLUSH_MS});
  document.addEventListener("visibilitychange", () => { accrue(); if (document.hidden) flush(true); });
  window.addEventListener("pagehide", () => flush(true));

  /* ---- viewer sign-in (required before slides are shown) ---- */
  const gate = document.getElementById("gate");
  const gateAuth = document.getElementById("gateAuth");
  let signedIn = false;

  function renderAuth(d) {
    who.innerHTML = "";
    if (d.user) {
      signedIn = true;
      gate.style.display = "none";
      const label = document.createElement("span");
      label.textContent = "Signed in: " + d.user;
      const out = document.createElement("button");
      out.textContent = "Sign out";
      out.style.marginLeft = "6px";
      out.onclick = async () => {
        await fetch("/api/logout", { method: "POST" });
        location.reload();
      };
      const row = document.createElement("span");
      row.append(label, out);
      who.appendChild(row);
      return;
    }
    signedIn = false;
    gate.style.display = "flex";
    gateAuth.innerHTML = "";
    if (d.msSso) {
      const b = document.createElement("button");
      b.className = "msbtn";
      b.textContent = "Sign in with Microsoft";
      b.onclick = () => location.href = "/api/ms/login";
      gateAuth.appendChild(b);
    }
    if (d.userKey) {
      const form = document.createElement("form");
      form.style.display = "flex";
      form.style.flexDirection = "column";
      form.style.gap = "10px";
      form.innerHTML =
        "<input placeholder='Your name' required>" +
        "<input placeholder='Key' type='password' required>" +
        "<button type='submit'>Go</button>";
      form.onsubmit = async (e) => {
        e.preventDefault();
        const [name, key] = form.querySelectorAll("input");
        const r = await fetch("/api/viewer-login", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.value, key: key.value }) });
        if (r.ok) location.reload();
        else { key.value = ""; key.placeholder = "Wrong key"; }
      };
      gateAuth.appendChild(form);
    }
  }

  /* ---- slides ---- */
  async function load() {
    try {
      const r = await fetch("/api/slides", { cache: "no-store" });
      const d = await r.json();
      seconds = d.defaultSeconds || 20;
      const oldLen = slides.length;
      renderAuth(d);
      if (!signedIn) return; // login required before any slides are shown
      slides = d.set ? d.set.slides : [];
      document.getElementById("setname").textContent = d.set ? d.set.name : "";
      updateSpeedLabel();
      if (oldLen === 0 && slides.length) render();
      count.textContent = slides.length ? (idx + 1) + " / " + slides.length : "";
    } catch (e) { /* offline; retry on next tick */ }
  }

  function render() {
    if (!slides.length) { stage.innerHTML = "<div style='color:#666;font-size:18px'>No slides in this set</div>"; return; }
    if (idx >= slides.length) idx = 0;
    const s = slides[idx];
    stage.innerHTML = s.kind === "pdf"
      ? '<iframe src="' + s.src + '"></iframe>'
      : '<img src="' + s.src + "?v=" + encodeURIComponent(s.id) + '">';
    count.textContent = (idx + 1) + " / " + slides.length;
    startTiming(s.id);
    restart();
  }

  function next() { idx = slides.length ? (idx + 1) % slides.length : 0; render(); }
  function prev() { idx = slides.length ? (idx - 1 + slides.length) % slides.length : 0; render(); }

  function restart() {
    clearTimeout(timer);
    bar.style.transition = "none";
    bar.style.width = "0%";
    if (paused || !slides.length) return;
    const per = seconds / speed; // higher speed = shorter time per slide
    requestAnimationFrame(() => {
      bar.style.transition = "width " + per + "s linear";
      bar.style.width = "100%";
    });
    timer = setTimeout(next, per * 1000);
  }

  function updateSpeedLabel() {
    const per = seconds / speed;
    speedLbl.textContent = speed.toFixed(1) + "× · " +
      (per < 10 ? per.toFixed(1) : Math.round(per)) + "s";
  }
  speedEl.oninput = () => { speed = parseFloat(speedEl.value); updateSpeedLabel(); restart(); };

  document.getElementById("next").onclick = next;
  document.getElementById("prev").onclick = prev;
  document.getElementById("pause").onclick = (e) => {
    paused = !paused;
    e.target.innerHTML = paused ? "&#9654;" : "&#10073;&#10073;";
    if (paused) { accrue(); bar.style.transition = "none"; }
    else restart();
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") next();
    if (e.key === "ArrowLeft") prev();
    if (e.key === " ") { e.preventDefault(); document.getElementById("pause").click(); }
    if (e.key === "f") document.documentElement.requestFullscreen?.();
  });

  // Live updates via SSE
  const es = new EventSource("/api/events");
  es.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === "update" && d.set) {
      if (!signedIn) return;
      const currentId = slides[idx] && slides[idx].id;
      slides = d.set.slides;
      document.getElementById("setname").textContent = d.set.name;
      const at = slides.findIndex(s => s.id === currentId);
      idx = at !== -1 ? at : 0;
      render();
    }
  };

  await load();
  if (signedIn) render();

  // Periodic re-check fallback (long-open displays, dropped SSE, etc.)
  setInterval(async () => {
    if (!signedIn) return;
    const before = JSON.stringify(slides);
    await load();
    if (JSON.stringify(slides) !== before) render();
  }, ${RESYNC_MS});
})();
</script></body></html>`;

const ADMIN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Slide Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;max-width:960px;margin:40px auto;padding:0 16px;color:#222}
  h1{font-size:22px} h2{font-size:16px;margin-top:28px}
  input,button,select{font-size:14px;padding:8px 12px;border-radius:8px;border:1px solid #ccc}
  button{cursor:pointer;background:#0a84ff;color:#fff;border:0}
  button:disabled{background:#999}
  #login{display:flex;gap:8px;margin-top:12px}
  ul{list-style:none;padding:0}
  li{display:flex;align-items:center;gap:12px;padding:10px;border:1px solid #eee;border-radius:10px;margin:6px 0;background:#fafafa}
  li img{width:96px;height:60px;object-fit:cover;border-radius:6px;background:#eee}
  li .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
  .mv{background:#888}.del{background:#c33}
  #msg{margin:8px 0;color:#080}.err{color:#c33}
  #panel{display:none}
  #drop{border:2px dashed #bbb;border-radius:12px;padding:32px;text-align:center;color:#777;margin:16px 0}
  #drop.over{border-color:#0a84ff;color:#0a84ff}
  #setbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}
  #setbar select{flex:1;min-width:160px}
  .setbtn{background:#666}
  #active{background:#0a84ff;color:#fff;font-size:12px;border-radius:999px;padding:4px 10px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{padding:8px 10px;border-bottom:1px solid #eee;text-align:left}
  th{background:#f5f5f7}.num{text-align:right}
  .total td{font-weight:600;background:#f5f5f7}
  #msbtn{background:#2f2f2f}
</style></head><body>
<h1>Slide Admin</h1>
<div id="login">
  <button id="msbtn" onclick="location.href='/api/ms/login?admin=1'">Sign in with Microsoft</button>
  <input type="password" id="key" placeholder="...or admin key" style="flex:1">
  <button onclick="login()">Sign in</button>
</div>
<div id="panel">
  <p id="msg"></p>

  <h2 style="margin-top:8px">Slide sets</h2>
  <div id="setbar">
    <select id="setsel"></select>
    <button class="setbtn" onclick="newSet()">New set</button>
    <button class="setbtn" onclick="renameSet()">Rename</button>
    <button class="setbtn" onclick="activateSet()" id="actbtn" disabled>Make active</button>
    <button class="del" onclick="deleteSet()">Delete set</button>
    <span id="active"></span>
  </div>

  <div id="drop">Drop images or PDFs here, or
    <label style="color:#0a84ff;cursor:pointer;text-decoration:underline">
      browse<input id="file" type="file" multiple accept="image/*,.pdf" hidden></label>
    &nbsp;<span style="font-size:12px">(uploads go into the selected set)</span>
  </div>
  <button id="up" onclick="upload()" disabled style="width:100%;padding:12px">Upload</button>

  <h2>Slides <span style="color:#999;font-weight:400">(drag to reorder)</span></h2>
  <ul id="list"></ul>

  <h2>Aggregate stats <span id="setName2" style="color:#999;font-weight:400"></span></h2>
  <table id="stats"><thead><tr>
    <th>#</th><th>Slide</th><th class="num">Views</th>
    <th class="num">Total watch time</th><th class="num">Avg / view</th>
  </tr></thead><tbody></tbody><tfoot></tfoot></table>

  <h2>Viewer stats <span id="setName3" style="color:#999;font-weight:400"></span></h2>
  <table id="users"><thead><tr>
    <th>User</th><th class="num">All-time total</th><th class="num">In this set</th><th>Slides in this set</th>
  </tr></thead><tbody></tbody></table>

  <button onclick="logout()" style="background:#666;margin-top:24px">Sign out</button>
</div>
<script>
let sets = [], activeId = null, selId = null, picked = null, dragFrom = null;
const msg = document.getElementById("msg");
const drop = document.getElementById("drop");
const file = document.getElementById("file");
const setsel = document.getElementById("setsel");

async function login() {
  const r = await fetch("/api/login", { method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ key: document.getElementById("key").value }) });
  if (r.ok) show(); else { msg.textContent = "Wrong key"; msg.className = "err"; }
}
async function logout() { await fetch("/api/logout", { method: "POST" }); location.reload(); }

async function show() {
  document.getElementById("login").style.display = "none";
  document.getElementById("panel").style.display = "block";
  refresh();
}

function fmt(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

function currentSet() { return sets.find(s => s.id === selId) || null; }

async function refresh() {
  const [sd, st] = await Promise.all([
    (await fetch("/api/sets", { cache: "no-store" })).json(),
    (await fetch("/api/stats" + (selId ? "?setId=" + encodeURIComponent(selId) : ""),
      { cache: "no-store" })).json(),
  ]);
  sets = sd.sets; activeId = sd.activeSetId;
  if (!selId || !sets.some(s => s.id === selId)) selId = activeId;
  renderSetBar();
  renderSlides();
  renderStats(st);
}

function renderSetBar() {
  setsel.innerHTML = "";
  sets.forEach(s => {
    const o = document.createElement("option");
    o.value = s.id; o.textContent = s.name + (s.id === activeId ? "  ● active" : "");
    setsel.appendChild(o);
  });
  setsel.value = selId || "";
  const act = document.getElementById("active");
  act.textContent = sets.find(s => s.id === activeId)
    ? "Viewers are watching: " + sets.find(s => s.id === activeId).name : "No active set";
  document.getElementById("actbtn").disabled = selId === activeId;
}

setsel.onchange = () => { selId = setsel.value; refresh(); };

async function newSet() {
  const name = prompt("Name for the new set:");
  if (!name) return;
  const r = await (await fetch("/api/sets/create", { method: "POST",
    headers: {"Content-Type":"application/json"}, body: JSON.stringify({ name }) })).json();
  if (r.id) { selId = r.id; refresh(); }
}
async function renameSet() {
  const set = currentSet(); if (!set) return;
  const name = prompt("New name:", set.name); if (!name) return;
  await fetch("/api/sets/rename", { method: "POST",
    headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id: set.id, name }) });
  refresh();
}
async function activateSet() {
  const set = currentSet(); if (!set) return;
  await fetch("/api/sets/activate", { method: "POST",
    headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id: set.id }) });
  refresh();
}
async function deleteSet() {
  const set = currentSet(); if (!set) return;
  if (!confirm("Delete set '" + set.name + "' and its " + set.slides.length +
    " slides? Watch-time history is kept.")) return;
  await fetch("/api/sets/delete", { method: "POST",
    headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id: set.id }) });
  selId = null; refresh();
}

function thumb(s) {
  return s.kind === "pdf"
    ? "<img src='data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='96' height='60'><rect width='96' height='60' fill='#e8e8ee'/><text x='30' y='35' font-size='13' fill='#888'>PDF</text></svg>") + "'>"
    : "<img src='" + s.src + "'>";
}

function renderSlides() {
  const set = currentSet();
  const ul = document.getElementById("list");
  ul.innerHTML = "";
  if (!set) { msg.textContent = "No set selected — create one above."; return; }
  set.slides.forEach((s, i) => {
    const li = document.createElement("li");
    li.draggable = true;
    li.innerHTML = "<span class='ord' style='color:#999;font-size:12px;width:22px;text-align:right'>" + (i + 1) + "</span>" +
      thumb(s) + "<span class='nm'>" + s.name + "</span>";
    const up = document.createElement("button");
    up.className = "mv"; up.textContent = "↑"; up.onclick = () => move(i, -1);
    const dn = document.createElement("button");
    dn.className = "mv"; dn.textContent = "↓"; dn.onclick = () => move(i, 1);
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "Delete"; del.onclick = () => remove(s.id);
    li.append(up, dn, del);
    li.ondragstart = () => { dragFrom = i; };
    li.ondragover = (e) => e.preventDefault();
    li.ondrop = (e) => { e.preventDefault(); if (dragFrom !== null) move(dragFrom, i - dragFrom); dragFrom = null; };
    ul.appendChild(li);
  });
}

async function move(i, delta) {
  const set = currentSet(); if (!set) return;
  const j = i + delta;
  if (j < 0 || j >= set.slides.length) return;
  const ids = set.slides.map(s => s.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await fetch("/api/reorder", { method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ setId: set.id, ids }) });
  refresh();
}

async function remove(id) {
  if (!confirm("Delete this slide? Watch-time history is kept.")) return;
  await fetch("/api/delete", { method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ id }) });
  refresh();
}

function pick(f) {
  if (!f || !f.length) return;
  picked = f;
  drop.innerHTML = picked.length + " file(s) selected";
  document.getElementById("up").disabled = false;
}
file.onchange = () => pick(file.files);
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); pick(e.dataTransfer.files); };

async function upload() {
  const set = currentSet();
  if (!set) { msg.textContent = "Create a set first."; msg.className = "err"; return; }
  const fd = new FormData();
  fd.append("setId", set.id);
  for (const f of picked) fd.append("files", f);
  msg.textContent = "Uploading..."; msg.className = "";
  const r = await fetch("/api/upload", { method: "POST", body: fd });
  const d = await r.json();
  if (r.ok) { msg.textContent = "Added " + d.added + " slide(s) to '" + set.name + "'. Viewers update live."; }
  else { msg.textContent = "Upload failed: " + (d.error || r.status); msg.className = "err"; }
  document.getElementById("up").disabled = true; picked = null; file.value = "";
  drop.innerHTML = "Drop images or PDFs here";
  refresh();
}

function renderStats(st) {
  const label = st && st.set ? st.set.name : "";
  document.getElementById("setName2").textContent = label ? "(" + label + ")" : "";
  document.getElementById("setName3").textContent = label ? "(" + label + ")" : "";

  const tb = document.querySelector("#stats tbody");
  tb.innerHTML = "";
  if (st && st.set) {
    (st.slides || []).forEach((r, i) => {
      tb.insertAdjacentHTML("beforeend",
        "<tr><td>" + (i + 1) + "</td><td>" + r.name + "</td>" +
        "<td class='num'>" + r.views + "</td>" +
        "<td class='num'>" + fmt(r.watchMs) + "</td>" +
        "<td class='num'>" + fmt(r.avgMs) + "</td></tr>");
    });
    if (!(st.slides || []).length) tb.innerHTML = "<tr><td colspan='5'>No slides in this set.</td></tr>";
    document.querySelector("#stats tfoot").innerHTML =
      "<tr class='total'><td></td><td>Set total</td><td class='num'></td>" +
      "<td class='num'>" + fmt(st.set.totalMs) + "</td><td></td></tr>";
  } else {
    tb.innerHTML = "<tr><td colspan='5'>No set selected.</td></tr>";
    document.querySelector("#stats tfoot").innerHTML = "";
  }

  const ub = document.querySelector("#users tbody");
  ub.innerHTML = "";
  if (st && (st.users || []).length) {
    st.users.forEach((u) => {
      const detail = Object.entries(u.slides || {})
        .map(([id, ms]) => {
          const set = currentSet();
          const s = set && set.slides.find(x => x.id === id);
          return (s ? s.name : id.slice(0, 6)) + " (" + fmt(ms) + ")";
        }).join(", ");
      ub.insertAdjacentHTML("beforeend", "<tr><td>" + u.user + "</td>" +
        "<td class='num'>" + fmt(u.totalMs) + "</td>" +
        "<td class='num'>" + fmt(u.setMs) + "</td>" +
        "<td style='font-size:12px;color:#666'>" + (detail || "–") + "</td></tr>");
    });
  } else {
    ub.innerHTML = "<tr><td colspan='4'>No signed-in viewer activity yet.</td></tr>";
  }
}

// Poll periodically (admin side of "live")
setInterval(() => { if (document.getElementById("panel").style.display === "block") refresh(); }, 15000);

// If already signed in (e.g., redirected from SSO), go straight in
fetch("/api/stats").then(r => { if (r.ok) show(); });
</script></body></html>`;

const SSO_ERROR_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign-in problem</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#333}</style>
</head><body>
<div style="text-align:center">
  <h2>Sign-in didn't complete</h2>
  <p id="r"></p>
  <p><a href="/admin">Back to admin</a></p>
</div>
<script>
const reasons = {
  invalid_state: "The sign-in session expired or was reused. Please try again.",
  not_admin: "Your Microsoft account is not on the admin list (ADMIN_EMAILS).",
  exchange_failed: "Microsoft rejected the sign-in. Check MS_TENANT_ID / MS_CLIENT_ID and the redirect URI.",
};
document.getElementById("r").textContent = reasons[new URLSearchParams(location.search).get("reason")] || "Unknown error.";
</script></body></html>`;

/* ------------------------------------------------------------------ */
/* Server                                                               */
/* ------------------------------------------------------------------ */

ensureDirs();

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let p = ""; // declared outside try so the catch block can reference it
      try {
        const body = Buffer.concat(chunks);
        if (body.length > 200 * 1024 * 1024) {
          return sendJSON(res, 413, { error: "too large" });
        }
        p = req.url.split("?")[0];

        if (p.startsWith("/api/")) return handleApi(req, res, body.length ? body : "");

        if (p === "/" || p === "/index.html") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          return res.end(VIEWER_HTML);
        }
        if (p === "/admin") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          return res.end(ADMIN_HTML);
        }
        if (p === "/sso-error") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          return res.end(SSO_ERROR_HTML);
        }
        if (p.startsWith("/slides/")) {
          const f = path.join(SLIDES_DIR, path.basename(p));
          if (fs.existsSync(f)) {
            const ext = path.extname(f).toLowerCase();
            const types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf" };
            res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
            const stream = fs.createReadStream(f);
            stream.on("error", (e) => { logError("stream " + p, e); try { res.destroy(); } catch (_) {} });
            return stream.pipe(res);
          }
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      } catch (e) {
        logError("request " + p, e);
        try { sendJSON(res, 500, { error: "internal error" }); } catch (_) {}
      }
    });
  })
  .on("clientError", (err, socket) => {
    logError("clientError", err);
    try { socket.destroy(); } catch (_) {}
  })
  .listen(PORT, () => {
    console.log("Slide site running:");
    console.log("  Viewer : http://localhost:" + PORT + "/");
    console.log("  Admin  : http://localhost:" + PORT + "/admin");
    console.log("  Speed  : 1x = " + DEFAULT_SECONDS + "s per slide (slider 0.5x-2x)");
    console.log("  SSO    : " + (MS_CLIENT ? "Microsoft SSO enabled (admins: " +
      (ADMIN_EMAILS.length ? ADMIN_EMAILS.join(", ") : "any signed-in org user") + ")"
      : "off — set MS_TENANT_ID / MS_CLIENT_ID to enable"));
    console.log("  SSO redirect URI for Azure: http://localhost:" + PORT + "/api/ms/callback");
    if (ADMIN_KEY === "admin123") console.log("  ⚠ Using default admin key — set ADMIN_KEY env var!");
  });
