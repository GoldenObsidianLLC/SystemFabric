'use strict';

const { randomBytes } = require('node:crypto');

/**
 * Own the browser-session persistence and validation lifecycle.
 *
 * Identity credential flows create sessions through this service, while the
 * API consumes the returned authenticate/CSRF/session-management operations.
 * Raw bearer tokens are returned only at creation time; PostgreSQL receives
 * SHA-256 digests and metadata fingerprints, never the raw token or CSRF value.
 */
function createSessionService({
  pool,
  clock = () => Date.now(),
  sessionTtlMs,
  sessionIdleTtlMinutes,
  digestToken,
  safeEqualText,
  safeUser,
  onAuthorizationChange = async () => {}
} = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('Session service requires a PostgreSQL query pool.');
  }
  if (typeof clock !== 'function') throw new TypeError('Session service clock must be a function.');
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1) {
    throw new TypeError('Session service requires a positive integer session TTL.');
  }
  if (!Number.isInteger(sessionIdleTtlMinutes) || sessionIdleTtlMinutes < 1) {
    throw new TypeError('Session service requires a positive integer idle TTL.');
  }
  for (const [name, value] of Object.entries({ digestToken, safeEqualText, safeUser, onAuthorizationChange })) {
    if (typeof value !== 'function') throw new TypeError('Session service requires ' + name + '().');
  }

  async function notifyAuthorizationChange(change) {
    await onAuthorizationChange(Object.freeze({ ...change }));
  }

  async function createSession(user, metadata = {}) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const expiresAt = new Date(clock() + sessionTtlMs);
    await pool.query(
      `INSERT INTO auth_sessions(user_id,token_hash,csrf_hash,expires_at,user_agent_hash,ip_hash)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        user.id,
        digestToken(token),
        digestToken(csrf),
        expiresAt,
        metadata.userAgent ? digestToken(metadata.userAgent) : null,
        metadata.ip ? digestToken(metadata.ip) : null
      ]
    );
    return { token, csrf, expiresAt, user: safeUser(user) };
  }

  async function authenticate(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 200) return null;
    const result = await pool.query(
      `SELECT s.id AS session_id,s.user_id,s.csrf_hash,s.expires_at,u.email,u.display_name,u.status,u.email_verified_at,u.mfa_enabled
       FROM auth_sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()
         AND s.last_seen_at > now() - ($2 * interval '1 minute') AND u.status='active' LIMIT 1`,
      [digestToken(token), sessionIdleTtlMinutes]
    );
    const row = result.rows[0];
    if (!row) return null;

    // Touches are intentionally best-effort and throttled to one write/minute.
    // A failed last_seen_at update must not turn a valid authenticated request
    // into an error or extend the hard expiry.
    void pool.query(
      "UPDATE auth_sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at < now() - interval '1 minute'",
      [row.session_id]
    ).catch(() => {});

    const memberships = await pool.query(
      `SELECT s.id AS site_id,s.slug AS site_slug,s.name AS site_name,r.slug AS role_slug,r.capabilities
       FROM site_memberships m JOIN sites s ON s.id=m.site_id JOIN roles r ON r.id=m.role_id
       WHERE m.user_id=$1 ORDER BY s.name`,
      [row.user_id]
    );
    const bySite = new Map();
    for (const member of memberships.rows) {
      let entry = bySite.get(member.site_id);
      if (!entry) {
        entry = {
          siteId: member.site_id,
          siteSlug: member.site_slug,
          siteName: member.site_name,
          roles: [],
          capabilities: new Set()
        };
        bySite.set(member.site_id, entry);
      }
      entry.roles.push(member.role_slug);
      for (const capability of (Array.isArray(member.capabilities) ? member.capabilities : [])) {
        entry.capabilities.add(capability);
      }
    }
    return {
      sessionId: row.session_id,
      user: {
        id: row.user_id,
        email: row.email,
        displayName: row.display_name,
        status: row.status,
        emailVerified: Boolean(row.email_verified_at),
        mfaEnabled: Boolean(row.mfa_enabled)
      },
      expiresAt: row.expires_at,
      memberships: [...bySite.values()].map(member => ({
        ...member,
        role: member.roles.length === 1 ? member.roles[0] : member.roles,
        roles: member.roles,
        capabilities: [...member.capabilities]
      }))
    };
  }

  async function isSessionActive({ userId, sessionId }) {
    if (typeof userId !== 'string' || !userId || typeof sessionId !== 'string' || !sessionId) return false;
    const result = await pool.query(
      `SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id
       WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now()
         AND s.last_seen_at>now()-($3 * interval '1 minute') AND u.status='active' LIMIT 1`,
      [sessionId, userId, sessionIdleTtlMinutes]
    );
    return result.rowCount > 0;
  }

  async function validateCsrf(token, csrf) {
    if (typeof token !== 'string' || typeof csrf !== 'string') return false;
    const result = await pool.query(
      'SELECT csrf_hash FROM auth_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',
      [digestToken(token)]
    );
    return !!result.rows[0] && safeEqualText(result.rows[0].csrf_hash, digestToken(csrf));
  }

  async function logout(token) {
    if (!token) return { revoked: false };
    const result = await pool.query(
      'UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL RETURNING id,user_id',
      [digestToken(token)]
    );
    const session = result.rows[0];
    if (session) await notifyAuthorizationChange({ principalId: session.user_id, sessionId: session.id });
    return { revoked: Boolean(session) };
  }

  async function listSessions({ userId, currentSessionId }) {
    const result = await pool.query(
      'SELECT id,created_at,last_seen_at,expires_at,revoked_at,user_agent_hash,ip_hash FROM auth_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
      [userId]
    );
    return result.rows.map(row => ({
      id: row.id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      current: row.id === currentSessionId,
      userAgentFingerprint: row.user_agent_hash ? row.user_agent_hash.slice(0, 12) : null,
      ipFingerprint: row.ip_hash ? row.ip_hash.slice(0, 12) : null
    }));
  }

  async function revokeSession({ userId, sessionId }) {
    const result = await pool.query(
      'UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id',
      [sessionId, userId]
    );
    const revoked = result.rowCount > 0;
    if (revoked) await notifyAuthorizationChange({ principalId: userId, sessionId });
    return { revoked };
  }

  return Object.freeze({
    createSession,
    authenticate,
    isSessionActive,
    validateCsrf,
    logout,
    listSessions,
    revokeSession
  });
}

module.exports = { createSessionService };
