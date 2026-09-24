// Stopping the server must never unlink WhatsApp.
//
// The shutdown handler used to call logout() with no arguments, and its default
// is unlink: true -- so every Ctrl-C, every `kill`, and every redeploy on a host
// that stops a service with SIGTERM told WhatsApp to remove the device. The next
// start then sat at a QR code, which on the deployed site means the broker's
// WhatsApp silently detaches on an ordinary deploy.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

let n = 0;
const test = (name, fn) => {
  n++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-test-"));
const flag = path.join(tmp, "linked.flag");

console.log("\nstopping the server keeps WhatsApp linked");

test("the signal handler asks for a shutdown, never a logout", () => {
  const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const handler = src.slice(src.indexOf('for (const sig of ["SIGINT"'));
  assert.ok(handler.includes("live.shutdown()"), "it should call shutdown()");
  assert.ok(!/live\.logout\s*\(/.test(handler), "it must never call logout() on the way down");
});

test("shutdown() closes the browser without unlinking", () => {
  const src = fs.readFileSync(path.join(__dirname, "live.js"), "utf8");
  const fn = src.slice(src.indexOf("async function shutdown()"));
  assert.match(fn.slice(0, 200), /logout\(\{\s*unlink:\s*false\s*\}\)/,
    "shutdown must pass unlink: false");
});

test("a shutdown leaves the linked marker alone", () => {
  fs.writeFileSync(flag, new Date().toISOString());
  const child = `const l=require(${JSON.stringify(path.join(__dirname, "live.js"))});
    l.shutdown().then(()=>process.exit(0));`;
  execFileSync(process.execPath, ["-e", child], {
    env: { ...process.env, LINKED_FLAG: flag, WA_PREWARM: "0" }, encoding: "utf8", timeout: 30000,
  });
  assert.ok(fs.existsSync(flag), "the device should still count as linked after a clean stop");
});

test("logout() is still able to unlink when that is what was asked for", () => {
  const src = fs.readFileSync(path.join(__dirname, "live.js"), "utf8");
  assert.match(src, /function logout\(\{ unlink = true/, "Unlink on request is a real feature");
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${n} tests\n`);
process.exit(process.exitCode || 0);
