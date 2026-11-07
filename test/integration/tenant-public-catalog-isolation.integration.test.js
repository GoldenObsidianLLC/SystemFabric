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
  'tenant isolation: public search, products, and membership catalogs stay site-scoped',
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
      const slug = 'public-scope-' + label + '-' + randomUUID().slice(0, 8);
      const result = await pool.query(
        'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id,slug',
        [slug, 'Public Scope ' + label.toUpperCase()]
      );
      siteIds.push(result.rows[0].id);
      return result.rows[0];
    };
    const siteA = await createSite('alpha');
    const siteB = await createSite('bravo');
    const searchMarker = 'publicscopeprobe' + randomUUID().replace(/-/g, '').toLowerCase();
    const body = JSON.stringify({ schemaVersion: 1, children: [] });

    const createContent = async ({ siteId, slug, status, published, deleted = false }) => {
      const title = searchMarker + ' ' + slug;
      const snapshot = published
        ? JSON.stringify({
          title,
          slug,
          locale: 'en',
          contentType: 'page',
          status: 'published',
          document: JSON.parse(body),
          version: 1,
        })
        : null;
      const result = await pool.query(
        'INSERT INTO content_items(site_id,content_type,slug,locale,title,status,body,' +
        'published_snapshot,published_version,published_at,published_search_vector,deleted_at) ' +
        'VALUES($1,\'page\',$2,\'en\',$3,$4,$5::jsonb,$6::jsonb,' +
        'CASE WHEN $6::jsonb IS NULL THEN NULL ELSE 1 END,' +
        'CASE WHEN $6::jsonb IS NULL THEN NULL ELSE now() END,' +
        'to_tsvector(\'simple\',$3 || \' \' || $2),CASE WHEN $7 THEN now() ELSE NULL END) RETURNING id,slug,status',
        [siteId, slug, title, status, body, snapshot, deleted]
      );
      return result.rows[0];
    };

    const pageA = await createContent({
      siteId: siteA.id,
      slug: 'published-alpha-' + randomUUID().slice(0, 6),
      status: 'published',
      published: true,
    });
    const pageB = await createContent({
      siteId: siteB.id,
      slug: 'published-bravo-' + randomUUID().slice(0, 6),
      status: 'published',
      published: true,
    });
    const draftA = await createContent({
      siteId: siteA.id,
      slug: 'draft-alpha-' + randomUUID().slice(0, 6),
      status: 'draft',
      published: false,
    });
    const deletedA = await createContent({
      siteId: siteA.id,
      slug: 'deleted-alpha-' + randomUUID().slice(0, 6),
      status: 'deleted',
      published: true,
      deleted: true,
    });

    const createProduct = async ({ siteId, slug, name, status }) => {
      const result = await pool.query(
        'INSERT INTO commerce_products(site_id,slug,name,status,currency,price_minor) ' +
        'VALUES($1,$2,$3,$4,\'USD\',1299) RETURNING id,slug,status',
        [siteId, slug, name, status]
      );
      return result.rows[0];
    };
    const productA = await createProduct({
      siteId: siteA.id,
      slug: 'alpha-product-' + randomUUID().slice(0, 6),
      name: 'Alpha Public Product ' + searchMarker,
      status: 'published',
    });
    const productADraft = await createProduct({
      siteId: siteA.id,
      slug: 'alpha-draft-product-' + randomUUID().slice(0, 6),
      name: 'Alpha Draft Product ' + searchMarker,
      status: 'draft',
    });
    const productB = await createProduct({
      siteId: siteB.id,
      slug: 'bravo-product-' + randomUUID().slice(0, 6),
      name: 'Bravo Public Product ' + searchMarker,
      status: 'published',
    });

    const createPlan = async ({ siteId, slug, name, active }) => {
      const result = await pool.query(
        'INSERT INTO membership_plans(site_id,slug,name,price_minor,currency,interval_unit,interval_count,active) ' +
        'VALUES($1,$2,$3,990,\'USD\',\'month\',1,$4) RETURNING id,slug,active',
        [siteId, slug, name, active]
      );
      return result.rows[0];
    };
    const planA = await createPlan({
      siteId: siteA.id,
      slug: 'alpha-plan-' + randomUUID().slice(0, 6),
      name: 'Alpha Active Plan',
      active: true,
    });
    const planAInactive = await createPlan({
      siteId: siteA.id,
      slug: 'alpha-inactive-plan-' + randomUUID().slice(0, 6),
      name: 'Alpha Inactive Plan',
      active: false,
    });
    const planB = await createPlan({
      siteId: siteB.id,
      slug: 'bravo-plan-' + randomUUID().slice(0, 6),
      name: 'Bravo Active Plan',
      active: true,
    });

    server = createApiServer({ env, pool, identityService: identity, logger: { error() {} } });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = 'http://127.0.0.1:' + server.address().port;

    await t.test('public search returns only published, non-deleted results for the requested site', async () => {
      const responseA = await fetch(
        base + '/api/v1/public/' + siteA.slug + '/search?q=' + encodeURIComponent(searchMarker)
      );
      assert.equal(responseA.status, 200);
      const payloadA = await responseA.json();
      const idsA = payloadA.results.map(item => item.slug);
      assert.ok(idsA.includes(pageA.slug));
      assert.equal(idsA.includes(pageB.slug), false, 'Site A search must not disclose Site B content');
      assert.equal(idsA.includes(draftA.slug), false, 'draft content must not be searchable');
      assert.equal(idsA.includes(deletedA.slug), false, 'soft-deleted content must not be searchable');

      const responseB = await fetch(
        base + '/api/v1/public/' + siteB.slug + '/search?q=' + encodeURIComponent(searchMarker)
      );
      assert.equal(responseB.status, 200);
      const payloadB = await responseB.json();
      assert.deepEqual(payloadB.results.map(item => item.slug), [pageB.slug]);
    });

    await t.test('public product catalogs are site-scoped and exclude drafts', async () => {
      const slugResponse = await fetch(base + '/api/v1/public/' + siteA.slug + '/products');
      assert.equal(slugResponse.status, 200);
      const slugPayload = await slugResponse.json();
      const slugProductIds = slugPayload.products.map(item => item.id);
      assert.ok(slugProductIds.includes(productA.id));
      assert.equal(slugProductIds.includes(productB.id), false);
      assert.equal(slugProductIds.includes(productADraft.id), false);

      const idResponse = await fetch(base + '/api/v1/public/sites/' + siteA.id + '/products');
      assert.equal(idResponse.status, 200);
      const idPayload = await idResponse.json();
      const idProductIds = idPayload.products.map(item => item.id);
      assert.ok(idProductIds.includes(productA.id));
      assert.equal(idProductIds.includes(productB.id), false);
      assert.equal(idProductIds.includes(productADraft.id), false);
    });

    await t.test('public product detail hides a product owned by another site', async () => {
      const own = await fetch(
        base + '/api/v1/public/sites/' + siteA.id + '/products/' + productA.slug
      );
      assert.equal(own.status, 200);
      assert.equal((await own.json()).product.id, productA.id);

      const foreign = await fetch(
        base + '/api/v1/public/sites/' + siteA.id + '/products/' + productB.slug
      );
      assert.equal(foreign.status, 404);
      assert.equal((await foreign.json()).code, 'ERR_VIRGOSCORPIO_HUB_PRODUCT_NOT_FOUND');
    });

    await t.test('public membership catalogs are site-scoped and exclude inactive plans', async () => {
      const slugResponse = await fetch(
        base + '/api/v1/public/' + siteA.slug + '/membership-plans'
      );
      assert.equal(slugResponse.status, 200);
      const slugPayload = await slugResponse.json();
      const slugPlanIds = slugPayload.plans.map(item => item.id);
      assert.ok(slugPlanIds.includes(planA.id));
      assert.equal(slugPlanIds.includes(planAInactive.id), false);
      assert.equal(slugPlanIds.includes(planB.id), false);

      const idResponse = await fetch(
        base + '/api/v1/public/sites/' + siteA.id + '/membership-plans'
      );
      assert.equal(idResponse.status, 200);
      const idPayload = await idResponse.json();
      const idPlanIds = idPayload.plans.map(item => item.id);
      assert.ok(idPlanIds.includes(planA.id));
      assert.equal(idPlanIds.includes(planAInactive.id), false);
      assert.equal(idPlanIds.includes(planB.id), false);
    });
  }
);