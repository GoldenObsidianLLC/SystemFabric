'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const required = [
  'README.md', 'package.json', '.env.example', '.editorconfig', '.nvmrc', 'SystemFabric.code-workspace', '.vscode/settings.json', '.vscode/extensions.json', '.vscode/launch.json', '.vscode/tasks.json', '.devcontainer/devcontainer.json', '.devcontainer/Dockerfile', '.devcontainer/docker-compose.devcontainer.yml', 'docker/postgres/init/01-create-test-db.sh', 'docs/VSCODE-DEV-SETUP.md', 'scripts/setup-dev.js', 'scripts/bootstrap-dev.js', 'scripts/dev-doctor.js', 'scripts/test-integration-live.js', 'scripts/test-memgraph-outage.js', 'docs/RELEASE-EVIDENCE.md', 'scripts/release-readiness.js', 'scripts/release-integration-env.js', 'scripts/release-readiness-validation.js', 'compose.yaml', 'openapi.yaml', 'RELEASE-MANIFEST.json', 'THIRD-PARTY-NOTICES.md', 'docs/LOCAL-VALIDATION.md',
  'docs/SYSTEMFABRIC-MASTER-TECHNICAL-SPECIFICATION.md', 'docs/AI-INTEGRATION.md',
  'docs/SECURITY-AND-THREAT-MODEL.md', 'docs/DATA-MODEL.md', 'docs/API-CONTRACTS.md',
  'docs/IMPLEMENTATION-ROADMAP.md', 'docs/OPERATIONS.md', 'docs/ARCHITECTURE-DECISIONS.md', 'docs/FEATURE-PARITY.md', 'docs/RELEASE-GATE.md', 'docs/PLATFORM-FEATURES.md', 'docs/LIBRARIES-AND-MEDIA.md', 'docs/COMMERCE-AND-MEMBERSHIPS.md', 'docs/CLOUD-INTEGRATIONS.md',
  'database/migrations/0001_initial.sql', 'database/migrations/0002_identity_workflows_plugins.sql', 'database/migrations/0003_identity_editor_ai.sql', 'database/migrations/0004_governance_taxonomy_release.sql', 'database/migrations/0005_saml_shared_cache.sql', 'database/migrations/0006_platform_libraries_commerce_social_billing.sql', 'database/migrations/0007_release_hardening.sql', 'database/migrations/0008_checkout_stock_reservation_lifecycle.sql', 'database/migrations/0009_fix_content_item_slug_constraint.sql', 'database/migrations/0010_outbox_event_contract.sql', 'database/migrations/0011_outbox_legacy_classification_backfill.sql', 'database/migrations/0012_durable_consumer_group_deliveries.sql', 'database/migrations/0013_consumer_group_event_filters.sql', 'database/migrations/0014_collaborative_document_operations.sql', 'scripts/migrate.js', 'scripts/migration-checksum.js', 'scripts/plugin-provenance.js', 'playwright.config.js', '.github/workflows/ci.yml', 'test/security-boundaries.test.js', 'test/platform-features.test.js', 'test/checkout-idempotency.test.js', 'test/checkout-reconciliation.test.js', 'test/community-workflows.test.js', 'test/stock-reservations.test.js', 'test/stripe-checkout.test.js', 'test/integration/community-workflows.integration.test.js', 'test/integration/commerce-reservations.integration.test.js', 'test/integration/postgres.integration.test.js', 'test/integration/memgraph.integration.test.js', 'test/release-hardening.test.js', 'test/release-integration-env.test.js', 'test/release-readiness-validation.test.js', 'test/e2e/editor.spec.js', 'test/e2e/accessibility.spec.js', 'packages/auth/src/saml.js', 'packages/auth/src/pg-saml-cache.js', 'packages/plugins/src/provenance.js', 'packages/media/src/s3-store.js', 'schemas/page-document.schema.json', 'apps/admin/assets/studio.js', 'apps/admin/assets/studio.css', 'apps/worker/src/scheduler.js', 'apps/worker/src/outbox-worker.js', 'apps/plugin-runner/src/server.js', 'packages/auth/src/service.js', 'packages/domain/src/content-types.js', 'packages/media/src/local-store.js', 'packages/plugins/src/archive-inspector.js', 'packages/plugins/src/container-runner.js', 'packages/plugins/src/remote-runner.js',
  'packages/domain/src/page-document.js', 'packages/domain/src/navigation.js', 'packages/render/src/index.js', 'packages/library/src/file-store.js', 'packages/icons/src/catalog.js', 'packages/math/src/renderer.js', 'packages/media/src/optimizer.js', 'packages/commerce/src/validation.js', 'packages/commerce/src/stock-reservations.js', 'packages/community/src/validation.js', 'packages/community/src/workflows.js', 'packages/security/src/firewall.js', 'packages/security/src/malware-scanner.js', 'packages/library/src/reconcile-local-objects.js', 'scripts/reconcile-library-objects.js', 'packages/cloud/src/storage-adapters.js', 'packages/billing/src/stripe.js', 'packages/billing/src/checkout-reconciliation.js',
  'packages/ai/src/service.js', 'packages/ai/src/provider-factory.js', 'packages/ai/src/config.js',
  'packages/db/src/postgres-store.js', 'packages/db/src/outbox-worker.js', 'packages/db/src/outbox-delivery.js', 'packages/db/src/relationship-store.js',
  'packages/realtime/src/index.js', 'packages/realtime/src/event-hub.js', 'packages/realtime/src/presence.js', 'packages/realtime/src/redis-presence.js', 'packages/realtime/src/redis-realtime.js', 'packages/realtime/src/sse-gateway.js', 'packages/realtime/src/event-contract.js',
  'test/migrations.test.js', 'test/realtime.test.js', 'test/redis-presence.test.js', 'test/redis-realtime.test.js', 'test/integration/redis-presence.integration.test.js', 'test/outbox-contract.test.js', 'test/outbox-delivery.test.js', 'test/graph-projection-worker.test.js', 'test/memgraph-projector.test.js', 'docs/REALTIME-FOUNDATION-F1.md', 'docs/REALTIME-AI-ARCHITECTURE.md',
  'packages/graph/src/memgraph-store.js', 'packages/graph/src/rebuild-projection.js', 'apps/api/src/server.js', 'apps/mcp/src/server.mjs',
  'apps/admin/index.html', 'apps/admin/platform.html', 'apps/admin/assets/platform.js', 'apps/admin/assets/platform.css', 'vendor/enginex/package.json'
];
const missing = required.filter(file => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error(`Missing required artifacts:\n${missing.map(file => ` - ${file}`).join('\n')}`);
  process.exit(1);
}
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseManifest = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE-MANIFEST.json'), 'utf8'));
if (releaseManifest.version !== packageJson.version) throw new Error(`Release manifest version ${releaseManifest.version} does not match package version ${packageJson.version}`);
if (packageJson.version !== '0.5.1') throw new Error(`Expected SystemFabric 0.5.1, got ${packageJson.version}`);
const vendorJson = JSON.parse(fs.readFileSync(path.join(root, 'vendor/enginex/package.json'), 'utf8'));
if (vendorJson.version !== '6.2.0') throw new Error(`Expected vendored EnginEx 6.2.0, got ${vendorJson.version}`);
if (packageJson.engines?.node !== vendorJson.engines?.node) throw new Error('SystemFabric Node minimum must match vendored EnginEx minimum.');

