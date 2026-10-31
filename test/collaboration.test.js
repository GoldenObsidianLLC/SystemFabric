'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateCollaborationOperation,
  transformCollaborationOperation,
  applyCollaborationOperation
} = require('../packages/collaboration/src');

function fixture() {
  return {
    schemaVersion: 1,
    documentId: 'page-test',
    type: 'page',
    title: 'Test Page',
    children: [{
      id: 'section-1',
      type: 'section',
      props: {},
      children: [
        { id: 'heading-1', type: 'widget.heading', props: { text: 'Hello', level: 1 }, children: [] },
        { id: 'text-1', type: 'widget.text', props: { text: 'abcdef' }, children: [] },
        { id: 'button-1', type: 'widget.button', props: { text: 'Explore', url: '/explore' }, children: [] },
        { id: 'quote-1', type: 'widget.quote', props: { text: 'A quote', cite: 'Editor' }, children: [] }
      ]
    }]
  };
}

function op(type, payload, overrides = {}) {
  return {
    schemaVersion: 1,
    opId: '11111111-1111-4111-8111-111111111111',
    clientId: 'editor-a',
    baseSequence: 0,
    type,
    payload,
    ...overrides
  };
}

test('validates collaboration envelopes and rejects malformed or oversized inputs', () => {
  const valid = op('document.set_title', { title: 'Updated title' });
  assert.deepEqual(validateCollaborationOperation(valid), { valid: true, errors: [] });
  assert.equal(validateCollaborationOperation({ ...valid, opId: 'not-a-uuid' }).valid, false);
  assert.equal(validateCollaborationOperation({ ...valid, clientId: 'x'.repeat(200) }).valid, false);
  assert.equal(validateCollaborationOperation({ ...valid, baseSequence: -1 }).valid, false);
  assert.equal(validateCollaborationOperation({ ...valid, type: 'document.patch' }).valid, false);
  assert.equal(validateCollaborationOperation({ ...valid, payload: { title: 'x'.repeat(181) } }).valid, false);
});

test('applies title and approved property changes without mutating the input tree', () => {
  const source = fixture();
  const titled = applyCollaborationOperation(source, op('document.set_title', { title: 'New title' }));
  assert.equal(titled.document.title, 'New title');
  assert.equal(source.title, 'Test Page');
  const changed = applyCollaborationOperation(titled.document, op('node.set_prop', {
    nodeId: 'heading-1', key: 'level', value: 2
  }));
  assert.equal(changed.document.children[0].children[0].props.level, 2);
  assert.equal(changed.changed, true);
});

test('inserts, moves, and deletes nodes using stable sibling and parent IDs', () => {
  const source = fixture();
  const inserted = applyCollaborationOperation(source, op('node.insert', {
    parentId: 'section-1',
    afterNodeId: 'heading-1',
    node: { id: 'new-text', type: 'widget.text', props: { text: 'New' }, children: [] }
  }));
  assert.deepEqual(inserted.document.children[0].children.map(node => node.id), [
    'heading-1', 'new-text', 'text-1', 'button-1', 'quote-1'
  ]);
  const moved = applyCollaborationOperation(inserted.document, op('node.move', {
    nodeId: 'button-1', parentId: 'section-1', afterNodeId: 'new-text'
  }));
  assert.deepEqual(moved.document.children[0].children.map(node => node.id), [
    'heading-1', 'new-text', 'button-1', 'text-1', 'quote-1'
  ]);
  const deleted = applyCollaborationOperation(moved.document, op('node.delete', { nodeId: 'new-text' }));
  assert.equal(deleted.document.children[0].children.some(node => node.id === 'new-text'), false);
});

test('rejects moves into descendants and node edits after the target was deleted', () => {
  const source = fixture();
  assert.throws(
    () => applyCollaborationOperation(source, op('node.move', {
      nodeId: 'section-1', parentId: 'section-1', afterNodeId: null
    })),
    error => error.code === 'ERR_SYSTEMFABRIC_OT_CYCLE'
  );
  const deleted = applyCollaborationOperation(source, op('node.delete', { nodeId: 'heading-1' }));
  assert.throws(
    () => applyCollaborationOperation(deleted.document, op('node.set_prop', {
      nodeId: 'heading-1', key: 'text', value: 'Late edit'
    })),
    error => error.code === 'ERR_SYSTEMFABRIC_OT_TARGET_DELETED'
  );
});

