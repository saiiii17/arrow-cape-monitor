// Who is allowed to reach what.
//
// the owner's account reads the broker's own chats -- the C5 account traffic, the C3
// cargo and tonnage extraction, the vessel matches, the history pulls. Customers
// pay for the broadcast tools and must never reach any of that. Hiding tabs in
// the page is not protection: anyone can type a URL. So every request passes
// through here first, and the page only decides what to draw.
//
// Three rules make the guarantee hold:
//
//   1. Deny by default. A path that is not in the table below needs admin. A new
//      route is therefore closed to customers until someone deliberately opens
//      it, and forgetting to list one shows up as a 403 for the person who added
//      it -- never as a leak.
//   2. The level is decided from the path alone, before any handler runs, so a
//      handler cannot be reached and then be relied on to check for itself.
//   3. Customers are confined to their own data by routing their broadcast
//      requests to a worker that only has their directories. Even a mistake here
//      cannot reach the owner's files, because the worker holds no path to them.

// Reachable with no account at all: signing in, registering, the public pages,
// and what an installed phone app asks for before anyone has logged in.
const PUBLIC = new Set([
  "/login", "/register", "/api/login", "/api/register", "/api/login/2fa",
  "/healthz",
  "/tutorial", "/pricing", "/privacy", "/terms", "/support",
  "/manifest.webmanifest", "/icon-180.png", "/icon-192.png", "/icon-512.png", "/favicon.png",
  "/logo.png",
]);

// Any signed-in account, customer or admin. This is the whole product for a
// customer, and the list is deliberately short enough to read in one go.
const SIGNED_IN = new Set([
  "/",                       // the page itself; it renders per role
  "/api/session",            // who am I, what may I see
  "/api/logout",
  "/api/me/password",        // change my own password

  // Their own WhatsApp: link it, see whether it is up, unlink it.
  "/api/wa/status",
  "/api/wa/start",
  "/api/wa/logout",
  "/api/wa/reset",

  // The broadcast tools.
  "/api/broadcast/chats",
  "/api/broadcast/lists",
  "/api/broadcast/tags",
  "/api/broadcast/preview",
  "/api/broadcast/upload",
  "/api/broadcast/send",
  "/api/broadcast/status",
  "/api/broadcast/recall",
  "/api/broadcast/relay",
]);

// Everything else is the owner's, listed so the intent is on the record rather than
// implied by absence. Anything new that is missing from every list lands here
// too, which is the point.
const ADMIN_ONLY = new Set([
  "/api/dates",              // which days of the broker's chats exist
  "/api/digest",             // the C5 account reading
  "/api/digest/brief",
  "/api/c3", "/api/c3/cached", "/api/c3/meta",   // cargo, tonnage, matches
  "/api/send",               // send the daily digest
  "/api/wa/watch",           // which groups to capture
  "/api/wa/groups",
  "/api/wa/sync",
  "/api/wa/backfill",        // pull chat history
  "/api/wa/import",
  "/api/wa/restore",
  "/api/wa/debug",           // the live-page probes
  "/api/users",              // approving and suspending accounts
  "/api/users/status",
  "/api/users/delete",
  "/api/admin/2fa",          // enrolling and removing the admin's 2FA
  "/api/admin/2fa/confirm",
  "/api/admin/workers",      // which customers' sessions are running
]);

const PUBLIC_PREFIXES = ["/assets/"];

// "public" | "user" | "admin". Unknown paths are admin, by design.
function levelFor(pathname) {
  const p = String(pathname || "");
  if (PUBLIC.has(p)) return "public";
  if (PUBLIC_PREFIXES.some((x) => p.startsWith(x))) return "public";
  if (SIGNED_IN.has(p)) return "user";
  return "admin";
}

// The single decision. `who` is the session's account, or null.
function decide(pathname, who) {
  const need = levelFor(pathname);
  if (need === "public") return { allow: true, need };
  if (!who) return { allow: false, need, why: "signin" };
  if (who.status !== "active") return { allow: false, need, why: "inactive" };
  if (need === "admin" && who.role !== "admin") return { allow: false, need, why: "forbidden" };
  return { allow: true, need };
}

// Exported so a test can walk every route the server actually serves and assert
// that none of them is reachable by a customer unless it is listed above.
module.exports = { decide, levelFor, PUBLIC, SIGNED_IN, ADMIN_ONLY };
