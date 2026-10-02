// Accounts.
//
// Two kinds of person use this. the owner is the admin: his account sees the C5 and
// C3 reading, the vessel matches and the broadcast tools. Everybody else is a
// customer who gets the broadcast tools and nothing else -- not a hidden tab,
// nothing. That separation is enforced in authz.js on every request; this file
// only decides who someone is.
//
// Stored as one JSON file. There are tens of accounts, not thousands, and a file
// that can be read with `cat` when something is wrong is worth more here than a
// database. Passwords are never in it -- only a scrypt hash and its salt.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const USERS_FILE = process.env.USERS_FILE || path.join(__dirname, "..", "data", "users.json");

// scrypt with the parameters Node recommends: deliberately slow, so a stolen
// file cannot be brute-forced at speed. 64 MB of memory per hash.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(plain, salt = crypto.randomBytes(16).toString("hex")) {
  const key = crypto.scryptSync(String(plain), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${salt}$${key.toString("hex")}`;
}

function verifyPassword(plain, stored) {
  const s = String(stored || "");
  const [scheme, salt, hex] = s.split("$");
  if (scheme !== "scrypt" || !salt || !hex) return false;
  const want = Buffer.from(hex, "hex");
  const got = crypto.scryptSync(String(plain), salt, want.length, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  // Same length by construction, but checked so timingSafeEqual cannot throw.
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const normalise = (email) => String(email || "").trim().toLowerCase();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function save(users) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  // Written to a neighbouring file and renamed, so a crash midway cannot leave
  // a half-written accounts file and lock everyone out.
  const tmp = USERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
  return users;
}

// What a request handler is allowed to see. Never includes the password hash or
// the 2FA secret -- those exist only inside this file.
function publicView(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name || "",
    role: u.role,
    status: u.status,
    twoFactor: Boolean(u.totpSecret),
    createdAt: u.createdAt || "",
    approvedAt: u.approvedAt || "",
    lastLoginAt: u.lastLoginAt || "",
  };
}

const findByEmail = (email) => load().find((u) => u.email === normalise(email)) || null;
const findById = (id) => load().find((u) => u.id === String(id)) || null;
const list = () => load().map(publicView);

function createUser({ email, password, name = "", role = "user", status = "pending" }) {
  const addr = normalise(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw new Error("That does not look like an email address");
  if (String(password || "").length < 8) throw new Error("Use a password of at least 8 characters");
  const users = load();
  if (users.some((u) => u.email === addr)) throw new Error("There is already an account with that email");
  const user = {
    id: "u" + crypto.randomBytes(8).toString("hex"),
    email: addr,
    name: String(name || "").trim().slice(0, 80),
    role: role === "admin" ? "admin" : "user",
    // A new customer waits for the owner: an account that cannot sign in yet cannot
    // start a WhatsApp session or see anything at all.
    status,
    password: hashPassword(password),
    createdAt: new Date().toISOString(),
    approvedAt: status === "active" ? new Date().toISOString() : "",
  };
  users.push(user);
  save(users);
  return publicView(user);
}

function update(id, change) {
  const users = load();
  const i = users.findIndex((u) => u.id === String(id));
  if (i < 0) throw new Error("No such account");
  users[i] = { ...users[i], ...change };
  save(users);
  return publicView(users[i]);
}

function setStatus(id, status) {
  if (!["pending", "active", "suspended"].includes(status)) throw new Error("Unknown status");
  const u = findById(id);
  if (!u) throw new Error("No such account");
  // The last admin must not be able to lock themselves out.
  if (u.role === "admin" && status !== "active") throw new Error("The admin account cannot be suspended");
  return update(id, { status, approvedAt: status === "active" ? (u.approvedAt || new Date().toISOString()) : u.approvedAt });
}

function setPassword(id, plain) {
  if (String(plain || "").length < 8) throw new Error("Use a password of at least 8 characters");
  return update(id, { password: hashPassword(plain) });
}

function remove(id) {
  const u = findById(id);
  if (!u) throw new Error("No such account");
  if (u.role === "admin") throw new Error("The admin account cannot be deleted");
  save(load().filter((x) => x.id !== String(id)));
  return true;
}

// Returns the account when the password is right AND the account may sign in.
// A pending or suspended account is refused with its own reason, so the owner can
// tell a customer why rather than guessing.
function authenticate(email, password) {
  const u = findByEmail(email);
  // Still hashes when there is no such account, so a missing address and a wrong
  // password take the same time and cannot be told apart.
  const ok = verifyPassword(password, u ? u.password : "scrypt$00$00");
  if (!u || !ok) return { ok: false, reason: "Wrong email or password" };
  if (u.status === "pending") return { ok: false, reason: "This account is waiting to be approved" };
  if (u.status === "suspended") return { ok: false, reason: "This account has been suspended" };
  return { ok: true, user: u };
}

// ---- Two-factor, for the admin only ----------------------------------------
// the owner's account reaches the broker's chat history and the vessel matching; a
// password alone is thin protection for that. Customers do not get this: they
// hold only their own broadcast lists, and a code they cannot receive would lock
// them out of a product they are paying for.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newTotpSecret = () => base32(crypto.randomBytes(20));

// RFC 6238, the scheme every authenticator app implements: a 6-digit code from
// an HMAC of the 30-second counter.
function totpAt(secret, counter) {
  const key = unbase32(secret);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter % 0x100000000, 4);
  const mac = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = ((mac[offset] & 0x7f) << 24 | mac[offset + 1] << 16 | mac[offset + 2] << 8 | mac[offset + 3]) % 1e6;
  return String(code).padStart(6, "0");
}

// One step either side, for a phone whose clock is slightly off.
function verifyTotp(secret, code, { at = Date.now(), window = 1 } = {}) {
  const given = String(code || "").replace(/\D/g, "");
  if (given.length !== 6 || !secret) return false;
  const step = Math.floor(at / 30000);
  for (let i = -window; i <= window; i++) {
    const want = Buffer.from(totpAt(secret, step + i));
    const got = Buffer.from(given);
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) return true;
  }
  return false;
}

// What an authenticator app scans. The secret never leaves the server except
// here, once, while the admin is enrolling.
function totpUri(secret, email, issuer = "Surfboard") {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

const needsTotp = (u) => Boolean(u && u.role === "admin" && u.totpSecret);
const totpSecretOf = (id) => (findById(id) || {}).totpSecret || "";
const enableTotp = (id, secret) => update(id, { totpSecret: String(secret) });
const disableTotp = (id) => update(id, { totpSecret: "" });

// The admin account exists from the first boot, from the environment, so there
// is never a window where the site is up with no owner. ADMIN_PASSWORD is only
// read when the account is being created; changing it later is done in the app.
// Where an admin lands when the deployment only ever had one password and no
// email. Kept stable so the account is found again on the next boot.
const LEGACY_ADMIN_EMAIL = "admin@arrowcape.local";

function ensureAdmin() {
  // A deployment that predates accounts has APP_PASSWORD and nothing else. It
  // still needs an admin, or nobody could approve a single customer.
  const email = normalise(process.env.ADMIN_EMAIL) ||
    (String(process.env.APP_PASSWORD || "").trim() ? LEGACY_ADMIN_EMAIL : "");
  if (!email) return null;
  const existing = findByEmail(email);
  if (existing) {
    // Promote in place if the role was ever lost, but never reset the password.
    if (existing.role !== "admin" || existing.status !== "active") {
      return update(existing.id, { role: "admin", status: "active" });
    }
    return publicView(existing);
  }
  const password = process.env.ADMIN_PASSWORD || process.env.APP_PASSWORD || "";
  if (String(password).length < 8) return null;
  return createUser({ email, password, name: process.env.ADMIN_NAME || "Admin", role: "admin", status: "active" });
}

const touchLogin = (id) => update(id, { lastLoginAt: new Date().toISOString() });

module.exports = {
  USERS_FILE, LEGACY_ADMIN_EMAIL,
  hashPassword, verifyPassword,
  list, findByEmail, findById, publicView,
  createUser, update, setStatus, setPassword, remove,
  authenticate, touchLogin, ensureAdmin,
  newTotpSecret, verifyTotp, totpUri, totpAt, needsTotp, totpSecretOf, enableTotp, disableTotp,
};
