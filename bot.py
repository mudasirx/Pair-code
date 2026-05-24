"""Telegram bot that polls mysmsportal.com for new SMS test results.

Logs into mysmsportal.com, scrapes the test-results table at the bottom of the
SMS Test Numbers page every POLL_INTERVAL_SECONDS, and sends new rows to a
Telegram chat.

Configuration is read from environment variables (see .env.example).
"""

from __future__ import annotations

import logging
import os
import sys
import time
from dataclasses import dataclass
from typing import Iterable

import requests
from bs4 import BeautifulSoup

BASE_URL = "http://mysmsportal.com"
LOGIN_URL = f"{BASE_URL}/index.php?login=1"
TEST_NUMBERS_URL = f"{BASE_URL}/index.php?opt=shw_test_np"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("mysmsportal-bot")


@dataclass(frozen=True)
class TestResult:
    date: str
    termination: str
    ddi: str
    cli: str
    status: str

    @property
    def key(self) -> str:
        return f"{self.date}|{self.ddi}|{self.termination}"

    def format_message(self) -> str:
        status_emoji = {
            "PAID": "\U0001F7E2",
            "UNPAID": "\U0001F534",
        }.get(self.status.upper(), "\u26AA")
        return (
            f"{status_emoji} *New SMS test result*\n"
            f"*Date:* `{self.date}`\n"
            f"*Termination:* {self.termination}\n"
            f"*DDI:* `{self.ddi}`\n"
            f"*CLI:* `{self.cli}`\n"
            f"*Status:* *{self.status}*"
        )


def env(name: str, default: str | None = None, required: bool = False) -> str:
    value = os.environ.get(name, default)
    if required and not value:
        log.error("Missing required environment variable: %s", name)
        sys.exit(1)
    return value or ""


class PortalClient:
    """Stateful HTTP client for mysmsportal.com that keeps a session cookie."""

    def __init__(self, username: str, password: str) -> None:
        self.username = username
        self.password = password
        self.session = requests.Session()
        self.session.headers.update(
            {"User-Agent": "Mozilla/5.0 (compatible; mysmsportal-bot/1.0)"}
        )

    def login(self) -> None:
        log.info("Logging into mysmsportal.com as %s", self.username)
        self.session.cookies.clear()
        self.session.get(BASE_URL, timeout=30)
        resp = self.session.post(
            LOGIN_URL,
            data={"user": self.username, "password": self.password},
            timeout=30,
            allow_redirects=True,
        )
        resp.raise_for_status()
        if "logout=1" not in resp.text and "Signoff" not in resp.text:
            raise RuntimeError("Login appears to have failed (no logout link found)")
        log.info("Login successful")

    def fetch_results_page(self) -> str:
        resp = self.session.get(TEST_NUMBERS_URL, timeout=30)
        resp.raise_for_status()
        if "Please enter your login details" in resp.text:
            log.warning("Session expired, logging in again")
            self.login()
            resp = self.session.get(TEST_NUMBERS_URL, timeout=30)
            resp.raise_for_status()
        return resp.text


def parse_results(html: str) -> list[TestResult]:
    """Parse the test-results table at the bottom of the page."""
    soup = BeautifulSoup(html, "html.parser")
    target = None
    for table in soup.find_all("table"):
        headers = [th.get_text(strip=True) for th in table.find_all("th")]
        if "Date" in headers and "STATUS" in headers and "DDI" in headers:
            target = table
            break
    if target is None:
        return []

    results: list[TestResult] = []
    for tr in target.find_all("tr"):
        cells = [td.get_text(strip=True) for td in tr.find_all("td")]
        if len(cells) < 5:
            continue
        results.append(
            TestResult(
                date=cells[0],
                termination=cells[1],
                ddi=cells[2],
                cli=cells[3],
                status=cells[4],
            )
        )
    return results


class TelegramNotifier:
    def __init__(self, token: str, chat_id: str) -> None:
        self.token = token
        self.chat_id = chat_id
        self.api = f"https://api.telegram.org/bot{token}"

    def send(self, text: str) -> None:
        resp = requests.post(
            f"{self.api}/sendMessage",
            json={
                "chat_id": self.chat_id,
                "text": text,
                "parse_mode": "Markdown",
                "disable_web_page_preview": True,
            },
            timeout=30,
        )
        if not resp.ok:
            log.error("Telegram API error %s: %s", resp.status_code, resp.text)
            resp.raise_for_status()


def run_once(
    client: PortalClient,
    notifier: TelegramNotifier,
    seen_keys: set[str],
    first_run: bool,
) -> set[str]:
    html = client.fetch_results_page()
    results = parse_results(html)
    log.info("Fetched %d result row(s)", len(results))

    new_results: list[TestResult] = []
    current_keys: set[str] = set()
    for r in results:
        current_keys.add(r.key)
        if r.key not in seen_keys:
            new_results.append(r)

    if first_run:
        log.info("First run: marking %d existing row(s) as seen, not notifying", len(new_results))
    else:
        for r in reversed(new_results):
            log.info("New result: %s | %s | %s | %s", r.date, r.termination, r.ddi, r.status)
            try:
                notifier.send(r.format_message())
            except Exception:
                log.exception("Failed to send Telegram message for %s", r.key)
                current_keys.discard(r.key)

    return current_keys


def main() -> None:
    username = env("MYSMSPORTAL_USERNAME", required=True)
    password = env("MYSMSPORTAL_PASSWORD", required=True)
    bot_token = env("TELEGRAM_BOT_TOKEN", required=True)
    chat_id = env("TELEGRAM_CHAT_ID", required=True)
    poll_interval = int(env("POLL_INTERVAL_SECONDS", default="30"))
    startup_notify = env("STARTUP_NOTIFY", default="true").lower() in {"1", "true", "yes"}

    client = PortalClient(username, password)
    notifier = TelegramNotifier(bot_token, chat_id)

    client.login()
    if startup_notify:
        try:
            notifier.send(
                "\U0001F916 *mysmsportal bot started*\n"
                f"Polling every {poll_interval}s for new SMS test results."
            )
        except Exception:
            log.exception("Failed to send startup notification")

    seen_keys: set[str] = set()
    first_run = True
    while True:
        try:
            seen_keys = run_once(client, notifier, seen_keys, first_run)
            first_run = False
        except requests.RequestException:
            log.exception("Network error; will retry after backoff")
            time.sleep(min(poll_interval, 60))
            try:
                client.login()
            except Exception:
                log.exception("Re-login failed; will keep retrying")
            continue
        except Exception:
            log.exception("Unexpected error in poll loop")
        time.sleep(poll_interval)


if __name__ == "__main__":
    main()
