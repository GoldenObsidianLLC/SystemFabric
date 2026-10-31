'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createPostgresStore } = require('../../packages/db/src/postgres-store');

function dedicatedTestDatabaseUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = new URL(value);
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    return ['localhost', '127.0.0.1', '::1', 'postgres'].includes(parsed.hostname.toLowerCase())
      && /(?:[_-])test$/i.test(database);
  } catch {
    return false;
  }
}

const databaseUrl = process.env.TEST_DATABASE_URL || '';
const enabled = process.env.SYSTEMFABRIC_RUN_POSTGRES_INTEGRATION === 'true'
  && dedicatedTestDatabaseUrl(databaseUrl);

test('PostgreSQL collaboration operations are atomic, idempotent, sequenced, and draft-only', {
  skip: !enabled
}, async t => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 4000 });
  const store = createPostgresStore({ pool });
  const siteAResult = await pool.query(
    'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
    [`collab-a-${randomUUID().slice(0, 8)}`, 'Collaboration Test Site A']
  );
  const siteBResult = await pool.query(
    'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
    [`collab-b-${randomUUID().slice(0, 8)}`, 'Collaboration Test Site B']
  );
  const authorResult = await pool.query(
    'INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id',
    [`collab-author-${randomUUID()}@example.test`, 'Collaboration Test Author']
  );
  const siteA = siteAResult.rows[0].id;
  const siteB = siteBResult.rows[0].id;
  const authorId = authorResult.rows[0].id;
  const headingId = 'collab-heading';
  const document = {
    schemaVersion: 1,
    documentId: 'collaboration-test',
    type: 'page',
    title: 'Collaborative Draft',
    children: [{
      id: 'collab-section',
      type: 'section',
      props: {},
      children: [{
        id: headingId,
        type: 'widget.heading',
        props: { text: 'Starting title', level: 1 },
        children: []
      }]
    }]
  };
  let saved;
  try {
    saved = await store.saveDraft({
      siteId: siteA,
      title: document.title,
      slug: `collab-${randomUUID().slice(0, 10)}`,
      locale: 'en',
      contentType: 'page',
      document,
      authorId,
      note: 'F1.9 collaboration fixture'
    });

    t.after(async () => {
      await pool.query('DELETE FROM sites WHERE id=ANY($1::uuid[])', [[siteA, siteB]]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id=$1', [authorId]).catch(() => {});
      await pool.end();
    });

    const opIdA = randomUUID();
    const opIdB = randomUUID();
    const firstOperation = {
      schemaVersion: 1, opId: opIdA, clientId: 'browser-a', baseSequence: 0,
      type: 'node.set_prop', payload: { nodeId: headingId, key: 'level', value: 2 }
    };
    const secondOperation = {
      schemaVersion: 1, opId: opIdB, clientId: 'browser-b', baseSequence: 0,
      type: 'node.set_prop', payload: { nodeId: headingId, key: 'text', value: 'Converged title' }
    };

    const first = await store.applyCollaborationOperation({
      siteId: siteA, contentId: saved.id, actorId: authorId, operation: firstOperation
    });
    assert.equal(first.sequence, 1);
    assert.equal(first.version, saved.version + 1);
    assert.equal(first.duplicate, false);

    const retry = await store.applyCollaborationOperation({
      siteId: siteA, contentId: saved.id, actorId: authorId, operation: firstOperation
    });
    assert.equal(retry.sequence, 1);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.operation.payload.key, 'level', 'a retained duplicate returns the exact server-applied operation');

    await assert.rejects(
      store.applyCollaborationOperation({
        siteId: siteA, contentId: saved.id, actorId: authorId,
        operation: { ...firstOperation, payload: { ...firstOperation.payload, value: 3 } }
      }),
      error => error.code === 'ERR_SYSTEMFABRIC_COLLABORATION_OP_ID_REUSE'
    );

    const second = await store.applyCollaborationOperation({
      siteId: siteA, contentId: saved.id, actorId: authorId, operation: secondOperation
    });
    assert.equal(second.sequence, 2);
    const afterConcurrent = await store.getById({ siteId: siteA, id: saved.id });
    assert.equal(afterConcurrent.body.children[0].children[0].props.level, 2);
    assert.equal(afterConcurrent.body.children[0].children[0].props.text, 'Converged title');
    assert.equal(afterConcurrent.published_snapshot, null);

    const sync = await store.getCollaborationSync({
      siteId: siteA, contentId: saved.id, afterSequence: 0
    });
    assert.equal(sync.reloadRequired, false);
    assert.equal(sync.sequence, 2);
    assert.equal(sync.operations.length, 2);

    await assert.rejects(
      store.getCollaborationSync({ siteId: siteB, contentId: saved.id, afterSequence: 0 }),
      error => error.code === 'ERR_SYSTEMFABRIC_CONTENT_NOT_FOUND'
    );

    // Seed a full replay window to exercise the exact pruning boundary without
    // submitting 1,000 HTTP requests. This is isolated test-database fixture data.
    await pool.query('DELETE FROM content_collaboration_operations WHERE content_id=$1', [saved.id]);
    await pool.query(
      'UPDATE content_collaboration_documents SET sequence=1000,oldest_replay_sequence=0 WHERE content_id=$1',
      [saved.id]
    );
    await pool.query(
      `INSERT INTO content_collaboration_operations(
         content_id,sequence,op_id,actor_id,client_id,original_operation,applied_operation,result
       )
       SELECT $1,
              n,
              ('00000000-0000-4000-8000-' || lpad(to_hex(n),12,'0'))::uuid,
              $2,
              'history-seed',
              jsonb_build_object('schemaVersion',1,'opId',('00000000-0000-4000-8000-' || lpad(to_hex(n),12,'0')),'clientId','history-seed','baseSequence',n-1,'type','document.set_title','payload',jsonb_build_object('title','Seed ' || n)),
              jsonb_build_object('schemaVersion',1,'opId',('00000000-0000-4000-8000-' || lpad(to_hex(n),12,'0')),'clientId','history-seed','baseSequence',n-1,'type','document.set_title','payload',jsonb_build_object('title','Seed ' || n)),
              jsonb_build_object('sequence',n)
         FROM generate_series(1,1000) AS series(n)`,
      [saved.id, authorId]
    );
    const finalOperation = {
      schemaVersion: 1, opId: randomUUID(), clientId: 'browser-a', baseSequence: 1000,
      type: 'document.set_title', payload: { title: 'After compaction' }
    };
    const compacted = await store.applyCollaborationOperation({
      siteId: siteA, contentId: saved.id, actorId: authorId, operation: finalOperation
    });
    assert.equal(compacted.sequence, 1001);
    assert.equal(compacted.oldestReplaySequence, 1);
    const prunedRetry = await store.applyCollaborationOperation({
      siteId: siteA, contentId: saved.id, actorId: authorId, operation: firstOperation
    });
    assert.equal(prunedRetry.sequence, 1001);
    assert.equal(prunedRetry.reloadRequired, true, 'a pruned idempotency tombstone requires canonical reload instead of a partial acknowledgement');
    assert.equal(prunedRetry.duplicate, true, 'idempotency keys must outlive pruned replay operations');
    assert.equal(prunedRetry.document.title, 'After compaction');
    const retained = await pool.query(
      'SELECT count(*)::int AS count,min(sequence)::int AS min,max(sequence)::int AS max FROM content_collaboration_operations WHERE content_id=$1',
      [saved.id]
    );
    assert.deepEqual(retained.rows[0], { count: 1000, min: 2, max: 1001 });

    const expired = await store.getCollaborationSync({
      siteId: siteA, contentId: saved.id, afterSequence: 0
    });
    assert.equal(expired.reloadRequired, true);
    assert.equal(expired.sequence, 1001);
    assert.equal(expired.document.title, 'After compaction');

    const replay = await store.getCollaborationSync({
      siteId: siteA, contentId: saved.id, afterSequence: 1
    });
    assert.equal(replay.reloadRequired, false);
    assert.equal(replay.operations.length, 1000);

    const beforeWholeSave = await store.getById({ siteId: siteA, id: saved.id });
    const wholeSave = await store.saveDraft({
      siteId: siteA,
      id: saved.id,
      title: beforeWholeSave.title,
      slug: beforeWholeSave.slug,
      locale: beforeWholeSave.locale,
      contentType: beforeWholeSave.content_type,
      document: beforeWholeSave.body,
      authorId,
      expectedVersion: beforeWholeSave.version,
      note: 'ordinary whole-document edit establishes a collaboration checkpoint'
    });
    const checkpointAfterSave = await store.getCollaborationSync({
      siteId: siteA, contentId: saved.id, afterSequence: 1001
    });
    assert.equal(checkpointAfterSave.reloadRequired, true);
    assert.equal(checkpointAfterSave.sequence, 1002);
    const oldRetryAfterCheckpoint = await store.applyCollaborationOperation({
      siteId: siteA, contentId: saved.id, actorId: authorId, operation: firstOperation
    });
    assert.equal(oldRetryAfterCheckpoint.reloadRequired, true, 'checkpoint invalidates op-id keys from the previous editing generation');

    const submitted = await store.submitForReview({
      siteId: siteA, id: saved.id, actorId: authorId, expectedVersion: wholeSave.version
    });
    await assert.rejects(
      store.applyCollaborationOperation({
        siteId: siteA, contentId: saved.id, actorId: authorId,
        operation: { ...finalOperation, opId: randomUUID(), baseSequence: 1002 }
      }),
      error => error.code === 'ERR_SYSTEMFABRIC_COLLABORATION_NOT_DRAFT'
    );

    const restored = await store.rejectReview({
      siteId: siteA, id: saved.id, actorId: authorId, expectedVersion: submitted.version
    });
    const checkpoint = await store.getCollaborationSync({
      siteId: siteA, contentId: saved.id, afterSequence: 1002
    });
    assert.equal(checkpoint.reloadRequired, true);
    assert.equal(checkpoint.sequence, 1003);
    assert.equal(checkpoint.document.title, 'After compaction');

    const submittedAgain = await store.submitForReview({
      siteId: siteA, id: saved.id, actorId: authorId, expectedVersion: restored.version
    });
    const approved = await store.approve({
      siteId: siteA, id: saved.id, actorId: authorId, expectedVersion: submittedAgain.version
    });
    const published = await store.publishContent({
      siteId: siteA, id: saved.id, actorId: authorId, expectedVersion: approved.version
    });
    assert.equal(published.status, 'published');
    const publishedRow = await store.getById({ siteId: siteA, id: saved.id });
    assert.equal(publishedRow.published_snapshot.document.title, 'After compaction');
    assert.equal(publishedRow.published_snapshot.document.children[0].children[0].props.text, 'Converged title');
    assert.equal(publishedRow.published_snapshot.document.children[0].children[0].props.level, 2);

    const revisionCount = await pool.query(
      'SELECT count(*)::int AS count FROM content_revisions WHERE content_id=$1',
      [saved.id]
    );
    assert.equal(revisionCount.rows[0].count, 5);
    const workflowCount = await pool.query(
      "SELECT count(*)::int AS count FROM workflow_events WHERE content_id=$1 AND action='collaboration_operation'",
      [saved.id]
    );
    assert.equal(workflowCount.rows[0].count, 3);
    const outboxCount = await pool.query(
      "SELECT count(*)::int AS count FROM outbox_events WHERE aggregate_id=$1 AND event_type='content.upsert'",
      [saved.id]
    );
    assert.equal(outboxCount.rows[0].count, 5);
  } finally {
    // Cleanup registered after the fixture IDs are created. In setup failures,
    // remove any partially-created fixture rows before closing the pool.
    if (!saved) {
      await pool.query('DELETE FROM sites WHERE id=ANY($1::uuid[])', [[siteA, siteB]]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id=$1', [authorId]).catch(() => {});
      await pool.end();
    }
  }
});
