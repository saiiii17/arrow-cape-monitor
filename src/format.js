const { ACCOUNTS, ACCOUNT_REGEX } = require("./accounts");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function prettyDate(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

// Broker name minus the desk suffix -- "David Jones ARROW SG" -> "David Jones".
function shortSender(sender) {
  return sender.replace(/\s+ARROW.*$/i, "").replace(/\s+Arrow.*$/i, "").trim();
}

// For a passing mention, the useful line is the one naming the account, headed
// by the subject it belongs to -- "Cosco C5" alone tells the owner nothing.
function mentionLine(update, accountId) {
  const lines = update.body.split("\n").map((l) => l.trim()).filter(Boolean);
  const re = ACCOUNT_REGEX[accountId];
  const hit = lines.find((l) => re.test(l));
  if (!hit) return lines[0] || "";
  return hit === lines[0] ? hit : `${lines[0]} — ${hit}`;
}

function bulletise(update, indent, summarised) {
  // A verified summary replaces the message; an unverified one never does.
  if (summarised && update.summary && update.summaryVerified) {
    return `• ${update.time}  ${update.summary}\n${indent}— ${shortSender(update.sender)}${
      update.alsoFrom.length ? ` (also ${update.alsoFrom.map(shortSender).join(", ")})` : ""
    }`;
  }
  const lines = update.body.split("\n").map((l) => l.trim()).filter(Boolean);
  const head = `• ${update.time}  ${lines[0]}`;
  const rest = lines.slice(1).map((l) => `${indent}${l}`);
  const attribution = `${indent}— ${shortSender(update.sender)}${
    update.alsoFrom.length ? ` (also ${update.alsoFrom.map(shortSender).join(", ")})` : ""
  }`;
  return [head, ...rest, attribution].join("\n");
}

// The WhatsApp digest: one block per account, chronological, asterisks for bold.
function formatDigest(groups, date, { includeEmpty = true, summarised = false } = {}) {
  const indent = "        ";
  const blocks = [];

  for (const account of ACCOUNTS) {
    const g = groups[account.id];
    if (!g.direct.length && !g.indirect.length && !includeEmpty) continue;

    const parts = [`*${account.label}*  —  ${prettyDate(date)}`];

    if (g.direct.length === 0) {
      parts.push("• no activity");
    } else {
      parts.push(g.direct.map((u) => bulletise(u, indent, summarised)).join("\n"));
    }

    // Passing mentions ("BHP shipper", "Rio only") are noise per the owner -- they
    // are still classified so they cannot be mistaken for account activity,
    // but they are no longer shown.

    blocks.push(parts.join("\n"));
  }

  return blocks.join("\n\n\n");
}

// Flat rows for the dashboard table / CSV.
function toRows(groups, date) {
  const rows = [];
  for (const account of ACCOUNTS) {
    for (const relation of ["direct", "indirect"]) {
      for (const u of groups[account.id][relation]) {
        rows.push({
          account: account.id,
          date,
          time: u.time,
          sender: shortSender(u.sender),
          relation,
          source: u.source,
          update: u.body,
          summary: u.summary || null,
          summaryVerified: Boolean(u.summaryVerified),
        });
      }
    }
  }
  return rows.sort((a, b) => a.time.localeCompare(b.time));
}

module.exports = { formatDigest, toRows, prettyDate, shortSender };
