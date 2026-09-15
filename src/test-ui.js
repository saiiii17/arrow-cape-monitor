// Browser regressions for the dashboard. These need a running server --
// `npm run dashboard` in another terminal -- which is why they are a separate
// script from `npm test` rather than part of it.
//
// Everything here is a bug that was actually reported: a refresh throwing away
// the date range, the live poll stealing the selection mid-read, dates outside
// the stored range being unclickable.
const puppeteer = require("puppeteer");
const URL = "http://localhost:4321";
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n}${d ? "\n       " + d : ""}`)); };
const val = (p, s) => p.$eval(s, (e) => e.value);

(async () => {
  const b = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
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

  console.log("\nevery tab renders");
  for (const [id, label] of [["#tab-c5","C5"],["#tab-c3","C3"],["#tab-mx","Matches"],["#tab-wa","WhatsApp"]]) {
    await p.click(id);
    await new Promise(r => setTimeout(r, 900));
    const shown = await p.$eval(id.replace("#tab-", "#v-"), (e) => !e.hidden && e.offsetHeight > 0);
    ok(`${label} tab shows content`, shown);
  }

  console.log("\nno JS errors");
  ok("page threw no errors", errs.length === 0, errs.slice(0,3).join(" | "));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
