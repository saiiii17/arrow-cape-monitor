const { ACCOUNTS, accountsIn } = require("./accounts");
const { isTopicHeader } = require("./principals");

// How long a sender's account context stays live. Brokers post an account
// header then trickle follow-ups ("18-20 sept", "sayhs holds 16dlrs") that name
// nobody; those inherit the account from that sender's own previous post.
const CONTEXT_MINUTES = 75;
const FOLLOWUP_MAX_CHARS = 240;

// A bare follow-up only counts if it carries trade content -- a rate, a laycan,
// a stanza, or bid/offer language. Otherwise it's chatter.
const TRADE_SIGNAL = /(\$|\bdlrs?\b|\busd\b|\d{1,3}\.\d{1,2}\b|\b\d{2,3}\s*\/\s*\d{1,2}\b|\b\d{1,2}\s*[-\/]\s*\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(bid|offer|offers|fixed|fxd|fix|sub|subs|failed|working|holds?|counter|last done|withdrawn|nuke|laycan|dates|repeat|rpt)\b)/i;

function normalise(body) {
  return body.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Token set used for near-duplicate detection. Splitting digit/letter runs
// makes "20-22Sep" and "20-22 Sep" comparable; single characters ("a", "c"
// from "A/C") carry no signal.
function tokenSet(body) {
  return new Set(
    body
      .toLowerCase()
      .replace(/(\d)([a-z])/g, "$1 $2")
      .replace(/([a-z])(\d)/g, "$1 $2")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1)
  );
}

function jaccard(a, b) {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

const RELAY_WINDOW_MINUTES = 25;
const RELAY_SIMILARITY = 0.65;

// Walk one day chronologically, attributing every message to RIO / FMG / BHP
// either by name or by inherited sender context.
function extractUpdates(dayMessages) {
  const lastContext = new Map(); // sender -> { accounts, minutes }
  const updates = [];

  for (const msg of dayMessages) {
    const hits = accountsIn(msg.body);

    if (hits.length > 0) {
      const direct = hits.filter((h) => h.relation === "direct");
      for (const hit of hits) {
        updates.push({
          account: hit.id,
          relation: hit.relation,
          source: "named",
          ...msg,
        });
      }
      // Only a direct mention refreshes context; an "ex BHP terms" aside does not.
      if (direct.length > 0) {
        lastContext.set(msg.sender, {
          accounts: direct.map((h) => h.id),
          minutes: msg.minutes,
        });
      }
      continue;
    }

    // The broker has moved on to a different principal -- the account thread is
    // over, so nothing after this point inherits it either.
    if (isTopicHeader(msg.body)) {
      lastContext.delete(msg.sender);
      continue;
    }

    const ctx = lastContext.get(msg.sender);
    if (!ctx) continue;
    if (msg.minutes - ctx.minutes > CONTEXT_MINUTES) continue;
    if (msg.body.length > FOLLOWUP_MAX_CHARS) continue;
    if (!TRADE_SIGNAL.test(msg.body)) continue;

    for (const account of ctx.accounts) {
      updates.push({ account, relation: "direct", source: "context", ...msg });
    }
    lastContext.set(msg.sender, { accounts: ctx.accounts, minutes: msg.minutes });
  }

  return dedupe(updates);
}

// Two brokers relaying the same enquiry produce near-identical posts. Keep the
// earliest and record who else carried it.
function dedupe(updates) {
  const seen = new Map();
  const out = [];

  for (const u of updates) {
    const key = `${u.account}|${normalise(u.body)}`;
    const prior = seen.get(key);
    if (prior) {
      if (!prior.alsoFrom.includes(u.sender) && u.sender !== prior.sender) {
        prior.alsoFrom.push(u.sender);
      }
      continue;
    }
    // Not byte-identical, but two brokers relaying one enquiry minutes apart
    // ("A/C BHP 160/10 20-22 Sep" vs "BHP 20-22Sep 160/10") is the same update.
    const tokens = tokenSet(u.body);
    const relay = out.find(
      (o) =>
        o.account === u.account &&
        o.sender !== u.sender &&
        Math.abs(u.minutes - o.minutes) <= RELAY_WINDOW_MINUTES &&
        jaccard(tokens, o.tokens) >= RELAY_SIMILARITY
    );
    if (relay) {
      if (!relay.alsoFrom.includes(u.sender)) relay.alsoFrom.push(u.sender);
      continue;
    }

    const record = { ...u, alsoFrom: [], tokens };
    seen.set(key, record);
    out.push(record);
  }

  return out;
}

function groupByAccount(updates) {
  const groups = {};
  for (const a of ACCOUNTS) groups[a.id] = { direct: [], indirect: [] };
  for (const u of updates) groups[u.account][u.relation].push(u);
  return groups;
}

module.exports = { extractUpdates, groupByAccount, CONTEXT_MINUTES };
