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
  'tenant isolation: mega-menu CRUD keeps same-slug records isolated across sites',
  { skip: !enabled },
  async t => {
    const pool = createPostgresPool({
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_POOL_MAX: '8',
    });
    const siteIds = [];
    const userIds = [];
    let server = null;

    const env = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL,
      REQUIRE_VERIFIED_EMAIL: 'false',
      VIRGOSCORPIO_HUB_EXPOSE_DEV_TOKENS: 'false',
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
      await pool.end();
    });

    const siteAResult = await pool.query(
      'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
      ['tenant-mega-a-' + randomUUID(), 'Tenant Mega Menu Site A']
    );
    const siteA = siteAResult.rows[0].id;
    siteIds.push(siteA);

    const siteBResult = await pool.query(
      'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
      ['tenant-mega-b-' + randomUUID(), 'Tenant Mega Menu Site B']
    );
    const siteB = siteBResult.rows[0].id;
    siteIds.push(siteB);

    const roleResult = await pool.query("SELECT id FROM roles WHERE slug='site-owner' LIMIT 1");
    assert.ok(roleResult.rows[0], 'the seeded site-owner role must exist');
    const ownerRoleId = roleResult.rows[0].id;

    async function createOwner(label) {
      const email = 'tenant-mega-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + randomUUID() + '@example.test';
      const result = await pool.query(
        'INSERT INTO users(email,display_name,password_hash,status) VALUES($1,$2,$3,\'active\') RETURNING id,email',
        [email, label, await hashPassword('Isolation-Password-2026')]
      );
      userIds.push(result.rows[0].id);
      return result.rows[0];
    }

    const ownerA = await createOwner('Site A Owner');
    const ownerB = await createOwner('Site B Owner');
    await pool.query(
      'INSERT INTO site_memberships(site_id,user_id,role_id) VALUES($1,$2,$3),($4,$5,$3)',
      [siteA, ownerA.id, ownerRoleId, siteB, ownerB.id]
    );

    const sharedSlug = 'shared-mega-menu';
    const initialItems = [{ id: 'home', label: 'Home', type: 'url', url: '/' }];
    const initialPresentation = { megaMenu: true, layout: 'columns', columns: 3 };
    await pool.query(
      'INSERT INTO navigation_menus(site_id,slug,name,items,presentation,updated_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6),($7,$2,$8,$4::jsonb,$5::jsonb,$9)',
      [
        siteA, sharedSlug, 'Site A private navigation', JSON.stringify(initialItems),
        JSON.stringify(initialPresentation), ownerA.id,
        siteB, 'Site B private navigation', ownerB.id,
      ]
    );

    const sessionA = await identity.login({
      email: ownerA.email,
      password: 'Isolation-Password-2026',
      ip: '127.0.0.1',
      userAgent: 'tenant-mega-menu-isolation-test',
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

    const base = 'http://127.0.0.1:' + server.address().port;
    const authHeaders = {
      authorization: 'Bearer ' + sessionA.token,
      'content-type': 'application/json',
    };
    const readHeaders = { authorization: 'Bearer ' + sessionA.token };
    const path = siteId => '/api/v1/sites/' + siteId + '/mega-menus';

    async function menuSnapshot() {
      const result = await pool.query(
        'SELECT id,site_id,slug,name,version,items,presentation,updated_by,created_at,updated_at FROM navigation_menus WHERE site_id=ANY($1::uuid[]) ORDER BY site_id,slug',
        [[siteA, siteB]]
      );
      return result.rows;
    }

    const before = await menuSnapshot();
    assert.equal(before.length, 2, 'the fixture must contain one same-slug menu in each site');
    assert.deepEqual(before.map(row => row.slug), [sharedSlug, sharedSlug]);

    const ownList = await fetch(base + path(siteA), { headers: readHeaders });
    assert.equal(ownList.status, 200);
    const ownListPayload = await ownList.json();
    assert.deepEqual(ownListPayload.menus.map(menu => menu.slug), [sharedSlug]);
    assert.equal(ownListPayload.menus[0].name, 'Site A private navigation');
    assert.doesNotMatch(JSON.stringify(ownListPayload), /Site B private navigation/);

    const deniedScenarios = [
      { method: 'GET', url: path(siteB) },
      {
        method: 'PUT',
        url: path(siteB) + '/' + sharedSlug,
        body: {
          expectedVersion: 1,
          name: 'Cross-site overwrite attempt',
          items: [{ id: 'stolen', label: 'Stolen', type: 'url', url: '/stolen' }],
        },
      },
      { method: 'DELETE', url: path(siteB) + '/' + sharedSlug },
    ];

    for (const scenario of deniedScenarios) {
      const response = await fetch(base + scenario.url, {
        method: scenario.method,
        headers: scenario.body === undefined ? readHeaders : authHeaders,
        ...(scenario.body === undefined ? {} : { body: JSON.stringify(scenario.body) }),
      });
      const payload = await response.json();
      assert.equal(response.status, 403, scenario.method + ' ' + scenario.url + ' must reject Site A owner access to Site B');
      assert.equal(payload.code, 'ERR_VIRGOSCORPIO_HUB_TENANT_FORBIDDEN');
      assert.doesNotMatch(JSON.stringify(payload), /Site B private navigation/);
    }

    const conflictingBody = await fetch(base + path(siteA) + '/' + sharedSlug, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        siteId: siteB,
        expectedVersion: 1,
        name: 'Conflicting selector attempt',
        items: initialItems,
      }),
    });
    assert.equal(conflictingBody.status, 400);
    assert.equal((await conflictingBody.json()).code, 'ERR_VIRGOSCORPIO_HUB_SITE_CONTEXT_MISMATCH');

    const conflictingHeader = await fetch(base + path(siteA), {
      headers: { ...readHeaders, 'x-virgoscorpio-hub-site-id': siteB },
    });
    assert.equal(conflictingHeader.status, 400);
    assert.equal((await conflictingHeader.json()).code, 'ERR_VIRGOSCORPIO_HUB_SITE_CONTEXT_MISMATCH');

    const conflictingQuery = await fetch(base + path(siteA) + '?siteId=' + siteB, {
      headers: readHeaders,
    });
    assert.equal(conflictingQuery.status, 400);
    assert.equal((await conflictingQuery.json()).code, 'ERR_VIRGOSCORPIO_HUB_SITE_CONTEXT_MISMATCH');

    assert.deepEqual(await menuSnapshot(), before, 'denied and conflicting requests must not change either site navigation');

    const createdSlug = 'site-a-created-mega-menu';
    const created = await fetch(base + path(siteA), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        slug: createdSlug,
        name: 'Site A created mega menu',
        items: [{ id: 'about', label: 'About', type: 'url', url: '/about' }],
        presentation: { layout: 'grid' },
      }),
    });
    assert.equal(created.status, 201);
    const createdPayload = await created.json();
    assert.equal(createdPayload.menu.site_id, siteA);
    assert.equal(createdPayload.menu.version, 1);
    assert.equal(createdPayload.menu.presentation.megaMenu, true);

    const updatedCreated = await fetch(base + path(siteA) + '/' + createdSlug, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        expectedVersion: 1,
        name: 'Site A updated mega menu',
        items: [{ id: 'contact', label: 'Contact', type: 'url', url: '/contact' }],
        presentation: { layout: 'tabs' },
      }),
    });
    assert.equal(updatedCreated.status, 200);
    const updatedPayload = await updatedCreated.json();
    assert.equal(updatedPayload.menu.site_id, siteA);
    assert.equal(updatedPayload.menu.version, 2);
    assert.equal(updatedPayload.menu.name, 'Site A updated mega menu');

    const deletedCreated = await fetch(base + path(siteA) + '/' + createdSlug, {
      method: 'DELETE',
      headers: readHeaders,
    });
    assert.equal(deletedCreated.status, 200);
    assert.equal((await deletedCreated.json()).deleted, true);

    const ownSharedUpdate = await fetch(base + path(siteA) + '/' + sharedSlug, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        expectedVersion: 1,
        name: 'Site A updated shared menu',
        items: [{ id: 'home', label: 'Home', type: 'url', url: '/' }],
        presentation: { layout: 'flyout' },
      }),
    });
    assert.equal(ownSharedUpdate.status, 200);
    assert.equal((await ownSharedUpdate.json()).menu.version, 2);

    const ownSharedDelete = await fetch(base + path(siteA) + '/' + sharedSlug, {
      method: 'DELETE',
      headers: readHeaders,
    });
    assert.equal(ownSharedDelete.status, 200);
    assert.equal((await ownSharedDelete.json()).deleted, true);

    const after = await menuSnapshot();
    assert.equal(after.length, 1, 'only Site B menu should remain after Site A deletes its own record');
    assert.equal(after[0].site_id, siteB);
    assert.equal(after[0].slug, sharedSlug);
    assert.equal(after[0].name, 'Site B private navigation');
    assert.equal(after[0].version, 1);
    assert.deepEqual(after[0].items, initialItems);
    assert.deepEqual(after[0].presentation, initialPresentation);
  }
);
