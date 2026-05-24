# Pair-code

This repo bundles three small services that share a `.env` file and a single
Render blueprint:

1. **WhatsApp pairing website** (`src/`, `public/`) — Node + Express + Baileys
   site that lets each visitor link their own WhatsApp number using a QR scan
   or an 8-digit pair code. Useful as the linking surface for any future
   WhatsApp bot logic.
2. **mysmsportal → Telegram worker** (`bot.py`) — Python worker that logs into
   [mysmsportal.com](http://mysmsportal.com), polls the SMS Test Numbers page,
   and forwards any new test-results rows to a Telegram chat.
3. **mysmsportal → WhatsApp worker** (`whatsapp_bot.js`) — Node worker that
   does the same job as `bot.py`, but sends the alerts over WhatsApp instead
   of Telegram. Uses Baileys with a pre-paired session.

All three services are deployed as separate Render services from the same
`render.yaml` blueprint: one `web` (Node) and two `worker`s (Python + Node).

---

## 1. WhatsApp Pairing Website

Multi-tenant pairing site built on top of
[Baileys](https://github.com/WhiskeySockets/Baileys). Each visitor gets their
own isolated WhatsApp session and can link their number using **either**:

- **QR code** (Settings → Linked devices → Link a device), or
- **Pair code** (Settings → Linked devices → Link with phone number instead)

### Stack

- Node.js 20+, Express, Baileys
- Vanilla HTML/CSS/JS frontend — no build step
- Server-Sent Events to push session state to the browser in real time
- Multi-file auth state persisted to disk

### Local development

```bash
cp .env.example .env
npm install
npm run dev
# open http://localhost:3000
```

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

The bot logic lives in `src/botHandler.js` and is wired into Baileys'
`messages.upsert` event for every active session. Add your own command
handlers there.

---

## 2. mysmsportal Telegram worker (`bot.py`)

### Configuration

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

---

## 3. mysmsportal WhatsApp worker (`whatsapp_bot.js`)

Uses Baileys with a pairing code (no QR scan). The bot needs to be linked
once from a real WhatsApp account, after which it stays linked indefinitely
(until you unlink it from WhatsApp → Linked Devices).

The recommended flow is to **pair directly on Render** — no local pairing
needed. The Render Blueprint ships with a 1 GB persistent disk mounted at
`/var/data`, so the credentials produced by the first-boot pairing survive
restarts and redeploys.

### Configuration

| Variable | Description |
|---|---|
| `MYSMSPORTAL_USERNAME` | mysmsportal.com login username |
| `MYSMSPORTAL_PASSWORD` | mysmsportal.com login password |
| `WHATSAPP_PHONE_NUMBER` | Phone number to link, digits only with country code (e.g. `923001234567`). Used only on first boot to request the pairing code. |
| `WHATSAPP_TARGET` | Optional. Phone number (digits only) or full JID (`...@s.whatsapp.net` / `...@g.us`) to send messages to. Defaults to the linked account itself. |
| `AUTH_DIR` | Where Baileys stores credentials. Defaults to `/var/data/auth_info_baileys` on Render (persistent disk). |
| `WHATSAPP_AUTH_BASE64` | Optional fallback. If set and `AUTH_DIR` is empty, the bot unpacks this base64 payload into `AUTH_DIR` on boot. Useful if you can't use a disk. |
| `POLL_INTERVAL_SECONDS` | Optional, default `30` |
| `STARTUP_NOTIFY` | Optional, send a "bot started" message on launch (default `true`) |

### Pair directly on Render (recommended)

1. Push this repo to GitHub.
2. Create the Render Blueprint (`New → Blueprint`).
3. On the **`mysmsportal-whatsapp-bot`** service, set the env vars from the
   table above — at minimum `MYSMSPORTAL_USERNAME`, `MYSMSPORTAL_PASSWORD`,
   and `WHATSAPP_PHONE_NUMBER`.
4. Deploy. Open the worker's **Logs** tab and wait for a banner like:

   ```
   ======================================================
     WhatsApp pairing code:  ABCD-1234
   ======================================================
   ```
5. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device →
   "Link with phone number instead"** and enter the 8-digit code. Code is
   valid for ~60 seconds — if it expires just restart the worker to get a
   fresh one.
6. The bot finishes linking, saves the credentials to `/var/data`, and
   starts polling. From now on every restart reuses the saved auth, so you
   can clear `WHATSAPP_PHONE_NUMBER` if you want (optional).

### Pair locally (optional alternative)

If you prefer pairing on your own machine first:

```bash
npm install
npm run pair                # prompts for phone, prints the pairing code
npm run start:portal-wa     # smoke-test polling locally with portal env vars set
npm run export-auth         # produces whatsapp_auth.base64.txt
```

Then set `WHATSAPP_AUTH_BASE64` on Render to the contents of that file. On
first boot the bot will unpack it into `AUTH_DIR` and skip pairing.

> **Heads up:** the base64 payload contains your WhatsApp session keys —
> treat it like a password. Never commit it.

---

## Render deployment

[`render.yaml`](./render.yaml) is a Render Blueprint that defines all three
services:

- `web` — `whatsapp-bot-pairing` (Node, persistent disk at `/var/data` for
  `SESSIONS_DIR=/var/data/sessions`).
- `worker` — `mysmsportal-telegram-bot` (Python).
- `worker` — `mysmsportal-whatsapp-bot` (Node).

Steps:

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, point it at this repo.
3. Render creates the three services. On each service's **Environment** tab,
   fill in the secrets that have `sync: false`.
4. Deploy.

> Background workers on Render require a paid plan. As a free alternative,
> the workers run fine on any always-on box (small VPS, Raspberry Pi, etc.).

## How dedupe works (both workers)

On startup each worker logs in, captures the current rows of the test-results
table as the "already-seen" baseline (so it doesn't spam history), and on each
subsequent poll compares the new snapshot against that baseline. New rows are
sent in the order they appeared. If the portal session expires the client
transparently logs back in.

Dedupe state is in-memory. If a worker restarts, it re-baselines on its first
poll.

## Security notes

- WhatsApp pairing site sessions live under `SESSIONS_DIR` and the WhatsApp
  worker's session lives in `auth_info_baileys/`. Treat both like credentials.
- `WHATSAPP_AUTH_BASE64` contains WhatsApp session keys — never commit it.
- The `/api/sessions/:id/*` endpoints currently trust the session ID as a
  bearer token. Session IDs are 16 random hex chars; add proper auth before
  exposing the pairing site on a public URL.
- Baileys is an **unofficial** WhatsApp Web client. Accounts can be banned by
  WhatsApp at their discretion. For production / commercial use, the WhatsApp
  Cloud API is the official path.
