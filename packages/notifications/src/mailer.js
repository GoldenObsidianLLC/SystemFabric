'use strict';

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function messageFor(template, payload) {
  const bodies = {
    'password-reset': {
      subject: 'Reset your SystemFabric password',
      text: `A password reset was requested for your account. Open this link to choose a new password: ${payload.resetUrl}\n\nThis link expires shortly. If you did not request this, ignore this message.`,
      html: `<p>A password reset was requested for your SystemFabric account.</p><p><a href="${htmlEscape(payload.resetUrl)}">Choose a new password</a></p><p>This link expires shortly. If you did not request this, ignore this message.</p>`
    },
    'email-verification': {
      subject: 'Verify your SystemFabric email',
      text: `Verify your email address: ${payload.verifyUrl}\n\nIf you did not create or update this account, ignore this message.`,
      html: `<p>Verify your email address to complete your SystemFabric account setup.</p><p><a href="${htmlEscape(payload.verifyUrl)}">Verify email address</a></p><p>If you did not create or update this account, ignore this message.</p>`
    },
    'site-invitation': {
      subject: `You're invited to ${payload.siteName || 'SystemFabric'}`,
      text: `You have been invited to ${payload.siteName || 'a SystemFabric site'}. Accept the invitation: ${payload.inviteUrl}\n\nThis link expires on ${payload.expiresAt}.`,
      html: `<p>You have been invited to ${htmlEscape(payload.siteName || 'a SystemFabric site')}.</p><p><a href="${htmlEscape(payload.inviteUrl)}">Accept invitation</a></p><p>This link expires on ${htmlEscape(payload.expiresAt || 'the expiry date')}.</p>`
    },
    generic: { subject: String(payload.subject || 'SystemFabric notification').slice(0, 180), text: String(payload.text || '').slice(0, 20_000), html: `<pre>${htmlEscape(String(payload.text || '').slice(0, 20_000))}</pre>` }
  };
  return bodies[template] || bodies.generic;
}

async function sendEmail({ recipient, template, payload }, env = process.env) {
  const provider = env.SYSTEMFABRIC_MAIL_PROVIDER || 'disabled';
  if (provider === 'disabled') {
    const error = new Error('Mail delivery is disabled; configure SYSTEMFABRIC_MAIL_PROVIDER.');
    error.code = 'ERR_SYSTEMFABRIC_MAIL_DISABLED'; throw error;
  }
  const from = env.SYSTEMFABRIC_MAIL_FROM;
  if (!from || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    const error = new Error('SYSTEMFABRIC_MAIL_FROM must be a valid sender email address.'); error.code = 'ERR_SYSTEMFABRIC_MAIL_CONFIG'; throw error;
  }
  const message = messageFor(template, payload || {});
  let response;
  if (provider === 'resend') {
    if (!env.RESEND_API_KEY) throw Object.assign(new Error('RESEND_API_KEY is required.'), { code: 'ERR_SYSTEMFABRIC_MAIL_CONFIG' });
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [recipient], subject: message.subject, text: message.text, html: message.html }), signal: AbortSignal.timeout(10_000)
    });
  } else if (provider === 'sendgrid') {
    if (!env.SENDGRID_API_KEY) throw Object.assign(new Error('SENDGRID_API_KEY is required.'), { code: 'ERR_SYSTEMFABRIC_MAIL_CONFIG' });
    response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST', headers: { authorization: `Bearer ${env.SENDGRID_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ personalizations: [{ to: [{ email: recipient }] }], from: { email: from }, subject: message.subject, content: [{ type: 'text/plain', value: message.text }, { type: 'text/html', value: message.html }] }), signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 202) return { accepted: true, provider };
  } else {
    const error = new Error(`Unsupported mail provider: ${provider}`); error.code = 'ERR_SYSTEMFABRIC_MAIL_PROVIDER'; throw error;
  }
  if (!response.ok) {
    const error = new Error(`Email provider rejected the delivery (${response.status}).`);
    error.code = response.status >= 500 || response.status === 429 ? 'ERR_SYSTEMFABRIC_MAIL_TRANSIENT' : 'ERR_SYSTEMFABRIC_MAIL_REJECTED';
    throw error;
  }
  return { accepted: true, provider };
}

module.exports = { sendEmail, messageFor, htmlEscape };
