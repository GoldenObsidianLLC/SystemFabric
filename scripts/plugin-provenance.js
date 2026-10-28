'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { signPluginArtifact, verifyPluginArtifactSignature, digestForArtifact } = require('../packages/plugins/src/provenance');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = Object.create(null);
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i];
    if (!item.startsWith('--')) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    if (!['artifact','manifest','sbom','source-type','key-id','private-key-file','public-key-file','signature-file'].includes(key)) throw new Error(`Unsupported option: ${item}`);
    if (args[key] !== undefined || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`Missing or duplicate value for ${item}`);
    args[key] = rest[++i];
  }
  const required = command === 'sign' ? ['artifact','manifest','sbom','source-type','key-id','private-key-file'] : command === 'verify' ? ['artifact','manifest','sbom','source-type','key-id','public-key-file','signature-file'] : null;
  if (!required) throw new Error('Usage: node scripts/plugin-provenance.js <sign|verify> --artifact FILE --manifest FILE --sbom FILE --source-type <npm-archive|oci-image> --key-id ID --private-key-file KEY [--public-key-file KEY --signature-file FILE]');
  for (const key of required) if (!args[key]) throw new Error(`Missing required option --${key}`);
  return { command, args };
}
function sha256File(filename) { return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
function readJson(filename) { const value = JSON.parse(fs.readFileSync(filename, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${filename} must contain a JSON object.`); return value; }
function resolveFile(filename) { const full = path.resolve(filename); const stat = fs.statSync(full); if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error(`Artifact must be a regular file no larger than 100 MiB: ${filename}`); return full; }
function main(argv = process.argv.slice(2)) {
  const { command, args } = parseArgs(argv);
  if (!['npm-archive','oci-image'].includes(args['source-type'])) throw new Error('--source-type must be npm-archive or oci-image.');
  const manifest = readJson(args.manifest); const sbomFile = resolveFile(args.sbom);
  const artifactDigest = args['source-type'] === 'oci-image' ? digestForArtifact(args.artifact) : sha256File(resolveFile(args.artifact));
  const sbomDigest = sha256File(sbomFile);
  if (!artifactDigest) throw new Error(args['source-type'] === 'oci-image' ? '--artifact must be an immutable OCI image reference pinned by @sha256:<64 lowercase hex characters>.' : 'Could not compute the plugin artifact SHA-256 digest.');
  if (command === 'sign') {
    const privateKey = fs.readFileSync(resolveFile(args['private-key-file']), 'utf8');
    const signature = signPluginArtifact({ manifest, artifactDigest, sbomDigest, sourceType: args['source-type'], privateKey });
    process.stdout.write(`${JSON.stringify({ algorithm: 'Ed25519', apiVersion: 1, keyId: args['key-id'], sourceType: args['source-type'], artifactDigest, sbomDigest, sbomReference: path.basename(sbomFile), signature }, null, 2)}\n`);
    return;
  }
  const publicKey = fs.readFileSync(resolveFile(args['public-key-file']), 'utf8');
  const signatureRecord = readJson(args['signature-file']);
  const result = verifyPluginArtifactSignature({ manifest, artifactDigest, sbomDigest, sourceType: args['source-type'], keyId: args['key-id'], signature: signatureRecord.signature, trustedKeys: { [args['key-id']]: publicKey } });
  process.stdout.write(`${JSON.stringify({ ...result, artifactDigest, sbomDigest, sourceType: args['source-type'] }, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}

if (require.main === module) { try { main(); } catch (error) { console.error(`Plugin provenance error: ${error.message}`); process.exitCode = 2; } }
module.exports = { parseArgs, sha256File, main };
