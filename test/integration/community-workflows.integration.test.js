'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPostgresPool } = require('../../packages/db/src/postgres-store');
const { handlePlatformRoute } = require('../../apps/api/src/platform-routes');

const enabled = Boolean(process.env.DATABASE_URL && process.env.SYSTEMFABRIC_RUN_POSTGRES_INTEGRATION === 'true');

function apiContext({ pool, siteId, user, method, pathname, body = {}, query = '' }) {
  const url = new URL(`http://systemfabric.integration${pathname}${query}`);
  const res = {};
  return {
    req: { method, headers: {} }, res, url,
    actor: { user: { id: user.id, email: user.email, displayName: user.displayName } },
    localPool: pool, maxBody: 64_000, requestId: randomUUID(),
    async siteIdFor({ body: requested }) {
      const requestedSiteId = requested.siteId;
      const member = await pool.query('SELECT 1 FROM site_memberships WHERE site_id=$1 AND user_id=$2 LIMIT 1', [requestedSiteId, user.id]);
      if (!member.rows[0]) throw Object.assign(new Error('Site membership required.'), { code: 'ERR_SYSTEMFABRIC_SITE_ACCESS', statusCode: 403 });
      return requestedSiteId;
    },
    async requireCapability(actor, requestedSiteId, capability) {
      const result = await pool.query(
        'SELECT 1 FROM site_memberships sm JOIN roles r ON r.id=sm.role_id WHERE sm.site_id=$1 AND sm.user_id=$2 AND r.capabilities ? $3 LIMIT 1',
        [requestedSiteId, actor.user.id, capability]
      );
      if (!result.rows[0]) throw Object.assign(new Error('Capability required.'), { code: 'ERR_SYSTEMFABRIC_CAPABILITY', statusCode: 403 });
    },
    async readJson() { return body; },
    sendJson(response, statusCode, payload) { response.statusCode = statusCode; response.payload = payload; return true; },
    fail(statusCode, code, message, details) { return Object.assign(new Error(message), { statusCode, code, details }); }
  };
}

async function invoke(options) {
  const ctx = apiContext(options);
  const handled = await handlePlatformRoute(ctx);
  assert.equal(handled, true, `route was not handled: ${options.method} ${options.pathname}`);
  return ctx.res;
}

