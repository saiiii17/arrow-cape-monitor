require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { buildDigest, buildDigestSummarised, buildDigestRange, datesAvailable } = require("./digest");
const { buildRundown } = require("./c3");
const { matchAll } = require("./c3/match");
const { PROVIDER: C3_PROVIDER } = require("./c3/llm");
const live = require("./live");
const auth = require("./auth");

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

  // ---- sign-in -------------------------------------------------------------
  // Everything below is behind the password when APP_PASSWORD is set.
  if (url.pathname === "/healthz") return json(res, 200, { ok: true });
  if (url.pathname === "/login") {
    if (!auth.enabled()) { res.writeHead(302, { Location: "/" }).end(); return; }
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    fs.createReadStream(path.join(PUBLIC_DIR, "login.html")).pipe(res);
    return;
  }
  if (url.pathname === "/api/login" && req.method === "POST") {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (!auth.allowAttempt(ip)) return json(res, 429, { error: "Too many attempts — wait a minute" });
    const { password } = await readBody(req);
    if (!auth.checkPassword(password)) return json(res, 401, { error: "Wrong password" });
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": auth.sessionCookie(req) });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === "/api/logout") {
    res.writeHead(302, { Location: auth.enabled() ? "/login" : "/", "Set-Cookie": auth.clearCookie() }).end();
    return;
  }
  if (auth.enabled() && !auth.isPublic(url.pathname) && !auth.isLoggedIn(req)) {
    if (url.pathname.startsWith("/api/")) return json(res, 401, { error: "Sign in required" });
    res.writeHead(302, { Location: "/login" }).end();
    return;
  }
  if (url.pathname === "/api/session") return json(res, 200, { auth: auth.enabled() });

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
  if (url.pathname === "/api/broadcast/tags" && req.method === "POST") {
    const { tags } = await readBody(req);
    return json(res, 200, { tagged: live.saveTags(tags) });
  }
  if (url.pathname === "/api/broadcast/send" && req.method === "POST") {
    const { text, dryRun } = await readBody(req);
    try {
      return json(res, 200, await live.broadcast(text, { dryRun: Boolean(dryRun) }));
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
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    try {
      await live.logout();
    } catch {
      /* ignore */
    }
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

try {
  const cleared = live.clearStaleProfileLock();
  if (cleared.length) console.log(`  cleared stale WhatsApp session: ${cleared.join(", ")}`);
} catch {
  /* nothing to clear */
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
try { live.prewarm(); } catch { /* non-fatal */ }

server.listen(PORT, "0.0.0.0", () => {
  const dates = datesAvailable();
  console.log(`\n  C5 account monitor  →  http://localhost:${PORT}`);
  console.log(`  ${dates.length} days loaded (${dates[0]} .. ${dates[dates.length - 1]})\n`);
});
