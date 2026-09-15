// The primary feature: Connect / Unlink / Force reset must work on the 1200th
// press as reliably as the first, and the owner's exports must always come back
// after a reset. Hammers the real endpoints against a running server.
//
//   node src/server.js          (one terminal)
//   node src/test-lifecycle.js  (another)
const BASE = process.env.WA_TEST_URL || "http://localhost:4321";
const ROUNDS = Number(process.env.ROUNDS || 40);

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n}${d ? "\n       " + d : ""}`)); };
const post = (p) => fetch(BASE + p, { method: "POST" }).then(r => r.json()).catch(e => ({ error: e.message }));
const get = (p) => fetch(BASE + p).then(r => r.json()).catch(e => ({ error: e.message }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`\nhammering ${ROUNDS} rounds of connect / unlink / reset at ${BASE}\n`);
  const ops = ["/api/wa/start", "/api/wa/logout", "/api/wa/reset"];
  let errors = 0, worst = 0;
  const hardFailures = [];
  const observed = [];          // launch failures seen at any point in the run
  const seenSteps = new Set();
  const perOp = {}; const slow = [];

  for (let i = 0; i < ROUNDS; i++) {
    const op = ops[Math.floor(Math.random() * ops.length)];
    const t0 = Date.now();
    const r = await post(op);
    const ms = Date.now() - t0;
    worst = Math.max(worst, ms);
    perOp[op] = Math.max(perOp[op] || 0, ms);
    if (ms > 2000) slow.push(`${op} ${ms}ms (round ${i})`);
    if (r.error) { errors++; console.log(`    round ${i} ${op} -> ${r.error}`); }
    // The end state is not enough: with the generation guard off, the run
    // still produced "Failed to launch the browser process" while finishing
    // in a clean state. Failures have to be caught as they happen.
    if (r.status === "error" || r.error) hardFailures.push(`round ${i} ${op}: ${r.error || r.status}`);
    // Deliberately little settle time: the point is to land inside the
    // previous operation's asynchronous teardown window.
    await sleep(Math.random() * 120);

    // Launch failures surface asynchronously, after the POST has returned, and
    // the steps buffer is a rolling window -- so sample as we go rather than
    // reading the tail at the end.
    const snap = await get("/api/wa/status");
    for (const st of snap.steps || []) {
      const key = st.t + st.text;
      if (seenSteps.has(key)) continue;
      seenSteps.add(key);
      if (/failed to launch|launch failed|reading 'Socket'|could not hold|did not finish loading|keeps exiting/i.test(st.text || ""))
        observed.push(st.text);
    }
    if (snap.status === "error") hardFailures.push(`round ${i} ${op}: ${snap.error || "error state"}`);
  }

  ok("server survived the hammering", !(await get("/api/dates")).error);
  ok("no launch failure at any point in the run", observed.length === 0,
     `${observed.length} incident(s): ` + [...new Set(observed)].slice(0, 3).join(" | "));
  ok("no operation reported an error state", hardFailures.length === 0,
     hardFailures.slice(0, 3).join(" | "));

  // A leak here is the failure that eventually OOMs the container: each
  // abandoned Connect leaving its own Chromium tree behind.
  const procs = await get("/api/wa/debug").then(d => d.chromiumProcesses).catch(() => null);
  if (procs != null) ok("no pile-up of orphaned chromium processes", procs <= 2, `${procs} chromium processes alive`);
  ok("no endpoint returned an error", errors === 0, `${errors} errored responses`);
  ok("every response stayed responsive (<3s)", worst < 3000,
     `slowest ${worst}ms | per-op worst: ${JSON.stringify(perOp)} | ${slow.slice(0,4).join(", ")}`);

  // Land on a known state and let the async teardowns drain.
  await post("/api/wa/logout");
  await sleep(2500);

  const st = await get("/api/wa/status");
  ok("ends unlinked, not wedged in error", st.status !== "error", `status=${st.status} error=${st.error || ""}`);
  ok("reports not connected after unlink", st.connected === false, `connected=${st.connected}`);

  // The requirement: after a reset, the owner's history is what's on screen.
  const d = await get("/api/dates");
  ok("the owner's export data is back after unlink", (d.dates || []).length > 300,
     `only ${(d.dates || []).length} days available`);

  // And a connect straight after an unlink must still start cleanly.
  await post("/api/wa/start");
  await sleep(4000);
  const st2 = await get("/api/wa/status");
  ok("connect after unlink reaches qr or starting, not error", ["qr", "starting", "authenticated", "ready"].includes(st2.status),
     `status=${st2.status} error=${st2.error || ""}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