test('transforms concurrent inserts at the same stable anchor in accepted sequence order', () => {
  const first = op('node.insert', {
    parentId: 'section-1', afterNodeId: 'heading-1',
    node: { id: 'insert-a', type: 'widget.text', props: { text: 'A' }, children: [] }
  }, { opId: '11111111-1111-4111-8111-111111111111' });
  const second = op('node.insert', {
    parentId: 'section-1', afterNodeId: 'heading-1',
    node: { id: 'insert-b', type: 'widget.text', props: { text: 'B' }, children: [] }
  }, { opId: '22222222-2222-4222-8222-222222222222', clientId: 'editor-b' });
  const transformed = transformCollaborationOperation(second, [{ sequence: 1, operation: first, appliedOperation: first }]);
  assert.equal(transformed.payload.afterNodeId, 'insert-a');
});

test('allows independent property edits and deterministically keeps the later same-key write', () => {
  const level = op('node.set_prop', { nodeId: 'heading-1', key: 'level', value: 2 });
  const text = op('node.set_prop', { nodeId: 'heading-1', key: 'text', value: 'Latest text' }, {
    opId: '22222222-2222-4222-8222-222222222222', clientId: 'editor-b'
  });
  const transformed = transformCollaborationOperation(text, [{ sequence: 1, operation: level }]);
  assert.equal(transformed.payload.key, 'text');
  const first = applyCollaborationOperation(fixture(), level);
  const second = applyCollaborationOperation(first.document, text);
  assert.equal(second.document.children[0].children[0].props.level, 2);
  assert.equal(second.document.children[0].children[0].props.text, 'Latest text');
});

test('transforms same-offset text inserts in accepted sequence order using code-point offsets', () => {
  const first = op('text.insert', { nodeId: 'text-1', key: 'text', offset: 2, text: '😀' });
  const second = op('text.insert', { nodeId: 'text-1', key: 'text', offset: 2, text: 'B' }, {
    opId: '22222222-2222-4222-8222-222222222222', clientId: 'editor-b'
  });
  const transformed = transformCollaborationOperation(second, [{ sequence: 1, operation: first }]);
  assert.equal(transformed.payload.offset, 3);
  const result = applyCollaborationOperation(fixture(), first);
  const next = applyCollaborationOperation(result.document, transformed);
  assert.equal(next.document.children[0].children[1].props.text, 'ab😀Bcdef');
});

test('maps text deletions through prior deletes and preserves Unicode code points', () => {
  const previous = op('text.delete', { nodeId: 'text-1', key: 'text', offset: 1, length: 2 });
  const stale = op('text.delete', { nodeId: 'text-1', key: 'text', offset: 3, length: 2 }, {
    opId: '22222222-2222-4222-8222-222222222222', clientId: 'editor-b'
  });
  const transformed = transformCollaborationOperation(stale, [{ sequence: 1, operation: previous }]);
  assert.deepEqual({ offset: transformed.payload.offset, length: transformed.payload.length }, { offset: 1, length: 2 });

  const unicode = fixture();
  unicode.children[0].children[1].props.text = 'A😀BC';
  const result = applyCollaborationOperation(unicode, op('text.delete', {
    nodeId: 'text-1', key: 'text', offset: 1, length: 1
  }));
  assert.equal(result.document.children[0].children[1].props.text, 'ABC');
});

test('rejects overlapping concurrent text insertions inside a stale delete range', () => {
  const inserted = op('text.insert', { nodeId: 'text-1', key: 'text', offset: 3, text: 'X' });
  const staleDelete = op('text.delete', { nodeId: 'text-1', key: 'text', offset: 1, length: 4 }, {
    opId: '22222222-2222-4222-8222-222222222222', clientId: 'editor-b'
  });
  assert.throws(
    () => transformCollaborationOperation(staleDelete, [{ sequence: 1, operation: inserted }]),
    error => error.code === 'ERR_SYSTEMFABRIC_OT_CONFLICT'
  );
});

test('rejects missing or non-sibling anchors and invalid final documents', () => {
  assert.throws(
    () => applyCollaborationOperation(fixture(), op('node.insert', {
      parentId: 'section-1', afterNodeId: 'missing-node',
      node: { id: 'new-node', type: 'widget.text', props: { text: 'X' }, children: [] }
    })),
    error => error.code === 'ERR_SYSTEMFABRIC_OT_CONFLICT'
  );
  assert.throws(
    () => applyCollaborationOperation(fixture(), op('node.set_prop', {
      nodeId: 'button-1', key: 'url', value: 'javascript:alert(1)'
    })),
    error => error.code === 'ERR_SYSTEMFABRIC_INVALID_DOCUMENT'
  );
});
