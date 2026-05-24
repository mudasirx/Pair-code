# Pair-code

This repo hosts two independent services that share a `.env` file and a single
Render blueprint:

1. **WhatsApp pairing website** (`src/`, `public/`) — Node.js + Baileys site
   that lets each visitor link their own WhatsApp number using a QR scan or an
   8-digit pair code. Foundation for a future WhatsApp bot.
2. **mysmsportal → Telegram bot** (`bot.py`) — Python worker that logs into
   [mysmsportal.com](http://mysmsportal.com), polls the SMS Test Numbers page,
   and forwards any new test-results rows to a Telegram chat.

The two services are deployed as separate Render services from the same
`render.yaml` blueprint — one `web` (Node) and one `worker` (Python).

---

## 1. WhatsApp Pairing Website

Multi-tenant pairing site built on top of
[Baileys](https://github.com/WhiskeySockets/Baileys). Each visitor gets their
own isolated WhatsApp session and can link their number using **either**:

- **QR code** (Settings → Linked devices → Link a device), or
- **Pair code** (Settings → Linked devices → Link with phone number instead)

### Stack

- **Node.js 20+**, CommonJS
- **Express** for the HTTP API
- **Baileys** (`@whiskeysockets/baileys`) for the WhatsApp Web protocol
- **Vanilla HTML/CSS/JS** for the frontend — no framework, no build step
- **Server-Sent Events** to push session state to the browser in real time
- **Multi-file auth state** persisted to disk so sessions survive restarts

### Local development

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

### API

| Method | Path                         | Description                                  |
| ------ | ---------------------------- | -------------------------------------------- |
| GET    | `/api/health`                | Liveness probe                               |
| POST   | `/api/sessions`              | Create a new session and start Baileys       |
| GET    | `/api/sessions`              | List known sessions                          |
| GET    | `/api/sessions/:id`          | Get current state for a session              |
| GET    | `/api/sessions/:id/events`   | SSE stream of state updates (QR, status…)   |
| POST   | `/api/sessions/:id/pair`     | Request an 8-digit pair code for a number    |
| POST   | `/api/sessions/:id/logout`   | Log out and wipe the session                 |

### Where the bot logic goes

`src/botHandler.js` exports `handleIncomingMessage({ sessionId, sock, update })`.
It is wired into Baileys' `messages.upsert` event for every active session.
For now it only handles `/ping` and `/start` — drop your own command handlers
in there.

---

## 2. mysmsportal Telegram Bot

A small Python worker that logs into mysmsportal.com, polls the **SMS Test
Numbers** page every 30 s, and sends any new rows from the test-results table
(Date / Termination / DDI / CLI / Status) to a Telegram chat.

### Configuration

Set these environment variables (see [`.env.example`](./.env.example)):

| Variable | Description |
|---|---|
| `MYSMSPORTAL_USERNAME` | mysmsportal.com login username |
| `MYSMSPORTAL_PASSWORD` | mysmsportal.com login password |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Target chat id (user / group / channel) |
| `POLL_INTERVAL_SECONDS` | Optional, default `30` |
| `STARTUP_NOTIFY` | Optional, send a "bot started" message on launch (default `true`) |

### Run locally

```bash
pip install -r requirements.txt
cp .env.example .env   # then edit values
set -a && source .env && set +a
python bot.py
```

### How it works

On startup the bot logs in, captures the test-results table as the
"already-seen" baseline (so it does not spam every existing row), and then on
each poll it compares the current rows against that baseline. New rows are
sent to Telegram in the order they appeared. If the session expires the client
transparently logs back in.

---

## Render deployment

[`render.yaml`](./render.yaml) is a Render Blueprint that defines **both**
services:

- A `web` service `whatsapp-bot-pairing` (Node, with a persistent disk at
  `/var/data` for `SESSIONS_DIR=/var/data/sessions`).
- A `worker` service `mysmsportal-telegram-bot` (Python).

Steps:

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, point it at this repo.
3. Render will create both services. On each service's **Environment** tab,
   fill in the secrets that have `sync: false`
   (`MYSMSPORTAL_USERNAME`, `MYSMSPORTAL_PASSWORD`, `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_CHAT_ID`).
4. Deploy.

> Background workers on Render require a paid plan. If you need a free
> alternative for the Python worker, you can run `python bot.py` on any
> always-on box (a small VPS, a Raspberry Pi, etc.) — it has no other
> infrastructure requirements.

## Security notes

- Sessions for the WhatsApp pairing site are stored on disk under
  `SESSIONS_DIR`. Treat that directory like a credentials store — anyone with
  access to it can impersonate the linked WhatsApp accounts.
- The `/api/sessions/:id/*` endpoints currently trust the session ID as a
  bearer token (whoever knows it controls that session). Session IDs are
  16 random hex chars (~64 bits of entropy), which is fine for the linking
  flow itself but you may want to add proper auth before exposing this on a
  shared URL.
- Baileys is an **unofficial** WhatsApp Web client. Accounts can be banned by
  WhatsApp at their discretion. For production / commercial use, the WhatsApp
  Cloud API is the official path.
