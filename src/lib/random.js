import { randomBytes, createHash } from 'node:crypto';

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}
