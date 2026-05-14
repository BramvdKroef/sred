import { db } from '../src/db/index.js';
import { signSession } from '../src/auth/jwt.js';

const email = process.argv[2];
if (!email) {
  console.error('usage: node tools/mint-dev-jwt.js <email>');
  process.exit(1);
}
const u = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
if (!u) {
  console.error(`no user with email ${email}`);
  process.exit(1);
}
console.log(signSession(u));
