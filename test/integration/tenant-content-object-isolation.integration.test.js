'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPostgresPool, createPostgresStore } = require('../../packages/db/src/postgres-store');
const { createIdentityService, hashPassword } = require('../../packages/auth/src/service');
const { createApiServer } = require('../../apps/api/src/server');

const enabled = Boolean(
  process.env.DATABASE_URL &&
  process.env.VIRGOSCORPIO_HUB_RUN_POSTGRES_INTEGRATION === 'true'
);

async function contentSideEffects(pool, siteId, contentId) {
  const result = await pool.query(
    `SELECT ci.status, ci.version, ci.lock_version,
       (SELECT count(*)::int FROM content_revisions r WHERE r.content_id=ci.id) AS revision_count,
       (SELECT count(*)::int FROM workflow_events w WHERE w.site_id=ci.site_id AND w.content_id=ci.id) AS workflow_count,
       (SELECT count(*)::int FROM outbox_events o WHERE o.site_id=ci.site_id AND o.aggregate_id=ci.id) AS outbox_count,
       (SELECT count(*)::int FROM content_collaboration_documents d WHERE d.content_id=ci.id) AS collaboration_document_count,
       (SELECT count(*)::int FROM content_collaboration_operations op WHERE op.content_id=ci.id) AS collaboration_operation_count
       FROM content_items ci
       WHERE ci.site_id=$1 AND ci.id=$2 AND ci.deleted_at IS NULL`,
    [siteId, contentId]
  );
  return result.rows[0] || null;
}

