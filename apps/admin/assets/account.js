'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const token = new URL(location.href).searchParams.get('token') || '';
  const route = location.pathname;
  function status(message, error = false) { $('account-status').textContent = message; $('account-status').classList.toggle('error', error); }
  async function api(path, body) {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
    return result;
  }
  if (route === '/reset-password') {
    $('account-title').textContent = 'Reset your password'; $('account-intro').textContent = 'Choose a new password. It must be at least 12 characters and include uppercase, lowercase, and a number.';
    $('password-reset-form').classList.remove('hidden');
    $('password-reset-form').addEventListener('submit', async event => {
      event.preventDefault();
      if ($('new-password').value !== $('confirm-password').value) return status('The passwords do not match.', true);
      try { await api('/api/v1/auth/password-reset/complete', { token, password: $('new-password').value }); status('Password changed. Sign in using your new password.'); $('password-reset-form').classList.add('hidden'); }
      catch (error) { status(error.message, true); }
    });
    if (!token) status('This link is missing its token. Request a new password reset.', true);
  } else if (route === '/verify-email') {
    $('account-title').textContent = 'Verify your email'; $('account-intro').textContent = 'Confirming your email address helps protect your account.';
    if (!token) status('This link is missing its token.', true);
    else api('/api/v1/auth/email-verification/confirm', { token }).then(() => status('Email verified. You can return to SystemFabric Studio.')).catch(error => status(error.message, true));
  } else if (route === '/accept-invitation') {
    $('account-title').textContent = 'Accept your invitation'; $('account-intro').textContent = 'Create your account to join the SystemFabric site.';
    $('invitation-form').classList.remove('hidden');
    $('invitation-form').addEventListener('submit', async event => {
      event.preventDefault();
      try { await api('/api/v1/auth/invitations/accept', { token, displayName: $('display-name').value, password: $('invite-password').value }); status('Invitation accepted. Return to SystemFabric Studio and sign in.'); $('invitation-form').classList.add('hidden'); }
      catch (error) { status(error.message, true); }
    });
    if (!token) status('This invitation link is missing its token.', true);
  } else { status('Unknown account action.', true); }
})();
