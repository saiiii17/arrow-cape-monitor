require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

// Where the digest lands. Default is the owner's own "Message yourself" chat;
// set DIGEST_TARGET to a number ("9715xxxxxxx") or a group name to override.
const TARGET = process.env.DIGEST_TARGET || "";

let clientPromise = null;

function createClient() {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: "digest" }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
  });

  client.on("qr", (qr) => {
    console.log("\nScan this QR code in WhatsApp → Linked Devices:\n");
    qrcode.generate(qr, { small: true });
  });

  return new Promise((resolve, reject) => {
    client.once("ready", () => {
      console.log(`WhatsApp ready as ${client.info.pushname}`);
      resolve(client);
    });
    client.once("auth_failure", (m) => reject(new Error(`WhatsApp auth failed: ${m}`)));
    client.initialize().catch(reject);
  });
}

function getClient() {
  if (!clientPromise) clientPromise = createClient();
  return clientPromise;
}

async function resolveTarget(client) {
  if (!TARGET) return client.info.wid._serialized; // message yourself

  if (/^\d{8,15}$/.test(TARGET)) {
    const id = await client.getNumberId(TARGET);
    if (!id) throw new Error(`${TARGET} is not on WhatsApp`);
    return id._serialized;
  }

  const chats = await client.getChats();
  const chat = chats.find((c) => c.name?.toLowerCase() === TARGET.toLowerCase());
  if (!chat) throw new Error(`No chat named "${TARGET}"`);
  return chat.id._serialized;
}

// WhatsApp truncates very long messages, so each account block goes separately
// when the digest is large.
function split(text, limit = 3500) {
  if (text.length <= limit) return [text];
  const blocks = text.split("\n\n\n");
  const out = [];
  let buf = "";
  for (const b of blocks) {
    if (buf && (buf + "\n\n\n" + b).length > limit) {
      out.push(buf);
      buf = b;
    } else {
      buf = buf ? `${buf}\n\n\n${b}` : b;
    }
  }
  if (buf) out.push(buf);
  return out;
}

async function sendToSelf(text) {
  const client = await getClient();
  const to = await resolveTarget(client);
  for (const part of split(text)) {
    await client.sendMessage(to, part);
  }
  return to;
}

module.exports = { sendToSelf, getClient };