function walk(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else if (/\.(?:js|mjs)$/.test(entry.name)) result.push(full);
  }
  return result;
}
const jsFiles = walk(root);
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`Syntax check failed: ${path.relative(root, file)}\n${result.stderr || result.stdout}`);
    process.exit(1);
  }
}
for (const file of [
  'schemas/page-document.schema.json', 'schemas/cpt-definition.schema.json', 'schemas/widget-manifest.schema.json', 'schemas/plugin-manifest.schema.json',
  'config/cpt/article.json', 'config/widgets/core.widgets.json', 'RELEASE-MANIFEST.json'
]) JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

const current = process.versions.node.split('.').map(Number);
const minimum = [22, 23, 4];
const tooOld = current.some((part, index) => part !== minimum[index] && (index === 0 ? part < minimum[index] : current.slice(0, index).every((v, i) => v === minimum[i]) && part < minimum[index]));
console.log(`SystemFabric artifact check passed (${required.length} required paths, ${jsFiles.length} JavaScript files syntax-checked).`);
console.log(`Vendored EnginEx version: ${vendorJson.version}; required Node.js: ${vendorJson.engines.node}; current Node.js: ${process.versions.node}.`);
if (tooOld) console.warn('WARNING: current runtime is below the declared minimum; results are development checks only, not supported-runtime validation.');
console.log('Database migrations, Memgraph Cypher, live provider calls, and production security are not validated by this script.');
