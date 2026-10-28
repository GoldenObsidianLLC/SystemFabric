'use strict';

function cloudEndpointAllowed(endpoint, env = process.env) {
  if (!endpoint) return true;
  let parsed;
  try { parsed = new URL(endpoint); } catch { return false; }
  if (!['http:','https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  if (String(env.NODE_ENV || '').toLowerCase() !== 'production') return true;
  if (parsed.protocol !== 'https:') return false;
  const allow = String(env.SYSTEMFABRIC_CLOUD_ENDPOINT_ALLOWLIST || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  // Exact authority matching (hostname and optional port). No wildcard suffixes.
  return allow.includes(parsed.host.toLowerCase());
}

function cloudError(message, code = 'ERR_SYSTEMFABRIC_CLOUD_CONFIG') { const error = new Error(message); error.code = code; return error; }
function createS3CompatibleAdapter({ bucket, client, commands, provider = 's3-compatible' }) {
  if (!bucket || !client?.send || !commands?.PutObjectCommand || !commands?.GetObjectCommand || !commands?.DeleteObjectCommand) throw cloudError('S3-compatible adapter requires bucket, client, and Put/Get/Delete command constructors.');
  return Object.freeze({ provider,
    async probe() { if (typeof commands.HeadBucketCommand !== 'function') throw cloudError('S3 SDK does not expose HeadBucketCommand.', 'ERR_SYSTEMFABRIC_CLOUD_PROBE_UNAVAILABLE'); await client.send(new commands.HeadBucketCommand({ Bucket: bucket })); return { provider, ok: true, operation: 'HeadBucket' }; },
    async putObject({ key, body, contentType }) { await client.send(new commands.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length, ServerSideEncryption: 'AES256' })); },
    async getObject({ key }) { const result = await client.send(new commands.GetObjectCommand({ Bucket: bucket, Key: key })); return bodyToBuffer(result.Body); },
    async deleteObject({ key }) { await client.send(new commands.DeleteObjectCommand({ Bucket: bucket, Key: key })); }
  });
}
async function bodyToBuffer(body, maxBytes = 52 * 1024 * 1024) {
  if (Buffer.isBuffer(body)) { if (body.length > maxBytes) throw cloudError('Downloaded object exceeds the byte limit.', 'ERR_SYSTEMFABRIC_CLOUD_SIZE_LIMIT'); return body; }
  if (body && typeof body.transformToByteArray === 'function') { const out = Buffer.from(await body.transformToByteArray()); if (out.length > maxBytes) throw cloudError('Downloaded object exceeds the byte limit.', 'ERR_SYSTEMFABRIC_CLOUD_SIZE_LIMIT'); return out; }
  const chunks=[]; let size=0;
  if (body && body[Symbol.asyncIterator]) for await (const chunk of body) { size+=chunk.length; if (size>maxBytes) throw cloudError('Downloaded object exceeds the byte limit.','ERR_SYSTEMFABRIC_CLOUD_SIZE_LIMIT'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
function createGoogleCloudStorageAdapter({ bucket, provider = 'gcs' }) {
  if (!bucket || typeof bucket.file !== 'function') throw cloudError('Google Cloud Storage adapter requires an authenticated bucket client.');
  return Object.freeze({ provider,
    async probe() { if (typeof bucket.getMetadata !== 'function') throw cloudError('Google Cloud Storage bucket metadata probe is unavailable.', 'ERR_SYSTEMFABRIC_CLOUD_PROBE_UNAVAILABLE'); await bucket.getMetadata(); return { provider, ok: true, operation: 'GetBucketMetadata' }; },
    async putObject({ key, body, contentType }) { await bucket.file(key).save(body, { resumable: false, validation: 'crc32c', metadata: { contentType, cacheControl: 'private, no-store' }, preconditionOpts: { ifGenerationMatch: 0 } }); },
    async getObject({ key }) { const [buffer] = await bucket.file(key).download(); if (buffer.length > 52 * 1024 * 1024) throw cloudError('Downloaded object exceeds the byte limit.','ERR_SYSTEMFABRIC_CLOUD_SIZE_LIMIT'); return buffer; },
    async deleteObject({ key }) { await bucket.file(key).delete({ ignoreNotFound: true }); }
  });
}
function createAzureBlobAdapter({ containerClient, provider = 'azure' }) {
  if (!containerClient || typeof containerClient.getBlockBlobClient !== 'function') throw cloudError('Azure Blob adapter requires an authenticated container client.');
  return Object.freeze({ provider,
    async probe() { if (typeof containerClient.getProperties !== 'function') throw cloudError('Azure container properties probe is unavailable.', 'ERR_SYSTEMFABRIC_CLOUD_PROBE_UNAVAILABLE'); await containerClient.getProperties(); return { provider, ok: true, operation: 'GetContainerProperties' }; },
    async putObject({ key, body, contentType }) { const blob=containerClient.getBlockBlobClient(key); await blob.uploadData(body, { blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: 'private, no-store' }, conditions: { ifNoneMatch: '*' } }); },
    async getObject({ key }) { const blob=containerClient.getBlockBlobClient(key); const response=await blob.download(); if (typeof response.readableStreamBody === 'undefined') throw cloudError('Azure download stream was not returned.','ERR_SYSTEMFABRIC_CLOUD_READ'); return bodyToBuffer(response.readableStreamBody); },
    async deleteObject({ key }) { await containerClient.deleteBlob(key, { deleteSnapshots: 'include' }).catch(error => { if (error.statusCode !== 404) throw error; }); }
  });
}

async function probeCloudStorageAdapter(adapter) {
  if (!adapter || typeof adapter.probe !== 'function') throw cloudError('Configured storage adapter does not support live connectivity probes.', 'ERR_SYSTEMFABRIC_CLOUD_PROBE_UNAVAILABLE');
  const started = Date.now();
  try {
    const result = await adapter.probe();
    return { ...result, ok: true, latencyMs: Math.max(0, Date.now() - started) };
  } catch (error) {
    // Never return raw provider errors to an API caller; SDK errors can contain
    // endpoints, account names, or request identifiers.
    const safe = cloudError('Cloud storage connectivity or authorization probe failed.', 'ERR_SYSTEMFABRIC_CLOUD_PROBE_FAILED');
    safe.cause = error;
    throw safe;
  }
}

function cloudConfigStatus({ provider, credentialReference, config }) {
  const validProvider = ['aws-s3','s3-compatible','google-cloud-storage','azure-blob','cloudflare-r2','minio'].includes(provider);
  const validReference = typeof credentialReference === 'string' && /^(?:env:\/\/[A-Z][A-Z0-9_]{1,100}|workload-identity:\/[A-Za-z0-9/_-]{1,240})$/.test(credentialReference);
  const isObject = Boolean(config && typeof config === 'object' && !Array.isArray(config));
  let safeConfig = isObject && Buffer.byteLength(JSON.stringify(config)) <= 16_384;
  const errors = [];
  const commonAllowed = new Set(['bucket','container','endpoint','region','forcePathStyle','projectId']);
  if (!validProvider) errors.push('unsupported provider');
  if (!validReference) errors.push('credentialReference must point to a secret reference, not contain a secret');
  if (!safeConfig) errors.push('config must be a small JSON object');
  if (isObject) {
    const providerAllowed = provider === 'azure-blob'
      ? new Set(['container'])
      : provider === 'google-cloud-storage'
        ? new Set(['bucket','projectId'])
        : new Set(['bucket','endpoint','region','forcePathStyle']);
    for (const key of Object.keys(config)) {
      if (!commonAllowed.has(key) || !providerAllowed.has(key)) { safeConfig = false; errors.push('config contains a field unsupported for this provider'); break; }
    }
    for (const key of ['bucket','container']) {
      if (config[key] !== undefined && (typeof config[key] !== 'string' || config[key].length < 1 || config[key].length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config[key]))) { safeConfig = false; errors.push(`${key} is invalid`); }
    }
    if (provider === 'azure-blob' && config.container !== undefined && !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(config.container)) { safeConfig = false; errors.push('Azure container name must be 3–63 lowercase letters, digits, or hyphens'); }
    if (config.region !== undefined && (typeof config.region !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(config.region))) { safeConfig = false; errors.push('region is invalid'); }
    if (config.projectId !== undefined && (typeof config.projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.projectId))) { safeConfig = false; errors.push('projectId is invalid'); }
    if (config.forcePathStyle !== undefined && typeof config.forcePathStyle !== 'boolean') { safeConfig = false; errors.push('forcePathStyle must be boolean'); }
    if (config.endpoint !== undefined) {
      try {
        if (typeof config.endpoint !== 'string' || config.endpoint.length > 2048) throw new Error('invalid');
        const endpoint = new URL(config.endpoint);
        if (!['http:','https:'].includes(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('invalid');
      } catch { safeConfig = false; errors.push('endpoint must be an HTTP(S) URL without embedded credentials, query, or fragment'); }
    }
  }
  return { valid: validProvider && validReference && safeConfig, errors };
}

function resolveCloudCredentialReference({ provider, reference, env = process.env } = {}) {
  const s3Providers = new Set(['aws-s3', 's3-compatible', 'cloudflare-r2', 'minio']);
  const gcsProviders = new Set(['google-cloud-storage']);
  const azureProviders = new Set(['azure-blob']);
  if (typeof reference !== 'string') return { ok: false, mode: 'unsupported', message: 'A credential reference is required.' };

  if (reference.startsWith('env://')) {
    const name = reference.slice(6);
    if (!env[name]) return { ok: false, mode: 'environment', message: 'The referenced environment variable is not configured.' };
    if (s3Providers.has(provider)) {
      const staticPair = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
      const webIdentity = Boolean(env.AWS_ROLE_ARN && env.AWS_WEB_IDENTITY_TOKEN_FILE);
      const containerIdentity = Boolean(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
      const profile = Boolean(env.AWS_PROFILE);
      const supportedNames = new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_PROFILE', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI']);
      if (!supportedNames.has(name)) return { ok: false, mode: 'environment', message: 'S3 credentials must be mapped to standard AWS SDK environment variables.' };
      if (!(staticPair || webIdentity || containerIdentity || profile)) return { ok: false, mode: 'environment', message: 'The AWS SDK credential chain is incomplete; configure a complete key pair, web identity, container identity, or profile.' };
      return { ok: true, mode: 'environment' };
    }
    if (gcsProviders.has(provider)) {
      if (name !== 'GOOGLE_APPLICATION_CREDENTIALS') return { ok: false, mode: 'environment', message: 'Google Cloud credentials must use GOOGLE_APPLICATION_CREDENTIALS or a workload-identity reference.' };
      return { ok: true, mode: 'environment' };
    }
    if (azureProviders.has(provider)) {
      if (name !== 'AZURE_STORAGE_CONNECTION_STRING') return { ok: false, mode: 'environment', message: 'Azure Blob currently requires AZURE_STORAGE_CONNECTION_STRING; DefaultAzureCredential integration is not enabled in this build.' };
      return { ok: true, mode: 'environment' };
    }
    return { ok: false, mode: 'unsupported', message: 'The provider does not support this credential reference.' };
  }

  if (reference.startsWith('workload-identity:/')) {
    if (s3Providers.has(provider)) {
      if (env.AWS_ACCESS_KEY_ID || env.AWS_SECRET_ACCESS_KEY || env.AWS_PROFILE) return { ok: false, mode: 'workload-identity', message: 'Static AWS credential variables are present; remove them to ensure the SDK uses workload identity.' };
      return { ok: true, mode: 'workload-identity' };
    }
    if (gcsProviders.has(provider)) {
      if (env.GOOGLE_APPLICATION_CREDENTIALS) return { ok: false, mode: 'workload-identity', message: 'GOOGLE_APPLICATION_CREDENTIALS is set; remove it to ensure the SDK uses workload identity.' };
      return { ok: true, mode: 'workload-identity' };
    }
    return { ok: false, mode: 'unsupported', message: 'This build does not support workload identity for the selected provider. Azure workload identity needs an explicit Azure Identity adapter.' };
  }

  return { ok: false, mode: 'unsupported', message: 'This build cannot resolve vault:// references directly. Configure a supported provider credential environment variable or workload identity.' };
}

function createCloudStorageAdapterFromEnv({ env = process.env } = {}) {
  const configured = String(env.LIBRARY_STORAGE_PROVIDER || 'local').toLowerCase();
  if (configured === 'local') return null;
  if (['s3','aws-s3','s3-compatible','cloudflare-r2','minio'].includes(configured)) {
    let sdk; try { sdk = require('@aws-sdk/client-s3'); } catch { throw cloudError('Install @aws-sdk/client-s3 to use S3-compatible storage.','ERR_SYSTEMFABRIC_CLOUD_SDK_MISSING'); }
    const bucket = env.LIBRARY_STORAGE_BUCKET || env.S3_BUCKET;
    if (!bucket) throw cloudError('LIBRARY_STORAGE_BUCKET or S3_BUCKET is required.');
    const endpoint = env.LIBRARY_STORAGE_ENDPOINT || env.S3_ENDPOINT || '';
    if (env.NODE_ENV === 'production' && endpoint && !cloudEndpointAllowed(endpoint, env)) throw cloudError('Production cloud endpoint must use HTTPS and exactly match SYSTEMFABRIC_CLOUD_ENDPOINT_ALLOWLIST.', 'ERR_SYSTEMFABRIC_CLOUD_ENDPOINT_NOT_ALLOWED');
    const region = configured === 'cloudflare-r2' ? 'auto' : (env.LIBRARY_STORAGE_REGION || env.S3_REGION || 'us-east-1');
    const client = new sdk.S3Client({ region, endpoint: endpoint || undefined, forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true' || configured === 'minio', maxAttempts: 3 });
    const provider = configured === 'aws-s3' || configured === 's3' ? 's3' : 's3-compatible';
    return createS3CompatibleAdapter({ bucket, client, commands: sdk, provider });
  }
  if (configured === 'gcs' || configured === 'google-cloud-storage') {
    let Storage; try { ({ Storage } = require('@google-cloud/storage')); } catch { throw cloudError('Install @google-cloud/storage to use Google Cloud Storage.','ERR_SYSTEMFABRIC_CLOUD_SDK_MISSING'); }
    const bucketName=env.LIBRARY_STORAGE_BUCKET||env.GCS_BUCKET; if(!bucketName) throw cloudError('LIBRARY_STORAGE_BUCKET or GCS_BUCKET is required.');
    const client=new Storage(env.GOOGLE_CLOUD_PROJECT?{projectId:env.GOOGLE_CLOUD_PROJECT}:undefined);
    return createGoogleCloudStorageAdapter({bucket:client.bucket(bucketName),provider:'gcs'});
  }
  if (configured === 'azure' || configured === 'azure-blob') {
    let sdk; try { sdk=require('@azure/storage-blob'); } catch { throw cloudError('Install @azure/storage-blob to use Azure Blob Storage.','ERR_SYSTEMFABRIC_CLOUD_SDK_MISSING'); }
    const connectionString=env.AZURE_STORAGE_CONNECTION_STRING; const container=env.LIBRARY_STORAGE_CONTAINER||env.AZURE_STORAGE_CONTAINER;
    if(!connectionString||!container) throw cloudError('AZURE_STORAGE_CONNECTION_STRING and AZURE_STORAGE_CONTAINER are required.');
    const service=sdk.BlobServiceClient.fromConnectionString(connectionString);
    return createAzureBlobAdapter({containerClient:service.getContainerClient(container),provider:'azure'});
  }
  throw cloudError(`Unsupported LIBRARY_STORAGE_PROVIDER: ${configured}`);
}

module.exports = { createS3CompatibleAdapter, createGoogleCloudStorageAdapter, createAzureBlobAdapter, createCloudStorageAdapterFromEnv, cloudConfigStatus, probeCloudStorageAdapter, resolveCloudCredentialReference, cloudEndpointAllowed, bodyToBuffer };
