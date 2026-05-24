const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');

const { logger } = require('./logger');

const SESSIONS_DIR = path.resolve(process.env.SESSIONS_DIR || './sessions');

// In-memory registry of live sessions, keyed by sessionId.
//
// Each entry:
// {
//   sock: WASocket,
//   status: 'connecting' | 'awaiting_qr' | 'awaiting_pair' | 'connected' | 'disconnected' | 'logged_out',
//   qr: string | null,            // latest QR string from Baileys
//   qrDataUrl: string | null,     // latest QR encoded as data: URL
//   pairingCode: string | null,
//   user: { id, name } | null,
//   lastError: string | null,
//   subscribers: Set<res>,        // SSE response objects
//   onMessage: (m) => void | null // optional hook for bot logic
// }
const sessions = new Map();

function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function sessionFolder(sessionId) {
  return path.join(SESSIONS_DIR, sessionId);
}

function newSessionId() {
  return crypto.randomBytes(8).toString('hex');
}

function publicState(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) {
    return { sessionId, status: 'unknown' };
  }
  return {
    sessionId,
    status: s.status,
    qr: s.qrDataUrl,
    pairingCode: s.pairingCode,
    user: s.user,
    lastError: s.lastError,
  };
}

function broadcast(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  const payload = `data: ${JSON.stringify(publicState(sessionId))}\n\n`;
  for (const res of s.subscribers) {
    try {
      res.write(payload);
    } catch (err) {
      logger.warn({ err: err.message, sessionId }, 'failed to push SSE update');
    }
  }
}

function subscribe(sessionId, res) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = createSessionRecord(sessionId);
  }
  s.subscribers.add(res);
  res.write(`data: ${JSON.stringify(publicState(sessionId))}\n\n`);
  res.on('close', () => {
    s.subscribers.delete(res);
  });
}

function createSessionRecord(sessionId) {
  const record = {
    sock: null,
    status: 'idle',
    qr: null,
    qrDataUrl: null,
    pairingCode: null,
    user: null,
    lastError: null,
    subscribers: new Set(),
    onMessage: null,
  };
  sessions.set(sessionId, record);
  return record;
}

async function startSession(sessionId, { onMessage } = {}) {
  ensureSessionsDir();

  let record = sessions.get(sessionId);
  if (!record) {
    record = createSessionRecord(sessionId);
  }
  if (onMessage) {
    record.onMessage = onMessage;
  }
  if (record.sock) {
    // already started; just return current state
    return publicState(sessionId);
  }

  record.status = 'connecting';
  record.lastError = null;
  broadcast(sessionId);

  const folder = sessionFolder(sessionId);
  fs.mkdirSync(folder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(folder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    logger: logger.child({ scope: 'baileys', sessionId }),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  record.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      record.qr = qr;
      try {
        record.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      } catch (err) {
        logger.warn({ err: err.message, sessionId }, 'failed to encode QR');
        record.qrDataUrl = null;
      }
      if (record.status !== 'awaiting_pair') {
        record.status = 'awaiting_qr';
      }
      broadcast(sessionId);
    }

    if (connection === 'open') {
      record.status = 'connected';
      record.qr = null;
      record.qrDataUrl = null;
      record.pairingCode = null;
      const me = sock.user;
      record.user = me
        ? {
            id: me.id,
            name: me.name || me.verifiedName || null,
          }
        : null;
      record.lastError = null;
      logger.info({ sessionId, user: record.user }, 'WhatsApp session connected');
      broadcast(sessionId);
    }

    if (connection === 'close') {
      const boomErr = lastDisconnect?.error;
      const statusCode = boomErr instanceof Boom ? boomErr.output?.statusCode : undefined;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      record.sock = null;
      record.qr = null;
      record.qrDataUrl = null;
      record.pairingCode = null;

      if (loggedOut) {
        record.status = 'logged_out';
        record.user = null;
        record.lastError = 'Logged out from phone';
        // Wipe creds so the next start triggers a fresh QR.
        try {
          fs.rmSync(folder, { recursive: true, force: true });
        } catch (err) {
          logger.warn({ err: err.message, sessionId }, 'failed to clear session folder');
        }
        broadcast(sessionId);
      } else {
        record.status = 'disconnected';
        record.lastError = boomErr?.message || 'connection closed';
        broadcast(sessionId);
        logger.warn({ sessionId, statusCode, err: record.lastError }, 'reconnecting');
        setTimeout(() => {
          startSession(sessionId, { onMessage: record.onMessage }).catch((err) => {
            logger.error({ err: err.message, sessionId }, 'reconnect failed');
          });
        }, 1500);
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (!record.onMessage) return;
    try {
      await record.onMessage({ sessionId, sock, update: m });
    } catch (err) {
      logger.error({ err: err.message, sessionId }, 'onMessage handler failed');
    }
  });

  return publicState(sessionId);
}

async function requestPairingCode(sessionId, phoneNumber) {
  const digits = String(phoneNumber || '').replace(/[^0-9]/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('Phone number must be 8–15 digits including country code');
  }

  const record = sessions.get(sessionId);
  if (!record || !record.sock) {
    throw new Error('Session is not active. Start it first.');
  }
  if (record.status === 'connected') {
    throw new Error('Session is already connected.');
  }
  if (record.sock.authState?.creds?.registered) {
    throw new Error('Session already paired.');
  }

  const code = await record.sock.requestPairingCode(digits);
  const formatted = code.match(/.{1,4}/g)?.join('-') || code;
  record.pairingCode = formatted;
  record.status = 'awaiting_pair';
  broadcast(sessionId);
  return formatted;
}

async function logoutSession(sessionId) {
  const record = sessions.get(sessionId);
  if (!record) return;
  try {
    if (record.sock) {
      await record.sock.logout();
    }
  } catch (err) {
    logger.warn({ err: err.message, sessionId }, 'logout call failed');
  }
  try {
    fs.rmSync(sessionFolder(sessionId), { recursive: true, force: true });
  } catch (err) {
    logger.warn({ err: err.message, sessionId }, 'failed to remove session folder');
  }
  record.sock = null;
  record.status = 'logged_out';
  record.qr = null;
  record.qrDataUrl = null;
  record.pairingCode = null;
  record.user = null;
  broadcast(sessionId);
}

function listSessions() {
  return Array.from(sessions.keys()).map((id) => publicState(id));
}

async function restoreExistingSessions({ onMessage } = {}) {
  ensureSessionsDir();
  const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionId = entry.name;
    try {
      await startSession(sessionId, { onMessage });
    } catch (err) {
      logger.error({ err: err.message, sessionId }, 'failed to restore session');
    }
  }
}

module.exports = {
  newSessionId,
  startSession,
  requestPairingCode,
  logoutSession,
  publicState,
  listSessions,
  subscribe,
  restoreExistingSessions,
};
