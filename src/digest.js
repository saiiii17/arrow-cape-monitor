const path = require("path");
const { parseChatExport, messagesForDate, availableDates } = require("./chatlog");
const { extractUpdates, groupByAccount } = require("./extract");
const { formatDigest, toRows } = require("./format");
const { summariseAll } = require("./summarise");
const source = require("./source");

// Dubai local hours. The export's timestamps are already Dubai time, so the
// window is applied directly with no conversion.
const WINDOW_START = Number(process.env.WINDOW_START_HOUR || 0);
const WINDOW_END = Number(process.env.WINDOW_END_HOUR || 24);
const CHAT_FILE = process.env.CHAT_FILE || path.join(__dirname, "..", "_chat.txt");

let cache = null;

function exported(file = CHAT_FILE) {
  if (!cache || cache.file !== file) {
    // Sample files are optional demo fixtures; in the cloud there are none and
    // the real source is always live WhatsApp.
    let messages = [];
    try { messages = parseChatExport(file); } catch { messages = []; }
    cache = { file, messages };
  }
  return cache.messages;
}

// Live store for the configured group, or the sample export. Never both.
function allMessages(file = CHAT_FILE) {
  return source.resolve(exported(file), process.env.C5_GROUP).messages;
}

function sourceLabel() {
  return source.label(source.resolve(exported(), process.env.C5_GROUP));
}

// A message may exist in both an export and the live capture; keep one.
function dedupeMerge(a, b) {
  const seen = new Set(a.map((m) => `${m.date} ${m.time} ${m.body.slice(0, 60)}`));
  const extra = b.filter((m) => !seen.has(`${m.date} ${m.time} ${m.body.slice(0, 60)}`));
  return [...a, ...extra].sort((x, y) =>
    x.date === y.date ? x.minutes - y.minutes : x.date < y.date ? -1 : 1
  );
}

function buildDigest(date, opts = {}) {
  const messages = allMessages(opts.file);
  const day = messagesForDate(messages, date, WINDOW_START, WINDOW_END);
  const updates = extractUpdates(day);
  const groups = groupByAccount(updates);

  return {
    date,
    window: `${String(WINDOW_START).padStart(2, "0")}:00–${WINDOW_END}:00 Dubai`,
    source: sourceLabel(),
    messagesScanned: day.length,
    groups,
    text: formatDigest(groups, date, opts),
    rows: toRows(groups, date),
  };
}

function datesAvailable(opts = {}) {
  return availableDates(allMessages(opts.file));
}

// the owner prefers short summaries. Each is number-verified against the source;
// anything that fails falls back to the broker's own words.
async function buildDigestSummarised(date, opts = {}) {
  const messages = allMessages(opts.file);
  const day = messagesForDate(messages, date, WINDOW_START, WINDOW_END);
  const updates = extractUpdates(day);
  await summariseAll(updates.filter((u) => u.relation === "direct"), opts);
  const groups = groupByAccount(updates);

  return {
    date,
    window: `${String(WINDOW_START).padStart(2, "0")}:00–${WINDOW_END}:00 Dubai`,
    source: sourceLabel(),
    messagesScanned: day.length,
    groups,
    text: formatDigest(groups, date, { ...opts, summarised: true }),
    rows: toRows(groups, date),
  };
}

// A date range, so the owner can look at a week rather than clicking through days.
// Capped because each new day may need summarising, which costs a model call.
const MAX_RANGE_DAYS = 14;

async function buildDigestRange(from, to, opts = {}) {
  // A reversed range silently returned nothing; treat it as the same span.
  if (from && to && from > to) [from, to] = [to, from];
  const all = datesAvailable(opts);
  let days = all.filter((d) => d >= from && d <= to);
  const capped = days.length > MAX_RANGE_DAYS;
  if (capped) days = days.slice(-MAX_RANGE_DAYS);

  const built = [];
  for (const d of days) {
    built.push(opts.raw ? buildDigest(d, opts) : await buildDigestSummarised(d, opts));
  }

  return {
    from: days[0] || from,
    to: days[days.length - 1] || to,
    days: built.map((b) => ({ date: b.date, messagesScanned: b.messagesScanned, groups: b.groups })),
    dayCount: built.length,
    capped: capped ? MAX_RANGE_DAYS : null,
    window: built[0]?.window || `${String(WINDOW_START).padStart(2, "0")}:00–${WINDOW_END}:00 Dubai`,
    source: sourceLabel(),
    messagesScanned: built.reduce((n, b) => n + b.messagesScanned, 0),
    rows: built.flatMap((b) => b.rows),
    text: built.map((b) => b.text).join("\n\n\n———\n\n\n"),
  };
}

module.exports = { buildDigest, buildDigestSummarised, buildDigestRange, datesAvailable, WINDOW_START, WINDOW_END };
