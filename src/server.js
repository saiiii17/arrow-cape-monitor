require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { buildDigest, buildDigestSummarised, buildDigestRange, datesAvailable } = require("./digest");
const { buildRundown } = require("./c3");
const { matchAll } = require("./c3/match");
const { PROVIDER: C3_PROVIDER } = require("./c3/llm");
const live = require("./live");

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
      ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).sort()
      : [];
    return json(res, 200, { dates, first: dates[0] || today, last: dates[dates.length - 1] || today, asOf, suggested, cached });
  }

  if (url.pathname === "/api/c3/cached") {
    // Must follow the active provider, or the UI offers days that were only
    // ever extracted by the other one.
    const dir = require("./c3").cacheDir();
    const days = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).sort()
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
    live.start({ fresh: url.searchParams.get("resume") !== "1" });
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
    const cleared = live.clearStaleProfileLock();
    return json(res, 200, { ...live.snapshot(), cleared });
  }

  if (url.pathname === "/api/wa/logout" && req.method === "POST") {
    // Unlink wipes the stored credentials so the next connect is a clean link.
    // Unlink = disconnect, forget credentials, and delete captured messages.
    await live.logout({ unlink: true, wipe: true, clearData: true });
    return json(res, 200, live.snapshot());
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
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
  res.writeHead(200, { "Content-Type": types[path.extname(full)] || "text/plain" });
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
if (fs.existsSync(path.join(__dirname, "..", ".wwebjs_auth", "session-monitor"))) process.env.WA_LINKED = "1";

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

// Start Chrome immediately so the QR is ready before anyone clicks Connect.
try { live.prewarm(); } catch { /* non-fatal */ }

server.listen(PORT, "0.0.0.0", () => {
  const dates = datesAvailable();
  console.log(`\n  C5 account monitor  →  http://localhost:${PORT}`);
  console.log(`  ${dates.length} days loaded (${dates[0]} .. ${dates[dates.length - 1]})\n`);
});
