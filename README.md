# Arrow Cape

Broadcast one WhatsApp message to many chats, each greeted by name, from a web
app. Built for a shipbroking desk that sends the same rundown to dozens of
groups every morning.

It drives WhatsApp Web through a real headless browser. There is no official
WhatsApp API involved — see **Caveats** before putting it in front of anyone.

## What it does

- **Saved lists** of chats, as many as you like
- **One message to all of them**, sent one at a time with a pause between
- **Greeted by name** — `Good morning {name}` arrives as "Good morning Meridian"
  to one chat and "Good morning Dalton" to the next
- **Images and files**, up to ten per broadcast
- **Recall** — delete for everyone, across every chat it reached
- **Delivered and read marks** per chat, read from WhatsApp's own message store
- **Broadcast from a WhatsApp group** — post there, it goes out to a list
- **Accounts**: an admin, plus customers who get the broadcast tools and nothing
  else. Each customer's WhatsApp runs in its own process with its own files.

The admin account also carries a separate monitoring side: it reads two named
groups, extracts cargo and tonnage with Claude, and matches them.

## Running it

```bash
npm install
npm run dashboard          # http://localhost:4321
```

With no `ADMIN_EMAIL` and no `APP_PASSWORD`, sign-in is off and you are treated
as the admin — which is what the test suites rely on. Set either one and
accounts apply to everything.

### Configuration

| Variable | What it does |
| --- | --- |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Creates the admin on first boot. The password is read once; change it in the app |
| `SESSION_SECRET` | Signs session cookies. Changing it signs everyone out |
| `ANTHROPIC_API_KEY` | For the admin's cargo/tonnage extraction only. Customers' broadcasting uses no AI |
| `C5_GROUP`, `C3_GROUP` | The two groups the admin monitors |
| `WWEBJS_PATH` | Where WhatsApp logins are stored. **On a container this must be on the mounted volume** |
| `USERS_FILE`, `USERS_DATA_DIR` | Accounts, and one folder per customer |
| `WORKER_IDLE_MINUTES` | How long a customer's browser may idle before it closes. Default 30 |
| `BROADCAST_MAX` | Cap on chats per broadcast |

Copy `.env.example` to `.env` to start.

## Tests

```bash
npm test                   # 239 assertions, no browser needed
npm run test:ui            # dashboard, needs a server running
npm run test:ui:accounts   # sign-in and accounts, needs a server with an admin
```

`npm test` includes suites that take the attacker's side: they sign in as a
customer, walk every route the server has, and fail if anything that is not the
broadcast tools answers instead of refusing.

## How it is put together

| File | What it is |
| --- | --- |
| `src/server.js` | HTTP server and routing |
| `src/authz.js` | Who may reach what. Denies by default |
| `src/auth.js`, `src/users.js` | Sessions, accounts, scrypt passwords, admin 2FA |
| `src/workers.js`, `src/wa-worker.js` | One WhatsApp process per customer, with its own files |
| `src/live.js` | WhatsApp itself: linking, capture, broadcasting, recall |
| `src/c3/` | Cargo and tonnage extraction, and matching |
| `src/public/` | The dashboard and the public pages |

Accounts are a JSON file, not a database — tens of accounts, and a file you can
read when something is wrong. Passwords are scrypt hashes with per-account
salts; the password itself is never stored.

## Caveats

**This is not an official WhatsApp integration.** It drives WhatsApp Web the way
a person would. Automated or bulk messaging is against the spirit of WhatsApp's
terms, and they may restrict a number that does it. Sends are paced and
broadcasts are capped to reduce that, but the risk is real and it falls on the
account doing the sending. For anything commercial, price the official
WhatsApp Business Cloud API first.

**Each linked WhatsApp costs about 1.2 GB of memory**, because each one is a
browser. Cost scales with people signed up, not messages sent.
