'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'docs/security/tenant-isolation-route-inventory.catalog.json');
const JSON_OUTPUT = path.join(ROOT, 'artifacts/security/tenant-isolation-route-inventory.json');
const MARKDOWN_OUTPUT = path.join(ROOT, 'docs/security/TENANT-ISOLATION-ROUTE-CAPABILITY-MAP-2026-11-07.md');
const METHOD_CODES = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'WORKER', 'SERVICE', 'CLI']);

function repoFile(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') || path.posix.isAbsolute(relativePath) ||
      relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe repository-relative path in tenant inventory: ' + String(relativePath));
  }
  const absolute = path.resolve(ROOT, ...relativePath.split('/'));
  if (!absolute.startsWith(ROOT + path.sep)) throw new Error('Inventory path escapes repository root.');
  return absolute;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function digestFiles(files) {
  const hash = crypto.createHash('sha256');
  const unique = [...new Set(files)].sort();
  for (const relativePath of unique) {
    const bytes = fs.readFileSync(repoFile(relativePath));
    hash.update(relativePath, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(sha256(bytes), 'utf8');
    hash.update(Buffer.from([10]));
  }
  return { fileCount: unique.length, sha256: hash.digest('hex'), files: unique };
}

function validateAndEnrich(catalog) {
  if (!catalog || catalog.catalogVersion !== 1 || !Array.isArray(catalog.families) || !Array.isArray(catalog.commonControls)) {
    throw new Error('Tenant route inventory catalog has an unsupported shape/version.');
  }
  const ids = new Set();
  const implementationFiles = [];
  const testFiles = [];
  const families = catalog.families.map(family => {
    if (!family || typeof family.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(family.id) || ids.has(family.id)) {
      throw new Error('Tenant route inventory family IDs must be unique kebab-case identifiers.');
    }
    ids.add(family.id);
    if (!family.title || !family.authentication || !family.siteContext || !Array.isArray(family.routePatterns) ||
        !Array.isArray(family.methods) || family.methods.length === 0 || family.methods.some(method => !METHOD_CODES.has(method)) ||
        !Array.isArray(family.capabilities) || !Array.isArray(family.dataAccess) || !Array.isArray(family.sideEffects) ||
        !Array.isArray(family.sourceRefs) || !Array.isArray(family.tests) || !family.coverage) {
      throw new Error('Tenant route inventory family is incomplete: ' + family.id);
    }
    if (family.routePatterns.some(route => typeof route !== 'string' || !route)) {
      throw new Error('Invalid route pattern in family ' + family.id);
    }
    if (family.routePatterns.some(route => !route.startsWith('/') && !route.startsWith('CLI:') && !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+\//.test(route))) {
      throw new Error('Route patterns must be paths, method-prefixed paths, or CLI entries in family ' + family.id);
    }
    const sourceRefs = family.sourceRefs.map(reference => {
      if (!reference || !Array.isArray(reference.anchors) || reference.anchors.length === 0) {
        throw new Error('Source refs require at least one exact anchor in family ' + family.id);
      }
      const text = fs.readFileSync(repoFile(reference.file), 'utf8');
      const lines = text.split(/\r?\n/);
      const resolvedAnchors = reference.anchors.map(anchor => {
        const lineNumbers = [];
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].includes(anchor)) lineNumbers.push(index + 1);
        }
        if (lineNumbers.length === 0) {
          throw new Error('Source anchor not found: ' + reference.file + ' :: ' + anchor + ' (' + family.id + ')');
        }
        return { anchor, lines: lineNumbers };
      });
      implementationFiles.push(reference.file);
      return { file: reference.file, anchors: resolvedAnchors };
    });
    const tests = family.tests.map(testPath => {
      const absolute = repoFile(testPath);
      if (!fs.statSync(absolute).isFile()) throw new Error('Test reference is not a file: ' + testPath);
      testFiles.push(testPath);
      return testPath;
    });
    return { ...family, sourceRefs, tests };
  });

  const commonControls = catalog.commonControls.map(control => {
    const sourceRefs = control.sourceRefs.map(reference => {
      const text = fs.readFileSync(repoFile(reference.file), 'utf8');
      const lines = text.split(/\r?\n/);
      const anchors = reference.anchors.map(anchor => {
        const matches = [];
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].includes(anchor)) matches.push(index + 1);
        }
        if (!matches.length) throw new Error('Common-control source anchor not found: ' + reference.file + ' :: ' + anchor);
        return { anchor, lines: matches };
      });
      implementationFiles.push(reference.file);
      return { file: reference.file, anchors };
    });
    const tests = (control.tests || []).map(testPath => {
      repoFile(testPath);
      testFiles.push(testPath);
      return testPath;
    });
    return { ...control, sourceRefs, tests };
  });

  const enriched = {
    schemaVersion: 1,
    product: catalog.product,
    purpose: catalog.purpose,
    status: catalog.status,
    notAnIndependentAssessment: true,
    scopeNote: catalog.scopeNote,
    generatedBy: 'scripts/generate-tenant-isolation-route-inventory.js',
    sourceTree: digestFiles(implementationFiles),
    testTree: digestFiles(testFiles),
    summary: {
      routeFamilyCount: families.length,
      httpRouteFamilyCount: families.filter(family => family.routePatterns.some(route => route.startsWith('/') || /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+\//.test(route))).length,
      nonHttpFamilyCount: families.filter(family => family.routePatterns.some(route => route.startsWith('CLI:')) || family.routePatterns.length === 0).length,
      declaredRoutePatternCount: families.reduce((total, family) => total + family.routePatterns.length, 0),
      sourceFileCount: new Set(implementationFiles).size,
      testFileCount: new Set(testFiles).size
    },
    commonControls,
    families
  };
  return enriched;
}

function sourceLink(reference) {
  const lineNumbers = [...new Set(reference.anchors.flatMap(anchor => anchor.lines))].sort((a, b) => a - b);
  return reference.file + (lineNumbers.length ? ' (lines ' + lineNumbers.join(', ') + ')' : '');
}

function renderMarkdown(inventory) {
  const lines = [
    '# VirgoScorpio Hub 0.6.2 - Tenant-Isolation Route and Data-Access Inventory',
    '',
    '> **MAINTAINER-GENERATED PREPARATION ONLY. NOT AN INDEPENDENT REVIEW, SECURITY OPINION, PASS, OR RELEASE EVIDENCE.**',
    '',
    inventory.purpose,
    '',
    '## Status and provenance',
    '',
    '- Status: MAINTAINER_PREPARED_NOT_INDEPENDENTLY_REVIEWED.',
    '- Generated from the current working-tree implementation anchors and the catalog at docs/security/tenant-isolation-route-inventory.catalog.json.',
    '- Implementation-source digest: ' + inventory.sourceTree.sha256 + ' across ' + inventory.sourceTree.fileCount + ' files.',
    '- Referenced-test digest: ' + inventory.testTree.sha256 + ' across ' + inventory.testTree.fileCount + ' files.',
    '- Inventory size: ' + inventory.summary.routeFamilyCount + ' route/flow families, ' + inventory.summary.declaredRoutePatternCount + ' declared route patterns, ' + inventory.summary.sourceFileCount + ' source files, and ' + inventory.summary.testFileCount + ' test files.',
    '- Regenerate with npm run security:tenant-inventory; CI checks freshness with node scripts/generate-tenant-isolation-route-inventory.js --check.',
    '',
    inventory.scopeNote,
    '',
    'The source digests identify the exact implementation and test file contents represented by this catalog. They are not a substitute for the independent reviewer recording the full Git commit SHA, clean checkout, runtime environment, and exact review scope.',
    '',
    '## 1. How to interpret this inventory',
    '',
    '- Route patterns and control descriptions are curated maintainer metadata, not automatically inferred proofs that every matching method follows the stated policy.',
    '- The generator verifies each declared source anchor and test-file reference and refreshes line numbers. It does not prove all registered routes or reverse-proxy paths are cataloged.',
    '- A test-file reference means that a relevant test file exists; it does not assert that every listed scenario is covered or passed on the reviewed revision.',
    '- Data-access and side-effect lists are navigation hints. The independent reviewer must trace each request through SQL, transactions, object storage, provider callbacks, outbox, workers, graph, caches and realtime delivery.',
    '- A public/anonymous endpoint still requires explicit site binding, publication/visibility checks, and non-disclosing behavior.',
    '',
    '## 2. Shared request and authorization controls',
    ''
  ];
  for (const control of inventory.commonControls) {
    lines.push('### ' + control.name, '', control.description, '', 'Source: ' + control.sourceRefs.map(sourceLink).join('; '), '', 'Tests: ' + (control.tests.length ? control.tests.join(', ') : 'No test file referenced.'), '');
  }
  lines.push('## 3. Route-family inventory', '');
  for (const [index, family] of inventory.families.entries()) {
    lines.push('### ' + (index + 1) + '. ' + family.title, '');
    lines.push('- Inventory ID: ' + family.id);
    lines.push('- Methods (family-level union): ' + family.methods.join(', '));
    lines.push('- Routes/flows: ' + (family.routePatterns.length ? family.routePatterns.join('; ') : 'Non-HTTP processing flow.'));
    lines.push('- Authentication: ' + family.authentication);
    lines.push('- Tenant/site context: ' + family.siteContext);
    lines.push('- Capabilities/controls: ' + (family.capabilities.length ? family.capabilities.join(', ') : 'No route-specific capability declared in this catalog.'));
    lines.push('- Data-access boundary: ' + family.dataAccess.join('; '));
    lines.push('- Side effects: ' + family.sideEffects.join('; '));
    lines.push('- Source: ' + family.sourceRefs.map(sourceLink).join('; '));
    lines.push('- Test references: ' + (family.tests.length ? family.tests.join(', ') : 'None located in the current catalog.'));
    lines.push('- Coverage characterization: **' + family.coverage.level + '**. ' + family.coverage.limits);
    lines.push('');
  }
  lines.push(
    '## 4. Mandatory independent-review work',
    '',
    '1. Independently enumerate the deployed HTTP routes, methods, middleware, reverse-proxy rewrites, public assets, worker entry points and operational/admin paths. Compare that enumeration with this curated catalog and add omitted surfaces to the review report.',
    '2. For each route/method, record authentication/session source, actor memberships/roles, all site selectors, tenant derivation, route capability and ownership policy, object lookup, SQL predicates/joins, transactions, cache keys, object-storage keys, event envelopes, provider calls and response redaction.',
    '3. Build synthetic site A/site B fixtures with A-only, B-only, multi-site actors with differing capabilities, and privileged actors. Exercise list/read/create/update/delete/history/export/download, same-ID and foreign-ID cases, malformed/conflicting selectors and positive controls.',
    '4. For denied operations, compare database rows, versions, audit, outbox/delivery, graph, cache, notification/realtime state, stored bytes and provider calls before/after. Include async replay, worker retries, reconnect and authorization revocation.',
    '5. Record each test/procedure as pass, fail, not run or not applicable with rationale. Preserve exact environment, sanitized artifacts, limitations and findings privately where exploit detail is sensitive.',
    '6. Populate artifacts/evidence/tenant-isolation-review.json only after an independent reviewer has completed the exact-commit review and accepted all issue #14 criteria. This generated inventory must never be copied into the formal evidence path as a substitute.',
    '',
    '## 5. Release disposition',
    '',
    '**Issue #14 remains OPEN / NOT PERFORMED.** This inventory is maintainer-prepared navigation and coverage planning only. It does not close the independent tenant/site isolation review, the broader security assessment in issue #25, or any release gate. VirgoScorpio Hub remains **NO-GO / NOT_PRODUCTION_CERTIFIED**.',
    '',
    'No reviewer approval, risk acceptance, production readiness, release, publication, or deployment is inferred by this document.',
    ''
  );
  return lines.join('\n');
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const inventory = validateAndEnrich(catalog);
  const jsonText = JSON.stringify(inventory, null, 2) + '\n';
  const markdownText = renderMarkdown(inventory);
  if (process.argv.includes('--check')) {
    const mismatches = [];
    for (const [file, expected] of [[JSON_OUTPUT, jsonText], [MARKDOWN_OUTPUT, markdownText]]) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== expected) mismatches.push(path.relative(ROOT, file));
    }
    if (mismatches.length) {
      console.error('Tenant-isolation inventory is stale. Run npm run security:tenant-inventory. Files: ' + mismatches.join(', '));
      process.exitCode = 1;
      return;
    }
    console.log('Tenant-isolation inventory is current (' + inventory.summary.routeFamilyCount + ' families, source SHA-256 ' + inventory.sourceTree.sha256 + ').');
    return;
  }
  fs.mkdirSync(path.dirname(JSON_OUTPUT), { recursive: true });
  fs.mkdirSync(path.dirname(MARKDOWN_OUTPUT), { recursive: true });
  fs.writeFileSync(JSON_OUTPUT, jsonText, 'utf8');
  fs.writeFileSync(MARKDOWN_OUTPUT, markdownText, 'utf8');
  console.log('Generated tenant-isolation inventory: ' + inventory.summary.routeFamilyCount + ' families, ' + inventory.summary.declaredRoutePatternCount + ' declared route patterns, ' + inventory.summary.sourceFileCount + ' source files, ' + inventory.summary.testFileCount + ' test files.');
}

main();
