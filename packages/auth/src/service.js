'use strict';

const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const scryptAsync = promisify(require('node:crypto').scrypt);
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const SESSION_TTL_HOURS = 12;
const { generateTotpSecret, verifyTotp, totpUri, encryptSecret, decryptSecret, generateRecoveryCodes } = require('./totp');

function digest(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function safeEqualText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().normalize('NFKC').toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}
function validatePassword(value) {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    const error = new Error(`Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`);
    error.statusCode = 400; error.code = 'ERR_SYSTEMFABRIC_PASSWORD_POLICY'; throw error;
  }
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    const error = new Error('Password must contain at least one lowercase letter, one uppercase letter, and one number.');
    error.statusCode = 400; error.code = 'ERR_SYSTEMFABRIC_PASSWORD_POLICY'; throw error;
  }
}
async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`;
}
async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3]);
  if (N !== 32768 || r !== 8 || p !== 1) return false;
  try {
    const salt = Buffer.from(parts[4], 'base64url'); const expected = Buffer.from(parts[5], 'base64url');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = Buffer.from(await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: 128 * 1024 * 1024 }));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

function authError(statusCode, code, message) { const error = new Error(message); error.statusCode = statusCode; error.code = code; return error; }
function configuredPublicBase(env) {
  const raw = String(env.PUBLIC_BASE_URL || 'http://localhost:8787').replace(/\/$/, '');
  let parsed; try { parsed = new URL(raw); } catch { throw authError(500, 'ERR_SYSTEMFABRIC_PUBLIC_BASE_URL_INVALID', 'PUBLIC_BASE_URL is invalid.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (env.NODE_ENV === 'production' && parsed.protocol !== 'https:')) throw authError(500, 'ERR_SYSTEMFABRIC_PUBLIC_BASE_URL_INVALID', 'PUBLIC_BASE_URL must be an absolute HTTP(S) origin; production requires HTTPS.');
  return parsed.origin;
}

function createIdentityService({ pool, env = process.env, clock = () => Date.now() } = {}) {
  if (!pool) throw new TypeError('Identity service requires a PostgreSQL pool.');
  const sessionTtlHours = Number(env.SESSION_TTL_HOURS || SESSION_TTL_HOURS);
  const sessionIdleTtlMinutes = Number(env.SESSION_IDLE_TTL_MINUTES || 60);
  if (!Number.isInteger(sessionTtlHours) || sessionTtlHours < 1 || sessionTtlHours > 720) throw authError(500, 'ERR_SYSTEMFABRIC_SESSION_TTL_CONFIG', 'SESSION_TTL_HOURS must be an integer from 1 to 720.');
  if (!Number.isInteger(sessionIdleTtlMinutes) || sessionIdleTtlMinutes < 5 || sessionIdleTtlMinutes > 43_200) throw authError(500, 'ERR_SYSTEMFABRIC_SESSION_IDLE_TTL_CONFIG', 'SESSION_IDLE_TTL_MINUTES must be an integer from 5 to 43200.');
  const sessionTtlMs = 1000 * 60 * 60 * sessionTtlHours;
  const loginBuckets = new Map();

  function throttleLogin(key) {
    const now = clock(); const normalized = String(key || 'unknown').slice(0, 300);
    // Bound memory even when an attacker rotates arbitrary email/IP combinations.
    if (loginBuckets.size > 10_000) {
      for (const [bucketKey, bucket] of loginBuckets) { if (bucket.resetAt <= now) loginBuckets.delete(bucketKey); }
      while (loginBuckets.size > 10_000) loginBuckets.delete(loginBuckets.keys().next().value);
    }
    const state = loginBuckets.get(normalized);
    if (!state || state.resetAt <= now) { loginBuckets.set(normalized, { count: 1, resetAt: now + 15 * 60_000 }); return; }
    if (state.count >= 10) { const error = new Error('Too many login attempts. Try again later.'); error.statusCode = 429; error.code = 'ERR_SYSTEMFABRIC_LOGIN_THROTTLED'; error.retryAfterSeconds = Math.ceil((state.resetAt - now) / 1000); throw error; }
    state.count += 1;
  }

  async function createSession(user, metadata = {}) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const expiresAt = new Date(clock() + sessionTtlMs);
    await pool.query(
      `INSERT INTO auth_sessions(user_id,token_hash,csrf_hash,expires_at,user_agent_hash,ip_hash)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [user.id, digest(token), digest(csrf), expiresAt, metadata.userAgent ? digest(metadata.userAgent) : null, metadata.ip ? digest(metadata.ip) : null]
    );
    return { token, csrf, expiresAt, user: safeUser(user) };
  }

  function safeUser(user) {
    return { id: user.id, email: user.email, displayName: user.display_name, status: user.status, emailVerified: Boolean(user.email_verified_at), mfaEnabled: Boolean(user.mfa_enabled) };
  }

  return Object.freeze({
    async bootstrapOwner({ email: inputEmail, password, displayName, siteSlug = 'main', siteName = 'Main Site' }) {
      const email = normalizeEmail(inputEmail);
      if (!email) { const error = new Error('A valid email address is required.'); error.statusCode = 400; error.code = 'ERR_SYSTEMFABRIC_INVALID_EMAIL'; throw error; }
      validatePassword(password);
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(siteSlug)) { const error = new Error('Site slug is invalid.'); error.statusCode = 400; error.code = 'ERR_SYSTEMFABRIC_INVALID_SITE_SLUG'; throw error; }
      const passwordHash = await hashPassword(password);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('systemfabric-bootstrap-owner'))");
        const users = await client.query('SELECT count(*)::integer AS count FROM users WHERE status <> \'disabled\'');
        if (users.rows[0].count > 0) { const error = new Error('Bootstrap is only allowed before the first active user exists.'); error.statusCode = 409; error.code = 'ERR_SYSTEMFABRIC_BOOTSTRAP_CLOSED'; throw error; }
        const site = await client.query('INSERT INTO sites(slug,name) VALUES($1,$2) ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name RETURNING id,slug,name,default_locale', [siteSlug, siteName]);
        const user = await client.query('INSERT INTO users(email,display_name,password_hash,status) VALUES($1,$2,$3,\'active\') RETURNING id,email,display_name,status', [email, String(displayName || email).slice(0, 180), passwordHash]);
        const role = await client.query("SELECT id FROM roles WHERE slug='site-owner'");
        if (!role.rows[0]) throw new Error('Required site-owner role is missing; run migrations first.');
        await client.query('INSERT INTO site_memberships(site_id,user_id,role_id) VALUES($1,$2,$3)', [site.rows[0].id, user.rows[0].id, role.rows[0].id]);
        await client.query('COMMIT');
        return { user: safeUser(user.rows[0]), site: site.rows[0] };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async login({ email: inputEmail, password, ip, userAgent }) {
      const email = normalizeEmail(inputEmail);
      throttleLogin(`${ip || 'unknown'}:${email || 'invalid'}`);
      const result = email ? await pool.query('SELECT id,email,display_name,status,password_hash,mfa_enabled,email_verified_at FROM users WHERE lower(email)=$1 LIMIT 1', [email]) : { rows: [] };
      const user = result.rows[0];
      const matches = await verifyPassword(password, user?.password_hash);
      if (!user || user.status !== 'active' || !matches) {
        const error = new Error('Invalid email or password.'); error.statusCode = 401; error.code = 'ERR_SYSTEMFABRIC_LOGIN_FAILED'; throw error;
      }
      if (env.REQUIRE_VERIFIED_EMAIL === 'true' && !user.email_verified_at) {
        const error = new Error('Verify your email address before signing in.'); error.statusCode = 403; error.code = 'ERR_SYSTEMFABRIC_EMAIL_NOT_VERIFIED'; throw error;
      }
      loginBuckets.delete(`${ip || 'unknown'}:${email}`);
      if (user.mfa_enabled) {
        const challengeToken = randomBytes(32).toString('base64url');
        await pool.query('INSERT INTO auth_mfa_challenges(user_id,token_hash,expires_at) VALUES($1,$2,$3)', [user.id, digest(challengeToken), new Date(clock() + 5 * 60_000)]);
        return { mfaRequired: true, challengeToken, user: safeUser(user), expiresAt: new Date(clock() + 5 * 60_000) };
      }
      const created = await createSession(user, { ip, userAgent });
      return { ...created, mfaRequired: false };
    },

    async completeMfaLogin({ challengeToken, code, ip, userAgent }) {
      if (typeof challengeToken !== 'string' || challengeToken.length < 32 || challengeToken.length > 200) throw authError(401, 'ERR_SYSTEMFABRIC_MFA_CHALLENGE_INVALID', 'MFA challenge is invalid or expired.');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const found = await client.query(`SELECT c.id AS challenge_id,c.user_id,c.attempts,u.id,u.email,u.display_name,u.status,u.mfa_enabled
          FROM auth_mfa_challenges c JOIN users u ON u.id=c.user_id
          WHERE c.token_hash=$1 AND c.consumed_at IS NULL AND c.expires_at>now() FOR UPDATE OF c`, [digest(challengeToken)]);
        const challenge = found.rows[0];
        if (!challenge || challenge.attempts >= 5 || challenge.status !== 'active' || !challenge.mfa_enabled) throw authError(401, 'ERR_SYSTEMFABRIC_MFA_CHALLENGE_INVALID', 'MFA challenge is invalid or expired.');
        const credentialResult = await client.query('SELECT secret_ciphertext,last_used_step,pending_secret FROM user_mfa_credentials WHERE user_id=$1 FOR UPDATE', [challenge.user_id]);
        const credential = credentialResult.rows[0];
        if (!credential || credential.pending_secret) throw authError(401, 'ERR_SYSTEMFABRIC_MFA_NOT_CONFIGURED', 'Multi-factor authentication is not configured.');
        let acceptedStep = credential.last_used_step;
        let valid = false;
        try {
          const secret = decryptSecret(credential.secret_ciphertext, env);
          const step = verifyTotp(secret, String(code || ''), { now: clock(), lastUsedStep: Number(credential.last_used_step) });
          if (step !== null) { acceptedStep = step; valid = true; }
        } catch (error) { if (error.code === 'ERR_SYSTEMFABRIC_MFA_KEY_MISSING' || error.code === 'ERR_SYSTEMFABRIC_MFA_KEY_INVALID') throw error; }
        if (!valid && typeof code === 'string' && /^[A-Z0-9_-]{10,32}$/i.test(code)) {
          const recovery = await client.query('UPDATE user_mfa_recovery_codes SET consumed_at=now() WHERE user_id=$1 AND code_hash=$2 AND consumed_at IS NULL RETURNING id', [challenge.user_id, digest(code.toUpperCase())]);
          valid = recovery.rowCount > 0;
        }
        if (!valid) {
          await client.query('UPDATE auth_mfa_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.challenge_id]);
          await client.query('COMMIT');
          throw authError(401, 'ERR_SYSTEMFABRIC_MFA_INVALID', 'The authentication code is invalid.');
        }
        if (acceptedStep !== credential.last_used_step) await client.query('UPDATE user_mfa_credentials SET last_used_step=$2,updated_at=now() WHERE user_id=$1', [challenge.user_id, acceptedStep]);
        await client.query('UPDATE auth_mfa_challenges SET consumed_at=now() WHERE id=$1', [challenge.challenge_id]);
        await client.query('COMMIT');
        const user = { id: challenge.user_id, email: challenge.email, display_name: challenge.display_name, status: challenge.status };
        return { ...(await createSession(user, { ip, userAgent })), mfaRequired: false };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async beginMfaEnrollment({ userId }) {
      const userResult = await pool.query("SELECT id,email,status FROM users WHERE id=$1 AND status='active'", [userId]);
      const user = userResult.rows[0]; if (!user) throw authError(404, 'ERR_SYSTEMFABRIC_USER_NOT_FOUND', 'Account not found.');
      const secret = generateTotpSecret(); const encrypted = encryptSecret(secret, env);
      await pool.query(`INSERT INTO user_mfa_credentials(user_id,secret_ciphertext,pending_secret,last_used_step,updated_at)
        VALUES($1,$2,true,-1,now()) ON CONFLICT(user_id) DO UPDATE SET secret_ciphertext=EXCLUDED.secret_ciphertext,pending_secret=true,last_used_step=-1,updated_at=now()`, [userId, encrypted]);
      return { secret, otpauthUrl: totpUri(secret, user.email), issuer: 'SystemFabric', digits: 6, periodSeconds: 30 };
    },

    async confirmMfaEnrollment({ userId, code }) {
      const client = await pool.connect(); const recoveryCodes = generateRecoveryCodes();
      try {
        await client.query('BEGIN');
        const result = await client.query('SELECT secret_ciphertext,pending_secret,last_used_step FROM user_mfa_credentials WHERE user_id=$1 FOR UPDATE', [userId]);
        const credential = result.rows[0];
        if (!credential || !credential.pending_secret) throw authError(409, 'ERR_SYSTEMFABRIC_MFA_ENROLLMENT_NOT_PENDING', 'Begin MFA enrollment before confirming it.');
        let step = null; try { step = verifyTotp(decryptSecret(credential.secret_ciphertext, env), String(code || ''), { now: clock() }); } catch (error) { throw error; }
        if (step === null) throw authError(400, 'ERR_SYSTEMFABRIC_MFA_INVALID', 'The authentication code is invalid.');
        await client.query('UPDATE user_mfa_credentials SET pending_secret=false,last_used_step=$2,updated_at=now() WHERE user_id=$1', [userId, step]);
        await client.query('UPDATE users SET mfa_enabled=true,mfa_enabled_at=now(),updated_at=now() WHERE id=$1', [userId]);
        await client.query('DELETE FROM user_mfa_recovery_codes WHERE user_id=$1', [userId]);
        for (const recoveryCode of recoveryCodes) await client.query('INSERT INTO user_mfa_recovery_codes(user_id,code_hash) VALUES($1,$2)', [userId, digest(recoveryCode)]);
        await client.query('COMMIT'); return { enabled: true, recoveryCodes };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async disableMfa({ userId, password, code }) {
      const userResult = await pool.query('SELECT id,password_hash,mfa_enabled FROM users WHERE id=$1', [userId]); const user = userResult.rows[0];
      if (!user || !user.mfa_enabled || !await verifyPassword(password, user.password_hash)) throw authError(403, 'ERR_SYSTEMFABRIC_MFA_REAUTH_FAILED', 'Password and a valid MFA code are required.');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query('SELECT secret_ciphertext,last_used_step,pending_secret FROM user_mfa_credentials WHERE user_id=$1 FOR UPDATE', [userId]);
        const credential = result.rows[0];
        if (!credential || credential.pending_secret) throw authError(409, 'ERR_SYSTEMFABRIC_MFA_NOT_CONFIGURED', 'MFA is not configured.');
        const step = verifyTotp(decryptSecret(credential.secret_ciphertext, env), String(code || ''), { now: clock(), lastUsedStep: Number(credential.last_used_step) });
        if (step === null) throw authError(403, 'ERR_SYSTEMFABRIC_MFA_INVALID', 'A valid, unused MFA code is required.');
        await client.query('DELETE FROM user_mfa_credentials WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM user_mfa_recovery_codes WHERE user_id=$1', [userId]);
        await client.query('UPDATE users SET mfa_enabled=false,mfa_enabled_at=NULL,updated_at=now() WHERE id=$1', [userId]);
        await client.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
        await client.query('COMMIT'); return { disabled: true };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async requestPasswordReset({ email: inputEmail }) {
      const email = normalizeEmail(inputEmail); if (!email) return { accepted: true };
      const result = await pool.query("SELECT id,email FROM users WHERE lower(email)=$1 AND status='active' LIMIT 1", [email]);
      const user = result.rows[0]; if (!user) return { accepted: true };
      const token = randomBytes(32).toString('base64url'); const expiresAt = new Date(clock() + 30 * 60_000);
      const base = configuredPublicBase(env);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("UPDATE identity_action_tokens SET consumed_at=now() WHERE user_id=$1 AND purpose='password-reset' AND consumed_at IS NULL", [user.id]);
        await client.query("INSERT INTO identity_action_tokens(user_id,purpose,token_hash,expires_at) VALUES($1,'password-reset',$2,$3)", [user.id, digest(token), expiresAt]);
        await client.query("INSERT INTO mail_outbox(recipient,template,payload) VALUES($1,'password-reset',$2::jsonb)", [user.email, JSON.stringify({ resetUrl: `${base}/reset-password?token=${encodeURIComponent(token)}`, expiresAt: expiresAt.toISOString() })]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
      return { accepted: true, ...(env.NODE_ENV !== 'production' && env.SYSTEMFABRIC_EXPOSE_DEV_TOKENS === 'true' ? { developmentToken: token } : {}) };
    },

    async resetPassword({ token, password }) {
      validatePassword(password);
      if (typeof token !== 'string' || token.length < 32 || token.length > 200) throw authError(400, 'ERR_SYSTEMFABRIC_RESET_TOKEN_INVALID', 'Password reset token is invalid or expired.');
      const passwordHash = await hashPassword(password); const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query("SELECT id,user_id FROM identity_action_tokens WHERE token_hash=$1 AND purpose='password-reset' AND consumed_at IS NULL AND expires_at>now() FOR UPDATE", [digest(token)]);
        const action = result.rows[0]; if (!action) throw authError(400, 'ERR_SYSTEMFABRIC_RESET_TOKEN_INVALID', 'Password reset token is invalid or expired.');
        await client.query('UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1', [action.user_id, passwordHash]);
        await client.query('UPDATE identity_action_tokens SET consumed_at=now() WHERE id=$1', [action.id]);
        await client.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [action.user_id]);
        await client.query('COMMIT'); return { reset: true };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
    },

    async requestEmailVerification({ userId }) {
      const result = await pool.query("SELECT id,email,email_verified_at FROM users WHERE id=$1 AND status='active'", [userId]);
      const user = result.rows[0]; if (!user) throw authError(404, 'ERR_SYSTEMFABRIC_USER_NOT_FOUND', 'Account not found.');
      if (user.email_verified_at) return { accepted: true, alreadyVerified: true };
      const token = randomBytes(32).toString('base64url'); const expiresAt = new Date(clock() + 24 * 60 * 60_000);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("UPDATE identity_action_tokens SET consumed_at=now() WHERE user_id=$1 AND purpose='email-verification' AND consumed_at IS NULL", [userId]);
        await client.query("INSERT INTO identity_action_tokens(user_id,purpose,token_hash,expires_at) VALUES($1,'email-verification',$2,$3)", [userId, digest(token), expiresAt]);
        await client.query("INSERT INTO mail_outbox(recipient,template,payload) VALUES($1,'email-verification',$2::jsonb)", [user.email, JSON.stringify({ verifyUrl: `${configuredPublicBase(env)}/verify-email?token=${encodeURIComponent(token)}`, expiresAt: expiresAt.toISOString() })]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
      return { accepted: true, ...(env.NODE_ENV !== 'production' && env.SYSTEMFABRIC_EXPOSE_DEV_TOKENS === 'true' ? { developmentToken: token } : {}) };
    },

    async verifyEmail({ token }) {
      if (typeof token !== 'string' || token.length < 32 || token.length > 200) throw authError(400, 'ERR_SYSTEMFABRIC_VERIFY_TOKEN_INVALID', 'Email verification token is invalid or expired.');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query("SELECT id,user_id FROM identity_action_tokens WHERE token_hash=$1 AND purpose='email-verification' AND consumed_at IS NULL AND expires_at>now() FOR UPDATE", [digest(token)]);
        const action = result.rows[0]; if (!action) throw authError(400, 'ERR_SYSTEMFABRIC_VERIFY_TOKEN_INVALID', 'Email verification token is invalid or expired.');
        await client.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),updated_at=now() WHERE id=$1', [action.user_id]);
        await client.query('UPDATE identity_action_tokens SET consumed_at=now() WHERE id=$1', [action.id]);
        await client.query('COMMIT'); return { verified: true };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
    },

    async listSessions({ userId, currentSessionId }) {
      const result = await pool.query('SELECT id,created_at,last_seen_at,expires_at,revoked_at,user_agent_hash,ip_hash FROM auth_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [userId]);
      return result.rows.map(row => ({ id: row.id, createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, revokedAt: row.revoked_at, current: row.id === currentSessionId, userAgentFingerprint: row.user_agent_hash ? row.user_agent_hash.slice(0, 12) : null, ipFingerprint: row.ip_hash ? row.ip_hash.slice(0, 12) : null }));
    },

    async revokeSession({ userId, sessionId }) {
      const result = await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id', [sessionId, userId]);
      return { revoked: result.rowCount > 0 };
    },

    async createOidcState({ state, nonce, verifier, issuer }) {
      if (![state, nonce, verifier, issuer].every(value => typeof value === 'string' && value.length > 0)) throw authError(400, 'ERR_SYSTEMFABRIC_OIDC_STATE_INVALID', 'OIDC state data is incomplete.');
      await pool.query('INSERT INTO auth_oidc_states(state_hash,nonce,code_verifier,issuer,expires_at) VALUES($1,$2,$3,$4,$5)', [digest(state), nonce, verifier, issuer, new Date(clock() + 10 * 60_000)]);
      return { expiresInSeconds: 600 };
    },

    async consumeOidcState({ state }) {
      if (typeof state !== 'string' || state.length < 32 || state.length > 256) throw authError(400, 'ERR_SYSTEMFABRIC_OIDC_STATE_INVALID', 'OIDC state is invalid or expired.');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query('SELECT id,nonce,code_verifier,issuer FROM auth_oidc_states WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE', [digest(state)]);
        const row = result.rows[0]; if (!row) throw authError(400, 'ERR_SYSTEMFABRIC_OIDC_STATE_INVALID', 'OIDC state is invalid or expired.');
        await client.query("UPDATE auth_oidc_states SET consumed_at=now(),code_verifier='' WHERE id=$1", [row.id]);
        await client.query('COMMIT'); return { nonce: row.nonce, verifier: row.code_verifier, issuer: row.issuer };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
    },

    async loginFederated({ issuer, subject, email: inputEmail, ip, userAgent }) {
      const email = normalizeEmail(inputEmail);
      if (!email || typeof issuer !== 'string' || typeof subject !== 'string' || !subject) throw authError(401, 'ERR_SYSTEMFABRIC_OIDC_IDENTITY_INVALID', 'The external identity is invalid.');
      const client = await pool.connect(); let user;
      try {
        await client.query('BEGIN');
        const mapped = await client.query(`SELECT u.id,u.email,u.display_name,u.status,u.mfa_enabled,u.email_verified_at
          FROM user_external_identities e JOIN users u ON u.id=e.user_id WHERE e.issuer=$1 AND e.subject=$2 FOR UPDATE OF u`, [issuer, subject]);
        if (mapped.rows[0]) user = mapped.rows[0];
        else {
          const found = await client.query('SELECT id,email,display_name,status,mfa_enabled,email_verified_at FROM users WHERE lower(email)=$1 LIMIT 1 FOR UPDATE', [email]);
          user = found.rows[0];
          if (!user || user.status !== 'active') throw authError(403, 'ERR_SYSTEMFABRIC_OIDC_ACCOUNT_NOT_LINKED', 'This verified identity is not linked to an active SystemFabric account. Ask a site owner to provision the account first.');
          await client.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),updated_at=now() WHERE id=$1', [user.id]);
          await client.query('INSERT INTO user_external_identities(user_id,issuer,subject) VALUES($1,$2,$3) ON CONFLICT(issuer,subject) DO NOTHING', [user.id, issuer, subject]);
          const confirmed = await client.query('SELECT user_id FROM user_external_identities WHERE issuer=$1 AND subject=$2', [issuer, subject]);
          if (confirmed.rows[0]?.user_id !== user.id) throw authError(409, 'ERR_SYSTEMFABRIC_OIDC_IDENTITY_LINK_CONFLICT', 'This external identity is already linked to a different account.');
        }
        if (user.status !== 'active') throw authError(403, 'ERR_SYSTEMFABRIC_ACCOUNT_DISABLED', 'This account is disabled.');
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
      if (user.mfa_enabled) {
        const challengeToken = randomBytes(32).toString('base64url');
        await pool.query('INSERT INTO auth_mfa_challenges(user_id,token_hash,expires_at) VALUES($1,$2,$3)', [user.id, digest(challengeToken), new Date(clock() + 5 * 60_000)]);
        return { mfaRequired: true, challengeToken, user: safeUser(user), expiresAt: new Date(clock() + 5 * 60_000) };
      }
      return { ...(await createSession(user, { ip, userAgent })), mfaRequired: false };
    },

    async authenticate(token) {
      if (typeof token !== 'string' || token.length < 32 || token.length > 200) return null;
      const result = await pool.query(
        `SELECT s.id AS session_id,s.user_id,s.csrf_hash,s.expires_at,u.email,u.display_name,u.status,u.email_verified_at,u.mfa_enabled
         FROM auth_sessions s JOIN users u ON u.id=s.user_id
         WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()
           AND s.last_seen_at > now() - ($2 * interval '1 minute') AND u.status='active' LIMIT 1`,
        [digest(token), sessionIdleTtlMinutes]
      );
      const row = result.rows[0];
      if (!row) return null;
      void pool.query('UPDATE auth_sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at < now() - interval \'1 minute\'', [row.session_id]).catch(() => {});
      const memberships = await pool.query(
        `SELECT s.id AS site_id,s.slug AS site_slug,s.name AS site_name,r.slug AS role_slug,r.capabilities
         FROM site_memberships m JOIN sites s ON s.id=m.site_id JOIN roles r ON r.id=m.role_id
         WHERE m.user_id=$1 ORDER BY s.name`, [row.user_id]
      );
      const bySite = new Map();
      for (const member of memberships.rows) {
        let entry = bySite.get(member.site_id);
        if (!entry) { entry = { siteId: member.site_id, siteSlug: member.site_slug, siteName: member.site_name, roles: [], capabilities: new Set() }; bySite.set(member.site_id, entry); }
        entry.roles.push(member.role_slug);
        for (const capability of (Array.isArray(member.capabilities) ? member.capabilities : [])) entry.capabilities.add(capability);
      }
      return {
        sessionId: row.session_id, user: { id: row.user_id, email: row.email, displayName: row.display_name, status: row.status, emailVerified: Boolean(row.email_verified_at), mfaEnabled: Boolean(row.mfa_enabled) },
        expiresAt: row.expires_at,
        memberships: [...bySite.values()].map(m => ({ ...m, role: m.roles.length === 1 ? m.roles[0] : m.roles, roles: m.roles, capabilities: [...m.capabilities] }))
      };
    },

    async validateCsrf(token, csrf) {
      if (typeof token !== 'string' || typeof csrf !== 'string') return false;
      const result = await pool.query('SELECT csrf_hash FROM auth_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()', [digest(token)]);
      return !!result.rows[0] && safeEqualText(result.rows[0].csrf_hash, digest(csrf));
    },

    async logout(token) {
      if (!token) return;
      await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [digest(token)]);
    },

    async listSites(userId) {
      const result = await pool.query(
        `SELECT s.id,s.slug,s.name,s.default_locale,r.slug AS role,r.capabilities
         FROM site_memberships m JOIN sites s ON s.id=m.site_id JOIN roles r ON r.id=m.role_id
         WHERE m.user_id=$1 ORDER BY s.name`, [userId]
      );
      const bySite = new Map();
      for (const row of result.rows) {
        let site = bySite.get(row.id);
        if (!site) { site = { id: row.id, slug: row.slug, name: row.name, defaultLocale: row.default_locale, roles: [], capabilities: new Set() }; bySite.set(row.id, site); }
        site.roles.push(row.role); for (const capability of (Array.isArray(row.capabilities) ? row.capabilities : [])) site.capabilities.add(capability);
      }
      return [...bySite.values()].map(site => ({ ...site, role: site.roles.length === 1 ? site.roles[0] : site.roles, capabilities: [...site.capabilities] }));
    },

    async authorizeSite(userId, siteId, capability) {
      if (!userId || !siteId) return false;
      const result = await pool.query(
        `SELECT r.capabilities FROM site_memberships m JOIN roles r ON r.id=m.role_id
         JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.site_id=$2 AND u.status='active'`, [userId, siteId]
      );
      return result.rows.some(row => Array.isArray(row.capabilities) && (
        row.capabilities.includes(capability) || row.capabilities.includes('site:manage') || row.capabilities.includes('*')
      ));
    },

    async createSite({ actorId, slug, name }) {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(slug || ''))) { const error = new Error('Site slug must use lowercase letters, numbers, and hyphens.'); error.statusCode = 400; error.code = 'ERR_SYSTEMFABRIC_INVALID_SITE_SLUG'; throw error; }
      if (typeof name !== 'string' || !name.trim() || name.length > 180) { const error = new Error('Site name must be 1–180 characters.'); error.statusCode = 400; error.code = 'ERR_SYSTEMFABRIC_INVALID_SITE_NAME'; throw error; }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const allowed = await client.query(`SELECT 1 FROM site_memberships m JOIN roles r ON r.id=m.role_id WHERE m.user_id=$1 AND r.capabilities @> '["site:manage"]'::jsonb LIMIT 1`, [actorId]);
        if (!allowed.rows[0]) { const error = new Error('At least one existing site-owner membership is required to create another site.'); error.statusCode = 403; error.code = 'ERR_SYSTEMFABRIC_FORBIDDEN'; throw error; }
        const site = await client.query('INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id,slug,name,default_locale', [slug, name.trim()]);
        const role = await client.query("SELECT id FROM roles WHERE slug='site-owner'");
        await client.query('INSERT INTO site_memberships(site_id,user_id,role_id) VALUES($1,$2,$3)', [site.rows[0].id, actorId, role.rows[0].id]);
        await client.query('COMMIT'); return site.rows[0];
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') { error.statusCode = 409; error.code = 'ERR_SYSTEMFABRIC_SITE_SLUG_EXISTS'; } throw error; }
      finally { client.release(); }
    },

    async listMembers({ siteId }) {
      const result = await pool.query(`SELECT u.id,u.email,u.display_name,u.status,r.slug AS role,m.created_at
        FROM site_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id
        WHERE m.site_id=$1 ORDER BY r.slug,u.email`, [siteId]);
      return result.rows.map(row => ({ id: row.id, email: row.email, displayName: row.display_name, status: row.status, role: row.role, joinedAt: row.created_at }));
    },

    async addMember({ siteId, email: inputEmail, roleSlug }) {
      const email = normalizeEmail(inputEmail);
      if (!email) { const error = new Error('A valid email address is required.'); error.statusCode = 400; error.code = 'ERR_SYSTEMFABRIC_INVALID_EMAIL'; throw error; }
      if (!['editor','author','viewer'].includes(roleSlug)) { const error = new Error('Members may be assigned editor, author, or viewer roles using this endpoint.'); error.statusCode = 400; error.code = 'ERR_SYSTEMFABRIC_INVALID_ROLE'; throw error; }
      const user = await pool.query("SELECT id,email,display_name,status FROM users WHERE lower(email)=$1 AND status='active'", [email]);
      if (!user.rows[0]) { const error = new Error('No active account exists for that email. Create an invitation instead.'); error.statusCode = 404; error.code = 'ERR_SYSTEMFABRIC_USER_NOT_FOUND'; throw error; }
      const role = await pool.query('SELECT id FROM roles WHERE slug=$1', [roleSlug]);
      await pool.query('INSERT INTO site_memberships(site_id,user_id,role_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [siteId, user.rows[0].id, role.rows[0].id]);
      return safeUser(user.rows[0]);
    },

    async removeMember({ siteId, userId }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const isOwner = await client.query(`SELECT 1 FROM site_memberships m JOIN roles r ON r.id=m.role_id WHERE m.site_id=$1 AND m.user_id=$2 AND r.slug='site-owner'`, [siteId, userId]);
        if (isOwner.rows[0]) {
          const owners = await client.query(`SELECT count(*)::integer AS count FROM site_memberships m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id WHERE m.site_id=$1 AND r.slug='site-owner' AND u.status='active'`, [siteId]);
          if (owners.rows[0].count <= 1) { const error = new Error('The last active site owner cannot be removed.'); error.statusCode = 409; error.code = 'ERR_SYSTEMFABRIC_LAST_OWNER'; throw error; }
        }
        await client.query('DELETE FROM site_memberships WHERE site_id=$1 AND user_id=$2', [siteId, userId]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async createInvitation({ siteId, email: inputEmail, roleSlug, invitedBy }) {
      const email = normalizeEmail(inputEmail);
      if (!email) { const error = new Error('A valid email address is required.'); error.statusCode = 400; error.code = 'ERR_SYSTEMFABRIC_INVALID_EMAIL'; throw error; }
      if (!['editor','author','viewer'].includes(roleSlug)) { const error = new Error('Invitations may grant editor, author, or viewer access.'); error.statusCode = 400; error.code = 'ERR_SYSTEMFABRIC_INVALID_ROLE'; throw error; }
      const role = await pool.query('SELECT id FROM roles WHERE slug=$1', [roleSlug]);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(clock() + 7 * 24 * 60 * 60_000);
      const site = await pool.query('SELECT slug,name FROM sites WHERE id=$1', [siteId]);
      if (!site.rows[0]) throw authError(404, 'ERR_SYSTEMFABRIC_SITE_NOT_FOUND', 'Site not found.');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO site_invitations(site_id,email,role_id,token_hash,invited_by,expires_at)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (site_id, (lower(email))) WHERE accepted_at IS NULL DO UPDATE
          SET role_id=EXCLUDED.role_id,token_hash=EXCLUDED.token_hash,invited_by=EXCLUDED.invited_by,expires_at=EXCLUDED.expires_at,created_at=now()`,
          [siteId, email, role.rows[0].id, digest(token), invitedBy, expiresAt]);
        await client.query("INSERT INTO mail_outbox(recipient,template,payload) VALUES($1,'site-invitation',$2::jsonb)", [email, JSON.stringify({ siteName: site.rows[0].name, inviteUrl: `${configuredPublicBase(env)}/accept-invitation?token=${encodeURIComponent(token)}`, expiresAt: expiresAt.toISOString() })]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
      return { email, role: roleSlug, expiresAt, ...(env.NODE_ENV !== 'production' && env.SYSTEMFABRIC_EXPOSE_DEV_TOKENS === 'true' ? { token } : {}) };
    },

    async acceptInvitation({ token, password, displayName }) {
      if (typeof token !== 'string' || token.length < 32 || token.length > 200) { const error = new Error('Invitation is invalid or expired.'); error.statusCode = 400; error.code = 'ERR_SYSTEMFABRIC_INVITATION_INVALID'; throw error; }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const invite = await client.query(`SELECT i.*,r.slug AS role_slug FROM site_invitations i JOIN roles r ON r.id=i.role_id
          WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.expires_at>now() FOR UPDATE`, [digest(token)]);
        if (!invite.rows[0]) { const error = new Error('Invitation is invalid or expired.'); error.statusCode = 400; error.code = 'ERR_SYSTEMFABRIC_INVITATION_INVALID'; throw error; }
        const data = invite.rows[0];
        let user = await client.query("SELECT id,email,display_name,status FROM users WHERE lower(email)=lower($1) LIMIT 1", [data.email]);
        if (!user.rows[0]) {
          const passwordHash = await hashPassword(password);
          user = await client.query("INSERT INTO users(email,display_name,password_hash,status,email_verified_at) VALUES($1,$2,$3,'active',now()) RETURNING id,email,display_name,status", [data.email, String(displayName || data.email).slice(0,180), passwordHash]);
        } else if (user.rows[0].status !== 'active') { const error = new Error('This account is disabled. Contact the site administrator.'); error.statusCode = 403; error.code = 'ERR_SYSTEMFABRIC_ACCOUNT_DISABLED'; throw error; }
        await client.query('INSERT INTO site_memberships(site_id,user_id,role_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [data.site_id, user.rows[0].id, data.role_id]);
        await client.query('UPDATE site_invitations SET accepted_at=now() WHERE id=$1', [data.id]);
        await client.query('COMMIT'); return { user: safeUser(user.rows[0]), siteId: data.site_id, role: data.role_slug };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async audit({ siteId = null, actorId = null, action, targetType = null, targetId = null, result = 'success', requestId = null, details = {} }) {
      await pool.query(
        `INSERT INTO audit_events(site_id,actor_id,action,target_type,target_id,result,request_id,details)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [siteId, actorId, action, targetType, targetId, result, requestId, JSON.stringify(details)]
      );
    }
  });
}

module.exports = { createIdentityService, normalizeEmail, validatePassword, hashPassword, verifyPassword, digest, safeEqualText, SESSION_TTL_HOURS, configuredPublicBase, authError };
