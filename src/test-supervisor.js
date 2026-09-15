// Regression tests for every connection failure this project has actually
// hit. Each one is a sequence of events replayed against a fake clock, so a
// bug that cost an evening of manual QR scanning costs one second here.

const assert = require("assert");
const { createSupervisor } = require("./wa-supervisor");

let n = 0;
function test(name, fn) {
  n++;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

// A clock we control, so a 90-second watchdog is tested instantly.
function clockAt(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

console.log("\nscan protection (the bug that burned the link-attempt limit)");

test("a stall watchdog must not restart while a phone is mid-handshake", () => {
  // Exactly tonight's sequence: QR shown, scanned 30s later, stall timer
  // fires at 90s. Restarting here aborted the scan AND cost a link attempt.
  const c = clockAt();
  const s = createSupervisor({ now: c.now });
  s.event("launch");
  s.event("qr_shown");
  c.advance(30_000);
  s.event("qr_taken"); // the code left the DOM: someone scanned it
  c.advance(60_000);   // stall timer fires, 90s after the QR appeared
  const d = s.requestRestart("QR stopped refreshing");
  assert.strictEqual(d.allow, false, "must not tear down a scan in flight");
  assert.match(d.reason, /not interrupting a link in flight/);
});

test("a scan that genuinely dies is still recovered", () => {
  const c = clockAt();
  const s = createSupervisor({ now: c.now });
  s.event("launch");
  s.event("qr_shown");
  s.event("qr_taken");
  c.advance(121_000); // past the scanning budget: the handshake is dead
  assert.strictEqual(s.requestRestart("still scanning").allow, true);
});

test("protection does not leak into the waiting state", () => {
  // A code nobody has touched IS allowed to go stale and be replaced.
  const c = clockAt();
  const s = createSupervisor({ now: c.now });
  s.event("launch");
  s.event("qr_shown");
  c.advance(91_000);
  assert.strictEqual(s.requestRestart("QR stopped refreshing").allow, true);
});

test("a crash during a scan is allowed through", () => {
  // The guard is about not interrupting progress. A dead browser is not
  // progress, and the caller says so with force.
  const c = clockAt();
  const s = createSupervisor({ now: c.now });
  s.event("launch");
  s.event("qr_shown");
  s.event("qr_taken");
  assert.strictEqual(s.requestRestart("chromium exited", { force: true }).allow, true);
});

test("reaching ready ends protection and all deadlines", () => {
  const c = clockAt();
  const s = createSupervisor({ now: c.now });
  s.event("launch");
  s.event("qr_shown");
  s.event("qr_taken");
  s.event("authenticated");
  s.event("ready");
  c.advance(3_600_000); // an hour of healthy idling
  assert.strictEqual(s.tick(), null, "a ready client must never be restarted by a timer");
  assert.strictEqual(s.protectedNow, false);
});

console.log("\ncircuit breaker (what actually caused the phone lockout)");

test("restart storms stop before WhatsApp locks the account", () => {
  const c = clockAt();
  const s = createSupervisor({ now: c.now });
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(s.requestRestart(`crash ${i}`, { force: true }).allow, true);
    c.advance(10_000);
  }
  const d = s.requestRestart("crash 4", { force: true });
  assert.strictEqual(d.allow, false);
  assert.ok(d.tripped);
  assert.match(d.reason, /can't link new devices/, "must explain the real consequence");
});

test("the breaker forgets old attempts once the window passes", () => {
  const c = clockAt();
  const s = createSupervisor({ now: c.now });
  for (let i = 0; i < 3; i++) { s.requestRestart(`crash ${i}`, { force: true }); c.advance(10_000); }
  assert.strictEqual(s.requestRestart("x", { force: true }).allow, false);
  c.advance(600_001);
  assert.strictEqual(s.requestRestart("much later", { force: true }).allow, true);
});

test("pressing Connect clears the breaker", () => {
  const c = clockAt();
  const s = createSupervisor({ now: c.now });
  for (let i = 0; i < 4; i++) { s.requestRestart(`crash ${i}`, { force: true }); c.advance(10_000); }
  assert.ok(s.tripped);
  s.reset();
  assert.strictEqual(s.tripped, false);
  assert.strictEqual(s.requestRestart("user pressed Connect", { force: true }).allow, true);
});

console.log("\nracing watchdogs (fifteen call sites, one decision)");

test("two watchdogs firing together produce one restart", () => {
  // The detached-frame bug: a crash handler and a stall timer both fired,
  // the second tearing down the browser the first had just relaunched.
  const c = clockAt();
  const s = createSupervisor({ now: c.now });
  assert.strictEqual(s.requestRestart("stall watchdog", { force: true }).allow, true);
  c.advance(500);
  assert.strictEqual(s.requestRestart("crash handler", { force: true }).allow, false,
    "a second teardown 500ms later must be refused");
});

test("a restart is allowed again once the gap has passed", () => {
  const c = clockAt();
  const s = createSupervisor({ now: c.now });
  s.requestRestart("first", { force: true });
  c.advance(3_100);
  assert.strictEqual(s.requestRestart("second", { force: true }).allow, true);
});

console.log("\ndeadlines");

test("a launch that never produces a QR is restarted", () => {
  const c = clockAt();
  const s = createSupervisor({ now: c.now });
  s.event("launch");
  c.advance(241_000);
  const d = s.tick();
  assert.ok(d && d.allow, "a 4-minute launch is genuinely stuck");
});

test("authenticated-but-never-ready is restarted", () => {
  // The hang that looked like 'authenticated' forever.
  const c = clockAt();
  const s = createSupervisor({ now: c.now });
  s.event("launch"); s.event("qr_shown"); s.event("qr_taken"); s.event("authenticated");
  c.advance(60_000);
  assert.strictEqual(s.tick(), null, "60s is normal, must not fire");
  c.advance(91_000);
  assert.ok(s.tick().allow, "151s means it is wedged");
});

test("a healthy launch is never interrupted by a tick", () => {
  const c = clockAt();
  const s = createSupervisor({ now: c.now });
  s.event("launch");
  for (let i = 0; i < 20; i++) { c.advance(5_000); assert.strictEqual(s.tick(), null); }
  s.event("qr_shown");
  c.advance(20_000); assert.strictEqual(s.tick(), null, "a rotating QR is healthy");
  s.event("qr_shown"); // rotation resets the clock
  c.advance(20_000); assert.strictEqual(s.tick(), null);
});

console.log(`\n${n} tests\n`);
