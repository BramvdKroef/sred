import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
export const ROOT_DIR = path.resolve(path.dirname(__filename), '..');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databasePath: path.resolve(ROOT_DIR, process.env.DATABASE_PATH || './data/sred.db'),
  uploadsDir: path.resolve(ROOT_DIR, process.env.UPLOADS_DIR || './uploads'),

  jwtSecret: required('JWT_SECRET'),
  jwtTtlSeconds: Number(process.env.JWT_TTL_SECONDS || 3600),

  rpName: process.env.RP_NAME || 'SR&ED Tracker',
  rpId: process.env.RP_ID || 'localhost',
  origin: process.env.ORIGIN || 'http://localhost:3000',

  inviteTtlMinutes: Number(process.env.INVITE_TTL_MINUTES || 1440),
  recoveryTtlMinutes: Number(process.env.RECOVERY_TTL_MINUTES || 15),
  addDeviceTtlMinutes: Number(process.env.ADD_DEVICE_TTL_MINUTES || 30),
};
