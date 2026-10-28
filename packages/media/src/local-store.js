'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MIME_TYPES = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' });
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a','GIF89a'].includes(buffer.subarray(0,6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0,4).toString('ascii') === 'RIFF' && buffer.subarray(8,12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
function invalid(message, code = 'ERR_SYSTEMFABRIC_MEDIA_INVALID') { const error = new Error(message); error.statusCode = 400; error.code = code; return error; }

function createLocalMediaStore({ pool, root = path.resolve(process.env.MEDIA_ROOT || path.join(process.cwd(), 'var', 'media')) }) {
  if (!pool) throw new TypeError('Media store requires a PostgreSQL pool.');
  const mediaRoot = path.resolve(root);
  return Object.freeze({
    async upload({ siteId, actorId, dataBase64, mimeType, altText = '', isPublic = true }) {
      if (typeof dataBase64 !== 'string' || dataBase64.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) throw invalid('dataBase64 must be a valid base64-encoded image up to 10 MiB.');
      const buffer = Buffer.from(dataBase64, 'base64');
      if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw invalid('Image must be between 1 byte and 10 MiB.', 'ERR_SYSTEMFABRIC_MEDIA_SIZE_LIMIT');
      const detected = detectImageType(buffer);
      if (!detected || detected !== mimeType || !MIME_TYPES[detected]) throw invalid('Only verified PNG, JPEG, WebP, and GIF images are supported. SVG and unrecognized formats are rejected.');
      if (typeof altText !== 'string' || altText.length > 1000) throw invalid('altText must be a string up to 1000 characters.');
      const id = randomUUID(); const storageKey = `${siteId}/${id}.${MIME_TYPES[detected]}`;
      const filePath = path.resolve(mediaRoot, storageKey);
      if (!filePath.startsWith(`${mediaRoot}${path.sep}`)) throw invalid('Invalid media path.');
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o750 });
      const handle = await fs.promises.open(filePath, 'wx', 0o640);
      try { await handle.writeFile(buffer); await handle.sync(); } finally { await handle.close(); }
      try {
        const result = await pool.query(
          `INSERT INTO media_assets(id,site_id,storage_key,mime_type,byte_size,alt_text,metadata,created_by,publicly_accessible)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
           RETURNING id,site_id,storage_key,mime_type,byte_size,alt_text,publicly_accessible,created_at`,
          [id, siteId, storageKey, detected, buffer.length, altText, JSON.stringify({ storage: 'local', verifiedImage: true }), actorId || null, isPublic !== false]
        );
        return result.rows[0];
      } catch (error) { await fs.promises.unlink(filePath).catch(() => {}); throw error; }
    },
    async list({ siteId, limit = 50 }) {
      const result = await pool.query(`SELECT id,mime_type,byte_size,alt_text,publicly_accessible,created_at FROM media_assets WHERE site_id=$1 ORDER BY created_at DESC LIMIT $2`, [siteId, Math.min(100, Math.max(1, Number(limit) || 50))]);
      return result.rows;
    },
    async readPublic(id) {
      const result = await pool.query('SELECT id,storage_key,mime_type,byte_size FROM media_assets WHERE id=$1 AND publicly_accessible=true LIMIT 1', [id]);
      const asset = result.rows[0]; if (!asset) return null;
      const filePath = path.resolve(mediaRoot, asset.storage_key);
      if (!filePath.startsWith(`${mediaRoot}${path.sep}`)) return null;
      try { const data = await fs.promises.readFile(filePath); return { ...asset, data }; } catch { return null; }
    }
  });
}
module.exports = { createLocalMediaStore, detectImageType, MAX_FILE_BYTES, MIME_TYPES };
