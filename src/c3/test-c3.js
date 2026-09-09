const assert = require("assert");
const { classifyRoute, rateIsPlausible } = require("./routes");
const { consolidate } = require("./consolidate");
const { parseList } = require("./ballasters");
const { parseWindow } = require("./index");
const { scoreMatch, parseQty, vesselAge, nukePolicy } = require("./match");

let n = 0;
function test(name, fn) {
  n++;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const rec = (o) => ({ kind: "cargo", route: "OTHER", restrictions: [], minutes: 0, time: "10:00", ...o });

console.log("\nroute classification");

test("Tubarao/Qingdao is C3", () => assert.strictEqual(classifyRoute(rec({ route_detail: "Tubarao/Qingdao" })), "C3"));
test("Nouadhibou is WAFR", () => assert.strictEqual(classifyRoute(rec({ route_detail: "Nouad/Qdao" })), "WAFR"));
test("Boffa is WAFR", () => assert.strictEqual(classifyRoute(rec({ route_detail: "Boffa/Huanghua" })), "WAFR"));
test("Brazil to Rotterdam is PDM/Rdam", () => assert.strictEqual(classifyRoute(rec({ route_detail: "PDM/Rdam" })), "PDM/RDAM"));

test("an explicit route beats a stray WAF elsewhere in the message", () => {
  assert.strictEqual(
    classifyRoute(rec({ route_detail: "Tubarao/Qingdao", raw: "Xiangyu buy c3, can also look at waf" })),
    "C3"
  );
});

test("a C3 cargo with a WAF option stays C3", () => {
  assert.strictEqual(classifyRoute(rec({ wafr_option: true, raw: "*Cargill* buy c3 /waf - still there" })), "C3");
});

test("a Braz/WAF ballaster is C3 tonnage", () => {
  assert.strictEqual(classifyRoute(rec({ kind: "tonnage", eta_region: "BRAZ", raw: "ETA BRAZ/WAF SEP 23" })), "C3");
});

test("rate bands reject a cross-route number", () => {
  assert.ok(!rateIsPlausible("C3", 16), "a PDM teens rate is not a C3 rate");
  assert.ok(rateIsPlausible("PDM/RDAM", 16));
  assert.ok(rateIsPlausible("C3", 37.5));
});

console.log("\nballaster list");

const LIST = `03/09/26
ARROW CAPE BALLASTER LIST 03/09/2026 *Index dates: 23 Sep - 03 Oct*
==========================
*BRAVOS* (GLENCORE FREIGHT) 180/ 10/ 18.22 M /SCRUBBER - _ETA TUB SEP 19-20_

*MINERAL EDEN* (BOCIMAR) 181/ 14/ 18.30 M /SCRUBBER - _ETA TUB SEP 26_ - *B/S*

NUKE TBN *OLDENDORFF* _ETA TUB OCT 1-5`;

test("parses named vessels, owners and ETAs", () => {
  const l = parseList(LIST, "2026-09-03");
  assert.strictEqual(l.vessels.length, 3);
  assert.deepStrictEqual(
    l.vessels.map((v) => v.vessel),
    ["BRAVOS", "MINERAL EDEN", "NUKE TBN"]
  );
  assert.strictEqual(l.vessels[0].size, "180");
  assert.strictEqual(l.vessels[0].year, "10");
  assert.strictEqual(l.vessels[0].eta.display, "19-20 Sep");
  assert.ok(l.vessels[1].flags.bs);
  assert.strictEqual(l.indexDates, "23 Sep - 03 Oct");
});

test("ETAs sort chronologically across a month boundary", () => {
  const l = parseList(LIST, "2026-09-03");
  const sorts = l.vessels.map((v) => v.eta.sort);
  assert.deepStrictEqual(sorts, [...sorts].sort((a, b) => a - b));
});

console.log("\nconsolidation");

test("a later quote replaces an earlier one and clears its high", () => {
  const state = consolidate(
    [
      rec({ charterer: "Vale", route_detail: "PDM/Rdam", rate: 14, rate_high: 15, indication: "asking", minutes: 900 }),
      rec({ charterer: "Vale", route_detail: "PDM/Rdam", rate: 16, indication: "offer", minutes: 1100 }),
    ],
    { date: "2026-08-26", ballasters: null }
  );
  assert.strictEqual(state.cargo[0].rate, 16);
  assert.strictEqual(state.cargo[0].rate_high, null, "stale high must not survive a new quote");
});

test("a reversed range is put back in order", () => {
  const state = consolidate(
    [rec({ charterer: "X", route_detail: "Tubarao/Qingdao", rate: 38, rate_high: 36, indication: "idea" })],
    { date: "2026-08-26", ballasters: null }
  );
  assert.strictEqual(state.cargo[0].rate, 36);
  assert.strictEqual(state.cargo[0].rate_high, 38);
});

test("an unnamed TBN folds into the owner's named ship", () => {
  const state = consolidate(
    [
      rec({ kind: "tonnage", owner: "Uming", vessel: "CAPE INDIA", size: "188", year: "14", eta: "28-30 Sep", eta_region: "TUB" }),
      rec({ kind: "tonnage", owner: "Uming", vessel: null, size: "187", year: "14", eta: "28-30 Sep", eta_region: "TUB", rate: 37, indication: "offer", minutes: 10 }),
    ],
    { date: "2026-08-26", ballasters: null }
  );
  assert.strictEqual(state.tonnage.length, 1, "same owner, same year, 1kt apart is one ship");
  assert.strictEqual(state.tonnage[0].vessel, "CAPE INDIA");
  assert.strictEqual(state.tonnage[0].rate, 37);
});

test("today's bid beats yesterday's, despite a later clock time", () => {
  // minutes is minutes-within-day: 18:41 yesterday must not outrank 10:23 today.
  const state = consolidate(
    [
      rec({ charterer: "IRH", route_detail: "Tubarao/Qingdao", rate: 36.75, indication: "bid", date: "2026-08-25", minutes: 1121 }),
      rec({ charterer: "IRH", route_detail: "Tubarao/Qingdao", rate: 37, indication: "bid", date: "2026-08-26", minutes: 623 }),
    ],
    { date: "2026-08-26", ballasters: null }
  );
  assert.strictEqual(state.cargo[0].rate, 37, "the newer day's bid must win");
});

test("tonnage is ordered strictly by ETA", () => {
  const state = consolidate(
    [
      rec({ kind: "tonnage", vessel: "LATER", eta: "30 Sep", eta_region: "TUB", minutes: 1 }),
      rec({ kind: "tonnage", vessel: "EARLIER", eta: "19-20 Sep", eta_region: "TUB", minutes: 2 }),
    ],
    { date: "2026-08-26", ballasters: null }
  );
  assert.deepStrictEqual(state.tonnage.map((t) => t.vessel), ["EARLIER", "LATER"]);
});

test("cargo is ordered by earliest laycan", () => {
  const state = consolidate(
    [
      rec({ charterer: "LATE", route_detail: "Tubarao/Qingdao", laycan: "26-30 Sep", minutes: 1 }),
      rec({ charterer: "EARLY", route_detail: "Tubarao/Qingdao", laycan: "20-26 Sep", minutes: 2 }),
    ],
    { date: "2026-08-26", ballasters: null }
  );
  assert.deepStrictEqual(state.cargo.map((c) => c.charterer), ["EARLY", "LATE"]);
});

test("an implausible rate is dropped, not printed", () => {
  const state = consolidate(
    [rec({ charterer: "Y", route_detail: "Tubarao/Qingdao", rate: 16, indication: "bid" })],
    { date: "2026-08-26", ballasters: null }
  );
  assert.strictEqual(state.cargo[0].rate, null);
  assert.strictEqual(state.cargo[0].indication, "none");
});

console.log("\nwindow parsing");

test("parses 20-26 Sep", () => {
  const w = parseWindow("20-26 Sep", 2026);
  assert.strictEqual(w.from.sort, 20260920);
  assert.strictEqual(w.to.sort, 20260926);
});
test("parses 20/26 sep", () => assert.strictEqual(parseWindow("20/26 sep", 2026).to.sort, 20260926));

console.log("\nbuy / sell side");

test("an ETA with no cargo markers means a ship, not a cargo", () => {
  // the owner: "ETA only shows up in case of ships".
  const state = consolidate(
    [rec({ charterer: "Koch", eta: "27 Sep", eta_region: "TUB", rate: 38.5, indication: "offer",
           raw: "Koch open as follows\nNewc ETA 27TH Sept\n38.50 C3 offer" })],
    { date: "2026-08-26", ballasters: null }
  );
  assert.strictEqual(state.cargo.length, 0, "Koch must not appear as cargo");
  assert.strictEqual(state.tonnage.length, 1);
  assert.strictEqual(state.tonnage[0].owner, "Koch");
});

test("a laycan and a stem keep a record on the cargo side", () => {
  const state = consolidate(
    [rec({ charterer: "IRH", laycan: "20-26 Sep", qty: "190/10", rate: 37.45, indication: "bid",
           raw: "IRH can buy a standard Cape C3 20-26 Sep" })],
    { date: "2026-08-26", ballasters: null }
  );
  assert.strictEqual(state.cargo.length, 1);
  assert.strictEqual(state.tonnage.length, 0);
});

test("a house that trades both sides is decided per message", () => {
  // Same name, two messages, two sides.
  const state = consolidate(
    [
      rec({ charterer: "Glencore", laycan: "13-22 Sept", qty: "185/10", raw: "Glencore buy c3" }),
      rec({ charterer: "Glencore", eta: "19-20 Sep", rate: 39, indication: "offer", raw: "glencore sell\nMV Bravos 180/10\nETA Tubarao 19/20 Sep" }),
    ],
    { date: "2026-08-26", ballasters: null }
  );
  assert.strictEqual(state.cargo.length, 1, "the buy message stays cargo");
  assert.strictEqual(state.tonnage.length, 1, "the sell message becomes tonnage");
});

console.log("\nmatching");

const CARGO = { route: "C3", qty: "190/10", laycan: "20-26 Sep", laycanSort: 20260920, laycanEndSort: 20260926, rate: 36.75, restrictions: ["max 20y"], raw: "max 20y, cape or nuke" };
const SHIP = { vessel: "STAR AYESHA", size: "206", year: "19", eta: "22-23 Sep", etaSort: 20260922, rate: 37.88, flags: {} };

test("parses a quantity range", () => {
  assert.deepStrictEqual(parseQty("170-190/10"), { low: 170, high: 190, tol: 10 });
  assert.deepStrictEqual(parseQty("190/10"), { low: 190, high: 190, tol: 10 });
});
test("rejects a typo'd quantity rather than guessing", () => assert.strictEqual(parseQty("1801/0"), null));
test("derives vessel age across the century", () => {
  assert.strictEqual(vesselAge("19"), 7);
  assert.strictEqual(vesselAge("06"), 20);
  assert.strictEqual(vesselAge("98"), 28);
});

test("a good fit scores high and explains itself", () => {
  const r = scoreMatch(CARGO, SHIP);
  assert.ok(r.score >= 75, `expected a strong score, got ${r.score}`);
  assert.strictEqual(r.blockers.length, 0);
  assert.ok(r.reasons.some((x) => /sits inside laycan/.test(x)));
  assert.strictEqual(r.gap, 1.13);
});

test("an ETA well past the laycan is a blocker, not a low score", () => {
  const r = scoreMatch(CARGO, { ...SHIP, eta: "10 Oct", etaSort: 20261010 });
  assert.strictEqual(r.score, 0);
  assert.ok(r.blockers.some((b) => /misses laycan/.test(b)));
});

test("stem size no longer filters anything out", () => {
  // the owner: don't factor stem size at this stage.
  const r = scoreMatch(CARGO, { ...SHIP, size: "150" });
  assert.ok(r.score > 0, "a smaller ship must still be offered");
  assert.ok(!r.blockers.some((b) => /lift/.test(b)));
});

test("an ETA 2 days past the laycan is inside the buffer", () => {
  const r = scoreMatch(CARGO, { ...SHIP, eta: "28 Sep", etaSort: 20260928 });
  assert.ok(r.score > 0, "2 days late is workable");
  assert.strictEqual(r.blockers.length, 0);
  assert.ok(r.reasons.some((x) => /buffer/.test(x)));
});

test("an ETA 3 days past the laycan is out", () => {
  const r = scoreMatch(CARGO, { ...SHIP, eta: "29 Sep", etaSort: 20260929 });
  assert.strictEqual(r.score, 0);
});

test("an over-age ship is blocked", () => {
  const r = scoreMatch(CARGO, { ...SHIP, year: "98" });
  assert.strictEqual(r.score, 0);
  assert.ok(r.blockers.some((b) => /over the max/.test(b)));
});

test("PDM/Rdam cargo never matches a C3 ballaster", () => {
  const r = scoreMatch({ ...CARGO, route: "PDM/RDAM" }, SHIP);
  assert.strictEqual(r.score, 0);
});

test("an offer at or under the bid is called tradeable", () => {
  const r = scoreMatch(CARGO, { ...SHIP, rate: 36.5 });
  assert.ok(r.reasons.some((x) => /tradeable now/.test(x)));
  assert.ok(r.gap < 0);
});

test("a nuke exclusion blocks a 200k+ ship", () => {
  const r = scoreMatch({ ...CARGO, restrictions: [], raw: "Def no nuke" }, SHIP);
  assert.strictEqual(nukePolicy({ restrictions: [], raw: "Def no nuke" }), "excluded");
  assert.strictEqual(r.score, 0);
});

console.log(`\n${n} tests\n`);
