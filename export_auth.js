'use strict';

const fs = require('fs');
const path = require('path');
const { AUTH_DIR, packAuthDir } = require('./auth_state');

const dir = path.resolve(AUTH_DIR);
if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) {
  console.error(`No auth state found in ${dir}. Run \`npm run pair\` first.`);
  process.exit(1);
}

const payload = packAuthDir(dir);
const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');

const outPath = path.join(path.dirname(dir), 'whatsapp_auth.base64.txt');
fs.writeFileSync(outPath, b64);

const fileCount = Object.keys(payload).length;
console.log(`Packed ${fileCount} file(s) from ${dir}.`);
console.log(`Base64 length: ${b64.length} chars.`);
console.log(`Written to: ${outPath}`);
console.log();
console.log('Set this as the WHATSAPP_AUTH_BASE64 environment variable on Render.');
