'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_TYPES = new Set(['profile', 'group', 'activity', 'message', 'user']);
const REPORT_CATEGORIES = new Set(['spam', 'harassment', 'hate', 'sexual', 'violence', 'illegal', 'other']);
const REPORT_STATUSES = new Set(['open', 'reviewing', 'resolved', 'dismissed']);
const MODERATION_ACTIONS = new Set(['hide', 'restore']);
const MAX_MESSAGE_LENGTH = 10_000;
const MAX_REPORT_DETAIL_LENGTH = 4_000;
const MAX_MODERATION_REASON_LENGTH = 2_000;
const MESSAGES_PER_MINUTE = 30;
const REPORTS_PER_HOUR = 10;

function isUuid(value) { return typeof value === 'string' && UUID_RE.test(value); }
function routeError(ctx, status, code, message, details) { throw ctx.fail(status, code, message, details); }
function cleanRequiredText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLength);
}
function sitePath(pathName) { return pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/community\/(conversations|blocks|reports|notifications|moderation)(?:\/([0-9a-f-]{36}|read-all)(?:\/(messages|read))?)?$/i); }

async function requireSignedInSite(ctx, siteId, body = {}) {
  const { actor, localPool } = ctx;
  if (!localPool) routeError(ctx, 503, 'ERR_SYSTEMFABRIC_COMMUNITY_DISABLED', 'Community workflows require PostgreSQL.');
  if (!actor?.user?.id || !isUuid(actor.user.id)) routeError(ctx, 401, 'ERR_SYSTEMFABRIC_UNAUTHORIZED', 'A signed-in user account is required.');
  await ctx.siteIdFor({ req: ctx.req, url: ctx.url, body: { ...body, siteId }, actor });
}

