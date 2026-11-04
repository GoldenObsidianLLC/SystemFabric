'use strict';

// package.json is the single source of truth for the application version.
const { version } = require('../../../package.json');

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new TypeError('VirgoScorpio Hub package version must use Semantic Versioning.');
}

module.exports = { PRODUCT_VERSION: version };