test('community direct messages, blocks, reports, notifications, and moderation are site-scoped', { skip: !enabled }, async t => {
  const pool = createPostgresPool({ ...process.env, DATABASE_POOL_MAX: '8' });
  const siteSlug = `community-it-${randomUUID().slice(0, 10)}`;
  const site = await pool.query('INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id', [siteSlug, 'Community Workflow Integration']);
  const siteId = site.rows[0].id;
  const otherSite = await pool.query('INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id', [`${siteSlug}-other`, 'Community Isolation Fixture']);
  const otherSiteId = otherSite.rows[0].id;
  const role = await pool.query(
    'INSERT INTO roles(slug,label,capabilities) VALUES($1,$2,$3::jsonb) RETURNING id',
    [`community-it-${randomUUID().slice(0, 10)}`, 'Integration Moderator', JSON.stringify(['community:moderate', 'content:create', 'content:edit'])]
  );
  const roleId = role.rows[0].id;
  const users = [];
  for (const displayName of ['Community Alice', 'Community Bob']) {
    const user = await pool.query(
      'INSERT INTO users(email,display_name,status) VALUES($1,$2,\'active\') RETURNING id,email,display_name',
      [`${randomUUID()}@example.test`, displayName]
    );
    users.push(user.rows[0]);
    await pool.query('INSERT INTO site_memberships(site_id,user_id,role_id) VALUES($1,$2,$3)', [siteId, user.rows[0].id, roleId]);
  }
  const [alice, bob] = users;
  const fixtures = { conversationId: null, reportId: null, activityId: null };
  t.after(async () => {
    await pool.query('DELETE FROM sites WHERE id=ANY($1::uuid[])', [[siteId, otherSiteId]]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users.map(user => user.id)]).catch(() => {});
    await pool.query('DELETE FROM roles WHERE id=$1', [roleId]).catch(() => {});
    await pool.end();
  });

  const conversation = await invoke({
    pool, siteId, user: alice, method: 'POST', pathname: `/api/v1/sites/${siteId}/community/conversations`,
    body: { recipientId: bob.id }
  });
  assert.equal(conversation.statusCode, 201);
  fixtures.conversationId = conversation.payload.conversation.id;
  const duplicateConversation = await invoke({
    pool, siteId, user: alice, method: 'POST', pathname: `/api/v1/sites/${siteId}/community/conversations`,
    body: { recipientId: bob.id }
  });
  assert.equal(duplicateConversation.statusCode, 200);
  assert.equal(duplicateConversation.payload.conversation.id, fixtures.conversationId);

  const message = await invoke({
    pool, siteId, user: alice, method: 'POST', pathname: `/api/v1/sites/${siteId}/community/conversations/${fixtures.conversationId}/messages`,
    body: { body: 'Hello from Alice' }
  });
  assert.equal(message.statusCode, 201);
  assert.equal(message.payload.message.body, 'Hello from Alice');
  const inbox = await invoke({ pool, siteId, user: bob, method: 'GET', pathname: `/api/v1/sites/${siteId}/community/conversations` });
  assert.equal(inbox.payload.conversations[0].id, fixtures.conversationId);
  const messages = await invoke({ pool, siteId, user: bob, method: 'GET', pathname: `/api/v1/sites/${siteId}/community/conversations/${fixtures.conversationId}/messages` });
  assert.equal(messages.payload.messages.length, 1);
  assert.equal(messages.payload.messages[0].sender_id, alice.id);
  await assert.rejects(
    invoke({ pool, siteId: otherSiteId, user: alice, method: 'GET', pathname: `/api/v1/sites/${otherSiteId}/community/conversations/${fixtures.conversationId}/messages` }),
    error => error.code === 'ERR_SYSTEMFABRIC_SITE_ACCESS' && error.statusCode === 403
  );

  const block = await invoke({
    pool, siteId, user: bob, method: 'POST', pathname: `/api/v1/sites/${siteId}/community/blocks`,
    body: { userId: alice.id, reason: 'Integration block' }
  });
  assert.equal(block.statusCode, 201);
  await assert.rejects(
    invoke({ pool, siteId, user: alice, method: 'POST', pathname: `/api/v1/sites/${siteId}/community/conversations/${fixtures.conversationId}/messages`, body: { body: 'This should be blocked.' } }),
    error => error.code === 'ERR_SYSTEMFABRIC_COMMUNITY_BLOCKED' && error.statusCode === 403
  );

  const report = await invoke({
    pool, siteId, user: alice, method: 'POST', pathname: `/api/v1/sites/${siteId}/community/reports`,
    body: { targetType: 'user', targetId: bob.id, category: 'harassment', detail: 'Integration report' }
  });
  assert.equal(report.statusCode, 201);
  fixtures.reportId = report.payload.report.id;
  const reviewed = await invoke({
    pool, siteId, user: bob, method: 'PATCH', pathname: `/api/v1/sites/${siteId}/community/reports/${fixtures.reportId}`,
    body: { status: 'reviewing', moderationNote: 'Review started' }
  });
  assert.equal(reviewed.payload.report.status, 'reviewing');
  const dismissed = await invoke({
    pool, siteId, user: bob, method: 'PATCH', pathname: `/api/v1/sites/${siteId}/community/reports/${fixtures.reportId}`,
    body: { status: 'dismissed', moderationNote: 'Reviewed in integration test' }
  });
  assert.equal(dismissed.payload.report.status, 'dismissed');

  const activity = await pool.query(
    "INSERT INTO social_activities(site_id,actor_id,activity_type,body,visibility) VALUES($1,$2,'status','Moderation fixture','members') RETURNING id",
    [siteId, alice.id]
  );
  fixtures.activityId = activity.rows[0].id;
  const hidden = await invoke({
    pool, siteId, user: bob, method: 'POST', pathname: `/api/v1/sites/${siteId}/community/moderation`,
    body: { targetType: 'activity', targetId: fixtures.activityId, action: 'hide', reason: 'Integration moderation' }
  });
  assert.equal(hidden.payload.moderation.action, 'hide');
  const deletedActivity = await pool.query('SELECT deleted_at FROM social_activities WHERE site_id=$1 AND id=$2', [siteId, fixtures.activityId]);
  assert.ok(deletedActivity.rows[0].deleted_at);

  const notifications = await invoke({ pool, siteId, user: bob, method: 'GET', pathname: `/api/v1/sites/${siteId}/community/notifications` });
  assert.ok(notifications.payload.notifications.length > 0);
  const readAll = await invoke({ pool, siteId, user: bob, method: 'POST', pathname: `/api/v1/sites/${siteId}/community/notifications/read-all` });
  assert.ok(readAll.payload.markedRead >= 1);
  const moderationAudit = await pool.query("SELECT count(*)::int AS count FROM systemfabric_moderation_actions WHERE site_id=$1 AND target_id=$2", [siteId, fixtures.reportId]);
  assert.equal(moderationAudit.rows[0].count, 1);
});
