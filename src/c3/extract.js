const { completeJson } = require("./llm");

const SYSTEM = `You are a Capesize C3/WAFR shipping analyst extracting structured data from broker WhatsApp messages.

You output ONLY JSON. You never invent a vessel, rate, date, ETA or fixture that is not present in the text.

Classify each message into zero or more records:

- "fixture"  a concluded or reported fixture (someone fixed / was fixed / last done / "she was the $X to Y")
- "cargo"    a charterer buying / looking for tonnage (BUY side)
- "tonnage"  an owner or operator selling a ship or ballaster (SELL side)
- ignore pure chatter, banter, questions, and administrative notes -- emit no record for those

ROUTE BUCKETS (use exactly one):
  "C3"       Brazil (Tubarao / Sudeste / PDM / Ponta da Madeira) to China
  "WAFR"     West Africa (Kamsar, Boffa, Nouadhibou/Nouad, Morebaya, Conakry, Simfer) to China/East
  "PDM/RDAM" Brazil to Rotterdam / Continent (a fronthaul-priced route, NEVER comparable to C3)
  "OTHER"    anything else (C7, TA, backhaul, Samarco/Misurata, tenders on other routes, TCT)
A message offering "C3 + WAF option" is "C3" with wafr_option true.

RATE RULES:
- rate is a number in USD/mt, e.g. 37.88. Never a string, never a range.
- If a range is given, put the low in rate and the high in rate_high.
- PDM/Rdam rates are in the teens ($14-16); C3/WAFR are in the $30s-40s. Do not mix them up.
- "indication" must be one of: bid, offer, asking, holds, idea, fixed, reported, none
- Time-charter equivalents ($60k/day) go in note, not rate.

Return this exact shape:
{"records":[{
  "i": <index of the source message>,
  "kind": "fixture" | "cargo" | "tonnage",
  "charterer": string|null,      // BUY side principal, or the fixing charterer
  "owner": string|null,          // SELL side owner/operator
  "vessel": string|null,         // UPPERCASE, no "MV". null if TBN/unnamed
  "size": string|null,           // "182" (thousand dwt)
  "year": string|null,           // "26" (2 digits)
  "route": "C3"|"WAFR"|"PDM/RDAM"|"OTHER",
  "route_detail": string|null,   // "Morebaya/Qdao", "Boffa/Huanghua"
  "laycan": string|null,         // "20-26 Sep"
  "eta": string|null,            // "23 Sep" or "22-23 Sep"
  "eta_region": "TUB"|"WAF"|"BRAZ"|null,
  "qty": string|null,            // "190/10"
  "rate": number|null,
  "rate_high": number|null,
  "indication": "bid"|"offer"|"asking"|"holds"|"idea"|"fixed"|"reported"|"none",
  "status": string|null,         // collecting | bidding | trading away | fixed | covered | waiting | failed | subjects | withdrawn
  "restrictions": string[],      // ["max 20y","std cape or nuke","DA cap $140k"]
  "wafr_option": boolean,
  "note": string|null,           // ONE short broker-style clause, max 12 words, no invention
  "disputed": boolean            // true if identity/rate is contested or denied
}]}

DISAMBIGUATION:
- "A/C <NAME>" means the account/charterer is <NAME>. Always fill charterer from it.
- "Acct <NAME>" and "a/c <NAME>" mean the same.
- A named vessel with an ETA being shown by a broker is TONNAGE (sell side), even
  when an operator's name appears first -- "Deyesion our period / BESIKTAS
  KAZAKHSTAN 169/10 / ETA 7 Oct Brazil-WAF" is tonnage owned/controlled by Deyesion.
- A charterer stating quantity, load/discharge ports and a laycan is CARGO (buy side).
- Some messages open with a quoted copy of an EARLIER message (WhatsApp reply):
  the quote comes first, the sender's new words follow. Extract the NEW content and
  use the quote only as context. Do not emit a record for the quoted part alone.
- "she was the $X to Y" reports a fixture: charterer Y, rate X, indication "reported".
- An ETA belongs to a SHIP. A message giving an ETA and no laycan is TONNAGE,
  even when a trading house's name leads it -- "Koch open as follows / Newc ETA
  27 Sept / 38.50 C3 offer" is Koch offering a ship, not Koch buying.
- Trading houses (Koch, Glencore, Bocimar, Cargill, Trafigura, Xiangyu, ECTP,
  Transmed) work BOTH sides. Decide buy vs sell per message from the wording,
  never from the name.

If a message contains no C3/WAFR/PDM shipping content, emit nothing for it.`;

