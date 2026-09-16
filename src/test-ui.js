// Browser regressions for the dashboard. These need a running server --
// `npm run dashboard` in another terminal -- which is why they are a separate
// script from `npm test` rather than part of it.
//
// Everything here is a bug that was actually reported: a refresh throwing away
// the date range, the live poll stealing the selection mid-read, dates outside
// the stored range being unclickable.
const puppeteer = require("puppeteer");
const URL = process.env.UI_TEST_URL || "http://localhost:4321";
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n}${d ? "\n       " + d : ""}`)); };
const val = (p, s) => p.$eval(s, (e) => e.value);

(async () => {
  const b = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));

  console.log("\ndate filter survives a refresh (the reported bug)");
  await p.goto(URL, { waitUntil: "networkidle0" });
  await p.$eval("#d5from", (e) => { e.value = "2026-09-01"; e.dispatchEvent(new Event("change")); });
  await p.$eval("#d5to",   (e) => { e.value = "2026-09-15"; e.dispatchEvent(new Event("change")); });
  await new Promise(r => setTimeout(r, 800));
  const setFrom = await val(p, "#d5from"), setTo = await val(p, "#d5to");
  ok("range is set before refresh", setFrom === "2026-09-01" && setTo === "2026-09-15", `${setFrom}..${setTo}`);

  await p.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 1200));
  const gotFrom = await val(p, "#d5from"), gotTo = await val(p, "#d5to");
  ok("range survives a page refresh", gotFrom === "2026-09-01" && gotTo === "2026-09-15", `got ${gotFrom}..${gotTo}, wanted 2026-09-01..2026-09-15`);

  console.log("\nlive polling must not steal the selection");
  await new Promise(r => setTimeout(r, 7000)); // > two 3s poll cycles
  const afterPoll = await val(p, "#d5from") + ".." + await val(p, "#d5to");
  ok("range survives two live-poll cycles", afterPoll === "2026-09-01..2026-09-15", afterPoll);

  console.log("\ntab is remembered");
  await p.click("#tab-c3");
  await new Promise(r => setTimeout(r, 600));
  await p.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 1500));
  const tab = await p.$eval("#tab-c3", (e) => e.getAttribute("aria-selected"));
  ok("C3 tab still selected after refresh", tab === "true", `aria-selected=${tab}`);

  console.log("\nC3 as-of date is remembered");
  const d3before = await val(p, "#d3");
  await p.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 1500));
  const d3after = await val(p, "#d3");
  ok("as-of date stable across refresh", d3before === d3after, `${d3before} -> ${d3after}`);

  console.log("\nbounds still enforced");
  await p.click("#tab-c5");
  await new Promise(r => setTimeout(r, 400));
  const max = await p.$eval("#d5to", (e) => e.max);
  const min = await p.$eval("#d5from", (e) => e.min);
  ok("To cannot exceed today", max === new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Dubai"}).format(new Date()), max);
  ok("a full year is browsable", min <= new Date(Date.now()-360*864e5).toISOString().slice(0,10), `min=${min}`);

  console.log("\nquick day shortcuts");
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 1200));
  const dubaiToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
  const back = (n) => { const d = new Date(`${dubaiToday}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  for (const [id, n, label] of [["#d5today", 0, "Today"], ["#d5yday", 1, "Yesterday"], ["#d5dbef", 2, "Day before"]]) {
    await p.click(id);
    await new Promise(r => setTimeout(r, 700));
    const f = await val(p, "#d5from"), t = await val(p, "#d5to");
    ok(`${label} sets both pickers to ${back(n)}`, f === back(n) && t === back(n), `got ${f}..${t}`);
    const lit = await p.$eval(id, (e) => e.classList.contains("on"));
    ok(`${label} shows as selected`, lit);
  }
  // Only one shortcut may be lit at a time.
  const litCount = await p.$$eval(".btn.quick.on", (els) => els.length);
  ok("exactly one shortcut is highlighted", litCount === 1, `${litCount} lit`);

  // A shortcut choice is a choice -- it must survive a refresh like any other.
  await p.click("#d5yday");
  await new Promise(r => setTimeout(r, 600));
  await p.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 1200));
  ok("a shortcut choice survives a refresh", await val(p, "#d5from") === back(1));

  console.log("\nevery tab renders");
  for (const [id, label] of [["#tab-c5","C5"],["#tab-c3","C3"],["#tab-mx","Matches"],["#tab-wa","WhatsApp"]]) {
    await p.click(id);
    await new Promise(r => setTimeout(r, 900));
    const shown = await p.$eval(id.replace("#tab-", "#v-"), (e) => !e.hidden && e.offsetHeight > 0);
    ok(`${label} tab shows content`, shown);
  }

  console.log("\nthe dashboard must never be served from cache");
  // With no cache headers the browser applied heuristic caching, so after a
  // code change the page kept serving the old script: fixes looked like they
  // had not landed and old bugs looked like they had returned.
  {
    const r = await p.goto(URL, { waitUntil: "domcontentloaded" });
    const cc = (r.headers()["cache-control"] || "").toLowerCase();
    ok("the page is sent with no-store", cc.includes("no-store"), `Cache-Control: "${cc || "(absent)"}"`);
    await new Promise(rr => setTimeout(rr, 1500));
  }

  console.log("\nthe header must never contradict the filter");
  // Including when the range is empty -- an empty result used to report the
  // data span (or the last range that had one) instead of what was asked for.
  await p.click("#tab-c5");
  await new Promise(r => setTimeout(r, 700));
  await p.$eval("#d5to",   e => { e.value = "2026-09-14"; e.dispatchEvent(new Event("change")); });
  await new Promise(r => setTimeout(r, 800));
  await p.$eval("#d5from", e => { e.value = "2026-09-01"; e.dispatchEvent(new Event("change")); });
  await new Promise(r => setTimeout(r, 1800));
  {
    const f = await val(p, "#d5from"), t = await val(p, "#d5to");
    const m = await p.$eval("#meta5", e => e.textContent);
    ok("an empty range still names the range asked for", m.includes(f) && m.includes(t),
       `filter ${f}→${t}, header "${m.slice(0, 70)}"`);
  }

  console.log("\nediting a date must not corrupt the range");
  await p.click("#tab-c5");
  await new Promise(r => setTimeout(r, 700));
  {
    // A date input reports every intermediate state while being edited:
    // typing "01/09/2026" walks through 0009, 0090, 0901, 9012. The old
    // "From must not be after To" guard fired on each, so a half-typed year
    // dragged the other end along and collapsed 01→14 into one nonsense day,
    // firing a request per keystroke on the way.
    await p.evaluate(() => {
      window.__q = [];
      const of = window.fetch;
      window.fetch = function (u, ...a) {
        const m = String(u).match(/digest\?from=([\d-]+)&to=([\d-]+)/);
        if (m) window.__q.push(`${m[1]}..${m[2]}`);
        return of.apply(this, [u, ...a]);
      };
    });
    await p.click("#d5today");
    await new Promise(r => setTimeout(r, 900));
    await p.evaluate(() => { window.__q = []; });

    await p.click("#d5from");
    await p.keyboard.type("09/01/2026");
    await new Promise(r => setTimeout(r, 1500));

    const q = await p.evaluate(() => window.__q);
    const junk = q.filter(x => !/^20\d\d-/.test(x.split("..")[0]) || !/^20\d\d-/.test(x.split("..")[1]));
    ok("no request is made for a half-typed date", junk.length === 0, `junk ranges: ${junk.slice(0, 4).join(", ")}`);
    ok("typing does not fire a request per keystroke", q.length <= 2, `${q.length} requests while typing`);

    const to = await val(p, "#d5to");
    ok("editing From does not corrupt To", /^20\d\d-\d\d-\d\d$/.test(to), `To became ${to}`);
  }

  // The header must state the range that was ASKED for, not just the days that
  // happened to have traffic -- showing only the latter read as the filter
  // being ignored ("1 to 14" displaying as "14 - 14").
  await p.$eval("#d5to",   e => { e.value = "2026-09-14"; e.dispatchEvent(new Event("change")); });
  await new Promise(r => setTimeout(r, 800));
  await p.$eval("#d5from", e => { e.value = "2026-09-01"; e.dispatchEvent(new Event("change")); });
  await new Promise(r => setTimeout(r, 1800));
  const hdr = await p.$eval("#meta5", e => e.textContent);
  const pf = await val(p, "#d5from"), pt = await val(p, "#d5to");
  ok("the range survives being set end to end", pf === "2026-09-01" && pt === "2026-09-14", `${pf}..${pt}`);
  ok("the header states the requested range", hdr.includes(pf) && hdr.includes(pt), `header: ${hdr.slice(0, 80)}`);

  console.log("\nrapid interaction (stale responses)");
  // The C5 controls are hidden on other tabs, so make sure we are on C5.
  await p.click("#tab-c5");
  await new Promise(r => setTimeout(r, 700));
  // The reported glitch: on a slow connection an earlier request lands last
  // and paints over the newer one, so the screen shows a different day than
  // the filter above it. Forced here by delaying the first digest call.
  {
    let n = 0;
    await p.setRequestInterception(true);
    const handler = async (req) => {
      if (req.url().includes("/api/digest")) { n++; if (n === 1) await new Promise(r => setTimeout(r, 1500)); }
      req.continue();
    };
    p.on("request", handler);

    await p.click("#d5dbef");
    await new Promise(r => setTimeout(r, 200));
    await p.click("#d5today");
    await new Promise(r => setTimeout(r, 3200));
    const picked = await val(p, "#d5from");
    const meta = await p.$eval("#meta5", (e) => e.textContent);
    ok("a slow earlier response cannot overwrite a newer one", meta.includes(picked),
       `pickers say ${picked}, screen says ${meta.slice(0, 60)}`);

    p.off("request", handler);
    await p.setRequestInterception(false);
  }

  // Mashing the shortcuts must settle somewhere coherent.
  for (let i = 0; i < 9; i++) { await p.click(["#d5today","#d5yday","#d5dbef"][i % 3]); await new Promise(r => setTimeout(r, 40)); }
  await new Promise(r => setTimeout(r, 2000));
  const mf = await val(p, "#d5from"), mt = await val(p, "#d5to");
  ok("mashing shortcuts leaves a single-day range", mf === mt, `${mf}..${mt}`);
  ok("exactly one shortcut lit after mashing", await p.$$eval(".btn.quick.on", (e) => e.length) === 1);
  ok("screen agrees with the pickers after mashing", (await p.$eval("#meta5", (e) => e.textContent)).includes(mf));

  console.log("\nleft open past Dubai midnight");
  // the owner will leave this open overnight. The pickers' max was stamped once at
  // load, so after the date rolled over "Today" produced an out-of-range value.
  {
    const r = await p.evaluate(() => {
      const from = document.querySelector("#d5from"), to = document.querySelector("#d5to");
      const d = new Date(`${todayDubai()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
      const yest = d.toISOString().slice(0, 10);
      from.max = yest; to.max = yest; knownDay = yest;   // as if loaded before midnight
      document.querySelector("#d5today").click();
      return { valid: from.checkValidity() && to.checkValidity(), got: from.value, max: to.max };
    });
    await new Promise(r => setTimeout(r, 1200));
    ok("Today stays in range after the date rolls over", r.valid, `max=${r.max} but Today set ${r.got}`);
  }

  console.log("\nhover popover");
  await p.click("#tab-c3");
  await new Promise(r => setTimeout(r, 3000));
  const rows = await p.$$("#tCargo tbody tr");
  if (rows.length < 3) {
    console.log(`  skip  needs C3 rows to hover (found ${rows.length}) — run against a server with data:`);
    console.log(`        DATA_SOURCE=sample WA_PREWARM=0 PORT=4322 node src/server.js`);
    console.log(`        UI_TEST_URL=http://localhost:4322 npm run test:ui`);
  } else {
    const vis = () => p.evaluate(() => { const e = document.querySelector("#pop"); return !e.hidden && e.classList.contains("show"); });
    const pbody = () => p.evaluate(() => document.querySelector("#pop pre").textContent.slice(0, 40));

    await rows[0].hover();
    await new Promise(r => setTimeout(r, 250));
    ok("appears on hover", await vis());

    // The flicker: hidePop's 140ms teardown was never cancelled, so moving to
    // a new row hid the popover that row had just opened.
    await rows[1].hover();
    await new Promise(r => setTimeout(r, 400));
    ok("survives moving between rows", await vis(), "popover vanished after switching rows");

    // It must not blanket the list. An interactive popover over 34px rows
    // swallows their mouseenter, leaving a stale message on screen.
    const blocks = await p.evaluate(() =>
      getComputedStyle(document.querySelector("#pop")).pointerEvents !== "none");
    ok("never intercepts the pointer over the rows", !blocks);

    const seen = new Set();
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      await rows[i].hover();
      await new Promise(r => setTimeout(r, 220));
      seen.add(await pbody());
    }
    ok("each row opens its own message", seen.size >= 3, `only ${seen.size} distinct messages across 5 rows`);

    // Positioned once, not dragged after the cursor.
    const at = () => p.evaluate(() => { const e = document.querySelector("#pop"); return e.style.left + "," + e.style.top; });
    const before = await at();
    const bb = await rows[4].boundingBox();
    await p.mouse.move(bb.x + bb.width - 20, bb.y + bb.height / 2);
    await new Promise(r => setTimeout(r, 250));
    ok("does not chase the cursor within a row", before === await at());

    await p.mouse.move(5, 5);
    await new Promise(r => setTimeout(r, 600));
    ok("closes once the cursor leaves", !(await vis()));

    for (let i = 0; i < 6 && i < rows.length; i++) { await rows[i].hover(); await new Promise(r => setTimeout(r, 60)); }
    await new Promise(r => setTimeout(r, 400));
    ok("survives a fast sweep across rows", await vis() && (await pbody()).length > 0);

    console.log("\nlong messages can be scrolled");
    // Forced so the path is exercised on any dataset: a popover that overflows
    // must become interactive, must survive the cursor moving onto it, must
    // actually scroll -- and must STILL not block the rows underneath.
    await p.addStyleTag({ content: "#pop pre{max-height:60px !important}" });
    await p.mouse.move(5, 5);
    await new Promise(r => setTimeout(r, 600));
    await rows[0].hover();
    await new Promise(r => setTimeout(r, 350));
    const sc = await p.evaluate(() => {
      const e = document.querySelector("#pop pre"), pop = document.querySelector("#pop");
      return { scrolls: e.scrollHeight > e.clientHeight + 2, reachable: pop.classList.contains("reachable") };
    });
    ok("an overflowing message is marked scrollable", sc.scrolls && sc.reachable,
       `scrolls=${sc.scrolls} reachable=${sc.reachable}`);

    const pc = await p.evaluate(() => { const r = document.querySelector("#pop").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await p.mouse.move(pc.x, pc.y);
    await new Promise(r => setTimeout(r, 450));
    ok("stays open while the cursor is on it", await vis());

    await p.mouse.wheel({ deltaY: 100 });
    await new Promise(r => setTimeout(r, 350));
    ok("the message actually scrolls", await p.evaluate(() => document.querySelector("#pop pre").scrollTop) > 0);

    await p.mouse.move(5, 5);
    await new Promise(r => setTimeout(r, 700));
    const reach = new Set();
    for (let i = 0; i < Math.min(4, rows.length); i++) {
      await rows[i].hover(); await new Promise(r => setTimeout(r, 240));
      reach.add(await pbody());
    }
    ok("rows underneath stay reachable even when it is interactive", reach.size >= 3,
       `only ${reach.size} distinct messages across 4 rows`);
  }

  console.log("\nno JS errors");
  ok("page threw no errors", errs.length === 0, errs.slice(0,3).join(" | "));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
