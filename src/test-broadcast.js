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
process.env.LISTS_FILE = path.join(tmp, "lists.json");
process.env.UPLOAD_DIR = path.join(tmp, "uploads");
process.env.LAST_BROADCAST_FILE = path.join(tmp, "last-broadcast.json");
const live = require("./live");
const waitDone = async () => { for (let i = 0; i < 200 && live.broadcastStatus().running; i++) await new Promise((r) => setTimeout(r, 10)); };

(async () => {
  console.log("\nbroadcast");

  await test("refuses when the list is empty", () => rejects(live.broadcast("hi", { dryRun: true }), /No chats in/));

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

  console.log("\nsaved lists");

  await test("the old single list is migrated, never lost", () => {
    const lists = live.loadLists();
    assert.ok(lists.length >= 1);
    assert.ok(lists[0].chats.length, "the chats tagged before lists existed are still there");
  });

  await test("lists are kept apart, and a chat can sit in both", () => {
    const owners = { id: "own@g.us", name: "Owners" };
    const shared = { id: "both@g.us", name: "Shared" };
    live.saveLists([
      { id: "main", name: "Main list", chats: [shared] },
      { id: "l2", name: "Owners", chats: [owners, shared] },
    ]);
    const after = live.loadLists();
    assert.deepStrictEqual(after.map((l) => l.name), ["Main list", "Owners"]);
    assert.strictEqual(after[1].chats.length, 2);
    assert.strictEqual(live.getList("l2").name, "Owners");
  });

  await test("an unknown list id falls back to the first, it never sends nowhere", () =>
    assert.strictEqual(live.getList("does-not-exist").id, "main"));

  await test("a broadcast goes to the list it was asked for", async () => {
    const st = await live.broadcast("owners only", { dryRun: true, listId: "l2" });
    assert.strictEqual(st.listName, "Owners");
    assert.strictEqual(st.total, 2);
    await waitDone();
    assert.deepStrictEqual(live.broadcastStatus().results.map((r) => r.name), ["Owners", "Shared"]);
  });

  await test("deleting every list is refused — there is always one to send to", () => {
    live.saveLists([]);
    assert.ok(live.loadLists().length >= 1);
    live.saveLists([{ id: "main", name: "Main list", chats: [{ id: "a@g.us", name: "A" }, { id: "b@g.us", name: "B" }] }]);
  });

  console.log("\nattachments");

  await test("an image is stored and reported as an image", () => {
    const up = live.saveUpload(Buffer.from("89504e470d0a1a0a", "hex"), { name: "C5 chart.png", type: "image/png" });
    assert.strictEqual(up.isImage, true);
    assert.strictEqual(up.name, "C5 chart.png");
    assert.ok(up.mediaId.endsWith(".png"));
  });

  await test("an empty file is refused", () =>
    assert.throws(() => live.saveUpload(Buffer.alloc(0), { name: "x.png" }), /Empty/));

  await test("a file past the size cap is refused", () =>
    assert.throws(() => live.saveUpload(Buffer.alloc(17 * 1024 * 1024), { name: "big.png", type: "image/png" }), /the limit is/));

  await test("a stale or made-up attachment id is refused, not sent as nothing", () =>
    rejects(live.broadcast("see chart", { dryRun: true, mediaId: "../../etc/passwd" }), /no longer available/));

  await test("an attachment alone, with no text, is a valid broadcast", async () => {
    const up = live.saveUpload(Buffer.from("x"), { name: "note.pdf", type: "application/pdf" });
    const st = await live.broadcast("", { dryRun: true, mediaId: up.mediaId });
    assert.strictEqual(st.mediaId, up.mediaId);
    await waitDone();
  });

  console.log("\nrecall");

  await test("recalling a dry run refuses — nothing real was ever sent", () =>
    rejects(live.recallBroadcast({ dryRun: true }), /Nothing left to recall/));

  // Recall is meant to survive a server restart, so this runs it the way it
  // really happens: a fresh process reading the last broadcast back off disk.
  await test("after a restart the last broadcast can still be recalled, once", () => {
    const lastFile = path.join(tmp, "last-broadcast.json");
    fs.writeFileSync(lastFile, JSON.stringify({
      id: 1, dryRun: false, origin: "app", text: "sent before the restart",
      listName: "Main list", total: 2, done: 2, sent: 2, failed: 0,
      results: [
        { id: "a@g.us", name: "A", state: "sent", messageId: "false_a" },
        { id: "b@g.us", name: "B", state: "sent", messageId: "false_b" },
      ],
    }));
    const child = `const l=require(${JSON.stringify(path.join(__dirname, "live.js"))});(async()=>{
      const a=await l.recallBroadcast({dryRun:true});
      let second="";
      try{ await l.recallBroadcast({dryRun:true}); }catch(e){ second=e.message; }
      console.log(JSON.stringify({states:a.results.map(r=>r.state),count:a.recalledCount,second}));
      process.exit(0);})()`;
    const out = require("child_process").execFileSync(process.execPath, ["-e", child], {
      env: { ...process.env, LAST_BROADCAST_FILE: lastFile }, encoding: "utf8",
    });
    const d = JSON.parse(out.trim().split("\n").pop());
    assert.deepStrictEqual(d.states, ["recalled", "recalled"], "every chat shows as recalled");
    assert.strictEqual(d.count, 2);
    assert.match(d.second, /already deleted/, "a second recall finds nothing left");
    // A dry run must leave the saved record alone, or a rehearsal would make
    // the real Recall button think the work was already done.
    assert.doesNotMatch(fs.readFileSync(lastFile, "utf8"), /recalled/, "a dry run does not touch the saved record");
  });

  console.log("\nwhat a failed chat says");

  await test("WhatsApp's internal wording never reaches the screen", () => {
    const real = "Data passed to getter must include an id property (it's how we memoize) but got undefined s (https://static.whatsapp.net/rsrc.php/v4/yy/r/UQbmAgZct11.js:85:180)";
    const said = live.sendErrorText(new Error(real));
    assert.ok(!/memoize|getter|rsrc\.php/.test(said), `still quoting WhatsApp: ${said}`);
    assert.match(said, /untick and tick it again/, "and it says what to do about it");
  });

  await test("an ordinary failure is still reported as it happened", () => {
    const said = live.sendErrorText(new Error("Phone is disconnected"));
    assert.strictEqual(said, "Phone is disconnected");
  });

  await test("a runaway message is trimmed, not pasted whole", () =>
    assert.ok(live.sendErrorText(new Error("x".repeat(500))).length <= 160));

  console.log("\ncaps and pacing");

  await test("a list longer than the cap is refused before a single message goes out", async () => {
    live.saveLists([{ id: "main", name: "Main list", chats:
      [1, 2, 3, 4].map((i) => ({ id: `cap${i}@g.us`, name: "Cap " + i })) }]);
    await rejects(live.broadcast("too many", { dryRun: true }), /the limit is 3/);
  });

  await test("chats are sent one at a time, with a gap between them", async () => {
    live.saveLists([{ id: "main", name: "Main list", chats:
      [1, 2, 3].map((i) => ({ id: `p${i}@g.us`, name: "P" + i })) }]);
    const t0 = Date.now();
    await live.broadcast("paced", { dryRun: true });
    const seen = [];
    while (live.broadcastStatus().running) {
      seen.push(live.broadcastStatus().results.filter((r) => r.state === "sending").length);
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(Math.max(...seen, 0) <= 1, "never two in flight at once");
    assert.ok(Date.now() - t0 >= 20, "there is a pause between chats");
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${n} tests\n`);
  process.exit(process.exitCode || 0);
})();
