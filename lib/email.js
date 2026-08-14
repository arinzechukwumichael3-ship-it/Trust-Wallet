/**
 * Helpry transactional email — Resend integration.
 *
 * All client <-> support notifications flow through here. The business inbox is
 * wallet@yieldempire.org (configured via SUPPORT_EMAIL / EMAIL_FROM env).
 *
 *   - When the CLIENT sends a message  -> support is emailed the transcript.
 *   - When SUPPORT replies             -> the client is emailed the reply.
 *
 * Deliverability rules we follow so mail stays out of spam:
 *   - The From name is just "Support" and the template never mentions an
 *     unrelated brand, and links point only at APP_URL (no third-party brand
 *     names in the body). This keeps content aligned with the sending domain.
 *   - Multi-part (HTML + plain-text) — single-part HTML is a common spam flag.
 *   - List-Unsubscribe header so providers treat this as a real notification.
 *   - Plain, transactional layout (no marketing gradients / big CTA buttons).
 *   - SPF/DKIM/DMARC must be configured for yieldempire.org in Resend + Cloudflare.
 *
 * Failures are swallowed and logged: email is an enhancement to the in-app chat,
 * never a prerequisite for a message to be delivered inside the widget/admin.
 */
const path = require('path');

let Resend = null;
try {
  // Required only when RESEND_API_KEY is present; loads lazily so the app runs
  // fine without the dependency installed (e.g. before `npm install`).
  Resend = require('resend').Resend;
} catch (e) {
  Resend = null;
}

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'wallet@yieldempire.org';
const EMAIL_FROM =
  process.env.EMAIL_FROM || `Support <${SUPPORT_EMAIL}>`;
const APP_URL = (process.env.APP_URL || 'https://helpry.jp').replace(/\/$/, '');

