require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { buildDigest, buildDigestSummarised, buildDigestRange, datesAvailable } = require("./digest");
const { buildRundown } = require("./c3");
const { matchAll } = require("./c3/match");
const { PROVIDER: C3_PROVIDER } = require("./c3/llm");
const live = require("./live");
const crypto = require("crypto");
const auth = require("./auth");
const authz = require("./authz");
const users = require("./users");

// Secrets mid-enrolment: held in memory only, so a 2FA setup that is abandoned
// leaves nothing behind.
const pendingTotp = new Map();

const PORT = Number(process.env.PORT || 4321);
const PUBLIC_DIR = path.join(__dirname, "public");

// The WhatsApp sender is loaded lazily -- the dashboard must run even when
// nobody has scanned a QR code yet.
let whatsapp = null;
function getWhatsapp() {
  if (!whatsapp) whatsapp = require("./whatsapp");
  return whatsapp;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c)); // exports can be several MB
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ---- who is asking -------------------------------------------------------
  // Accounts, not one shared password. the owner is the admin and sees everything;
  // everybody else is a customer who gets the broadcast tools and nothing more.
  // authz.js decides, from the path alone, before any handler runs.
  if (url.pathname === "/healthz") return json(res, 200, { ok: true });

  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

  for (const [route, file] of [["/login", "login.html"], ["/register", "register.html"],
    ["/tutorial", "tutorial.html"], ["/pricing", "pricing.html"], ["/privacy", "privacy.html"],
    ["/terms", "terms.html"], ["/support", "support.html"]]) {
    if (url.pathname !== route) continue;
    if (route === "/login" && !auth.enabled()) { res.writeHead(302, { Location: "/" }).end(); return; }
    const full = path.join(PUBLIC_DIR, file);
    if (!fs.existsSync(full)) break;
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    fs.createReadStream(full).pipe(res);
    return;
  }

  if (url.pathname === "/api/login" && req.method === "POST") {
    if (!auth.allowAttempt(ip)) return json(res, 429, { error: "Too many attempts — wait a minute" });
    const { email, password } = await readBody(req);
    // The deployed site predates accounts: its sign-in page sends a password and
    // no address. That keeps working -- the password alone signs the admin in --
    // so a deploy does not lock the owner out of his own dashboard.
    const legacy = !String(email || "").trim() && String(process.env.APP_PASSWORD || "").trim();
    const r = legacy
      ? (() => {
        const a = Buffer.from(crypto.createHash("sha256").update(String(password || "")).digest());
        const b = Buffer.from(crypto.createHash("sha256").update(String(process.env.APP_PASSWORD)).digest());
        if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: "Wrong password" };
        const admin = users.findByEmail(process.env.ADMIN_EMAIL || users.LEGACY_ADMIN_EMAIL);
        return admin ? { ok: true, user: admin } : { ok: false, reason: "No admin account on this server" };
      })()
      : users.authenticate(email, password);
    if (!r.ok) return json(res, 401, { error: r.reason });
    // The admin's password alone is not enough once 2FA is on: it buys a short
    // ticket that only a current code can redeem.
    if (users.needsTotp(r.user)) {
      return json(res, 200, { need2fa: true, ticket: auth.makeTicket(r.user) });
    }
    users.touchLogin(r.user.id);
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": auth.sessionCookie(req, r.user) });
    res.end(JSON.stringify({ ok: true, role: r.user.role }));
    return;
  }

  if (url.pathname === "/api/login/2fa" && req.method === "POST") {
    // Codes are rationed harder than passwords: six digits is a small space.
    if (!auth.allowAttempt(ip, "2fa", 5)) return json(res, 429, { error: "Too many codes — wait a minute" });
    const { ticket, code } = await readBody(req);
    const uid = auth.readTicket(ticket);
    if (!uid) return json(res, 401, { error: "That took too long — sign in again" });
    const u = users.findById(uid);
    if (!u || !users.verifyTotp(users.totpSecretOf(uid), code)) {
      return json(res, 401, { error: "That code is not right" });
    }
    users.touchLogin(u.id);
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": auth.sessionCookie(req, u) });
    res.end(JSON.stringify({ ok: true, role: u.role }));
    return;
  }

  // Anyone may ask for an account; nobody gets in until the owner approves it.
  if (url.pathname === "/api/register" && req.method === "POST") {
    if (!auth.enabled()) return json(res, 400, { error: "Accounts are not in use on this server" });
    if (!auth.allowAttempt(ip, "register", 5)) return json(res, 429, { error: "Too many attempts — wait a minute" });
    const { email, password, name } = await readBody(req);
    try {
      users.createUser({ email, password, name, role: "user", status: "pending" });
      return json(res, 200, { ok: true, pending: true });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (url.pathname === "/api/logout") {
    res.writeHead(302, { Location: auth.enabled() ? "/login" : "/", "Set-Cookie": auth.clearCookie() }).end();
    return;
  }

  // The gate. One decision, taken from the path, for every request below.
  const who = auth.whoami(req);
  const verdict = authz.decide(url.pathname, who);
  if (!verdict.allow) {
    const api = url.pathname.startsWith("/api/");
    if (verdict.why === "signin") {
      if (api) return json(res, 401, { error: "Sign in required" });
      res.writeHead(302, { Location: "/login" }).end();
      return;
    }
    if (verdict.why === "inactive") {
      const msg = who && who.status === "pending"
        ? "This account is waiting to be approved"
        : "This account has been suspended";
      if (api) return json(res, 403, { error: msg });
      res.writeHead(302, { Location: "/login?status=" + (who ? who.status : "") }).end();
      return;
    }
    // Forbidden: a customer reaching for something that is not theirs. Nothing
    // about it is described, and it is noted.
    console.warn(`  [authz] ${who ? who.email : "?"} was refused ${url.pathname}`);
    if (api) return json(res, 403, { error: "Not available on this account" });
    res.writeHead(302, { Location: "/" }).end();
    return;
  }
  // A public path passes the gate with nobody signed in, so this must tolerate
  // a null account rather than assume one.
  const isAdmin = Boolean(who && who.role === "admin");

  if (url.pathname === "/api/session") {
    if (!who) return json(res, 401, { error: "Sign in required" });
    return json(res, 200, {
      auth: auth.enabled(),
      user: { email: who.email, name: who.name, role: who.role, twoFactor: Boolean(who.twoFactor) },
      // What the page may draw. The server has already decided; this only saves
      // the page from rendering a tab that would be refused anyway.
      can: { broadcast: true, accounts: isAdmin, c5: isAdmin, c3: isAdmin, matches: isAdmin, history: isAdmin },
    });
  }

  // ---- accounts, for the admin --------------------------------------------
  if (url.pathname === "/api/users") return json(res, 200, { users: users.list() });

  if (url.pathname === "/api/users/status" && req.method === "POST") {
    const { id, status } = await readBody(req);
    try { return json(res, 200, { user: users.setStatus(id, status) }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (url.pathname === "/api/users/delete" && req.method === "POST") {
    const { id } = await readBody(req);
    try { users.remove(id); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (url.pathname === "/api/me/password" && req.method === "POST") {
    const { current, next } = await readBody(req);
    const check = users.authenticate(who.email, current);
    if (!check.ok) return json(res, 401, { error: "Your current password is not right" });
    try { users.setPassword(who.id, next); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ---- the admin's second factor ------------------------------------------
  if (url.pathname === "/api/admin/2fa" && req.method === "POST") {
    const { off } = await readBody(req);
    if (off) { users.disableTotp(who.id); return json(res, 200, { ok: true, twoFactor: false }); }
    // Handed over once, while enrolling, and never readable again afterwards.
    const secret = users.newTotpSecret();
    pendingTotp.set(who.id, { secret, at: Date.now() });
    return json(res, 200, { secret, uri: users.totpUri(secret, who.email) });
  }

  if (url.pathname === "/api/admin/2fa/confirm" && req.method === "POST") {
    const { code } = await readBody(req);
    const p = pendingTotp.get(who.id);
    if (!p || Date.now() - p.at > 10 * 60_000) return json(res, 400, { error: "Start again — that took too long" });
    if (!users.verifyTotp(p.secret, code)) return json(res, 400, { error: "That code is not right — check the app and try again" });
    users.enableTotp(who.id, p.secret);
    pendingTotp.delete(who.id);
    return json(res, 200, { ok: true, twoFactor: true });
  }

  if (url.pathname === "/api/dates") {
    return json(res, 200, { dates: datesAvailable() });
  }

  if (url.pathname === "/api/digest") {
    const dates = datesAvailable();
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    // Range mode: one payload covering several days.
    if (from && to) {
      const r = await buildDigestRange(from, to, { raw: url.searchParams.get("raw") === "1" });
      return json(res, 200, {
        date: `${r.from} → ${r.to}`,
        // The range asked for, kept separate from the days that had traffic.
        // Collapsing the two made the header contradict the filter above it.
        requestedFrom: r.requestedFrom,
        requestedTo: r.requestedTo,
        from: r.from,
        to: r.to,
        dayCount: r.dayCount,
        capped: r.capped,
        window: r.window,
        source: r.source,
        messagesScanned: r.messagesScanned,
        text: r.text,
        rows: r.rows,
        counts: null,
      });
    }

    const date = url.searchParams.get("date") || dates[dates.length - 1];
    if (!dates.includes(date)) return json(res, 404, { error: `No messages on ${date}` });
    // the owner prefers summaries; raw stays available per row for checking.
    const d = url.searchParams.get("raw") === "1" ? buildDigest(date) : await buildDigestSummarised(date);
    return json(res, 200, {
      date: d.date,
      window: d.window,
      source: d.source,
      messagesScanned: d.messagesScanned,
      text: d.text,
      rows: d.rows,
      counts: Object.fromEntries(
        Object.entries(d.groups).map(([k, v]) => [k, { direct: v.direct.length, indirect: v.indirect.length }])
      ),
    });
  }

  // The consolidated copy-paste block for the C5 accounts. Cached by range so a
  // second view is instant (each build is a set of model calls).
  if (url.pathname === "/api/digest/brief") {
    try {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const sig = `${from}|${to}|${process.env.C5_GROUP || ""}|${process.env.WA_CONNECTED || ""}`;
      global.__briefCache = global.__briefCache || new Map();
      if (!url.searchParams.get("refresh") && global.__briefCache.has(sig)) {
        return json(res, 200, { ...global.__briefCache.get(sig), cached: true });
      }
      const { buildBrief } = require("./brief");
      const { rawGroupsForRange } = require("./digest");
      // Raw groups only -- no per-message summaries -- so the cost is just the
      // three account calls, not one call per update.
      const day = from || url.searchParams.get("date") || datesAvailable().pop();
      const r = rawGroupsForRange(from || day, to || day, {});
      const brief = await buildBrief(r.groups, { from: r.from, to: r.to });
      global.__briefCache.set(sig, brief);
      return json(res, 200, brief);
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // Extraction is rate-limited and slow; the UI uses this to prefer warm days.
  // Everything the C3 controls need, derived from the data.
  if (url.pathname === "/api/c3/meta") {
    const c3 = require("./c3");
    const dates = c3.availableDates();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
    const asOf = url.searchParams.get("date") || dates[dates.length - 1] || today;
    let suggested = null;
    try {
      suggested = c3.suggestedWindow(asOf);
    } catch {
      /* no ballaster list for that day */
    }
    const dir = c3.cacheDir();
    const cached = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.replace(".json", "")).sort()
      : [];
    return json(res, 200, { dates, first: dates[0] || today, last: dates[dates.length - 1] || today, asOf, suggested, cached });
  }

  if (url.pathname === "/api/c3/cached") {
    // Must follow the active provider, or the UI offers days that were only
    // ever extracted by the other one.
    const dir = require("./c3").cacheDir();
    const days = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.replace(".json", "")).sort()
      : [];
    return json(res, 200, { days });
  }

  if (url.pathname === "/api/c3") {
    try {
      const out = await buildRundown({
        date: url.searchParams.get("date") || undefined,
        window: url.searchParams.get("window") || undefined,
        windowFrom: url.searchParams.get("windowFrom") || undefined,
        windowTo: url.searchParams.get("windowTo") || undefined,
        lookback: Number(url.searchParams.get("lookback") || 2),
      });
      return json(res, 200, {
        asOf: out.asOf,
        span: out.span,
        ballasterDate: out.ballasterDate,
        source: out.source,
        windowText: out.windowText,
        text: out.text,
        cargo: out.state.cargo,
        tonnage: out.state.tonnage,
        fixtures: out.state.fixtures,
        matches: matchAll(out.state, {
          minScore: Number(url.searchParams.get("minScore") || 40),
          perCargo: Number(url.searchParams.get("perCargo") || 4),
        }),
      });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ---- live WhatsApp ----
  if (url.pathname === "/api/wa/status") {
    return json(res, 200, live.snapshot());
  }

  if (url.pathname === "/api/wa/start" && req.method === "POST") {
    // Connect = always a fresh QR. Pass ?resume=1 to reuse a stored login.
    // ?phone=<digits with country code> links with a code instead of a QR.
    const phone = url.searchParams.get("phone");
    if (phone != null) {
      const digits = phone.replace(/\D/g, "");
      if (digits.length < 8 || digits.length > 15) {
        return json(res, 400, { error: "Enter the number with its country code, digits only — e.g. 971501234567" });
      }
    }
    live.start({ fresh: url.searchParams.get("resume") !== "1", phone: phone || undefined });
    return json(res, 200, live.snapshot());
  }

  if (url.pathname === "/api/wa/watch" && req.method === "POST") {
    const { c5, c3, since } = await readBody(req);
    live.setWatching(c5, c3, since);
    return json(res, 200, live.snapshot());
  }

  if (url.pathname === "/api/wa/debug") {
    try {
      const g = url.searchParams.get("group");
      const groups = live.snapshot().groups;
      const hit = groups.find((x) => x.name === g) || groups[0];
      // Without a group there is nothing to inspect -- but that is exactly the
      // state worth reporting, so describe the page rather than throwing on
      // `hit.name` the way this used to.
      if (!hit) {
        const snap = live.snapshot();
        return json(res, 200, {
          note: "no groups loaded yet — reporting the live page instead",
          status: snap.status, connected: snap.connected, error: snap.error || null,
          page: await live.pageState(),
        });
      }
      // Opening the chat makes WhatsApp load and DECRYPT its messages into
      // Collections.Msg; without it only encrypted raw rows are available.
      if (url.searchParams.get("dry")) return json(res, 200, await live.dryRunSend(url.searchParams.get("dry")));
      if (url.searchParams.get("trace")) return json(res, 200, await live.traceSend(url.searchParams.get("trace")));
      if (url.searchParams.get("sendable")) return json(res, 200, await live.checkSendable(url.searchParams.get("sendable")));
      if (url.searchParams.get("lid")) return json(res, 200, await live.probeLid(url.searchParams.get("lid")));
      if (url.searchParams.get("probe") === "1") return json(res, 200, await live.probeModules());
      if (url.searchParams.get("hydrate") === "1") return json(res, 200, await live.tryHydrate(hit.id));
      const openedInfo = await live.openChatByName(hit.name);
      const since = url.searchParams.get("since");
      const sinceUnix = since ? Math.floor(new Date(`${since}T00:00:00+04:00`).getTime() / 1000) : 0;
      const after = await live.inspectAfterOpen(hit.id);
      const r = await live.historySince(hit.id, sinceUnix, 2000);
      return json(res, 200, { group: hit.name, id: hit.id, opened: openedInfo, afterOpen: after, found: r.rows.length, diag: r.diag, sample: r.rows.slice(0, 5) });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (url.pathname === "/api/wa/groups" && req.method === "POST") {
    try {
      await live.refreshGroups({ retries: 3 });
      return json(res, 200, live.snapshot());
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (url.pathname === "/api/wa/import" && req.method === "POST") {
    const { group, text, since } = await readBody(req);
    try {
      if (!group) throw new Error("No group name given");
      if (!text) throw new Error("No export text received");
      return json(res, 200, live.importExport(group, text, { since }));
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (url.pathname === "/api/wa/sync" && req.method === "POST") {
    try {
      const results = await live.syncAll();
      return json(res, 200, { results, ...live.snapshot() });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (url.pathname === "/api/wa/backfill" && req.method === "POST") {
    const { group, limit, since } = await readBody(req);
    try {
      return json(res, 200, await live.backfill(group, { since, limit: Number(limit) || 5000 }));
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (url.pathname === "/api/wa/reset" && req.method === "POST") {
    // Keep the login; guarantee the browser and its profile lock are gone so
    // the next Connect cannot hang on a leftover process.
    live.logout({ unlink: false });
    // Killing the profile can block for up to two seconds waiting on the
    // kernel. The caller does not need to wait for that -- logout() has
    // already reset the state the UI reads, and the cleanup is generation
    // guarded, so a Connect pressed in the meantime is not affected by it.
    live.clearStaleProfileLockAsync().catch(() => {});
    return json(res, 200, { ...live.snapshot(), cleared: ["clearing browser profile"] });
  }

  if (url.pathname === "/api/wa/restore" && req.method === "POST") {
    // Unlink archives the capture rather than deleting it; this puts the most
    // recent archive back, merged with anything captured since.
    const r = require("./livestore").restoreLatest();
    // Not spread over live.snapshot(): its own `groups` field (every group on
    // the account) silently replaced the list of groups that were restored.
    const snap = live.snapshot();
    return json(res, 200, { restored: r.restored, restoredGroups: r.groups, status: snap.status, stores: snap.stores });
  }

  if (url.pathname === "/api/wa/logout" && req.method === "POST") {
    // Unlink wipes the stored credentials so the next connect is a clean link.
    // Unlink = disconnect, forget credentials, and delete captured messages.
    await live.logout({ unlink: true, wipe: true, clearData: true });
    return json(res, 200, live.snapshot());
  }

  // ---- broadcast -----------------------------------------------------------
  if (url.pathname === "/api/broadcast/chats") {
    const tagged = live.loadTags();
    try {
      return json(res, 200, { connected: true, chats: await live.listChats(), tagged });
    } catch (e) {
      // Not connected: show the saved tags so they can still be reviewed and
      // untagged, and say why the full list is missing.
      return json(res, 200, { connected: false, reason: e.message, chats: tagged, tagged });
    }
  }
  // Shows the operator exactly how a greeting lands before it is sent.
  if (url.pathname === "/api/broadcast/preview" && req.method === "POST") {
    const { text, listId } = await readBody(req);
    const list = live.getList(listId || "");
    const chats = (list && list.chats) || [];
    return json(res, 200, {
      personalised: live.hasTokens(text),
      samples: chats.slice(0, 3).map((c) => ({ name: c.name, text: live.personalise(text, c) })),
      more: Math.max(0, chats.length - 3),
    });
  }
  if (url.pathname === "/api/broadcast/lists") {
    if (req.method === "POST") {
      const { lists } = await readBody(req);
      return json(res, 200, { lists: live.saveLists(lists) });
    }
    return json(res, 200, { lists: live.loadLists() });
  }
  if (url.pathname === "/api/broadcast/tags" && req.method === "POST") {
    const { tags } = await readBody(req);
    return json(res, 200, { tagged: live.saveTags(tags) });
  }
  // Raw bytes, not multipart: one file at a time, and the name and type come
  // from the query, which keeps the server free of a form-parsing dependency.
  if (url.pathname === "/api/broadcast/upload" && req.method === "POST") {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) throw new Error("That file is too large");
        chunks.push(chunk);
      }
      return json(res, 200, live.saveUpload(Buffer.concat(chunks), {
        name: url.searchParams.get("name") || "file",
        type: url.searchParams.get("type") || req.headers["content-type"] || "",
      }));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (url.pathname === "/api/broadcast/recall" && req.method === "POST") {
    try {
      return json(res, 200, await live.recallBroadcast({}));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (url.pathname === "/api/broadcast/send" && req.method === "POST") {
    const { text, dryRun, listId, mediaId, mediaIds } = await readBody(req);
    try {
      return json(res, 200, await live.broadcast(text, { dryRun: Boolean(dryRun), listId: listId || "",
        mediaId: mediaId || "", mediaIds: Array.isArray(mediaIds) ? mediaIds : [] }));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (url.pathname === "/api/broadcast/relay") {
    if (req.method === "POST") {
      const cfg = await readBody(req);
      return json(res, 200, live.saveRelay(cfg));
    }
    return json(res, 200, live.loadRelay());
  }
  if (url.pathname === "/api/broadcast/status") {
    // Refresh the delivery ticks as the UI polls, throttled inside live.js.
    await live.refreshAcks().catch(() => {});
    return json(res, 200, live.broadcastStatus());
  }

  if (url.pathname === "/api/send" && req.method === "POST") {
    const { date, text, target } = await readBody(req);
    try {
      const payload = text || buildDigest(date).text;
      // Prefer the live-linked session so only one QR scan is ever needed.
      const r = live.snapshot().status === "ready"
        ? await live.send(payload, target)
        : { to: await getWhatsapp().sendToSelf(payload), parts: 1 };
      return json(res, 200, { ok: true, sent: date || "rundown", to: r.to, parts: r.parts });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) {
    res.writeHead(404).end("Not found");
    return;
  }
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
    ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
  // No cache headers at all meant browsers applied heuristic caching to the
  // dashboard: after a code change the page kept serving the old markup and
  // script, so fixes looked like they had not landed and old bugs looked like
  // they had come back. The whole UI is one small file served locally -- there
  // is nothing to gain by caching it and a great deal to lose.
  res.writeHead(200, {
    "Content-Type": types[path.extname(full)] || "text/plain",
    "Cache-Control": "no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  fs.createReadStream(full).pipe(res);
});

// Tearing down the WhatsApp browser mid-connect makes whatsapp-web.js reject
// from an internal handler that has no catch (Client.js -> Network.getResponseBody),
// which by default takes the whole process down. That crash is what made the
// connect flow look flaky: the server died, so the UI kept showing a stale
// error. Puppeteer teardown noise must never kill the dashboard.
const TEARDOWN_NOISE = /Target closed|Protocol error|Session closed|Execution context was destroyed|Target\.closeTarget/i;

process.on("unhandledRejection", (err) => {
  const msg = (err && err.message) || String(err);
  if (TEARDOWN_NOISE.test(msg)) {
    console.warn(`  (ignored browser teardown error: ${msg.slice(0, 80)})`);
    return;
  }
  console.error("Unhandled rejection:", err);
});

process.on("exit", (code) => {
  if (code !== 0) console.error(`  [node] exiting with code ${code}`);
});

process.on("uncaughtException", (err) => {
  const msg = (err && err.message) || String(err);
  if (TEARDOWN_NOISE.test(msg)) {
    console.warn(`  (ignored browser teardown error: ${msg.slice(0, 80)})`);
    return;
  }
  console.error("Uncaught exception:", err);
});

// A killed server leaves its headless Chrome holding the WhatsApp profile lock,
// which makes the next start fail with "browser is already running".
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (stopping) process.exit(0);   // a second Ctrl-C means now
    stopping = true;
    // Close the browser; do NOT log out. logout() defaults to unlinking the
    // device, which is why stopping the server used to cost a fresh QR scan.
    const capped = new Promise((r) => setTimeout(r, 8000));
    try { await Promise.race([live.shutdown(), capped]); } catch { /* going down */ }
    process.exit(0);
  });
}

// A previous run may have left headless Chrome holding the WhatsApp profile.
// Clearing it at boot means a server restart is always enough to recover -- the
// user should never see "browser is already running".
// A stored WhatsApp profile means an account is linked: never show sample data
// for it, even before the browser is started again.
// A chromium profile on disk is not a login -- showing a QR creates one. Only
// a session that actually authenticated leaves this marker behind.
if (fs.existsSync(path.join(__dirname, "..", "data", "linked.flag"))) process.env.WA_LINKED = "1";

// Re-apply the saved group selection so captured messages are found after a
// restart, without needing the WhatsApp tab to be opened first.
const savedWatch = live.snapshot().watching;
if (savedWatch.c5) process.env.C5_GROUP = savedWatch.c5;
if (savedWatch.c3) process.env.C3_GROUP = savedWatch.c3;

// Only clear leftovers when nobody else is using the profile: the clear is a
// SIGKILL of every Chromium on it, and a second server (a test or dev copy)
// must not take down a live session owned by another instance.
const profileOwner = live.profileOwner();
if (profileOwner) {
  console.log(`  another instance (pid ${profileOwner.pid}) is using the WhatsApp profile — leaving it alone`);
} else {
  try {
    const cleared = live.clearStaleProfileLock();
    if (cleared.length) console.log(`  cleared stale WhatsApp session: ${cleared.join(", ")}`);
  } catch {
    /* nothing to clear */
  }
}

// One-line environment fingerprint: on a container this is what tells you which
// Chromium is in use and how much memory the box actually has.
try {
  const info = live.environmentInfo();
  console.log(`  env: ${info.platform}/${info.arch} · chromium ${info.chromium} · ${info.memory}`);
} catch {
  /* non-fatal */
}

// Start Chrome immediately so the QR is ready before anyone clicks Connect.
// A second instance must not launch a browser on a profile someone else owns.
if (profileOwner) console.log("  not starting WhatsApp here — the profile belongs to another instance");
else try { live.prewarm(); } catch { /* non-fatal */ }

server.listen(PORT, "0.0.0.0", () => {
  const dates = datesAvailable();
  console.log(`\n  C5 account monitor  →  http://localhost:${PORT}`);
  // Said plainly at boot: an open deployment looks identical to a protected
  // one until someone opens the URL, and this one can broadcast from the
  // linked WhatsApp account.
  // The admin exists from the first boot, so the site is never up without an
  // owner who could approve accounts.
  let admin = null;
  try { admin = users.ensureAdmin(); } catch (e) { console.error("  could not create the admin account:", e.message); }
  if (auth.enabled()) {
    const all = users.list();
    const waiting = all.filter((u) => u.status === "pending").length;
    console.log(`  sign-in: ON · ${all.length} account${all.length === 1 ? "" : "s"}` +
      (waiting ? ` · ${waiting} waiting for approval` : ""));
    if (admin) {
      console.log(`  admin: ${admin.email}${admin.twoFactor ? " · 2FA on" : " · 2FA off (turn it on from the app)"}`);
    } else if (!String(process.env.ADMIN_EMAIL || "").trim()) {
      console.log("  no ADMIN_EMAIL set — nobody can approve new accounts until one exists");
    }
  } else {
    console.log("  sign-in: OFF — anyone with the URL can read the chats and broadcast.");
    console.log("  set ADMIN_EMAIL and ADMIN_PASSWORD to turn accounts on.");
  }
  console.log(`  ${dates.length} days loaded (${dates[0]} .. ${dates[dates.length - 1]})\n`);
});
