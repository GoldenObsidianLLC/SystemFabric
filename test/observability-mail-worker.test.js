'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let sendEmailStub = async () => {};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../../../packages/notifications/src/mailer' &&
      parent?.filename.endsWith(require('node:path').join('apps', 'worker', 'src', 'mail-worker.js'))) {
    return { sendEmail: (...args) => sendEmailStub(...args) };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let processBatch;
try {
  ({ processBatch } = require('../apps/worker/src/mail-worker'));
} finally {
  Module._load = originalLoad;
}

function createPool(row) {
  const clientCalls = [];
  const poolCalls = [];
  return {
    clientCalls,
    poolCalls,
    async connect() {
      return {
        async query(sql, params) {
          clientCalls.push({ sql, params });
          if (sql.includes('SELECT id,recipient,template,payload,attempts')) {
            return { rows: [row] };
          }
          return { rows: [] };
        },
        release() {}
      };
    },
    async query(sql, params) {
      poolCalls.push({ sql, params });
      return { rows: [] };
    }
  };
}

test('mail worker failures emit only allow-listed operational fields', async () => {
  const secrets = {
    id: 'b7f25a10-16a9-47a6-8a9b-0c4f574c5133',
    recipient: 'person+private@example.invalid',
    template: 'password-reset',
    payload: { token: 'MAIL_RESET_TOKEN_SHOULD_NOT_LEAK', name: 'Private Name' },
    attempts: 7
  };
  const pool = createPool(secrets);
  const records = [];
  const logger = {
    info(line) { records.push(JSON.parse(line)); },
    error(line) { records.push(JSON.parse(line)); }
  };
  sendEmailStub = async message => {
    assert.equal(message.recipient, secrets.recipient);
    assert.equal(message.payload.token, secrets.payload.token);
    throw Object.assign(new Error('SMTP response included private mailbox and provider detail'), {
      code: 'ERR_VIRGOSCORPIO_HUB_MAIL_PROVIDER'
    });
  };

  const result = await processBatch(pool, {
    logger,
    env: { NODE_ENV: 'test' },
    clock: () => 1_800_000_000_000
  });

  assert.equal(result.processed, 1);
  assert.deepEqual(result.results, [{ id: secrets.id, status: 'failed' }]);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.event, 'virgoscorpio_hub.mail.delivery_failure');
  assert.equal(record.level, 'error');
  assert.equal(record.component, 'mail');
  assert.equal(record.operation, 'delivery');
  assert.equal(record.code, 'ERR_VIRGOSCORPIO_HUB_MAIL_PROVIDER');
  assert.equal(record.attempts, 8);
  assert.equal(record.terminal, true);
  assert.equal(record.outcome, 'failed');
  assert.equal('recipient' in record, false);
  assert.equal('id' in record, false);
  assert.equal('payload' in record, false);
  assert.doesNotMatch(
    JSON.stringify(record),
    /b7f25a10|person\+private|password-reset|MAIL_RESET_TOKEN|Private Name|SMTP response/
  );
  assert.equal(pool.poolCalls.length, 1);
  assert.deepEqual(pool.poolCalls[0].params.slice(0, 3), [
    secrets.id,
    'failed',
    8
  ]);
});
