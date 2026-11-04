'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPostgresStore } = require('../packages/db/src/postgres-store');

test('owner-scoped content lookup binds site, content ID, owner, and deletion state in SQL', async () => {
  const calls = [];
  const row = {
    id: '33333333-3333-4333-8333-333333333333',
    site_id: '11111111-1111-4111-8111-111111111111',
    created_by: '22222222-2222-4222-8222-222222222222',
    content_type: 'page'
  };
  const store = createPostgresStore({
    pool: {
      async query(sql, values) {
        calls.push({ sql, values });
        return { rows: [row] };
      }
    }
  });

  const result = await store.getByIdForOwner({
    siteId: row.site_id,
    id: row.id,
    actorId: row.created_by
  });

  assert.equal(result, row);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE site_id=\$1 AND id=\$2 AND created_by=\$3 AND deleted_at IS NULL/);
  assert.deepEqual(calls[0].values, [row.site_id, row.id, row.created_by]);
});
