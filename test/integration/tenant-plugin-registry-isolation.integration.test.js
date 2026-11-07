'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPostgresPool } = require('../../packages/db/src/postgres-store');
const { createIdentityService, hashPassword } = require('../../packages/auth/src/service');
const { createApiServer } = require('../../apps/api/src/server');

const enabled = Boolean(
  process.env.DATABASE_URL &&
  process.env.VIRGOSCORPIO_HUB_RUN_POSTGRES_INTEGRATION === 'true'
);

test(
  'tenant isolation: plugin registry listing, lifecycle actions, and invocation remain site-scoped',
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
      VIRGOSCORPIO_HUB_PLUGIN_EXECUTION_ENABLED: 'false',
    };
    delete env.VIRGOSCORPIO_HUB_API_TOKEN;

    const identity = createIdentityService({ pool, env });
    t.after(async () => {
      if (server) {
        if (server.listening) await new Promise(resolve => server.close(resolve));
        await server.virgoScorpioHub.close().catch(() => {});
      }
      if (siteIds.length) {
        await pool.query('DELETE FROM sites WHERE id = ANY($1::uuid[])', [siteIds]).catch(() => {});
      }
      if (userIds.length) {
        await pool.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [userIds]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]).catch(() => {});
      }
      if (roleId) await pool.query('DELETE FROM roles WHERE id = $1', [roleId]).catch(() => {});
      await pool.end();
    });

    const siteAResult = await pool.query(
      'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
      ['tenant-plugin-a-' + randomUUID().slice(0, 8), 'Tenant Plugin Site A']
    );
    const siteA = siteAResult.rows[0].id;
    siteIds.push(siteA);

    const siteBResult = await pool.query(
      'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
      ['tenant-plugin-b-' + randomUUID().slice(0, 8), 'Tenant Plugin Site B']
    );
    const siteB = siteBResult.rows[0].id;
    siteIds.push(siteB);

    const roleResult = await pool.query(
      'INSERT INTO roles(slug,label,capabilities) VALUES($1,$2,$3::jsonb) RETURNING id',
      ['tenant-plugin-' + randomUUID().slice(0, 10), 'Tenant Plugin Administrator', JSON.stringify(['*'])]
    );
    roleId = roleResult.rows[0].id;

    const password = 'Isolation-Password-2026';
    const passwordHash = await hashPassword(password);
    const actorResult = await pool.query(
      "INSERT INTO users(email,display_name,password_hash,status) VALUES($1,$2,$3,'active') RETURNING id,email",
      ['tenant-plugin-actor-' + randomUUID() + '@example.test', 'Site B Plugin Administrator', passwordHash]
    );
    const actor = actorResult.rows[0];
    userIds.push(actor.id);

    const reviewerResult = await pool.query(
      "INSERT INTO users(email,display_name,password_hash,status) VALUES($1,$2,$3,'active') RETURNING id,email",
      ['tenant-plugin-reviewer-' + randomUUID() + '@example.test', 'Site B Independent Plugin Reviewer', passwordHash]
    );
    const reviewer = reviewerResult.rows[0];
    userIds.push(reviewer.id);

    await pool.query(
      'INSERT INTO site_memberships(site_id,user_id,role_id) VALUES($1,$2,$3),($1,$4,$3)',
      [siteB, actor.id, roleId, reviewer.id]
    );

    const pluginName = 'tenant-isolation-plugin';
    const imageDigest = 'sha256:' + 'b'.repeat(64);
    const sbomDigest = 'c'.repeat(64);
    const manifest = JSON.stringify({
      name: pluginName,
      version: '1.0.0',
      apiVersion: 1,
      capabilities: ['content:read'],
    });
    const insertPlugin = async siteId => {
      const result = await pool.query(
        "INSERT INTO plugin_installs(site_id,name,version,api_version,status,source_type,image_digest,artifact_digest,sbom_reference,sbom_digest,provenance,signature_verified,manifest,requested_capabilities,approved_capabilities) " +
        "VALUES($1,$2,'1.0.0',1,'pending','oci-image',$3,$4,$5,$6,'{}'::jsonb,true,$7::jsonb,'[\"content:read\"]'::jsonb,'[]'::jsonb) RETURNING id",
        [siteId, pluginName, imageDigest, 'b'.repeat(64), 'artifact://tenant-plugin.sbom.json', sbomDigest, manifest]
      );
      return result.rows[0];
    };
    const pluginA = await insertPlugin(siteA);
    const pluginB = await insertPlugin(siteB);

    const actorSession = await identity.login({ email: actor.email, password, ip: '127.0.0.1' });
    const reviewerSession = await identity.login({ email: reviewer.email, password, ip: '127.0.0.1' });
    assert.equal(actorSession.mfaRequired, false);
    assert.equal(reviewerSession.mfaRequired, false);

    server = createApiServer({ env, pool, identityService: identity, logger: { error() {} } });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const base = 'http://127.0.0.1:' + server.address().port;
    const actorHeaders = {
      authorization: 'Bearer ' + actorSession.token,
      'x-virgoscorpio-hub-site-id': siteB,
    };
    const reviewerHeaders = {
      authorization: 'Bearer ' + reviewerSession.token,
      'x-virgoscorpio-hub-site-id': siteB,
    };
    const snapshot = async () => {
      const result = await pool.query(
        'SELECT id,site_id,status,approved_by,approved_capabilities,security_reviewed_at,security_reviewed_by,updated_at FROM plugin_installs WHERE id=ANY($1::uuid[]) ORDER BY site_id,id',
        [[pluginA.id, pluginB.id]]
      );
      return result.rows;
    };
    const invocationCount = async () => {
      const result = await pool.query(
        'SELECT count(*)::int AS count FROM plugin_invocations WHERE site_id=ANY($1::uuid[])',
        [[siteA, siteB]]
      );
      return result.rows[0].count;
    };
    const actionRequest = (pluginId, action, body, headers) => fetch(
      base + '/api/v1/plugins/' + pluginId + '/' + action,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ siteId: siteB, ...(body || {}) }),
      }
    );

    const listed = await fetch(base + '/api/v1/plugins', { headers: actorHeaders });
    assert.equal(listed.status, 200);
    const listedPayload = await listed.json();
    assert.ok(listedPayload.plugins.some(plugin => plugin.id === pluginB.id));
    assert.equal(listedPayload.plugins.some(plugin => plugin.id === pluginA.id), false);

    const beforeForeignActions = await snapshot();
    const foreignActions = [
      ['approve', { approvedCapabilities: ['content:read'] }],
      ['security-review', {}],
      ['activate', {}],
      ['disable', {}],
      ['invoke', { action: 'run', input: {} }],
    ];
    for (const [action, body] of foreignActions) {
      const response = await actionRequest(pluginA.id, action, body, actorHeaders);
      const payload = await response.json();
      assert.equal(response.status, 404, 'foreign plugin ' + action + ' must be indistinguishable from a missing Site B plugin');
      assert.equal(payload.code, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_NOT_FOUND');
    }

    const selectorMismatch = await fetch(base + '/api/v1/plugins/register', {
      method: 'POST',
      headers: { ...actorHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        siteId: siteA,
        sourceType: 'npm-archive',
        packageSha256: 'd'.repeat(64),
        manifest: { name: 'cross-site-registration', version: '1.0.0', apiVersion: 1, capabilities: [] },
      }),
    });
    assert.equal(selectorMismatch.status, 400);
    assert.equal((await selectorMismatch.json()).code, 'ERR_VIRGOSCORPIO_HUB_SITE_CONTEXT_MISMATCH');
    const unregistered = await pool.query(
      'SELECT id FROM plugin_installs WHERE site_id=ANY($1::uuid[]) AND name=$2',
      [[siteA, siteB], 'cross-site-registration']
    );
    assert.equal(unregistered.rowCount, 0, 'conflicting site selectors must not create a plugin registration');

    const afterForeignActions = await snapshot();
    assert.deepEqual(afterForeignActions, beforeForeignActions, 'foreign plugin actions must not mutate either site');
    assert.equal(await invocationCount(), 0, 'foreign invocation attempts must not create invocation records');

    const approvedResponse = await actionRequest(
      pluginB.id,
      'approve',
      { approvedCapabilities: ['content:read'] },
      actorHeaders
    );
    assert.equal(approvedResponse.status, 200);
    assert.equal((await approvedResponse.json()).plugin.status, 'approved');

    const reviewedResponse = await actionRequest(pluginB.id, 'security-review', {}, reviewerHeaders);
    assert.equal(reviewedResponse.status, 200);
    const reviewedState = await snapshot();
    const siteAAfterReview = reviewedState.find(row => row.id === pluginA.id);
    const siteBAfterReview = reviewedState.find(row => row.id === pluginB.id);
    assert.equal(siteAAfterReview.status, 'pending');
    assert.equal(siteAAfterReview.approved_by, null);
    assert.equal(siteBAfterReview.status, 'approved');
    assert.equal(siteBAfterReview.approved_by, actor.id);
    assert.equal(siteBAfterReview.security_reviewed_by, reviewer.id);
    assert.ok(siteBAfterReview.security_reviewed_at);

    const activation = await actionRequest(pluginB.id, 'activate', {}, actorHeaders);
    assert.equal(activation.status, 503);
    assert.equal((await activation.json()).code, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_EXECUTION_DISABLED');
    const stillApproved = await snapshot();
    assert.equal(stillApproved.find(row => row.id === pluginB.id).status, 'approved');

    const disabled = await actionRequest(pluginB.id, 'disable', {}, actorHeaders);
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).plugin.status, 'disabled');

    const invocation = await actionRequest(pluginB.id, 'invoke', { action: 'run', input: {} }, actorHeaders);
    assert.equal(invocation.status, 503);
    assert.equal((await invocation.json()).code, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_EXECUTION_DISABLED');
    assert.equal(await invocationCount(), 0, 'disabled execution must not call a runner or persist invocation records');
    const finalState = await snapshot();
    assert.equal(finalState.find(row => row.id === pluginA.id).status, 'pending');
    assert.equal(finalState.find(row => row.id === pluginB.id).status, 'disabled');
  }
);
