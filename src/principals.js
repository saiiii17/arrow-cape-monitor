// Counterparties who post their own headers in this group, harvested from the
// corpus (any name appearing 8+ times ahead of a header keyword). Used only to
// detect topic boundaries -- when a broker opens a new subject, the previous
// account context must not carry over into it.
//
// Regenerate with: npm run principals
const PRINCIPALS = [
  "alpha", "anglo", "aquavita", "baosteel", "berge", "bocimar", "brave",
  "capital", "cargill", "classic", "contango", "cosco", "costamare", "cse",
  "cyprus", "daiichi", "danaos", "erdemir", "five", "fiveocean", "genco",
  "glencore", "glovis", "golden", "hmm", "hosco", "hyundai", "jera", "jfe",
  "kepco", "klc", "kline", "koch", "kollakis", "ksc", "ldc", "maran",
  "marinsa", "marmaras", "merc", "mercuria", "minerva", "ming", "mingwah",
  "mittal", "mol", "moundreas", "navios", "norden", "nsc", "nsu", "nyk",
  "oak", "olden", "oldendorff", "pano", "panocean", "polaris", "polembros",
  "posco", "rgl", "richland", "roy", "rwe", "samonas", "ssangyong",
  "starbulk", "superior", "thenamaris", "tml", "trafigura", "uming", "union",
  "uniper", "vale", "wah", "welhunt", "winking", "zhejiang",
];

const PRINCIPAL_SET = new Set(PRINCIPALS);

const HEADER_KEYWORD =
  /\b(c5|c3|pac\s+(?:sell|buy)|pacific|tender|remains|update|sell|buy|next|fresh|fyi|latest|unchanged)\b/i;

// Words that open a genuine follow-up rather than name a principal.
const NOT_A_NAME = new Set([
  "no", "yes", "ok", "okay", "still", "holds", "hold", "bid", "bids", "offer",
  "offers", "done", "fixed", "fxd", "working", "nothing", "quiet", "same",
  "unchanged", "repeat", "noted", "thanks", "sorry", "correction", "fyi",
  "update", "remains", "failed", "sub", "subs", "withdrawn", "away", "counter",
  "nil", "none", "gone", "passed", "waiting", "checking", "reverting",
]);

function firstLine(body) {
  const line = body.split("\n").find((l) => l.trim());
  return line ? line.replace(/[*_~]/g, "").trim() : "";
}

// Does this message open a new subject? Bare rate/date follow-ups must not
// inherit an account across one of these.
function isTopicHeader(body) {
  const line = firstLine(body);
  if (!line) return false;

  if (/^A\/C\b/i.test(line)) return true;
  if (/^M\.?V\b/i.test(line)) return true;

  // A leading name of up to three words that we know posts its own enquiries.
  const lead = line.match(/^([A-Za-z][A-Za-z0-9'&.-]*(?:\s+[A-Za-z][A-Za-z0-9'&.-]*){0,2})/);
  if (lead) {
    const words = lead[1].toLowerCase().split(/\s+/);
    for (let n = words.length; n >= 1; n--) {
      if (PRINCIPAL_SET.has(words.slice(0, n).join(" "))) return true;
    }
  }

  // Generalises to principals not in the harvested list: "Someone - Pac sell",
  // "Someone C5", "SOMEONE TENDER".
  if (/^[A-Za-z][A-Za-z0-9 '&.-]{2,28}\s*[-–—:]\s*\S/.test(line) && HEADER_KEYWORD.test(line)) {
    return true;
  }
  if (/^[A-Za-z][A-Za-z0-9'&.-]*(?:\s+[A-Za-z][A-Za-z0-9'&.-]*){0,2}\s+(?:c5|c3|tender)\b/i.test(line)) {
    return true;
  }

  // "Dongnan - still there", "J Bekkers - can possibly look at Eaus business":
  // a name followed by a dash opens a new subject. Account names reaching here
  // is harmless -- those are resolved by name before context is ever consulted.
  if (/^[A-Z][A-Za-z'&.-]*(?:\s+[A-Z][A-Za-z'&.-]*){0,2}\s*[-–—]\s*\S/.test(line)) {
    return true;
  }

  // A multi-line message whose first line is a bare one-or-two-word name is the
  // group's standard way of opening a new principal's post ("Pacbulk", "OTSL",
  // "Golden Bricks"), even for principals too infrequent to have been harvested.
  const nonEmpty = body.split("\n").map((l) => l.replace(/[*_~]/g, "").trim()).filter(Boolean);
  if (
    nonEmpty.length >= 2 &&
    /^[A-Za-z][A-Za-z'&.-]*(?:\s+[A-Za-z][A-Za-z'&.-]*)?$/.test(nonEmpty[0]) &&
    !NOT_A_NAME.has(nonEmpty[0].toLowerCase().split(/\s+/)[0])
  ) {
    return true;
  }

  return false;
}

module.exports = { PRINCIPALS, isTopicHeader };
