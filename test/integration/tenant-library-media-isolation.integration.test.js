'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPostgresPool, createPostgresStore } = require('../../packages/db/src/postgres-store');
const { createIdentityService, hashPassword } = require('../../packages/auth/src/service');
const { createApiServer } = require('../../apps/api/src/server');

const enabled = Boolean(
  process.env.DATABASE_URL &&
  process.env.VIRGOSCORPIO_HUB_RUN_POSTGRES_INTEGRATION === 'true'
);

async function seedLibraryAsset({ pool, libraryRoot, siteId, id, bytes, displayName, isPublic, createdBy = null }) {
  const storageKey = `${siteId}/${id}/v1.txt`;
  const digest = createHash('sha256').update(bytes).digest('hex');
  const filePath = path.join(libraryRoot, ...storageKey.split('/'));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes, { flag: 'wx' });

  await pool.query(
    `INSERT INTO library_assets(
       id,site_id,asset_kind,display_name,original_name,storage_provider,storage_key,
       mime_type,byte_size,sha256,is_public,version,status,optimization_status,
       metadata,created_by,updated_by,malware_scan_status,malware_scan_engine,malware_scanned_at
     ) VALUES($1,$2,'document',$3,$4,'local',$5,'text/plain',$6,$7,$8,1,'active','pending',
       '{}'::jsonb,$9,$9,'clean','integration-fixture',now())`,
    [id, siteId, displayName, `${displayName}.txt`, storageKey, bytes.length, digest, isPublic, createdBy]
  );

  await pool.query(
    `INSERT INTO library_asset_versions(asset_id,version,snapshot,storage_key,sha256,created_by)
     VALUES($1,1,$2::jsonb,$3,$4,$5)`,
    [
      id,
      JSON.stringify({
        displayName,
        originalName: `${displayName}.txt`,
        altText: '',
        caption: '',
        description: '',
        isPublic,
        metadata: {},
      }),
      storageKey,
      digest,
      createdBy,
    ]
  );

  return { id, siteId, storageKey, bytes, digest, displayName };
}

async function seedMediaAsset({ pool, mediaRoot, siteId, id, bytes, createdBy = null }) {
  const storageKey = String(siteId) + '/' + String(id) + '.png';
  const filePath = path.join(mediaRoot, ...storageKey.split('/'));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes, { flag: 'wx' });
  await pool.query(
    'INSERT INTO media_assets(id,site_id,storage_key,mime_type,byte_size,alt_text,metadata,created_by,publicly_accessible) ' +
    "VALUES($1,$2,$3,'image/png',$4,'','{}'::jsonb,$5,true)",
    [id, siteId, storageKey, bytes.length, createdBy]
  );
  return { id, siteId, storageKey, bytes };
}

async function librarySideEffects(pool, siteId, assetId) {
  const [asset, versions, variants] = await Promise.all([
    pool.query(
      `SELECT id,site_id,status,deleted_at,version,is_public,optimization_status,
              updated_at,storage_key,sha256,metadata
       FROM library_assets WHERE site_id=$1 AND id=$2`,
      [siteId, assetId]
    ),
    pool.query(
      'SELECT id,asset_id,version,snapshot,storage_key,sha256 FROM library_asset_versions WHERE asset_id=$1 ORDER BY version',
      [assetId]
    ),
    pool.query(
      'SELECT id,asset_id,variant_key,storage_key,mime_type,byte_size,sha256 FROM media_variants WHERE asset_id=$1 ORDER BY variant_key',
      [assetId]
    ),
  ]);
  return { asset: asset.rows, versions: versions.rows, variants: variants.rows };
}

