require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const QR = require("qrcode");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { append, stats, toRecord, clearAll } = require("./livestore");

const PROFILE_DIR = path.join(__dirname, "..", ".wwebjs_auth", "session-monitor");
const WATCH_FILE = path.join(__dirname, "..", "data", "watched-groups.json");

// The chosen groups must survive a server restart, or captured messages become
// unreachable: the pipelines look them up by group name.
function loadWatched() {
  try {
    const w = JSON.parse(fs.readFileSync(WATCH_FILE, "utf8"));
    if (w.c5) process.env.C5_GROUP = w.c5;
    if (w.c3) process.env.C3_GROUP = w.c3;
    return { c5: w.c5 || "", c3: w.c3 || "", since: w.since || "" };
  } catch {
    return { c5: process.env.C5_GROUP || "", c3: process.env.C3_GROUP || "", since: "" };
  }
}

function saveWatched(w) {
  try {
    fs.mkdirSync(path.dirname(WATCH_FILE), { recursive: true });
    fs.writeFileSync(WATCH_FILE, JSON.stringify(w, null, 2));
  } catch {
    /* non-fatal */
  }
}

// A crashed or killed server leaves headless Chrome holding the profile, and
// every later connect fails with "browser is already running". Clear both the
// orphaned process and the stale lock files so the user never has to run pkill.
function clearStaleProfileLock() {
  const cleared = [];
  try {
    // Match only Chrome's own --user-data-dir flag. A looser pattern also
    // matches any shell whose command line mentions the profile, including the
    // one that launched this process.
    // "--" is required: the pattern itself begins with "--", which pkill would
    // otherwise parse as an option and silently match nothing.
    execFileSync("pkill", ["-f", "--", `--user-data-dir=${PROFILE_DIR}`], { stdio: "ignore" });
    cleared.push("orphaned chrome");
  } catch {
    /* nothing was running */
  }
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    const full = path.join(PROFILE_DIR, f);
    try {
      if (fs.existsSync(full) || fs.lstatSync(full)) {
        fs.rmSync(full, { force: true });
        cleared.push(f);
      }
    } catch {
      /* not present */
    }
  }
  return cleared;
}

// Live WhatsApp ingest. One linked session reads the two broker groups and
// writes each message into the same store the exports feed, so the C5 and C3
// pipelines run unchanged on live data.
//
// Linking is done by scanning a QR with the phone that owns the account. That
// grants this process access to every chat on that account, and the session is
// persisted on this machine under .wwebjs_auth/. Only link an account whose
// owner understands that.

const state = {
  status: "idle", // idle | starting | qr | authenticated | ready | error
  // Plain-English description of what is happening right now, for the UI.
  phase: "Not connected",
  // Rolling log of lifecycle steps with timestamps, for the UI.
  steps: [],
  // True only once history has been pulled for every configured group AND the
  // listener is active. "ready" alone is not "connected" for the user.
  connected: false,
  syncing: false,
  lastSync: null,
  qrDataUrl: null,
  error: null,
  me: null,
  groups: [],
  watching: loadWatched(),
  captured: 0,
  lastMessageAt: null,
};

function step(text, level = "info") {
  const t = new Date().toISOString();
  state.phase = text;
  // Collapse repeats: the same warning every 3s became 13 identical lines.
  const last = state.steps[state.steps.length - 1];
  if (last && last.text === text && last.level === level) {
    last.count = (last.count || 1) + 1;
    last.t = t;
  } else {
    state.steps.push({ t, text, level });
    if (state.steps.length > 40) state.steps.shift();
    console.log(`  [wa] ${text}`);
  }
}

let client = null;

