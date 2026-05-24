'use strict';

const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const { PortalClient, parseResults, resultKey, formatMessage } = require('./portal');
const { AUTH_DIR, ensureAuthDirFromEnv } = require('./auth_state');

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

function normalizeTarget(raw, fallbackJid) {
  if (!raw) return fallbackJid;
  let v = raw.trim();
  if (v.endsWith('@s.whatsapp.net') || v.endsWith('@g.us')) return v;
  if (v.includes('@g.us') || v.includes('@s.whatsapp.net')) return v;
  const digits = v.replace(/[^0-9]/g, '');
  if (!digits) return fallbackJid;
  return `${digits}@s.whatsapp.net`;
}

async function main() {
  const username = requireEnv('MYSMSPORTAL_USERNAME');
  const password = requireEnv('MYSMSPORTAL_PASSWORD');
  const pollInterval = parseInt(process.env.POLL_INTERVAL_SECONDS || '30', 10) * 1000;
  const startupNotify = (process.env.STARTUP_NOTIFY || 'true').toLowerCase() !== 'false';
  const rawTarget = process.env.WHATSAPP_TARGET;

  ensureAuthDirFromEnv();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const phoneNumber = (process.env.WHATSAPP_PHONE_NUMBER || '').replace(/[^0-9]/g, '');

  if (!state.creds.registered && !phoneNumber) {
    console.error(
      `No WhatsApp credentials found in ${AUTH_DIR} and WHATSAPP_PHONE_NUMBER is not set.\n` +
        `Set WHATSAPP_PHONE_NUMBER (digits only, with country code, e.g. 923001234567) and redeploy ` +
        `to trigger in-process pairing on first boot.`
    );
    process.exit(1);
  }

  const { version } = await fetchLatestBaileysVersion();
  log.info({ version, authDir: AUTH_DIR, alreadyRegistered: !!state.creds.registered }, 'Starting Baileys WhatsApp socket');

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['mysmsportal-bot', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  if (!state.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        const pretty = code.match(/.{1,4}/g).join('-');
        const banner =
          '\n' +
          '======================================================\n' +
          '  WhatsApp pairing code:  ' + pretty + '\n' +
          '======================================================\n' +
          '  Open WhatsApp on your phone (' + phoneNumber + ')\n' +
          '  -> Settings -> Linked Devices -> Link a Device\n' +
          '  -> tap "Link with phone number instead"\n' +
          '  -> enter the code above (expires in ~60 seconds).\n' +
          '======================================================\n';
        console.log(banner);
      } catch (err) {
        log.error({ err }, 'Failed to request pairing code');
        process.exit(1);
      }
    }, 2500);
  }

  const portal = new PortalClient(username, password, log);
  let loopStarted = false;
  let seen = new Set();
  let firstPoll = true;

  async function safeSend(jid, text) {
    try {
      await sock.sendMessage(jid, { text });
    } catch (err) {
      log.error({ err }, 'Failed to send WhatsApp message');
    }
  }

  async function pollLoop() {
    if (loopStarted) return;
    loopStarted = true;
    const fallbackJid = sock.user?.id?.replace(/:\d+@/, '@');
    const target = normalizeTarget(rawTarget, fallbackJid);
    log.info({ target }, 'Resolved WhatsApp target');

    try {
      await portal.login();
    } catch (err) {
      log.error({ err }, 'Initial portal login failed');
    }

    if (startupNotify) {
      await safeSend(
        target,
        `\u{1F916} *mysmsportal bot started*\nPolling every ${pollInterval / 1000}s for new SMS test results.`
      );
    }

    while (true) {
      try {
        const html = await portal.fetchResultsPage();
        const rows = parseResults(html);
        log.info({ rows: rows.length }, 'Fetched test-results table');

        const currentKeys = new Set();
        const newRows = [];
        for (const r of rows) {
          const k = resultKey(r);
          currentKeys.add(k);
          if (!seen.has(k)) newRows.push(r);
        }

        if (firstPoll) {
          firstPoll = false;
          log.info({ baseline: newRows.length }, 'First poll: marking rows as seen without notifying');
        } else {
          for (const r of newRows.reverse()) {
            log.info({ key: resultKey(r) }, 'New result -> WhatsApp');
            await safeSend(target, formatMessage(r));
          }
        }
        seen = currentKeys;
      } catch (err) {
        log.error({ err }, 'Poll error');
        try {
          await portal.login();
        } catch (_) {}
      }
      await new Promise((res) => setTimeout(res, pollInterval));
    }
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      log.info({ user: sock.user?.id }, 'WhatsApp connection open');
      pollLoop().catch((err) => log.error({ err }, 'Poll loop crashed'));
    } else if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      log.warn({ statusCode, loggedOut }, 'WhatsApp connection closed');
      if (loggedOut) {
        log.error('Logged out. Re-pair the device with `npm run pair`.');
        process.exit(1);
      }
      log.info('Exiting so the supervisor (Render) can restart and reconnect.');
      process.exit(1);
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
