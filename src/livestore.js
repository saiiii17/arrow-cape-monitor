const fs = require("fs");
const path = require("path");

// Live messages are stored in exactly the shape chatlog.js produces, so the C5
// and C3 pipelines cannot tell a live message from an exported one.
// Overridable so tests can point at a scratch directory instead of the real
// capture -- a test that wipes the live store would destroy real messages.
const DIR = process.env.LIVE_STORE_DIR || path.join(__dirname, "..", "data", "live");

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

function toRecord(unixSeconds, sender, body, id) {
  const parts = Object.fromEntries(FMT.formatToParts(new Date(unixSeconds * 1000)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${String(hour).padStart(2, "0")}:${parts.minute}`,
    minutes: hour * 60 + Number(parts.minute),
    sender,
    body: String(body || "").trim(),
    live: true,
    // WhatsApp's own message id. Two identical messages sent in the same
    // minute are two messages, and only the id can tell them apart.
    ...(id ? { id: String(id) } : {}),
  };
}

// The one write path for captured messages. Returns what changed:
//   added    -- messages not seen before
//   edited   -- a known message whose text changed (someone edited it)
//   adopted  -- a row saved before ids existed, now matched to its id
//
// Identity is WhatsApp's message id whenever there is one. Keying on
// date+minute+text merged a genuine repeat -- the same text sent twice in a
// minute -- into one message, and made an edited message look like a new one.
function upsert(groupName, records) {
  const out = { added: 0, edited: 0, adopted: 0 };
  if (!records.length) return out;
  fs.mkdirSync(DIR, { recursive: true });
  const stored = load(groupName);
  const byId = new Map();
  stored.forEach((r, i) => { if (r.id) byId.set(r.id, i); });
  // Rows saved before ids were kept, by content, so the next pull matches them
  // to their id instead of re-adding them as copies. One-for-one: two legacy
  // repeats need two incoming messages to be matched.
  const legacy = new Map();
  stored.forEach((r, i) => {
    if (r.id) return;
    const k = keyOf(r);
    if (!legacy.has(k)) legacy.set(k, []);
    legacy.get(k).push(i);
  });

  // Every saved message by content, one-for-one. An incoming message WITHOUT
  // an id (a chat export, or a pull that could not read ids) is matched
  // against all of these -- checking only id-less rows re-added messages the
  // live listener had already saved with their id.
  const byContent = new Map();
  for (const r of stored) byContent.set(keyOf(r), (byContent.get(keyOf(r)) || 0) + 1);

  let rewrite = false;
  const fresh = [];
  const batchKeys = new Set();
  for (const r of records) {
    if (!r.body) continue;
    if (r.id && byId.has(r.id)) {
      const cur = stored[byId.get(r.id)];
      if (cur.body !== r.body) {
        // Edited in WhatsApp. Keep the first text so the change is visible.
        stored[byId.get(r.id)] = { ...cur, body: r.body, edited: true,
          originalBody: cur.originalBody || cur.body, editedAt: new Date().toISOString() };
        out.edited++;
        rewrite = true;
      }
      continue;
    }
    const k = keyOf(r);
    const slots = legacy.get(k);
    if (slots && slots.length) {
      const i = slots.shift();
      if (r.id) { stored[i] = { ...stored[i], id: r.id }; byId.set(r.id, i); out.adopted++; rewrite = true; }
      continue;
    }
    if (!r.id) {
      // No id: content is all there is.
      if (byContent.get(k) > 0) { byContent.set(k, byContent.get(k) - 1); continue; }
      if (batchKeys.has(k)) continue;
      batchKeys.add(k);
    } else {
      byId.set(r.id, -1);
    }
    fresh.push(r);
  }

  if (rewrite) {
    fs.writeFileSync(file(groupName), [...stored, ...fresh].map((r) => JSON.stringify(r)).join("\n") + "\n");
  } else if (fresh.length) {
    fs.appendFileSync(file(groupName), fresh.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  out.added = fresh.length;
  return out;
}

// Kept for callers that only need to know how many messages were new.
function append(groupName, records) {
  return upsert(groupName, records).added;
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
  let rev = 0;
  try { rev = Math.round(fs.statSync(file(groupName)).mtimeMs); } catch { /* no file yet */ }
  const edited = rows.filter((r) => r.edited).length;
  return { count: rows.length, days: dates.length, first: dates[0] || null, last: dates[dates.length - 1] || null, edited, rev };
}

// Unlinking must remove the captured messages, not just the connection --
// otherwise the C5/C3 views still show data from an account that is no longer
// linked.
// Captured messages are the one thing in this app that cannot be recovered.
// WhatsApp pushes only a small recent window to a newly linked device -- a
// re-pull after unlinking came back with one message where the store had held
// fourteen, and reported "complete, nothing earlier in this group", because
// from WhatsApp's side that was true. Anything older exists ONLY here.
//
// So Unlink archives rather than deletes. The live view is cleared either way;
// the difference is whether weeks of capture are destroyed by a button labelled
// "clear".
function archiveDir() {
  return path.join(DIR, "archive");
}

function clearAll() {
  if (!fs.existsSync(DIR)) return { files: 0, messages: 0, archived: null };
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".jsonl"));
  let messages = 0;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let archived = 0;
  for (const f of files) {
    const full = path.join(DIR, f);
    try {
      const body = fs.readFileSync(full, "utf8");
      const n = body.split("\n").filter(Boolean).length;
      messages += n;
      if (n > 0) {
        fs.mkdirSync(archiveDir(), { recursive: true });
        fs.writeFileSync(path.join(archiveDir(), `${f.replace(/\.jsonl$/, "")}.${stamp}.jsonl`), body);
        archived += n;
      }
      fs.rmSync(full, { force: true });
    } catch {
      /* ignore */
    }
  }
  return { files: files.length, messages, archived, stamp: archived ? stamp : null };
}

// Put the most recent archive for each group back into the live store. Used
// when an unlink turned out to be a mistake -- which is easy, because the
// button that disconnects is the same one that clears.
function restoreLatest() {
  const dir = archiveDir();
  if (!fs.existsSync(dir)) return { restored: 0, groups: [] };
  const newest = new Map(); // base name -> newest archive file
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    const base = f.replace(/\.\d{4}-\d{2}-\d{2}T[\d-]+Z?\.jsonl$/, "");
    const prev = newest.get(base);
    if (!prev || f > prev) newest.set(base, f);
  }
  let restored = 0;
  const groups = [];
  for (const [base, f] of newest) {
    try {
      const body = fs.readFileSync(path.join(dir, f), "utf8");
      const rows = body.split("\n").filter(Boolean);
      const target = path.join(DIR, `${base}.jsonl`);
      // Merge with anything captured since, keeping one copy of each message.
      const existingLines = fs.existsSync(target) ? fs.readFileSync(target, "utf8").split("\n").filter(Boolean) : [];
      // Rows already in the file are never touched. Deduplicating them here is
      // what dropped six genuine messages from a 2,213-message group; only the
      // archive side is filtered, and one-for-one so real repeats survive.
      const have = new Map();
      const keyLine = (line) => {
        try { const m = JSON.parse(line); return m.id || `${m.date} ${m.time} ${String(m.body).slice(0, 80)}`; } catch { return line; }
      };
      for (const line of existingLines) { const k = keyLine(line); have.set(k, (have.get(k) || 0) + 1); }
      const add = [];
      for (const line of rows) {
        const k = keyLine(line);
        if (have.get(k) > 0) { have.set(k, have.get(k) - 1); continue; }
        add.push(line);
      }
      if (add.length) fs.appendFileSync(target, add.join("\n") + "\n");
      restored += add.length;
      groups.push(base);
    } catch { /* ignore */ }
  }
  return { restored, groups };
}

module.exports = { upsert, restoreLatest, append, load, stats, toRecord, file, slug, clearAll };
