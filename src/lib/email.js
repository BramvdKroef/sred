import nodemailer from 'nodemailer';
import { config } from '../config.js';

const mailer = config.smtp.host
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: false,
      ignoreTLS: true,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : null;

const SUBJECTS = {
  invite:     'You are invited to the SR&ED tracker',
  recovery:   'Recover your SR&ED tracker access',
  add_device: 'Add a new device to your SR&ED tracker',
};

const ACTIONS = {
  invite:     'set up your passkey and sign in',
  recovery:   'enroll a new passkey on a fresh device',
  add_device: 'add a new device to your account',
};

export async function sendMagicLink({ to, name, purpose, link }) {
  if (!mailer) {
    console.log(`[email] (no SMTP configured) ${purpose} link for ${to}: ${link}`);
    return { delivered: false, reason: 'smtp_disabled' };
  }
  const subject = SUBJECTS[purpose] ?? 'SR&ED tracker';
  const action = ACTIONS[purpose] ?? 'continue';
  const text =
    `Hi ${name || ''},\n\n` +
    `Click this link to ${action}:\n\n${link}\n\n` +
    `This link expires shortly and can only be used once.\n\n` +
    `If you weren't expecting this email, ignore it.\n`;
  try {
    const info = await mailer.sendMail({
      from: config.smtp.from,
      to,
      subject,
      text,
    });
    console.log(`[email] sent ${purpose} to ${to} (messageId=${info.messageId})`);
    return { delivered: true, messageId: info.messageId };
  } catch (err) {
    console.warn(`[email] failed to send ${purpose} to ${to}: ${err.message}`);
    console.log(`[email] fallback link: ${link}`);
    return { delivered: false, reason: 'send_failed', error: err.message };
  }
}
