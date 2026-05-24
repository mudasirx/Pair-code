'use strict';

const readline = require('readline');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { AUTH_DIR } = require('./auth_state');

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let phone = process.env.WHATSAPP_PHONE_NUMBER;
  if (!phone) {
    phone = await ask(rl, 'Enter your WhatsApp phone number with country code (digits only, e.g. 923001234567): ');
  }
  phone = phone.replace(/[^0-9]/g, '');
  if (!phone) {
    console.error('Phone number is required');
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['mysmsportal-bot', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phone);
        const pretty = code.match(/.{1,4}/g).join('-');
        console.log('\n=================================================');
        console.log('Your WhatsApp pairing code:  ' + pretty);
        console.log('=================================================');
        console.log('On your phone: WhatsApp -> Settings -> Linked Devices');
        console.log('-> Link a Device -> Link with phone number instead');
        console.log('-> enter the code above. Code expires in ~60 seconds.');
      } catch (err) {
        console.error('Failed to request pairing code:', err);
        process.exit(1);
      }
    }, 2000);
  } else {
    console.log('Already paired. Auth state present in', AUTH_DIR);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      console.log('\nLinked successfully! WhatsApp number:', sock.user?.id);
      console.log('Auth saved in ./' + AUTH_DIR + '/');
      console.log('Run `npm run export-auth` to package it for Render deployment.');
      rl.close();
      setTimeout(() => process.exit(0), 1500);
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log('Connection closed, retrying...');
      } else {
        console.log('Logged out.');
        process.exit(1);
      }
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
