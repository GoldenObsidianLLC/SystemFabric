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

async function membershipSideEffects(pool, siteId, watchedRecipient) {
  const [memberships, invitations, mail, audit] = await Promise.all([
    pool.query(
      'SELECT site_id,user_id,role_id,created_at FROM site_memberships WHERE site_id=$1 ORDER BY user_id,role_id',
      [siteId]
    ),
    pool.query(
      `SELECT id,site_id,email,role_id,token_hash,invited_by,expires_at,accepted_at,created_at
         FROM site_invitations WHERE site_id=$1 ORDER BY id`,
      [siteId]
    ),
    pool.query(
      `SELECT id,recipient,template,payload,status,attempts,created_at
         FROM mail_outbox WHERE recipient=$1 AND template='site-invitation' ORDER BY id`,
      [watchedRecipient]
    ),
    pool.query(
      'SELECT id,site_id,actor_id,action,target_type,target_id,result,request_id,details,created_at FROM audit_events WHERE site_id=$1 ORDER BY id',
      [siteId]
    ),
  ]);
  return {
    memberships: memberships.rows,
    invitations: invitations.rows,
    mail: mail.rows,
    audit: audit.rows,
  };
}

test(
  'tenant isolation: site membership and invitation administration cannot cross site boundaries',
  { skip: !enabled },
  async t => {
    const pool = createPostgresPool({
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_POOL_MAX: '8',
    });
    const siteIds = [];
    const userIds = [];
    const mailRecipients = [];
    let server = null;

    const env = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL,
      REQUIRE_VERIFIED_EMAIL: 'false',
      SYSTEMFABRIC_EXPOSE_DEV_TOKENS: 'false',
    };
    delete env.SYSTEMFABRIC_API_TOKEN;
    const identity = createIdentityService({ pool, env });

    t.after(async () => {
      if (server) {
        if (server.listening) await new Promise(resolve => server.close(resolve));
        await server.systemfabric.close().catch(() => {});
      }
      if (siteIds.length) {
        await pool.query('DELETE FROM audit_events WHERE site_id=ANY($1::uuid[])', [siteIds]).catch(() => {});
      }
      if (mailRecipients.length) {
        await pool.query('DELETE FROM mail_outbox WHERE recipient=ANY($1::text[])', [mailRecipients]).catch(() => {});
      }
      if (siteIds.length) {
        await pool.query('DELETE FROM sites WHERE id=ANY($1::uuid[])', [siteIds]).catch(() => {});
      }
      if (userIds.length) {
        await pool.query('DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])', [userIds]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]).catch(() => {});
      }
      await pool.end();
    });

    const siteAResult = await pool.query(
      'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
      [`tenant-members-a-${randomUUID().slice(0, 8)}`, 'Tenant Membership Site A']
    );
    const siteA = siteAResult.rows[0].id;
    siteIds.push(siteA);

    const siteBResult = await pool.query(
      'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
      [`tenant-members-b-${randomUUID().slice(0, 8)}`, 'Tenant Membership Site B']
    );
    const siteB = siteBResult.rows[0].id;
    siteIds.push(siteB);

    const roles = await pool.query(
      "SELECT id,slug FROM roles WHERE slug IN ('site-owner','editor','viewer')"
    );
    const roleIds = new Map(roles.rows.map(row => [row.slug, row.id]));
    for (const required of ['site-owner', 'editor', 'viewer']) {
      assert.ok(roleIds.has(required), `the ${required} seed role must exist`);
    }

    async function createUser(label, withPassword = false) {
      const email = `tenant-members-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID()}@example.test`;
      const result = await pool.query(
        withPassword
          ? `INSERT INTO users(email,display_name,password_hash,status)
             VALUES($1,$2,$3,'active') RETURNING id,email,display_name`
          : `INSERT INTO users(email,display_name,status)
             VALUES($1,$2,'active') RETURNING id,email,display_name`,
        withPassword
          ? [email, label, await hashPassword('Isolation-Password-2026')]
          : [email, label]
      );
      userIds.push(result.rows[0].id);
      return result.rows[0];
    }

    const actorA = await createUser('Site A Owner', true);
    const actorB = await createUser('Site B Owner', true);
    const targetB = await createUser('Site B Existing Member');
    const targetA = await createUser('Site A Provisioning Target');

    await pool.query(
      'INSERT INTO site_memberships(site_id,user_id,role_id) VALUES($1,$2,$3),($4,$5,$3),($4,$6,$7)',
      [siteA, actorA.id, roleIds.get('site-owner'), siteB, actorB.id, targetB.id, roleIds.get('editor')]
    );

    const sessionA = await identity.login({
      email: actorA.email,
      password: 'Isolation-Password-2026',
      ip: '127.0.0.1',
      userAgent: 'tenant-membership-isolation-test',
    });
    assert.equal(sessionA.mfaRequired, false);

    server = createApiServer({
      env,
      pool,
      identityService: identity,
      logger: { error() {} },
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      authorization: `Bearer ${sessionA.token}`,
      'content-type': 'application/json',
    };
    const attemptedInviteEmail = `cross-site-invite-${randomUUID()}@example.test`;
    mailRecipients.push(attemptedInviteEmail);
    const before = await membershipSideEffects(pool, siteB, attemptedInviteEmail);

    async function denyCrossSite(method, url, body) {
      const response = await fetch(base + url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json();
      assert.equal(response.status, 403, `${method} ${url} must reject an administrator from a different site`);
      assert.equal(payload.code, 'ERR_SYSTEMFABRIC_FORBIDDEN');
      assert.doesNotMatch(JSON.stringify(payload), /Site B Existing Member|cross-site-invite/);
    }

    await t.test('site A owner can list and add members to site A', async () => {
      const listBefore = await fetch(`${base}/api/v1/sites/${siteA}/members`, {
        headers: { authorization: `Bearer ${sessionA.token}` },
      });
      assert.equal(listBefore.status, 200);
      const beforePayload = await listBefore.json();
      assert.ok(beforePayload.members.some(member => member.id === actorA.id));
      assert.equal(beforePayload.members.some(member => member.id === targetA.id), false);

      const add = await fetch(`${base}/api/v1/sites/${siteA}/members`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: targetA.email, role: 'viewer' }),
      });
      assert.equal(add.status, 201);
      const added = await add.json();
      assert.equal(added.member.id, targetA.id);

      const membership = await pool.query(
        'SELECT role_id FROM site_memberships WHERE site_id=$1 AND user_id=$2',
        [siteA, targetA.id]
      );
      assert.deepEqual(membership.rows.map(row => row.role_id), [roleIds.get('viewer')]);
    });

    await t.test('site A owner cannot enumerate site B members', async () => {
      await denyCrossSite('GET', `/api/v1/sites/${siteB}/members`);
    });

    await t.test('site A owner cannot add a member to site B', async () => {
      await denyCrossSite('POST', `/api/v1/sites/${siteB}/members`, {
        email: targetA.email,
        role: 'viewer',
      });
    });

    await t.test('site A owner cannot remove an existing site B member', async () => {
      await denyCrossSite('DELETE', `/api/v1/sites/${siteB}/members/${targetB.id}`);
    });

    await t.test('site A owner cannot create a site B invitation or mail delivery', async () => {
      await denyCrossSite('POST', `/api/v1/sites/${siteB}/invitations`, {
        email: attemptedInviteEmail,
        role: 'editor',
      });
    });

    await t.test('site A member addition produced a scoped audit record only in site A', async () => {
      const addedAudit = await pool.query(
        `SELECT site_id,actor_id,action,target_type,target_id,details
           FROM audit_events WHERE site_id=$1 AND action='site.member_added' AND target_id=$2`,
        [siteA, targetA.id]
      );
      assert.equal(addedAudit.rows.length, 1);
      assert.equal(addedAudit.rows[0].actor_id, actorA.id);
      assert.equal(addedAudit.rows[0].site_id, siteA);
      assert.deepEqual(await membershipSideEffects(pool, siteB, attemptedInviteEmail), before);
    });

    await t.test('site A owner can remove the A member without affecting site B', async () => {
      const response = await fetch(`${base}/api/v1/sites/${siteA}/members/${targetA.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${sessionA.token}` },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).removed, true);
      const membership = await pool.query(
        'SELECT 1 FROM site_memberships WHERE site_id=$1 AND user_id=$2',
        [siteA, targetA.id]
      );
      assert.equal(membership.rowCount, 0);
      assert.deepEqual(await membershipSideEffects(pool, siteB, attemptedInviteEmail), before);
    });

    await t.test('site A owner can create a site A invitation with isolated mail and audit effects', async () => {
      const invitedEmail = `site-a-invitation-${randomUUID()}@example.test`;
      mailRecipients.push(invitedEmail);
      const response = await fetch(`${base}/api/v1/sites/${siteA}/invitations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: invitedEmail, role: 'editor' }),
      });
      assert.equal(response.status, 201);
      const payload = await response.json();
      assert.equal(payload.invitation.email, invitedEmail);
      assert.equal(payload.invitation.role, 'editor');
      assert.equal(Object.hasOwn(payload.invitation, 'token'), false, 'one-time invitation token must not be returned by default');

      const invite = await pool.query(
        'SELECT site_id,email,role_id,length(token_hash)::int AS token_hash_length FROM site_invitations WHERE site_id=$1 AND lower(email)=lower($2) AND accepted_at IS NULL',
        [siteA, invitedEmail]
      );
      assert.equal(invite.rows.length, 1);
      assert.equal(invite.rows[0].site_id, siteA);
      assert.equal(invite.rows[0].role_id, roleIds.get('editor'));
      assert.equal(invite.rows[0].token_hash_length, 64);

      const mail = await pool.query(
        `SELECT recipient,template,payload FROM mail_outbox
          WHERE recipient=$1 AND template='site-invitation'`,
        [invitedEmail]
      );
      assert.equal(mail.rows.length, 1);
      assert.match(mail.rows[0].payload.inviteUrl, /^https?:\/\//);
      assert.ok(!Object.hasOwn(payload.invitation, 'token'));

      const audit = await pool.query(
        `SELECT site_id,actor_id,action,target_type,details FROM audit_events
          WHERE site_id=$1 AND action='site.invitation_created' AND details->>'email'=$2`,
        [siteA, invitedEmail]
      );
      assert.equal(audit.rows.length, 1);
      assert.equal(audit.rows[0].actor_id, actorA.id);
      assert.equal(audit.rows[0].target_type, 'invitation');
      assert.deepEqual(await membershipSideEffects(pool, siteB, attemptedInviteEmail), before);
    });

    const siteBMembership = await pool.query(
      'SELECT user_id,role_id FROM site_memberships WHERE site_id=$1 ORDER BY user_id',
      [siteB]
    );
    assert.equal(siteBMembership.rows.length, 2);
    assert.ok(siteBMembership.rows.some(row => row.user_id === actorB.id));
    assert.ok(siteBMembership.rows.some(row => row.user_id === targetB.id));
    assert.equal(siteBMembership.rows.some(row => row.user_id === actorA.id), false);
  }
);
