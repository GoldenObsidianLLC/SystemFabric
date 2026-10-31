'use strict';

const { Buffer } = require('node:buffer');
const {
  CONTAINER_TYPES,
  TYPE_PROPS,
  validatePageDocument
} = require('../../domain/src/page-document');

const MAX_OPERATION_BYTES = 12 * 1024;
const OPERATION_TYPES = new Set([
  'document.set_title',
  'node.insert',
  'node.delete',
  'node.move',
  'node.set_prop',
  'text.insert',
  'text.delete'
]);
const TEXT_NODE_TYPES = new Set([
  'widget.heading',
  'widget.text',
  'widget.button',
  'widget.quote'
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownKeysMatch(value, allowed) {
  return Object.keys(value).every(key => allowed.includes(key));
}

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'ERR_SYSTEMFABRIC_INVALID_COLLABORATION_OPERATION';
  return error;
}

function conflict(message, code = 'ERR_SYSTEMFABRIC_OT_CONFLICT') {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = code;
  return error;
}

function validateCollaborationOperation(operation) {
  const errors = [];
  if (!isPlainObject(operation)) return { valid: false, errors: ['operation must be an object'] };

  if (operation.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof operation.opId !== 'string' || !UUID_PATTERN.test(operation.opId)) errors.push('opId must be a UUID');
  if (typeof operation.clientId !== 'string' || !CLIENT_ID_PATTERN.test(operation.clientId)) errors.push('clientId must be 1–80 safe characters');
  if (!Number.isSafeInteger(operation.baseSequence) || operation.baseSequence < 0) errors.push('baseSequence must be a non-negative safe integer');
  if (!OPERATION_TYPES.has(operation.type)) errors.push('type is not supported');
  if (!isPlainObject(operation.payload)) errors.push('payload must be an object');

  if (errors.length === 0) {
    const payload = operation.payload;
    switch (operation.type) {
      case 'document.set_title':
        if (!ownKeysMatch(payload, ['title']) || typeof payload.title !== 'string' || payload.title.trim().length < 1 || payload.title.length > 180) {
          errors.push('document.set_title payload requires a title of 1–180 characters');
        }
        break;
      case 'node.insert':
        if (!ownKeysMatch(payload, ['node', 'parentId', 'afterNodeId']) || !isPlainObject(payload.node)) errors.push('node.insert payload is invalid');
        if (payload.parentId !== null && (typeof payload.parentId !== 'string' || !NODE_ID_PATTERN.test(payload.parentId))) errors.push('node.insert parentId is invalid');
        if (payload.afterNodeId !== null && (typeof payload.afterNodeId !== 'string' || !NODE_ID_PATTERN.test(payload.afterNodeId))) errors.push('node.insert afterNodeId is invalid');
        break;
      case 'node.delete':
        if (!ownKeysMatch(payload, ['nodeId']) || typeof payload.nodeId !== 'string' || !NODE_ID_PATTERN.test(payload.nodeId)) errors.push('node.delete nodeId is invalid');
        break;
      case 'node.move':
        if (!ownKeysMatch(payload, ['nodeId', 'parentId', 'afterNodeId']) || typeof payload.nodeId !== 'string' || !NODE_ID_PATTERN.test(payload.nodeId)) errors.push('node.move nodeId is invalid');
        if (payload.parentId !== null && (typeof payload.parentId !== 'string' || !NODE_ID_PATTERN.test(payload.parentId))) errors.push('node.move parentId is invalid');
        if (payload.afterNodeId !== null && (typeof payload.afterNodeId !== 'string' || !NODE_ID_PATTERN.test(payload.afterNodeId))) errors.push('node.move afterNodeId is invalid');
        break;
      case 'node.set_prop':
        if (!ownKeysMatch(payload, ['nodeId', 'key', 'value']) || typeof payload.nodeId !== 'string' || !NODE_ID_PATTERN.test(payload.nodeId)) errors.push('node.set_prop nodeId is invalid');
        if (typeof payload.key !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,49}$/.test(payload.key)) errors.push('node.set_prop key is invalid');
        if (!Object.hasOwn(payload, 'value')) errors.push('node.set_prop value is required');
        break;
      case 'text.insert':
        if (!ownKeysMatch(payload, ['nodeId', 'key', 'offset', 'text']) || typeof payload.nodeId !== 'string' || !NODE_ID_PATTERN.test(payload.nodeId)) errors.push('text.insert nodeId is invalid');
        if (typeof payload.key !== 'string' || !['text', 'cite'].includes(payload.key)) errors.push('text.insert key is invalid');
        if (!Number.isSafeInteger(payload.offset) || payload.offset < 0) errors.push('text.insert offset must be a non-negative integer');
        if (typeof payload.text !== 'string' || payload.text.length < 1 || payload.text.length > 10_000) errors.push('text.insert text must contain 1–10000 UTF-16 code units');
        break;
      case 'text.delete':
        if (!ownKeysMatch(payload, ['nodeId', 'key', 'offset', 'length']) || typeof payload.nodeId !== 'string' || !NODE_ID_PATTERN.test(payload.nodeId)) errors.push('text.delete nodeId is invalid');
        if (typeof payload.key !== 'string' || !['text', 'cite'].includes(payload.key)) errors.push('text.delete key is invalid');
        if (!Number.isSafeInteger(payload.offset) || payload.offset < 0) errors.push('text.delete offset must be a non-negative integer');
        if (!Number.isSafeInteger(payload.length) || payload.length < 1) errors.push('text.delete length must be a positive integer');
        break;
      default:
        errors.push('type is not supported');
    }

    try {
      if (Buffer.byteLength(JSON.stringify(operation), 'utf8') > MAX_OPERATION_BYTES) errors.push('operation exceeds the 12 KiB envelope limit');
    } catch {
      errors.push('operation must be JSON serializable');
    }
  }

  return { valid: errors.length === 0, errors };
}

