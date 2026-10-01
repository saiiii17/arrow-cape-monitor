// One customer's WhatsApp, in its own process.
//
// the owner runs inside the main server, exactly as he always has. Every other
// account gets one of these instead: a separate process, holding a separate
// Chromium, pointed at directories that belong to that customer alone. The main
// server passes their broadcast requests through to it and nothing else.
//
// Two reasons it is a process and not a module:
//
//   Isolation that does not depend on being careful. The worker is started with
//   its own LIVE_STORE_DIR, WWEBJS_PATH, LISTS_FILE and the rest. It holds no
//   path to the broker's chats, so no mistake in routing or in a handler can
//   reach them -- there is nothing here to reach them with.
//
//   A crash stays local. whatsapp-web.js drives a real browser and sometimes
//   that browser dies. One customer's Chromium falling over must not take the
//   broker's monitor down with it.
//
// It listens on localhost only, on a port the parent chooses, and every request
// must carry the shared secret the parent passed in. Another process on the same
// machine cannot talk to it by guessing a port.
const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.WORKER_PORT || 0);
const SECRET = String(process.env.WORKER_SECRET || "");
const USER = String(process.env.WORKER_USER || "?");
if (!SECRET) {
  console.error("wa-worker: refusing to start without WORKER_SECRET");
  process.exit(1);
}

const live = require("./live");

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

// Compared in constant time so the secret cannot be found a character at a time.
function authorised(req) {
  const given = Buffer.from(String(req.headers["x-worker-secret"] || ""));
  const want = Buffer.from(SECRET);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname === "/healthz") return json(res, 200, { ok: true, user: USER });
  if (!authorised(req)) return json(res, 403, { error: "not for you" });

  try {
    // ---- their own WhatsApp ------------------------------------------------
    if (url.pathname === "/api/wa/status") return json(res, 200, live.snapshot());

    if (url.pathname === "/api/wa/start" && req.method === "POST") {
      const phone = url.searchParams.get("phone");
      if (phone != null) {
        const digits = phone.replace(/\D/g, "");
        if (digits.length < 8 || digits.length > 15) {
          return json(res, 400, { error: "Enter the number with its country code, digits only — e.g. 971501234567" });
        }
      }
      live.start({ fresh: url.searchParams.get("resume") !== "1", phone: phone || undefined });
      return json(res, 200, live.snapshot());
    }

    if (url.pathname === "/api/wa/logout" && req.method === "POST") {
      // Unlinking belongs to the customer: it is their number.
      live.logout({ unlink: true, wipe: true, clearData: true });
      return json(res, 200, live.snapshot());
    }

    if (url.pathname === "/api/wa/reset" && req.method === "POST") {
      live.logout({ unlink: false });
      live.clearStaleProfileLockAsync().catch(() => {});
      return json(res, 200, { ...live.snapshot(), cleared: ["clearing browser profile"] });
    }

    // ---- broadcasting ------------------------------------------------------
    if (url.pathname === "/api/broadcast/chats") {
      const tagged = live.loadTags();
      try { return json(res, 200, { connected: true, chats: await live.listChats(), tagged }); }
      catch (e) { return json(res, 200, { connected: false, reason: e.message, chats: tagged, tagged }); }
    }

    if (url.pathname === "/api/broadcast/lists") {
      if (req.method === "POST") {
        const { lists } = await readBody(req);
        return json(res, 200, { lists: live.saveLists(lists) });
      }
      return json(res, 200, { lists: live.loadLists() });
    }

    if (url.pathname === "/api/broadcast/tags" && req.method === "POST") {
      const { tags } = await readBody(req);
      return json(res, 200, { tagged: live.saveTags(tags) });
    }

    if (url.pathname === "/api/broadcast/preview" && req.method === "POST") {
      const { text, listId } = await readBody(req);
      const list = live.getList(listId || "");
      const chats = (list && list.chats) || [];
      return json(res, 200, {
        personalised: live.hasTokens(text),
        samples: chats.slice(0, 3).map((c) => ({ name: c.name, text: live.personalise(text, c) })),
        more: Math.max(0, chats.length - 3),
      });
    }

    if (url.pathname === "/api/broadcast/upload" && req.method === "POST") {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) return json(res, 400, { error: "That file is too large" });
        chunks.push(chunk);
      }
      return json(res, 200, live.saveUpload(Buffer.concat(chunks), {
        name: url.searchParams.get("name") || "file",
        type: url.searchParams.get("type") || req.headers["content-type"] || "",
      }));
    }

    if (url.pathname === "/api/broadcast/send" && req.method === "POST") {
      const { text, dryRun, listId, mediaId, mediaIds } = await readBody(req);
      return json(res, 200, await live.broadcast(text, {
        dryRun: Boolean(dryRun), listId: listId || "", mediaId: mediaId || "",
        mediaIds: Array.isArray(mediaIds) ? mediaIds : [],
      }));
    }

    if (url.pathname === "/api/broadcast/recall" && req.method === "POST") {
      return json(res, 200, await live.recallBroadcast({}));
    }

    if (url.pathname === "/api/broadcast/status") {
      await live.refreshAcks().catch(() => {});
      return json(res, 200, live.broadcastStatus());
    }

    if (url.pathname === "/api/broadcast/relay") {
      if (req.method === "POST") return json(res, 200, live.saveRelay(await readBody(req)));
      return json(res, 200, live.loadRelay());
    }

    // Anything else does not exist here. The broker's reading is not absent
    // because it is refused -- there is no route to it in this process at all.
    return json(res, 404, { error: "no such route" });
  } catch (e) {
    return json(res, 400, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // The parent reads this line to learn which port was given.
  console.log(`worker-ready ${server.address().port}`);
});

// Closing the browser without unlinking, so a worker that is stopped to save
// memory does not cost the customer a fresh QR scan when they come back.
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (stopping) process.exit(0);
    stopping = true;
    try { await Promise.race([live.shutdown(), new Promise((r) => setTimeout(r, 8000))]); } catch { /* going down */ }
    process.exit(0);
  });
}
