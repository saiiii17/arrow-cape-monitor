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
process.env.RELAY_FILE = path.join(tmp, "relay.json");
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

  console.log("\nbroadcast group (a message sent in one group goes to every tagged chat)");
  const SRC = "999@g.us";
  const now = () => Math.floor(Date.now() / 1000);
  const ev = (over = {}) => ({ chatId: SRC, fromMe: true, body: "Morning update", timestamp: now(), id: `m${Math.random()}`, kind: "new", ...over });
  const dry = { dryRun: true };

  await test("does nothing until a group is chosen and enabled", async () => {
    live.saveRelay({ sourceId: SRC, sourceName: "📣 Broadcast", enabled: false });
    assert.strictEqual(await live.maybeRelay(ev(), dry), "not-relay");
    assert.strictEqual(live.saveRelay({ sourceId: "", enabled: true }).enabled, false, "no group, cannot be enabled");
  });

  live.saveRelay({ sourceId: SRC, sourceName: "📣 Broadcast", enabled: true });
  live.saveTags([{ id: "a@g.us", name: "A" }, { id: SRC, name: "📣 Broadcast" }, { id: "b@g.us", name: "B" }]);

  await test("messages in other chats are ignored", async () =>
    assert.strictEqual(await live.maybeRelay(ev({ chatId: "a@g.us" }), dry), "not-relay"));
  await test("someone else posting in the group cannot broadcast from this account", async () =>
    assert.strictEqual(await live.maybeRelay(ev({ fromMe: false }), dry), "not-owner"));
  await test("editing a message does not send it again", async () =>
    assert.strictEqual(await live.maybeRelay(ev({ kind: "edit" }), dry), "edit"));
  await test("the app's own confirmations never trigger a broadcast", async () =>
    assert.strictEqual(await live.maybeRelay(ev({ body: "✅ Broadcast sent to 2 chats" }), dry), "own-reply"));
  await test("a message delivered late after a reconnect is not broadcast", async () =>
    assert.strictEqual(await live.maybeRelay(ev({ timestamp: now() - 3600 }), dry), "stale"));

  await test("the owner's message is broadcast — to every tagged chat except the group itself", async () => {
    assert.strictEqual(await live.maybeRelay(ev(), dry), "sent");
    const st = live.broadcastStatus();
    assert.strictEqual(st.origin, "group");
    assert.deepStrictEqual(st.results.map((r) => r.name), ["A", "B"], "the broadcast group is never a target");
    await waitDone();
  });

  await test("the same message seen twice is broadcast once", async () => {
    const e = ev();
    assert.strictEqual(await live.maybeRelay(e, dry), "sent");
    assert.strictEqual(await live.maybeRelay(e, dry), "duplicate");
    await waitDone();
  });

  await test("a second message while one is sending is queued, not dropped", async () => {
    assert.strictEqual(await live.maybeRelay(ev({ body: "first" }), dry), "sent");
    assert.strictEqual(await live.maybeRelay(ev({ body: "second" }), dry), "queued");
    await waitDone();
    for (let i = 0; i < 100 && live.broadcastStatus().text !== "second"; i++) await new Promise((r) => setTimeout(r, 10));
    await waitDone();
    assert.strictEqual(live.broadcastStatus().text, "second", "the queued message went out after the first");
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${n} tests\n`);
  process.exit(process.exitCode || 0);
})();
