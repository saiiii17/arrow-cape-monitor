require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { completeJson } = require("./c3/llm");

// the owner prefers short summaries over raw messages. The risk is that a model
// rewrites "mid-hi 17s vs 18 dlrs" into something numerically different, and a
// wrong rate here is worth six figures. So every summary is verified: each
// number it contains must appear verbatim in the source message. Anything that
// fails verification falls back to the original text.

const CACHE = path.join(__dirname, "..", "data", "c5-summaries.json");

const SYSTEM = `You compress Capesize shipping broker messages into one short line.

RULES
- One line. No more than 9 words. Shorter is better. No preamble, no explanation.
- Never add or change a price qualifier (mid / hi / low / sub / circa). "hi 17s"
  must not become "mid-hi 17s".
- Drop restrictions (max age, nuke/std, DA caps) unless nothing else remains --
  The owner asked for the short form and can click through to the original.
- Copy every number, rate, date and laycan EXACTLY as written. Never reformat,
  convert, round, or expand them. "160/10" stays "160/10". "mid-hi 17s" stays
  "mid-hi 17s". "$16-16.25" stays "$16-16.25".
- Keep the trading verb ONLY if the original has one: bid / offer / holds /
  fixed / no bid / withdrawn. NEVER add a trading verb that is not in the
  original. A laycan on its own is not a bid.
- Drop greetings, names, and filler only.

Return JSON: {"summary": "..."}`;

// Digit runs, kept in the exact form they appear so reformatting is detectable.
function numbersIn(text) {
  return (String(text).match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(/,/g, ""));
}

// Every number in the summary must exist in the source. Extra numbers mean the
// model invented or transformed one.
function numbersAreFaithful(summary, source) {
  const src = new Set(numbersIn(source));
  return numbersIn(summary).every((n) => src.has(n));
}

// Trading verbs carry commercial meaning that no number check can protect. The
// model turned "Rio C5 170/10 19-21 Sept" into "...bid 19-21 Sept" -- inventing
// a bid that was never made. A verb may only appear if it is in the source.
// Verb families, so an inflection is not mistaken for an invention: a summary
// saying "holds" against a source saying "hold" is faithful; a summary saying
// "bid" against a source with no bid word at all is not.
const VERB_FAMILIES = [
  ["bid", "bids", "bidding"],
  ["offer", "offers", "offered", "offering"],
  ["hold", "holds", "holding", "held"],
  ["fix", "fixed", "fxd", "fixing"],
  ["sub", "subs"],
  ["counter", "counters", "countering", "countered"],
  ["fail", "failed", "fails"],
  ["work", "working", "works"],
  ["cover", "covered", "covering"],
  ["trade", "trading", "trades"],
  ["withdraw", "withdrawn", "withdrew"],
  ["done"],
];

function hasAny(text, words) {
  return words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
}

// Any verb family the summary uses must also be present in the source.
function verbsAreFaithful(summary, source) {
  return VERB_FAMILIES.every((family) => !hasAny(summary, family) || hasAny(source, family));
}

// Price qualifiers move the level as much as a digit does. The model turned
// "hold hi 17s" into "hold mid-hi 17s" -- no number changed, verb genuine, but
// a different price. A qualifier may only appear if the source used it.
const QUALIFIERS = ["mid", "high", "hi", "low", "sub", "circa", "abt", "about", "over", "under", "plus", "ish"];

function qualifiersAreFaithful(summary, source) {
  const src = source.toLowerCase();
  return QUALIFIERS.filter((q) => new RegExp(`\\b${q}\\b`, "i").test(summary)).every((q) =>
    new RegExp(`\\b${q}\\b`, "i").test(src)
  );
}

function isFaithful(summary, source) {
  return (
    numbersAreFaithful(summary, source) &&
    verbsAreFaithful(summary, source) &&
    qualifiersAreFaithful(summary, source)
  );
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(c) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(c, null, 2));
}

const key = (body) => crypto.createHash("sha1").update(body).digest("hex").slice(0, 16);

// Summarise many updates at once, reusing cached results.
async function summariseAll(updates, { onProgress } = {}) {
  const cache = loadCache();
  let done = 0;
  let dirty = false;

  for (const u of updates) {
    const k = key(u.body);
    if (cache[k]) {
      u.summary = cache[k].summary;
      u.summaryVerified = cache[k].verified;
      done++;
      continue;
    }

    let summary = null;
    let verified = false;
    try {
      const out = await completeJson(SYSTEM, u.body, { maxTokens: 300 });
      const candidate = String(out.summary || "").trim();
      if (candidate && isFaithful(candidate, u.body)) {
        summary = candidate;
        verified = true;
      }
    } catch {
      // fall through to verbatim
    }

    // Verification failed or the call errored: keep the broker's own words.
    u.summary = summary || u.body.split("\n").map((l) => l.trim()).filter(Boolean).join(" · ");
    u.summaryVerified = verified;
    cache[k] = { summary: u.summary, verified };
    dirty = true;
    if (onProgress) onProgress(++done, updates.length);
  }

  if (dirty) saveCache(cache);
  return updates;
}

module.exports = { summariseAll, numbersAreFaithful, verbsAreFaithful, qualifiersAreFaithful, isFaithful, numbersIn };
