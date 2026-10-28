'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { detectImageType, MAX_FILE_BYTES, MIME_TYPES } = require('./local-store');

function mediaError(message, code = 'ERR_SYSTEMFABRIC_MEDIA_INVALID', statusCode = 400) { const error = new Error(message); error.code = code; error.statusCode = statusCode; return error; }
async function bodyToBuffer(body, maxBytes = MAX_FILE_BYTES) {
  if (Buffer.isBuffer(body)) return body;
  if (body && typeof body.transformToByteArray === 'function') {
    const bytes = Buffer.from(await body.transformToByteArray());
    if (bytes.length > maxBytes) throw mediaError('Object is larger than the configured maximum.', 'ERR_SYSTEMFABRIC_MEDIA_SIZE_LIMIT', 413);
    return bytes;
  }
  const chunks = []; let size = 0;
  if (body && body[Symbol.asyncIterator]) {
    for await (const chunk of body) { size += chunk.length; if (size > maxBytes) throw mediaError('Object is larger than the configured maximum.', 'ERR_SYSTEMFABRIC_MEDIA_SIZE_LIMIT', 413); chunks.push(Buffer.from(chunk)); }
  }
  return Buffer.concat(chunks);
}
function createS3MediaStore({ pool, env = process.env, client: suppliedClient, commands: suppliedCommands } = {}) {
  if (!pool) throw new TypeError('S3 media store requires a PostgreSQL pool.');
  const bucket = String(env.S3_BUCKET || '');
  const region = String(env.S3_REGION || 'us-east-1');
  const endpoint = String(env.S3_ENDPOINT || '');
  const cdnBase = String(env.CDN_BASE_URL || '').replace(/\/$/, '');
  if (!bucket || !/^[A-Za-z0-9._-]{3,63}$/.test(bucket)) throw new Error('S3_BUCKET must be configured with a valid bucket name.');
  if (env.NODE_ENV === 'production' && endpoint) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') throw new Error('S3_ENDPOINT must use HTTPS in production.');
  }
  let client = suppliedClient; let commands = suppliedCommands;
  if (!client || !commands) {
    let sdk;
    try { sdk = require('@aws-sdk/client-s3'); } catch { throw new Error('Install the declared @aws-sdk/client-s3 dependency to enable S3 media storage.'); }
    commands = commands || sdk;
    client = client || new sdk.S3Client({ region, endpoint: endpoint || undefined, forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true', maxAttempts: 3 });
  }
  const publicCdnEnabled = env.MEDIA_CDN_PUBLIC === 'true' && Boolean(cdnBase);

  async function upload({ siteId, actorId, dataBase64, mimeType, altText = '', isPublic = true }) {
    if (typeof dataBase64 !== 'string' || dataBase64.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) throw mediaError('dataBase64 must be valid base64 image data up to 10 MiB.');
    const buffer = Buffer.from(dataBase64, 'base64');
    if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw mediaError('Image must be between 1 byte and 10 MiB.', 'ERR_SYSTEMFABRIC_MEDIA_SIZE_LIMIT', 413);
    const detected = detectImageType(buffer);
    if (!detected || detected !== mimeType || !MIME_TYPES[detected]) throw mediaError('Only signature-verified PNG, JPEG, WebP, and GIF images are supported. SVG and unknown formats are rejected.');
    if (typeof altText !== 'string' || altText.length > 1000) throw mediaError('altText must be at most 1000 characters.');
    const id = randomUUID(); const storageKey = `${siteId}/${id}.${MIME_TYPES[detected]}`;
    await client.send(new commands.PutObjectCommand({ Bucket: bucket, Key: storageKey, Body: buffer, ContentType: detected, ContentLength: buffer.length, CacheControl: isPublic === false ? 'private, no-store' : 'public, max-age=31536000, immutable', Metadata: { systemfabricSiteId: String(siteId), systemfabricAssetId: id, verifiedImage: 'true' } }));
    try {
      const result = await pool.query(`INSERT INTO media_assets(id,site_id,storage_key,mime_type,byte_size,alt_text,metadata,created_by,publicly_accessible) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING id,site_id,storage_key,mime_type,byte_size,alt_text,publicly_accessible,created_at`, [id, siteId, storageKey, detected, buffer.length, altText, JSON.stringify({ storage: 's3', bucket, region, verifiedImage: true }), actorId || null, isPublic !== false]);
      return result.rows[0];
    } catch (error) {
      await client.send(new commands.DeleteObjectCommand({ Bucket: bucket, Key: storageKey })).catch(() => {});
      throw error;
    }
  }

  return Object.freeze({
    async upload(args) { return upload(args); },
    async list({ siteId, limit = 50 }) {
      const result = await pool.query('SELECT id,mime_type,byte_size,alt_text,publicly_accessible,created_at FROM media_assets WHERE site_id=$1 ORDER BY created_at DESC LIMIT $2', [siteId, Math.min(100, Math.max(1, Number(limit) || 50))]);
      return result.rows;
    },
    publicUrl(asset) {
      if (!asset || !publicCdnEnabled || asset.publicly_accessible !== true || !asset.storage_key) return asset?.id ? `/media/${asset.id}` : null;
      return `${cdnBase}/${String(asset.storage_key).split('/').map(segment => encodeURIComponent(segment)).join('/')}`;
    },
    async readPublic(id) {
      const result = await pool.query('SELECT id,storage_key,mime_type,byte_size FROM media_assets WHERE id=$1 AND publicly_accessible=true LIMIT 1', [id]);
      const asset = result.rows[0]; if (!asset) return null;
      const object = await client.send(new commands.GetObjectCommand({ Bucket: bucket, Key: asset.storage_key }));
      const data = await bodyToBuffer(object.Body, MAX_FILE_BYTES);
      if (data.length !== Number(asset.byte_size) || detectImageType(data) !== asset.mime_type) throw mediaError('Stored media object failed integrity checks.', 'ERR_SYSTEMFABRIC_MEDIA_CORRUPT', 502);
      return { ...asset, data };
    },
    async close() { if (typeof client.destroy === 'function') client.destroy(); }
  });
}
module.exports = { createS3MediaStore, bodyToBuffer };
