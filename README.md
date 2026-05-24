# mysmsportal alert bots

Two small workers that log into [mysmsportal.com](http://mysmsportal.com), poll
the **SMS Test Numbers** page every 30 seconds, and forward any new rows from
the test-results table (Date / Termination / DDI / CLI / Status) to a chat:

- **`bot.py`** — Telegram bot (Python, `requests` + `beautifulsoup4`).
- **`whatsapp_bot.js`** — WhatsApp bot (Node.js, [Baileys](https://github.com/WhiskeySockets/Baileys)
  linked via 8-digit pairing code).

Both bots are deployed by the included Render Blueprint ([`render.yaml`](./render.yaml))
as background workers. You can run either one independently.

---

## Telegram bot (`bot.py`)

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

## WhatsApp bot (`whatsapp_bot.js`)

Uses Baileys with a pairing code (no QR scan). The bot needs to be linked once
from a real WhatsApp account, after which it stays linked indefinitely (until
you unlink it from WhatsApp → Linked Devices).

### Configuration

| Variable | Description |
|---|---|
| `MYSMSPORTAL_USERNAME` | mysmsportal.com login username |
| `MYSMSPORTAL_PASSWORD` | mysmsportal.com login password |
| `WHATSAPP_AUTH_BASE64` | Base64-encoded zip of the `auth_info_baileys/` folder produced by `npm run pair`. Required on Render. Not needed locally. |
| `WHATSAPP_TARGET` | Optional. Phone number (digits only) or full JID (`...@s.whatsapp.net` / `...@g.us`) to send messages to. Defaults to the linked account itself. |
| `POLL_INTERVAL_SECONDS` | Optional, default `30` |
| `STARTUP_NOTIFY` | Optional, send a "bot started" message on launch (default `true`) |

### Step 1 — Pair locally

```bash
npm install
npm run pair        # asks for your WhatsApp phone number, prints an 8-digit code
```

On your phone: **WhatsApp → Settings → Linked Devices → Link a Device →
"Link with phone number instead"** and enter the code. Once linked the script
exits and leaves the credentials in `./auth_info_baileys/`.

### Step 2 — Run locally (optional smoke test)

```bash
cp .env.example .env   # fill in MYSMSPORTAL_USERNAME / MYSMSPORTAL_PASSWORD
set -a && source .env && set +a
npm start
```

### Step 3 — Package auth for Render

Render workers don't have local disk that survives restarts, so we ship the
auth state via env var:

```bash
npm run export-auth
# writes whatsapp_auth.base64.txt  (one long string)
```

Copy the contents of `whatsapp_auth.base64.txt` and set it as the
`WHATSAPP_AUTH_BASE64` env var on the Render worker. The bot will unpack it on
startup.

> **Heads up:** that base64 string contains your WhatsApp session keys.
> Treat it like a password. Never commit it.

---

## Deploy to Render

The repo ships with [`render.yaml`](./render.yaml) (a Render Blueprint) that
declares both workers.

1. Push this repo to GitHub.
2. In Render, click **New → Blueprint** and point it at this repo.
3. Render creates two workers: `mysmsportal-telegram-bot` and
   `mysmsportal-whatsapp-bot`.
4. On each service's **Environment** tab, fill in the required secrets
   (see tables above).
5. Deploy.

> Background workers on Render require a paid plan. As a free alternative,
> both bots run fine on any always-on machine (small VPS, Raspberry Pi, etc.).

---

## How dedupe works

On startup each bot logs in, captures the current rows of the test-results
table as the "already-seen" baseline (so it does not spam history), and on
each subsequent poll compares the new snapshot against that baseline. New
rows are sent in the order they appeared. If the portal session expires the
client transparently logs back in.

Dedupe state is in-memory. If the worker restarts, the bot re-baselines on
its first poll.