function renderBatch(messages, offset) {
  return messages
    .map((m, k) => `[${offset + k}] ${m.time} ${m.sender.replace(/\s+ARROW.*$/i, "")}:\n${m.body}`)
    .join("\n\n---\n\n");
}

// Batches are small so one bad message cannot poison a whole day, and so the
// model keeps every rate in view.
async function extractDay(allDayMessages, { batchSize = Number(process.env.C3_BATCH_SIZE || 6), onProgress, batchCache } = {}) {
  // The ballaster list is parsed deterministically elsewhere; sending it to the
  // model wastes tokens and yields rate-less duplicates of the tonnage spine.
  const dayMessages = allDayMessages.filter((m) => !/BALLASTER LIST/i.test(m.body));
  const records = [];

  const failed = [];

  // A batch of dense posts can overflow the response budget and come back as
  // truncated JSON. Halving the batch is almost always enough; only a single
  // message that still fails is dropped, and it is reported rather than hidden.
  async function run(batch, offset, depth = 0) {
    const user = `Today is ${dayMessages[0]?.date}. Extract records from these ${batch.length} broker messages.\n\n${renderBatch(batch, offset)}`;
    try {
      // The prompt text IS the key: same messages at the same positions give
      // the same answer. Re-extracting today after one new or edited message
      // then only pays for the batch that changed, not the whole day.
      const cached = batchCache && batchCache.get(user);
      const out = cached || await completeJson(SYSTEM, user);
      if (!cached && batchCache) batchCache.set(user, out);
      for (const r of out.records || []) {
        const src = dayMessages[r.i];
        if (!src) continue;
        records.push({
          ...r,
          restrictions: Array.isArray(r.restrictions) ? r.restrictions : [],
          date: src.date,
          time: src.time,
          minutes: src.minutes,
          sender: src.sender,
          raw: src.body,
        });
      }
    } catch (err) {
      // Configuration failures apply to every batch -- splitting just multiplies
      // the same error, so surface it immediately.
      if (
        /API_KEY is not set|authentication|invalid[_ ]api[_ ]key|credit balance is too low|billing|quota/i.test(err.message || "") ||
        err.status === 401
      ) {
        throw err;
      }
      if (batch.length > 1 && depth < 3) {
        const mid = Math.ceil(batch.length / 2);
        await run(batch.slice(0, mid), offset, depth + 1);
        await run(batch.slice(mid), offset + mid, depth + 1);
        return;
      }
      failed.push({ index: offset, time: batch[0]?.time, error: err.message.slice(0, 120) });
    }
  }

  for (let i = 0; i < dayMessages.length; i += batchSize) {
    await run(dayMessages.slice(i, i + batchSize), i);
    if (onProgress) onProgress(Math.min(i + batchSize, dayMessages.length), dayMessages.length);
  }

  if (failed.length) {
    console.error(`\n  ${failed.length} message(s) could not be extracted: ${failed.map((f) => f.time).join(", ")}`);
  }

  // Let the caller tell "the model ran and found nothing" apart from "the
  // model could not be reached". Both yield an empty array otherwise.
  records.failedBatches = failed.length;
  records.scanned = dayMessages.length;
  return records;
}

module.exports = { extractDay, SYSTEM };
