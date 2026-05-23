const { logger } = require('./logger');

// Placeholder bot logic. Once the original Telegram bot code is shared,
// each handler/command/external-API call will be ported here.
//
// Baileys delivers messages through `messages.upsert`. We normalise the
// incoming message and dispatch to whatever logic we want. For now we just
// log and reply to a basic /ping command so we can verify end-to-end flow.
async function handleIncomingMessage({ sessionId, sock, update }) {
  if (update.type !== 'notify') return;

  for (const msg of update.messages) {
    if (!msg.message || msg.key.fromMe) continue;

    const from = msg.key.remoteJid;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      '';

    logger.info({ sessionId, from, text }, 'incoming message');

    const trimmed = text.trim();
    if (!trimmed) continue;

    if (/^\/?ping$/i.test(trimmed)) {
      await sock.sendMessage(from, { text: 'pong' });
      continue;
    }

    if (/^\/?start$/i.test(trimmed)) {
      await sock.sendMessage(from, {
        text:
          'WhatsApp bot is online. Send /ping to test. Once the original ' +
          'Telegram bot is ported, full functionality will be available here.',
      });
      continue;
    }
  }
}

module.exports = { handleIncomingMessage };
