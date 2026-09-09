require("dotenv").config();
const { execFileSync } = require("child_process");
const path = require("path");

// Re-extracts the same day under each provider and diffs them on the specific
// failures found by hand, so "is Haiku better here" is answered by evidence
// rather than impression.
//
//   npm run c3:compare -- 2026-08-26
//
// Each provider runs in its own child process because the provider is chosen at
// module load time from the environment.

const DAY = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || "2026-08-26";
const REFRESH = !process.argv.includes("--cached");
const PROVIDERS = ["groq", "anthropic"];

const PROBE = `
const { recordsFor } = require(${JSON.stringify(path.join(__dirname, "index.js"))});
const { usage } = require(${JSON.stringify(path.join(__dirname, "llm.js"))});
(async () => {
  const records = await recordsFor(process.env.PROBE_DAY, { refresh: process.env.PROBE_REFRESH === "1" });
  const irh = records.filter((r) => /irh/i.test(r.charterer || "")).sort((a, b) => a.minutes - b.minutes);
  const koch = records.filter((r) => /koch/i.test(r.charterer || "") || /koch/i.test(r.owner || ""));
  process.stdout.write("@@" + JSON.stringify({
    total: records.length,
    usage,
    irhLatest: irh.length ? { time: irh[irh.length - 1].time, rate: irh[irh.length - 1].rate } : null,
    sawTheMissedMessage: records.some((r) => r.time === "11:47"),
    kochKinds: [...new Set(koch.map((r) => r.kind))],
    kinds: records.reduce((a, r) => ((a[r.kind] = (a[r.kind] || 0) + 1), a), {}),
  }) + "@@");
})().catch((e) => { process.stdout.write("@@" + JSON.stringify({ error: e.message }) + "@@"); });
`;

function run(provider) {
  const out = execFileSync(process.execPath, ["-e", PROBE], {
    env: { ...process.env, C3_PROVIDER: provider, PROBE_DAY: DAY, PROBE_REFRESH: REFRESH ? "1" : "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  });
  const m = out.match(/@@([\s\S]*)@@/);
  return m ? JSON.parse(m[1]) : { error: "no result" };
}

// $/M tokens. Groq figures are approximate; Anthropic list pricing for Haiku 4.5.
const PRICE = { groq: [0.15, 0.75], anthropic: [1, 5] };

function fmtIrh(r) {
  return r.irhLatest ? `${r.irhLatest.time}  $${r.irhLatest.rate}` : "—";
}

function yn(v) {
  return v === undefined ? "—" : v ? "yes" : "NO";
}

function line(label, a, b) {
  console.log(`  ${label.padEnd(26)} ${String(a).padEnd(26)} ${b}`);
}

(async () => {
  console.log(
    REFRESH
      ? `\nExtracting ${DAY} under each provider (this re-runs the model, so it costs money)\n`
      : `\nReading cached extractions for ${DAY} (no model calls)\n`
  );
  const results = {};
  for (const p of PROVIDERS) {
    process.stdout.write(`  ${p} ... `);
    try {
      results[p] = run(p);
      console.log(results[p].error ? `failed: ${results[p].error}` : "done");
    } catch (e) {
      results[p] = { error: e.message.split("\n")[0] };
      console.log(`failed: ${results[p].error}`);
    }
  }

  const [g, a] = [results.groq, results.anthropic];
  console.log(`\n${"".padEnd(28)}${"GROQ".padEnd(26)}ANTHROPIC`);
  console.log("  " + "-".repeat(72));
  line("model", g.usage?.model ?? "—", a.usage?.model ?? "—");
  line("records extracted", g.total ?? "—", a.total ?? "—");
  line("by kind", JSON.stringify(g.kinds ?? {}), JSON.stringify(a.kinds ?? {}));
  console.log("  " + "-".repeat(72));
  console.log("  known failures:");
  line("IRH latest bid", fmtIrh(g), fmtIrh(a));
  line("  (truth: 11:47 $37.45)", "", "");
  line("saw the 11:47 message", yn(g.sawTheMissedMessage), yn(a.sawTheMissedMessage));
  line("KOCH classified as", (g.kochKinds || []).join(",") || "—", (a.kochKinds || []).join(",") || "—");
  line("  (truth: tonnage)", "", "");
  console.log("  " + "-".repeat(72));
  for (const p of PROVIDERS) {
    const u = results[p].usage;
    if (!u) continue;
    const [pi, po] = PRICE[p];
    const cost = (u.input / 1e6) * pi + (u.output / 1e6) * po;
    console.log(`  ${p.padEnd(10)} ${u.calls} calls · ${u.input} in / ${u.output} out · $${cost.toFixed(4)} for this day · ~$${(cost * 22).toFixed(2)}/month`);
  }
  console.log();
})();