test(
  'tenant isolation: a site B member cannot read, restore, publish, or collaborate on a site A content ID',
  { skip: !enabled },
  async t => {
    const pool = createPostgresPool({
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_POOL_MAX: '8',
    });
    const store = createPostgresStore({ pool });
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
      [`tenant-object-a-${randomUUID().slice(0, 8)}`, 'Tenant Object Site A']
    );
    const siteA = siteAResult.rows[0].id;
    siteIds.push(siteA);

    const siteBResult = await pool.query(
      'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
      [`tenant-object-b-${randomUUID().slice(0, 8)}`, 'Tenant Object Site B']
    );
    const siteB = siteBResult.rows[0].id;
    siteIds.push(siteB);

    const roleResult = await pool.query(
      'INSERT INTO roles(slug,label,capabilities) VALUES($1,$2,$3::jsonb) RETURNING id',
      [`tenant-object-${randomUUID().slice(0, 10)}`, 'Tenant Object Test Administrator', JSON.stringify(['*'])]
    );
    roleId = roleResult.rows[0].id;

    const password = 'Isolation-Password-2026';
    const actorResult = await pool.query(
      `INSERT INTO users(email,display_name,password_hash,status)
       VALUES($1,$2,$3,'active') RETURNING id,email`,
      [`tenant-object-actor-${randomUUID()}@example.test`, 'Site B Actor', await hashPassword(password)]
    );
    const actor = actorResult.rows[0];
    userIds.push(actor.id);

    const authorResult = await pool.query(
      `INSERT INTO users(email,display_name,status)
       VALUES($1,$2,'active') RETURNING id`,
      [`tenant-object-author-${randomUUID()}@example.test`, 'Site A Author']
    );
    const authorId = authorResult.rows[0].id;
    userIds.push(authorId);

    // The actor belongs only to B; the foreign content and its author belong to A.
    await pool.query(
      'INSERT INTO site_memberships(site_id,user_id,role_id) VALUES($1,$2,$3)',
      [siteB, actor.id, roleId]
    );

    const document = {
      schemaVersion: 1,
      documentId: randomUUID(),
      type: 'page',
      title: 'Private Site A Draft',
      children: [{
        id: 'heading-private',
        type: 'widget.heading',
        props: { text: 'Site A only' },
        children: [],
      }],
    };
    const foreignContent = await store.saveDraft({
      siteId: siteA,
      title: 'Private Site A Draft',
      slug: `private-site-a-${randomUUID().slice(0, 8)}`,
      locale: 'en',
      contentType: 'page',
      document,
      authorId,
      note: 'tenant object isolation fixture',
    });

    const ownDocument = {
      schemaVersion: 1,
      documentId: randomUUID(),
      type: 'page',
      title: 'Site B Control Draft',
      children: [],
    };
    const ownContent = await store.saveDraft({
      siteId: siteB,
      title: 'Site B Control Draft',
      slug: `site-b-control-${randomUUID().slice(0, 8)}`,
      locale: 'en',
      contentType: 'page',
      document: ownDocument,
      authorId: actor.id,
      note: 'positive control',
    });

    const ownContentTarget = await store.saveDraft({
      siteId: siteB,
      title: 'Site B Relationship Target',
      slug: 'site-b-relationship-target-' + randomUUID().slice(0, 8),
      locale: 'en',
      contentType: 'page',
      document: {
        schemaVersion: 1,
        documentId: randomUUID(),
        type: 'page',
        title: 'Site B Relationship Target',
        children: [],
      },
      authorId: actor.id,
      note: 'relationship positive control',
    });
    const session = await identity.login({
      email: actor.email,
      password,
      ip: '127.0.0.1',
      userAgent: 'tenant-object-isolation-test',
    });
    assert.equal(session.mfaRequired, false);

    server = createApiServer({
      env,
      pool,
      contentStore: store,
      identityService: identity,
      logger: { error() {} },
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { authorization: `Bearer ${session.token}`, 'x-virgoscorpio-hub-site-id': siteB };
    const before = await contentSideEffects(pool, siteA, foreignContent.id);
    assert.ok(before, 'site A fixture must exist before adversarial requests');
    await t.test('relationship endpoints must belong to the selected site and valid same-site relationships still work', async () => {
      const foreignEndpoints = [
        { sourceId: ownContent.id, targetId: foreignContent.id },
        { sourceId: foreignContent.id, targetId: ownContent.id },
      ];

      for (const endpoints of foreignEndpoints) {
        const response = await fetch(base + '/api/v1/sites/' + siteB + '/relationships', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ ...endpoints, kind: 'RELATED_TO' }),
        });
        const payload = await response.json();
        assert.equal(response.status, 404);
        assert.equal(payload.code, 'ERR_VIRGOSCORPIO_HUB_RELATIONSHIP_ENDPOINT_NOT_FOUND');
        assert.doesNotMatch(JSON.stringify(payload), /Private Site A Draft|Site A only/);

        const persisted = await pool.query(
          'SELECT id FROM content_relationships WHERE site_id=$1 AND source_id=$2 AND target_id=$3 AND kind=$4 AND deleted_at IS NULL',
          [siteB, endpoints.sourceId, endpoints.targetId, 'RELATED_TO']
        );
        assert.equal(persisted.rowCount, 0, 'foreign relationship attempts must not persist');
      }

      try {
        const validResponse = await fetch(base + '/api/v1/sites/' + siteB + '/relationships', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            siteId: siteB,
            sourceId: ownContent.id,
            targetId: ownContentTarget.id,
            kind: 'RELATED_TO',
          }),
        });
        const validPayload = await validResponse.json();
        assert.equal(validResponse.status, 201, 'same-site relationship creation remains available');
        assert.equal(validPayload.relationship.site_id, siteB);
        assert.equal(validPayload.relationship.source_id, ownContent.id);
        assert.equal(validPayload.relationship.target_id, ownContentTarget.id);
        const upsertEvent = await pool.query(
          "SELECT site_id,classification,payload->>'siteId' AS payload_site_id FROM outbox_events WHERE aggregate_type=$1 AND aggregate_id=$2 AND event_type=$3",
          ['relationship', validPayload.relationship.id, 'relationship.upsert']
        );
        assert.equal(upsertEvent.rowCount, 1);
        assert.equal(upsertEvent.rows[0].site_id, siteB);
        assert.equal(upsertEvent.rows[0].classification, 'site-private');
        assert.equal(upsertEvent.rows[0].payload_site_id, siteB);

        const deleteResponse = await fetch(base + '/api/v1/sites/' + siteB + '/relationships/' + validPayload.relationship.id, {
          method: 'DELETE',
          headers,
        });
        assert.equal(deleteResponse.status, 200, 'same-site relationship deletion remains available');
        const deleteEvent = await pool.query(
          "SELECT site_id,classification,payload->>'siteId' AS payload_site_id FROM outbox_events WHERE aggregate_type=$1 AND aggregate_id=$2 AND event_type=$3",
          ['relationship', validPayload.relationship.id, 'relationship.delete']
        );
        assert.equal(deleteEvent.rowCount, 1);
        assert.equal(deleteEvent.rows[0].site_id, siteB);
        assert.equal(deleteEvent.rows[0].classification, 'site-private');
        assert.equal(deleteEvent.rows[0].payload_site_id, siteB);
      } finally {
        // The route emits a durable outbox event. Remove only this fixture's
        // relationship and matching event so later outage/replay tests retain
        // their empty-queue precondition.
        const created = await pool.query(
          'SELECT id FROM content_relationships WHERE site_id=$1 AND source_id=$2 AND target_id=$3 AND kind=$4',
          [siteB, ownContent.id, ownContentTarget.id, 'RELATED_TO']
        );
        const relationshipIds = created.rows.map(row => row.id);
        if (relationshipIds.length) {
          await pool.query(
            'DELETE FROM outbox_events WHERE aggregate_type=$1 AND aggregate_id=ANY($2::uuid[]) AND event_type=ANY($3::text[])',
            ['relationship', relationshipIds, ['relationship.upsert', 'relationship.delete']]
          );
          await pool.query(
            'DELETE FROM content_relationships WHERE site_id=$1 AND id=ANY($2::uuid[])',
            [siteB, relationshipIds]
          );
        }
      }
    });

    const cases = [
      {
        name: 'page read',
        method: 'GET',
        path: `/api/v1/pages/${foreignContent.id}`,
        status: 404,
        body: null,
      },
      {
        name: 'revision history read',
        method: 'GET',
        path: `/api/v1/pages/${foreignContent.id}/revisions`,
        status: 404,
        body: null,
      },
      {
        name: 'collaboration sync read',
        method: 'GET',
        path: `/api/v1/pages/${foreignContent.id}/collaboration/sync?afterSequence=0`,
        status: 404,
        body: null,
      },
      {
        name: 'collaboration operation write',
        method: 'POST',
        path: `/api/v1/pages/${foreignContent.id}/collaboration/operations`,
        status: 404,
        body: { operation: {} },
      },
      {
        name: 'revision restore write',
        method: 'POST',
        path: `/api/v1/pages/${foreignContent.id}/restore/1`,
        status: 404,
        body: { expectedVersion: 1 },
      },
      {
        name: 'publish workflow write',
        method: 'POST',
        path: `/api/v1/pages/${foreignContent.id}/publish`,
        status: 404,
        body: { expectedVersion: 1 },
      },
    ];

    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        const response = await fetch(base + scenario.path, {
          method: scenario.method,
          headers: scenario.body
            ? { ...headers, 'content-type': 'application/json' }
            : headers,
          ...(scenario.body ? { body: JSON.stringify(scenario.body) } : {}),
        });
        const payload = await response.json();
        assert.equal(response.status, scenario.status, 'foreign object IDs must be scoped to the selected site');
        assert.ok(
          payload.code === 'ERR_VIRGOSCORPIO_HUB_CONTENT_NOT_FOUND' ||
          payload.code === 'ERR_VIRGOSCORPIO_HUB_REVISION_NOT_FOUND',
          'a foreign object must be indistinguishable from an absent object in the selected site'
        );
        assert.doesNotMatch(JSON.stringify(payload), /Private Site A Draft|Site A only/);
        assert.deepEqual(
          await contentSideEffects(pool, siteA, foreignContent.id),
          before,
          'denied foreign-object requests must not mutate content, revisions, workflow, outbox, or collaboration state'
        );
      });
    }

    const ownRead = await fetch(base + `/api/v1/pages/${ownContent.id}`, { headers });
    assert.equal(ownRead.status, 200, 'the actor must still be able to read content in site B');
    const ownPayload = await ownRead.json();
    assert.equal(ownPayload.content.id, ownContent.id);
    assert.equal(ownPayload.content.site_id, siteB);

    assert.equal(await store.getById({ siteId: siteA, id: foreignContent.id }) !== null, true);
    assert.equal(await store.getById({ siteId: siteB, id: foreignContent.id }), null);
  }
);
