/**
 * Helpry transactional email — Resend integration.
 *
 * All client <-> support notifications flow through here. The business inbox is
 * trustsupport@yieldempire.org (configured via SUPPORT_EMAIL / EMAIL_FROM env).
 *
 *   - When the CLIENT sends a message  -> support is emailed the transcript.
 *   - When SUPPORT replies             -> the client is emailed the reply.
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

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'trustsupport@yieldempire.org';
const EMAIL_FROM =
  process.env.EMAIL_FROM || `Trust Wallet Support <${SUPPORT_EMAIL}>`;

// Extra admin inboxes that should ALSO receive every client->support message
// (comma- or space-separated list in ADMIN_NOTIFY_EMAILS). These are the people
// who run support, so they get a copy alongside the shared SUPPORT_EMAIL inbox.
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

// Shared visual shell so every email looks like the Trust Wallet / Helpry brand.
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
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(5,0,255,0.08);">
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#0500FF,#00d395);padding:24px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:18px;font-weight:700;color:#ffffff;letter-spacing:.2px;">Trust Wallet Support</td>
              <td align="right" style="font-size:12px;color:rgba(255,255,255,0.85);">Powered by Trust Wallet</td>
            </tr>
          </table>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px;">
          ${bodyInner}
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:20px 32px;background-color:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">
            This is an automated message from Trust Wallet Support. You are receiving this because you are part of a support conversation.
            Please do not reply directly to this email — use the secure chat or contact us at
            <a href="mailto:${SUPPORT_EMAIL}" style="color:#0500FF;text-decoration:none;">${escapeHtml(SUPPORT_EMAIL)}</a>.
          </p>
          <p style="margin:12px 0 0;font-size:11px;color:#94a3b8;">© ${year} Trust Wallet Support · Powered by Trust Wallet</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function messageCard({ label, message, imageUrls }) {
  const textBlock = message
    ? `<div style="margin:0 0 16px;padding:16px;border-radius:12px;background-color:#f8fafc;border:1px solid #e2e8f0;font-size:15px;line-height:1.6;color:#1a202c;white-space:pre-wrap;">${nl2br(message)}</div>`
    : '';
  const imgs = Array.isArray(imageUrls) && imageUrls.length
    ? `<div style="margin:0 0 8px;font-size:13px;color:#64748b;">${imageUrls.length} attachment(s) were shared in the chat.</div>`
    : '';
  return `
    <p style="margin:0 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#0500FF;">${escapeHtml(label)}</p>
    ${textBlock}
    ${imgs}
  `;
}

/**
 * Notify support that a CLIENT just sent a message.
 * @param {object} c client {ref_id, helpry_id, email}
 * @param {object} m message {message, image_urls, created_at}
 */
async function notifySupportOfClientMessage(c, m) {
  const cl = getClient();
  if (!cl) return { sent: false, reason: 'no-resend' };
  const subject = `New message from ${c.ref_id} (Trust Wallet Support)`;
  const body = baseTemplate({
    title: subject,
    preheader: `New support message from ${c.ref_id}.`,
    bodyInner: `
      <h1 style="margin:0 0 4px;font-size:20px;color:#1a202c;">New support message</h1>
      <p style="margin:0 0 20px;font-size:14px;color:#64748b;">A customer just messaged you through the Trust Wallet support chat.</p>
      ${messageCard({ label: `From: ${c.ref_id}${c.email ? ' <' + c.email + '>' : ''}`, message: m.message, imageUrls: m.image_urls })}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;font-size:13px;color:#64748b;">
        <tr><td style="padding:4px 0;"><strong style="color:#1a202c;">Reference:</strong> ${escapeHtml(c.ref_id)}</td></tr>
        <tr><td style="padding:4px 0;"><strong style="color:#1a202c;">Received:</strong> ${new Date(m.created_at).toUTCString()}</td></tr>
      </table>
      <p style="margin:20px 0 0;">
        <a href="${process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : ''}/admin" style="display:inline-block;background-color:#0500FF;color:#ffffff;font-size:14px;font-weight:600;padding:12px 22px;border-radius:10px;text-decoration:none;">Open admin console</a>
      </p>
    `
  });
  try {
    const { data, error } = await cl.emails.send({
      from: EMAIL_FROM,
      to: supportRecipients(),
      reply_to: c.email ? [c.email] : undefined,
      subject,
      html: body
    });
    if (error) { console.error('[email] support notify failed:', error.message || error); return { sent: false, error }; }
    return { sent: true, id: data && data.id };
  } catch (e) {
    console.error('[email] support notify error:', e.message);
    return { sent: false, error: e.message };
  }
}

/**
 * Notify the CLIENT that SUPPORT just replied.
 * @param {object} c client {ref_id, email}
 * @param {object} m reply message {message, image_urls, created_at}
 */
async function notifyClientOfReply(c, m) {
  if (!c.email) return { sent: false, reason: 'no-client-email' };
  const cl = getClient();
  if (!cl) return { sent: false, reason: 'no-resend' };
  const subject = `Reply from Trust Wallet Support (${c.ref_id})`;
  const body = baseTemplate({
    title: subject,
    preheader: 'You have a new reply from our support team.',
    bodyInner: `
      <h1 style="margin:0 0 4px;font-size:20px;color:#1a202c;">You have a new reply</h1>
      <p style="margin:0 0 20px;font-size:14px;color:#64748b;">Our support team has responded to your conversation.</p>
      ${messageCard({ label: 'Message from Trust Wallet Support', message: m.message, imageUrls: m.image_urls })}
      <p style="margin:20px 0 0;">
        <a href="${process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : ''}/helpry.jp/cmupnn-trustwallet-xostfj-helpry-eohlok-trustwallet-gkqtyx.html" style="display:inline-block;background-color:#0500FF;color:#ffffff;font-size:14px;font-weight:600;padding:12px 22px;border-radius:10px;text-decoration:none;">Open the chat</a>
      </p>
      <p style="margin:16px 0 0;font-size:13px;color:#64748b;">Reference: ${escapeHtml(c.ref_id)} · ${new Date(m.created_at).toUTCString()}</p>
    `
  });
  try {
    const { data, error } = await cl.emails.send({
      from: EMAIL_FROM,
      to: [c.email],
      subject,
      html: body
    });
    if (error) { console.error('[email] client reply notify failed:', error.message || error); return { sent: false, error }; }
    return { sent: true, id: data && data.id };
  } catch (e) {
    console.error('[email] client reply notify error:', e.message);
    return { sent: false, error: e.message };
  }
}

module.exports = {
  notifySupportOfClientMessage,
  notifyClientOfReply,
  isConfigured: () => !!getClient(),
  SUPPORT_EMAIL,
  EMAIL_FROM
};
