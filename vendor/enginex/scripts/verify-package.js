'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const required = [
  'index.js', 'engine.js', 'engine-legacy.js', 'ai/index.js',
  'lib/dirty-bitset.js', 'lib/performance-profiles.js', 'lib/backend-capabilities.js', 'lib/render-request.js', 'schemas/render-request.schema.json',
  'lib/response-cache.js', 'lib/schema.js', 'schemas/template-grammar.json',
  'schemas/template-manifest.schema.json', 'bin/enginex.js', 'test/engine.test.js',
  'test/fast-renderer.test.js', 'test/v6.2.test.js', 'bench/compare.js', 'bench/paired-benchmark.js', 'optimization/README.md',
  'bench/php-native-bench.php', 'bench/twig-bench.php', 'bench/enginex-php-twig-comparison.json',
  'bench/http-comparison-v6.2-c1.json', 'bench/http-comparison-v6.2-c8.json',
  'docs/ENGINEX-6.2-ARCHITECTURE.md', 'docs/UPDATED-COMPARISON.md', 'RELEASE-MANIFEST.json',
  'optimization/claims-register.json', 'optimization/rollback-manifest.json', 'SECURITY.md', 'THREAT_MODEL.md'
];
const missing = required.filter(item => !fs.existsSync(path.join(root, item)));
if (missing.length) {
  console.error(`Package verification failed; missing files: ${missing.join(', ')}`);
  process.exitCode = 1;
} else if (pkg.version !== require('../engine').version || pkg.version !== require('../index').version) {
  console.error(`Package version mismatch: package=${pkg.version}, engine=${require('../engine').version}, index=${require('../index').version}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, packageVersion: pkg.version, checkedFiles: required.length }, null, 2));
}
