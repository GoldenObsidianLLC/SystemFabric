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

async function snapshotCommunitySite(pool, siteId) {
  const queries = {
    groups: [
      'SELECT id,site_id,slug,name,privacy,created_by,created_at FROM social_groups WHERE site_id=$1 ORDER BY id',
      [siteId],
    ],
    groupMembers: [
      `SELECT gm.group_id,gm.user_id,gm.role,gm.status,gm.created_at
         FROM social_group_memberships gm JOIN social_groups g ON g.id=gm.group_id
        WHERE g.site_id=$1 ORDER BY gm.group_id,gm.user_id`,
      [siteId],
    ],
    conversations: [
      'SELECT id,site_id,conversation_type,group_id,created_by,created_at,updated_at FROM social_conversations WHERE site_id=$1 ORDER BY id',
      [siteId],
    ],
    conversationMembers: [
      'SELECT conversation_id,site_id,user_id,joined_at,left_at,last_read_at FROM social_conversation_members WHERE site_id=$1 ORDER BY conversation_id,user_id',
      [siteId],
    ],
    messages: [
      'SELECT id,site_id,conversation_id,sender_id,body,status,created_at,updated_at,deleted_at FROM social_messages WHERE site_id=$1 ORDER BY id',
      [siteId],
    ],
    blocks: [
      'SELECT site_id,blocker_id,blocked_id,reason,created_at FROM social_blocks WHERE site_id=$1 ORDER BY blocker_id,blocked_id',
      [siteId],
    ],
    reports: [
      'SELECT id,site_id,reporter_id,target_type,target_id,category,detail,status,moderation_note,reviewed_by,created_at,updated_at FROM social_reports WHERE site_id=$1 ORDER BY id',
      [siteId],
    ],
    friendships: [
      'SELECT site_id,requester_id,addressee_id,status,created_at,updated_at FROM social_friendships WHERE site_id=$1 ORDER BY requester_id,addressee_id',
      [siteId],
    ],
    notifications: [
      'SELECT id,site_id,user_id,notification_type,payload,read_at,created_at FROM social_notifications WHERE site_id=$1 ORDER BY id',
      [siteId],
    ],
    moderation: [
      'SELECT id,site_id,actor_id,target_type,target_id,action,reason,created_at FROM virgoscorpio_hub_moderation_actions WHERE site_id=$1 ORDER BY id',
      [siteId],
    ],
  };
  const result = {};
  for (const [name, [sql, params]] of Object.entries(queries)) {
    const rows = await pool.query(sql, params);
    result[name] = rows.rows;
  }
  return result;
}

