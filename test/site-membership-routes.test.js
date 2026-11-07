'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleSiteMembershipRoute } = require('../apps/api/src/site-membership-routes');

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INVITATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACTOR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REQUEST_ID = 'request-membership-test';

function createContext({
  path,
  method = 'GET',
  body = {},
  identityOverrides = {},
  requireCapability = async () => {},
  siteIdFor = async ({ routeSiteId }) => routeSiteId,
} = {}) {
  const events = [];
  const payload = {};
  const res = {
    payload,
  };

  const identity = {
    async listMembers(input) {
      events.push({ type: 'listMembers', input });
      return [{ id: USER_ID, role: 'site-owner' }];
    },
    async addMember(input) {
      events.push({ type: 'addMember', input });
      return { id: TARGET_ID, email: input.email, role: input.roleSlug };
    },
    async removeMember(input) {
      events.push({ type: 'removeMember', input });
      return { removed: true };
    },
    async createInvitation(input) {
      events.push({ type: 'createInvitation', input });
      return {
        id: INVITATION_ID,
        email: input.email,
        role: input.roleSlug,
        token: 'one-time-secret-invitation-token',
      };
    },
    async audit(input) {
      events.push({ type: 'audit', input });
    },
    ...identityOverrides,
  };

  const ctx = {
    req: { method, headers: {} },
    res,
    url: new URL(`http://localhost${path}`),
    actor: { user: { id: ACTOR_ID } },
    siteIdFor: async input => {
      events.push({ type: 'siteIdFor', routeSiteId: input.routeSiteId, body: input.body });
      return siteIdFor(input);
    },
    requireCapability: async (...args) => {
      events.push({ type: 'requireCapability', args });
      return requireCapability(...args);
    },
    readJson: async (req, maxBytes) => {
      events.push({ type: 'readJson', maxBytes });
      return body;
    },
    sendJson: (response, statusCode, result) => {
      events.push({ type: 'sendJson', statusCode });
      response.payload.statusCode = statusCode;
      response.payload.body = result;
      return true;
    },
    requestId: REQUEST_ID,
    identity,
    maxBody: 128_000,
    events,
  };

  return ctx;
}

test('unmatched paths and methods decline without invoking membership dependencies', async () => {
  const ctx = createContext({
    path: `/api/v1/sites/${SITE_ID}/members`,
    method: 'PUT',
  });

  assert.equal(await handleSiteMembershipRoute(ctx), false);
  assert.deepEqual(ctx.events, []);
});

test('member listing checks site management capability before identity access', async () => {
  const ctx = createContext({
    path: `/api/v1/sites/${SITE_ID}/members`,
  });

  assert.equal(await handleSiteMembershipRoute(ctx), true);
  assert.deepEqual(ctx.events, [
    { type: 'siteIdFor', routeSiteId: SITE_ID, body: undefined },
    {
      type: 'requireCapability',
      args: [ctx.actor, SITE_ID, 'site:manage'],
    },
    { type: 'listMembers', input: { siteId: SITE_ID } },
    { type: 'sendJson', statusCode: 200 },
  ]);
  assert.deepEqual(ctx.res.payload.body, {
    members: [{ id: USER_ID, role: 'site-owner' }],
    requestId: REQUEST_ID,
  });
});

test('site selector reconciliation rejects conflicting context before capability or identity access', async () => {
  const ctx = createContext({
    path: `/api/v1/sites/${SITE_ID}/members`,
    method: 'POST',
    body: { siteId: '22222222-2222-4222-8222-222222222222', email: 'member@example.test', role: 'editor' },
    siteIdFor: async () => {
      throw Object.assign(new Error('Site selectors do not match.'), {
        statusCode: 400,
        code: 'ERR_VIRGOSCORPIO_HUB_SITE_CONTEXT_MISMATCH',
      });
    },
  });

  await assert.rejects(
    handleSiteMembershipRoute(ctx),
    error => error.statusCode === 400 && error.code === 'ERR_VIRGOSCORPIO_HUB_SITE_CONTEXT_MISMATCH',
  );
  assert.deepEqual(ctx.events.map(event => event.type), ['readJson', 'siteIdFor']);
});

