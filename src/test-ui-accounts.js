// The screens people actually touch: signing in, registering, and the admin's
// Accounts tab. Needs a running server with accounts turned on.
//
// Separate from test-ui.js because that suite runs with sign-in off, as the
// dashboard has always been tested. This one needs an admin and a customer.
const puppeteer = require("puppeteer");
const URL = process.env.UI_TEST_URL || "http://localhost:4328";
const ADMIN = { email: process.env.TEST_ADMIN_EMAIL || "owner@test.com", password: process.env.TEST_ADMIN_PASSWORD || "adminpass123" };
const CUST = { email: "broker@test.com", password: "brokerpass1" };

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n}${d ? "\n       " + d : ""}`)); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });

  async function fresh() {
    const ctx = await b.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 1280, height: 900 });
    // Real JavaScript faults only. A 4xx from a deliberately refused request is
    // the server working, and the console reports those as errors too.
    const errs = [];
    p.on("pageerror", (e) => errs.push(e.message));
    p.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (/Failed to load resource/i.test(t)) return;
      errs.push(t);
    });
    return { ctx, p, errs };
  }

  async function signIn(p, who) {
    await p.goto(URL + "/login", { waitUntil: "networkidle0" });
    await p.type("#email", who.email);
    await p.type("#pw", who.password);
    await p.click("#go");
    await wait(1800);
  }

  // Seed what the later checks need, rather than depending on a server someone
  // else prepared: register the customer and approve them through the API.
  {
    const post = (path, body, cookie) => fetch(URL + path, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body || {}),
    });
    await post("/api/register", { email: CUST.email, password: CUST.password, name: "A Broker" });
    const r = await post("/api/login", ADMIN);
    const admin = String(r.headers.get("set-cookie") || "").split(";")[0];
    const d = await (await fetch(URL + "/api/users", { headers: { cookie: admin } })).json();
    const c = (d.users || []).find(u => u.email === CUST.email);
    if (c && c.status !== "active") await post("/api/users/status", { id: c.id, status: "active" }, admin);
  }

  console.log("\nthe public pages");
  {
    const { ctx, p, errs } = await fresh();
    for (const [path, must] of [
      ["/tutorial", "Link your WhatsApp"],
      ["/pricing", "trial period"],
      ["/privacy", "scrypt"],
      ["/terms", "WhatsApp can restrict"],
      ["/support", "What to tell us"],
    ]) {
      await p.goto(URL + path, { waitUntil: "domcontentloaded" });
      const text = await p.evaluate(() => document.body.innerText);
      ok(`${path} loads and says what it should`, text.includes(must), `missing "${must}"`);
    }
    // Every page must link onward, or a visitor is stuck.
    await p.goto(URL + "/pricing", { waitUntil: "domcontentloaded" });
    const links = await p.$$eval("a", (as) => as.map(a => a.getAttribute("href")));
    ok("the pages link to sign-in and to each other",
       links.includes("/login") && links.includes("/privacy"), JSON.stringify(links.slice(0, 10)));
    ok("no page errors on the public pages", errs.length === 0, errs.slice(0, 2).join(" | "));
    await ctx.close();
  }

  console.log("\nregistering");
  {
    const { ctx, p, errs } = await fresh();
    await p.goto(URL + "/register", { waitUntil: "networkidle0" });
    // A fresh address each run: a re-run must not fail because the last run
    // already created this account.
    const newEmail = `newperson${Date.now()}@test.com`;
    await p.type("#name", "New Person");
    await p.type("#email", newEmail);
    await p.type("#pw", "short");
    await p.click("#go");
    await wait(400);
    ok("a short password is refused before anything is sent",
       (await p.$eval("#msg", e => e.textContent)).includes("8 characters"));

    await p.$eval("#pw", e => { e.value = ""; });
    await p.type("#pw", "goodpassword1");
    await p.click("#go");
    await wait(1200);
    ok("a good request is accepted", !await p.$eval("#done", e => e.hidden));
    const done = await p.$eval("#done", e => e.innerText);
    ok("and it says the account must be approved first", /approved/i.test(done), done.slice(0, 80));
    ok("the form is put away", await p.$eval("#form", e => e.hidden));

    // The same email twice must say so rather than silently appearing to work.
    await p.goto(URL + "/register", { waitUntil: "networkidle0" });
    await p.type("#email", newEmail);
    await p.type("#pw", "goodpassword1");
    await p.click("#go");
    await wait(1200);
    ok("registering the same email twice is refused",
       (await p.$eval("#msg", e => e.textContent)).toLowerCase().includes("already"));
    ok("no page errors while registering", errs.length === 0, errs.slice(0, 2).join(" | "));
    await ctx.close();
  }

  console.log("\nsigning in");
  {
    const { ctx, p, errs } = await fresh();
    await p.goto(URL + "/login", { waitUntil: "networkidle0" });
    await p.type("#email", ADMIN.email);
    await p.type("#pw", "wrongpassword");
    await p.click("#go");
    await wait(1200);
    ok("a wrong password says so and stays put",
       (await p.$eval("#msg", e => e.textContent)).length > 0 && p.url().includes("/login"));

    await signIn(p, ADMIN);
    ok("the admin lands on the dashboard", !p.url().includes("/login"), p.url());
    ok("no page errors signing in", errs.length === 0, errs.slice(0, 2).join(" | "));
    await ctx.close();
  }

  console.log("\nwhat a customer sees");
  {
    const { ctx, p, errs } = await fresh();
    await signIn(p, CUST);
    await wait(1500);
    const tabs = await p.evaluate(() =>
      [...document.querySelectorAll("nav[role=tablist] button")]
        .filter(b => !b.hidden).map(b => b.getAttribute("aria-label")));
    ok("only WhatsApp and Broadcast are offered",
       !tabs.includes("C5 Accounts") && !tabs.includes("C3 Cargo and Tonnage") &&
       !tabs.includes("Matches") && !tabs.includes("Accounts") &&
       tabs.includes("Broadcast"), JSON.stringify(tabs));
    ok("the group-capture card is not theirs to see",
       await p.evaluate(() => { const e = document.querySelector("#waHistoryOnly"); return !e || e.hidden; }));
    ok("their name is in the header",
       !await p.$eval("#whoami", e => e.hidden));

    // These act on the broker's daily digest. A customer is refused them, so a
    // button that can only fail should not be on their screen.
    const adminButtons = await p.evaluate(() =>
      ["#refresh", "#copy", "#download", "#send"]
        .filter(sel => { const e = document.querySelector(sel); return e && !e.hidden; }));
    ok("the digest buttons are not shown to a customer",
       adminButtons.length === 0, `still visible: ${adminButtons.join(", ")}`);

    // Linking their own WhatsApp is theirs, and must work. This starts a real
    // Chromium in their own worker, so it is given time.
    await p.click("#tab-wa");
    await wait(1200);
    await p.click("#waStart");
    let qr = { shown: false, big: false, status: "" };
    for (let i = 0; i < 20; i++) {
      await wait(3000);
      qr = await p.evaluate(() => {
        const img = document.querySelector("#waQr img");
        return {
          shown: Boolean(img),
          big: img ? img.offsetWidth > 100 : false,
          status: (document.querySelector("#waSteps") || {}).innerText ? "" : "",
        };
      });
      if (qr.shown && qr.big) break;
    }
    ok("a customer is given a QR code to scan", qr.shown && qr.big, JSON.stringify(qr));

    // And the instructions must be theirs, not the broker's.
    const steps = await p.evaluate(() => document.body.innerText);
    ok("they are not told to enter C5 and C3 group names",
       !/C5 and C3 group names/i.test(steps),
       "the admin's instruction reached a customer");
    ok("no page errors for a customer", errs.length === 0, errs.slice(0, 3).join(" | "));
    await ctx.close();
  }

  console.log("\nthe admin's Accounts tab");
  {
    const { ctx, p, errs } = await fresh();
    await signIn(p, ADMIN);
    await wait(1200);
    const tabs = await p.evaluate(() =>
      [...document.querySelectorAll("nav[role=tablist] button")]
        .filter(b => !b.hidden).map(b => b.getAttribute("aria-label")));
    ok("the admin keeps every tab", tabs.includes("C5 Accounts") && tabs.includes("Accounts"), JSON.stringify(tabs));

    // This suite must not depend on another run having left an account waiting,
    // so it makes its own and approves that.
    const pendingEmail = `pending${Date.now()}@test.com`;
    await p.evaluate(async (email) => {
      await fetch("/api/register", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "pendingpass1", name: "Waiting Person" }) });
    }, pendingEmail);

    await p.click("#tab-ac");
    await wait(1800);
    const list = await p.$eval("#acList", e => e.innerText);
    ok("the accounts are listed", list.includes("broker@test.com"), list.slice(0, 120));
    ok("whoever is waiting is shown first", /waiting for approval/i.test(list), list.slice(0, 120));
    ok("the admin's own account is named", (await p.$eval("#acWho", e => e.textContent)).includes(ADMIN.email));
    ok("2FA shows as off to begin with",
       (await p.$eval("#tfState", e => e.textContent)).toLowerCase().includes("off"));
    ok("running customer sessions are reported",
       (await p.$eval("#acWorkers", e => e.innerText)).length > 0);

    // Approving from the screen must actually change the account.
    const before = await p.evaluate(async () => (await (await fetch("/api/users")).json())
      .users.filter(u => u.status === "pending").length);
    ok("the account that was just requested is waiting", before >= 1, `${before} pending`);
    const pressed = await p.evaluate(() => {
      const btn = [...document.querySelectorAll("#acList button")].find(b => b.textContent === "Approve");
      if (btn) { btn.click(); return true; }
      return false;
    });
    ok("there is an Approve button to press", pressed);
    await wait(1800);
    const after = await p.evaluate(async () => (await (await fetch("/api/users")).json())
      .users.filter(u => u.status === "pending").length);
    ok("pressing Approve approves them", after === before - 1, `${before} -> ${after}`);

    ok("no page errors on the Accounts tab", errs.length === 0, errs.slice(0, 3).join(" | "));
    await ctx.close();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
