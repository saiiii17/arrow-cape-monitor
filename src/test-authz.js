// A customer must never reach the owner's data.
//
// These tests take the adversary's side: they walk every route the server
// actually serves, try each one as a customer, and fail if anything that is not
// deliberately shared comes back allowed. The route list is read out of
// server.js rather than written here, so a route added tomorrow is covered by
// these tests without anyone remembering to update them.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "authz-test-"));
process.env.USERS_FILE = path.join(tmp, "users.json");

const authz = require("./authz");
const users = require("./users");

const ADMIN = { id: "a1", email: "owner@example.com", role: "admin", status: "active" };
const CUSTOMER = { id: "c1", email: "someone@example.com", role: "user", status: "active" };
const PENDING = { ...CUSTOMER, id: "c2", status: "pending" };
const SUSPENDED = { ...CUSTOMER, id: "c3", status: "suspended" };

// Every path the server compares against, straight from the source.
function routesInServer() {
  const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const found = new Set();
  for (const m of src.matchAll(/url\.pathname === "([^"]+)"/g)) found.add(m[1]);
  return [...found].sort();
}

// What a customer is meant to have. Everything else must be refused.
const SHARED = authz.SIGNED_IN;

(async () => {
  console.log("\nwhat a customer may reach");

  await test("every route the server serves is classified", () => {
    const routes = routesInServer();
    assert.ok(routes.length > 25, `expected to find the routes, found ${routes.length}`);
    for (const r of routes) {
      const lvl = authz.levelFor(r);
      assert.ok(["public", "user", "admin"].includes(lvl), `${r} has no level`);
    }
  });

  await test("a customer is refused every route except the broadcast tools", () => {
    const leaked = [];
    for (const route of routesInServer()) {
      const d = authz.decide(route, CUSTOMER);
      const meantToBeShared = SHARED.has(route) || authz.levelFor(route) === "public";
      if (d.allow && !meantToBeShared) leaked.push(route);
    }
    assert.deepStrictEqual(leaked, [], `a customer could reach: ${leaked.join(", ")}`);
  });

  // The specific things that would be a disaster.
  await test("the owner's reading of the broker's chats is closed to customers", () => {
    for (const route of ["/api/digest", "/api/digest/brief", "/api/dates", "/api/send"]) {
      assert.strictEqual(authz.decide(route, CUSTOMER).allow, false, route);
      assert.strictEqual(authz.decide(route, ADMIN).allow, true, `admin should still reach ${route}`);
    }
  });

  await test("the C3 extraction and vessel matches are closed to customers", () => {
    for (const route of ["/api/c3", "/api/c3/cached", "/api/c3/meta"]) {
      assert.strictEqual(authz.decide(route, CUSTOMER).allow, false, route);
      assert.strictEqual(authz.decide(route, ADMIN).allow, true, route);
    }
  });

  await test("a customer cannot touch which groups are captured, or pull history", () => {
    for (const route of ["/api/wa/watch", "/api/wa/groups", "/api/wa/sync", "/api/wa/backfill",
      "/api/wa/import", "/api/wa/restore", "/api/wa/debug"]) {
      assert.strictEqual(authz.decide(route, CUSTOMER).allow, false, route);
    }
  });

  await test("a customer cannot approve accounts, including their own", () => {
    for (const route of ["/api/users", "/api/users/status", "/api/users/delete"]) {
      assert.strictEqual(authz.decide(route, CUSTOMER).allow, false, route);
    }
  });

  await test("a customer cannot reach the admin's 2FA settings", () => {
    for (const route of ["/api/admin/2fa", "/api/admin/2fa/confirm"]) {
      assert.strictEqual(authz.decide(route, CUSTOMER).allow, false, route);
    }
  });

  console.log("\nwhat a customer does get");

  await test("the broadcast tools are open to a customer", () => {
    for (const route of ["/api/broadcast/chats", "/api/broadcast/lists", "/api/broadcast/send",
      "/api/broadcast/status", "/api/broadcast/recall", "/api/broadcast/upload",
      "/api/broadcast/preview", "/api/broadcast/relay", "/api/broadcast/tags"]) {
      assert.strictEqual(authz.decide(route, CUSTOMER).allow, true, `a customer needs ${route}`);
    }
  });

  await test("a customer can link and unlink their own WhatsApp", () => {
    for (const route of ["/api/wa/status", "/api/wa/start", "/api/wa/logout", "/api/wa/reset"]) {
      assert.strictEqual(authz.decide(route, CUSTOMER).allow, true, route);
    }
  });

  console.log("\ndeny by default");

  await test("a route nobody classified needs admin, so a new one cannot leak", () => {
    for (const invented of ["/api/secret", "/api/broadcast/../digest", "/api/c3/raw", "/api/anything"]) {
      assert.strictEqual(authz.levelFor(invented), "admin", invented);
      assert.strictEqual(authz.decide(invented, CUSTOMER).allow, false, invented);
    }
  });

  await test("nothing is reachable without an account except the public pages", () => {
    for (const route of routesInServer()) {
      const open = authz.decide(route, null).allow;
      assert.strictEqual(open, authz.levelFor(route) === "public",
        `${route} ${open ? "is open to" : "is closed to"} someone with no account`);
    }
  });

  await test("an account awaiting approval cannot reach anything", () => {
    for (const route of [...SHARED]) {
      assert.strictEqual(authz.decide(route, PENDING).allow, false, `pending reached ${route}`);
    }
  });

  await test("a suspended account cannot reach anything", () => {
    for (const route of [...SHARED]) {
      assert.strictEqual(authz.decide(route, SUSPENDED).allow, false, `suspended reached ${route}`);
    }
  });

  await test("the reason is reported, so the page can say what to do", () => {
    assert.strictEqual(authz.decide("/api/digest", null).why, "signin");
    assert.strictEqual(authz.decide("/api/digest", PENDING).why, "inactive");
    assert.strictEqual(authz.decide("/api/digest", CUSTOMER).why, "forbidden");
  });

  console.log("\naccounts");

  await test("a password is never stored, only a slow hash of it", () => {
    users.createUser({ email: "a@b.com", password: "longenough1", name: "A" });
    const raw = fs.readFileSync(process.env.USERS_FILE, "utf8");
    assert.ok(!raw.includes("longenough1"), "the password itself is in the file");
    assert.match(raw, /scrypt\$/, "expected a scrypt hash");
  });

  await test("a new account cannot sign in until it is approved", () => {
    const r = users.authenticate("a@b.com", "longenough1");
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /waiting to be approved/);
  });

  await test("once approved, the right password works and a wrong one does not", () => {
    const u = users.findByEmail("a@b.com");
    users.setStatus(u.id, "active");
    assert.strictEqual(users.authenticate("a@b.com", "longenough1").ok, true);
    assert.strictEqual(users.authenticate("a@b.com", "wrongwrong").ok, false);
  });

  await test("a missing account and a wrong password are indistinguishable", () => {
    const a = users.authenticate("nobody@nowhere.com", "whatever1");
    const b = users.authenticate("a@b.com", "whatever1");
    assert.strictEqual(a.reason, b.reason, "the wording should not reveal which accounts exist");
  });

  await test("a suspended account is refused with its own reason", () => {
    const u = users.findByEmail("a@b.com");
    users.setStatus(u.id, "suspended");
    assert.match(users.authenticate("a@b.com", "longenough1").reason, /suspended/);
    users.setStatus(u.id, "active");
  });

  await test("two accounts cannot share an email, whatever the capitals", () => {
    assert.throws(() => users.createUser({ email: "A@B.com", password: "longenough1" }), /already an account/);
  });

  await test("a short password is refused", () =>
    assert.throws(() => users.createUser({ email: "c@d.com", password: "short" }), /at least 8/));

  await test("the admin account cannot be suspended or deleted", () => {
    const admin = users.createUser({ email: "boss@x.com", password: "longenough1", role: "admin", status: "active" });
    assert.throws(() => users.setStatus(admin.id, "suspended"), /cannot be suspended/);
    assert.throws(() => users.remove(admin.id), /cannot be deleted/);
  });

  await test("what a handler sees never includes the hash or the 2FA secret", () => {
    const admin = users.findByEmail("boss@x.com");
    users.enableTotp(admin.id, users.newTotpSecret());
    const shown = JSON.stringify(users.list());
    assert.ok(!shown.includes("scrypt$"), "a password hash was exposed");
    assert.ok(!/"totpSecret"/.test(shown), "the 2FA secret was exposed");
    assert.match(shown, /"twoFactor":true/, "but whether 2FA is on should be visible");
  });

  console.log("\ntwo-factor, for the admin only");

  await test("a code from the shared secret is accepted", () => {
    const secret = users.newTotpSecret();
    const now = Date.now();
    assert.strictEqual(users.verifyTotp(secret, users.totpAt(secret, Math.floor(now / 30000)), { at: now }), true);
  });

  await test("a wrong code, a short code and an empty one are all refused", () => {
    const secret = users.newTotpSecret();
    for (const bad of ["000000", "12345", "", null, "abcdef"]) {
      assert.strictEqual(users.verifyTotp(secret, bad), false, String(bad));
    }
  });

  await test("a phone whose clock is a step out still works", () => {
    const secret = users.newTotpSecret();
    const now = Date.now();
    const step = Math.floor(now / 30000);
    assert.strictEqual(users.verifyTotp(secret, users.totpAt(secret, step - 1), { at: now }), true);
    assert.strictEqual(users.verifyTotp(secret, users.totpAt(secret, step + 1), { at: now }), true);
  });

  await test("a code from well outside the window is refused", () => {
    const secret = users.newTotpSecret();
    const now = Date.now();
    assert.strictEqual(users.verifyTotp(secret, users.totpAt(secret, Math.floor(now / 30000) - 10), { at: now }), false);
  });

  await test("another account's secret does not open the admin's", () => {
    const mine = users.newTotpSecret(), theirs = users.newTotpSecret();
    const step = Math.floor(Date.now() / 30000);
    assert.strictEqual(users.verifyTotp(mine, users.totpAt(theirs, step)), false);
  });

  await test("2FA is only ever asked of the admin", () => {
    const admin = users.findByEmail("boss@x.com");
    const customer = users.findByEmail("a@b.com");
    assert.strictEqual(users.needsTotp(admin), true);
    // Even if a customer somehow had a secret, they are not challenged: they
    // hold only their own lists, and a code they cannot receive locks them out.
    users.enableTotp(customer.id, users.newTotpSecret());
    assert.strictEqual(users.needsTotp(users.findById(customer.id)), false);
  });

  await test("the enrolment link is what an authenticator app expects", () => {
    const secret = users.newTotpSecret();
    const uri = users.totpUri(secret, "owner@example.com");
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.ok(uri.includes(`secret=${secret}`));
    assert.match(uri, /digits=6/);
    assert.match(uri, /period=30/);
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${n} tests\n`);
  process.exit(process.exitCode || 0);
})();
