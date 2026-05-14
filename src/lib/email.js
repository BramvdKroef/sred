import nodemailer from 'nodemailer';
import { config } from '../config.js';

// Default nodemailer timeouts are ~2 minutes per phase, which is far too long
// for a synchronous, admin-triggered action like /invite. We cap the transport
// itself at ~5s for connect / greet / socket so a black-holed SMTP host can't
// stall a request, and the route handler wraps the whole sendMail call in a
// separate 8s race (see SEND_TIMEOUT_MS below) to bound the total.
const mailer = config.smtp.host
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: false,
      ignoreTLS: true,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 5000,
    })
  : null;

// Outer wall-clock cap on a single send attempt. Generous enough to absorb a
// slow-but-working SMTP host, tight enough that an admin clicking "invite"
// doesn't sit on a spinner for two minutes.
export const SEND_TIMEOUT_MS = 8000;

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

// Wrap a promise so it rejects after `ms` if it hasn't settled yet. Used to
// bound the outer wall-clock of a single SMTP attempt independently of
// nodemailer's per-phase timeouts (so e.g. a server that accepts the TCP
// connection then trickles bytes can't keep us waiting forever).
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = 'ESENDTIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
    const info = await withTimeout(
      mailer.sendMail({ from: config.smtp.from, to, subject, text }),
      SEND_TIMEOUT_MS,
      'sendMail',
    );
    console.log(`[email] sent ${purpose} to ${to} (messageId=${info.messageId})`);
    return { delivered: true, messageId: info.messageId };
  } catch (err) {
    const reason = err.code === 'ESENDTIMEOUT' ? 'timeout' : 'send_failed';
    console.warn(`[email] failed to send ${purpose} to ${to} (${reason}): ${err.message}`);
    console.log(`[email] fallback link: ${link}`);
    return { delivered: false, reason, error: err.message };
  }
}
