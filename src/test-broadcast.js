// Broadcast: one message to every tagged chat. These run the real send loop in
// dry-run mode, so nothing is ever sent to anyone.
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
const rejects = async (p, re) => {
  try { await p; } catch (e) { assert.match(e.message, re); return; }
  throw new Error("expected it to refuse");
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bc-test-"));
process.env.BROADCAST_FILE = path.join(tmp, "tags.json");
process.env.BROADCAST_MAX = "3";
const live = require("./live");
const waitDone = async () => { for (let i = 0; i < 200 && live.broadcastStatus().running; i++) await new Promise((r) => setTimeout(r, 10)); };

(async () => {
  console.log("\nbroadcast");

  await test("refuses when nothing is tagged", () => rejects(live.broadcast("hi", { dryRun: true }), /No chats tagged/));

  await test("tags are saved by id, de-duplicated, and groups recognised", () => {
    const saved = live.saveTags([
      { id: "111@g.us", name: "Brokers" },
      { id: "111@g.us", name: "Brokers again" },
      { id: "971500000000@c.us", name: "the owner" },
      { name: "no id" },
    ]);
    assert.strictEqual(saved.length, 2);
    assert.strictEqual(saved[0].isGroup, true);
    assert.strictEqual(saved[1].isGroup, false);
    assert.strictEqual(live.loadTags().length, 2, "persisted to disk");
  });

  await test("refuses an empty message", () => rejects(live.broadcast("   ", { dryRun: true }), /Type a message/));

  await test("refuses to really send while WhatsApp is not connected", () =>
    rejects(live.broadcast("hi"), /not connected/));

  await test("sends to every tagged chat, one at a time", async () => {
    const st = await live.broadcast("Morning — C5 update attached", { dryRun: true });
    assert.strictEqual(st.total, 2);
    await waitDone();
    const done = live.broadcastStatus();
    assert.strictEqual(done.running, false);
    assert.deepStrictEqual([done.sent, done.failed], [2, 0]);
    assert.deepStrictEqual(done.results.map((r) => r.state), ["sent", "sent"]);
  });

  await test("a second broadcast cannot start while one is sending", async () => {
    live.saveTags([{ id: "a@g.us", name: "A" }, { id: "b@g.us", name: "B" }, { id: "c@g.us", name: "C" }]);
    const first = live.broadcast("one", { dryRun: true });
    await first;
    await rejects(live.broadcast("two", { dryRun: true }), /already sending/);
    await waitDone();
  });

  await test("refuses more chats than the per-broadcast limit", async () => {
    live.saveTags([1, 2, 3, 4].map((i) => ({ id: `${i}@g.us`, name: `G${i}` })));
    await rejects(live.broadcast("hi", { dryRun: true }), /limit is 3/);
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${n} tests\n`);
  process.exit(process.exitCode || 0);
})();
