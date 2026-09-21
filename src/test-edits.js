// Edited messages and today's re-check. A message edited in WhatsApp must
// replace the saved text, not sit next to it as a second message; nothing
// already saved may be lost along the way; and re-extracting today for C3 must
// only pay for the batch that actually changed.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let n = 0;
async function test(name, fn) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edits-test-"));
process.env.LIVE_STORE_DIR = tmp;
delete require.cache[require.resolve("./livestore")];
const store = require("./livestore");
const rec = (id, body, time = "10:00") =>
  ({ date: "2026-09-21", time, minutes: 600, sender: "Oly", body, live: true, ...(id ? { id } : {}) });

(async () => {
  console.log("\nedited messages");

  await test("an edit replaces the text instead of adding a message", () => {
    store.upsert("E", [rec("M1", "RIO C5 170/10")]);
    const r = store.upsert("E", [rec("M1", "RIO C5 180/10")]);
    assert.deepStrictEqual([r.added, r.edited], [0, 1]);
    const rows = store.load("E");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].body, "RIO C5 180/10");
    assert.strictEqual(rows[0].originalBody, "RIO C5 170/10", "the first text is kept");
    assert.strictEqual(rows[0].edited, true);
  });

  await test("a second edit keeps the ORIGINAL text, not the previous edit", () => {
    store.upsert("E", [rec("M1", "RIO C5 190/10")]);
    const row = store.load("E")[0];
    assert.strictEqual(row.body, "RIO C5 190/10");
    assert.strictEqual(row.originalBody, "RIO C5 170/10");
  });

  await test("re-reading an unchanged message changes nothing", () => {
    const r = store.upsert("E", [rec("M1", "RIO C5 190/10")]);
    assert.deepStrictEqual([r.added, r.edited], [0, 0]);
  });

  await test("an edit changes the store revision, so the dashboard refreshes", async () => {
    const before = store.stats("E").rev;
    await new Promise((r) => setTimeout(r, 20));
    store.upsert("E", [rec("M1", "RIO C5 200/10")]);
    assert.notStrictEqual(store.stats("E").rev, before);
    assert.strictEqual(store.stats("E").count, 1);
  });

  await test("an edit to a row saved before ids existed is adopted, then tracked", () => {
    store.upsert("L", [rec(null, "FMG C5 160/10")]);          // legacy
    store.upsert("L", [rec("X1", "FMG C5 160/10")]);          // pull matches it to its id
    const r = store.upsert("L", [rec("X1", "FMG C5 165/10")]); // then it is edited
    assert.strictEqual(r.edited, 1);
    assert.strictEqual(store.load("L").length, 1);
  });

  await test("a message without an id does not duplicate one saved with its id", () => {
    store.upsert("I", [rec("Z1", "RIO C5 190/10", "21:14")]);   // live, with id
    const r = store.upsert("I", [rec(null, "RIO C5 190/10", "21:14")]); // export / id-less pull
    assert.strictEqual(r.added, 0);
    assert.strictEqual(store.load("I").length, 1);
  });

  console.log("\nrestore never removes what is already saved");

  await test("genuine repeats already in the file survive a restore", () => {
    const f = store.file("R");
    fs.writeFileSync(f, [rec(null, "😂"), rec(null, "😂")].map((x) => JSON.stringify(x)).join("\n") + "\n");
    store.restoreLatest();
    assert.strictEqual(store.load("R").length, 2, "both identical messages are kept");
  });

  console.log("\nC3 re-extraction pays only for what changed");

  await test("one new message re-extracts one batch, not the day", async () => {
    let calls = 0;
    const llm = require.resolve("./c3/llm");
    require.cache[llm] = { id: llm, filename: llm, loaded: true,
      exports: { completeJson: async () => { calls++; return { records: [] }; }, usage: {} } };
    delete require.cache[require.resolve("./c3/extract")];
    const { extractDay } = require("./c3/extract");

    const day = Array.from({ length: 12 }, (_, i) =>
      ({ date: "2026-09-21", time: `10:${String(i).padStart(2, "0")}`, minutes: 600 + i, sender: "Oly", body: `msg ${i}` }));
    const mem = {};
    const batchCache = { get: (t) => mem[t], set: (t, v) => { mem[t] = v; } };

    await extractDay(day, { batchSize: 6, batchCache });
    assert.strictEqual(calls, 2, "first run: two batches");
    await extractDay([...day, { ...day[0], time: "11:00", minutes: 660, body: "msg new" }], { batchSize: 6, batchCache });
    assert.strictEqual(calls, 3, "second run: only the new third batch");
    const edited = day.map((m, i) => (i === 3 ? { ...m, body: "msg 3 edited" } : m));
    await extractDay(edited, { batchSize: 6, batchCache });
    assert.strictEqual(calls, 4, "an edit re-extracts only its own batch");
    delete require.cache[llm];
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${n} tests\n`);
})();
