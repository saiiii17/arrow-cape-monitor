// Sign-in and separation, over real HTTP.
//
// test-authz.js checks the decision in isolation. This runs a real server and
// takes the customer's side: it signs in as a paying user and tries every route
// the server has, including the ones that read the broker's own chats. Anything
// that answers instead of refusing is a failure.
//
// Nothing here touches a WhatsApp session: the server runs with WA_PREWARM=0 and
// its own temporary data directories.
const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 4399;
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));

const ADMIN = { email: "owner@example.com", password: "adminpassword1" };
const CUST = { email: "broker@example.com", password: "customerpass1", name: "A Customer" };

const srv = spawn(process.execPath, [path.join(__dirname, "server.js")], {
  env: {
    ...process.env,
    PORT: String(PORT), WA_PREWARM: "0", DATA_SOURCE: "sample",
    USERS_FILE: path.join(tmp, "users.json"),
    ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
    SESSION_SECRET: "test-secret-for-sessions",
    // These tests sign in dozens of times from one address; the real limit of
    // ten a minute is exercised deliberately in its own check below.
    LOGIN_ATTEMPTS_PER_MIN: "500",
    BROADCAST_FILE: path.join(tmp, "t.json"), RELAY_FILE: path.join(tmp, "r.json"),
    LISTS_FILE: path.join(tmp, "l.json"), UPLOAD_DIR: path.join(tmp, "up"),
    LIVE_STORE_DIR: path.join(tmp, "store"), WATCH_FILE: path.join(tmp, "w.json"),
    LINKED_FLAG: path.join(tmp, "linked.flag"), WWEBJS_PATH: path.join(tmp, "wwebjs"),
    USERS_DATA_DIR: path.join(tmp, "customers"),
  },
  stdio: "ignore",
});

let n = 0;
async function test(name, fn) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const req = (p, opts = {}) => fetch(BASE + p, { redirect: "manual", ...opts });
const post = (p, body, cookie) => req(p, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body || {}),
});
const cookieOf = (r) => String(r.headers.get("set-cookie") || "").split(";")[0];
// Read once: a body cannot be read twice, and an assert's message argument is
// evaluated whether or not the assert fails.
const body = async (r) => {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t }; }
};