// Groups discovered from live traffic, keyed by name.
function rememberGroup(name, id) {
  if (!name || !id) return;
  if (state.groups.some((g) => g.id === id)) return;
  state.groups.push({ name, id, participants: null, discovered: "traffic" });
  state.groups.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function senderName(msg) {
  try {
    const c = await msg.getContact();
    return c.pushname || c.name || c.number || msg.author || "unknown";
  } catch {
    return msg.author || "unknown";
  }
}

// Which of the two watched groups is this chat, if either.
function bucketFor(chatName) {
  const n = String(chatName || "").toLowerCase();
  if (state.watching.c5 && n === state.watching.c5.toLowerCase()) return "c5";
  if (state.watching.c3 && n === state.watching.c3.toLowerCase()) return "c3";
  return null;
}

function start() {
  if (client) return state;
  if (state.syncing) { step("Ignoring restart during history pull", "warn"); return state; }
  // Anything left over from a previous run would block the launch.
  clearStaleProfileLock();
  state.status = "starting";
  state.error = null;
  state.connected = false;
  state.abandoned = false;
  state.conflictStreak = 0;
  state.startedAt = Date.now();
  // A stored session means this account is linked even before it finishes
  // loading, so the sample must not flash on screen meanwhile.
  if (fs.existsSync(PROFILE_DIR)) process.env.WA_LINKED = "1";
  state.abandoned = false;
  step("Launching WhatsApp Web…");

  // A start that never reaches "qr" or "ready" would otherwise sit on
  // "starting" forever with nothing to act on.
  clearTimeout(state.startTimer);
  state.startTimer = setTimeout(() => {
    if (state.status === "starting") {
      state.status = "error";
      state.error =
        "Timed out launching WhatsApp. Press Connect again; if it repeats, stop the server, run: pkill -f session-monitor";
      hardStop();
    }
  }, 90_000);

  // A remote webVersionCache was tried to work around the broken chat layer; it
  // had no effect (WhatsApp Web self-updates past it) and cost a GitHub fetch on
  // every connect, which stalled reconnects. Set WA_VERSION to re-enable it.
  const waVersion = process.env.WA_VERSION || "";

  client = new Client({
    authStrategy: new LocalAuth({ clientId: "monitor" }),
    // NOTE: takeoverOnConflict was tried and made things worse on this build --
    // it produced a permanent "Use here" conflict even with no other client
    // open. The plain config below is what actually reached "ready".
    ...(waVersion
      ? {
          webVersionCache: {
            type: "remote",
            remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${waVersion}.html`,
          },
        }
      : {}),
    puppeteer: {
      headless: true,
      // Opening a chat and paging history run long in-page; the default 30s
      // protocol timeout aborts them mid-way.
      protocolTimeout: 240_000,
      // Only honour a container Chromium path when it actually exists -- a stale
      // /usr/bin/chromium on a Mac would make the launch fail with "Code: null".
      ...(process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)
        ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
        : {}),
      // Minimal, cross-platform flag set. NOTE: --no-zygote / --single-process
      // crash Chrome on macOS; do not add them. --disable-dev-shm-usage is the
      // only container-specific one and is harmless elsewhere.
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
  });

  client.on("qr", async (qr) => {
    clearTimeout(state.startTimer);
    if (state.status !== "qr") step("Waiting for QR scan — phone → Linked Devices → Link a Device");
    state.status = "qr";
    state.qrDataUrl = await QR.toDataURL(qr, { margin: 1, width: 320 });
    // WhatsApp rotates the code roughly every 20s; a scan of an expired one
    // fails with "couldn't link device", so the age is shown in the UI.
    state.qrAt = Date.now();
    state.qrCount = (state.qrCount || 0) + 1;
  });

  client.on("authenticated", () => {
    state.status = "authenticated";
    process.env.WA_LINKED = "1"; // from here on, sample data is never shown
    state.qrDataUrl = null;
    state.authAt = Date.now();
    step("Authenticated — loading WhatsApp Web (usually 10–40s)…");

    // "authenticated" but never "ready" is the hang the user kept hitting.
    // Escalate: claim the session, then reload the page, then restart once.
    clearInterval(state.authWatchdog);
    state.authWatchdog = setInterval(async () => {
      if (state.status !== "authenticated" || !client) return clearInterval(state.authWatchdog);
      const waited = Math.round((Date.now() - state.authAt) / 1000);
      if (waited >= 150) {
        clearInterval(state.authWatchdog);
        if (!state.reloadedOnce) {
          state.reloadedOnce = true;
          step(`Still loading after ${waited}s — restarting the browser once`, "warn");
          hardStop();
          setTimeout(() => start(), 2500);
        } else {
          step("WhatsApp Web did not finish loading. Press Force reset, then Connect.", "error");
          state.status = "error";
          state.error = "WhatsApp Web did not finish loading. Close web.whatsapp.com elsewhere, press Force reset, then Connect.";
          hardStop();
        }
        return;
      }
      if (waited >= 75 && !state.reloadTried) {
        state.reloadTried = true;
        step(`Still loading after ${waited}s — reloading the page`, "warn");
        try { await client.pupPage.reload({ waitUntil: "domcontentloaded" }); } catch { /* ignore */ }
        return;
      }
      if (waited >= 30 && waited % 15 === 0) {
        try { if (await claimSession()) step("Took the session back from another window", "warn"); } catch { /* ignore */ }
      }
    }, 5000);
  });

  client.on("ready", async () => {
    clearTimeout(state.startTimer);
    clearInterval(state.authWatchdog);
    state.status = "ready";
    process.env.WA_LINKED = "1";
    state.qrDataUrl = null;
    state.reclaims = 0;
    state.conflictStreak = 0;
    state.reclaimRestart = false;
    state.reloadTried = false;
    state.reloadedOnce = false;
    state.me = client.info?.pushname || client.info?.wid?.user || null;
    step(`Linked as ${state.me || "unknown"} — reading groups…`);

    // Ready: stop the fast poll. Watch slowly in case another window steals it.
    startClaimLoop(60_000);

    // Automatic sequence: groups -> history for the saved groups -> live.
    // The user should not have to press anything after scanning.
    await refreshGroups({ retries: 10 });
    step(`${state.groups.length} groups found`);
    if (state.watching.c5 || state.watching.c3) {
      await syncAll();
    } else {
      step("Ready — type the C5 and C3 group names and press Save", "info");
    }
  });

  client.on("auth_failure", (m) => {
    state.status = "error";
    state.error = `auth failed: ${m}`;
  });

  client.on("disconnected", (r) => {
    state.status = "idle";
    state.error = `disconnected: ${r}`;
    process.env.WA_CONNECTED = "";
    hardStop();
  });

  // Capture live traffic in both watched groups.
  //
  // Deliberately avoids msg.getChat(): that call goes through the same chat
  // layer that is broken on current WhatsApp Web builds, so it threw on every
  // message and the catch swallowed it -- nothing was ever captured. The chat
  // id is already on the message, and names come from the group list read out
  // of the local database.
  client.on("message_create", async (msg) => {
    // Counts every event, before any filtering, so "the listener never fires"
    // can be told apart from "it fired but the group did not match".
    state.eventsSeen = (state.eventsSeen || 0) + 1;
    try {
      const chatId =
        (msg.id && msg.id.remote) || (msg.fromMe ? msg.to : msg.from) || "";
      state.lastEvent = {
        at: new Date().toISOString(),
        chatId: String(chatId),
        isGroup: String(chatId).endsWith("@g.us"),
        body: String(msg.body || "").slice(0, 40),
      };
      if (!String(chatId).endsWith("@g.us")) return; // groups only

      if (!state.groups.length) await refreshGroups().catch(() => {});
      const group = state.groups.find((g) => g.id === String(chatId));
      const name = group ? group.name : String(chatId);
      rememberGroup(name, String(chatId));

      state.lastEvent.groupName = name;
      const bucket = bucketFor(name);
      state.lastEvent.matchedBucket = bucket || null;
      if (!bucket) return;

      const body = msg.body || (msg._data && msg._data.caption) || "";
      if (!body) return;

      // Own messages carry no notifyName, so the raw id leaked through as the
      // sender. Use the linked account's name instead.
      const sender = msg.fromMe
        ? (state.me || "You")
        : (msg._data && (msg._data.notifyName || msg._data.pushName)) ||
          String(msg.author || "").split("@")[0] ||
          "unknown";

      const rec = toRecord(msg.timestamp, sender, body);
      const n = append(name, [rec]);
      if (n) {
        state.captured += n;
        state.lastMessageAt = new Date().toISOString();
        console.log(`  captured [${bucket}] ${name}: ${sender}: ${body.slice(0, 60)}`);
      }
    } catch (e) {
      // Never silent again -- a swallowed error here cost hours.
      state.error = `capture failed: ${(e && e.message) || e}`;
      console.error("  capture error:", e && e.message);
    }
  });

  // Poll for the dialog from the start; it can appear before authentication.
  startClaimLoop(3000);

  client.initialize().catch(async (e) => {
    // A page reload during start-up destroys the init context. ONE restart
    // recovers it; anything more is thrash, so it is hard-capped at one.
    const contextLost = /Execution context was destroyed|Protocol error|Target closed|Session closed/i.test(e.message || "");
    // A deliberate abandon (persistent conflict) must not be "recovered".
    if (state.abandoned) return;
    if (contextLost && !state.reclaimRestart) {
      state.reclaimRestart = true;
      step("Page reloaded during start-up — restarting once", "warn");
      hardStop();
      state.status = "starting";
      state.error = null;
      setTimeout(() => start(), 3000);
      return;
    }
    // Self-heal the most common failure instead of asking for a terminal.
    if (/already running|SingletonLock/i.test(e.message || "")) {
      const cleared = clearStaleProfileLock();
      hardStop();
      state.status = "idle";
      state.error = `Cleared a stale session (${cleared.join(", ") || "lock"}). Press Connect again.`;
      return;
    }
    state.status = "error";
    hardStop();
    clearInterval(state.claimTimer);
    state.error = state.claimedSession || contextLost
      ? "Could not hold the WhatsApp session. Close web.whatsapp.com in every other browser tab, then press Connect."
      : e.message || "unknown startup failure";
    step(state.error, "error");
  });

  return state;
}

// client.getChats() serialises every field of every chat and throws a minified
// in-page error ("r") on some WhatsApp Web builds. Reading just the id and title
// straight from the page's own store avoids whatever field breaks it.
async function groupsFromPage() {
  return client.pupPage.evaluate(() => {
    const out = [];
    const store = window.Store && window.Store.Chat;
    const models = store ? (store.getModelsArray ? store.getModelsArray() : store.models || []) : [];
    for (const c of models) {
      const id = c.id && (c.id._serialized || c.id.toString());
      const isGroup = id ? id.endsWith("@g.us") : Boolean(c.isGroup);
      if (!isGroup) continue;
      out.push({
        name: c.formattedTitle || c.name || c.subject || id,
        id,
        participants: (c.groupMetadata && c.groupMetadata.participants && c.groupMetadata.participants.length) || null,
      });
    }
    return out;
  });
}

// Group list, sorted so a broker with dozens of chats can find the two.
async function refreshGroups({ retries = 0 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      // Local database first -- it works where getChats() does not.
      let groups = await groupsFromIDB();
      if (!groups.length) {
        const chats = await client.getChats();
        groups = chats
          .filter((c) => c.isGroup)
          .map((c) => ({ name: c.name, id: c.id._serialized, participants: c.participants?.length || null }));
      }
      if (groups.length) {
        state.groups = groups.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        state.error = null;
        return state.groups;
      }
    } catch (e) {
      // Known failure on current WhatsApp Web builds: getChats() issues a
      // keyless IndexedDB query. Groups are learned from traffic instead.
      // The underlying failure is a keyless IndexedDB query inside WhatsApp
      // Web; puppeteer only surfaces it as a minified "r". Either way the chat
      // list is unavailable, so say what to do instead of showing the noise.
      // Only report this while actually connected; otherwise it masks the real
      // connection error.
      if (state.status === "ready") {
        state.error =
          "Chat list unavailable — type the exact group names instead. " +
          "Capture still works, and names auto-fill as messages arrive.";
      }
    }
    if (i < retries) await new Promise((r) => setTimeout(r, 2000));
  }
  return state.groups;
}

// Pull recent history so a digest can be produced immediately after linking,
// rather than waiting for new traffic.
async function backfill(groupName, { since, limit = 50000 } = {}) {
  if (state.status !== "ready") throw new Error("WhatsApp is not connected yet");

  if (!state.groups.length) await refreshGroups();
  const known =
    state.groups.find((g) => g.name === groupName) ||
    state.groups.find((g) => String(g.name).toLowerCase() === String(groupName).toLowerCase());
  if (!known) throw new Error(`No group named "${groupName}" — check the exact name`);

  // Date floor in Dubai time, matching every other timestamp in the app.
  const sinceUnix = since ? Math.floor(new Date(`${since}T00:00:00+04:00`).getTime() / 1000) : 0;

  const { rows, diag } = await historySince(known.id, sinceUnix, limit);
  const records = rows.map((r) => toRecord(r.timestamp, r.sender, r.text));
  const added = append(groupName, records);

  return {
    group: groupName,
    via: "WhatsApp Web (loadEarlierMsgs)",
    since: since || "all",
    found: rows.length,
    added,
    pages: diag.pages,
    loaded: `${diag.startCount} → ${diag.endCount}`,
    stopped: diag.stopped,
    store: stats(groupName),
  };
}

// Pull history for every configured group. "connected" means this finished
// for all of them and the listener is up -- that is what the user sees as
// "WhatsApp is working".
async function syncAll() {
  if (state.status !== "ready") return;
  if (state.syncing) return;
  state.syncing = true;
  state.connected = false;
  const targets = [
    ["C5", state.watching.c5],
    ["C3", state.watching.c3],
  ].filter(([, g]) => g);
  const results = [];
  try {
    for (const [tag, g] of targets) {
      step(`Pulling history for ${tag} · ${g}${state.watching.since ? " since " + state.watching.since : ""}…`);
      try {
        const r = await backfill(g, { since: state.watching.since || undefined });
        results.push({ tag, group: g, ok: true, ...r });
        step(`${tag} · ${g}: ${r.found} messages${r.added ? ` (${r.added} new)` : ""} — ${r.store.first || "-"} → ${r.store.last || "-"}`);
      } catch (e) {
        results.push({ tag, group: g, ok: false, error: e.message });
        step(`${tag} · ${g}: history failed — ${e.message.slice(0, 80)}`, "error");
      }
    }
  } finally {
    state.syncing = false;
  }
  state.lastSync = { at: new Date().toISOString(), results };
  const allOk = results.length > 0 && results.every((r) => r.ok);
  state.connected = allOk;
  process.env.WA_CONNECTED = allOk ? "1" : "";
  if (allOk) {
    step(`Live — watching ${targets.map(([, g]) => g).join(", ")}. New messages appear automatically.`, "ok");
  } else if (results.length) {
    step("History incomplete — check the group names, then press Pull history", "error");
  }
  return results;
}

function setWatching(c5, c3, since) {
  if (typeof c5 === "string") state.watching.c5 = c5.trim();
  if (typeof c3 === "string") state.watching.c3 = c3.trim();
  if (typeof since === "string") state.watching.since = since.trim();
  // Keep the env in step -- the digest and rundown read it per request.
  process.env.C5_GROUP = state.watching.c5;
  process.env.C3_GROUP = state.watching.c3;
  saveWatched(state.watching);
  state.connected = false;
  // Saving groups while linked pulls their history straight away.
  if (state.status === "ready" && (state.watching.c5 || state.watching.c3)) {
    syncAll().catch(() => {});
  }
  return state.watching;
}

function snapshot() {
  return {
    status: state.status,
    phase: state.phase,
    steps: state.steps.slice(-14),
    connected: state.connected,
    syncing: state.syncing,
    lastSync: state.lastSync,
    error: state.error,
    startingFor: state.status === "starting" && state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : null,
    me: state.me,
    qr: state.qrDataUrl,
    qrAge: state.qrAt && state.status === "qr" ? Math.round((Date.now() - state.qrAt) / 1000) : null,
    groups: state.groups,
    watching: state.watching,
    claimedSession: Boolean(state.claimedSession),
    conflicts: state.reclaims || 0,
    eventsSeen: state.eventsSeen || 0,
    lastEvent: state.lastEvent || null,
    cleared: state.cleared || null,
    captured: state.captured,
    lastMessageAt: state.lastMessageAt,
    stores: {
      c5: state.watching.c5 ? stats(state.watching.c5) : null,
      c3: state.watching.c3 ? stats(state.watching.c3) : null,
    },
  };
}

// Close the browser as well as dropping the reference. Without destroy() the
// headless Chrome keeps the session profile locked and the next connect fails
// with "browser is already running".
function hardStop() {
  const c = client;
  client = null;
  clearTimeout(state.startTimer);
  clearInterval(state.claimTimer);
  clearInterval(state.authWatchdog);
  if (!c) return;
  Promise.resolve()
    .then(() => c.destroy())
    .catch(() => {});
}

// Wipe the stored session entirely. Needed when the saved credentials are
// damaged -- the symptom is "couldn't link device" on an otherwise valid scan.
function wipeSession() {
  clearStaleProfileLock();
  try {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// Returns immediately. The state is reset synchronously so the UI reflects
// "disconnected" at once; the browser teardown (which can take many seconds and
// occasionally hangs) runs in the background and can never block the caller.
function logout({ unlink = true, wipe = false, clearData = false } = {}) {
  clearTimeout(state.startTimer);
  clearInterval(state.claimTimer);
  clearInterval(state.authWatchdog);
  // Abort anything the connect flow might still be doing.
  state.abandoned = true;
  const c = client;
  client = null;

  // Full reset: a stale group list, capture counter or claim flag left behind
  // makes the UI look connected when it is not. Watched group names are kept
  // deliberately, so re-linking does not mean re-typing them.
  state.status = "idle";
  state.qrDataUrl = null;
  state.qrAt = null;
  state.me = null;
  state.groups = [];
  state.error = null;
  state.captured = 0;
  state.eventsSeen = 0;
  state.lastEvent = null;
  state.lastMessageAt = null;
  state.claimedSession = false;
  state.reclaimRestart = false;
  state.reclaims = 0;
  state.startedAt = null;
  state.connected = false;
  state.syncing = false;
  state.lastSync = null;
  clearInterval(state.authWatchdog);
  process.env.WA_LINKED = "";
  process.env.WA_CONNECTED = ""; // sample data may show again once unlinked
  step("Not connected");

  // Unlinking removes the captured messages AND the chosen groups -- both
  // belong to the account being disconnected.
  if (clearData) {
    state.cleared = clearAll();
    state.watching = { c5: "", c3: "", since: "" };
    process.env.C5_GROUP = "";
    process.env.C3_GROUP = "";
    saveWatched(state.watching);
  }

  // Background teardown -- never awaited, so the HTTP response is instant.
  (async () => {
    const withTimeout = (fn, ms) => Promise.race([Promise.resolve().then(fn).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
    if (c) {
      if (unlink) await withTimeout(() => c.logout(), 6000);
      await withTimeout(() => c.destroy(), 6000);
    }
    if (wipe) wipeSession();
    clearStaleProfileLock(); // belt-and-braces: release the profile lock
  })().catch(() => {});
}

// The same linked session sends the digest, so the owner scans one QR, not two.
async function send(text, target) {
  if (state.status !== "ready" || !client) throw new Error("WhatsApp is not connected — link it on the WhatsApp tab first");

  let to;
  const t = (target || process.env.DIGEST_TARGET || "").trim();
  if (!t) {
    to = client.info.wid._serialized; // the linked account's own chat
  } else if (/^\d{8,15}$/.test(t)) {
    const id = await client.getNumberId(t);
    if (!id) throw new Error(`${t} is not on WhatsApp`);
    to = id._serialized;
  } else {
    const chats = await client.getChats();
    const chat = chats.find((c) => c.name?.toLowerCase() === t.toLowerCase());
    if (!chat) throw new Error(`No chat named "${t}"`);
    to = chat.id._serialized;
  }

  // WhatsApp truncates very long messages; split on block boundaries.
  const parts = [];
  let buf = "";
  for (const block of String(text).split("\n\n\n")) {
    if (buf && (buf + "\n\n\n" + block).length > 3500) { parts.push(buf); buf = block; }
    else buf = buf ? `${buf}\n\n\n${block}` : block;
  }
  if (buf) parts.push(buf);

  for (const p of parts) await client.sendMessage(to, p);
  return { to, parts: parts.length };
}

// Diagnostic: what does the injected page actually expose?
// whatsapp-web.js's getChats() issues a keyless IndexedDB query that current
// WhatsApp Web builds reject. The same data is sitting in the local database,
// so read it directly: "group-metadata" holds every group's id, subject and size.
async function groupsFromIDB() {
  return client.pupPage.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("model-storage");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    try {
      if (!Array.from(db.objectStoreNames).includes("group-metadata")) return [];
      const rows = await new Promise((res, rej) => {
        const rq = db.transaction("group-metadata", "readonly").objectStore("group-metadata").getAll();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      return rows
        .filter((r) => r && r.id && String(r.id).endsWith("@g.us") && !r.terminated)
        .map((r) => ({ id: String(r.id), name: r.subject || String(r.id), participants: r.size || null }));
    } finally {
      db.close();
    }
  });
}

// History comes from WhatsApp Web's own local database rather than the library's
// fetchMessages, which depends on the same broken chat-list path. Message ids
// are shaped "<fromMe>_<chatId>_<msgId>", so the chat is filterable directly,
// and "t" is a unix timestamp so a date floor is a simple comparison.
//
// Caveat: this returns what the browser has synced, which is not necessarily the
// group's entire lifetime.
async function historyFromIDB(chatId, sinceUnix) {
  return client.pupPage.evaluate(
    async (chatId, sinceUnix) => {
      const open = () => new Promise((res, rej) => {
        const r = indexedDB.open("model-storage");
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const db = await open();
      try {
        const names = new Map();
        if (Array.from(db.objectStoreNames).includes("contact")) {
          const contacts = await new Promise((res, rej) => {
            const rq = db.transaction("contact", "readonly").objectStore("contact").getAll();
            rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
          });
          for (const c of contacts) {
            const nm = c.name || c.pushname || c.notify || c.verifiedName || c.formattedName;
            if (c.id && nm) names.set(String(c.id), nm);
          }
        }

        const out = [];
        await new Promise((res, rej) => {
          const rq = db.transaction("message", "readonly").objectStore("message").openCursor();
          rq.onsuccess = (e) => {
            const cur = e.target.result;
            if (!cur) return res();
            const m = cur.value;
            const parts = String(m.id || "").split("_");
            if (parts[1] === chatId && m.t >= sinceUnix) {
              const body = m.body || m.caption || "";
              if (body && (m.type === "chat" || m.type === "image" || m.type === "video" || m.type === "document")) {
                const who = String(m.author || m.from || "");
                out.push({ t: m.t, sender: names.get(who) || who.split("@")[0] || "unknown", body });
              }
            }
            cur.continue();
          };
          rq.onerror = () => rej(rq.error);
        });
        return out.sort((a, b) => a.t - b.t);
      } finally {
        db.close();
      }
    },
    chatId,
    sinceUnix
  );
}

async function whichVersion() {
  try {
    return await client.getWWebVersion();
  } catch (e) {
    return `unknown (${e.message})`;
  }
}

// WhatsApp Web allows one active session per browser profile. When another
// window (or a previous instance) holds it, this page parks on a "Use here"
// dialog and the whole app stays inert -- no chat store, no UI, and every
// library call fails with an opaque IndexedDB error. Claiming the session fixes
// all of it, so it is checked on connect and rechecked periodically.
async function claimSession() {
  try {
    const claimed = await client.pupPage.evaluate((loaded) => {
      const els = Array.from(document.querySelectorAll("button, div[role='button'], a"));
      const byText = (words) =>
        els.find((e) => words.includes((e.innerText || "").trim().toLowerCase()));

      // The library's takeoverOnConflict does not win on this WhatsApp Web
      // build; the only connects that ever reached Live were the ones where we
      // clicked "Use here" ourselves. So click it -- but exactly ONCE per
      // connect (the click reloads the page, which is handled by a single
      // deliberate restart below). Repeated clicking is what used to thrash.
      const useHere = byText(["use here", "usar aquí", "utiliser ici"]);
      if (useHere) {
        if (!window.__useHereClicked) {
          window.__useHereClicked = true;
          useHere.click();
          return "clicked";
        }
        return true;
      }

      // Dismiss a blocking dialog only while the app is still coming up --
      // clicking these repeatedly once loaded interferes with the UI.
      if (!loaded) {
        const dismiss = byText(["continue", "ok", "got it", "not now", "later", "close"]);
        if (dismiss && document.querySelector("[role='dialog']")) dismiss.click();
      }
      return false;
    }, state.status === "ready");
    if (claimed) {
      // Do not clear state.error here -- it hides why a start failed.
      // The app reloads after the claim before anything is readable.
      await new Promise((r) => setTimeout(r, 6000));
    }
    return claimed;
  } catch {
    return false;
  }
}

// The "Use here" dialog blocks the app from loading, so "ready" never fires
// while it is up. The claim has to run from the moment the browser is alive,
// not after ready.
function startClaimLoop(intervalMs) {
  clearInterval(state.claimTimer);
  state.claimTimer = setInterval(async () => {
    if (state.abandoned) return clearInterval(state.claimTimer);
    if (!client || !client.pupPage) return;
    try {
      const seen = await claimSession();
      if (!seen) { state.conflictStreak = 0; return; }

      state.claimedSession = true;
      state.reclaims = (state.reclaims || 0) + 1;

      // We just took the session; the page is reloading under initialize().
      // Restart once, now, rather than waiting for the library's internal wait
      // (~75s) to time out. This is the exact path that produced every
      // successful connect, made deterministic and capped at one.
      if (seen === "clicked" && !state.reclaimRestart) {
        state.reclaimRestart = true;
        step("Took the session from another WhatsApp client — restarting once", "warn");
        clearInterval(state.claimTimer);
        hardStop();
        state.status = "starting";
        state.error = null;
        setTimeout(() => start(), 2500);
        return;
      }
      // Once Live, the dialog is background noise handled by the library; it
      // must not overwrite the "Live — watching …" banner.
      if (!state.connected) step("Another WhatsApp Web window had the session — taking it back", "warn");

      // A conflict that persists for ~30s during start-up is not going to
      // resolve itself: another client (WhatsApp Desktop, or a web.whatsapp.com
      // tab) is holding the account. Fail fast with the exact fix instead of
      // grinding for three minutes.
      state.conflictStreak = (state.conflictStreak || 0) + 1;
      if (!state.connected && state.status !== "ready" && state.conflictStreak >= 8) {
        clearInterval(state.claimTimer);
        clearInterval(state.authWatchdog);
        state.status = "error";
        state.abandoned = true; // stop every other recovery path
        state.error =
          "Another WhatsApp client is holding this account — usually the WhatsApp Desktop app (quit it from the Dock), or web.whatsapp.com open in another browser. Quit it, then press Connect.";
        step(state.error, "error");
        hardStop();
      }
    } catch {
      /* page not ready yet */
    }
  }, intervalMs);
}

// Reading history off the rendered page. The library's chat layer is broken on
// current WhatsApp Web builds (keyless IndexedDB query), but the app itself
// works fine -- and every message bubble carries
//   data-pre-plain-text="[HH:MM, DD/MM/YYYY] Sender Name: "
// which is exactly the shape the export parser already understands.
async function openChat(name) {
  const page = client.pupPage;

  // The "What's new" modal blocks the search box; it needs a moment to unmount.
  await page.evaluate(() => {
    const d = document.querySelector("[role='dialog']");
    if (!d) return;
    const go =
      Array.from(d.querySelectorAll("button, div[role='button']")).find((b) =>
        ["continue", "ok", "got it", "not now", "later"].includes((b.innerText || "").trim().toLowerCase())
      ) || d.querySelector("button[aria-label='Close']");
    if (go) go.click();
  });
  await new Promise((r) => setTimeout(r, 2000));

  return page.evaluate(async (chatName) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Titles in the DOM carry invisible direction marks and stray spaces, so an
    // exact string comparison against the stored group name misses.
    const norm = (t) => String(t || "").replace(/[\u200e\u200f\u202a-\u202e]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    const want = norm(chatName);

    const clickRow = async () => {
      const spans = Array.from(document.querySelectorAll("span[title]"));
      const span =
        spans.find((s) => norm(s.getAttribute("title")) === want) ||
        spans.find((s) => norm(s.getAttribute("title")).includes(want)) ||
        spans.find((s) => want.includes(norm(s.getAttribute("title"))) && norm(s.getAttribute("title")).length > 6);
      if (!span) return false;
      const row = span.closest('div[role="row"]') || span.closest('div[role="listitem"]') || span;
      const cell = row.querySelector('div[role="gridcell"]') || row;
      cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      cell.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      cell.click();
      await sleep(400);
      return true; // found and clicked; loading is awaited once, below
    };

    // Waiting for bubbles belongs here, not inside clickRow -- the scroll loop
    // calls clickRow dozens of times, and a per-probe wait blew the protocol
    // timeout (60 probes x 6.4s).
    const waitForMessages = async () => {
      for (let i = 0; i < 20; i++) {
        if (document.querySelector("#main [data-pre-plain-text]")) return true;
        await sleep(500);
      }
      return Boolean(document.querySelector("#main"));
    };

    // Search is a React-controlled <input>: assigning .value directly does not
    // notify React, so the native setter plus an input event is required.
    const input =
      document.querySelector('input[aria-label="Search or start a new chat"]') ||
      document.querySelector('input[role="textbox"]') ||
      document.querySelector("#pane-side input") ||
      document.querySelector("input");

    if (input) {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(300);
      setter.call(input, chatName);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(3000);
      if (await clickRow()) { const ready = await waitForMessages(); return { ok: true, via: "search input", messagesRendered: ready }; }
    }

    // Fallback: walk the whole (virtualised) list.
    const pane = document.querySelector("#pane-side");
    if (pane) {
      if (input) {
        const setter2 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter2.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(1200);
      }
      pane.scrollTop = 0;
      await sleep(400);
      const step = Math.max(200, pane.clientHeight - 60);
      // Bounded: a full walk of a 67k-pixel list outruns the protocol timeout.
      const maxSteps = 60;
      for (let i = 0; i < maxSteps; i++) {
        if (await clickRow()) { const ready = await waitForMessages(); return { ok: true, via: `list scroll step ${i}`, messagesRendered: ready }; }
        pane.scrollTop = i * step;
        await sleep(150);
      }
    }

    return {
      ok: false,
      hadSearchInput: Boolean(input),
      dialogStillUp: Boolean(document.querySelector("[role='dialog']")),
      lookingFor: want,
      titlesSeen: Array.from(document.querySelectorAll("span[title]")).slice(0, 12).map((s) => norm(s.getAttribute("title"))),
    };
  }, name);
}

// Scroll the conversation up until it reaches the date floor or stops growing.
async function scrapeHistory(name, sinceDate, { maxScrolls = 60 } = {}) {
  const page = client.pupPage;
  const opened = await openChat(name);
  if (!opened.ok) {
    throw new Error(
      `Could not open "${name}" in WhatsApp Web` +
        (opened.dialogStillUp ? " (a dialog is blocking the UI)" : "") +
        (opened.hadSearchInput === false ? " (no search input found)" : "") +
        (opened.titlesSeen ? ` — saw: ${opened.titlesSeen.slice(0, 5).join(", ")}` : "")
    );
  }

  return page.evaluate(
    async (sinceDate, maxScrolls) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const pane = document.querySelector("#main div.copyable-area [tabindex]") ||
        document.querySelector("#main [data-tab='8']") ||
        (document.querySelector("[data-pre-plain-text]") || {}).closest?.("div[tabindex]") ||
        document.querySelector("#main");

      const scroller = (() => {
        let el = document.querySelector("[data-pre-plain-text]");
        while (el && el !== document.body) {
          if (el.scrollHeight > el.clientHeight + 50) return el;
          el = el.parentElement;
        }
        return pane;
      })();

      const collect = () =>
        Array.from(document.querySelectorAll("[data-pre-plain-text]")).map((el) => ({
          pre: el.getAttribute("data-pre-plain-text"),
          text: (el.innerText || "").trim(),
        }));

      let seen = 0;
      for (let i = 0; i < maxScrolls; i++) {
        const rows = collect();
        if (rows.length === seen && i > 2) break;
        seen = rows.length;

        // Stop once the oldest loaded message is before the floor.
        if (sinceDate && rows.length) {
          const m = (rows[0].pre || "").match(/\[(\d{1,2}):(\d{2})[^,]*,\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\]/);
          if (m) {
            const yr = m[5].length === 2 ? "20" + m[5] : m[5];
            const iso = `${yr}-${String(m[4]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
            if (iso < sinceDate) break;
          }
        }
        if (scroller) scroller.scrollTop = 0;
        await sleep(700);
      }
      return collect();
    },
    sinceDate || "",
    maxScrolls
  );
}

// History via WhatsApp Web's own internal modules.
//
// whatsapp-web.js 1.34.7 is broken here in two independent places on current
// builds: WWebJS.getChat() falls through to findOrCreateLatestChat() (keyless
// IndexedDB query -> DataError), and fetchMessages() paginates with the
// retired loadEarlierMsgs(). Both are bypassed:
//   Chat.get(wid)                      resolve the chat without the bad fallback
//   msgFindByDirection / msgFindBefore page backwards through local messages
//   WWebJS.getMessageModel(model)      decrypt to plaintext
//
// Returns what this client has synced locally, which is not necessarily the
// group's entire lifetime.
// History, working, via WhatsApp Web's own loader.
//
// whatsapp-web.js 1.34.7 cannot do this on current builds: getChat() falls
// through to findOrCreateLatestChat() (keyless IndexedDB query -> DataError).
// But the pieces underneath are fine:
//   Chat.get(wid)                    resolve the chat, skipping the bad fallback
//   loadEarlierMsgs({chat})          hydrate + DECRYPT older messages into chat.msgs
//   WWebJS.getMessageModel(model)    read plaintext
//
// Note msgFindByDirection() also works but only returns persisted rows, whose
// bodies are encrypted at rest -- it finds messages without decrypting them.
// loadEarlierMsgs is the hydration step that actually yields text.
//
// Returns what this client has synced locally, not necessarily the group's
// entire lifetime.
// History, paginated FROM NODE. Each evaluate does exactly one loadEarlierMsgs
// and returns lightweight counts, so no single in-page call runs long enough to
// trip the protocol timeout or blow up on a busy group (the C3 crash). The final
// extraction is chunked for the same reason.
async function historySince(chatId, sinceUnix, maxMessages = 50000) {
  const page = client.pupPage;

  try { await page.evaluate((me) => { window.__waMe = me; }, state.me || "You"); } catch { /* ignore */ }
  const setup = await page.evaluate((chatId) => {
    const W = window;
    const C = W.require("WAWebCollections");
    const WF = W.require("WAWebWidFactory");
    const chat = C.Chat.get(WF.createWid(chatId));
    if (!chat) return { ok: false };
    const m = typeof chat.msgs?.getModelsArray === "function" ? chat.msgs.getModelsArray() : [];
    return { ok: true, count: m.length, oldest: m.length ? Math.min(...m.map((x) => x.t || Infinity)) : null };
  }, chatId);
  if (!setup.ok) throw new Error(`Chat ${chatId} not loaded in WhatsApp Web`);

  const diag = { pages: 0, startCount: setup.count, stopped: null };
  let prev = -1;

  for (let page_i = 0; page_i < 400; page_i++) {
    // One page per evaluate: fast, and a crash here loses only this batch.
    let r;
    try {
      r = await page.evaluate(async (chatId) => {
        const W = window;
        const C = W.require("WAWebCollections");
        const WF = W.require("WAWebWidFactory");
        const Load = W.require("WAWebChatLoadMessages");
        const chat = C.Chat.get(WF.createWid(chatId));
        const before = chat.msgs.getModelsArray().length;
        let n = 0;
        try {
          const batch = await Load.loadEarlierMsgs({ chat });
          n = Array.isArray(batch) ? batch.length : 0;
        } catch (e) {
          return { count: chat.msgs.getModelsArray().length, added: 0, err: String((e && e.message) || e).slice(0, 60) };
        }
        const m = chat.msgs.getModelsArray();
        return { count: m.length, added: m.length - before, batch: n, oldest: m.length ? Math.min(...m.map((x) => x.t || Infinity)) : null };
      }, chatId);
    } catch (e) {
      diag.stopped = `page error: ${String((e && e.message) || e).slice(0, 60)}`;
      break;
    }
    diag.pages++;
    if (r.err) { diag.stopped = `loader: ${r.err}`; break; }
    if (r.count === prev || r.added === 0 || r.batch === 0) { diag.stopped = "no older messages"; break; }
    prev = r.count;
    if (sinceUnix && r.oldest && r.oldest < sinceUnix) { diag.stopped = "reached since-date"; break; }
    if (r.count >= maxMessages) { diag.stopped = "hit maxMessages"; break; }
    await new Promise((res) => setTimeout(res, 60));
  }
  if (!diag.stopped) diag.stopped = "page cap (400 pages) — older history still on the phone";

  // Extract in chunks so a large collection never serialises in one shot.
  const total = await page.evaluate((chatId) => {
    const C = window.require("WAWebCollections"), WF = window.require("WAWebWidFactory");
    return C.Chat.get(WF.createWid(chatId)).msgs.getModelsArray().length;
  }, chatId);
  diag.endCount = total;

  const rows = [];
  const CHUNK = 400;
  for (let off = 0; off < total; off += CHUNK) {
    const part = await page.evaluate((chatId, off, CHUNK, sinceUnix) => {
      const W = window;
      const C = W.require("WAWebCollections");
      const WF = W.require("WAWebWidFactory");
      const all = C.Chat.get(WF.createWid(chatId)).msgs.getModelsArray().slice().sort((a, b) => a.t - b.t);
      const out = [];
      for (const m of all.slice(off, off + CHUNK)) {
        if (m.isNotification) continue;
        if (sinceUnix && !(typeof m.t === "number" && m.t >= sinceUnix)) continue;
        let x; try { x = W.WWebJS.getMessageModel(m); } catch { continue; }
        const text = x.body || x.caption || "";
        if (!text) continue;
        out.push({
          timestamp: Number(x.t || 0),
          sender: x.id?.fromMe ? (window.__waMe || "You")
            : (x._data?.notifyName || x.notifyName || String(x.author || x.from || "").split("@")[0] || "unknown"),
          text: String(text),
        });
      }
      return out;
    }, chatId, off, CHUNK, sinceUnix);
    rows.push(...part);
  }

  rows.sort((a, b) => a.timestamp - b.timestamp);
  return { rows, diag };
}

// Does any loader actually hydrate// Does any loader actually hydrate// Does any loader actually hydrate decrypted messages into chat.msgs?
async function tryHydrate(chatId) {
  return client.pupPage.evaluate(async (chatId) => {
    const W = window;
    const C = W.require("WAWebCollections");
    const WF = W.require("WAWebWidFactory");
    const Load = W.require("WAWebChatLoadMessages");
    const chat = C.Chat.get(WF.createWid(chatId));
    if (!chat) return { error: "chat not in collection" };

    const snap = () => {
      const m = typeof chat.msgs?.getModelsArray === "function" ? chat.msgs.getModelsArray() : [];
      return { count: m.length, withBody: m.filter((x) => x.body).length };
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { before: snap(), attempts: {} };

    const attempt = async (label, fn) => {
      try {
        const r = await fn();
        await sleep(2500);
        out.attempts[label] = { ok: true, returned: Array.isArray(r) ? `array(${r.length})` : typeof r, after: snap() };
      } catch (e) {
        out.attempts[label] = { ok: false, error: String((e && e.message) || e).slice(0, 120), after: snap() };
      }
    };

    await attempt("loadRecentMsgs({chat})", () => Load.loadRecentMsgs({ chat }));
    await attempt("loadEarlierMsgs({chat})", () => Load.loadEarlierMsgs({ chat }));
    await attempt("loadRecentMsgs(chat)", () => Load.loadRecentMsgs(chat));
    await attempt("chat.loadEarlierMsgs()", () => (typeof chat.loadEarlierMsgs === "function" ? chat.loadEarlierMsgs() : Promise.reject(new Error("not a function"))));

    const models = typeof chat.msgs?.getModelsArray === "function" ? chat.msgs.getModelsArray() : [];
    out.final = snap();
    out.sample = models.filter((m) => m.body).slice(-3).map((m) => ({ t: m.t, body: String(m.body).slice(0, 45) }));
    return out;
  }, chatId);
}

// Inventory of WhatsApp's internal modules, to find the hydration/open API.
async function probeModules() {
  return client.pupPage.evaluate(() => {
    const out = {};
    const names = [
      "WAWebCmd", "WAWebMsgCollection", "WAWebChatLoadMessages", "WAWebChatOpenAction",
      "WAWebDBMessageFindLocal", "WAWebCollections",
    ];
    for (const n of names) {
      try {
        const m = window.require(n);
        out[n] = {
          ok: true,
          fns: Object.entries(m)
            .filter(([, v]) => typeof v === "function")
            .map(([k, v]) => ({ name: k, arity: v.length })),
          other: Object.entries(m).filter(([, v]) => typeof v !== "function").map(([k]) => k).slice(0, 20),
        };
      } catch (e) {
        out[n] = { ok: false, error: (e && e.message) || String(e) };
      }
    }
    // The two sources ChatGPT specifically asked for.
    try {
      const Cmd = window.require("WAWebCmd");
      out.openChatSource = Cmd.openChat ? String(Cmd.openChat).slice(0, 700) : "openChat NOT PRESENT";
      out.cmdMatching = Object.keys(Cmd).filter((k) => /chat|conversation|open|navigate|route/i.test(k));
    } catch (e) {
      out.openChatSource = `WAWebCmd failed: ${e.message}`;
    }
    return out;
  });
}

// After opening a chat: did WhatsApp actually load decrypted models for it?
async function inspectAfterOpen(chatId) {
  return client.pupPage.evaluate((chatId) => {
    const W = window;
    const C = W.require("WAWebCollections");
    const WF = W.require("WAWebWidFactory");
    const chat = C.Chat.get(WF.createWid(chatId));
    const out = {
      chatFound: Boolean(chat),
      mainPresent: Boolean(document.querySelector("#main")),
      bubbles: document.querySelectorAll("[data-pre-plain-text]").length,
      msgCollectionTotal: typeof C.Msg.getModelsArray === "function" ? C.Msg.getModelsArray().length : null,
    };
    if (chat && typeof chat.msgs?.getModelsArray === "function") {
      const models = chat.msgs.getModelsArray();
      out.chatMsgCount = models.length;
      out.withBody = models.filter((m) => m.body).length;
      out.sample = models.slice(-3).map((m) => {
        let x = null;
        try { x = W.WWebJS.getMessageModel(m); } catch { /* ignore */ }
        return { t: m.t, rawBody: String(m.body || "").slice(0, 30), modelBody: String((x && x.body) || "").slice(0, 30) };
      });
    }
    return out;
  }, chatId);
}

async function diagnoseHistoryInternals(chatId) {
  return client.pupPage.evaluate(async (chatId) => {
    const W = window;
    const out = { chatId, hasRequire: typeof W.require === "function", hasWWebJS: Boolean(W.WWebJS), modules: {} };
    if (!out.hasRequire) {
      out.error = "window.require unavailable";
      return out;
    }
    const get = (name) => {
      try {
        const m = W.require(name);
        out.modules[name] = { ok: Boolean(m), keys: m ? Object.keys(m).slice(0, 25) : [] };
        return m;
      } catch (e) {
        out.modules[name] = { ok: false, error: (e && e.message) || String(e) };
        return null;
      }
    };
    const Collections = get("WAWebCollections");
    const WidFactory = get("WAWebWidFactory");
    get("WAWebFindChatAction");
    const FindLocal = get("WAWebDBMessageFindLocal");
    const MsgKey = get("WAWebMsgKey");

    if (Collections && Collections.Chat && WidFactory) {
      try {
        const wid = WidFactory.createWid(chatId);
        const chat = Collections.Chat.get(wid);
        out.chatFound = Boolean(chat);
        if (chat) {
          out.chatSummary = {
            id: (chat.id && (chat.id._serialized || String(chat.id))) || null,
            title: chat.formattedTitle || chat.name || null,
            hasMsgs: Boolean(chat.msgs),
            msgCount: typeof chat.msgs?.getModelsArray === "function" ? chat.msgs.getModelsArray().length : null,
            lastReceivedKey: chat.lastReceivedKey?._serialized || null,
          };
        }
      } catch (e) {
        out.chatLookupError = (e && e.message) || String(e);
      }
    }

    out.canFindBefore = Boolean(
      FindLocal && (typeof FindLocal.msgFindByDirection === "function" || typeof FindLocal.msgFindBefore === "function")
    );
    out.findLocalFns = FindLocal ? Object.keys(FindLocal).filter((k) => /find/i.test(k)).slice(0, 15) : [];
    out.msgKeyFromString = Boolean(MsgKey && typeof MsgKey.fromString === "function");
    out.msgCollection = Collections?.Msg ? (typeof Collections.Msg.getModelsArray === "function" ? Collections.Msg.getModelsArray().length : "no getModelsArray") : "no Msg";
    return out;
  }, chatId);
}

// WhatsApp's own "Export chat" is the only complete, reliable history source:
// the library's chat layer is broken against current WhatsApp Web builds, and
// message text is encrypted at rest in the browser's local database. An export
// is parsed with exactly the same parser as the sample files.
function importExport(groupName, text, { since } = {}) {
  const { parseChatText } = require("./chatlog");
  const parsed = parseChatText(text);
  const rows = since ? parsed.filter((m) => m.date >= since) : parsed;
  const records = rows.map((m) => ({ ...m, live: true }));
  const added = append(groupName, records);
  return { group: groupName, parsed: parsed.length, kept: rows.length, added, store: stats(groupName) };
}

// Exposed so history can open the chat first -- WhatsApp only decrypts a
// chat's messages into memory once that conversation is opened.
async function openChatByName(name) {
  try {
    return await openChat(name);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = { start, snapshot, backfill, syncAll, probeModules, tryHydrate, diagnoseHistoryInternals, historySince, openChatByName, inspectAfterOpen, setWatching, logout, send, refreshGroups, importExport, clearStaleProfileLock, wipeSession };