function assertValidOperation(operation) {
  const result = validateCollaborationOperation(operation);
  if (!result.valid) throw invalid(result.errors.join('; '));
}

function clone(value) {
  return structuredClone(value);
}

function findNode(document, nodeId, parent = null, siblings = document.children) {
  if (!Array.isArray(siblings)) return null;
  for (let index = 0; index < siblings.length; index += 1) {
    const node = siblings[index];
    if (node && node.id === nodeId) return { node, parent, siblings, index };
    const nested = findNode(document, nodeId, node, node?.children);
    if (nested) return nested;
  }
  return null;
}

function getContainer(document, parentId) {
  if (parentId === null) return { node: null, children: document.children };
  const found = findNode(document, parentId);
  if (!found) throw conflict('The destination parent no longer exists.');
  if (!CONTAINER_TYPES.has(found.node.type)) throw conflict('The destination parent cannot contain child nodes.');
  return { node: found.node, children: found.node.children };
}

function insertIndex(siblings, afterNodeId) {
  if (afterNodeId === null) return 0;
  const index = siblings.findIndex(node => node.id === afterNodeId);
  if (index < 0) throw conflict('The sibling anchor no longer exists in the destination parent.');
  return index + 1;
}

function isWithin(node, ancestorId) {
  if (!node || typeof node !== 'object') return false;
  if (node.id === ancestorId) return true;
  return Array.isArray(node.children) && node.children.some(child => isWithin(child, ancestorId));
}

function acceptedParts(item) {
  const original = item?.operation || item?.originalOperation || item;
  const applied = item?.appliedOperation || item?.transformedOperation || original;
  return { original, applied };
}

function codePointLength(value) {
  return Array.from(value).length;
}

function mapPointThroughDelete(point, start, length) {
  const end = start + length;
  if (point <= start) return point;
  if (point >= end) return point - length;
  return start;
}

function transformCollaborationOperation(operation, acceptedOperations = []) {
  assertValidOperation(operation);
  if (!Array.isArray(acceptedOperations)) throw new TypeError('acceptedOperations must be an array');

  const transformed = clone(operation);
  const ordered = acceptedOperations
    .map((item, index) => ({ item, index, sequence: Number(item?.sequence ?? index + 1) }))
    .sort((a, b) => a.sequence - b.sequence || a.index - b.index);

  if (transformed.type === 'node.insert') {
    const { parentId, afterNodeId } = transformed.payload;
    let lastSiblingInAnchorGroup = null;
    for (const { item } of ordered) {
      const { original, applied } = acceptedParts(item);
      if (original?.type !== 'node.insert' || applied?.type !== 'node.insert') continue;
      if (original.payload?.parentId === parentId && original.payload?.afterNodeId === afterNodeId) {
        lastSiblingInAnchorGroup = applied.payload?.node?.id || null;
      }
    }
    if (lastSiblingInAnchorGroup) transformed.payload.afterNodeId = lastSiblingInAnchorGroup;
  }

  if (transformed.type === 'text.insert' || transformed.type === 'text.delete') {
    let offset = transformed.payload.offset;
    let length = transformed.type === 'text.delete' ? transformed.payload.length : null;

    for (const { item } of ordered) {
      const { applied } = acceptedParts(item);
      const previous = applied;
      if (!previous || !['text.insert', 'text.delete'].includes(previous.type)) continue;
      if (previous.payload?.nodeId !== transformed.payload.nodeId || previous.payload?.key !== transformed.payload.key) continue;

      const previousOffset = previous.payload.offset;
      if (!Number.isSafeInteger(previousOffset) || previousOffset < 0) continue;

      if (transformed.type === 'text.insert') {
        if (previous.type === 'text.insert') {
          if (previousOffset <= offset) offset += codePointLength(previous.payload.text);
        } else {
          offset = mapPointThroughDelete(offset, previousOffset, previous.payload.length);
        }
      } else if (previous.type === 'text.insert') {
        const insertedLength = codePointLength(previous.payload.text);
        const end = offset + length;
        if (previousOffset <= offset) {
          offset += insertedLength;
        } else if (previousOffset < end) {
          throw conflict('A concurrent insertion falls inside the stale delete range.', 'ERR_SYSTEMFABRIC_OT_CONFLICT');
        }
      } else {
        const mappedStart = mapPointThroughDelete(offset, previousOffset, previous.payload.length);
        const mappedEnd = mapPointThroughDelete(offset + length, previousOffset, previous.payload.length);
        offset = mappedStart;
        length = Math.max(0, mappedEnd - mappedStart);
      }
    }

    transformed.payload.offset = offset;
    if (transformed.type === 'text.delete') transformed.payload.length = length;
  }

  return transformed;
}

