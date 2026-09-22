require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const QR = require("qrcode");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { append, upsert, stats, toRecord, clearAll } = require("./livestore");

const PROFILE_DIR = path.join(process.env.WWEBJS_PATH || path.join(__dirname, "..", ".wwebjs_auth"), "session-monitor");

// One budget for every startup clock. A shared-CPU container needs minutes,
// not the 30s defaults.
const LAUNCH_MS = Number(process.env.LAUNCH_TIMEOUT_MS || 240_000);

// After a Chromium crash the client object survives but its page is a corpse;
// every call then fails with "detached Frame" / "Target closed". These helpers
// tell a dead page apart from a genuine data problem.
const DEAD_PAGE = /detached Frame|Target closed|Session closed|Execution context was destroyed|Protocol error|Most likely the page has been closed/i;

const { createSupervisor } = require("./wa-supervisor");

// Connect / Unlink / Force reset are the primary feature: they have to work
// on the 1200th press as reliably as the first. The reason they did not is
// that every one of them leaves asynchronous work behind -- a destroy(), a
// logout(), and a pkill -9 on the profile directory that lands up to twelve
// seconds later. Press Connect inside that window and the PREVIOUS unlink's
// cleanup kills the browser the new one just launched, which is the SIGKILL
// that preceded "Cannot read properties of null (reading 'Socket')".
//
// So every lifecycle operation takes a generation. Work scheduled by an
// operation checks whether it is still the current one before touching
// anything shared; the moment a newer operation starts, the older one's
// pending teardown becomes inert instead of destructive.
let generation = 0;
const bumpGeneration = () => ++generation;
const isCurrent = (gen) => gen === generation;

// One arbiter for every teardown in this file. Watchdogs report to it; it
// alone decides. See src/wa-supervisor.js for why.
const supervisor = createSupervisor();

// The only sanctioned way to restart the browser. `force` is for callers who
// know the page is already dead (a crash), where the "don't interrupt a scan"
// guard cannot apply but the circuit breaker still must.
function relaunch(reason, { force = false, delay = 3000, fresh = false } = {}) {
  const decision = supervisor.requestRestart(reason, { force });
  if (!decision.allow) {
    // Refusals are the interesting case -- surface them rather than failing
    // silently the way the old competing watchdogs did.
    if (decision.tripped) {
      state.status = "error";
      state.error = decision.reason;
      step(decision.reason, "error");
    } else {
      console.log(`  [wa] restart refused (${reason}): ${decision.reason}`);
    }
    return false;
  }
  hardStop();
  state.status = "starting";
  state.error = null;
  setTimeout(() => start({ fresh }), delay);
  return true;
}

async function pageUsable() {
  try {
    if (!client || !client.pupPage || client.pupPage.isClosed()) return false;
    await client.pupPage.evaluate(() => 1);
    return true;
  } catch {
    return false;
  }
}

