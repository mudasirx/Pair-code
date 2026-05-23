require('dotenv').config();

const path = require('path');
const express = require('express');

const { logger } = require('./logger');
const {
  newSessionId,
  startSession,
  requestPairingCode,
  logoutSession,
  publicState,
  listSessions,
  subscribe,
  restoreExistingSessions,
} = require('./sessionManager');
const { handleIncomingMessage } = require('./botHandler');

const app = express();
app.use(express.json());

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/sessions', async (req, res) => {
  try {
    const sessionId = newSessionId();
    const state = await startSession(sessionId, { onMessage: handleIncomingMessage });
    res.json(state);
  } catch (err) {
    logger.error({ err: err.message }, 'failed to create session');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: listSessions() });
});

app.get('/api/sessions/:id', (req, res) => {
  res.json(publicState(req.params.id));
});

app.get('/api/sessions/:id/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  subscribe(req.params.id, res);

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* socket gone */
    }
  }, 25_000);

  req.on('close', () => clearInterval(keepAlive));
});

app.post('/api/sessions/:id/pair', async (req, res) => {
  const { phoneNumber } = req.body || {};
  try {
    const code = await requestPairingCode(req.params.id, phoneNumber);
    res.json({ pairingCode: code });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sessions/:id/logout', async (req, res) => {
  try {
    await logoutSession(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  try {
    await restoreExistingSessions({ onMessage: handleIncomingMessage });
  } catch (err) {
    logger.error({ err: err.message }, 'failed to restore sessions on boot');
  }

  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'pairing site listening');
  });
}

main();
