# mysmsportal alert bots

Two small workers that log into [mysmsportal.com](http://mysmsportal.com), poll
the **SMS Test Numbers** page every 30 seconds, and forward any new rows from
the test-results table (Date / Termination / DDI / CLI / Status) to a chat:

- **`bot.py`** — Telegram bot (Python, `requests` + `beautifulsoup4`).
- **`whatsapp_bot.js`** — WhatsApp bot (Node.js, [Baileys](https://github.com/WhiskeySockets/Baileys)
  linked via 8-digit pairing code) with full portal command support.

Both bots are deployed by the included Render Blueprint ([`render.yaml`](./render.yaml))
as background workers. You can run either one independently.

### WhatsApp Bot Commands

Send any of these commands to the bot via WhatsApp:

| Command | Description |
|---|---|
| `/help` | Show all available commands |
| `/results` | Latest test results (last 10) |
| `/rates <country>` | Search the international SMS rate card |
| `/numbers` | Show your allocated numbers |
| `/clients` | List all sub-accounts |
| `/payouts` | Current payouts summary (top 30) |
| `/today` | Today's traffic summary by status and range |
| `/todaydetail` | Today's detail grouped by range |
| `/summaries` | Sender summaries for today |
| `/statements` | Recent payment statements (last 15) |
| `/pair <phone>` | Pair a new WhatsApp number from chat |
| `/login <user> <pass>` | Change portal credentials on the fly |
| `/status` | Bot uptime and poll interval |

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
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Optional. If both are set, the pairing code is also relayed to that Telegram chat on first boot — much easier than hunting through Render logs. Reuse the same values as the Telegram worker. |
| `POLL_INTERVAL_SECONDS` | Optional, default `30` |
| `STARTUP_NOTIFY` | Optional, send a "bot started" message on launch (default `true`) |

### Pair directly on Render (recommended)

1. Push this repo to GitHub.
2. Create the Render Blueprint (`New → Blueprint`).
3. On the **`mysmsportal-whatsapp-bot`** service, set the env vars from the
   table above — at minimum `MYSMSPORTAL_USERNAME`, `MYSMSPORTAL_PASSWORD`,
   and `WHATSAPP_PHONE_NUMBER`. If you've already got the Telegram bot
   working, copy `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` here too — the
   pairing code will then arrive as a Telegram message.
4. Deploy. The pairing code is broadcast to **three places** so you can pick
   whichever is easiest:
   - **Telegram** chat (if `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` are set).
   - The worker's **Logs** tab — printed 3× with a `*** PAIRING MODE ***`
     header so it's hard to miss.
   - A file at `/var/data/PAIRING_CODE.txt` — view it from the worker's
     **Shell** tab with `cat /var/data/PAIRING_CODE.txt`.
5. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device →
   "Link with phone number instead"** and enter the 8-character code
   (dashes optional). Code is valid for ~60 seconds — if it expires just
   restart the worker on Render to get a fresh one.
6. The bot finishes linking, saves the credentials to `/var/data`, and
   starts polling. From now on every restart reuses the saved auth, so you
   can clear `WHATSAPP_PHONE_NUMBER` if you want (optional).

### Pair locally (optional alternative)

If you prefer pairing on your own machine first:

```bash
npm install
npm run pair          # prompts for phone, prints the pairing code
npm start             # smoke-test polling locally with portal env vars set
npm run export-auth   # produces whatsapp_auth.base64.txt
```

Then set `WHATSAPP_AUTH_BASE64` on Render to the contents of that file. On
first boot the bot will unpack it into `AUTH_DIR` and skip pairing.

> **Heads up:** the base64 payload contains your WhatsApp session keys —
> treat it like a password.

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
