// Password protection for the dashboard.
//
// The dashboard shows the linked account's chats and can broadcast from it, so
// once it is on a public URL it must not be open to anyone who finds the link.
// Off unless APP_PASSWORD is set: local use and the test suites are unchanged.
//
// A successful login sets a signed cookie (HMAC over its expiry), valid for 30
// days so an app on the home screen stays logged in. Nothing is stored on the
// server; changing APP_PASSWORD invalidates every existing session.
const crypto = require("crypto");

const PASSWORD = process.env.APP_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update(`acm-session:${PASSWORD}`).digest();
const DAYS = Number(process.env.SESSION_DAYS || 30);
const COOKIE = "acm_session";

// Reachable without logging in: the login itself, what the phone needs to
// install the app, and Render's health check.
const PUBLIC = new Set([
  "/login", "/api/login", "/healthz", "/api/dates",
  "/manifest.webmanifest", "/icon-180.png", "/icon-192.png", "/icon-512.png", "/favicon.png",
]);

function enabled() {
  return Boolean(PASSWORD);
}

function isPublic(pathname) {
  return PUBLIC.has(pathname);
}

const sign = (exp) => crypto.createHmac("sha256", SECRET).update(String(exp)).digest("base64url");

function sessionCookie(req) {
  const exp = Date.now() + DAYS * 864e5;
  // Secure only behind HTTPS (Render); locally the app is plain http.
  const https = String(req.headers["x-forwarded-proto"] || "").includes("https");
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${https ? "; Secure" : ""}`;
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function isLoggedIn(req) {
  const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Compared as hashes so the comparison takes the same time whatever was typed.
function checkPassword(given) {
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(PASSWORD).digest();
  return enabled() && crypto.timingSafeEqual(a, b);
}

// Ten attempts a minute per address: enough for typos, useless for guessing.
const attempts = new Map();
function allowAttempt(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 10) { attempts.set(ip, recent); return false; }
  recent.push(now);
  attempts.set(ip, recent);
  return true;
}

module.exports = { enabled, isPublic, sessionCookie, clearCookie, isLoggedIn, checkPassword, allowAttempt };
