// Signing in.
//
// There are accounts now rather than one shared password: the owner is the admin and
// everybody else is a customer who gets the broadcast tools. This file answers
// one question -- who is making this request -- and authz.js decides what they
// may do with it.
//
// The session is a signed cookie naming the account. Nothing is stored server
// side, so a restart does not sign anyone out, but the account is re-read on
// every request: suspending someone takes effect on their next click rather than
// whenever their cookie happens to expire.
const crypto = require("crypto");
const users = require("./users");

const DAYS = Number(process.env.SESSION_DAYS || 30);
const COOKIE = "acm_session";

// Derived from whatever secret the deployment has. Changing it signs everyone
// out, which is the desired behaviour when a secret is rotated.
const SECRET = process.env.SESSION_SECRET
  ? Buffer.from(String(process.env.SESSION_SECRET))
  : crypto.createHash("sha256").update(`acm-session:${process.env.ADMIN_EMAIL || ""}:${process.env.APP_PASSWORD || ""}`).digest();

// Sign-in is on if there is any reason for it to be: an admin email, the older
// single APP_PASSWORD, or accounts already on disk. Only a machine with none of
// those -- a developer's laptop, a test run -- is open.
//
// APP_PASSWORD counts deliberately. The deployed site has it set and no
// ADMIN_EMAIL, and forgetting it here would have turned the password off on the
// next deploy and left the broker's chats on a public URL.
function enabled() {
  if (process.env.AUTH_OFF === "1") return false;
  if (String(process.env.ADMIN_EMAIL || "").trim()) return true;
  if (String(process.env.APP_PASSWORD || "").trim()) return true;
  try { return users.list().length > 0; } catch { return false; }
}

// Who a request with no sign-in counts as while the server is open. An admin, so
// local development and the test suites behave as they always did.
const DEV_ADMIN = Object.freeze({ id: "dev", email: "dev@localhost", name: "Developer", role: "admin", status: "active" });

const mac = (data) => crypto.createHmac("sha256", SECRET).update(String(data)).digest("base64url");

function sessionCookie(req, user) {
  const exp = Date.now() + DAYS * 864e5;
  const body = `${user.id}.${exp}`;
  const https = String(req.headers["x-forwarded-proto"] || "").includes("https");
  return `${COOKIE}=${body}.${mac(body)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${https ? "; Secure" : ""}`;
}

const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

function readCookie(req) {
  const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  if (!(Number(exp) > Date.now())) return null;
  const want = Buffer.from(mac(`${uid}.${exp}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return uid;
}

// The account behind this request, or null. Read fresh each time so a change of
// role or status applies at once.
function whoami(req) {
  if (!enabled()) return DEV_ADMIN;
  const uid = readCookie(req);
  if (!uid) return null;
  const u = users.findById(uid);
  if (!u) return null;                       // deleted since signing in
  return users.publicView(u);
}

// ---- The two-step sign-in for the admin ------------------------------------
// Password first. If the account is the admin and has 2FA on, the password alone
// yields a short-lived ticket rather than a session, and the code redeems it.
// The ticket is signed, carries its own expiry and is not a session: on its own
// it opens nothing.
const TICKET_SECONDS = 180;

function makeTicket(user) {
  const exp = Date.now() + TICKET_SECONDS * 1000;
  const body = `2fa.${user.id}.${exp}`;
  return `${body}.${mac(body)}`;
}

function readTicket(ticket) {
  const parts = String(ticket || "").split(".");
  if (parts.length !== 4 || parts[0] !== "2fa") return null;
  const [, uid, exp, sig] = parts;
  if (!(Number(exp) > Date.now())) return null;
  const want = Buffer.from(mac(`2fa.${uid}.${exp}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return uid;
}

// Ten attempts a minute per address: enough for typos, useless for guessing.
// Codes are rationed harder -- six digits is a small space to walk.
const attempts = new Map();
const LOGIN_LIMIT = Number(process.env.LOGIN_ATTEMPTS_PER_MIN || 10);
function allowAttempt(ip, kind = "login", limit = LOGIN_LIMIT) {
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((t) => now - t < 60_000);
  if (recent.length >= limit) { attempts.set(key, recent); return false; }
  recent.push(now);
  attempts.set(key, recent);
  return true;
}

module.exports = {
  enabled, whoami, sessionCookie, clearCookie, allowAttempt,
  makeTicket, readTicket, DEV_ADMIN, COOKIE,
};
