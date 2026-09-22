// Sign-in: with APP_PASSWORD set, nothing but the login, the install files and
// the health check is reachable without a session -- above all, not the chats
// and not broadcast. Starts a real server on a spare port (no WhatsApp).
const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 4399;
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
const srv = spawn(process.execPath, [path.join(__dirname, "server.js")], {
  env: { ...process.env, APP_PASSWORD: "correct horse", PORT: String(PORT), WA_PREWARM: "0",
         DATA_SOURCE: "sample", BROADCAST_FILE: path.join(tmp, "t.json"), RELAY_FILE: path.join(tmp, "r.json") },
  stdio: "ignore",
});

let n = 0;
async function test(name, fn) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
const req = (p, opts = {}) => fetch(BASE + p, { redirect: "manual", ...opts });
const login = (password) => req("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });

(async () => {
  for (let i = 0; i < 80; i++) { try { await req("/healthz"); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
  console.log("\nsign-in");

  await test("the dashboard redirects to sign-in", async () => {
    const r = await req("/");
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get("location"), "/login");
  });
  await test("chats cannot be read without signing in", async () =>
    assert.strictEqual((await req("/api/digest?from=2026-09-01&to=2026-09-03")).status, 401));
  await test("broadcast cannot be triggered without signing in", async () =>
    assert.strictEqual((await req("/api/broadcast/send", { method: "POST", body: "{}" })).status, 401));
  await test("the phone can still fetch what it needs to install the app", async () => {
    for (const p of ["/login", "/manifest.webmanifest", "/icon-180.png", "/healthz", "/api/dates"])
      assert.strictEqual((await req(p)).status, 200, p);
  });
  await test("a wrong password is refused", async () => assert.strictEqual((await login("nope")).status, 401));

  let cookie = "";
  await test("the right password opens everything, for 30 days", async () => {
    const r = await login("correct horse");
    assert.strictEqual(r.status, 200);
    cookie = r.headers.get("set-cookie").split(";")[0];
    assert.match(r.headers.get("set-cookie"), /HttpOnly/);
    assert.match(r.headers.get("set-cookie"), /Max-Age=2592000/);
    assert.strictEqual((await req("/", { headers: { cookie } })).status, 200);
    assert.strictEqual((await req("/api/digest?from=2026-09-01&to=2026-09-03", { headers: { cookie } })).status, 200);
  });
  await test("a forged session is rejected", async () =>
    assert.strictEqual((await req("/api/digest", { headers: { cookie: "acm_session=9999999999999.forged" } })).status, 401));
  await test("rapid guessing is cut off", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await login("guess")).status;
    assert.strictEqual(last, 429);
  });

  srv.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${n} tests\n`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