test(
  'tenant isolation: library metadata, history, downloads, optimization, and public bytes stay site-scoped',
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
    let libraryRoot = null;
    let mediaRoot = null;

    const env = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL,
      REQUIRE_VERIFIED_EMAIL: 'false',
      AI_PROVIDER: 'mock',
      LIBRARY_STORAGE_PROVIDER: 'local',
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
      if (libraryRoot) await fs.rm(libraryRoot, { recursive: true, force: true }).catch(() => {});
      if (mediaRoot) await fs.rm(mediaRoot, { recursive: true, force: true }).catch(() => {});
      await pool.end();
    });

    libraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'virgoscorpio_hub-tenant-library-'));
    env.LIBRARY_ROOT = libraryRoot;
    mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'virgoscorpio_hub-tenant-media-'));
    env.MEDIA_ROOT = mediaRoot;

    const siteAResult = await pool.query(
      'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
      [`tenant-library-a-${randomUUID().slice(0, 8)}`, 'Tenant Library Site A']
    );
    const siteA = siteAResult.rows[0].id;
    siteIds.push(siteA);

    const siteBResult = await pool.query(
      'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
      [`tenant-library-b-${randomUUID().slice(0, 8)}`, 'Tenant Library Site B']
    );
    const siteB = siteBResult.rows[0].id;
    siteIds.push(siteB);

    const roleResult = await pool.query(
      'INSERT INTO roles(slug,label,capabilities) VALUES($1,$2,$3::jsonb) RETURNING id',
      [`tenant-library-${randomUUID().slice(0, 10)}`, 'Tenant Library Test Administrator', JSON.stringify(['*'])]
    );
    roleId = roleResult.rows[0].id;

    const password = 'Isolation-Password-2026';
    const actorResult = await pool.query(
      `INSERT INTO users(email,display_name,password_hash,status)
       VALUES($1,$2,$3,'active') RETURNING id,email`,
      [`tenant-library-actor-${randomUUID()}@example.test`, 'Site B Library Actor', await hashPassword(password)]
    );
    const actor = actorResult.rows[0];
    userIds.push(actor.id);

    await pool.query(
      'INSERT INTO site_memberships(site_id,user_id,role_id) VALUES($1,$2,$3)',
      [siteB, actor.id, roleId]
    );

    const assetAId = randomUUID();
    const assetBId = randomUUID();
    const secretA = Buffer.from('SITE_A_PRIVATE_LIBRARY_PAYLOAD_MUST_NOT_ESCAPE');
    const controlB = Buffer.from('SITE_B_LIBRARY_CONTROL_PAYLOAD');
    const assetA = await seedLibraryAsset({
      pool,
      libraryRoot,
      siteId: siteA,
      id: assetAId,
      bytes: secretA,
      displayName: 'PRIVATE_SITE_A_LIBRARY_MARKER',
      isPublic: false,
    });
    const assetB = await seedLibraryAsset({
      pool,
      libraryRoot,
      siteId: siteB,
      id: assetBId,
      bytes: controlB,
      displayName: 'Site B Library Control',
      isPublic: true,
      createdBy: actor.id,
    });

    const variantBytes = Buffer.from('SITE_A_PRIVATE_VARIANT_PAYLOAD');
    const variantKey = `${siteA}/${assetAId}/variants/private-preview.txt`;
    const variantPath = path.join(libraryRoot, ...variantKey.split('/'));
    await fs.mkdir(path.dirname(variantPath), { recursive: true });
    await fs.writeFile(variantPath, variantBytes, { flag: 'wx' });
    await pool.query(
      `INSERT INTO media_variants(asset_id,variant_key,storage_key,mime_type,byte_size,sha256)
       VALUES($1,'private-preview',$2,'text/plain',$3,$4)`,
      [assetAId, variantKey, variantBytes.length, createHash('sha256').update(variantBytes).digest('hex')]
    );

    const mediaAssetId = randomUUID();
    const mediaBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const mediaAsset = await seedMediaAsset({ pool, mediaRoot, siteId: siteB, id: mediaAssetId, bytes: mediaBytes, createdBy: actor.id });

    const publicVariantBytes = Buffer.from('SITE_B_PUBLIC_VARIANT_PAYLOAD');
    const publicVariantKey = siteB + '/' + assetBId + '/variants/public-preview.txt';
    const publicVariantPath = path.join(libraryRoot, ...publicVariantKey.split('/'));
    await fs.mkdir(path.dirname(publicVariantPath), { recursive: true });
    await fs.writeFile(publicVariantPath, publicVariantBytes, { flag: 'wx' });
    await pool.query(
      'INSERT INTO media_variants(asset_id,variant_key,storage_key,mime_type,byte_size,sha256) ' +
      "VALUES($1,'public-preview',$2,'text/plain',$3,$4)",
      [assetBId, publicVariantKey, publicVariantBytes.length, createHash('sha256').update(publicVariantBytes).digest('hex')]
    );

    const session = await identity.login({
      email: actor.email,
      password,
      ip: '127.0.0.1',
      userAgent: 'tenant-library-isolation-test',
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
    const headers = {
      authorization: `Bearer ${session.token}`,
      'x-virgoscorpio-hub-site-id': siteB,
    };
    const before = await librarySideEffects(pool, siteA, assetAId);
    assert.equal(before.asset.length, 1);
    assert.equal(before.versions.length, 1);
    assert.equal(before.variants.length, 1);

    async function assertSiteAUnchanged() {
      assert.deepEqual(await librarySideEffects(pool, siteA, assetAId), before);
      assert.deepEqual(await fs.readFile(path.join(libraryRoot, ...assetA.storageKey.split('/'))), secretA);
      assert.deepEqual(await fs.readFile(variantPath), variantBytes);
    }

    await t.test('site B library listing excludes site A metadata', async () => {
      const response = await fetch(`${base}/api/v1/sites/${siteB}/library/items`, { headers });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.ok(payload.items.some(item => item.id === assetB.id));
      assert.equal(payload.items.some(item => item.id === assetA.id), false);
      assert.equal(payload.items.some(item => item.display_name === assetA.displayName), false);
      assert.doesNotMatch(JSON.stringify(payload), /SITE_A_PRIVATE_LIBRARY_PAYLOAD|PRIVATE_SITE_A_LIBRARY_MARKER/);
      await assertSiteAUnchanged();
    });

    await t.test('foreign metadata and version history are returned as not found', async () => {
      for (const endpoint of ['', '/versions']) {
        const response = await fetch(`${base}/api/v1/sites/${siteB}/library/items/${assetA.id}${endpoint}`, { headers });
        const payload = await response.json();
        assert.equal(response.status, 404);
        assert.equal(payload.code, 'ERR_VIRGOSCORPIO_HUB_LIBRARY_NOT_FOUND');
        assert.doesNotMatch(JSON.stringify(payload), /SITE_A_PRIVATE_LIBRARY_PAYLOAD|PRIVATE_SITE_A_LIBRARY_MARKER/);
      }
      await assertSiteAUnchanged();
    });

    await t.test('foreign authenticated download cannot read site A bytes', async () => {
      const response = await fetch(`${base}/api/v1/sites/${siteB}/library/items/${assetA.id}/download`, { headers });
      assert.equal(response.status, 404);
      const payload = await response.text();
      assert.doesNotMatch(payload, /SITE_A_PRIVATE_LIBRARY_PAYLOAD|PRIVATE_SITE_A_LIBRARY_MARKER/);
      await assertSiteAUnchanged();
    });

    await t.test('foreign metadata update cannot expose a private site A asset', async () => {
      const response = await fetch(`${base}/api/v1/sites/${siteB}/library/items/${assetA.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: 1,
          patch: { isPublic: true, description: 'attempted cross-site public promotion' },
        }),
      });
      assert.equal(response.status, 404);
      const payload = await response.json();
      assert.equal(payload.code, 'ERR_VIRGOSCORPIO_HUB_LIBRARY_NOT_FOUND');
      await assertSiteAUnchanged();
    });

    await t.test('foreign optimization cannot update site A optimization state', async () => {
      const response = await fetch(`${base}/api/v1/sites/${siteB}/library/items/${assetA.id}/optimize`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 404);
      const payload = await response.json();
      assert.equal(payload.code, 'ERR_VIRGOSCORPIO_HUB_LIBRARY_NOT_FOUND');
      await assertSiteAUnchanged();
    });

    await t.test('foreign deletion is rejected without changing site A asset or versions', async () => {
      const response = await fetch(`${base}/api/v1/sites/${siteB}/library/items/${assetA.id}`, {
        method: 'DELETE',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1 }),
      });
      assert.equal(response.status, 409);
      const payload = await response.json();
      assert.equal(payload.code, 'ERR_VIRGOSCORPIO_HUB_VERSION_CONFLICT');
      await assertSiteAUnchanged();
    });

    await t.test('private site A asset and variant remain unavailable through public byte routes', async () => {
      const assetResponse = await fetch(`${base}/library/public/${assetA.id}`);
      const variantResponse = await fetch(`${base}/library/public/${assetA.id}/variants/private-preview`);
      assert.equal(assetResponse.status, 404);
      assert.equal(variantResponse.status, 404);
      assert.doesNotMatch(await assetResponse.text(), /SITE_A_PRIVATE_LIBRARY_PAYLOAD/);
      assert.doesNotMatch(await variantResponse.text(), /SITE_A_PRIVATE_VARIANT_PAYLOAD/);
      await assertSiteAUnchanged();
    });

    await t.test('site B metadata and private download remain accessible as positive controls', async () => {
      const detail = await fetch(`${base}/api/v1/sites/${siteB}/library/items/${assetB.id}`, { headers });
      assert.equal(detail.status, 200);
      const payload = await detail.json();
      assert.equal(payload.item.id, assetB.id);
      assert.equal(payload.item.site_id, siteB);

      const download = await fetch(`${base}/api/v1/sites/${siteB}/library/items/${assetB.id}/download`, { headers });
      assert.equal(download.status, 200);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), controlB);
    });

    await t.test('site B public asset and variant are non-cacheable and become unavailable immediately after revocation', async () => {
      const assetResponse = await fetch(base + '/library/public/' + assetB.id);
      assert.equal(assetResponse.status, 200);
      assert.equal(assetResponse.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(Buffer.from(await assetResponse.arrayBuffer()), controlB);

      const variantResponse = await fetch(base + '/library/public/' + assetB.id + '/variants/public-preview');
      assert.equal(variantResponse.status, 200);
      assert.equal(variantResponse.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(Buffer.from(await variantResponse.arrayBuffer()), publicVariantBytes);

      const revoke = await fetch(base + '/api/v1/sites/' + siteB + '/library/items/' + assetB.id, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1, patch: { isPublic: false } }),
      });
      assert.equal(revoke.status, 200, await revoke.text());

      const hiddenAsset = await fetch(base + '/library/public/' + assetB.id);
      const hiddenVariant = await fetch(base + '/library/public/' + assetB.id + '/variants/public-preview');
      assert.equal(hiddenAsset.status, 404);
      assert.equal(hiddenVariant.status, 404);
      assert.equal(hiddenAsset.headers.get('cache-control'), 'no-store');
      assert.equal(hiddenVariant.headers.get('cache-control'), 'no-store');
    });

    await t.test('public media uses no-store and checks current visibility on every request', async () => {
      const publicResponse = await fetch(base + '/media/' + mediaAsset.id);
      assert.equal(publicResponse.status, 200);
      assert.equal(publicResponse.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(Buffer.from(await publicResponse.arrayBuffer()), mediaBytes);

      await pool.query('UPDATE media_assets SET publicly_accessible=false WHERE site_id=$1 AND id=$2', [siteB, mediaAsset.id]);
      const revokedResponse = await fetch(base + '/media/' + mediaAsset.id);
      assert.equal(revokedResponse.status, 404);
      assert.equal(revokedResponse.headers.get('cache-control'), 'no-store');
    });
  }
);
