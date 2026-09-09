const fs = require("fs");
const path = require("path");

// Live messages are stored in exactly the shape chatlog.js produces, so the C5
// and C3 pipelines cannot tell a live message from an exported one.
const DIR = path.join(__dirname, "..", "data", "live");

const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

function file(groupName) {
  return path.join(DIR, `${slug(groupName)}.jsonl`);
}

// The exports are in Dubai local time, so live timestamps must be too --
// otherwise the same message lands in a different hour depending on source.
const FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Dubai",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

function toRecord(unixSeconds, sender, body) {
  const parts = Object.fromEntries(FMT.formatToParts(new Date(unixSeconds * 1000)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${String(hour).padStart(2, "0")}:${parts.minute}`,
    minutes: hour * 60 + Number(parts.minute),
    sender,
    body: String(body || "").trim(),
    live: true,
  };
}

function append(groupName, records) {
  if (!records.length) return 0;
  fs.mkdirSync(DIR, { recursive: true });
  const existing = new Set(load(groupName).map(keyOf));
  const fresh = records.filter((r) => r.body && !existing.has(keyOf(r)));
  if (!fresh.length) return 0;
  fs.appendFileSync(file(groupName), fresh.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return fresh.length;
}

// Identity is date+time+body. The sender is deliberately excluded: the same
// message can arrive with a raw id one time ("217845153677395") and a display
// name the next ("Sai Shanmat"), and including it doubled every own message.
const keyOf = (r) => `${r.date} ${r.time} ${String(r.body).slice(0, 80)}`;

function load(groupName) {
  const f = file(groupName);
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function stats(groupName) {
  const rows = load(groupName);
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  return { count: rows.length, days: dates.length, first: dates[0] || null, last: dates[dates.length - 1] || null };
}

// Unlinking must remove the captured messages, not just the connection --
// otherwise the C5/C3 views still show data from an account that is no longer
// linked.
function clearAll() {
  if (!fs.existsSync(DIR)) return { files: 0, messages: 0 };
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".jsonl"));
  let messages = 0;
  for (const f of files) {
    const full = path.join(DIR, f);
    try {
      messages += fs.readFileSync(full, "utf8").split("\n").filter(Boolean).length;
      fs.rmSync(full, { force: true });
    } catch {
      /* ignore */
    }
  }
  return { files: files.length, messages };
}

module.exports = { append, load, stats, toRecord, file, slug, clearAll };
