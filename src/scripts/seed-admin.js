import { db } from '../db/index.js';
import { mintEmailToken, buildMagicLink } from '../auth/tokens.js';
import { sendMagicLink } from '../lib/email.js';

function getArg(flag) {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === flag) return process.argv[i + 1] ?? null;
    if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
  }
  return null;
}

const email = getArg('--email');
const name = getArg('--name');

if (!email || !name) {
  console.error('usage: npm run seed:admin -- --email=bram@example.com --name="Bram"');
  process.exit(1);
}

let user = db.prepare(`SELECT id, status FROM users WHERE email = ?`).get(email);
if (!user) {
  const info = db.prepare(
    `INSERT INTO users (email, name, role, status) VALUES (?, ?, 'admin', 'pending')`
  ).run(email, name);
  user = { id: info.lastInsertRowid, status: 'pending' };
  console.log(`created admin user #${user.id} <${email}>`);
} else {
  console.log(`user <${email}> already exists (id=${user.id}, status=${user.status})`);
}

const { raw } = mintEmailToken(user.id, 'invite');
const link = buildMagicLink(raw);
console.log('\nmagic link (open in browser to enroll a passkey):');
console.log(`  ${link}\n`);

const result = await sendMagicLink({ to: email, name, purpose: 'invite', link });
if (result.delivered) console.log(`emailed to ${email}.`);
