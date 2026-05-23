# WhatsApp Bot Pairing Website

A multi-tenant WhatsApp pairing website built on top of
[Baileys](https://github.com/WhiskeySockets/Baileys). Each visitor gets their
own isolated WhatsApp session and can link their number using **either**:

- **QR code** (Settings → Linked devices → Link a device), or
- **Pair code** (Settings → Linked devices → Link with phone number instead)

This is the foundation for porting an existing Telegram bot to WhatsApp — the
linking flow + per-user session management live here. The actual bot logic
lives in `src/botHandler.js` and is intentionally minimal until the original
bot code is dropped in and ported.

## Why this exists

The user wanted to convert a Python Telegram bot to a WhatsApp bot. WhatsApp
doesn't have a "bot token" like Telegram — to act as a user, the bot needs to
be linked as a companion device on each user's WhatsApp account. This site is
the linking surface.

## Stack

- **Node.js 20+**, CommonJS
- **Express** for the HTTP API
- **Baileys** (`@whiskeysockets/baileys`) for the WhatsApp Web protocol
- **Vanilla HTML/CSS/JS** for the frontend — no framework, no build step
- **Server-Sent Events** to push session state to the browser in real time
- **Multi-file auth state** persisted to disk so sessions survive restarts

## Local development

```bash
cp .env.example .env
npm install
npm run dev
# open http://localhost:3000
```

When you open the site:

1. The browser POSTs to `/api/sessions` to create a fresh session ID.
2. The server boots a Baileys socket for that ID and starts streaming state
   over `/api/sessions/:id/events` (SSE).
3. Pick the QR or Pair Code tab and follow the on-screen steps.
4. Once connected, the bot logic in `src/botHandler.js` runs against incoming
   messages. Send `/ping` from another phone to test — the bot replies with
   `pong`.

The session ID is stored in `localStorage` so the same browser keeps reusing
the same WhatsApp session.

## API

| Method | Path                         | Description                                  |
| ------ | ---------------------------- | -------------------------------------------- |
| GET    | `/api/health`                | Liveness probe                               |
| POST   | `/api/sessions`              | Create a new session and start Baileys       |
| GET    | `/api/sessions`              | List known sessions                          |
| GET    | `/api/sessions/:id`          | Get current state for a session              |
| GET    | `/api/sessions/:id/events`   | SSE stream of state updates (QR, status…)   |
| POST   | `/api/sessions/:id/pair`     | Request an 8-digit pair code for a number    |
| POST   | `/api/sessions/:id/logout`   | Log out and wipe the session                 |

## Render deployment

A `render.yaml` blueprint is included:

- Web service on Node, build with `npm install`, start with `npm start`.
- Health check on `/api/health`.
- A persistent disk mounted at `/var/data`, with `SESSIONS_DIR=/var/data/sessions`,
  so per-user WhatsApp auth state survives deploys and restarts.

Push the repo to GitHub, then on Render:

1. **New → Blueprint** and point it at this repo.
2. Confirm the service and disk shown by Render match `render.yaml`.
3. Deploy. The site will be live at the URL Render gives you.

## Where the Telegram bot logic goes

`src/botHandler.js` exports `handleIncomingMessage({ sessionId, sock, update })`.
It is wired into Baileys' `messages.upsert` event for every active session.

Porting from Python Telegram bot is mostly mechanical:

- Telegram `@bot.message_handler(commands=['foo'])` → check the message text
  for `/foo` in `handleIncomingMessage` and call `sock.sendMessage(jid, …)`.
- External API calls (`requests.get(...)`) → use `fetch` (Node 20 has it
  built in) and `await` the response inside the handler.
- Per-user state → key it by the WhatsApp JID (`msg.key.remoteJid`) instead of
  Telegram `chat.id`.

Drop the original bot's code into the repo and I'll port it command by command.

## Security notes

- Sessions are stored on disk under `SESSIONS_DIR`. Treat that directory like
  a credentials store — anyone with access to it can impersonate the linked
  WhatsApp accounts.
- The `/api/sessions/:id/*` endpoints currently trust the session ID as a
  bearer token (whoever knows it controls that session). Session IDs are
  16 random hex chars (~64 bits of entropy), which is fine for the linking
  flow itself but you may want to add proper auth before exposing this on a
  shared URL.
- This uses Baileys, which is an **unofficial** WhatsApp Web client. Accounts
  can be banned by WhatsApp at their discretion. For production / commercial
  use, the WhatsApp Cloud API is the official path.
