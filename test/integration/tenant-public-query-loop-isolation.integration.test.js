'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPostgresPool } = require('../../packages/db/src/postgres-store');
const { createIdentityService } = require('../../packages/auth/src/service');
const { createApiServer } = require('../../apps/api/src/server');

const enabled = Boolean(
  process.env.DATABASE_URL &&
  process.env.VIRGOSCORPIO_HUB_RUN_POSTGRES_INTEGRATION === 'true'
);

test(
  'tenant isolation: public page query loops render only the selected site published posts',
  { skip: !enabled },
  async t => {
    const pool = createPostgresPool({
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_POOL_MAX: '6',
    });
    const siteIds = [];
    let server = null;

    const env = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL,
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
      await pool.end();
    });

    const createSite = async label => {
      const result = await pool.query(
        'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id,slug',
        ['query-loop-' + label + '-' + randomUUID().slice(0, 8), 'Query Loop ' + label]
      );
      siteIds.push(result.rows[0].id);
      return result.rows[0];
    };
    const siteA = await createSite('alpha');
    const siteB = await createSite('bravo');

    const insertContent = async ({ siteId, contentType, slug, title, status, document, published, deleted = false }) => {
      const snapshot = published
        ? JSON.stringify({
          title,
          slug,
          locale: 'en',
          contentType,
          status: 'published',
          document,
          version: 1,
        })
        : null;
      const body = JSON.stringify(document || { schemaVersion: 1, children: [] });
      const result = await pool.query(
        'INSERT INTO content_items(site_id,content_type,slug,locale,title,status,body,' +
        'published_snapshot,published_version,published_at,published_search_vector,deleted_at) ' +
        'VALUES($1,$2,$3,\'en\',$4,$5,$6::jsonb,$7::jsonb,' +
        'CASE WHEN $7::jsonb IS NULL THEN NULL ELSE 1 END,' +
        'CASE WHEN $7::jsonb IS NULL THEN NULL ELSE now() END,' +
        'to_tsvector(\'simple\',$4 || \' \' || $3),CASE WHEN $8 THEN now() ELSE NULL END) ' +
        'RETURNING id,slug,status',
        [siteId, contentType, slug, title, status, body, snapshot, deleted]
      );
      return result.rows[0];
    };

    const createPage = async (site, heading) => {
      const slug = 'latest-articles';
      const pageDocument = {
        schemaVersion: 1,
        documentId: 'query-page-' + randomUUID(),
        type: 'page',
        title: heading,
        children: [
          {
            id: 'page-heading',
            type: 'widget.heading',
            props: { text: heading, level: 1 },
            children: [],
          },
          {
            id: 'query-loop-1',
            type: 'widget.query-loop',
            props: {
              source: 'latest-published',
              contentType: 'post',
              limit: 12,
              columns: 1,
              emptyText: 'No published posts.',
            },
            children: [],
          },
        ],
      };
      await insertContent({
        siteId: site.id,
        contentType: 'page',
        slug,
        title: heading,
        status: 'published',
        document: pageDocument,
        published: true,
      });
      return slug;
    };

    const pageSlugA = await createPage(siteA, 'SITE_ALPHA_QUERY_PAGE');
    const pageSlugB = await createPage(siteB, 'SITE_BRAVO_QUERY_PAGE');

    const postA = await insertContent({
      siteId: siteA.id,
      contentType: 'post',
      slug: 'alpha-post-' + randomUUID().slice(0, 8),
      title: 'SITE_ALPHA_PUBLISHED_POST',
      status: 'published',
      document: {
        schemaVersion: 1,
        documentId: 'alpha-post-doc',
        type: 'page',
        title: 'SITE_ALPHA_PUBLISHED_POST',
        children: [{ id: 'alpha-text', type: 'widget.text', props: { text: 'Alpha excerpt.' }, children: [] }],
      },
      published: true,
    });
    const postB = await insertContent({
      siteId: siteB.id,
      contentType: 'post',
      slug: 'bravo-post-' + randomUUID().slice(0, 8),
      title: 'SITE_BRAVO_PUBLISHED_POST',
      status: 'published',
      document: {
        schemaVersion: 1,
        documentId: 'bravo-post-doc',
        type: 'page',
        title: 'SITE_BRAVO_PUBLISHED_POST',
        children: [{ id: 'bravo-text', type: 'widget.text', props: { text: 'Bravo excerpt.' }, children: [] }],
      },
      published: true,
    });
    await insertContent({
      siteId: siteA.id,
      contentType: 'post',
      slug: 'alpha-draft-' + randomUUID().slice(0, 8),
      title: 'SITE_ALPHA_DRAFT_MUST_NOT_RENDER',
      status: 'draft',
      document: { schemaVersion: 1, children: [] },
      published: false,
    });
    await insertContent({
      siteId: siteA.id,
      contentType: 'post',
      slug: 'alpha-deleted-' + randomUUID().slice(0, 8),
      title: 'SITE_ALPHA_DELETED_MUST_NOT_RENDER',
      status: 'deleted',
      document: { schemaVersion: 1, children: [] },
      published: true,
      deleted: true,
    });

    server = createApiServer({ env, pool, identityService: identity, logger: { error() {} } });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = 'http://127.0.0.1:' + server.address().port;

    await t.test('Site A page query loop includes its own published post and hides other content', async () => {
      const response = await fetch(base + '/public/' + siteA.slug + '/pages/' + pageSlugA);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /SITE_ALPHA_QUERY_PAGE/);
      assert.match(html, /SITE_ALPHA_PUBLISHED_POST/);
      assert.match(html, new RegExp('/public/' + siteA.slug + '/pages/' + postA.slug));
      assert.doesNotMatch(html, /SITE_BRAVO_QUERY_PAGE/);
      assert.doesNotMatch(html, /SITE_BRAVO_PUBLISHED_POST/);
      assert.doesNotMatch(html, /SITE_ALPHA_DRAFT_MUST_NOT_RENDER/);
      assert.doesNotMatch(html, /SITE_ALPHA_DELETED_MUST_NOT_RENDER/);
    });

    await t.test('Site B page query loop includes its own published post and hides Site A content', async () => {
      const response = await fetch(base + '/public/' + siteB.slug + '/pages/' + pageSlugB);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /SITE_BRAVO_QUERY_PAGE/);
      assert.match(html, /SITE_BRAVO_PUBLISHED_POST/);
      assert.match(html, new RegExp('/public/' + siteB.slug + '/pages/' + postB.slug));
      assert.doesNotMatch(html, /SITE_ALPHA_QUERY_PAGE/);
      assert.doesNotMatch(html, /SITE_ALPHA_PUBLISHED_POST/);
      assert.doesNotMatch(html, /SITE_ALPHA_DRAFT_MUST_NOT_RENDER/);
      assert.doesNotMatch(html, /SITE_ALPHA_DELETED_MUST_NOT_RENDER/);
    });
  }
);