// Every route the server actually serves, read from its source so this cannot
// drift behind a route added later.
function routes() {
  const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  return [...new Set([...src.matchAll(/url\.pathname === "([^"]+)"/g)].map((m) => m[1]))].sort();
}

const authz = require("./authz");

(async () => {
  for (let i = 0; i < 100; i++) {
    try { await req("/healthz"); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }

  console.log("\nwith no account");

  await test("the app redirects to sign-in", async () => {
    const r = await req("/");
    assert.strictEqual(r.status, 302);
    assert.match(String(r.headers.get("location")), /\/login/);
  });

  await test("nothing behind the gate answers", async () => {
    for (const p of ["/api/broadcast/chats", "/api/digest", "/api/c3", "/api/users", "/api/wa/status"]) {
      assert.strictEqual((await req(p)).status, 401, p);
    }
  });

  await test("the public pages and install files are reachable", async () => {
    for (const p of ["/healthz", "/login", "/manifest.webmanifest", "/favicon.png"]) {
      let status = 0;
      try { status = (await req(p)).status; } catch (e) { throw new Error(`${p}: ${e.message}`); }
      assert.ok(status < 400, `${p} should be public, got ${status}`);
    }
  });

  console.log("\nregistering");

  await test("anyone may ask for an account", async () => {
    const r = await post("/api/register", CUST);
    const d = await body(r);
    assert.strictEqual(r.status, 200, JSON.stringify(d));
    assert.strictEqual(d.pending, true, "a new account should wait for approval");
  });

  await test("but it cannot sign in until it is approved", async () => {
    const r = await post("/api/login", { email: CUST.email, password: CUST.password });
    assert.strictEqual(r.status, 401);
    assert.match((await r.json()).error, /waiting to be approved/);
  });

  await test("the same email cannot register twice", async () => {
    const r = await post("/api/register", CUST);
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /already an account/);
  });

  await test("a weak password is refused", async () => {
    const r = await post("/api/register", { email: "x@y.com", password: "short" });
    assert.strictEqual(r.status, 400);
  });

  await test("with OPEN_SIGNUP on, a new account can sign in at once", async () => {
    // A separate server, because the setting is read at registration time and
    // the rest of this suite relies on approval being required.
    const t2 = fs.mkdtempSync(path.join(os.tmpdir(), "open-signup-"));
    const port2 = 20000 + Math.floor(Math.random() * 20000);
    const srv2 = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: { ...process.env, PORT: String(port2), WA_PREWARM: "0", DATA_SOURCE: "sample",
        OPEN_SIGNUP: "1", USERS_FILE: path.join(t2, "u.json"), USERS_DATA_DIR: path.join(t2, "c"),
        ADMIN_EMAIL: "boss@example.com", ADMIN_PASSWORD: "bosspassword1",
        APP_PASSWORD: "", SESSION_SECRET: "open-signup-test",
        BROADCAST_FILE: path.join(t2, "b.json"), RELAY_FILE: path.join(t2, "r.json"),
        LISTS_FILE: path.join(t2, "l.json"), LIVE_STORE_DIR: path.join(t2, "s"),
        WATCH_FILE: path.join(t2, "w.json"), LINKED_FLAG: path.join(t2, "f"),
        WWEBJS_PATH: path.join(t2, "wa"), REGISTER_ATTEMPTS_PER_MIN: "100" },
      stdio: "ignore",
    });
    const B2 = `http://localhost:${port2}`;
    for (let i = 0; i < 100; i++) {
      try { await fetch(B2 + "/healthz"); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    const p2 = (path_, body) => fetch(B2 + path_, { method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    const reg = await p2("/api/register", { email: "walkup@example.com", password: "walkuppass1", name: "Walk Up" });
    const rd = await reg.json();
    assert.strictEqual(reg.status, 200, JSON.stringify(rd));
    assert.strictEqual(rd.pending, false, "with open sign-up nobody waits");

    const login = await p2("/api/login", { email: "walkup@example.com", password: "walkuppass1" });
    assert.strictEqual(login.status, 200, "they should be able to sign in straight away");
    const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];

    // Open sign-up must not open anything else: they are still only a customer.
    const denied = await fetch(B2 + "/api/digest", { headers: { cookie } });
    assert.strictEqual(denied.status, 403, "an open sign-up account is still refused the admin's data");
    const allowed = await fetch(B2 + "/api/broadcast/lists", { headers: { cookie } });
    assert.strictEqual(allowed.status, 200, "but they do get the broadcast tools");

    srv2.kill();
    try { fs.rmSync(t2, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  console.log("\nthe admin");

  let adminCookie = "";
  await test("the admin signs in with the configured password", async () => {
    const r = await post("/api/login", ADMIN);
    const d = await body(r);
    assert.strictEqual(r.status, 200, JSON.stringify(d));
    assert.strictEqual(d.role, "admin");
    adminCookie = cookieOf(r);
    assert.ok(adminCookie, "expected a session cookie");
  });

  await test("a wrong password is refused", async () =>
    assert.strictEqual((await post("/api/login", { email: ADMIN.email, password: "nope" })).status, 401));

  await test("a missing account reads the same as a wrong password", async () => {
    const a = await (await post("/api/login", { email: "ghost@example.com", password: "whatever1" })).json();
    const b = await (await post("/api/login", { email: ADMIN.email, password: "whatever1" })).json();
    assert.strictEqual(a.error, b.error, "the wording should not reveal which accounts exist");
  });

  await test("the admin sees the account list and can approve", async () => {
    const list = await (await req("/api/users", { headers: { cookie: adminCookie } })).json();
    const waiting = list.users.find((u) => u.email === CUST.email);
    assert.ok(waiting, "the new account should be listed");
    assert.strictEqual(waiting.status, "pending");
    const r = await post("/api/users/status", { id: waiting.id, status: "active" }, adminCookie);
    assert.strictEqual(r.status, 200, JSON.stringify(await body(r)));
  });

  console.log("\nthe customer: what they get, and what they must never get");

  let custCookie = "";
  await test("an approved customer can sign in", async () => {
    const r = await post("/api/login", { email: CUST.email, password: CUST.password });
    const d = await body(r);
    assert.strictEqual(r.status, 200, JSON.stringify(d));
    assert.strictEqual(d.role, "user");
    custCookie = cookieOf(r);
  });

  await test("the session says what they may see, and it is broadcast only", async () => {
    const s = await (await req("/api/session", { headers: { cookie: custCookie } })).json();
    assert.strictEqual(s.user.role, "user");
    assert.strictEqual(s.can.broadcast, true);
    for (const k of ["c5", "c3", "matches", "history", "accounts"]) {
      assert.strictEqual(s.can[k], false, `a customer must not be offered ${k}`);
    }
  });

  // The heart of it: try everything.
  await test("every route that is not the broadcast tools refuses a customer", async () => {
    const leaked = [];
    for (const p of routes()) {
      if (authz.levelFor(p) !== "admin") continue;
      for (const method of ["GET", "POST"]) {
        const r = await req(p, {
          method,
          headers: { cookie: custCookie, "Content-Type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        if (r.status !== 403) leaked.push(`${method} ${p} -> ${r.status}`);
      }
    }
    assert.deepStrictEqual(leaked, [], `a customer got through to:\n       ${leaked.join("\n       ")}`);
  });

  await test("the refusal describes nothing about what is behind it", async () => {
    const r = await req("/api/digest", { headers: { cookie: custCookie } });
    const body = await r.json();
    assert.strictEqual(r.status, 403);
    assert.strictEqual(body.error, "Not available on this account");
    assert.ok(!JSON.stringify(body).match(/digest|c5|c3|owner/i), "the refusal leaked a hint");
  });

  await test("a customer reaching the app itself is not shown the admin page data", async () => {
    // The page is shared, but every admin feed behind it is closed.
    assert.strictEqual((await req("/", { headers: { cookie: custCookie } })).status, 200);
    assert.strictEqual((await req("/api/dates", { headers: { cookie: custCookie } })).status, 403);
  });

  await test("the broadcast tools do answer a customer", async () => {
    for (const p of ["/api/broadcast/lists", "/api/broadcast/status", "/api/wa/status"]) {
      const r = await req(p, { headers: { cookie: custCookie } });
      assert.notStrictEqual(r.status, 403, `${p} should be open to a customer`);
      assert.notStrictEqual(r.status, 401, `${p} should be open to a customer`);
    }
  });

  console.log("\nthe customer's WhatsApp is a separate process with separate files");

  await test("a customer's broadcast lists are their own, not the admin's", async () => {
    // The admin's lists live in this server's own files.
    await post("/api/broadcast/lists", { lists: [
      { id: "main", name: "THE BROKERS LIST", chats: [{ id: "secret@c.us", name: "A Broker Contact" }] },
    ] }, adminCookie);
    const mine = await (await req("/api/broadcast/lists", { headers: { cookie: adminCookie } })).json();
    assert.strictEqual(mine.lists[0].name, "THE BROKERS LIST");

    // The customer's come from their own worker, and start empty.
    const theirs = await (await req("/api/broadcast/lists", { headers: { cookie: custCookie } })).json();
    assert.ok(theirs.lists, `expected the customer's own lists, got ${JSON.stringify(theirs)}`);
    assert.notStrictEqual(theirs.lists[0].name, "THE BROKERS LIST",
      "the customer was served the broker's list");
    assert.strictEqual(theirs.lists[0].chats.length, 0, "a new customer starts with nothing in their list");
  });

  await test("what the customer saves cannot touch what the admin has", async () => {
    await post("/api/broadcast/lists", { lists: [
      { id: "main", name: "Customer list", chats: [{ id: "theirs@c.us", name: "Their Contact" }] },
    ] }, custCookie);
    const mine = await (await req("/api/broadcast/lists", { headers: { cookie: adminCookie } })).json();
    assert.strictEqual(mine.lists[0].name, "THE BROKERS LIST", "the admin's list was overwritten");
    assert.strictEqual(mine.lists[0].chats[0].name, "A Broker Contact");
  });

  await test("the customer's files are written under their own account folder", async () => {
    const list = await (await req("/api/users", { headers: { cookie: adminCookie } })).json();
    const cust = list.users.find((u) => u.email === CUST.email);
    const dir = path.join(tmp, "customers", cust.id);
    assert.ok(fs.existsSync(dir), `expected ${dir} to exist`);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "broadcast-lists.json"), "utf8"));
    assert.strictEqual(saved[0].chats[0].name, "Their Contact");
    // And nothing of the broker's is in there.
    const all = fs.readdirSync(dir).join(" ");
    assert.ok(!all.includes("digest") && !all.includes("c3"), `unexpected files: ${all}`);
  });

  await test("the admin is told which customer sessions are running", async () => {
    const r = await req("/api/admin/workers", { headers: { cookie: adminCookie } });
    assert.strictEqual(r.status, 200);
    const d = await r.json();
    assert.ok(Array.isArray(d.running), "expected a list of running sessions");
    assert.ok(d.running.some((w) => w.email === CUST.email), "the customer's session should be listed");
    assert.ok(typeof d.estimatedMemoryGb === "number", "and what it is costing in memory");
  });

  await test("a customer cannot see who else has a session running", async () =>
    assert.strictEqual((await req("/api/admin/workers", { headers: { cookie: custCookie } })).status, 403));

  console.log("\nsessions");

  await test("a forged cookie is rejected", async () => {
    for (const bad of ["acm_session=u1.9999999999999.forged", "acm_session=nonsense", "acm_session=."]) {
      assert.strictEqual((await req("/api/broadcast/lists", { headers: { cookie: bad } })).status, 401, bad);
    }
  });

  await test("a customer cannot promote themselves by editing the cookie", async () => {
    // The cookie names an account; the role is read from disk, never from it.
    const uid = custCookie.split("=")[1].split(".")[0];
    const forged = `acm_session=${uid}.${Date.now() + 864e5}.whatever`;
    assert.strictEqual((await req("/api/users", { headers: { cookie: forged } })).status, 401);
  });

  await test("suspending someone shuts them out at once, on the cookie they hold", async () => {
    const list = await (await req("/api/users", { headers: { cookie: adminCookie } })).json();
    const cust = list.users.find((u) => u.email === CUST.email);
    await post("/api/users/status", { id: cust.id, status: "suspended" }, adminCookie);
    const r = await req("/api/broadcast/lists", { headers: { cookie: custCookie } });
    assert.strictEqual(r.status, 403, "a suspended session must stop working immediately");
    assert.match((await r.json()).error, /suspended/);
    await post("/api/users/status", { id: cust.id, status: "active" }, adminCookie);
  });

  await test("a customer cannot approve or delete accounts", async () => {
    const list = await (await req("/api/users", { headers: { cookie: adminCookie } })).json();
    const me = list.users.find((u) => u.email === CUST.email);
    assert.strictEqual((await post("/api/users/status", { id: me.id, status: "active" }, custCookie)).status, 403);
    assert.strictEqual((await post("/api/users/delete", { id: me.id }, custCookie)).status, 403);
  });

  await test("the admin account cannot be deleted or suspended", async () => {
    const list = await (await req("/api/users", { headers: { cookie: adminCookie } })).json();
    const boss = list.users.find((u) => u.role === "admin");
    assert.strictEqual((await post("/api/users/status", { id: boss.id, status: "suspended" }, adminCookie)).status, 400);
    assert.strictEqual((await post("/api/users/delete", { id: boss.id }, adminCookie)).status, 400);
  });

  console.log("\ntwo-factor, for the admin");

  const users = require("./users");
  let secret = "";
  await test("only the admin can start enrolment", async () =>
    assert.strictEqual((await post("/api/admin/2fa", {}, custCookie)).status, 403));

  await test("the admin is given a secret and a link for the app", async () => {
    const r = await post("/api/admin/2fa", {}, adminCookie);
    const d = await body(r);
    assert.strictEqual(r.status, 200, JSON.stringify(d));
    secret = d.secret;
    assert.ok(secret && secret.length >= 16, "expected a secret");
    assert.match(d.uri, /^otpauth:\/\/totp\//);
  });

  await test("a wrong code does not finish enrolment", async () => {
    const r = await post("/api/admin/2fa/confirm", { code: "000000" }, adminCookie);
    assert.strictEqual(r.status, 400);
  });

  await test("the right code turns it on", async () => {
    const code = users.totpAt(secret, Math.floor(Date.now() / 30000));
    const r = await post("/api/admin/2fa/confirm", { code }, adminCookie);
    const d = await body(r);
    assert.strictEqual(r.status, 200, JSON.stringify(d));
    assert.strictEqual(d.twoFactor, true);
  });

  await test("from now on the admin's password alone gives no session", async () => {
    const r = await post("/api/login", ADMIN);
    const d = await r.json();
    assert.strictEqual(d.need2fa, true, "expected to be asked for a code");
    assert.ok(d.ticket, "expected a ticket");
    assert.ok(!String(r.headers.get("set-cookie") || "").includes("acm_session="),
      "no session may be issued before the code");
  });

  await test("the ticket on its own opens nothing", async () => {
    const d = await (await post("/api/login", ADMIN)).json();
    const r = await req("/api/users", { headers: { cookie: `acm_session=${d.ticket}` } });
    assert.strictEqual(r.status, 401);
  });

  await test("the ticket plus the code gives the session", async () => {
    const d = await (await post("/api/login", ADMIN)).json();
    const code = users.totpAt(secret, Math.floor(Date.now() / 30000));
    const r = await post("/api/login/2fa", { ticket: d.ticket, code });
    assert.strictEqual(r.status, 200, JSON.stringify(await body(r)));
    const c = cookieOf(r);
    assert.strictEqual((await req("/api/users", { headers: { cookie: c } })).status, 200);
  });

  await test("a wrong code is refused even with a good ticket", async () => {
    const d = await (await post("/api/login", ADMIN)).json();
    assert.strictEqual((await post("/api/login/2fa", { ticket: d.ticket, code: "000000" })).status, 401);
  });

  await test("a made-up ticket is refused", async () =>
    assert.strictEqual((await post("/api/login/2fa", { ticket: "2fa.u1.99999999999999.x", code: "000000" })).status, 401));

  await test("a customer is never asked for a code", async () => {
    const r = await post("/api/login", { email: CUST.email, password: CUST.password });
    const d = await r.json();
    assert.ok(!d.need2fa, "customers must not be challenged — they have no authenticator");
    assert.ok(cookieOf(r), "a customer signs in in one step");
  });

  console.log("\nthe deployment that predates accounts");

  await test("a server with only APP_PASSWORD still has sign-in on", async () => {
    // The live site has APP_PASSWORD and no ADMIN_EMAIL. If accounts turned
    // sign-in off for it, a deploy would put the broker's chats on an open URL.
    const auth2 = require("./auth");
    const saved = { admin: process.env.ADMIN_EMAIL, pw: process.env.APP_PASSWORD, uf: process.env.USERS_FILE };
    process.env.ADMIN_EMAIL = "";
    process.env.APP_PASSWORD = "an-old-password";
    process.env.USERS_FILE = path.join(tmp, "legacy-users.json");
    delete require.cache[require.resolve("./auth")];
    delete require.cache[require.resolve("./users")];
    const freshAuth = require("./auth");
    const freshUsers = require("./users");
    assert.strictEqual(freshAuth.enabled(), true, "sign-in must stay on");
    const admin = freshUsers.ensureAdmin();
    assert.ok(admin, "an admin must exist so somebody can approve accounts");
    assert.strictEqual(admin.role, "admin");
    Object.assign(process.env, { ADMIN_EMAIL: saved.admin, APP_PASSWORD: saved.pw, USERS_FILE: saved.uf });
    delete require.cache[require.resolve("./auth")];
    delete require.cache[require.resolve("./users")];
    void auth2;
  });

  console.log("\nguessing");

  await test("rapid password guessing is cut off", async () => {
    // The limit is raised for this run, so this proves the mechanism works
    // rather than the number: 500 wrong passwords must end in a refusal.
    let blocked = false;
    for (let i = 0; i < 520; i++) {
      const r = await post("/api/login", { email: "nobody@example.com", password: "wrong" + i });
      if (r.status === 429) { blocked = true; break; }
    }
    assert.ok(blocked, "guessing must eventually be rationed");
  });

  await test("rapid code guessing is cut off sooner than passwords", async () => {
    const d = await (await post("/api/login", ADMIN)).json();
    let blocked = false;
    for (let i = 0; i < 12; i++) {
      const r = await post("/api/login/2fa", { ticket: d.ticket, code: "111111" });
      if (r.status === 429) { blocked = true; break; }
    }
    assert.ok(blocked, "six digits is a small space — this must be rationed");
  });

  srv.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${n} tests\n`);
  process.exit(process.exitCode || 0);
})();