function applyCollaborationOperation(document, operation) {
  if (!document || typeof document !== 'object') throw invalid('document must be an object');
  assertValidOperation(operation);
  const next = clone(document);
  const appliedOperation = clone(operation);
  const payload = appliedOperation.payload;

  switch (appliedOperation.type) {
    case 'document.set_title':
      next.title = payload.title;
      break;
    case 'node.insert': {
      const destination = getContainer(next, payload.parentId);
      const index = insertIndex(destination.children, payload.afterNodeId);
      destination.children.splice(index, 0, clone(payload.node));
      break;
    }
    case 'node.delete': {
      const target = findNode(next, payload.nodeId);
      if (!target) throw conflict('The operation target was deleted.', 'ERR_SYSTEMFABRIC_OT_TARGET_DELETED');
      target.siblings.splice(target.index, 1);
      break;
    }
    case 'node.move': {
      const target = findNode(next, payload.nodeId);
      if (!target) throw conflict('The operation target was deleted.', 'ERR_SYSTEMFABRIC_OT_TARGET_DELETED');
      const destination = getContainer(next, payload.parentId);
      if (destination.node && isWithin(target.node, destination.node.id)) {
        throw conflict('A node cannot be moved into itself or one of its descendants.', 'ERR_SYSTEMFABRIC_OT_CYCLE');
      }
      if (payload.afterNodeId === payload.nodeId) throw conflict('A node cannot be positioned after itself.');
      target.siblings.splice(target.index, 1);
      const index = insertIndex(destination.children, payload.afterNodeId);
      destination.children.splice(index, 0, target.node);
      break;
    }
    case 'node.set_prop': {
      const target = findNode(next, payload.nodeId);
      if (!target) throw conflict('The operation target was deleted.', 'ERR_SYSTEMFABRIC_OT_TARGET_DELETED');
      if (!TYPE_PROPS[target.node.type]?.has(payload.key)) throw conflict('The property is not approved for this node type.');
      target.node.props[payload.key] = clone(payload.value);
      break;
    }
    case 'text.insert':
    case 'text.delete': {
      const target = findNode(next, payload.nodeId);
      if (!target) throw conflict('The operation target was deleted.', 'ERR_SYSTEMFABRIC_OT_TARGET_DELETED');
      const { type } = target.node;
      const { key, offset } = payload;
      if (!TEXT_NODE_TYPES.has(type) || !TYPE_PROPS[type]?.has(key) || (key === 'cite' && type !== 'widget.quote')) {
        throw conflict('Text operations are not allowed for this node property.');
      }
      const current = target.node.props?.[key];
      if (typeof current !== 'string') throw conflict('The target text property no longer contains a string.');
      const points = Array.from(current);
      if (offset > points.length) throw conflict('The text offset is outside the current property.');
      if (appliedOperation.type === 'text.insert') {
        points.splice(offset, 0, ...Array.from(payload.text));
      } else {
        if (offset + payload.length > points.length) throw conflict('The text deletion range is outside the current property.');
        points.splice(offset, payload.length);
      }
      target.node.props[key] = points.join('');
      break;
    }
    default:
      throw invalid('Unsupported collaboration operation.');
  }

  const validation = validatePageDocument(next);
  if (!validation.valid) {
    const error = new Error(`Operation would create an invalid page document: ${validation.errors.join('; ')}`);
    error.statusCode = 422;
    error.code = 'ERR_SYSTEMFABRIC_INVALID_DOCUMENT';
    error.details = validation.errors;
    throw error;
  }

  return {
    document: next,
    appliedOperation,
    changed: JSON.stringify(next) !== JSON.stringify(document)
  };
}

module.exports = {
  MAX_OPERATION_BYTES,
  OPERATION_TYPES,
  validateCollaborationOperation,
  transformCollaborationOperation,
  applyCollaborationOperation,
  conflict
};
