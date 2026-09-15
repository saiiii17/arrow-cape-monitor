// The ONE decision about where messages come from, shared by the C5 and C3
// pipelines so they can never disagree.
//
//   a WhatsApp account is linked  -> that account's live messages, ONLY
//   nothing linked                -> the owner's sample exports, so the dashboard
//                                    has something real to show before anyone
//                                    scans a QR
//
// The sample exports are the owner's historical chats, used as demo fixtures. They
// must never be mixed with a linked account's data: merging them is what put
// the owner's brokers into the user's own "Work" group view.
const { load: loadLive, slug } = require("./livestore");

// live.js sets WA_LINKED=1 the moment a session is authenticated and clears it
// on unlink, so a linked account never sees sample data -- not even in the
// seconds before its first history pull.
function linked() {
  return process.env.WA_LINKED === "1";
}

function resolve(exported, group) {
  const forced = (process.env.DATA_SOURCE || "").toLowerCase();
  if (forced === "sample") return { messages: exported, source: "sample", group: null };

  const live = group ? loadLive(group) : [];
  // Being linked is the whole test. A previous session's captured messages
  // must not stand in for the exports once that account is gone -- before
  // connecting, the dashboard shows the owner's own history, not a stale echo of
  // whoever linked last.
  if (linked()) {
    return {
      messages: live.slice().sort((a, b) => (a.date === b.date ? a.minutes - b.minutes : a.date < b.date ? -1 : 1)),
      source: "live",
      group: group || null,
      empty: live.length === 0,
    };
  }
  return { messages: exported, source: "sample", group: null };
}

// Human label for the header.
function label(r) {
  if (r.source === "live") {
    const live = process.env.WA_CONNECTED === "1";
    if (!r.group) return live ? "WhatsApp connected — no group chosen yet" : "saved WhatsApp data — not connected";
    if (r.empty) return live
      ? `connected · ${r.group} · no messages yet`
      : `saved · ${r.group} · no messages — connect and pull history`;
    // The data is this account's real captured messages either way; the only
    // difference is whether new ones are arriving right now.
    return live
      ? `LIVE · ${r.group} · ${r.messages.length} messages`
      : `saved (not connected) · ${r.group} · ${r.messages.length} messages`;
  }
  return "sample data (the owner's exports) — link WhatsApp to replace";
}

// Cache namespace, so extractions from one source are never served for another.
function cacheKey(r) {
  return r.source === "live" ? `live-${slug(r.group || "none")}` : "sample";
}

module.exports = { resolve, label, cacheKey };
