import { DatabaseSync } from 'node:sqlite';
import { readConfig } from '../src/config.js';

// Local operator command: no network, mutation, decryption, text or secret output.
try {
  const { dbPath } = readConfig();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const jobs = db.prepare('SELECT kind,state,count(*) AS count FROM jobs GROUP BY kind,state ORDER BY kind,state').all();
    const subscriptions = db.prepare('SELECT count(*) AS count FROM subscriptions WHERE active=1 AND expires>?').get(Date.now()).count;
    const messages = db.prepare('SELECT count(*) AS count FROM messages').get().count;
    process.stdout.write(JSON.stringify({ active_subscriptions: subscriptions, retained_message_ids: messages, jobs }, null, 2) + '\n');
  } finally { db.close(); }
} catch {
  process.stderr.write('Cannot read an existing bridge database. Check DATABASE_PATH and local file permissions.\n');
  process.exitCode = 1;
}
