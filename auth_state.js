'use strict';

const fs = require('fs');
const path = require('path');

const AUTH_DIR = process.env.AUTH_DIR || 'auth_info_baileys';

function packAuthDir(dir) {
  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir)) throw new Error(`Auth dir not found: ${absDir}`);
  const out = {};
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(absDir, entry.name);
    out[entry.name] = fs.readFileSync(filePath).toString('base64');
  }
  return out;
}

function unpackAuthDir(dir, payload) {
  const absDir = path.resolve(dir);
  fs.mkdirSync(absDir, { recursive: true });
  for (const [name, b64] of Object.entries(payload)) {
    if (name.includes('/') || name.includes('\\') || name === '..' || name === '.') continue;
    fs.writeFileSync(path.join(absDir, name), Buffer.from(b64, 'base64'));
  }
}

function ensureAuthDirFromEnv() {
  const dir = path.resolve(AUTH_DIR);
  const base64 = process.env.WHATSAPP_AUTH_BASE64;
  if (!base64) return dir;

  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    return dir;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch (err) {
    throw new Error('WHATSAPP_AUTH_BASE64 is not a valid base64 JSON payload from `npm run export-auth`');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('WHATSAPP_AUTH_BASE64 payload is empty');
  }
  unpackAuthDir(dir, payload);
  return dir;
}

module.exports = { AUTH_DIR, ensureAuthDirFromEnv, packAuthDir, unpackAuthDir };
