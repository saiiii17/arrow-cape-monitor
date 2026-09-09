require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { parseChatExport, messagesForDate, availableDates } = require("../chatlog");
const { latestList } = require("./ballasters");
const { extractDay } = require("./extract");
const { consolidate } = require("./consolidate");
const { render } = require("./rundown");
const { PROVIDER } = require("./llm");
const source = require("../source");

const CHAT_FILE = process.env.C3_CHAT_FILE || path.join(__dirname, "..", "..", "_chat 2.txt");
// Cache is namespaced per provider so a Groq run and an Anthropic run of the
// same day can coexist and be compared. Groq keeps the original flat path.
const CACHE_DIR =
  PROVIDER === "groq"
    ? path.join(__dirname, "..", "..", "data", "c3-cache")
    : path.join(__dirname, "..", "..", "data", `c3-cache-${PROVIDER}`);
const START = Number(process.env.C3_WINDOW_START_HOUR || 0);
const END = Number(process.env.C3_WINDOW_END_HOUR || 24);

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

let cache = null;
function exported() {
  if (!cache) { try { cache = parseChatExport(CHAT_FILE); } catch { cache = []; } }
  return cache;
}

// Live store for the configured group, or the sample export. Never both.
function current() {
  return source.resolve(exported(), process.env.C3_GROUP);
}
function messages() {
  return current().messages;
}

// "20-26 Sep", "20/26 sep", "1-10 Oct"
function parseWindow(text, year) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,2})\s*[-\/]\s*(\d{1,2})\s*([A-Za-z]{3})/);
  if (!m) return null;
  const month = MONTHS[m[3].toLowerCase()];
  if (!month) return null;
  return {
    from: { day: Number(m[1]), month, sort: year * 10000 + month * 100 + Number(m[1]) },
    to: { day: Number(m[2]), month, sort: year * 10000 + month * 100 + Number(m[2]) },
  };
}

function shiftSort(sort, days) {
  const y = Math.floor(sort / 10000);
  const mo = Math.floor((sort % 10000) / 100);
  const d = sort % 100;
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  return dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
}

// Extraction is the only paid step, so each day is cached on disk by date.
// Cache is namespaced by source: an extraction of the owner's sample group must
// never be served for a linked account's group on the same date.
function cacheDir() {
  return path.join(CACHE_DIR, source.cacheKey(current()));
}

async function recordsFor(date, { refresh = false, onProgress } = {}) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const file = path.join(cacheDir(), `${date}.json`);
  if (!refresh && fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    // An explicit "nothing here" marker is a legitimate cached result.
    return Array.isArray(cached) ? cached : [];
  }

  const day = messagesForDate(messages(), date, START, END);
  if (!day.length) return [];

  const records = await extractDay(day, { onProgress });

  if (records.length === 0) {
    // Provider trouble (batches failed) must not be cached: a poisoned empty
    // cache once made every later run report "0 records" as if legitimate.
    if (records.failedBatches > 0) {
      throw new Error(
        `Extraction failed for ${date}: ${records.failedBatches} batch(es) errored out of ${day.length} messages — not caching. Check the provider and API key.`
      );
    }
    // The model ran cleanly and found no C3/WAFR content (e.g. a non-shipping
    // group). Cache that as a marker so the day is not re-extracted.
    fs.writeFileSync(file, JSON.stringify({ empty: true, scanned: day.length, at: new Date().toISOString() }, null, 2));
    return [];
  }

  fs.writeFileSync(file, JSON.stringify(records, null, 2));
  return records;
}