// Is the QR still on screen? WhatsApp stops rotating the code the moment a
// phone scans it, so "stale" and "scanned" look identical from the qr event
// alone. The DOM tells them apart: whatsapp-web.js reads the code out of
// div[data-ref], and that element is gone once the handshake starts.
// Returns true (still waiting), false (scanned), or null (cannot tell).
async function qrOnScreen() {
  try {
    if (!client || !client.pupPage || client.pupPage.isClosed()) return null;
    return await client.pupPage.evaluate(() => {
      const el = document.querySelector("div[data-ref]");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  } catch {
    return null; // page is wedged; the caller should restart
  }
}

// cgroup v2 memory accounting -- the only reliable way to tell an OOM kill
// apart from a slow start inside a container.
function containerMemory() {
  const read = (f) => {
    try {
      return fs.readFileSync(f, "utf8").trim();
    } catch {
      return null;
    }
  };
  const current = read("/sys/fs/cgroup/memory.current");
  if (!current) return null; // not in a cgroup v2 container (e.g. macOS)
  const events = read("/sys/fs/cgroup/memory.events") || "";
  const oomKill = (events.match(/oom_kill (\d+)/) || [])[1] || "0";
  const mb = (v) => (v && /^\d+$/.test(v) ? Math.round(Number(v) / 1048576) + "MB" : v);
  return { used: mb(current), limit: mb(read("/sys/fs/cgroup/memory.max")), oomKill };
}
const WATCH_FILE = path.join(__dirname, "..", "data", "watched-groups.json");

// Ceiling on a single group's history pull. Whatever it has managed to capture
// by then is already written to the store, so a timeout costs progress, never
// data -- and it guarantees state.syncing clears.
const PULL_TIMEOUT_MS = Number(process.env.PULL_TIMEOUT_MS || 120_000);

// Whether an account is linked is OUR fact, not something to infer from disk.
// It used to be read as "the chromium profile directory exists", but simply
// showing a QR creates that directory -- and its whatsapp IndexedDB -- so the
// app decided it was linked with nobody logged in, and served "saved WhatsApp
// data" instead of the owner's exports after a reset. This flag is written when a
// session actually authenticates and removed when it is torn down.
const LINKED_FLAG = path.join(__dirname, "..", "data", "linked.flag");
function markLinked(on) {
  try {
    if (on) { fs.mkdirSync(path.dirname(LINKED_FLAG), { recursive: true }); fs.writeFileSync(LINKED_FLAG, new Date().toISOString()); }
    else fs.rmSync(LINKED_FLAG, { force: true });
  } catch { /* best effort: the env var is still authoritative in-process */ }
  process.env.WA_LINKED = on ? "1" : "";
}
function wasLinked() {
  try { return fs.existsSync(LINKED_FLAG); } catch { return false; }
}

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
  // Match only Chrome's own --user-data-dir flag ("--" so pkill does not read
  // the pattern as an option). SIGKILL: a soft TERM left 8 helper processes
  // alive and holding the profile lock, which hung the next launch at
  // "Launching WhatsApp Web…" indefinitely. Then wait until they are gone.
  const pattern = `--user-data-dir=${PROFILE_DIR}`;
  const count = () => {
    try {
      return execFileSync("pgrep", ["-f", "--", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  if (count() > 0) {
    try { execFileSync("pkill", ["-9", "-f", "--", pattern], { stdio: "ignore" }); } catch { /* gone */ }
    // Wait (max ~2s) for the kernel to reap them. This blocks deliberately --
    // the next launch must not start while the profile is still held -- but it
    // blocks Node's event loop too, so it must be cheap. Spawning /bin/sleep
    // twenty times per call was not: under repeated Connect/Reset presses the
    // spawns queued every other request behind them and pushed responses past
    // seven seconds. Atomics.wait sleeps the thread without spawning anything.
    const nap = (() => {
      const sab = new Int32Array(new SharedArrayBuffer(4));
      return (ms) => { try { Atomics.wait(sab, 0, 0, ms); } catch { /* fall through */ } };
    })();
    const deadline = Date.now() + 2000;
    while (count() > 0 && Date.now() < deadline) nap(100);
    cleared.push(count() === 0 ? "orphaned chrome" : "orphaned chrome (some survived)");
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

function start({ fresh = false, phone } = {}) {
  if (state.syncing) { step("Ignoring restart during history pull", "warn"); return state; }
  supervisor.event("launch");

  // Link with a phone number instead of a QR -- for someone with only the
  // phone, who cannot scan a code shown on that same screen. Chosen by a fresh
  // Connect, and kept for any restart during the same attempt so a crash does
  // not silently fall back to a QR they have no way to scan.
  if (fresh) {
    const digits = String(phone || "").replace(/\D/g, "");
    state.pairPhone = digits.length >= 8 && digits.length <= 15 ? digits : "";
    state.pairingCode = null;
    state.codeAt = null;
  }

  // Already sitting on an unscanned QR? That IS a fresh, unlinked session and
  // WhatsApp rotates the code every ~20s anyway. Reuse it instead of paying the
  // full Chrome boot again (~60s on a free-tier container).
  if (fresh && !state.pairPhone && state.status === "qr" && state.qrDataUrl && client) {
    step("QR already active — scan it now");
    return state;
  }

  // "Connect" always means a clean link: tear down any live client, hard-kill
  // every leftover Chrome, and drop the stored login so WhatsApp issues a NEW
  // QR rather than silently resuming an old session.
  if (fresh) {
    // An operator pressing Connect has waited out any lockout and is entitled
    // to a clean slate, including the restart circuit breaker.
    supervisor.reset();
    state.crashes = 0;      // deliberate teardowns are not crashes
    state.reloadedOnce = false;
    state.reloadTried = false;
    const fgen = bumpGeneration();
    if (client) {
      const c = client; client = null;
      // Guarded for the same reason as logout's: this resolves seconds later.
      Promise.resolve().then(() => c.destroy()).catch(() => {}).then(() => {
        if (isCurrent(fgen)) clearStaleProfileLock();
      });
    }
    clearTimeout(state.startTimer);
    clearInterval(state.claimTimer);
    clearInterval(state.authWatchdog);
    state.abandoned = true;
    clearStaleProfileLock();
    wipeSession();
    state.status = "idle";
    state.qrDataUrl = null;
    state.me = null;
    state.groups = [];
    state.connected = false;
    state.claimedSession = false;
    state.conflictStreak = 0;
    state.reclaimRestart = false;
    markLinked(false);
    process.env.WA_CONNECTED = "";
    state.steps = [];
    step("Cleared previous session — requesting a new QR…");
  }

  if (client) return state;
  // Anything left over from a previous run would block the launch.
  clearStaleProfileLock();
  state.status = "starting";
  state.error = null;
  state.connected = false;
  state.abandoned = false;
  state.conflictStreak = 0;
  state.startedAt = Date.now();
  // A session that genuinely authenticated before means this account is linked
  // even while it is still loading, so the sample must not flash on screen
  // meanwhile. A profile directory on its own proves nothing -- showing a QR
  // creates one.
  if (wasLinked()) process.env.WA_LINKED = "1";
  state.abandoned = false;
  step("Launching WhatsApp Web…");

  // A start that never reaches "qr" or "ready" would otherwise sit on
  // "starting" forever with nothing to act on.
  clearTimeout(state.startTimer);
  // A shared-CPU free-tier container boots Chrome far slower than a laptop, so
  // this is generous. LAUNCH_TIMEOUT_MS can override.
  const launchTimeout = LAUNCH_MS;
  state.startTimer = setTimeout(() => {
    if (state.status === "starting") {
      state.status = "error";
      state.error =
        `Chrome did not start within ${Math.round(launchTimeout / 1000)}s. On a free-tier container this usually means it ran out of memory — check the host logs, then press Connect again.`;
      step(state.error, "error");
      hardStop();
    }
  }, launchTimeout);

  // A remote webVersionCache was tried to work around the broken chat layer; it
  // had no effect (WhatsApp Web self-updates past it) and cost a GitHub fetch on
  // every connect, which stalled reconnects. Set WA_VERSION to re-enable it.
  const waVersion = process.env.WA_VERSION || "";

  const gen = bumpGeneration();
  takeProfileLock(); // this process is about to own the browser profile
  state.pageListener = false;
  // Every handler registered below is inert once a newer operation begins. A
  // killed browser keeps emitting for a while, and those late events used to
  // mutate the state of the client that had already replaced it.
  const bindGuarded = (c) => {
    const raw = c.on.bind(c);
    c.on = (ev, fn) => raw(ev, (...a) => { if (!isCurrent(gen)) return; return fn(...a); });
    return c;
  };

  client = new Client({
    // WWEBJS_PATH lets the login live on a persistent disk in the cloud (paid
    // tier), so a redeploy or restart does not force a re-scan. Unset locally.
    authStrategy: new LocalAuth({ clientId: "monitor", ...(process.env.WWEBJS_PATH ? { dataPath: process.env.WWEBJS_PATH } : {}) }),
    // whatsapp-web.js enforces its OWN auth timeout, default 30s, covering the
    // WhatsApp Web load + inject phase. On a slow/shared-CPU box that expires
    // and the client sits "authenticated" but never reaches ready -- exactly the
    // hang seen on the free-tier container. protocolTimeout does not cover it.
    authTimeoutMs: LAUNCH_MS,
    qrMaxRetries: 0,
    // Phone-number linking: WhatsApp issues an 8-character code (refreshed
    // every 3 minutes) and pops a notification on the phone asking for it.
    ...(state.pairPhone ? { pairWithPhoneNumber: { phoneNumber: state.pairPhone, showNotification: true, intervalMs: 180000 } } : {}),
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
      // Three separate clocks, all 30s by default and all too short here:
      //   timeout         -> Chromium process launch
      //   protocolTimeout -> DevTools protocol calls (long in-page pagination)
      //   authTimeoutMs   -> set on the Client above, WhatsApp Web load/inject
      timeout: LAUNCH_MS,
      protocolTimeout: LAUNCH_MS,
      // Chromium's own stdout/stderr, for diagnosing a silent launch failure or
      // OOM kill in a container. Noisy, so opt in with WA_DEBUG=1.
      ...(process.env.WA_DEBUG === "1" ? { dumpio: true } : {}),
      // Only honour a container Chromium path when it actually exists -- a stale
      // /usr/bin/chromium on a Mac would make the launch fail with "Code: null".
      ...(process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)
        ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
        : {}),
      // Platform-specific flags. On macOS the minimal set is all Chrome will
      // accept (--no-zygote crashes it). In the Linux container Chromium runs
      // as root on a small (512 MB free-tier) box, so it needs the sandbox-off
      // process flags AND memory-saving ones, or it dies at launch with
      // "Failed to launch the browser process: Code: null".
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        ...(process.platform === "linux"
          ? [
              "--disable-gpu",
              // --no-zygote/--single-process cut memory but can destabilise
              // Chromium. Set WA_NO_SINGLE_PROCESS=1 to A/B this on the host
              // without a code change.
              // Multi-process by DEFAULT: --single-process concentrates all of
              // WhatsApp Web in one process, so hitting the cgroup limit kills
              // the whole browser (observed: oom_kill after loading 127 groups).
              // Opt back in with WA_SINGLE_PROCESS=1 on very small boxes.
              ...(process.env.WA_SINGLE_PROCESS === "1" ? ["--no-zygote", "--single-process"] : []),          // one renderer: far less RAM
              "--disable-extensions",
              "--disable-background-networking",
              "--disable-default-apps",
              "--disable-sync",
              "--no-first-run",
              "--mute-audio",
              // Trim WhatsApp Web's memory growth without capping the JS heap
              // (a hard cap caused GC thrash and did not limit native memory).
              "--disable-back-forward-cache",
              "--disable-features=BackForwardCache,AcceptCHFrame,MediaRouter,Translate",
            ]
          : []),
      ],
    },
  });
  bindGuarded(client);

  client.on("code", (code) => {
    clearTimeout(state.startTimer); // a code arriving is the launch succeeding
    const first = state.status !== "code";
    state.status = "code";
    state.pairingCode = String(code || "");
    state.codeAt = Date.now();
    state.qrDataUrl = null;
    step(first
      ? "Link code ready — on the phone: Linked Devices → Link a device → Link with phone number instead, then type the code"
      : "New link code (they refresh every 3 minutes)");
  });

  client.on("qr", async (qr) => {
    clearTimeout(state.startTimer);
    if (state.status !== "qr") step("Waiting for QR scan — phone → Linked Devices → Link a Device");
    supervisor.event("qr_shown");
    state.status = "qr";
    state.qrDataUrl = await QR.toDataURL(qr, { margin: 1, width: 320 });
    // WhatsApp decides the rotation interval, not us. Measure it from the
    // actual qr events rather than guessing a number in the UI.
    const now = Date.now();
    if (state.qrAt) {
      state.qrIntervals = [...(state.qrIntervals || []), Math.round((now - state.qrAt) / 1000)].slice(-5);
    }
    state.qrAt = now;
    state.qrCount = (state.qrCount || 0) + 1;

    // WhatsApp refreshes the code about every 20s. If it stops (the page is
    // CPU-starved on a small container), the displayed QR goes stale and will
    // not link. Relaunch to get a live one rather than showing a dead code.
    clearTimeout(state.qrStaleTimer);
    state.qrStaleTimer = setTimeout(async () => {
      if (state.status !== "qr") return;
      // Rotation also stops when someone scans. Restarting here aborted the
      // link mid-handshake, which is what tripped WhatsApp's "can't link new
      // devices" limit on the phone. Check the page before killing anything.
      const onScreen = await qrOnScreen();
      if (state.status !== "qr") return; // authenticated while we probed
      if (onScreen === false) {
        // The code left the DOM: a phone has it. From here the supervisor
        // refuses teardowns until the handshake succeeds or truly times out.
        supervisor.event("qr_taken");
        step("Code scanned — completing the link…");
        // Nothing more to do here: `authenticated` arms its own watchdog. If
        // the handshake dies silently, this one last timer recovers.
        clearTimeout(state.qrStaleTimer);
        state.qrStaleTimer = setTimeout(() => {
          if (state.status !== "qr") return;
          relaunch("link did not complete after a scan", { delay: 1500 });
        }, Number(process.env.QR_SCAN_GRACE_MS || 120_000));
        return;
      }
      const age = Math.round((Date.now() - state.qrAt) / 1000);
      step(`QR stopped refreshing (${age}s old) — restarting to get a live code`, "warn");
      relaunch(`QR stale (${age}s)`, { delay: 1500 });
    }, Number(process.env.QR_STALE_MS || 90_000));
  });

  // Fires after a successful scan, before `authenticated`. Whatever else it
  // means, it means the code was taken -- stand the restart timer down.
  client.on("loading_screen", (percent) => {
    supervisor.event("loading");
    clearTimeout(state.qrStaleTimer);
    if (state.status === "qr") step("Code scanned — loading WhatsApp Web…");
    state.loadingPercent = percent;
  });

  client.on("authenticated", () => {
    supervisor.event("authenticated");
    state.pairingCode = null; // linked: the code has done its job
    state.pairPhone = "";
    clearTimeout(state.qrStaleTimer);
    state.status = "authenticated";
    markLinked(true); // from here on, sample data is never shown
    state.qrDataUrl = null;
    state.authAt = Date.now();
    step("Authenticated — loading WhatsApp Web (usually 10–40s)…");

    // "authenticated" but never "ready" is the hang the user kept hitting.
    // Escalate: claim the session, then reload the page, then restart once.
    clearInterval(state.authWatchdog);
    state.authWatchdog = setInterval(async () => {
      if (state.status !== "authenticated" || !client) return clearInterval(state.authWatchdog);
      const waited = Math.round((Date.now() - state.authAt) / 1000);

      // Before escalating, ask the page whether it is actually finished. A
      // session can be fully loaded -- chat pane mounted, chats rendered --
      // while the library never emits `ready`. Reloading or restarting a
      // working session is strictly worse than using it.
      const ps = await pageState();
      if (ps.ok && ps.chatListPresent && !ps.needsScan) {
        clearInterval(state.authWatchdog);
        await becomeReady("probe");
        return;
      }
      if (waited >= 150) {
        clearInterval(state.authWatchdog);
        if (!state.reloadedOnce) {
          state.reloadedOnce = true;
          step(`Still loading after ${waited}s — restarting the browser once`, "warn");
          relaunch(`authenticated but not ready after ${waited}s`, { delay: 2500 });
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

  client.on("ready", () => becomeReady("library"));

  // whatsapp-web.js does not always emit `ready`, even when the page is
  // demonstrably finished: probing a hung session showed the chat list mounted,
  // 103 unread and every chat rendered, while the app still sat at
  // "authenticated". Waiting on an event that never arrives is what produced
  // "Still loading after 75s" on a working session. So readiness is also
  // PROBED -- if WhatsApp's own chat pane is on screen, it is ready, whatever
  // the library did or did not emit.
  async function becomeReady(via) {
    if (state.status === "ready") return;      // whichever path got here first
    if (!isCurrent(gen)) return;
    supervisor.event("ready"); // ends protection and every deadline
    clearTimeout(state.startTimer);
    clearInterval(state.authWatchdog);
    state.status = "ready";
    markLinked(true);
    state.qrDataUrl = null;
    state.reclaims = 0;
    state.crashes = 0;
    state.conflictStreak = 0;
    state.reclaimRestart = false;
    state.reloadTried = false;
    state.reloadedOnce = false;
    state.me = client.info?.pushname || client.info?.wid?.user || null;
    step(`Linked as ${state.me || "unknown"} — reading groups…`
      + (via === "probe" ? " (detected from the page — the library never signalled ready)" : ""));

    // Live messages must not depend on how ready was reached.
    const listening = await installPageListener();
    if (!listening) step("Live listener fell back to the library — if new messages do not appear, press Force reset", "warn");

    // Ready: stop the fast poll. Watch slowly in case another window steals it.
    startClaimLoop(60_000);

    // Automatic sequence: groups -> history for the saved groups -> live.
    // The user should not have to press anything after scanning.
    await refreshGroups({ retries: 10 });
    step(`${state.groups.length} groups found`);
    if (state.watching.c5 || state.watching.c3) {
      await syncAll();
      scheduleCatchUpPull();
      startRecheck();
    } else {
      step("Linked. Now enter the C5 and C3 group names below and press Save groups & pull history", "info");
      if (!process.env.WWEBJS_PATH) {
        step("Note: no persistent volume — group names and the login reset on each redeploy", "warn");
      }
    }
  }

  client.on("auth_failure", (m) => {
    state.status = "error";
    state.error = `auth failed: ${m}`;
  });

  client.on("disconnected", (r) => {
    state.status = "idle";
    state.connected = false;
    state.error = `disconnected: ${r}`;
    process.env.WA_CONNECTED = "";
    // Say what actually happened. After a LOGOUT the next thing the user saw
    // was "Could not read: Work. Check the exact group name" from a pull that
    // was already running -- which sent them looking at group names.
    step(String(r).toUpperCase().includes("LOGOUT")
      ? "WhatsApp logged this device out — it was removed under Linked devices on the phone, or the session ended. Press Connect and scan again."
      : `WhatsApp disconnected (${r}). Press Connect to reconnect.`, "error");
    hardStop();
  });

  // Capture live traffic in both watched groups.
  //
  // Deliberately avoids msg.getChat(): that call goes through the same chat
  // layer that is broken on current WhatsApp Web builds, so it threw on every
  // message and the catch swallowed it -- nothing was ever captured. The chat
  // id is already on the message, and names come from the group list read out
  // of the local database.
  client.on("message_create", (msg) => {
    // The in-page listener is the primary source (see installPageListener);
    // this stays as a fallback for when it could not be installed.
    if (state.pageListener) return;
    captureEvent({
      chatId: (msg.id && msg.id.remote) || (msg.fromMe ? msg.to : msg.from) || "",
      fromMe: msg.fromMe,
      body: msg.body || (msg._data && msg._data.caption) || "",
      timestamp: msg.timestamp,
      notifyName: msg._data && (msg._data.notifyName || msg._data.pushName),
      author: msg.author,
      id: msg.id && msg.id._serialized,
      kind: "new",
      via: "library",
    });
  });

  async function captureEvent(msg) {
    // Counts every event, before any filtering, so "the listener never fires"
    // can be told apart from "it fired but the group did not match".
    state.eventsSeen = (state.eventsSeen || 0) + 1;
    try {
      const chatId = msg.chatId || "";
      state.lastEvent = {
        at: new Date().toISOString(),
        chatId: String(chatId),
        isGroup: String(chatId).endsWith("@g.us"),
        body: String(msg.body || "").slice(0, 40),
      };
      // A message the owner sends in the chosen broadcast group goes out to
      // every tagged chat. Checked before any other filter: the broadcast
      // group is usually not one of the watched C5/C3 groups.
      maybeRelay(msg).catch((e) => console.error("  [wa] broadcast-group relay failed:", (e && e.message) || e));
      if (!String(chatId).endsWith("@g.us")) return; // groups only

      if (!state.groups.length) await refreshGroups().catch(() => {});
      const group = state.groups.find((g) => g.id === String(chatId));
      const name = group ? group.name : String(chatId);
      rememberGroup(name, String(chatId));

      state.lastEvent.groupName = name;
      const bucket = bucketFor(name);
      state.lastEvent.matchedBucket = bucket || null;
      if (!bucket) return;

      const body = msg.body || "";
      if (!body) return;

      // Own messages carry no notifyName, so the raw id leaked through as the
      // sender. Use the linked account's name instead.
      const sender = msg.fromMe
        ? (state.me || "You")
        : msg.notifyName || String(msg.author || "").split("@")[0] || "unknown";

      const rec = toRecord(msg.timestamp, sender, body, msg.id);
      const r = upsert(name, [rec]);
      if (r.added) {
        state.captured += r.added;
        state.lastMessageAt = new Date().toISOString();
        console.log(`  captured [${bucket}] ${name}: ${sender}: ${body.slice(0, 60)}`);
      }
      if (r.edited) {
        state.edited = (state.edited || 0) + r.edited;
        state.lastMessageAt = new Date().toISOString();
        console.log(`  edited   [${bucket}] ${name}: ${sender}: ${body.slice(0, 60)}`);
      }
    } catch (e) {
      // Never silent again -- a swallowed error here cost hours.
      state.error = `capture failed: ${(e && e.message) || e}`;
      console.error("  capture error:", e && e.message);
    }
  }

  // Live messages, read straight from WhatsApp's own message collection.
  //
  // whatsapp-web.js only wires up its message_create event at the END of its
  // ready sequence. When the page finishes loading but the library never gets
  // there -- the case becomeReady("probe") exists for -- history still works
  // (it reads the page directly) but live messages silently stop: eventsSeen
  // stayed at 0 on a session that was otherwise fully up. So listen on the
  // page ourselves, the same way history is read, independent of the library.
  async function installPageListener() {
    const page = client && client.pupPage;
    if (!page) return false;
    try {
      if (!state.listenerPages) state.listenerPages = new WeakSet();
      if (!state.listenerPages.has(page)) {
        await page.exposeFunction("__acmOnMsg", (ev) => { if (isCurrent(gen)) captureEvent({ ...ev, via: "page" }); });
        state.listenerPages.add(page);
      }
      const ok = await page.evaluate(() => {
        if (window.__acmListening) return true;
        const C = window.require("WAWebCollections");
        if (!C || !C.Msg || typeof C.Msg.on !== "function") return false;
        const send = (m, kind) => {
          try {
            const id = m.id || {};
            const ser = (w) => (w && (w._serialized || String(w))) || "";
            window.__acmOnMsg({
              chatId: ser(id.remote),
              fromMe: Boolean(id.fromMe),
              body: m.body || m.caption || "",
              timestamp: m.t,
              notifyName: m.notifyName || "",
              author: ser(m.author),
              id: ser(id),
              kind: kind || "new",
            });
          } catch (e) { /* one bad message must not stop the listener */ }
        };
        // An edit changes the existing message's body in place. Its id is the
        // original message's, so the store updates that row rather than adding
        // a new one.
        C.Msg.on("change:body change:caption", (m) => { if (m && m.id) send(m, "edit"); });
        C.Msg.on("add", (m) => {
          if (!m || !m.isNewMsg) return;
          // Still encrypted on arrival: wait for WhatsApp to decrypt it, as
          // whatsapp-web.js itself does.
          if (m.type === "ciphertext") { m.once("change:type", () => send(m, "new")); return; }
          send(m, "new");
        });
        window.__acmListening = true;
        return true;
      });
      state.pageListener = Boolean(ok);
      return state.pageListener;
    } catch (e) {
      console.error("  [wa] could not install the page listener:", (e && e.message) || e);
      state.pageListener = false;
      return false;
    }
  }

  // Surface the Chromium process: a silent exit (OOM kill in a container) would
  // otherwise look identical to a slow start.
  client.on("ready", () => {}); // no-op; ensures listeners are attached early
  setTimeout(async () => {
    try {
      const proc = client && client.pupBrowser && client.pupBrowser.process();
      if (!proc) return;
      const mem = containerMemory();
      console.log(`  [wa] chromium pid=${proc.pid}${mem ? ` mem=${mem.used}/${mem.limit}` : ""}`);
      if (process.env.WA_DEBUG === "1") {
        proc.stdout?.on("data", (d) => console.log("  [chrome]", String(d).trimEnd().slice(0, 300)));
        proc.stderr?.on("data", (d) => console.error("  [chrome!]", String(d).trimEnd().slice(0, 300)));
      }
      proc.on("exit", (code, signal) => {
        const m = containerMemory();
        const wasOom = Boolean(m && m.oomKill !== "0");
        const oom = wasOom ? ` (cgroup oom_kill=${m.oomKill} — out of memory)` : "";
        console.error(`  [wa] chromium exited code=${code} signal=${signal}${oom}`);
        if (state.abandoned || state.status === "idle") return; // deliberate teardown
        // Superseded by a newer Connect/Unlink: this exit is one WE caused, so
        // it must not count toward the crash budget. Without this, pressing
        // Unlink and Connect a handful of times accumulated four "crashes" and
        // wedged the app on "Chromium keeps exiting" until a server restart.
        if (!isCurrent(gen)) return;

        // A crash mid-session leaves the app dead until someone presses Connect.
        // Come back automatically, but cap it so a hard OOM loop cannot spin.
        state.crashes = (state.crashes || 0) + 1;
        if (state.crashes <= 3) {
          step(
            `Chromium exited${oom} — restarting (${state.crashes}/3)` +
              (wasOom ? ". Set WA_NO_SINGLE_PROCESS=1 or raise the memory limit if this repeats." : ""),
            "warn"
          );
          relaunch(`chromium exited${oom}`, { force: true, delay: 4000 });
        } else {
          state.status = "error";
          state.error = wasOom
            ? "Chromium keeps running out of memory. Set WA_NO_SINGLE_PROCESS=1, or give the service more RAM."
            : `Chromium keeps exiting (code ${code}).`;
          step(state.error, "error");
        }
      });
    } catch {
      /* browser not up yet */
    }
  }, 8000);

  // Poll for the dialog from the start; it can appear before authentication.
  startClaimLoop(3000);

  client.initialize().catch(async (e) => {
    // Superseded before it ever came up: not an error anyone needs to see.
    if (!isCurrent(gen)) return;
    // A page reload during start-up destroys the init context. ONE restart
    // recovers it; anything more is thrash, so it is hard-capped at one.
    const contextLost = /Execution context was destroyed|Protocol error|Target closed|Session closed/i.test(e.message || "");
    // A deliberate abandon (persistent conflict) must not be "recovered".
    if (state.abandoned) return;
    if (contextLost && !state.reclaimRestart) {
      state.reclaimRestart = true;
      step("Page reloaded during start-up — restarting once", "warn");
      relaunch("execution context lost during start-up", { force: true });
      return;
    }
    // whatsapp-web.js failing to find its injected Store: the page it
    // attached to went away mid-injection, which is what a racing teardown
    // does. Transient by nature -- pressing Connect again always fixed it, so
    // do that automatically instead of showing the user a null-property error.
    if (/reading 'Socket'|reading "Socket"|Store is not defined|window\.Store/i.test(e.message || "")) {
      step("Start-up raced a previous session — retrying", "warn");
      relaunch("store injection raced a teardown", { force: true, delay: 1500 });
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
    console.error("  [wa] launch failed:", (e && e.message) || e);
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
  if (!(await pageUsable())) throw new Error("Connection lost — reconnecting; try again in a moment");

  if (!state.groups.length) await refreshGroups();
  const known =
    state.groups.find((g) => g.name === groupName) ||
    state.groups.find((g) => String(g.name).toLowerCase() === String(groupName).toLowerCase());
  if (!known) throw new Error(`No group named "${groupName}" — check the exact name`);

  // Date floor in Dubai time, matching every other timestamp in the app.
  const sinceUnix = since ? Math.floor(new Date(`${since}T00:00:00+04:00`).getTime() / 1000) : 0;

  // WhatsApp only loads and decrypts a chat's messages once that conversation
  // is actually opened. Paginating without opening it first sees whatever
  // happens to be in memory -- usually a single message -- and loadEarlierMsgs
  // then reports there is nothing older, which the UI relayed as "complete,
  // nothing earlier in this group". Measured on the same group in the same
  // session: 1 message without opening, 14 with. The chat must be opened.
  const opened = await openChatByName(known.name);

  // Opening returns as soon as the conversation is SELECTED, not when its
  // messages have loaded -- it reports messagesRendered:false and the message
  // collection is still whatever was cached. Paginating at that instant sees
  // one message and concludes the group has no history, which is exactly what
  // happened on the pull straight after a fresh link. Wait for the collection
  // to actually fill before asking for more.
  const loaded = await waitForChatMessages(known.id);

  const { rows, diag } = await historySince(known.id, sinceUnix, limit);
  diag.opened = opened && opened.ok ? (opened.via || true) : `failed: ${(opened && opened.error) || "unknown"}`;
  diag.loadedBeforePull = loaded;
  const records = rows.map((r) => toRecord(r.timestamp, r.sender, r.text, r.id));
  const { added, edited } = upsert(groupName, records);

  return {
    group: groupName,
    via: "WhatsApp Web (loadEarlierMsgs)",
    since: since || "all",
    found: rows.length,
    added,
    edited,
    opened: diag.opened,
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

  // The browser may have crashed and been replaced since we were marked ready.
  if (!(await pageUsable())) {
    state.connected = false;
    process.env.WA_CONNECTED = "";
    step("Connection was lost — reconnecting, then pull history again", "warn");
    relaunch("page unusable before sync", { force: true });
    return;
  }

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
        // One slow or enormous group must not wedge the app. state.syncing
        // blocks Connect and Force reset while it is set, so a pull that never
        // returns leaves the user with no way out but killing the server --
        // observed at over two minutes on a single group with no output.
        const r = await Promise.race([
          backfill(g, { since: state.watching.since || undefined }),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`timed out after ${Math.round(PULL_TIMEOUT_MS / 1000)}s — the group may be very large; press Pull history to continue`)),
              PULL_TIMEOUT_MS)),
        ]);
        results.push({ tag, group: g, ok: true, ...r });
        // Why the pull ended matters as much as what it found: "starts on the
        // 6th" reads as a bug when the group simply has nothing earlier, and
        // reads as fine when history was actually truncated. Say which.
        const why =
          r.opened && String(r.opened).startsWith("failed")
            ? ` · could not open the chat — history may be incomplete`
          : r.stopped === "no older messages"
            ? ` · complete — nothing earlier in this group`
            : r.stopped === "reached since-date"
              ? ` · complete back to ${r.since}`
              : ` · stopped early (${r.stopped}) — older history may still be on the phone`;
        // Lead with the range asked for; the dates after it are where messages
        // were actually found. "1 messages — 16 → 16" read as the filter being
        // ignored when it meant "the only message since the 1st is on the 16th".
        const asked = r.since && r.since !== "all" ? `since ${r.since}` : "all history";
        const where = !r.found ? "none found"
          : r.store.first === r.store.last ? `all on ${r.store.first}`
          : `found ${r.store.first} → ${r.store.last}`;
        step(`${tag} · ${g}: ${r.found} message${r.found === 1 ? "" : "s"} ${asked}${r.added ? ` (${r.added} new)` : ""}${r.edited ? ` (${r.edited} edited)` : ""} — ${where}${why}`);
      } catch (e) {
        const dead = DEAD_PAGE.test(e.message || "");
        results.push({ tag, group: g, ok: false, error: e.message, dead });
        step(
          dead
            ? `${tag} · ${g}: connection lost mid-pull — will reconnect`
            : `${tag} · ${g}: history failed — ${e.message.slice(0, 80)}`,
          "error"
        );
        if (dead) break; // no point trying the next group on a dead page
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
    // Groups can be chosen after linking; the re-check must cover them too.
    startRecheck();
  } else if (results.length) {
    const dead = results.some((r) => r.dead);
    if (dead) {
      step("Connection dropped during the pull — reconnecting…", "warn");
      state.connected = false;
      process.env.WA_CONNECTED = "";
      relaunch("page died during history pull", { force: true });
    } else {
      const failed = results.filter((r) => !r.ok);
      const bad = failed.map((r) => r.group).join(", ");
      // Only a missing group is a naming problem. Anything else -- most often
      // the session dropping mid-pull -- must not send the user to re-type
      // group names that were correct all along.
      const naming = failed.every((r) => /No group named/i.test(r.error || ""));
      if (naming) step(`Could not find: ${bad}. Check the exact group name, then press Pull history`, "error");
      else if (state.status !== "ready") step(`Could not read ${bad}: WhatsApp disconnected during the pull. Press Connect, then Pull history.`, "error");
      else step(`Could not read ${bad}: ${failed[0].error}. Press Pull history to try again.`, "error");
    }
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
    pairingCode: state.status === "code" ? state.pairingCode : null,
    codeAge: state.status === "code" && state.codeAt ? Math.round((Date.now() - state.codeAt) / 1000) : null,
    // Last four digits only: enough to recognise, not enough to leak.
    pairPhone: state.pairPhone ? `…${state.pairPhone.slice(-4)}` : "",
    // Median of the observed gaps between QR refreshes, once we have any.
    qrRotateSecs: (state.qrIntervals || []).length
      ? [...state.qrIntervals].sort((a, b) => a - b)[Math.floor(state.qrIntervals.length / 2)]
      : null,
    groups: state.groups,
    watching: state.watching,
    claimedSession: Boolean(state.claimedSession),
    conflicts: state.reclaims || 0,
    eventsSeen: state.eventsSeen || 0,
    // Which source is feeding live messages; false means only the library,
    // which goes quiet whenever it never reached its own ready.
    pageListener: Boolean(state.pageListener),
    edited: state.edited || 0,
    lastRecheck: state.lastRecheck || null,
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
  clearTimeout(state.catchUpTimer);
  clearInterval(state.recheckTimer);
  bumpGeneration(); // anything the old client still emits is now ignored
  clearTimeout(state.startTimer);
  clearTimeout(state.qrStaleTimer);
  clearInterval(state.claimTimer);
  clearInterval(state.authWatchdog);
  if (!c) return;
  Promise.resolve()
    .then(() => c.destroy())
    .catch(() => {});
}

// Background teardown runs on the same event loop that serves HTTP. The
// synchronous forms below block it: the profile kill waits up to 2s and rm -rf
// on a Chrome profile is not fast, which together pushed responses past nine
// seconds during repeated Connect/Unlink presses. These twins do the same work
// without stalling everything else. The sync forms stay for the callers that
// genuinely must finish before a launch begins.
async function clearStaleProfileLockAsync() {
  const pattern = `--user-data-dir=${PROFILE_DIR}`;
  const count = () => {
    try {
      return execFileSync("pgrep", ["-f", "--", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  if (count() === 0) return [];
  try { execFileSync("pkill", ["-9", "-f", "--", pattern], { stdio: "ignore" }); } catch { /* gone */ }
  const deadline = Date.now() + 2000;
  while (count() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try { await fs.promises.rm(path.join(PROFILE_DIR, f), { force: true }); } catch { /* not present */ }
  }
  return ["orphaned chrome"];
}

async function wipeSessionAsync() {
  await clearStaleProfileLockAsync();
  try {
    await fs.promises.rm(PROFILE_DIR, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// Which process owns the WhatsApp profile.
//
// Clearing the profile means SIGKILLing every Chromium using it, which cannot
// tell a crashed leftover from a HEALTHY session owned by another running
// instance. Starting a second server -- a test copy, a dev copy -- therefore
// killed the live one's browser mid-session. The owner records its pid here so
// others can see the profile is in use and leave it alone.
const PROFILE_LOCK = path.join(PROFILE_DIR, "..", "owner.json");

function profileOwner() {
  try {
    const { pid, at } = JSON.parse(fs.readFileSync(PROFILE_LOCK, "utf8"));
    if (!pid || pid === process.pid) return null;
    process.kill(pid, 0); // throws if that process is gone
    return { pid, at };
  } catch {
    return null; // no lock, unreadable, or the owner has exited
  }
}

function takeProfileLock() {
  try {
    fs.mkdirSync(path.dirname(PROFILE_LOCK), { recursive: true });
    fs.writeFileSync(PROFILE_LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } catch { /* advisory only */ }
}

function releaseProfileLock() {
  try {
    const { pid } = JSON.parse(fs.readFileSync(PROFILE_LOCK, "utf8"));
    if (pid === process.pid) fs.rmSync(PROFILE_LOCK, { force: true });
  } catch { /* nothing to release */ }
}

process.on("exit", releaseProfileLock);

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
  state.pairingCode = null;
  state.pairPhone = "";
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
  markLinked(false);
  process.env.WA_CONNECTED = ""; // sample data may show again once unlinked
  step("Not connected");

  // Unlinking removes the captured messages AND the chosen groups -- both
  // belong to the account being disconnected.
  if (clearData) {
    state.cleared = clearAll();
    if (state.cleared.archived) {
      step(`Archived ${state.cleared.archived} captured message(s) — WhatsApp will not re-send them, so they are kept`, "info");
    }
    state.watching = { c5: "", c3: "", since: "" };
    process.env.C5_GROUP = "";
    process.env.C3_GROUP = "";
    saveWatched(state.watching);
  }

  // Background teardown -- never awaited, so the HTTP response is instant.
  // Every destructive step re-checks the generation first: by the time these
  // resolve the user may already have pressed Connect, and killing the
  // profile then takes down the browser they are waiting on.
  const gen = bumpGeneration();
  (async () => {
    const withTimeout = (fn, ms) => Promise.race([Promise.resolve().then(fn).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
    if (c) {
      if (unlink) await withTimeout(() => c.logout(), 6000);
      await withTimeout(() => c.destroy(), 6000);
    }
    if (!isCurrent(gen)) return; // a newer Connect owns the profile now
    if (wipe) await wipeSessionAsync();
    if (!isCurrent(gen)) return;
    await clearStaleProfileLockAsync(); // belt-and-braces: release the lock
  })().catch(() => {});
}

// ---------------------------------------------------------------------------
// Broadcast: one message, sent to every chat the user has tagged.
//
// Tags are saved by chat id, not name: sending by name needs getChats(), which
// is broken on current WhatsApp Web builds, and two chats can share a name.
// Sends go one chat at a time with a few seconds between them. The same text
// fired at many chats at once is exactly the pattern WhatsApp flags as spam,
// and an unofficial client is the easiest kind to ban.
// ---------------------------------------------------------------------------
const BROADCAST_FILE = process.env.BROADCAST_FILE || path.join(__dirname, "..", "data", "broadcast-targets.json");
const BROADCAST_MAX = Number(process.env.BROADCAST_MAX || 60);
const BROADCAST_GAP_MS = Number(process.env.BROADCAST_GAP_MS || 2500);

function loadTags() {
  try {
    const list = JSON.parse(fs.readFileSync(BROADCAST_FILE, "utf8"));
    return Array.isArray(list) ? list.filter((t) => t && t.id) : [];
  } catch {
    return [];
  }
}

function saveTags(list) {
  const clean = [];
  const seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    const id = String((t && t.id) || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    clean.push({ id, name: String(t.name || id).slice(0, 200), isGroup: id.endsWith("@g.us") });
  }
  fs.mkdirSync(path.dirname(BROADCAST_FILE), { recursive: true });
  fs.writeFileSync(BROADCAST_FILE, JSON.stringify(clean, null, 2));
  return clean;
}

// Every chat the user could tag: groups from the local database (reliable),
// plus one-to-one chats from WhatsApp's in-memory chat list.
async function listChats() {
  if (state.status !== "ready" || !client) throw new Error("WhatsApp is not connected");
  if (!state.groups.length) await refreshGroups().catch(() => {});
  const out = new Map();
  for (const g of state.groups) out.set(g.id, { id: g.id, name: g.name, isGroup: true });
  try {
    const direct = await client.pupPage.evaluate(() => {
      const C = window.require("WAWebCollections");
      if (!C || !C.Chat || typeof C.Chat.getModelsArray !== "function") return [];
      return C.Chat.getModelsArray()
        .map((c) => ({ c, id: String((c.id && c.id._serialized) || "") }))
        .filter(({ id }) => id && !/@(g\.us|broadcast|newsletter)$/.test(id))
        .map(({ c, id }) => ({
          id,
          name: c.formattedTitle || c.name || (c.contact && (c.contact.name || c.contact.pushname)) || id.split("@")[0],
          isGroup: false,
        }));
    });
    for (const d of direct) if (!out.has(d.id)) out.set(d.id, d);
  } catch {
    /* groups alone are still useful */
  }
  return [...out.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// ---- Broadcast group ---------------------------------------------------------
// The owner picks one WhatsApp group; every message THEY send in it is
// broadcast to the tagged chats, and the app replies there with the result so
// it can be driven from the phone without opening the dashboard. Guards, each
// for a real failure:
//   - only the owner's own messages (fromMe) trigger it -- anyone else in the
//     group must not be able to broadcast from this account
//   - edits are ignored -- fixing a typo must not send the message again
//   - the app's own replies are ignored (by id, and by their prefix) -- or each
//     "sent" confirmation would trigger another broadcast, forever
//   - messages older than 10 minutes are ignored -- after a reconnect WhatsApp
//     can deliver a backlog, and last night's message must not go out now
const RELAY_FILE = process.env.RELAY_FILE || path.join(__dirname, "..", "data", "broadcast-relay.json");
const RELAY_MAX_AGE_S = Number(process.env.RELAY_MAX_AGE_S || 600);
const RELAY_REPLY = /^(✅|⚠️|⏳) Broadcast/;

function loadRelay() {
  try {
    const r = JSON.parse(fs.readFileSync(RELAY_FILE, "utf8"));
    return { enabled: Boolean(r.enabled && r.sourceId), sourceId: String(r.sourceId || ""), sourceName: String(r.sourceName || "") };
  } catch {
    return { enabled: false, sourceId: "", sourceName: "" };
  }
}

function saveRelay(cfg = {}) {
  const c = {
    sourceId: String(cfg.sourceId || "").trim(),
    sourceName: String(cfg.sourceName || "").slice(0, 200),
  };
  c.enabled = Boolean(cfg.enabled) && Boolean(c.sourceId);
  fs.mkdirSync(path.dirname(RELAY_FILE), { recursive: true });
  fs.writeFileSync(RELAY_FILE, JSON.stringify(c, null, 2));
  return c;
}

// Ids of messages this app sent, so its own posts are never heard as commands.
const appSent = new Set();
function rememberSent(m) {
  const id = m && m.id && (m.id._serialized || String(m.id));
  if (!id) return;
  appSent.add(id);
  if (appSent.size > 1000) appSent.delete(appSent.values().next().value);
}
const relaySeen = new Set();

async function replyInRelay(text, { dryRun = false } = {}) {
  const cfg = loadRelay();
  if (!cfg.sourceId) return;
  if (dryRun || state.status !== "ready" || !client) { console.log(`  [wa] broadcast-group reply (not sent): ${text}`); return; }
  try { rememberSent(await client.sendMessage(cfg.sourceId, text)); }
  catch (e) { console.error("  [wa] could not reply in the broadcast group:", (e && e.message) || e); }
}

const bcQueue = [];
function runNextQueued() {
  const next = bcQueue.shift();
  if (next) startGroupBroadcast(next.text, next.opts);
}

async function startGroupBroadcast(text, opts = {}) {
  try {
    const st = await broadcast(text, { ...opts, origin: "group" });
    if (st.total > 3) await replyInRelay(`⏳ Broadcasting to ${st.total} chats…`, opts);
  } catch (e) {
    await replyInRelay(`⚠️ Broadcast not sent: ${e.message}`, opts);
    runNextQueued();
  }
}

// Decide whether an incoming event is a broadcast command. Exported for tests.
async function maybeRelay(ev, opts = {}) {
  const cfg = loadRelay();
  if (!cfg.enabled || String(ev.chatId || "") !== cfg.sourceId) return "not-relay";
  if (ev.kind === "edit") return "edit";
  if (!ev.fromMe) return "not-owner";
  if (ev.id && appSent.has(ev.id)) return "own-reply";
  const body = String(ev.body || "").trim();
  if (!body) return "empty";
  if (RELAY_REPLY.test(body)) return "own-reply";
  if (ev.id) { if (relaySeen.has(ev.id)) return "duplicate"; relaySeen.add(ev.id); }
  const age = Date.now() / 1000 - Number(ev.timestamp || 0);
  if (ev.timestamp && age > RELAY_MAX_AGE_S) {
    step("Broadcast group: skipped a message older than 10 minutes (delivered late after a reconnect)", "warn");
    return "stale";
  }
  step(`Broadcast group: new message from ${cfg.sourceName || "the broadcast group"} — broadcasting`);
  if (bc.running) { bcQueue.push({ text: body, opts }); return "queued"; }
  await startGroupBroadcast(body, opts);
  return "sent";
}

const bc = { running: false, results: [] };
function broadcastStatus() {
  return { ...bc, results: bc.results.map((r) => ({ ...r })) };
}

async function broadcast(text, { dryRun = false, origin = "app" } = {}) {
  const body = String(text || "").trim();
  if (!body) throw new Error("Type a message first");
  if (bc.running) throw new Error("A broadcast is already sending — wait for it to finish");
  if (!dryRun && (state.status !== "ready" || !client)) throw new Error("WhatsApp is not connected — link it on the WhatsApp tab first");
  // The broadcast group itself is never a target: sending into it would be
  // heard as a new message there and broadcast again, forever.
  const relay = loadRelay();
  const targets = loadTags().filter((t) => !(relay.sourceId && t.id === relay.sourceId));
  if (!targets.length) throw new Error("No chats tagged — tick at least one chat");
  if (targets.length > BROADCAST_MAX) {
    throw new Error(`${targets.length} chats are tagged; the limit is ${BROADCAST_MAX} per broadcast to keep the account clear of WhatsApp's spam checks`);
  }

  Object.assign(bc, {
    running: true, id: Date.now(), dryRun, origin, text: body,
    total: targets.length, done: 0, sent: 0, failed: 0,
    startedAt: new Date().toISOString(), finishedAt: null,
    results: targets.map((t) => ({ id: t.id, name: t.name, state: "waiting" })),
  });
  const gen = generation;
  step(`Broadcast${dryRun ? " (dry run)" : ""}: sending to ${targets.length} chat${targets.length === 1 ? "" : "s"}…`);

  (async () => {
    for (let i = 0; i < targets.length; i++) {
      const r = bc.results[i];
      if (!dryRun && (!isCurrent(gen) || state.status !== "ready" || !client)) {
        r.state = "failed"; r.error = "WhatsApp disconnected before this chat was reached";
        bc.failed++; bc.done++;
        continue;
      }
      r.state = "sending";
      try {
        if (!dryRun) rememberSent(await client.sendMessage(targets[i].id, body));
        r.state = "sent"; r.at = new Date().toISOString();
        bc.sent++;
      } catch (e) {
        r.state = "failed"; r.error = String((e && e.message) || e).slice(0, 160);
        bc.failed++;
      }
      bc.done++;
      if (i < targets.length - 1) {
        const gap = dryRun ? 20 : BROADCAST_GAP_MS + Math.floor(Math.random() * BROADCAST_GAP_MS);
        await new Promise((res) => setTimeout(res, gap));
      }
    }
    bc.running = false;
    bc.finishedAt = new Date().toISOString();
    step(`Broadcast${dryRun ? " (dry run)" : ""} finished: ${bc.sent} sent${bc.failed ? `, ${bc.failed} failed` : ""}`, bc.failed ? "warn" : "ok");
    if (origin === "group") {
      const failedNames = bc.results.filter((r) => r.state === "failed").map((r) => r.name);
      await replyInRelay(bc.failed
        ? `⚠️ Broadcast sent to ${bc.sent} of ${bc.total} chats. Failed: ${failedNames.slice(0, 10).join(", ")}${failedNames.length > 10 ? "…" : ""}`
        : `✅ Broadcast sent to ${bc.sent} chat${bc.sent === 1 ? "" : "s"}`, { dryRun });
    }
    runNextQueued();
  })().catch((e) => {
    bc.running = false;
    bc.finishedAt = new Date().toISOString();
    console.error("  [wa] broadcast crashed:", (e && e.message) || e);
  });

  return broadcastStatus();
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
        relaunch("claimed the session from another client", { force: true, delay: 2500 });
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
          // The raw model's key is authoritative; the serialised copy from
          // getMessageModel does not always carry _serialized, and a history
          // row without an id cannot be matched to its live copy or its edits.
          id: (m.id && (m.id._serialized || (typeof m.id.toString === "function" ? m.id.toString() : ""))) || x.id?._serialized || "",
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
// What is actually on the WhatsApp Web page right now. The "authenticated but
// never ready" hang is invisible from the outside -- the status says loading
// and nothing else is reported -- and the debug endpoint that should have
// answered it crashed whenever no groups were loaded, which is precisely when
// the hang happens. This answers it without needing a chat.
async function pageState() {
  if (!client || !client.pupPage) return { ok: false, why: "no browser" };
  if (!(await pageUsable())) return { ok: false, why: "page is dead or detached" };
  try {
    return await client.pupPage.evaluate(() => {
      const txt = (document.body.innerText || "").replace(/\s+/g, " ").trim();
      const has = (re) => re.test(txt);
      const btn = [...document.querySelectorAll("button,div[role=button]")]
        .map((b) => (b.innerText || "").trim()).filter(Boolean).slice(0, 12);
      return {
        ok: true,
        url: location.href,
        title: document.title,
        divs: document.querySelectorAll("div").length,
        // The single most common cause of the hang: another client holds the
        // session and WhatsApp is waiting for someone to choose.
        conflictDialog: has(/open in another window|Use here|use it here|another device/i),
        stillLoading: has(/Loading|Connecting|End-to-end encrypted|syncing/i),
        needsScan: Boolean(document.querySelector("div[data-ref]")),
        chatListPresent: Boolean(document.querySelector("#pane-side")),
        buttons: btn,
        text: txt.slice(0, 220),
      };
    });
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e).slice(0, 120) };
  }
}

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

// Today's messages are re-read on a timer and compared with what is saved.
// The live listener catches edits as they happen; this catches anything it
// missed -- an edit made while the server was restarting, or a message that
// arrived during a reconnect. It reads the chat already held in memory (no
// chat switching, no model calls) and only writes when something changed.
const RECHECK_MS = Number(process.env.RECHECK_TODAY_MS || 120_000);
function dubaiMidnightUnix() {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
  return Math.floor(new Date(`${d}T00:00:00+04:00`).getTime() / 1000);
}
async function recheckToday() {
  if (state.status !== "ready" || state.syncing || !client) return;
  if (!(await pageUsable())) return;
  for (const [tag, g] of [["C5", state.watching.c5], ["C3", state.watching.c3]]) {
    if (!g) continue;
    const known = state.groups.find((x) => x.name === g) ||
      state.groups.find((x) => String(x.name).toLowerCase() === String(g).toLowerCase());
    if (!known) continue;
    try {
      const { rows } = await historySince(known.id, dubaiMidnightUnix(), 5000);
      const r = upsert(g, rows.map((x) => toRecord(x.timestamp, x.sender, x.text, x.id)));
      state.lastRecheck = new Date().toISOString();
      if (r.edited) { state.edited = (state.edited || 0) + r.edited; step(`${tag} · ${g}: ${r.edited} message${r.edited === 1 ? "" : "s"} edited today — updated`); }
      if (r.added) { state.captured += r.added; step(`${tag} · ${g}: ${r.added} message${r.added === 1 ? "" : "s"} from today picked up on re-check`); }
    } catch (e) {
      console.error(`  [wa] re-check of ${g} failed:`, (e && e.message) || e);
    }
  }
}
function startRecheck() {
  const gen = generation;
  clearInterval(state.recheckTimer);
  state.recheckTimer = setInterval(() => {
    if (!isCurrent(gen)) return clearInterval(state.recheckTimer);
    recheckToday().catch(() => {});
  }, RECHECK_MS);
}

// Right after a device is linked, WhatsApp keeps copying history from the phone
// to it for several minutes, so the first pull only sees what has arrived so
// far. Measured: the C3 group returned 13 messages 20s after linking and 2,213
// a few minutes later; the group list grew from 128 to 330 over the same span.
// Pull once more after the copy has had time to land. Pulls only append new
// messages, so a second one never duplicates anything.
const CATCH_UP_MS = Number(process.env.CATCH_UP_PULL_MS || 180_000);
function scheduleCatchUpPull() {
  const gen = generation;
  clearTimeout(state.catchUpTimer);
  state.catchUpTimer = setTimeout(async () => {
    if (!isCurrent(gen) || state.status !== "ready" || state.syncing) return;
    step("Pulling again — WhatsApp copies older history to a new device for a few minutes after linking");
    await syncAll();
  }, CATCH_UP_MS);
}

// Opening a chat is asynchronous inside WhatsApp: the conversation is selected
// immediately but its messages arrive afterwards. Poll the message collection
// until it stops growing, so a pull never runs against a half-loaded chat.
async function waitForChatMessages(chatId, { settleMs = 700, maxMs = 15000 } = {}) {
  const count = async () => {
    try {
      return await client.pupPage.evaluate((id) => {
        const C = window.require("WAWebCollections");
        const WF = window.require("WAWebWidFactory");
        const chat = C.Chat.get(WF.createWid(id));
        if (!chat || typeof chat.msgs?.getModelsArray !== "function") return -1;
        return chat.msgs.getModelsArray().length;
      }, chatId);
    } catch {
      return -1;
    }
  };
  const deadline = Date.now() + maxMs;
  let last = await count();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const now = await count();
    if (now > last) { last = now; stableSince = Date.now(); continue; }
    // Settled, and there is something to work with.
    if (last > 1 && Date.now() - stableSince >= settleMs) break;
    // Nothing ever arrived: give it the full budget before giving up.
    if (last <= 1) stableSince = Date.now();
  }
  return last;
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

// Boot the browser in the background at startup. On a slow container Chrome
// takes ~60s to reach the QR, so doing it up front means the code is already
// waiting when the user opens the tab.
function prewarm() {
  if (process.env.WA_PREWARM === "0") return;
  setTimeout(() => {
    if (!client && state.status === "idle") {
      step("Warming up WhatsApp Web so the QR is ready…");
      try { start({ fresh: false }); } catch { /* non-fatal */ }
    }
  }, 1500);
}

// What Chromium are we actually about to run, and inside what memory limit?
function environmentInfo() {
  const p = process.env.PUPPETEER_EXECUTABLE_PATH;
  let chromium = "bundled (puppeteer)";
  if (p) {
    if (!fs.existsSync(p)) chromium = `MISSING at ${p} — falling back to bundled`;
    else {
      try {
        chromium = execFileSync(p, ["--version"], { encoding: "utf8" }).trim();
      } catch (e) {
        chromium = `${p} (version check failed: ${(e && e.message) || e})`;
      }
    }
  }
  const mem = containerMemory();
  return {
    platform: process.platform,
    arch: process.arch,
    chromium,
    memory: mem ? `container ${mem.used}/${mem.limit}` : "host (no cgroup limit)",
  };
}

module.exports = { profileOwner, releaseProfileLock, loadRelay, saveRelay, maybeRelay, listChats, loadTags, saveTags, broadcast, broadcastStatus, pageState, clearStaleProfileLockAsync, wipeSessionAsync, start, snapshot, backfill, syncAll, prewarm, environmentInfo, probeModules, tryHydrate, diagnoseHistoryInternals, historySince, openChatByName, inspectAfterOpen, setWatching, logout, send, refreshGroups, importExport, clearStaleProfileLock, wipeSession };
