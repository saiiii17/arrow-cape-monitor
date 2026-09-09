require("dotenv").config();
const { completeJson } = require("./c3/llm");
const { isFaithful } = require("./summarise");
const { ACCOUNTS } = require("./accounts");

// The copy-paste block the owner sends on. One consolidated line per account with
// the time span, rather than a list of individual updates.
//
// Every number, trading verb and price qualifier is verified against the source
// messages exactly as the per-update summaries are; anything that fails falls
// back to listing the updates verbatim rather than printing something invented.

const SYSTEM = `You consolidate a day's Capesize broker updates for ONE account into a short WhatsApp line.

RULES
- Up to 6 short lines. Completeness beats brevity: never drop a fact to fit.
- Do NOT repeat the account name ("Rio", "BHP", "FMG") or the route ("C5") --
  both are already in the heading. Do NOT repeat the stem size ("160/10")
  unless it actually changed during the day.
- Lead with the laycan/dates, then the rates and status. Dates and numbers are
  the point of the line.
- MUST INCLUDE, every time it appears in the source:
    1. ANY FIXTURE — "fixed one at $16", "fxd", "done", "failed", "on subs".
       A concluded deal is the single most important fact; never omit one.
    2. EVERY rate level mentioned — bids, offers, last done, ideas, FFA levels —
       and who is at each.
    3. The laycan, AND any change to it ("was 20-22 Sep, now 21-23 Sep").
    4. Hard restrictions: no nuke / nuke ok, max age, DA caps, load-port limits.
    5. Status: collecting, bidding, trading away, no bid yet, still looking.
- Separate distinct facts with " | ". Order them oldest to newest so movement
  during the period is visible.
- Copy every number, rate, date and laycan EXACTLY as written. Never reformat,
  convert, round or expand them. "160/10" stays "160/10". "mid-hi 17s" stays "mid-hi 17s".
- Use a trading verb (bid/offer/holds/fixed/no bid) ONLY if the source has one.
  Never add a price qualifier (mid/hi/low/sub) that is not in the source.
- Report the LATEST position. Mention an earlier level only when it shows movement.
- No commentary, no advice, no explanation. Never add status words that are not
  in the source ("no activity", "quiet", "active", "firm") -- if the source is a
  single bare message, restate it and stop.

Return JSON: {"line": "..."}`;

function timeSpan(updates) {
  const t = updates.map((u) => u.time).sort();
  return t.length === 1 ? t[0] : `${t[0]}–${t[t.length - 1]}`;
}

function dateSpan(updates) {
  const d = [...new Set(updates.map((u) => u.date))].sort();
  return d.length === 1 ? d[0] : `${d[0]} → ${d[d.length - 1]}`;
}

// Follow-ups carry no account of their own, so the source given to the model
// includes the original message they hang off.
function sourceFor(updates) {
  return updates
    .map((u) => `[${u.date} ${u.time}] ${u.sender.replace(/\s+ARROW.*$/i, "")}:\n${u.body}`)
    .join("\n\n");
}

// A "C5 Update" is the account's CURRENT position, not its whole history. Over
// a long range that could be hundreds of messages (340 RIO updates across 3
// months), which is slow to summarise and not what the owner wants. Cap to the most
// recent updates -- enough to capture the latest levels and any movement.
const MAX_UPDATES = 25;

async function briefForAccount(label, updatesAll) {
  if (!updatesAll.length) return { account: label, quiet: true, line: "quiet so far" };

  const updates = [...updatesAll]
    .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)))
    .slice(-MAX_UPDATES);

  const source = sourceFor(updates);
  let line = null;
  let verified = false;
  try {
    const out = await completeJson(SYSTEM, source, { maxTokens: 400 });
    const candidate = String(out.line || "").trim();
    if (candidate && isFaithful(candidate, source)) {
      line = candidate;
      verified = true;
    }
  } catch {
    /* fall through to verbatim */
  }

  // Unverified: list the updates rather than risk a wrong number.
  if (!line) {
    line = updates.map((u) => `${u.time}  ${u.body.split("\n").map((x) => x.trim()).filter(Boolean).join(" · ")}`).join("\n");
  }

  return {
    account: label,
    quiet: false,
    line,
    verified,
    span: timeSpan(updates),
    dates: dateSpan(updates),
    count: updates.length,
    sources: updates.map((u) => ({ date: u.date, time: u.time, sender: u.sender, body: u.body })),
  };
}

async function buildBrief(groups, { from, to } = {}) {
  // RIO/FMG/BHP summaries are independent -- run them at once, not in series.
  // Sequential was ~37s; parallel is ~one model call's latency.
  const blocks = await Promise.all(
    ACCOUNTS.map((a) => briefForAccount(a.label, groups[a.id]?.direct || []))
  );

  const header = from && to && from !== to ? `*C5 Update:*  ${from} → ${to}` : `*C5 Update:*  ${from || ""}`.trimEnd();
  const text = [
    header,
    "",
    ...blocks.map((b) =>
      b.quiet ? `*${b.account}* — quiet so far` : `*${b.account}* (${b.span})\n${b.line}`
    ),
  ].join("\n\n");

  return { blocks, text };
}

module.exports = { buildBrief, briefForAccount };
