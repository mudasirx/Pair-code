# mysmsportal Telegram bot

A small Python worker that logs into [mysmsportal.com](http://mysmsportal.com),
polls the **SMS Test Numbers** page every 30 seconds, and sends any new rows
from the test-results table (Date / Termination / DDI / CLI / Status) to a
Telegram chat.

## Configuration

Set these environment variables (see [`.env.example`](./.env.example)):

| Variable | Description |
|---|---|
| `MYSMSPORTAL_USERNAME` | mysmsportal.com login username |
| `MYSMSPORTAL_PASSWORD` | mysmsportal.com login password |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Target chat id (user / group / channel) |
| `POLL_INTERVAL_SECONDS` | Optional, default `30` |
| `STARTUP_NOTIFY` | Optional, send a "bot started" message on launch (default `true`) |

## Run locally

```bash
pip install -r requirements.txt
cp .env.example .env   # then edit values
set -a && source .env && set +a
python bot.py
```

## Deploy to Render

The repo ships with [`render.yaml`](./render.yaml) (a Render Blueprint).

1. Push this repo to GitHub.
2. In Render, click **New → Blueprint** and point it at this repo.
3. Render will create a `worker` service called **mysmsportal-telegram-bot**.
4. On the service's **Environment** tab, fill in the four required secrets
   (`MYSMSPORTAL_USERNAME`, `MYSMSPORTAL_PASSWORD`, `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_CHAT_ID`).
5. Deploy. The worker will keep running and stream logs from `bot.py`.

> Background workers on Render require a paid plan. If you need a free
> alternative, you can also run `python bot.py` on any always-on box
> (a small VPS, a Raspberry Pi, etc.) — it has no other infrastructure
> requirements.

## How it works

On startup the bot logs in, captures the test-results table as the
"already-seen" baseline (so it does not spam every existing row), and then
on each poll it compares the current rows against that baseline. New rows
are sent to Telegram in the order they appeared. If the session expires the
client transparently logs back in.
