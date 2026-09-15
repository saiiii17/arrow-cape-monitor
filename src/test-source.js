const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

let n = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// Point the live store at a scratch directory so these tests never touch real data.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "livestore-"));
const livestorePath = require.resolve("./livestore");
const orig = fs.readFileSync(livestorePath, "utf8");
delete require.cache[livestorePath];
const livestore = require("./livestore");
// Redirect by monkey-patching the module's DIR through its file() helper.
const realFile = livestore.file;
const store = new Map();
livestore.load = (g) => store.get(g) || [];
const source = require("./source");
const SAMPLE = [{ date: "2026-09-03", time: "10:00", minutes: 600, sender: "Oly", body: "sample" }];

console.log("\nsource selection (the only-the-linked-account rule)");

test("nothing linked, no live data -> sample", () => {
  process.env.WA_LINKED = "";
  const r = source.resolve(SAMPLE, "Work");
  assert.strictEqual(r.source, "sample");
  assert.strictEqual(r.messages, SAMPLE);
});

test("linked with no messages yet -> live (empty), never sample", () => {
  process.env.WA_LINKED = "1";
  process.env.WA_CONNECTED = "1";
  const r = source.resolve(SAMPLE, "Work");
  assert.strictEqual(r.source, "live");
  assert.strictEqual(r.messages.length, 0);
  assert.ok(r.empty);
  assert.ok(/no messages yet/.test(source.label(r)), source.label(r));
  process.env.WA_CONNECTED = "";
});

test("before connecting, the owner's exports are shown -- not a previous session's data", () => {
  // The dashboard must have something real on it before anyone scans a QR,
  // and a stale echo of whoever linked last is not it.
  process.env.WA_LINKED = ""; process.env.WA_CONNECTED = "";
  store.set("Work", [{ date: "2026-09-08", time: "22:39", minutes: 1359, sender: "Me", body: "leftover" }]);
  const r = source.resolve(SAMPLE, "Work");
  assert.strictEqual(r.source, "sample");
  assert.strictEqual(r.messages, SAMPLE);
  assert.ok(!r.messages.some((m) => m.body === "leftover"), "last session's messages must not leak in");
  assert.ok(/the owner's exports/.test(source.label(r)), source.label(r));
});

test("once linked, live data only -- sample excluded", () => {
  process.env.WA_LINKED = "1";
  store.set("Work", [{ date: "2026-09-08", time: "16:17", minutes: 977, sender: "Me", body: "RIO C5" }]);
  const r = source.resolve(SAMPLE, "Work");
  assert.strictEqual(r.source, "live");
  assert.strictEqual(r.messages.length, 1);
  assert.ok(!r.messages.some((m) => m.body === "sample"), "sample rows must not leak in");
  process.env.WA_CONNECTED = "1";
  assert.ok(/LIVE/.test(source.label(r)), source.label(r));
  process.env.WA_CONNECTED = ""; process.env.WA_LINKED = "";
});

test("linked but mid-reconnect is 'saved', never 'LIVE'", () => {
  process.env.WA_LINKED = "1"; process.env.WA_CONNECTED = "";
  store.set("Work", [{ date: "2026-09-08", time: "22:39", minutes: 1359, sender: "Me", body: "RIO C5" }]);
  const l = source.label(source.resolve(SAMPLE, "Work"));
  assert.ok(/saved \(not connected\)/.test(l), l);
  assert.ok(!/LIVE/.test(l), l);
  process.env.WA_LINKED = "";
});

test("cache namespace differs between sample and each live group", () => {
  process.env.WA_LINKED = "";
  const a = source.cacheKey(source.resolve(SAMPLE, "Nope"));
  process.env.WA_LINKED = "1";
  const b = source.cacheKey(source.resolve(SAMPLE, "Work"));
  const c = source.cacheKey(source.resolve(SAMPLE, "Chelsea OSC Chennai"));
  assert.strictEqual(a, "sample");
  assert.notStrictEqual(b, a);
  assert.notStrictEqual(b, c);
});

test("DATA_SOURCE=sample forces the sample even when linked", () => {
  process.env.WA_LINKED = "1";
  process.env.DATA_SOURCE = "sample";
  assert.strictEqual(source.resolve(SAMPLE, "Work").source, "sample");
  delete process.env.DATA_SOURCE;
});

process.env.WA_LINKED = "";
console.log(`\n${n} tests\n`);
