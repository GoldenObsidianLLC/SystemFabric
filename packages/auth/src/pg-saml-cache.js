'use strict';

const crypto = require('node:crypto');

function createPgSamlCacheProvider({ pool, issuer, ttlMs = 8 * 60 * 60 * 1000 } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL SAML cache requires a query-capable pool.');
  if (typeof issuer !== 'string' || issuer.length < 1 || issuer.length > 500) throw new TypeError('A bounded SAML issuer is required for cache isolation.');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60 * 1000) throw new TypeError('SAML request cache TTL must be between one minute and 24 hours.');
  const prefix = crypto.createHash('sha256').update(issuer).digest('hex').slice(0, 32);
  const cacheKey = key => {
    if (typeof key !== 'string' || key.length < 1 || key.length > 512) return null;
    return `${prefix}:${crypto.createHash('sha256').update(key).digest('hex')}`;
  };
  const item = row => row ? ({ value: row.cache_value, createdAt: new Date(row.created_at).getTime() }) : null;

  return Object.freeze({
    async saveAsync(key, value) {
      const normalizedKey = cacheKey(key);
      if (!normalizedKey || typeof value !== 'string' || value.length > 4096) return null;
      const result = await pool.query(`INSERT INTO auth_saml_request_cache(cache_key,cache_value,expires_at)
        VALUES($1,$2,now()+($3::bigint * interval '1 millisecond'))
        ON CONFLICT(cache_key) DO UPDATE SET cache_value=EXCLUDED.cache_value,created_at=now(),expires_at=EXCLUDED.expires_at
        RETURNING cache_value,created_at`, [normalizedKey, value, ttlMs]);
      return item(result.rows[0]);
    },
    async saveIfAbsentAsync(key, value) {
      const normalizedKey = cacheKey(key);
      if (!normalizedKey || typeof value !== 'string' || value.length > 4096) return null;
      const result = await pool.query(`INSERT INTO auth_saml_request_cache(cache_key,cache_value,expires_at)
        VALUES($1,$2,now()+($3::bigint * interval '1 millisecond'))
        ON CONFLICT(cache_key) DO UPDATE SET cache_value=EXCLUDED.cache_value,created_at=now(),expires_at=EXCLUDED.expires_at
        WHERE auth_saml_request_cache.expires_at <= now()
        RETURNING cache_value,created_at`, [normalizedKey, value, ttlMs]);
      return item(result.rows[0]);
    },
    async getAsync(key) {
      const normalizedKey = cacheKey(key); if (!normalizedKey) return null;
      const result = await pool.query('SELECT cache_value FROM auth_saml_request_cache WHERE cache_key=$1 AND expires_at>now()', [normalizedKey]);
      return result.rows[0]?.cache_value ?? null;
    },
    async removeAsync(key) {
      const normalizedKey = cacheKey(key); if (!normalizedKey) return null;
      const result = await pool.query('DELETE FROM auth_saml_request_cache WHERE cache_key=$1 RETURNING cache_value', [normalizedKey]);
      return result.rows[0]?.cache_value ?? null;
    },
    async consumeAsync(key) {
      const normalizedKey = cacheKey(key); if (!normalizedKey) return null;
      const result = await pool.query('DELETE FROM auth_saml_request_cache WHERE cache_key=$1 AND expires_at>now() RETURNING cache_value', [normalizedKey]);
      return result.rows[0]?.cache_value ?? null;
    },
    async purgeExpired() {
      const result = await pool.query('DELETE FROM auth_saml_request_cache WHERE expires_at<=now()');
      return result.rowCount || 0;
    },
    _ttlMs: ttlMs
  });
}

module.exports = { createPgSamlCacheProvider };
