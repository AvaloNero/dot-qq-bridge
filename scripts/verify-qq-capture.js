import fs from 'node:fs';
import { TextDecoder } from 'node:util';
import { qqVerify } from '../src/signatures.js';

// Inspect an explicitly supplied, fresh official callback. Never bind identity,
// retain a request, generate credentials, or forward data from this command.
try {
  const [bodyPath, headersPath, ...extra] = process.argv.slice(2);
  if (!bodyPath || !headersPath || extra.length || !process.env.QQ_APP_ID || !process.env.QQ_BOT_SECRET) throw new Error('invalid arguments');
  if (fs.statSync(bodyPath).size > 32768 || fs.statSync(headersPath).size > 8192) throw new Error('capture too large');
  const body = fs.readFileSync(bodyPath);
  const rawHeaders = JSON.parse(fs.readFileSync(headersPath, 'utf8'));
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) throw new Error('invalid headers');
  const headers = Object.fromEntries(Object.entries(rawHeaders).map(([key, value]) => [key.toLowerCase(), value]));
  if (headers['x-bot-appid'] !== undefined && headers['x-bot-appid'] !== process.env.QQ_APP_ID) throw new Error('wrong app');
  qqVerify(process.env.QQ_BOT_SECRET, headers, body, Date.now());
  const event = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(body));
  const openid = event?.d?.author?.user_openid;
  if (event.op !== 0 || event.t !== 'C2C_MESSAGE_CREATE' || typeof openid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(openid) || event.d.author.bot === true) throw new Error('not a C2C author');
  process.stdout.write(JSON.stringify({ verified_app: process.env.QQ_APP_ID, event: event.t, verified_author_openid: openid,
    owner_binding_changed: false, independently_confirm_this_is_your_account: true }, null, 2) + '\n');
} catch {
  process.stderr.write('Capture rejected. Supply raw-body and JSON-headers files from a fresh signed QQ C2C callback, with QQ_APP_ID and QQ_BOT_SECRET already authorized locally.\n');
  process.exitCode = 1;
}
