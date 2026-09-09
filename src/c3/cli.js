require("dotenv").config();
const { buildRundown } = require("./index");

function usage() {
  console.log(`
C3 / WAFR rundown

  node src/c3/cli.js --window "20-26 Sep" [--on 2026-08-26] [--lookback 2] [--refresh]

  --window    laycan / ETA window to report on   (required for a windowed rundown)
  --on        as-of date, YYYY-MM-DD             (default: latest day in the export)
  --lookback  days of chat to ingest             (default: 2)
  --refresh   re-run extraction, ignoring cache
`);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

(async () => {
  if (process.argv.includes("--help")) return usage();

  const opts = {
    date: arg("on", null),
    lookback: Number(arg("lookback", 2)),
    window: arg("window", null),
    refresh: process.argv.includes("--refresh"),
    onProgress: (n, total) => process.stderr.write(`\r  extracting ${n}/${total}   `),
  };

  const out = await buildRundown(opts);
  process.stderr.write("\r                              \r");
  console.error(`as-of ${out.asOf} · chat ${out.span.join(", ")} · ballaster list ${out.ballasterDate}\n`);
  console.log(out.text);
})().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