test('member addition uses the bounded body reader and audits the assigned role', async () => {
  const ctx = createContext({
    path: `/api/v1/sites/${SITE_ID}/members`,
    method: 'POST',
    body: { email: 'member@example.test', role: 'editor' },
  });

  assert.equal(await handleSiteMembershipRoute(ctx), true);
  assert.deepEqual(ctx.events.map(event => event.type), [
    'readJson',
    'siteIdFor',
    'requireCapability',
    'addMember',
    'audit',
    'sendJson',
  ]);
  assert.equal(ctx.events[0].maxBytes, 16_384);
  assert.deepEqual(ctx.events[1], {
    type: 'siteIdFor',
    routeSiteId: SITE_ID,
    body: { email: 'member@example.test', role: 'editor' },
  });
  assert.deepEqual(ctx.events[3].input, {
    siteId: SITE_ID,
    email: 'member@example.test',
    roleSlug: 'editor',
  });
  assert.deepEqual(ctx.events[4].input, {
    siteId: SITE_ID,
    actorId: ACTOR_ID,
    action: 'site.member_added',
    targetType: 'user',
    targetId: TARGET_ID,
    requestId: REQUEST_ID,
    details: { role: 'editor' },
  });
  assert.equal(ctx.res.payload.statusCode, 201);
});

test('member removal is site-capability guarded and audited after persistence', async () => {
  const ctx = createContext({
    path: `/api/v1/sites/${SITE_ID}/members/${TARGET_ID}`,
    method: 'DELETE',
  });

  assert.equal(await handleSiteMembershipRoute(ctx), true);
  assert.deepEqual(ctx.events.map(event => event.type), [
    'siteIdFor',
    'requireCapability',
    'removeMember',
    'audit',
    'sendJson',
  ]);
  assert.deepEqual(ctx.events[2].input, { siteId: SITE_ID, userId: TARGET_ID });
  assert.equal(ctx.events[3].input.action, 'site.member_removed');
  assert.equal(ctx.events[3].input.targetId, TARGET_ID);
  assert.deepEqual(ctx.res.payload.body, { removed: true, requestId: REQUEST_ID });
});

test('invitation creation scopes capability checks and never audits the one-time token', async () => {
  const ctx = createContext({
    path: `/api/v1/sites/${SITE_ID}/invitations`,
    method: 'POST',
    body: { email: 'invitee@example.test', role: 'viewer' },
  });

  assert.equal(await handleSiteMembershipRoute(ctx), true);
  assert.deepEqual(ctx.events.map(event => event.type), [
    'readJson',
    'siteIdFor',
    'requireCapability',
    'createInvitation',
    'audit',
    'sendJson',
  ]);
  assert.equal(ctx.events[0].maxBytes, 16_384);
  assert.deepEqual(ctx.events[1], { type: 'siteIdFor', routeSiteId: SITE_ID, body: { email: 'invitee@example.test', role: 'viewer' } });
  assert.deepEqual(ctx.events[3].input, {
    siteId: SITE_ID,
    email: 'invitee@example.test',
    roleSlug: 'viewer',
    invitedBy: ACTOR_ID,
  });
  assert.deepEqual(ctx.events[4].input, {
    siteId: SITE_ID,
    actorId: ACTOR_ID,
    action: 'site.invitation_created',
    targetType: 'invitation',
    requestId: REQUEST_ID,
    details: { email: 'invitee@example.test', role: 'viewer' },
  });
  assert.equal(
    ctx.res.payload.body.invitation.token,
    'one-time-secret-invitation-token',
    'the token is returned to the trusted request but is not written to audit metadata',
  );
  assert.match(ctx.res.payload.body.note, /trusted channel/);
});

test('denied site capability prevents member listing, mutation, and audit', async t => {
  for (const scenario of [
    { path: `/api/v1/sites/${SITE_ID}/members`, method: 'GET' },
    {
      path: `/api/v1/sites/${SITE_ID}/members`,
      method: 'POST',
      body: { email: 'denied@example.test', role: 'viewer' },
    },
    {
      path: `/api/v1/sites/${SITE_ID}/members/${TARGET_ID}`,
      method: 'DELETE',
    },
    {
      path: `/api/v1/sites/${SITE_ID}/invitations`,
      method: 'POST',
      body: { email: 'denied@example.test', role: 'viewer' },
    },
  ]) {
    await t.test(`${scenario.method} ${scenario.path}`, async () => {
      const ctx = createContext({
        ...scenario,
        requireCapability: async () => {
          throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
        },
      });

      await assert.rejects(
        handleSiteMembershipRoute(ctx),
        error => error.statusCode === 403,
      );
      assert.ok(
        !ctx.events.some(event =>
          ['listMembers', 'addMember', 'removeMember', 'createInvitation', 'audit'].includes(event.type),
        ),
      );
    });
  }
});