async function buildRundown({ date, lookback = 2, window: windowText, windowFrom, windowTo, refresh = false, onProgress } = {}) {
  const dates = availableDates(messages());
  const asOf = date || dates[dates.length - 1];

  // No data yet (fresh deploy, or before WhatsApp is connected): return a clean
  // empty position instead of crashing on asOf.slice().
  if (!asOf) {
    return {
      asOf: null,
      span: [],
      ballasterDate: null,
      source: source.label(current()),
      windowText: windowText || null,
      state: { cargo: [], tonnage: [], fixtures: [] },
      text: "",
      empty: true,
    };
  }

  const year = Number(asOf.slice(0, 4));

  const span = dates.filter((d) => d <= asOf).slice(-lookback);
  let records = [];
  for (const d of span) {
    records = records.concat(await recordsFor(d, { refresh, onProgress }));
  }

  const ballasters = latestList(messages(), asOf);
  let state = consolidate(records, { date: asOf, ballasters });

  let win = parseWindow(windowText, year);
  // An explicit from/to (from the calendar controls) wins over the text form.
  if (windowFrom && windowTo) {
    const iso = (d) => {
      const [y, m, dd] = d.split("-").map(Number);
      return { day: dd, month: m, sort: y * 10000 + m * 100 + dd };
    };
    win = { from: iso(windowFrom), to: iso(windowTo) };
  }
  if (win) {
    const tonFrom = shiftSort(win.from.sort, -4);
    const tonTo = shiftSort(win.to.sort, 4);
    // Keep a cargo only if its laycan actually overlaps the window (with a few
    // days' tolerance either side), not merely because it starts before the end.
    const cargoFrom = shiftSort(win.from.sort, -3);
    const cargoTo = shiftSort(win.to.sort, 4);
    // A record whose dates could not be parsed used to pass EVERY window --
    // a window a year away still returned 15 ships. Undated records are only
    // kept when they carry an open-ended laycan ("25 Sep onwards") that the
    // window itself covers; otherwise they are out.
    const openEnded = (c) => /onward|onws|onw\b|\+|any\b/i.test(String(c.laycan || ""));
    state = {
      ...state,
      cargo: state.cargo.filter((c) => {
        if (c.laycanSort === Infinity) return false;
        const end = c.laycanEndSort === Infinity ? (openEnded(c) ? Infinity : c.laycanSort) : c.laycanEndSort ?? c.laycanSort;
        return c.laycanSort <= cargoTo && end >= cargoFrom;
      }),
      tonnage: state.tonnage.filter((t) => t.etaSort !== Infinity && t.etaSort >= tonFrom && t.etaSort <= tonTo),
    };
  }

  return {
    asOf,
    span,
    window: win,
    windowText,
    ballasterDate: ballasters?.date || null,
    source: source.label(current()),
    state,
    text: render(state, { date: asOf, window: win }),
  };
}

// The ballaster list publishes the desk's own index window ("Index dates:
// 23 Sep - 03 Oct"), which is a far better default than a hardcoded string.
const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function suggestedWindow(asOf) {
  if (!asOf) return null;
  const list = latestList(messages(), asOf);
  const text = list?.indexDates;
  if (!text) return null;
  const m = String(text).match(/(\d{1,2})\s*([A-Za-z]{3})\w*\s*[-–—]\s*(\d{1,2})\s*([A-Za-z]{3})?/);
  if (!m) return null;

  const baseYear = Number(asOf.slice(0, 4));
  const m1 = MONTH_NAMES[m[2].toLowerCase()];
  const m2 = m[4] ? MONTH_NAMES[m[4].toLowerCase()] : m1;
  if (!m1 || !m2) return null;

  // A window that wraps into a lower month number has crossed the year end.
  const y2 = m2 < m1 ? baseYear + 1 : baseYear;
  const pad = (n) => String(n).padStart(2, "0");
  return {
    text,
    from: `${baseYear}-${pad(m1)}-${pad(Number(m[1]))}`,
    to: `${y2}-${pad(m2)}-${pad(Number(m[3]))}`,
  };
}

module.exports = {
  cacheDir,
  buildRundown,
  recordsFor,
  parseWindow,
  messages,
  suggestedWindow,
  availableDates: () => availableDates(messages()),
};
