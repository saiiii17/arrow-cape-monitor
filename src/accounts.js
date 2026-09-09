// The three miner accounts the owner tracks. `tokens` are matched case-insensitively
// on word boundaries; ports (Dampier, Hedland, Cape Preston) are deliberately
// absent since all three miners load through overlapping terminals.
const ACCOUNTS = [
  { id: "RIO", label: "RIO", tokens: ["rio", "rio tinto", "riotinto", "hamersley", "pilbara iron"] },
  { id: "FMG", label: "FMG", tokens: ["fmg", "fmgl", "fortescue"] },
  { id: "BHP", label: "BHP", tokens: ["bhp", "bhpb", "bhp billiton"] },
];

// A hit is "indirect" when the account is named as someone else's shipper, as a
// terms/charter-party reference, as a stated intention, or under negation --
// market colour rather than that account being live in the market itself.
const INDIRECT_PATTERNS = [
  /\bnon[\s-]?{A}\b/,
  /\bno\s+{A}\b/,
  /\bnot\s+{A}\b/,
  /\bex[\s-]{A}\b/,
  /\b{A}\s+(?:terms|t\/?c|cp|c\/p|form|rider|approved|approval|vetting)\b/,
  /\b(?:prefers?|prefer|basis|bss|on)\s+{A}\s+(?:terms|form|cp|c\/p)\b/,
  /\b{A}\s+shipper\b/,
  /\bshipper\s*[:\-]?\s*{A}\b/,
  /\b(?:intention|inten|intent|intended)\s*[:\-]?\s*{A}\b/,
  /\b{A}\s+(?:intention|inten|intent|intended|cargo\s+intention)\b/,
  /\b{A}\s+(?:index|ffa|tce)\b/,
  // "NYK - sell std cape - Rio only": an owner's restriction on their ship.
  // the owner: tonnage news, not a Rio update.
  /\b{A}\s+only\b/,
  /\bonly\s+{A}\b/,
];

function tokenAlternation(account) {
  return account.tokens
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
    .join("|");
}

function buildMatchers() {
  return ACCOUNTS.map((account) => {
    const alt = tokenAlternation(account);
    return {
      ...account,
      direct: new RegExp(`\\b(?:${alt})\\b`, "i"),
      indirect: INDIRECT_PATTERNS.map(
        (p) => new RegExp(p.source.replace(/\{A\}/g, `(?:${alt})`), "gi")
      ),
    };
  });
}

const MATCHERS = buildMatchers();

// Classify one message body: which accounts it names, and whether each mention
// is the account trading (direct) or just being referenced (indirect).
function accountsIn(body) {
  const hits = [];
  for (const m of MATCHERS) {
    if (!m.direct.test(body)) continue;
    const everyMentionIsIndirect = isFullyIndirect(body, m);
    hits.push({ id: m.id, label: m.label, relation: everyMentionIsIndirect ? "indirect" : "direct" });
  }
  return hits;
}

// True only when *every* occurrence of the account name is itself consumed by an
// indirect pattern. Containment is tested against the exact character range each
// pattern matched -- a nearby "BHP shipper" must not excuse a later bare "BHP".
// One unqualified mention anywhere makes the whole message a direct update.
function isFullyIndirect(body, matcher) {
  const occurrences = [...body.matchAll(new RegExp(matcher.direct.source, "gi"))];
  if (occurrences.length === 0) return false;

  const covered = [];
  for (const pattern of matcher.indirect) {
    pattern.lastIndex = 0;
    for (const m of body.matchAll(pattern)) {
      covered.push([m.index, m.index + m[0].length]);
    }
  }

  return occurrences.every((occ) =>
    covered.some(([start, end]) => occ.index >= start && occ.index + occ[0].length <= end)
  );
}

const ACCOUNT_REGEX = Object.fromEntries(MATCHERS.map((m) => [m.id, m.direct]));

module.exports = { ACCOUNTS, accountsIn, ACCOUNT_REGEX };