async function assertConversationMember(client, ctx, siteId, conversationId, userId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT c.id,c.conversation_type,c.group_id
       FROM social_conversations c
       JOIN social_conversation_members m ON m.conversation_id=c.id AND m.site_id=c.site_id
      WHERE c.site_id=$1 AND c.id=$2 AND m.user_id=$3 AND m.left_at IS NULL
      ${lock ? 'FOR UPDATE OF c,m' : ''}`,
    [siteId, conversationId, userId]
  );
  if (!result.rows[0]) routeError(ctx, 404, 'ERR_SYSTEMFABRIC_CONVERSATION_NOT_FOUND', 'Conversation not found.');
  return result.rows[0];
}

async function hasBlockBetween(client, siteId, userId, otherUserId) {
  const result = await client.query(
    `SELECT 1 FROM social_blocks
      WHERE site_id=$1 AND ((blocker_id=$2 AND blocked_id=$3) OR (blocker_id=$3 AND blocked_id=$2))
      LIMIT 1`,
    [siteId, userId, otherUserId]
  );
  return Boolean(result.rows[0]);
}

async function listConversations(ctx, siteId, userId) {
  const result = await ctx.localPool.query(
    `SELECT c.id,c.conversation_type,c.group_id,c.created_at,c.updated_at,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('userId',m2.user_id,'displayName',u.display_name)
                                      ORDER BY m2.joined_at)
                        FROM social_conversation_members m2 JOIN users u ON u.id=m2.user_id
                       WHERE m2.conversation_id=c.id AND m2.site_id=c.site_id AND m2.left_at IS NULL), '[]'::jsonb) AS participants,
            last_message.body AS last_message_body,last_message.sender_id AS last_message_sender_id,
            last_message.created_at AS last_message_at,
            (SELECT count(*)::int FROM social_messages unread
              WHERE unread.site_id=c.site_id AND unread.conversation_id=c.id AND unread.deleted_at IS NULL
                AND unread.sender_id IS DISTINCT FROM $2
                AND unread.created_at > COALESCE(m.last_read_at, '-infinity'::timestamptz)) AS unread_count
       FROM social_conversations c
       JOIN social_conversation_members m ON m.conversation_id=c.id AND m.site_id=c.site_id
      LEFT JOIN LATERAL (SELECT sm.body,sm.sender_id,sm.created_at FROM social_messages sm
                          WHERE sm.site_id=c.site_id AND sm.conversation_id=c.id AND sm.deleted_at IS NULL
                          ORDER BY sm.created_at DESC LIMIT 1) last_message ON true
      WHERE c.site_id=$1 AND m.user_id=$2 AND m.left_at IS NULL
      ORDER BY COALESCE(last_message.created_at,c.updated_at) DESC LIMIT $3`,
    [siteId, userId, Math.min(100, Math.max(1, Number(ctx.url.searchParams.get('limit')) || 30))]
  );
  return ctx.sendJson(ctx.res, 200, { conversations: result.rows, requestId: ctx.requestId });
}

async function createDirectConversation(ctx, siteId, body) {
  const { localPool, actor, requestId } = ctx;
  const recipientId = body.recipientId || body.userId;
  if (!isUuid(recipientId) || recipientId === actor.user.id) {
    routeError(ctx, 400, 'ERR_SYSTEMFABRIC_CONVERSATION_RECIPIENT', 'A different, valid recipientId is required.');
  }
  const recipient = await localPool.query(
    `SELECT u.id FROM users u JOIN site_memberships sm ON sm.user_id=u.id
      WHERE sm.site_id=$1 AND u.id=$2 AND u.status='active' LIMIT 1`,
    [siteId, recipientId]
  );
  if (!recipient.rows[0]) routeError(ctx, 404, 'ERR_SYSTEMFABRIC_COMMUNITY_USER_NOT_FOUND', 'Recipient is not an active member of this site.');

  const client = await localPool.connect();
  try {
    await client.query('BEGIN');
    const pair = [actor.user.id, recipientId].sort();
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`systemfabric:direct:${siteId}:${pair.join(':')}`]);
    if (await hasBlockBetween(client, siteId, actor.user.id, recipientId)) {
      routeError(ctx, 403, 'ERR_SYSTEMFABRIC_COMMUNITY_BLOCKED', 'A conversation cannot be created between these users.');
    }
    const existing = await client.query(
      `SELECT c.id FROM social_conversations c
        WHERE c.site_id=$1 AND c.conversation_type='direct'
          AND EXISTS (SELECT 1 FROM social_conversation_members m WHERE m.site_id=c.site_id AND m.conversation_id=c.id AND m.user_id=$2 AND m.left_at IS NULL)
          AND EXISTS (SELECT 1 FROM social_conversation_members m WHERE m.site_id=c.site_id AND m.conversation_id=c.id AND m.user_id=$3 AND m.left_at IS NULL)
          AND (SELECT count(*) FROM social_conversation_members m WHERE m.site_id=c.site_id AND m.conversation_id=c.id AND m.left_at IS NULL)=2
        ORDER BY c.created_at LIMIT 1`,
      [siteId, actor.user.id, recipientId]
    );
    let conversationId = existing.rows[0]?.id;
    let created = false;
    if (!conversationId) {
      const inserted = await client.query(
        "INSERT INTO social_conversations(site_id,conversation_type,created_by) VALUES($1,'direct',$2) RETURNING id,site_id,conversation_type,group_id,created_at,updated_at",
        [siteId, actor.user.id]
      );
      conversationId = inserted.rows[0].id;
      await client.query(
        'INSERT INTO social_conversation_members(conversation_id,site_id,user_id) VALUES($1,$2,$3),($1,$2,$4)',
        [conversationId, siteId, actor.user.id, recipientId]
      );
      await client.query(
        `INSERT INTO social_notifications(site_id,user_id,notification_type,payload)
         VALUES($1,$2,'community.message.conversation_created',jsonb_build_object('conversationId',$3::text,'fromUserId',$4::text))`,
        [siteId, recipientId, conversationId, actor.user.id]
      );
      created = true;
    }
    const conversation = await client.query(
      `SELECT c.id,c.site_id,c.conversation_type,c.group_id,c.created_at,c.updated_at
         FROM social_conversations c WHERE c.site_id=$1 AND c.id=$2`,
      [siteId, conversationId]
    );
    await client.query('COMMIT');
    return ctx.sendJson(ctx.res, created ? 201 : 200, { conversation: conversation.rows[0], created, requestId });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function listMessages(ctx, siteId, conversationId) {
  const userId = ctx.actor.user.id;
  await assertConversationMember(ctx.localPool, ctx, siteId, conversationId, userId);
  await ctx.localPool.query(
    'UPDATE social_conversation_members SET last_read_at=now() WHERE site_id=$1 AND conversation_id=$2 AND user_id=$3 AND left_at IS NULL',
    [siteId, conversationId, userId]
  );
  const result = await ctx.localPool.query(
    `SELECT m.id,m.conversation_id,m.sender_id,u.display_name AS sender_name,m.body,m.status,m.created_at,m.updated_at
       FROM social_messages m LEFT JOIN users u ON u.id=m.sender_id
      WHERE m.site_id=$1 AND m.conversation_id=$2 AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC LIMIT $3`,
    [siteId, conversationId, Math.min(100, Math.max(1, Number(ctx.url.searchParams.get('limit')) || 50))]
  );
  return ctx.sendJson(ctx.res, 200, { messages: result.rows.reverse(), requestId: ctx.requestId });
}

async function createMessage(ctx, siteId, conversationId, body) {
  const content = cleanRequiredText(body.body, MAX_MESSAGE_LENGTH);
  if (!content) routeError(ctx, 400, 'ERR_SYSTEMFABRIC_MESSAGE_INVALID', 'Message body must contain 1–10000 characters.');
  const client = await ctx.localPool.connect();
  try {
    await client.query('BEGIN');
    const conversation = await assertConversationMember(client, ctx, siteId, conversationId, ctx.actor.user.id, { lock: true });
    const recipients = await client.query(
      `SELECT user_id FROM social_conversation_members
        WHERE site_id=$1 AND conversation_id=$2 AND left_at IS NULL AND user_id<>$3`,
      [siteId, conversationId, ctx.actor.user.id]
    );
    for (const recipient of recipients.rows) {
      if (await hasBlockBetween(client, siteId, ctx.actor.user.id, recipient.user_id)) {
        routeError(ctx, 403, 'ERR_SYSTEMFABRIC_COMMUNITY_BLOCKED', 'Messages are disabled between these users.');
      }
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`systemfabric:message-rate:${siteId}:${ctx.actor.user.id}`]);
    const recent = await client.query(
      `SELECT count(*)::int AS count FROM social_messages
        WHERE site_id=$1 AND sender_id=$2 AND created_at>now()-interval '1 minute' AND status IN ('sent','edited')`,
      [siteId, ctx.actor.user.id]
    );
    if (Number(recent.rows[0]?.count || 0) >= MESSAGES_PER_MINUTE) {
      routeError(ctx, 429, 'ERR_SYSTEMFABRIC_MESSAGE_RATE_LIMIT', 'Message rate limit exceeded. Try again shortly.');
    }
    const saved = await client.query(
      `INSERT INTO social_messages(site_id,conversation_id,sender_id,body)
       VALUES($1,$2,$3,$4) RETURNING id,conversation_id,sender_id,body,status,created_at,updated_at`,
      [siteId, conversationId, ctx.actor.user.id, content]
    );
    await client.query('UPDATE social_conversations SET updated_at=now() WHERE site_id=$1 AND id=$2', [siteId, conversationId]);
    for (const recipient of recipients.rows) {
      await client.query(
        `INSERT INTO social_notifications(site_id,user_id,notification_type,payload)
         VALUES($1,$2,'community.message.new',jsonb_build_object('conversationId',$3::text,'messageId',$4::text,'fromUserId',$5::text))`,
        [siteId, recipient.user_id, conversationId, saved.rows[0].id, ctx.actor.user.id]
      );
    }
    await client.query('COMMIT');
    return ctx.sendJson(ctx.res, 201, { message: saved.rows[0], requestId: ctx.requestId });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function handleBlocks(ctx, siteId, targetId, method) {
  const actorId = ctx.actor.user.id;
  if (method === 'GET' && !targetId) {
    const result = await ctx.localPool.query(
      `SELECT b.blocked_id AS user_id,u.display_name,b.reason,b.created_at
         FROM social_blocks b JOIN users u ON u.id=b.blocked_id
        WHERE b.site_id=$1 AND b.blocker_id=$2 ORDER BY b.created_at DESC LIMIT 500`,
      [siteId, actorId]
    );
    return ctx.sendJson(ctx.res, 200, { blocks: result.rows, requestId: ctx.requestId });
  }
  if (method === 'POST' && !targetId) {
    const body = await ctx.readJson(ctx.req, Math.min(ctx.maxBody || 64_000, 16_000));
    const blockedId = body.userId;
    if (!isUuid(blockedId) || blockedId === actorId) routeError(ctx, 400, 'ERR_SYSTEMFABRIC_BLOCK_INVALID', 'A different, valid userId is required.');
    const exists = await ctx.localPool.query(
      `SELECT 1 FROM site_memberships sm JOIN users u ON u.id=sm.user_id
        WHERE sm.site_id=$1 AND sm.user_id=$2 AND u.status='active' LIMIT 1`,
      [siteId, blockedId]
    );
    if (!exists.rows[0]) routeError(ctx, 404, 'ERR_SYSTEMFABRIC_COMMUNITY_USER_NOT_FOUND', 'User is not an active member of this site.');
    const reason = cleanRequiredText(body.reason, 500);
    const result = await ctx.localPool.query(
      `INSERT INTO social_blocks(site_id,blocker_id,blocked_id,reason) VALUES($1,$2,$3,$4)
       ON CONFLICT(site_id,blocker_id,blocked_id) DO UPDATE SET reason=EXCLUDED.reason
       RETURNING site_id,blocker_id,blocked_id,reason,created_at`,
      [siteId, actorId, blockedId, reason]
    );
    return ctx.sendJson(ctx.res, 201, { block: result.rows[0], requestId: ctx.requestId });
  }
  if (method === 'DELETE' && targetId) {
    if (!isUuid(targetId) || targetId === actorId) routeError(ctx, 400, 'ERR_SYSTEMFABRIC_BLOCK_INVALID', 'Blocked user ID is invalid.');
    const result = await ctx.localPool.query('DELETE FROM social_blocks WHERE site_id=$1 AND blocker_id=$2 AND blocked_id=$3 RETURNING blocked_id', [siteId, actorId, targetId]);
    if (!result.rows[0]) routeError(ctx, 404, 'ERR_SYSTEMFABRIC_BLOCK_NOT_FOUND', 'Block record not found.');
    return ctx.sendJson(ctx.res, 200, { unblocked: true, userId: targetId, requestId: ctx.requestId });
  }
  return false;
}

async function reportTargetExists(pool, siteId, type, id) {
  const queries = {
    profile: ['SELECT 1 FROM social_profiles WHERE site_id=$1 AND user_id=$2 LIMIT 1', [siteId, id]],
    group: ['SELECT 1 FROM social_groups WHERE site_id=$1 AND id=$2 LIMIT 1', [siteId, id]],
    activity: ['SELECT 1 FROM social_activities WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL LIMIT 1', [siteId, id]],
    message: ['SELECT 1 FROM social_messages WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL LIMIT 1', [siteId, id]],
    user: ["SELECT 1 FROM site_memberships sm JOIN users u ON u.id=sm.user_id WHERE sm.site_id=$1 AND sm.user_id=$2 AND u.status='active' LIMIT 1", [siteId, id]]
  };
  const [sql, params] = queries[type];
  const result = await pool.query(sql, params);
  return Boolean(result.rows[0]);
}

async function handleReports(ctx, siteId, reportId, method) {
  if (method === 'GET' && !reportId) {
    await ctx.requireCapability(ctx.actor, siteId, 'community:moderate');
    const requestedStatus = ctx.url.searchParams.get('status') || 'open';
    if (!REPORT_STATUSES.has(requestedStatus)) routeError(ctx, 400, 'ERR_SYSTEMFABRIC_REPORT_STATUS', 'Report status filter is invalid.');
    const result = await ctx.localPool.query(
      `SELECT r.id,r.reporter_id,u.display_name AS reporter_name,r.target_type,r.target_id,r.category,r.detail,r.status,r.moderation_note,r.reviewed_by,r.created_at,r.updated_at
         FROM social_reports r JOIN users u ON u.id=r.reporter_id
        WHERE r.site_id=$1 AND r.status=$2 ORDER BY r.created_at ASC LIMIT $3`,
      [siteId, requestedStatus, Math.min(200, Math.max(1, Number(ctx.url.searchParams.get('limit')) || 50))]
    );
    return ctx.sendJson(ctx.res, 200, { reports: result.rows, requestId: ctx.requestId });
  }
  if (method === 'POST' && !reportId) {
    const body = await ctx.readJson(ctx.req, Math.min(ctx.maxBody || 64_000, 16_000));
    if (!REPORT_TYPES.has(body.targetType) || !isUuid(body.targetId)) routeError(ctx, 400, 'ERR_SYSTEMFABRIC_REPORT_TARGET', 'Report targetType and targetId are invalid.');
    if (!REPORT_CATEGORIES.has(body.category)) routeError(ctx, 400, 'ERR_SYSTEMFABRIC_REPORT_CATEGORY', 'Report category is invalid.');
    const detail = cleanRequiredText(body.detail, MAX_REPORT_DETAIL_LENGTH);
    const client = await ctx.localPool.connect();
    try {
      await client.query('BEGIN');
      // Serialize rate-limit accounting by reporter so concurrent requests cannot
      // all pass the count check and exceed the documented ceiling.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`systemfabric:report-rate:${siteId}:${ctx.actor.user.id}`]);
      const prior = await client.query(
        "SELECT count(*)::int AS count FROM social_reports WHERE site_id=$1 AND reporter_id=$2 AND created_at>now()-interval '1 hour'",
        [siteId, ctx.actor.user.id]
      );
      if (Number(prior.rows[0]?.count || 0) >= REPORTS_PER_HOUR) routeError(ctx, 429, 'ERR_SYSTEMFABRIC_REPORT_RATE_LIMIT', 'Report rate limit exceeded.');
      if (!(await reportTargetExists(client, siteId, body.targetType, body.targetId))) {
        routeError(ctx, 404, 'ERR_SYSTEMFABRIC_REPORT_TARGET_NOT_FOUND', 'Reported target was not found in this site.');
      }
      const result = await client.query(
        `INSERT INTO social_reports(site_id,reporter_id,target_type,target_id,category,detail)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id,site_id,reporter_id,target_type,target_id,category,detail,status,created_at`,
        [siteId, ctx.actor.user.id, body.targetType, body.targetId, body.category, detail]
      );
      await client.query(
        `INSERT INTO social_notifications(site_id,user_id,notification_type,payload)
         SELECT DISTINCT sm.site_id,sm.user_id,'community.report.created',jsonb_build_object('reportId',$2::text)
           FROM site_memberships sm JOIN roles r ON r.id=sm.role_id
          WHERE sm.site_id=$1 AND r.capabilities @> '["community:moderate"]'::jsonb AND sm.user_id<>$3
         ON CONFLICT DO NOTHING`,
        [siteId, result.rows[0].id, ctx.actor.user.id]
      );
      await client.query('COMMIT');
      return ctx.sendJson(ctx.res, 201, { report: result.rows[0], requestId: ctx.requestId });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  if (method === 'PATCH' && reportId) {
    await ctx.requireCapability(ctx.actor, siteId, 'community:moderate');
    if (!isUuid(reportId)) routeError(ctx, 400, 'ERR_SYSTEMFABRIC_REPORT_ID', 'Report ID is invalid.');
    const body = await ctx.readJson(ctx.req, Math.min(ctx.maxBody || 64_000, 16_000));
    if (!['reviewing', 'resolved', 'dismissed'].includes(body.status)) routeError(ctx, 400, 'ERR_SYSTEMFABRIC_REPORT_STATUS', 'A report may be moved to reviewing, resolved, or dismissed.');
    const note = cleanRequiredText(body.moderationNote, MAX_REPORT_DETAIL_LENGTH);
    const client = await ctx.localPool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        'UPDATE social_reports SET status=$3,moderation_note=$4,reviewed_by=$5,updated_at=now() WHERE site_id=$1 AND id=$2 RETURNING id,site_id,reporter_id,target_type,target_id,category,detail,status,moderation_note,reviewed_by,updated_at',
        [siteId, reportId, body.status, note, ctx.actor.user.id]
      );
      if (!updated.rows[0]) routeError(ctx, 404, 'ERR_SYSTEMFABRIC_REPORT_NOT_FOUND', 'Report not found.');
      if (body.status === 'dismissed') {
        await client.query(
          "INSERT INTO systemfabric_moderation_actions(site_id,actor_id,target_type,target_id,action,reason) VALUES($1,$2,'report',$3,'dismiss_report',$4)",
          [siteId, ctx.actor.user.id, reportId, note]
        );
      }
      await client.query('COMMIT');
      return ctx.sendJson(ctx.res, 200, { report: updated.rows[0], requestId: ctx.requestId });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return false;
}

async function handleModeration(ctx, siteId) {
  await ctx.requireCapability(ctx.actor, siteId, 'community:moderate');
  if (ctx.req.method !== 'POST') return false;
  const body = await ctx.readJson(ctx.req, Math.min(ctx.maxBody || 64_000, 16_000));
  if (!['activity', 'message'].includes(body.targetType) || !isUuid(body.targetId) || !MODERATION_ACTIONS.has(body.action)) {
    routeError(ctx, 400, 'ERR_SYSTEMFABRIC_MODERATION_ACTION', 'Only hide/restore actions on an activity or message are currently supported.');
  }
  const reason = cleanRequiredText(body.reason, MAX_MODERATION_REASON_LENGTH);
  const client = await ctx.localPool.connect();
  try {
    await client.query('BEGIN');
    let result;
    if (body.targetType === 'activity') {
      result = await client.query(
        `UPDATE social_activities SET deleted_at=${body.action === 'hide' ? 'now()' : 'NULL'} WHERE site_id=$1 AND id=$2
         RETURNING id,site_id,actor_id,deleted_at`,
        [siteId, body.targetId]
      );
    } else {
      result = await client.query(
        `UPDATE social_messages SET deleted_at=${body.action === 'hide' ? 'now()' : 'NULL'},status=$3,updated_at=now()
          WHERE site_id=$1 AND id=$2 RETURNING id,site_id,conversation_id,sender_id,deleted_at,status`,
        [siteId, body.targetId, body.action === 'hide' ? 'moderated' : 'sent']
      );
    }
    if (!result.rows[0]) routeError(ctx, 404, 'ERR_SYSTEMFABRIC_MODERATION_TARGET_NOT_FOUND', 'Moderation target was not found.');
    await client.query(
      'INSERT INTO systemfabric_moderation_actions(site_id,actor_id,target_type,target_id,action,reason) VALUES($1,$2,$3,$4,$5,$6)',
      [siteId, ctx.actor.user.id, body.targetType, body.targetId, body.action, reason]
    );
    await client.query('COMMIT');
    return ctx.sendJson(ctx.res, 200, { moderation: { targetType: body.targetType, targetId: body.targetId, action: body.action, target: result.rows[0] }, requestId: ctx.requestId });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function handleNotifications(ctx, siteId, notificationId, action, method) {
  const userId = ctx.actor.user.id;
  if (method === 'GET' && !notificationId) {
    const result = await ctx.localPool.query(
      `SELECT id,notification_type,payload,read_at,created_at FROM social_notifications
        WHERE site_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT $3`,
      [siteId, userId, Math.min(100, Math.max(1, Number(ctx.url.searchParams.get('limit')) || 50))]
    );
    const unread = await ctx.localPool.query('SELECT count(*)::int AS count FROM social_notifications WHERE site_id=$1 AND user_id=$2 AND read_at IS NULL', [siteId, userId]);
    return ctx.sendJson(ctx.res, 200, { notifications: result.rows, unreadCount: Number(unread.rows[0]?.count || 0), requestId: ctx.requestId });
  }
  if (method === 'POST' && action === 'read-all' && !notificationId) {
    const result = await ctx.localPool.query('UPDATE social_notifications SET read_at=now() WHERE site_id=$1 AND user_id=$2 AND read_at IS NULL RETURNING id', [siteId, userId]);
    return ctx.sendJson(ctx.res, 200, { markedRead: result.rows.length, requestId: ctx.requestId });
  }
  if (method === 'POST' && action === 'read' && notificationId) {
    if (!isUuid(notificationId)) routeError(ctx, 400, 'ERR_SYSTEMFABRIC_NOTIFICATION_ID', 'Notification ID is invalid.');
    const result = await ctx.localPool.query('UPDATE social_notifications SET read_at=COALESCE(read_at,now()) WHERE site_id=$1 AND user_id=$2 AND id=$3 RETURNING id,read_at', [siteId, userId, notificationId]);
    if (!result.rows[0]) routeError(ctx, 404, 'ERR_SYSTEMFABRIC_NOTIFICATION_NOT_FOUND', 'Notification not found.');
    return ctx.sendJson(ctx.res, 200, { notification: result.rows[0], requestId: ctx.requestId });
  }
  return false;
}

async function handleCommunityWorkflowRoute(ctx) {
  const matched = sitePath(ctx.url.pathname);
  if (!matched) return false;
  const [, siteId, area, itemId, subaction] = matched;
  const method = ctx.req.method;
  const pathBody = ['POST', 'PATCH'].includes(method) ? null : {};
  await requireSignedInSite(ctx, siteId, pathBody || {});

  if (area === 'conversations') {
    if (!itemId && method === 'GET') return listConversations(ctx, siteId, ctx.actor.user.id);
    if (!itemId && method === 'POST') return createDirectConversation(ctx, siteId, await ctx.readJson(ctx.req, Math.min(ctx.maxBody || 64_000, 16_000)));
    if (itemId && subaction === 'messages' && method === 'GET') return listMessages(ctx, siteId, itemId);
    if (itemId && subaction === 'messages' && method === 'POST') return createMessage(ctx, siteId, itemId, await ctx.readJson(ctx.req, Math.min(ctx.maxBody || 64_000, 16_000)));
    if (itemId && subaction === 'read' && method === 'POST') {
      const result = await ctx.localPool.query('UPDATE social_conversation_members SET last_read_at=now() WHERE site_id=$1 AND conversation_id=$2 AND user_id=$3 AND left_at IS NULL RETURNING conversation_id,last_read_at', [siteId, itemId, ctx.actor.user.id]);
      if (!result.rows[0]) routeError(ctx, 404, 'ERR_SYSTEMFABRIC_CONVERSATION_NOT_FOUND', 'Conversation not found.');
      await ctx.localPool.query("UPDATE social_notifications SET read_at=COALESCE(read_at,now()) WHERE site_id=$1 AND user_id=$2 AND read_at IS NULL AND payload->>'conversationId'=$3", [siteId, ctx.actor.user.id, itemId]);
      return ctx.sendJson(ctx.res, 200, { conversationRead: result.rows[0], requestId: ctx.requestId });
    }
    return false;
  }
  if (area === 'blocks') return handleBlocks(ctx, siteId, itemId, method);
  if (area === 'reports') return handleReports(ctx, siteId, itemId, method);
  if (area === 'notifications') {
    const action = ctx.url.pathname.endsWith('/read-all') ? 'read-all' : subaction;
    if (action === 'read-all') {
      if (method !== 'POST') return false;
      const result = await ctx.localPool.query('UPDATE social_notifications SET read_at=now() WHERE site_id=$1 AND user_id=$2 AND read_at IS NULL RETURNING id', [siteId, ctx.actor.user.id]);
      return ctx.sendJson(ctx.res, 200, { markedRead: result.rows.length, requestId: ctx.requestId });
    }
    return handleNotifications(ctx, siteId, itemId, action, method);
  }
  if (area === 'moderation') return handleModeration(ctx, siteId);
  return false;
}

module.exports = {
  handleCommunityWorkflowRoute,
  isUuid,
  cleanRequiredText,
  constants: { MAX_MESSAGE_LENGTH, MAX_REPORT_DETAIL_LENGTH, MESSAGES_PER_MINUTE, REPORTS_PER_HOUR }
};
