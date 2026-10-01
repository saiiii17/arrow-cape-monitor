// A customer's WhatsApp runs in its own process, holding only its own files.
//
// test-authz.js proves a customer is refused the broker's routes. This proves
// the stronger thing: even if that check were wrong, a customer's process has no
// path to the broker's data. It is given its own directories and nothing else,
// so there is nothing there to reach.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let n = 0;
const test = (name, fn) => {
  n++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workers-test-"));
process.env.USERS_DATA_DIR = path.join(tmp, "customers");

// What the broker's own deployment has set. A worker must inherit none of it.
process.env.ANTHROPIC_API_KEY = "fake-anthropic-key-for-tests";
process.env.GROQ_API_KEY = "fake-groq-key-for-tests";
process.env.C5_GROUP = "EXAMPLE GROUP ONE";
process.env.C3_GROUP = "EXAMPLE GROUP TWO";
process.env.LIVE_STORE_DIR = "/the/brokers/live";
process.env.WWEBJS_PATH = "/the/brokers/wwebjs";
process.env.LISTS_FILE = "/the/brokers/lists.json";
process.env.BROADCAST_FILE = "/the/brokers/targets.json";
process.env.LINKED_FLAG = "/the/brokers/linked.flag";

const workers = require("./workers");

const A = "ua1111111111111111";
const B = "ub2222222222222222";

console.log("\neach customer gets their own directories");

test("a worker is pointed at its own folder, named for the account", () => {
  const env = workers.envFor(A, 1234, "secret");
  const dir = workers.dirFor(A);
  for (const key of ["LIVE_STORE_DIR", "WWEBJS_PATH", "UPLOAD_DIR", "LISTS_FILE",
    "BROADCAST_FILE", "RELAY_FILE", "LAST_BROADCAST_FILE", "WATCH_FILE", "LINKED_FLAG"]) {
    assert.ok(env[key], `${key} must be set, never left to a default`);
    assert.ok(env[key].startsWith(dir), `${key} points outside the customer's folder: ${env[key]}`);
  }
});

test("no path of the broker's survives into a customer's worker", () => {
  const env = workers.envFor(A, 1234, "secret");
  const leaked = Object.entries(env)
    .filter(([, v]) => typeof v === "string" && v.includes("/the/brokers/"))
    .map(([k]) => k);
  assert.deepStrictEqual(leaked, [], `the broker's paths reached a customer: ${leaked.join(", ")}`);
});

test("two customers are never given the same folder", () => {
  const a = workers.envFor(A, 1, "x");
  const b = workers.envFor(B, 2, "y");
  for (const key of ["LIVE_STORE_DIR", "WWEBJS_PATH", "LISTS_FILE", "UPLOAD_DIR"]) {
    assert.notStrictEqual(a[key], b[key], `${key} is shared between two customers`);
  }
  assert.ok(!a.LIVE_STORE_DIR.startsWith(b.LIVE_STORE_DIR));
  assert.ok(!b.LIVE_STORE_DIR.startsWith(a.LIVE_STORE_DIR));
});

test("the folder is created, and only inside the customers directory", () => {
  workers.envFor(A, 1, "x");
  const dir = workers.dirFor(A);
  assert.ok(fs.existsSync(path.join(dir, "live")));
  assert.ok(path.resolve(dir).startsWith(path.resolve(workers.USERS_DATA) + path.sep));
});

console.log("\nan account id cannot be used to escape");

test("a id that tries to climb out is refused", () => {
  for (const bad of ["../../data", "..", "../", "a/../../..", "/etc", "", "x"]) {
    assert.throws(() => workers.dirFor(bad), /bad account id/, JSON.stringify(bad));
  }
});

test("anything that is not a plain id is refused, not cleaned up", () => {
  // Stripping would be safe but would let two different accounts share a
  // folder, and an id that is not what it should be is worth seeing.
  for (const bad of ["ab$c/../def", "a b", "id;rm -rf", "émile", "a".repeat(65)]) {
    assert.throws(() => workers.dirFor(bad), /bad account id/, JSON.stringify(bad));
  }
  // A real id, as the accounts file generates them, is accepted.
  assert.ok(workers.dirFor("u0123456789abcdef").endsWith("u0123456789abcdef"));
});

console.log("\nwhat a customer's worker is not given");

test("the broker's AI keys are not passed down", () => {
  const env = workers.envFor(A, 1, "x");
  assert.strictEqual(env.ANTHROPIC_API_KEY, "", "a customer could spend the broker's AI budget");
  assert.strictEqual(env.GROQ_API_KEY, "");
});

test("the broker's group names are not passed down", () => {
  const env = workers.envFor(A, 1, "x");
  assert.strictEqual(env.C5_GROUP, "");
  assert.strictEqual(env.C3_GROUP, "");
  assert.strictEqual(env.CHAT_FILE, "");
  assert.strictEqual(env.C3_CHAT_FILE, "");
});

test("a customer's worker holds a secret of its own", () => {
  const a = workers.envFor(A, 1, "secret-a");
  const b = workers.envFor(B, 2, "secret-b");
  assert.strictEqual(a.WORKER_SECRET, "secret-a");
  assert.notStrictEqual(a.WORKER_SECRET, b.WORKER_SECRET);
});

console.log("\nthe worker itself");

test("it refuses to start without a secret", () => {
  const src = fs.readFileSync(path.join(__dirname, "wa-worker.js"), "utf8");
  assert.match(src, /refusing to start without WORKER_SECRET/);
  assert.match(src, /127\.0\.0\.1/, "it must listen on localhost only");
});

test("it serves no route that reads the broker's work", () => {
  const src = fs.readFileSync(path.join(__dirname, "wa-worker.js"), "utf8");
  for (const forbidden of ["/api/digest", "/api/c3", "/api/dates", "/api/wa/backfill",
    "/api/wa/watch", "/api/wa/import", "/api/users"]) {
    assert.ok(!src.includes(`"${forbidden}"`), `the worker exposes ${forbidden}`);
  }
});

test("it checks the secret in constant time", () => {
  const src = fs.readFileSync(path.join(__dirname, "wa-worker.js"), "utf8");
  assert.match(src, /timingSafeEqual/);
});

test("closing an idle worker does not unlink the customer", () => {
  const src = fs.readFileSync(path.join(__dirname, "wa-worker.js"), "utf8");
  const shutdown = src.slice(src.indexOf("for (const sig of"));
  assert.match(shutdown, /live\.shutdown\(\)/, "it must close the browser, not log out");
  assert.ok(!/logout\(\s*\)/.test(shutdown), "a stop must never unlink a customer's number");
});

console.log("\nthe server sends customers to their worker, never to the broker's session");

test("customer traffic is proxied, and the admin's is not", () => {
  const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const routing = src.slice(src.indexOf("const isAdmin ="), src.indexOf("const isAdmin =") + 900);
  assert.match(routing, /!isAdmin/, "the admin must stay in this process");
  assert.match(routing, /workers\.proxy\(who\.id/, "a customer's id decides which worker, never anything from the request");
  assert.match(routing, /\/api\/wa\/|\/api\/broadcast\//);
});

test("the worker is chosen by the session, never by anything the caller sends", () => {
  const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const call = /workers\.proxy\(([^)]*)\)/.exec(src);
  assert.ok(call, "expected the proxy call");
  assert.match(call[1], /^who\.id/, `the worker is picked from: ${call[1]}`);
  assert.ok(!/url\.searchParams|req\.headers|body/.test(call[1]),
    "the account must come from the session alone");
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${n} tests\n`);
process.exit(process.exitCode || 0);
