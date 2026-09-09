const assert = require("assert");
const { extractUpdates, groupByAccount } = require("./extract");
const { accountsIn } = require("./accounts");
const { isTopicHeader } = require("./principals");

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

// Build a day of messages; times are minutes past 06:00 for brevity.
function day(...specs) {
  return specs.map(([offset, sender, body]) => ({
    date: "2026-09-02",
    time: `06:${String(offset).padStart(2, "0")}`,
    minutes: 360 + offset,
    sender,
    body,
  }));
}

console.log("\naccount classification");

test("names an account directly", () => {
  assert.deepStrictEqual(accountsIn("BHP C5\n160/10\n20-22 Sep"), [
    { id: "BHP", label: "BHP", relation: "direct" },
  ]);
});

test("shipper reference is indirect", () => {
  assert.strictEqual(accountsIn("Cosco C5\n160/10\nBHP shipper")[0].relation, "indirect");
});

test("stated intention is indirect, either word order", () => {
  assert.strictEqual(accountsIn("Cosco C5\nrio intention")[0].relation, "indirect");
  assert.strictEqual(accountsIn("Pano C5\nall 3 lports (intention FMG)")[0].relation, "indirect");
});

test("negation is indirect", () => {
  assert.strictEqual(accountsIn("150K coal\nnon bhp,\nmax 20y")[0].relation, "indirect");
});

test("terms reference is indirect", () => {
  assert.strictEqual(accountsIn("prefers RIO terms.. anyone please?")[0].relation, "indirect");
});

test("one bare mention outweighs an indirect one", () => {
  assert.strictEqual(accountsIn("BHP shipper. Separately BHP C5 160/10 20-22 Sep")[0].relation, "direct");
});

test("a message can name several accounts", () => {
  assert.deepStrictEqual(
    accountsIn("bhp and fmg bidding $17.25 according to FFA").map((h) => h.id).sort(),
    ["BHP", "FMG"]
  );
});

console.log("\ntopic boundaries");

test("A/C header opens a new subject", () => assert.ok(isTopicHeader("A/C Oldendorff C5\nSTD\n14-16 Sep")));
test("known principal opens a new subject", () => assert.ok(isTopicHeader("Berge C5\n\nBerge Rinjani 175/10")));
test("bare name line opens a new subject", () => assert.ok(isTopicHeader("Pacbulk\n\nCitius\n170/10")));
test("name-dash opens a new subject", () => assert.ok(isTopicHeader("Dongnan - still there\nonly rate we have is 30k")));
test("unharvested principal with keyword opens a new subject", () => assert.ok(isTopicHeader("Zeaborn - Pac sell\nMv Whatever")));
test("a bare rate follow-up does not", () => assert.ok(!isTopicHeader("12.70 vs 13.80 away")));
test("a dated follow-up does not", () => assert.ok(!isTopicHeader("18-20 sept\nsayhs holds 16dlrs so far")));

console.log("\ncontext inheritance");

test("a bare follow-up inherits the sender's account", () => {
  const g = groupByAccount(
    extractUpdates(day([0, "Oly", "FMG C5\n160/10\n16-18 Sept"], [12, "Oly", "18-20 sept\nsayhs holds 16dlrs so far"]))
  );
  assert.strictEqual(g.FMG.direct.length, 2);
  assert.strictEqual(g.FMG.direct[1].source, "context");
});

test("a new topic ends the thread", () => {
  const g = groupByAccount(
    extractUpdates(
      day(
        [0, "David Jones", "BHP C5\n20-22 Sep"],
        [10, "David Jones", "Berge C5\n\nBerge Rinjani 175/10\nETA WA 11-12 Sep"],
        [20, "David Jones", "bid 14.90 (last done yday)"]
      )
    )
  );
  assert.strictEqual(g.BHP.direct.length, 1, "only the named BHP post should attach");
});

test("a follow-up from a different broker is not inherited", () => {
  const g = groupByAccount(
    extractUpdates(day([0, "Oly", "RIO C5\n170/10"], [5, "Someone Else", "15.25 vs 15.85 away"]))
  );
  assert.strictEqual(g.RIO.direct.length, 1);
});

test("inheritance expires after the context window", () => {
  const g = groupByAccount(
    extractUpdates(day([0, "Oly", "RIO C5\n170/10"], [90, "Oly", "15.25 vs 15.85 away"]))
  );
  assert.strictEqual(g.RIO.direct.length, 1);
});

test("chatter without trade signal is not inherited", () => {
  const g = groupByAccount(extractUpdates(day([0, "Oly", "RIO C5\n170/10"], [5, "Oly", "thanks mate"])));
  assert.strictEqual(g.RIO.direct.length, 1);
});

test("an indirect mention does not open a thread", () => {
  const g = groupByAccount(
    extractUpdates(day([0, "Leo", "Cosco C5\n160/10\nBHP shipper"], [5, "Leo", "bid 14.90"]))
  );
  assert.strictEqual(g.BHP.direct.length, 0);
  assert.strictEqual(g.BHP.indirect.length, 1);
});

console.log("\nrelay de-duplication");

test("the same enquiry from two brokers collapses into one", () => {
  const g = groupByAccount(
    extractUpdates(day([0, "William Smart", "A/C BHP\n160/10\n20-22 Sep"], [0, "Leslie Bo", "BHP 20-22Sep\n160/10"]))
  );
  assert.strictEqual(g.BHP.direct.length, 1);
  assert.deepStrictEqual(g.BHP.direct[0].alsoFrom, ["Leslie Bo"]);
});

test("a later update adding detail is kept separate", () => {
  const g = groupByAccount(
    extractUpdates(
      day(
        [0, "William Smart", "A/C BHP\n160/10\n20-22 Sep"],
        [52, "David Jones", "A/C BHP\n160/10\n20-22 Sep - try 19th\nClaims to hold offers $16-16.25"]
      )
    )
  );
  assert.strictEqual(g.BHP.direct.length, 2);
});

console.log("\nsummary verification");

const { numbersAreFaithful, verbsAreFaithful, isFaithful } = require("./summarise");

test("a reformatted quantity is rejected", () => {
  assert.ok(!numbersAreFaithful("BHP 160,000 x 10%", "A/C BHP 160/10"));
});

test("an altered rate is rejected", () => {
  assert.ok(!numbersAreFaithful("holds $17-17.25", "Claims to hold offers $16-16.25"));
});

test("an invented trading verb is rejected", () => {
  // The model turned a bare laycan into a bid; no number changed.
  assert.ok(!verbsAreFaithful("Rio C5 170/10 bid 19-21 Sept", "Rio C5\n170/10\n19-21 Sept"));
});

test("a verb present in the source is kept", () => {
  assert.ok(verbsAreFaithful("BHP holds sub $18 offers", "Claims to hold 'plenty' sub $18 offers"));
});

test("an invented price qualifier is rejected", () => {
  // "hi 17s" -> "mid-hi 17s": no number changed, but a different price level.
  const { qualifiersAreFaithful } = require("./summarise");
  assert.ok(!qualifiersAreFaithful("Rio C5 hold mid-hi 17s", "claim hold hi 17s (asume 17.90 ish)"));
  assert.ok(qualifiersAreFaithful("Rio C5 hold hi 17s", "claim hold hi 17s (asume 17.90 ish)"));
});

test("a faithful summary passes both checks", () => {
  assert.ok(isFaithful("BHP 160/10, 20-22 Sep, holds $16-16.25", "A/C BHP\n160/10\n20-22 Sep\nClaims to hold offers $16-16.25"));
});

console.log(`\n${n} tests\n`);
