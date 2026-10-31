'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPostgresPool } = require('../../packages/db/src/postgres-store');
const { createIdentityService, hashPassword } = require('../../packages/auth/src/service');
const { createApiServer } = require('../../apps/api/src/server');

const enabled = Boolean(
  process.env.DATABASE_URL &&
  process.env.SYSTEMFABRIC_RUN_POSTGRES_INTEGRATION === 'true'
);

test(
  'tenant isolation: reject conflicting site selectors before cross-site community feed reads or writes',
  { skip: !enabled },
  async t => {
    const pool = createPostgresPool({
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_POOL_MAX: '8',
    });
    const siteIds = [];
    const userIds = [];
    let roleId = null;
    let server = null;

    const env = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL,
      REQUIRE_VERIFIED_EMAIL: 'false',
      AI_PROVIDER: 'mock',
    };
    // Ensure the development-token shortcut is not enabled in this API test.
    delete env.SYSTEMFABRIC_API_TOKEN;

    const identity = createIdentityService({ pool, env });

    t.after(async () => {
      if (server) {
        if (server.listening) {
          await new Promise(resolve => server.close(resolve));
        }
        await server.systemfabric.close().catch(() => {});
      }

      if (siteIds.length) {
        await pool.query('DELETE FROM sites WHERE id = ANY($1::uuid[])', [siteIds]).catch(() => {});
      }
      if (userIds.length) {
        await pool.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [userIds]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]).catch(() => {});
      }
      if (roleId) {
        await pool.query('DELETE FROM roles WHERE id = $1', [roleId]).catch(() => {});
      }
      await pool.end();
    });

    const siteAResult = await pool.query(
      'INSERT INTO sites(slug, name) VALUES($1, $2) RETURNING id',
      [`tenant-iso-a-${randomUUID().slice(0, 8)}`, 'Tenant Isolation Site A']
    );
    const siteA = siteAResult.rows[0].id;
    siteIds.push(siteA);

    const siteBResult = await pool.query(
      'INSERT INTO sites(slug, name) VALUES($1, $2) RETURNING id',
      [`tenant-iso-b-${randomUUID().slice(0, 8)}`, 'Tenant Isolation Site B']
    );
    const siteB = siteBResult.rows[0].id;
    siteIds.push(siteB);

    const role = await pool.query(
      'INSERT INTO roles(slug, label, capabilities) VALUES($1, $2, $3::jsonb) RETURNING id',
      [`tenant-iso-${randomUUID().slice(0, 10)}`, 'Tenant Isolation Test Owner', JSON.stringify(['*'])]
    );
    roleId = role.rows[0].id;

    const password = 'Isolation-Password-2026';
    const actorResult = await pool.query(
      `INSERT INTO users(email, display_name, password_hash, status)
       VALUES($1, $2, $3, 'active') RETURNING id, email`,
      [`tenant-iso-actor-${randomUUID()}@example.test`, 'Tenant B Actor', await hashPassword(password)]
    );
    const actor = actorResult.rows[0];
    userIds.push(actor.id);

    const authorResult = await pool.query(
      `INSERT INTO users(email, display_name, status)
       VALUES($1, $2, 'active') RETURNING id`,
      [`tenant-iso-author-${randomUUID()}@example.test`, 'Tenant A Author']
    );
    const authorId = authorResult.rows[0].id;
    userIds.push(authorId);

    // The authenticated actor belongs only to site B. The fixture author belongs only to site A.
    await pool.query(
      'INSERT INTO site_memberships(site_id, user_id, role_id) VALUES($1, $2, $3), ($4, $5, $3)',
      [siteA, authorId, roleId, siteB, actor.id]
    );

    const privateMarker = `TENANT_A_PRIVATE_${randomUUID()}`;
    const writeMarker = `TENANT_A_WRITE_${randomUUID()}`;
    await pool.query(
      `INSERT INTO social_activities(site_id, actor_id, activity_type, body, visibility)
       VALUES($1, $2, 'status', $3, 'members')`,
      [siteA, authorId, privateMarker]
    );

    const session = await identity.login({ email: actor.email, password, ip: '127.0.0.1' });
    assert.equal(session.mfaRequired, false);

    server = createApiServer({ env, pool, identityService: identity, logger: { error() {} } });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const authHeaders = { authorization: `Bearer ${session.token}` };

    const ordinaryForbidden = await fetch(`${base}/api/v1/sites/${siteA}/community/feed`, {
      headers: authHeaders,
    });
    assert.equal(ordinaryForbidden.status, 403, 'site A must reject an actor who belongs only to site B');
    const ordinaryForbiddenBody = await ordinaryForbidden.json();
    assert.equal(ordinaryForbiddenBody.code, 'ERR_SYSTEMFABRIC_TENANT_FORBIDDEN');
    assert.doesNotMatch(JSON.stringify(ordinaryForbiddenBody), new RegExp(privateMarker));

    // Duplicate selectors are rejected even when both values happen to agree.
    // This prevents callers and intermediaries from interpreting repeated query keys differently.
    const repeatedQuery = await fetch(
      `${base}/api/v1/sites/${siteB}/community/feed?siteId=${siteB}&siteId=${siteB}`,
      { headers: authHeaders }
    );
    assert.equal(repeatedQuery.status, 400);
    const repeatedQueryBody = await repeatedQuery.json();
    assert.equal(repeatedQueryBody.code, 'ERR_SYSTEMFABRIC_SITE_CONTEXT_MISMATCH');
    assert.doesNotMatch(JSON.stringify(repeatedQueryBody), new RegExp(privateMarker));

    // A malformed standalone selector must fail validation before any site lookup.
    const malformedQuery = await fetch(`${base}/api/v1/content-types?siteId=not-a-uuid`, {
      headers: authHeaders,
    });
    assert.equal(malformedQuery.status, 400);
    const malformedQueryBody = await malformedQuery.json();
    assert.equal(malformedQueryBody.code, 'ERR_SYSTEMFABRIC_INVALID_SITE_ID');
    assert.doesNotMatch(JSON.stringify(malformedQueryBody), new RegExp(privateMarker));

    const headerMismatch = await fetch(`${base}/api/v1/sites/${siteA}/community/feed`, {
      headers: { ...authHeaders, 'x-systemfabric-site-id': siteB },
    });
    assert.equal(headerMismatch.status, 400, 'a site B header must not authorize a site A route');
    const headerMismatchBody = await headerMismatch.json();
    assert.equal(headerMismatchBody.code, 'ERR_SYSTEMFABRIC_SITE_CONTEXT_MISMATCH');
    assert.doesNotMatch(JSON.stringify(headerMismatchBody), new RegExp(privateMarker));

    const queryMismatch = await fetch(`${base}/api/v1/sites/${siteA}/community/feed?siteId=${siteB}`, {
      headers: authHeaders,
    });
    assert.equal(queryMismatch.status, 400, 'a site B query selector must not authorize a site A route');
    const queryMismatchBody = await queryMismatch.json();
    assert.equal(queryMismatchBody.code, 'ERR_SYSTEMFABRIC_SITE_CONTEXT_MISMATCH');
    assert.doesNotMatch(JSON.stringify(queryMismatchBody), new RegExp(privateMarker));

    const bodyMismatch = await fetch(`${base}/api/v1/sites/${siteA}/community/feed`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: siteB, body: writeMarker, visibility: 'members' }),
    });
    assert.equal(bodyMismatch.status, 400, 'a site B body selector must not authorize writes to a site A route');
    const bodyMismatchBody = await bodyMismatch.json();
    assert.equal(bodyMismatchBody.code, 'ERR_SYSTEMFABRIC_SITE_CONTEXT_MISMATCH');
    assert.doesNotMatch(JSON.stringify(bodyMismatchBody), new RegExp(privateMarker));

    const writeMismatch = await fetch(`${base}/api/v1/sites/${siteA}/community/feed`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json', 'x-systemfabric-site-id': siteB },
      body: JSON.stringify({ body: writeMarker, visibility: 'members' }),
    });
    assert.equal(writeMismatch.status, 400, 'a site B header must not authorize writes to a site A route');
    const writeMismatchBody = await writeMismatch.json();
    assert.equal(writeMismatchBody.code, 'ERR_SYSTEMFABRIC_SITE_CONTEXT_MISMATCH');
    assert.doesNotMatch(JSON.stringify(writeMismatchBody), new RegExp(privateMarker));

    const malformedBodySelector = await fetch(`${base}/api/v1/sites/${siteA}/community/feed`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: 42, body: writeMarker, visibility: 'members' }),
    });
    assert.equal(malformedBodySelector.status, 400);
    const malformedBodySelectorBody = await malformedBodySelector.json();
    assert.equal(malformedBodySelectorBody.code, 'ERR_SYSTEMFABRIC_INVALID_SITE_ID');
    assert.doesNotMatch(JSON.stringify(malformedBodySelectorBody), new RegExp(privateMarker));

    const writtenAcrossSites = await pool.query(
      'SELECT id FROM social_activities WHERE site_id = $1 AND body = $2',
      [siteA, writeMarker]
    );
    assert.equal(writtenAcrossSites.rowCount, 0, 'the rejected request must not write activity into site A');

    const ownSite = await fetch(`${base}/api/v1/sites/${siteB}/community/feed`, {
      headers: authHeaders,
    });
    assert.equal(ownSite.status, 200, 'valid requests scoped to the actor\'s own site should still work');
    const ownSiteBody = await ownSite.json();
    assert.doesNotMatch(JSON.stringify(ownSiteBody), new RegExp(privateMarker));

    const matchingSelectors = await fetch(
      `${base}/api/v1/sites/${siteB}/community/feed?siteId=${siteB}`,
      { headers: { ...authHeaders, 'x-systemfabric-site-id': siteB } }
    );
    assert.equal(matchingSelectors.status, 200, 'matching route, header, and query selectors should be accepted');
    const matchingSelectorsBody = await matchingSelectors.json();
    assert.doesNotMatch(JSON.stringify(matchingSelectorsBody), new RegExp(privateMarker));
  }
);
