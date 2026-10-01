// One WhatsApp worker per customer: starting them, routing to them, stopping
// the idle ones.
//
// Every customer's files live under their own directory, named by account id,
// and the worker is given those paths and no others. That is what makes the
// separation real rather than a promise: a customer's process is not told where
// the broker's chats are, so nothing it does can reach them.
//
// Workers are started when a customer first asks for anything and stopped again
// after a stretch of silence. A linked WhatsApp costs more than a gigabyte, so
// leaving fifty of them running for people who broadcast once a week would be
// paying for nothing.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

// Where customers' data lives. Deliberately a sibling of the broker's data
// rather than inside it, so a wrong path cannot land in his.
const USERS_DATA = process.env.USERS_DATA_DIR || path.join(__dirname, "..", "data", "customers");

// How long a worker may sit unused before it is closed. The login survives --
// the worker shuts down without unlinking -- so coming back is a reconnect, not
// a fresh QR scan.
const IDLE_MS = Number(process.env.WORKER_IDLE_MINUTES || 30) * 60_000;
const START_TIMEOUT_MS = Number(process.env.WORKER_START_TIMEOUT_MS || 30_000);

const workers = new Map(); // id -> { proc, port, secret, startedAt, lastUsed, starting }

// An account id becomes a directory name, so it must not be able to be one.
// Ids are generated as hex, but a hand-edited accounts file should not be able
// to point a worker at "../../data".
function dirFor(id) {
  const raw = String(id || "");
  // Refused, not cleaned up. Quietly stripping "../../data" down to "data"
  // would be safe but would also let two different accounts land in one folder,
  // and an id that is not what it should be is a bug worth seeing.
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(raw)) throw new Error("bad account id");
  const dir = path.join(USERS_DATA, raw);
  const root = path.resolve(USERS_DATA);
  if (!path.resolve(dir).startsWith(root + path.sep)) throw new Error("bad account id");
  return dir;
}

// Exactly what a worker is allowed to touch. Everything live.js can be pointed
// at is listed, so nothing falls back to a shared default.
function envFor(id, port, secret) {
  const dir = dirFor(id);
  fs.mkdirSync(path.join(dir, "live"), { recursive: true });
  fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
  return {
    ...process.env,
    WORKER_PORT: String(port),
    WORKER_SECRET: secret,
    WORKER_USER: String(id),

    WWEBJS_PATH: path.join(dir, "wwebjs"),
    LIVE_STORE_DIR: path.join(dir, "live"),
    UPLOAD_DIR: path.join(dir, "uploads"),
    BROADCAST_FILE: path.join(dir, "broadcast-targets.json"),
    LISTS_FILE: path.join(dir, "broadcast-lists.json"),
    RELAY_FILE: path.join(dir, "broadcast-relay.json"),
    LAST_BROADCAST_FILE: path.join(dir, "last-broadcast.json"),
    WATCH_FILE: path.join(dir, "watched-groups.json"),
    LINKED_FLAG: path.join(dir, "linked.flag"),

    // A customer's worker has no business reading the broker's chats or
    // spending his AI budget, so the keys are not passed down.
    ANTHROPIC_API_KEY: "",
    GROQ_API_KEY: "",
    C5_GROUP: "", C3_GROUP: "", CHAT_FILE: "", C3_CHAT_FILE: "",
    DATA_SOURCE: "live",
    // Their session broadcasts and nothing else, so it must not tell them to
    // go and choose C5 and C3 groups that do not exist for them.
    BROADCAST_ONLY: "1",
    // Customers do not get a prewarmed browser: one starts when they press
    // Connect, which is also when they are there to scan it.
    WA_PREWARM: "0",
  };
}

function start(id) {
  const existing = workers.get(id);
  if (existing) return existing.ready;

  const secret = crypto.randomBytes(24).toString("hex");
  const proc = spawn(process.execPath, [path.join(__dirname, "wa-worker.js")], {
    env: envFor(id, 0, secret),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const entry = { proc, port: 0, secret, startedAt: Date.now(), lastUsed: Date.now() };
  entry.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the WhatsApp worker did not start in time")), START_TIMEOUT_MS);
    let out = "";
    proc.stdout.on("data", (b) => {
      out += b.toString();
      // Its own lines, prefixed, so one log can be followed per customer.
      for (const line of out.split("\n").slice(0, -1)) {
        if (line.trim()) console.log(`  [${String(id).slice(0, 8)}] ${line.trim()}`);
      }
      out = out.split("\n").slice(-1)[0];
      const m = /worker-ready (\d+)/.exec(b.toString());
      if (m) { entry.port = Number(m[1]); clearTimeout(timer); resolve(entry); }
    });
    proc.stderr.on("data", (b) => console.error(`  [${String(id).slice(0, 8)}] ${String(b).trim().slice(0, 400)}`));
    proc.on("exit", (code) => {
      clearTimeout(timer);
      workers.delete(id);
      if (code) console.error(`  [${String(id).slice(0, 8)}] worker exited with ${code}`);
      reject(new Error("the WhatsApp worker stopped"));
    });
  });
  // A failure to start must not become an unhandled rejection; callers see it.
  entry.ready.catch(() => {});
  workers.set(id, entry);
  return entry.ready;
}

// Pass one request through to a customer's worker, starting it if need be.
async function proxy(id, req, res, pathname, search) {
  let entry;
  try { entry = await start(id); } catch (e) {
    res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: `WhatsApp is not available right now — ${e.message}` }));
    return;
  }
  entry.lastUsed = Date.now();

  await new Promise((resolve) => {
    const up = http.request({
      host: "127.0.0.1",
      port: entry.port,
      method: req.method,
      path: pathname + (search || ""),
      headers: {
        "content-type": req.headers["content-type"] || "application/json",
        "x-worker-secret": entry.secret,
      },
    }, (r) => {
      res.writeHead(r.statusCode || 500, {
        "Content-Type": r.headers["content-type"] || "application/json",
        "Cache-Control": "no-store",
      });
      r.pipe(res);
      r.on("end", resolve);
    });
    up.on("error", (e) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Could not reach your WhatsApp session — ${e.message}` }));
      resolve();
    });
    req.pipe(up);
  });
}

async function stop(id) {
  const entry = workers.get(id);
  if (!entry) return false;
  workers.delete(id);
  entry.proc.kill("SIGTERM");
  // Give it the time its own shutdown asks for, then insist.
  await new Promise((r) => setTimeout(r, 9000));
  try { entry.proc.kill("SIGKILL"); } catch { /* already gone */ }
  return true;
}

// Idle workers are closed, which frees well over a gigabyte each. Shutting one
// down does not unlink it, so the customer comes back to a reconnect.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of workers) {
    if (now - entry.lastUsed > IDLE_MS) {
      console.log(`  [${String(id).slice(0, 8)}] idle — closing the browser to free memory`);
      stop(id).catch(() => {});
    }
  }
}, 60_000);
if (sweeper.unref) sweeper.unref();

const running = () => [...workers.entries()].map(([id, e]) => ({
  id, port: e.port, startedAt: e.startedAt, lastUsed: e.lastUsed,
  upMinutes: Math.round((Date.now() - e.startedAt) / 60000),
}));

async function stopAll() {
  await Promise.all([...workers.keys()].map((id) => stop(id).catch(() => {})));
}

module.exports = { proxy, start, stop, stopAll, running, dirFor, envFor, USERS_DATA };
