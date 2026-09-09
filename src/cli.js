require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { buildDigest, datesAvailable } = require("./digest");

const OUT_DIR = path.join(__dirname, "..", "data", "digests");

function usage() {
  console.log(`
Usage:
  node src/cli.js <date>          Digest for one day   (YYYY-MM-DD or DD/MM/YYYY)
  node src/cli.js latest          Digest for the most recent day in the export
  node src/cli.js <date> --save   Also write JSON + CSV into data/digests/
  node src/cli.js --dates         List every day available in the export
`);
}

function toIso(input) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const m = input.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function toCsv(rows) {
  const cols = ["account", "date", "time", "sender", "relation", "source", "update"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) return usage();

  if (args.includes("--dates")) {
    const dates = datesAvailable();
    console.log(`${dates.length} days available: ${dates[0]} .. ${dates[dates.length - 1]}`);
    return;
  }

  const target = args[0] === "latest" ? datesAvailable().pop() : toIso(args[0]);
  if (!target) {
    console.error(`Unrecognised date "${args[0]}" — use YYYY-MM-DD or DD/MM/YYYY.`);
    process.exit(1);
  }

  const digest = buildDigest(target);
  console.log(`\n${target}  ·  ${digest.messagesScanned} messages scanned  ·  ${digest.window}\n`);
  console.log(digest.text);

  if (args.includes("--save")) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, `${target}.json`), JSON.stringify(digest.rows, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, `${target}.csv`), toCsv(digest.rows));
    fs.writeFileSync(path.join(OUT_DIR, `${target}.txt`), digest.text);
    console.log(`\nSaved to data/digests/${target}.{json,csv,txt}`);
  }
}

main();
