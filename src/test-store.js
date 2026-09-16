// Unlink must not destroy captured messages. WhatsApp pushes only a small
// recent window to a newly linked device, so anything older exists ONLY in
// this store -- a re-pull after unlinking came back with one message where the
// store had held fourteen, and truthfully reported "nothing earlier in this
// group". Deleting it on a button labelled "clear" loses it for good.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let n = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// Point the store at a scratch directory for the duration of the test.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-test-"));
process.env.LIVE_STORE_DIR = tmp;
delete require.cache[require.resolve("./livestore")];
const store = require("./livestore");

const MSGS = [
  { date: "2026-09-06", time: "16:17", minutes: 977, sender: "Oly", body: "RIO C5 170/10" },
  { date: "2026-09-08", time: "22:39", minutes: 1359, sender: "Oly", body: "FMG C5 180/10" },
];

console.log("\nunlink must not destroy captured messages");

test("clearAll archives what it removes", () => {
  store.append("Work", MSGS);
  const before = store.load("Work").length;
  assert.strictEqual(before, 2, "setup: two messages stored");
  const r = store.clearAll();
  assert.strictEqual(r.archived, 2, `archived ${r.archived}, expected 2`);
  assert.strictEqual(store.load("Work").length, 0, "live store is cleared");
});

test("restoreLatest brings them back", () => {
  const r = store.restoreLatest();
  assert.strictEqual(r.restored, 2, `restored ${r.restored}, expected 2`);
  const back = store.load("Work");
  assert.strictEqual(back.length, 2);
  assert.deepStrictEqual(back.map((m) => m.body).sort(), MSGS.map((m) => m.body).sort());
});

test("restore merges rather than overwriting newer capture", () => {
  store.append("Work", [{ date: "2026-09-20", time: "09:00", minutes: 540, sender: "Oly", body: "BHP C5 160/10" }]);
  store.clearAll();
  store.append("Work", [{ date: "2026-09-21", time: "10:00", minutes: 600, sender: "Oly", body: "newer capture" }]);
  store.restoreLatest();
  const bodies = store.load("Work").map((m) => m.body);
  assert.ok(bodies.includes("newer capture"), "messages captured after the clear survive");
  assert.ok(bodies.includes("BHP C5 160/10"), "archived messages come back");
});

test("clearing an empty store archives nothing", () => {
  store.clearAll();
  const r = store.clearAll();
  assert.strictEqual(r.archived, 0);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${n} tests\n`);
