const fs = require("fs");

// WhatsApp exports prefix some lines with LTR/RTL marks and use a narrow
// no-break space before AM/PM, so the header regex has to be permissive.
const HEADER = /^‎?\[(\d{2})\/(\d{2})\/(\d{4}),\s(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)\]\s([^:]+):\s?([\s\S]*)$/;

const SYSTEM_MARKERS = [
  "Messages and calls are end-to-end encrypted",
  "created this group",
  "added you",
  "This message was deleted",
  "You deleted this message",
  "changed the subject",
  "changed this group's icon",
  "joined using this group's invite link",
  "image omitted",
  "video omitted",
  "sticker omitted",
  "document omitted",
  "audio omitted",
  "GIF omitted",
];

function clean(text) {
  return text
    .replace(/[‎‏]/g, "")
    .replace(/ /g, " ")
    .replace(/<This message was edited>/g, "")
    .trimEnd();
}

function to24h(hour, ampm) {
  let h = Number(hour);
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return h;
}

function isSystem(body) {
  return SYSTEM_MARKERS.some((m) => body.includes(m));
}

// Returns messages as flat records. Timestamps stay as plain date/time fields
// (the export is already in the group's local Dubai time) so no Date object
// ever gets a chance to shift them into the host machine's timezone.
function parseChatExport(filePath) {
  return parseChatText(fs.readFileSync(filePath, "utf8"));
}

// Same parser, from a string -- used by the export upload path.
function parseChatText(raw) {
  const lines = raw.split(/\r?\n/);
  const messages = [];
  let current = null;

  const push = () => {
    if (!current) return;
    current.body = clean(current.body).trim();
    if (current.body && !isSystem(current.body)) messages.push(current);
    current = null;
  };

  for (const line of lines) {
    const m = line.match(HEADER);
    if (m) {
      push();
      const [, dd, mm, yyyy, hh, min, , ampm, sender, rest] = m;
      const hour = to24h(hh, ampm);
      current = {
        date: `${yyyy}-${mm}-${dd}`,
        time: `${String(hour).padStart(2, "0")}:${min}`,
        minutes: hour * 60 + Number(min),
        sender: clean(sender).trim(),
        body: rest,
      };
    } else if (current) {
      current.body += "\n" + line;
    }
  }
  push();

  return messages;
}

function messagesForDate(messages, date, startHour, endHour) {
  return messages.filter(
    (m) =>
      m.date === date &&
      m.minutes >= startHour * 60 &&
      m.minutes < endHour * 60
  );
}

function availableDates(messages) {
  return [...new Set(messages.map((m) => m.date))].sort();
}

module.exports = { parseChatExport, parseChatText, messagesForDate, availableDates };
