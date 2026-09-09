require("dotenv").config();
const { buildDigest, datesAvailable } = require("./digest");
const { sendToSelf } = require("./whatsapp");

// Sends one day's digest to WhatsApp, then exits.
//   npm run send            -> most recent day in the export
//   npm run send 2026-09-02 -> that day
(async () => {
  const arg = process.argv[2];
  const date = arg && arg !== "latest" ? arg : datesAvailable().pop();

  const digest = buildDigest(date);
  const total = Object.values(digest.groups).reduce((n, g) => n + g.direct.length, 0);

  if (total === 0) {
    console.log(`No RIO/FMG/BHP activity on ${date} — nothing sent.`);
    process.exit(0);
  }

  console.log(`Sending ${date} (${total} updates)...`);
  const to = await sendToSelf(digest.text);
  console.log(`Sent to ${to}`);
  process.exit(0);
})().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