test(
  'tenant isolation: community object IDs, moderation, conversations, and notifications stay site-scoped',
  { skip: !enabled },
  async t => {
    const pool = createPostgresPool({
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_POOL_MAX: '10',
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
    delete env.VIRGOSCORPIO_HUB_API_TOKEN;
    const identity = createIdentityService({ pool, env });

    t.after(async () => {
      if (server) {
        if (server.listening) await new Promise(resolve => server.close(resolve));
        await server.virgoScorpioHub.close().catch(() => {});
      }
      if (siteIds.length) {
        await pool.query('DELETE FROM sites WHERE id=ANY($1::uuid[])', [siteIds]).catch(() => {});
      }
      if (userIds.length) {
        await pool.query('DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])', [userIds]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]).catch(() => {});
      }
      if (roleId) await pool.query('DELETE FROM roles WHERE id=$1', [roleId]).catch(() => {});
      await pool.end();
    });

    const siteAResult = await pool.query(
      'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
      [`tenant-community-a-${randomUUID().slice(0, 8)}`, 'Tenant Community Site A']
    );
    const siteA = siteAResult.rows[0].id;
    siteIds.push(siteA);

    const siteBResult = await pool.query(
      'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
      [`tenant-community-b-${randomUUID().slice(0, 8)}`, 'Tenant Community Site B']
    );
    const siteB = siteBResult.rows[0].id;
    siteIds.push(siteB);

    const roleResult = await pool.query(
      'INSERT INTO roles(slug,label,capabilities) VALUES($1,$2,$3::jsonb) RETURNING id',
      [
        `tenant-community-${randomUUID().slice(0, 10)}`,
        'Tenant Community Integration Moderator',
        JSON.stringify(['community:moderate', 'content:create', 'content:edit']),
      ]
    );
    roleId = roleResult.rows[0].id;

    async function createUser(label, withPassword = false) {
      const email = `tenant-community-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID()}@example.test`;
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

    const userA = await createUser('Site A Member');
    const userA2 = await createUser('Site A Target');
    const actorB = await createUser('Site B Moderator', true);
    const userB2 = await createUser('Site B Member');

    await pool.query(
      'INSERT INTO site_memberships(site_id,user_id,role_id) VALUES($1,$2,$3),($1,$4,$3),($5,$6,$3),($5,$7,$3)',
      [siteA, userA.id, roleId, userA2.id, siteB, actorB.id, userB2.id]
    );

    const groupAResult = await pool.query(
      `INSERT INTO social_groups(site_id,slug,name,description,privacy,created_by)
       VALUES($1,$2,$3,'Private tenant A group','private',$4) RETURNING id`,
      [siteA, `private-a-${randomUUID().slice(0, 8)}`, 'PRIVATE_SITE_A_GROUP_MARKER', userA.id]
    );
    const groupA = groupAResult.rows[0].id;
    await pool.query(
      `INSERT INTO social_group_memberships(group_id,user_id,role,status)
       VALUES($1,$2,'owner','active'),($1,$3,'member','active')`,
      [groupA, userA.id, userA2.id]
    );

    const groupBResult = await pool.query(
      `INSERT INTO social_groups(site_id,slug,name,description,privacy,created_by)
       VALUES($1,$2,$3,'Positive control group','public',$4) RETURNING id`,
      [siteB, `control-b-${randomUUID().slice(0, 8)}`, 'Site B Community Control', actorB.id]
    );
    const groupB = groupBResult.rows[0].id;
    await pool.query(
      "INSERT INTO social_group_memberships(group_id,user_id,role,status) VALUES($1,$2,'owner','active')",
      [groupB, actorB.id]
    );

    const conversationAResult = await pool.query(
      `INSERT INTO social_conversations(site_id,conversation_type,created_by)
       VALUES($1,'direct',$2) RETURNING id`,
      [siteA, userA.id]
    );
    const conversationA = conversationAResult.rows[0].id;
    await pool.query(
      'INSERT INTO social_conversation_members(conversation_id,site_id,user_id) VALUES($1,$2,$3),($1,$2,$4)',
      [conversationA, siteA, userA.id, userA2.id]
    );
    const messageAResult = await pool.query(
      `INSERT INTO social_messages(site_id,conversation_id,sender_id,body)
       VALUES($1,$2,$3,'PRIVATE_SITE_A_MESSAGE_MARKER') RETURNING id`,
      [siteA, conversationA, userA.id]
    );
    const messageA = messageAResult.rows[0].id;

    const conversationBResult = await pool.query(
      `INSERT INTO social_conversations(site_id,conversation_type,created_by)
       VALUES($1,'direct',$2) RETURNING id`,
      [siteB, actorB.id]
    );
    const conversationB = conversationBResult.rows[0].id;
    await pool.query(
      'INSERT INTO social_conversation_members(conversation_id,site_id,user_id) VALUES($1,$2,$3),($1,$2,$4)',
      [conversationB, siteB, actorB.id, userB2.id]
    );
    const messageBResult = await pool.query(
      `INSERT INTO social_messages(site_id,conversation_id,sender_id,body)
       VALUES($1,$2,$3,'Site B message control') RETURNING id`,
      [siteB, conversationB, userB2.id]
    );
    const messageB = messageBResult.rows[0].id;

    await pool.query(
      'INSERT INTO social_blocks(site_id,blocker_id,blocked_id,reason) VALUES($1,$2,$3,$4)',
      [siteA, userA.id, userA2.id, 'Site A block fixture']
    );
    await pool.query(
      'INSERT INTO social_friendships(site_id,requester_id,addressee_id,status) VALUES($1,$2,$3,\'accepted\')',
      [siteA, userA.id, userA2.id]
    );

    const reportAResult = await pool.query(
      `INSERT INTO social_reports(site_id,reporter_id,target_type,target_id,category,detail)
       VALUES($1,$2,'user',$3,'harassment','PRIVATE_SITE_A_REPORT_MARKER') RETURNING id`,
      [siteA, userA.id, userA2.id]
    );
    const reportA = reportAResult.rows[0].id;

    const activityAResult = await pool.query(
      `INSERT INTO social_activities(site_id,actor_id,activity_type,body,visibility)
       VALUES($1,$2,'status','PRIVATE_SITE_A_ACTIVITY_MARKER','members') RETURNING id,deleted_at`,
      [siteA, userA.id]
    );
    const activityA = activityAResult.rows[0].id;

    const notificationAResult = await pool.query(
      `INSERT INTO social_notifications(site_id,user_id,notification_type,payload)
       VALUES($1,$2,'community.message.new',jsonb_build_object('messageId',$3::text))
       RETURNING id`,
      [siteA, actorB.id, messageA]
    );
    const notificationA = notificationAResult.rows[0].id;
    const notificationBResult = await pool.query(
      `INSERT INTO social_notifications(site_id,user_id,notification_type,payload)
       VALUES($1,$2,'community.message.new',jsonb_build_object('messageId',$3::text))
       RETURNING id`,
      [siteB, actorB.id, messageB]
    );
    const notificationB = notificationBResult.rows[0].id;

    const session = await identity.login({
      email: actorB.email,
      password: 'Isolation-Password-2026',
      ip: '127.0.0.1',
      userAgent: 'tenant-community-isolation-test',
    });
    assert.equal(session.mfaRequired, false);

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
      authorization: `Bearer ${session.token}`,
      'x-virgoscorpio-hub-site-id': siteB,
    };
    const before = await snapshotCommunitySite(pool, siteA);

    async function assertSiteAUnchanged() {
      assert.deepEqual(await snapshotCommunitySite(pool, siteA), before);
    }

    await t.test('site B group listing and member reads do not reveal a foreign group', async () => {
      const response = await fetch(`${base}/api/v1/sites/${siteB}/community/groups`, { headers });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.ok(payload.groups.some(group => group.id === groupB));
      assert.equal(payload.groups.some(group => group.id === groupA), false);
      assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_SITE_A_GROUP_MARKER/);

      const members = await fetch(`${base}/api/v1/sites/${siteB}/community/groups/${groupA}/members`, { headers });
      assert.equal(members.status, 200);
      assert.deepEqual((await members.json()).members, []);
      await assertSiteAUnchanged();
    });

    await t.test('foreign group join is rejected without creating a site B membership', async () => {
      const response = await fetch(`${base}/api/v1/sites/${siteB}/community/groups/${groupA}/join`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, 'ERR_VIRGOSCORPIO_HUB_GROUP_NOT_FOUND');
      const membership = await pool.query(
        'SELECT 1 FROM social_group_memberships WHERE group_id=$1 AND user_id=$2',
        [groupA, actorB.id]
      );
      assert.equal(membership.rows.length, 0);
      await assertSiteAUnchanged();
    });

    await t.test('foreign conversation list, messages, send, and read do not cross sites', async () => {
      const list = await fetch(`${base}/api/v1/sites/${siteB}/community/conversations`, { headers });
      const listed = await list.json();
      assert.equal(list.status, 200);
      assert.ok(listed.conversations.some(conversation => conversation.id === conversationB));
      assert.equal(listed.conversations.some(conversation => conversation.id === conversationA), false);

      const messageList = await fetch(`${base}/api/v1/sites/${siteB}/community/conversations/${conversationA}/messages`, { headers });
      assert.equal(messageList.status, 404);
      assert.equal((await messageList.json()).code, 'ERR_VIRGOSCORPIO_HUB_CONVERSATION_NOT_FOUND');

      const send = await fetch(`${base}/api/v1/sites/${siteB}/community/conversations/${conversationA}/messages`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'Attempted cross-site message' }),
      });
      assert.equal(send.status, 404);
      assert.equal((await send.json()).code, 'ERR_VIRGOSCORPIO_HUB_CONVERSATION_NOT_FOUND');

      const read = await fetch(`${base}/api/v1/sites/${siteB}/community/conversations/${conversationA}/read`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(read.status, 404);
      assert.equal((await read.json()).code, 'ERR_VIRGOSCORPIO_HUB_CONVERSATION_NOT_FOUND');
      await assertSiteAUnchanged();
    });

    await t.test('foreign block and friendship targets cannot be listed, created, changed, or removed', async () => {
      const blocks = await fetch(`${base}/api/v1/sites/${siteB}/community/blocks`, { headers });
      assert.equal(blocks.status, 200);
      assert.deepEqual((await blocks.json()).blocks, []);

      const createBlock = await fetch(`${base}/api/v1/sites/${siteB}/community/blocks`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ userId: userA.id, reason: 'Cross-site block attempt' }),
      });
      assert.equal(createBlock.status, 404);
      assert.equal((await createBlock.json()).code, 'ERR_VIRGOSCORPIO_HUB_COMMUNITY_USER_NOT_FOUND');

      const removeBlock = await fetch(`${base}/api/v1/sites/${siteB}/community/blocks/${userA2.id}`, {
        method: 'DELETE',
        headers,
      });
      assert.equal(removeBlock.status, 404);
      assert.equal((await removeBlock.json()).code, 'ERR_VIRGOSCORPIO_HUB_BLOCK_NOT_FOUND');

      const friends = await fetch(`${base}/api/v1/sites/${siteB}/community/friends`, { headers });
      assert.equal(friends.status, 200);
      assert.deepEqual((await friends.json()).friendships, []);

      const createFriend = await fetch(`${base}/api/v1/sites/${siteB}/community/friends/${userA.id}`, {
        method: 'POST',
        headers,
      });
      assert.equal(createFriend.status, 404);
      assert.equal((await createFriend.json()).code, 'ERR_VIRGOSCORPIO_HUB_COMMUNITY_USER_NOT_FOUND');

      const acceptForeign = await fetch(`${base}/api/v1/sites/${siteB}/community/friends/${userA.id}`, {
        method: 'PUT',
        headers,
      });
      assert.equal(acceptForeign.status, 404);
      assert.equal((await acceptForeign.json()).code, 'ERR_VIRGOSCORPIO_HUB_FRIEND_REQUEST_NOT_FOUND');
      await assertSiteAUnchanged();
    });

    await t.test('foreign report target and review IDs cannot reveal or change site A reports', async () => {
      const reports = await fetch(`${base}/api/v1/sites/${siteB}/community/reports`, { headers });
      assert.equal(reports.status, 200);
      assert.deepEqual((await reports.json()).reports, []);

      const createReport = await fetch(`${base}/api/v1/sites/${siteB}/community/reports`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ targetType: 'user', targetId: userA.id, category: 'harassment', detail: 'Cross-site report attempt' }),
      });
      assert.equal(createReport.status, 404);
      assert.equal((await createReport.json()).code, 'ERR_VIRGOSCORPIO_HUB_REPORT_TARGET_NOT_FOUND');

      const review = await fetch(`${base}/api/v1/sites/${siteB}/community/reports/${reportA}`, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'dismissed', moderationNote: 'Cross-site review attempt' }),
      });
      assert.equal(review.status, 404);
      assert.equal((await review.json()).code, 'ERR_VIRGOSCORPIO_HUB_REPORT_NOT_FOUND');
      await assertSiteAUnchanged();
    });

    await t.test('foreign moderation IDs cannot hide site A activity or emit audit rows', async () => {
      const response = await fetch(`${base}/api/v1/sites/${siteB}/community/moderation`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ targetType: 'activity', targetId: activityA, action: 'hide', reason: 'Cross-site moderation attempt' }),
      });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, 'ERR_VIRGOSCORPIO_HUB_MODERATION_TARGET_NOT_FOUND');

      const foreignMessage = await fetch(`${base}/api/v1/sites/${siteB}/community/moderation`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ targetType: 'message', targetId: messageA, action: 'hide', reason: 'Cross-site message moderation attempt' }),
      });
      assert.equal(foreignMessage.status, 404);
      assert.equal((await foreignMessage.json()).code, 'ERR_VIRGOSCORPIO_HUB_MODERATION_TARGET_NOT_FOUND');
      await assertSiteAUnchanged();
    });

    await t.test('notification reads are bounded by both site and recipient', async () => {
      const inbox = await fetch(`${base}/api/v1/sites/${siteB}/community/notifications`, { headers });
      const inboxPayload = await inbox.json();
      assert.equal(inbox.status, 200);
      assert.ok(inboxPayload.notifications.some(item => item.id === notificationB));
      assert.equal(inboxPayload.notifications.some(item => item.id === notificationA), false);

      const readForeign = await fetch(`${base}/api/v1/sites/${siteB}/community/notifications/${notificationA}/read`, {
        method: 'POST',
        headers,
      });
      assert.equal(readForeign.status, 404);
      assert.equal((await readForeign.json()).code, 'ERR_VIRGOSCORPIO_HUB_NOTIFICATION_NOT_FOUND');

      const readAll = await fetch(`${base}/api/v1/sites/${siteB}/community/notifications/read-all`, {
        method: 'POST',
        headers,
      });
      assert.equal(readAll.status, 200);
      const states = await pool.query(
        'SELECT id,site_id,read_at FROM social_notifications WHERE id=ANY($1::uuid[]) ORDER BY site_id',
        [[notificationA, notificationB]]
      );
      const aState = states.rows.find(row => row.id === notificationA);
      const bState = states.rows.find(row => row.id === notificationB);
      assert.equal(aState.site_id, siteA);
      assert.equal(aState.read_at, null, 'site B read-all must not acknowledge a foreign site notification');
      assert.equal(bState.site_id, siteB);
      assert.ok(bState.read_at, 'site B read-all should acknowledge the site B control notification');
      await assertSiteAUnchanged();
    });

    const ownMessage = await fetch(`${base}/api/v1/sites/${siteB}/community/conversations/${conversationB}/messages`, { headers });
    assert.equal(ownMessage.status, 200, 'the actor can still read a conversation belonging to site B');
    assert.match(JSON.stringify(await ownMessage.json()), /Site B message control/);
  }
);