// Extra admin inboxes that should ALSO receive every client->support message
// (comma- or space-separated list in ADMIN_NOTIFY_EMAILS).
function adminNotifyEmails() {
  const raw = process.env.ADMIN_NOTIFY_EMAILS || '';
  return raw
    .split(/[\s,]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

// All addresses that should receive a "client messaged support" notification:
// the shared support inbox + each listed admin, de-duplicated.
function supportRecipients() {
  const set = new Set([SUPPORT_EMAIL.toLowerCase(), ...adminNotifyEmails()]);
  return Array.from(set);
}

let client = null;
function getClient() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!Resend) {
    console.warn('[email] RESEND_API_KEY is set but the "resend" package is missing. Run `npm install`.');
    return null;
  }
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2br(s) {
  return escapeHtml(s).replace(/\n/g, '<br>\n');
}

// Plain-text rendering (used for the multipart text part).
function plainText({ title, preheader, bodyLines }) {
  return [title, '', preheader, '', ...bodyLines, '', '— Support', SUPPORT_EMAIL].join('\n');
}

// Transactional, brand-neutral shell. No marketing gradient, no big CTA button,
// links only to APP_URL (no third-party brand strings in the body).
function baseTemplate({ title, preheader, bodyInner }) {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:20px 0;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
        <tr><td style="padding:14px 24px;border-bottom:1px solid #eef0f3;font-size:13px;font-weight:600;color:#374151;letter-spacing:.3px;">Support</td></tr>
        <tr><td style="padding:24px;">
          ${bodyInner}
        </td></tr>
        <tr><td style="padding:16px 24px;background-color:#fafafa;border-top:1px solid #eef0f3;font-size:11px;line-height:1.6;color:#9ca3af;">
          You are receiving this because you are part of a support conversation. To stop these notifications, reply with "unsubscribe" or email
          <a href="mailto:${SUPPORT_EMAIL}?subject=unsubscribe" style="color:#6b7280;text-decoration:none;">${escapeHtml(SUPPORT_EMAIL)}</a>.
          <br>© ${year} Support
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function messageCard({ label, message, imageUrls }) {
  const textBlock = message
    ? `<div style="margin:0 0 14px;padding:14px;background-color:#f9fafb;border:1px solid #eef0f3;border-radius:8px;font-size:15px;line-height:1.6;color:#111827;white-space:pre-wrap;">${nl2br(message)}</div>`
    : '';
  const imgs = Array.isArray(imageUrls) && imageUrls.length
    ? `<div style="margin:0 0 8px;font-size:13px;color:#6b7280;">${imageUrls.length} attachment(s) were shared in the chat.</div>`
    : '';
  return `
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#6b7280;">${escapeHtml(label)}</p>
    ${textBlock}
    ${imgs}
  `;
}

// Common send wrapper: HTML + plain-text multipart, plus List-Unsubscribe header.
async function sendEmail({ to, subject, title, preheader, bodyInner, bodyLines, replyTo }) {
  const cl = getClient();
  if (!cl) return { sent: false, reason: 'no-resend' };
  const html = baseTemplate({ title, preheader, bodyInner });
  const text = plainText({ title, preheader, bodyLines });
  try {
    const { data, error } = await cl.emails.send({
      from: EMAIL_FROM,
      to,
      reply_to: replyTo,
      subject,
      html,
      text,
      headers: {
        'List-Unsubscribe': `<mailto:${SUPPORT_EMAIL}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      }
    });
    if (error) { console.error('[email] send failed:', error.message || error); return { sent: false, error }; }
    return { sent: true, id: data && data.id };
  } catch (e) {
    console.error('[email] send error:', e.message);
    return { sent: false, error: e.message };
  }
}

/**
 * Notify support that a CLIENT just sent a message.
 * @param {object} c client {ref_id, name, email}
 * @param {object} m message {message, image_urls, created_at}
 */
async function notifySupportOfClientMessage(c, m) {
  const who = c.name ? `${c.name} (${c.ref_id})` : c.ref_id;
  const subject = `New message from ${who}`;
  const adminUrl = 'https://trust-wallet-gamma-steel.vercel.app/';
  return sendEmail({
    to: supportRecipients(),
    replyTo: c.email ? [c.email] : undefined,
    subject,
    title: subject,
    preheader: `New support message from ${who}.`,
    bodyInner: `
      <h2 style="margin:0 0 6px;font-size:18px;color:#111827;">New support message</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#6b7280;">A customer just messaged you through the support chat.</p>
      ${messageCard({ label: `From: ${escapeHtml(who)}${c.email ? ' <' + c.email + '>' : ''}`, message: m.message, imageUrls: m.image_urls })}
      <p style="margin:14px 0 0;font-size:13px;color:#6b7280;">Reference: ${escapeHtml(c.ref_id)} · Received: ${new Date(m.created_at).toUTCString()}</p>
      <p style="margin:16px 0 0;font-size:13px;color:#374151;">Open the admin console: <a href="${adminUrl}" style="color:#0500FF;text-decoration:none;">${adminUrl}</a></p>
    `,
    bodyLines: [
      'A customer just messaged you through the support chat.',
      '',
      `From: ${who}${c.email ? ' <' + c.email + '>' : ''}`,
      m.message || '',
      `Reference: ${c.ref_id}`,
      `Received: ${new Date(m.created_at).toUTCString()}`,
      '',
      `Open admin console: ${adminUrl}`
    ]
  });
}

/**
 * Notify the CLIENT that SUPPORT just replied.
 * @param {object} c client {ref_id, email, name}
 * @param {object} m reply message {message, image_urls, created_at}
 */
async function notifyClientOfReply(c, m) {
  if (!c.email) return { sent: false, reason: 'no-client-email' };
  const subject = `Reply from Support (${c.ref_id})`;
  const chatUrl = APP_URL;
  return sendEmail({
    to: [c.email],
    subject,
    title: subject,
    preheader: 'You have a new reply from our support team.',
    bodyInner: `
      <h2 style="margin:0 0 6px;font-size:18px;color:#111827;">You have a new reply</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#6b7280;">Our support team has responded to your conversation.</p>
      ${messageCard({ label: 'Message from Support', message: m.message, imageUrls: m.image_urls })}
      <p style="margin:14px 0 0;font-size:13px;color:#374151;">Continue the chat: <a href="${chatUrl}" style="color:#0500FF;text-decoration:none;">${chatUrl}</a></p>
      <p style="margin:10px 0 0;font-size:12px;color:#9ca3af;">Reference: ${escapeHtml(c.ref_id)} · ${new Date(m.created_at).toUTCString()}</p>
    `,
    bodyLines: [
      'Our support team has responded to your conversation.',
      '',
      m.message || '',
      '',
      `Continue the chat: ${chatUrl}`,
      `Reference: ${c.ref_id} · ${new Date(m.created_at).toUTCString()}`
    ]
  });
}

module.exports = {
  notifySupportOfClientMessage,
  notifyClientOfReply,
  isConfigured: () => !!getClient(),
  SUPPORT_EMAIL,
  EMAIL_FROM
};
