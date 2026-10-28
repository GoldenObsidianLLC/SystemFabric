'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const MAX_LIBRARY_FILE_BYTES = 50 * 1024 * 1024;
const CATEGORY_TO_KIND = Object.freeze({ image: 'image', video: 'video', audio: 'audio', document: 'document', file: 'file', font: 'font' });
const KIND_MIMES = Object.freeze({
  image: new Set(['image/png','image/jpeg','image/webp','image/gif']),
  video: new Set(['video/mp4','video/webm']),
  audio: new Set(['audio/mpeg','audio/wav','audio/ogg','audio/mp4']),
  document: new Set(['application/pdf','text/plain','application/json','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation']),
  file: new Set(['application/pdf','text/plain','application/json','application/zip']),
  font: new Set(['font/woff','font/woff2','application/font-woff','application/font-woff2'])
});
const EXTENSIONS = Object.freeze({
  'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif',
  'video/mp4':'mp4','video/webm':'webm','audio/mpeg':'mp3','audio/wav':'wav','audio/ogg':'ogg','audio/mp4':'m4a',
  'application/pdf':'pdf','text/plain':'txt','application/json':'json','application/zip':'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx',
  'font/woff':'woff','application/font-woff':'woff','font/woff2':'woff2','application/font-woff2':'woff2'
});

function libraryError(message, code = 'ERR_SYSTEMFABRIC_LIBRARY_INVALID', statusCode = 400) {
  const error = new Error(message); error.code = code; error.statusCode = statusCode; return error;
}
function sniffMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a','GIF89a'].includes(buffer.subarray(0,6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.toString('ascii',0,4) === 'RIFF' && buffer.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.toString('ascii',4,8) === 'ftyp') return 'video/mp4';
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'video/webm';
  if (buffer.subarray(0,3).toString('ascii') === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buffer.length >= 12 && buffer.toString('ascii',0,4) === 'RIFF' && buffer.toString('ascii',8,12) === 'WAVE') return 'audio/wav';
  if (buffer.subarray(0,4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (buffer.subarray(0,5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (buffer.length >= 4 && buffer.toString('ascii',0,4) === 'wOFF') return 'font/woff';
  if (buffer.length >= 4 && buffer.toString('ascii',0,4) === 'wOF2') return 'font/woff2';
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03,0x05,0x07].includes(buffer[2]) && [0x04,0x06,0x08].includes(buffer[3])) return 'application/zip';
  // Text requires strict UTF-8 and rejects NUL bytes; a client MIME label alone is not trusted.
  if (buffer.length <= 10 * 1024 * 1024 && !buffer.includes(0)) {
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) { JSON.parse(text); return 'application/json'; } if (/^[\t\n\r\x20-\uD7FF\uE000-\uFFFD]*$/.test(text)) return 'text/plain'; } catch {}
  }
  return null;
}
function sanitizeDisplayName(value) {
  const result = path.posix.basename(String(value || '')).replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"/\\|?*]/g, '-').trim();
  return result.slice(0, 240) || 'untitled';
}
function decodeDataBase64(value, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 4 / 3) + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw libraryError('dataBase64 must be valid base64 data.');
  const data = Buffer.from(value, 'base64');
  if (!data.length || data.length > maxBytes) throw libraryError(`File must be between 1 byte and ${maxBytes} bytes.`, 'ERR_SYSTEMFABRIC_LIBRARY_SIZE_LIMIT', 413);
  return data;
}

function createLibraryStore({ pool, root = path.resolve(process.env.LIBRARY_ROOT || path.join(process.cwd(), 'var', 'library')), maxFileBytes = MAX_LIBRARY_FILE_BYTES, storageAdapter = null, malwareScanner = null, requireMalwareScan = process.env.NODE_ENV === 'production' } = {}) {
  if (!pool) throw new TypeError('Library store requires PostgreSQL.');
  const libraryRoot = path.resolve(root);
  async function scanForMalware(buffer, fileName) {
    if (!malwareScanner || typeof malwareScanner.scan !== 'function') {
      if (requireMalwareScan) throw libraryError('Uploads are disabled because a malware scanner is required but not configured.', 'ERR_SYSTEMFABRIC_MALWARE_SCANNER_REQUIRED', 503);
      return { clean: false, status: 'not_scanned', engine: null };
    }
    let result;
    try { result = await malwareScanner.scan({ buffer, fileName }); }
    catch (error) { throw libraryError(`Malware scanning failed closed: ${error.code || 'scanner error'}.`, error.code || 'ERR_SYSTEMFABRIC_MALWARE_SCAN_FAILED', 503); }
    if (!result || result.clean !== true || result.status && result.status !== 'clean') {
      throw libraryError('The uploaded file did not pass malware scanning.', 'ERR_SYSTEMFABRIC_MALWARE_DETECTED', 422);
    }
    return { clean: true, status: 'clean', engine: String(result.engine || malwareScanner.engine || 'configured-scanner').slice(0, 100) };
  }
  async function put(key, buffer, mimeType) {
    if (storageAdapter) return storageAdapter.putObject({ key, body: buffer, contentType: mimeType });
    const filePath = path.resolve(libraryRoot, key);
    if (!filePath.startsWith(`${libraryRoot}${path.sep}`)) throw libraryError('Unsafe storage path.', 'ERR_SYSTEMFABRIC_LIBRARY_PATH');
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o750 });
    const handle = await fs.promises.open(filePath, 'wx', 0o640);
    try { await handle.writeFile(buffer); await handle.sync(); } finally { await handle.close(); }
    return filePath;
  }
  async function get(key) {
    if (storageAdapter) return storageAdapter.getObject({ key });
    const filePath = path.resolve(libraryRoot, key);
    if (!filePath.startsWith(`${libraryRoot}${path.sep}`)) return null;
    try { return await fs.promises.readFile(filePath); } catch { return null; }
  }
  async function remove(key) {
    if (storageAdapter) return storageAdapter.deleteObject({ key });
    const filePath = path.resolve(libraryRoot, key);
    if (filePath.startsWith(`${libraryRoot}${path.sep}`)) await fs.promises.unlink(filePath).catch(() => {});
  }
  return Object.freeze({
    async upload({ siteId, actorId, category, dataBase64, mimeType, fileName, displayName, altText = '', caption = '', description = '', isPublic = false, metadata = {} }) {
      const kind = CATEGORY_TO_KIND[category];
      if (!kind) throw libraryError('category must be image, video, audio, document, file, or font.');
      const data = decodeDataBase64(dataBase64, maxFileBytes); const detected = sniffMime(data);
      if (!detected || detected !== mimeType || !KIND_MIMES[kind].has(detected)) throw libraryError('File signature does not match an allowed MIME type for this library category.', 'ERR_SYSTEMFABRIC_LIBRARY_TYPE');
      const originalName = sanitizeDisplayName(fileName || displayName); const name = sanitizeDisplayName(displayName || originalName);
      for (const [key, value, limit] of [['altText',altText,1000],['caption',caption,4000],['description',description,12000]]) if (typeof value !== 'string' || value.length > limit) throw libraryError(`${key} must be a string up to ${limit} characters.`);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Buffer.byteLength(JSON.stringify(metadata)) > 16_384) throw libraryError('metadata must be a small JSON object.');
      const scan = await scanForMalware(data, originalName);
      const id = randomUUID(); const ext = EXTENSIONS[detected] || 'bin'; const storageKey = `${siteId}/${id}/v1.${ext}`; const digest = createHash('sha256').update(data).digest('hex');
      const assetStatus = scan.clean ? 'active' : 'quarantined';
      const publicAfterScan = scan.clean && isPublic === true;
      const safeMetadata = { ...metadata, securityScan: { status: scan.status, engine: scan.engine, scannedAt: scan.clean ? new Date().toISOString() : null } };
      await put(storageKey, data, detected);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const q = await client.query(`INSERT INTO library_assets(id,site_id,asset_kind,display_name,original_name,storage_provider,storage_key,mime_type,byte_size,sha256,alt_text,caption,description,is_public,metadata,created_by,updated_by,optimization_status,status,malware_scan_status,malware_scan_engine,malware_scanned_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$16,'pending',$17,$18,$19,CASE WHEN $18='clean' THEN now() ELSE NULL END)
          RETURNING id,site_id,asset_kind,display_name,original_name,storage_provider,mime_type,byte_size,sha256,alt_text,caption,description,is_public,version,status,optimization_status,malware_scan_status,malware_scan_engine,metadata,created_by,created_at,updated_at`,
          [id, siteId, kind, name, originalName, storageAdapter?.provider || 'local', storageKey, detected, data.length, digest, altText, caption, description, publicAfterScan, JSON.stringify(safeMetadata), actorId || null, assetStatus, scan.status, scan.engine]);
        await client.query(`INSERT INTO library_asset_versions(asset_id,version,snapshot,storage_key,sha256,created_by) VALUES($1,1,$2::jsonb,$3,$4,$5)`, [id, JSON.stringify({displayName:name,originalName,altText,caption,description,metadata}), storageKey, digest, actorId || null]);
        await client.query('COMMIT'); return q.rows[0];
      } catch (error) { await client.query('ROLLBACK').catch(()=>{}); await remove(storageKey); throw error; } finally { client.release(); }
    },
    async list({ siteId, category, query, limit = 50, offset = 0 }) {
      const conditions = ['site_id=$1','deleted_at IS NULL']; const values = [siteId];
      if (category && category !== 'all') { if (!Object.hasOwn(CATEGORY_TO_KIND, category)) throw libraryError('Invalid library category.'); values.push(CATEGORY_TO_KIND[category]); conditions.push(`asset_kind=$${values.length}`); }
      if (query) { values.push(`%${String(query).slice(0,100).replace(/[\\%_]/g, '\\$&')}%`); conditions.push(`(display_name ILIKE $${values.length} ESCAPE '\\' OR original_name ILIKE $${values.length} ESCAPE '\\')`); }
      values.push(Math.min(100, Math.max(1, Number(limit) || 50))); values.push(Math.max(0, Number(offset) || 0));
      const result = await pool.query(`SELECT id,site_id,asset_kind,display_name,original_name,mime_type,byte_size,sha256,alt_text,caption,description,is_public,version,status,optimization_status,metadata,created_by,created_at,updated_at FROM library_assets WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`, values);
      return result.rows;
    },
    async get({ siteId, id }) {
      const result = await pool.query('SELECT * FROM library_assets WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL', [siteId,id]);
      return result.rows[0] || null;
    },
    async readPublic(id) {
      const result = await pool.query("SELECT id,storage_key,mime_type,byte_size,sha256 FROM library_assets WHERE id=$1 AND is_public=true AND status='active' AND deleted_at IS NULL", [id]);
      const row = result.rows[0]; if (!row) return null; const data = await get(row.storage_key);
      if (!data || data.length !== Number(row.byte_size) || createHash('sha256').update(data).digest('hex') !== row.sha256) return null;
      return { ...row, data };
    },
    async updateMetadata({ siteId, id, actorId, expectedVersion, patch }) {
      const allowed = ['displayName','altText','caption','description','isPublic','metadata'];
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !allowed.includes(key))) throw libraryError('Only displayName, altText, caption, description, isPublic, and metadata can be updated.');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const old = await client.query('SELECT * FROM library_assets WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE', [siteId,id]);
        if (!old.rows[0]) throw libraryError('Library asset not found.', 'ERR_SYSTEMFABRIC_LIBRARY_NOT_FOUND', 404);
        const row = old.rows[0]; if (!Number.isInteger(Number(expectedVersion)) || Number(expectedVersion) !== row.version) throw libraryError('Asset version is stale.', 'ERR_SYSTEMFABRIC_VERSION_CONFLICT', 409);
        const next = { displayName: row.display_name, altText: row.alt_text, caption: row.caption, description: row.description, isPublic: row.is_public, metadata: row.metadata, ...patch };
        next.displayName = sanitizeDisplayName(next.displayName);
        for (const [key, limit] of [['altText',1000],['caption',4000],['description',12000]]) if (typeof next[key] !== 'string' || next[key].length > limit) throw libraryError(`${key} is invalid.`);
        if (typeof next.isPublic !== 'boolean' || !next.metadata || typeof next.metadata !== 'object' || Array.isArray(next.metadata) || Buffer.byteLength(JSON.stringify(next.metadata)) > 16_384) throw libraryError('isPublic must be boolean and metadata must be a bounded JSON object.');
        await client.query(`INSERT INTO library_asset_versions(asset_id,version,snapshot,storage_key,sha256,created_by) VALUES($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(asset_id,version) DO NOTHING`, [id,row.version,JSON.stringify({displayName:row.display_name,originalName:row.original_name,altText:row.alt_text,caption:row.caption,description:row.description,isPublic:row.is_public,metadata:row.metadata}),row.storage_key,row.sha256,row.updated_by]);
        const updated = await client.query(`UPDATE library_assets SET display_name=$3,alt_text=$4,caption=$5,description=$6,is_public=$7,metadata=$8::jsonb,version=version+1,updated_by=$9,updated_at=now() WHERE site_id=$1 AND id=$2 AND version=$10 RETURNING id,site_id,asset_kind,display_name,original_name,mime_type,byte_size,sha256,alt_text,caption,description,is_public,version,status,optimization_status,metadata,created_by,updated_by,created_at,updated_at`, [siteId,id,next.displayName,next.altText,next.caption,next.description,next.isPublic,JSON.stringify(next.metadata),actorId || null,row.version]);
        if (!updated.rows[0]) throw libraryError('Asset version is stale.', 'ERR_SYSTEMFABRIC_VERSION_CONFLICT', 409);
        const updatedRow = updated.rows[0];
        await client.query('INSERT INTO library_asset_versions(asset_id,version,snapshot,storage_key,sha256,created_by) VALUES($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(asset_id,version) DO NOTHING', [id, updatedRow.version, JSON.stringify({ displayName: updatedRow.display_name, originalName: updatedRow.original_name, altText: updatedRow.alt_text, caption: updatedRow.caption, description: updatedRow.description, isPublic: updatedRow.is_public, metadata: updatedRow.metadata }), row.storage_key, row.sha256, actorId || null]);
        await client.query('COMMIT'); return updatedRow;
      } catch (e) { await client.query('ROLLBACK').catch(()=>{}); throw e; } finally { client.release(); }
    },
    async history({ siteId,id }) {
      const owns = await pool.query('SELECT 1 FROM library_assets WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL', [siteId,id]);
      if (!owns.rowCount) return null;
      const rows = await pool.query('SELECT id,asset_id,version,snapshot,sha256,created_by,created_at FROM library_asset_versions WHERE asset_id=$1 ORDER BY version DESC', [id]); return rows.rows;
    },
    async replaceVersion({ siteId, id, actorId, expectedVersion, dataBase64, mimeType, fileName }) {
      const data = decodeDataBase64(dataBase64, maxFileBytes);
      const detected = sniffMime(data);
      if (!detected || detected !== mimeType) throw libraryError('Replacement file signature does not match MIME type.', 'ERR_SYSTEMFABRIC_LIBRARY_TYPE');
      const safeFileName = sanitizeDisplayName(fileName || 'replacement');
      const scan = await scanForMalware(data, safeFileName);
      const nextStatus = scan.clean ? 'active' : 'quarantined';
      const nextScanMetadata = { status: scan.status, engine: scan.engine, scannedAt: scan.clean ? new Date().toISOString() : null };
      const client = await pool.connect();
      let storageKey = null;
      let committed = false;
      try {
        await client.query('BEGIN');
        const selected = await client.query("SELECT * FROM library_assets WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL AND status='active' FOR UPDATE", [siteId, id]);
        const old = selected.rows[0];
        if (!old) throw libraryError('Library asset not found.', 'ERR_SYSTEMFABRIC_LIBRARY_NOT_FOUND', 404);
        if (old.version !== Number(expectedVersion)) throw libraryError('Asset version is stale.', 'ERR_SYSTEMFABRIC_VERSION_CONFLICT', 409);
        if (!KIND_MIMES[old.asset_kind]?.has(detected)) throw libraryError('A new asset version must keep the same library category.', 'ERR_SYSTEMFABRIC_LIBRARY_TYPE');
        const ext = EXTENSIONS[detected];
        if (!ext) throw libraryError('Replacement MIME type is not supported.');
        const nextVersion = old.version + 1;
        storageKey = `${siteId}/${id}/v${nextVersion}.${ext}`;
        const digest = createHash('sha256').update(data).digest('hex');
        const oldSnapshot = { displayName: old.display_name, originalName: old.original_name, altText: old.alt_text, caption: old.caption, description: old.description, isPublic: old.is_public, metadata: old.metadata };
        await client.query('INSERT INTO library_asset_versions(asset_id,version,snapshot,storage_key,sha256,created_by) VALUES($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(asset_id,version) DO NOTHING', [id, old.version, JSON.stringify(oldSnapshot), old.storage_key, old.sha256, old.updated_by]);
        await put(storageKey, data, detected);
        const result = await client.query(`UPDATE library_assets SET original_name=$3,storage_key=$4,mime_type=$5,byte_size=$6,sha256=$7,version=$8,optimization_status='pending',updated_by=$9,updated_at=now(),status=$11,malware_scan_status=$12,malware_scan_engine=$13,malware_scanned_at=CASE WHEN $12='clean' THEN now() ELSE NULL END,is_public=CASE WHEN $12='clean' THEN is_public ELSE false END,metadata=metadata || $14::jsonb
          WHERE site_id=$1 AND id=$2 AND version=$10 RETURNING id,site_id,asset_kind,display_name,original_name,mime_type,byte_size,sha256,alt_text,caption,description,is_public,version,status,optimization_status,malware_scan_status,malware_scan_engine,metadata,updated_at`, [siteId, id, safeFileName || old.original_name, storageKey, detected, data.length, digest, nextVersion, actorId || null, old.version, nextStatus, scan.status, scan.engine, JSON.stringify({securityScan:nextScanMetadata})]);
        if (!result.rows[0]) throw libraryError('Asset version is stale.', 'ERR_SYSTEMFABRIC_VERSION_CONFLICT', 409);
        await client.query('INSERT INTO library_asset_versions(asset_id,version,snapshot,storage_key,sha256,created_by) VALUES($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(asset_id,version) DO NOTHING', [id, nextVersion, JSON.stringify({ displayName: old.display_name, originalName: sanitizeDisplayName(fileName || old.original_name), mimeType: detected, byteSize: data.length }), storageKey, digest, actorId || null]);
        await client.query('COMMIT');
        committed = true;
        return result.rows[0];
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (storageKey && !committed) await remove(storageKey).catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async readPublicVariant({ assetId,variantKey }) {
      if(!/^[a-z0-9][a-z0-9_-]{0,60}$/.test(String(variantKey))) return null;
      const q=await pool.query("SELECT v.id,v.storage_key,v.mime_type,v.byte_size,v.sha256 FROM media_variants v JOIN library_assets a ON a.id=v.asset_id WHERE a.id=$1 AND a.is_public=true AND a.status='active' AND a.deleted_at IS NULL AND v.variant_key=$2",[assetId,variantKey]);const row=q.rows[0];if(!row)return null;const data=await get(row.storage_key);if(!data||data.length!==Number(row.byte_size)||createHash('sha256').update(data).digest('hex')!==row.sha256)return null;return {...row,data};
    },
    async createVariant({ siteId,id,variantKey,data,mimeType,width=null,height=null }) {
      if (!/^[a-z0-9][a-z0-9_-]{0,60}$/.test(String(variantKey)) || !Buffer.isBuffer(data) || data.length < 1 || data.length > maxFileBytes || typeof mimeType !== 'string') throw libraryError('Variant metadata or bytes are invalid.');
      const current = await pool.query("SELECT id,asset_kind,version FROM library_assets WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL AND status='active'",[siteId,id]);
      if (!current.rows[0]) throw libraryError('Library asset not found.','ERR_SYSTEMFABRIC_LIBRARY_NOT_FOUND',404);
      const ext = EXTENSIONS[mimeType]; if (!ext) throw libraryError('Variant MIME type is not allowed.');
      const storageKey = `${siteId}/${id}/variants/${variantKey}-${randomUUID()}.${ext}`; const digest = createHash('sha256').update(data).digest('hex');
      await put(storageKey,data,mimeType);
      try {
        const result = await pool.query(`INSERT INTO media_variants(asset_id,variant_key,storage_key,mime_type,byte_size,width,height,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(asset_id,variant_key) DO UPDATE SET storage_key=EXCLUDED.storage_key,mime_type=EXCLUDED.mime_type,byte_size=EXCLUDED.byte_size,width=EXCLUDED.width,height=EXCLUDED.height,sha256=EXCLUDED.sha256,created_at=now() RETURNING id,asset_id,variant_key,mime_type,byte_size,width,height,sha256`,[id,variantKey,storageKey,mimeType,data.length,width,height,digest]);
        return result.rows[0];
      } catch (error) { await remove(storageKey); throw error; }
    },
    async markOptimization({ siteId,id,status,details }) {
      if (!['pending','processing','optimized','skipped','failed'].includes(status)) throw libraryError('Invalid optimization status.');
      const result = await pool.query('UPDATE library_assets SET optimization_status=$3,metadata=metadata || $4::jsonb,updated_at=now() WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id,optimization_status,metadata', [siteId,id,status,JSON.stringify(details || {})]); return result.rows[0] || null;
    },
    async delete({ siteId,id,expectedVersion }) {
      const result = await pool.query("UPDATE library_assets SET status='deleted',deleted_at=now(),version=version+1,updated_at=now() WHERE site_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL RETURNING id,version", [siteId,id,Number(expectedVersion)]);
      if (!result.rows[0]) throw libraryError('Asset missing or version is stale.', 'ERR_SYSTEMFABRIC_VERSION_CONFLICT', 409);
      return result.rows[0];
    },
    async getBufferById({ siteId,id }) {
      const row = await this.get({ siteId,id }); if (!row || row.status !== 'active') return null; const data = await get(row.storage_key); if (!data || data.length !== Number(row.byte_size) || createHash('sha256').update(data).digest('hex') !== row.sha256) return null; return { asset: row, data };
    }
  });
}

module.exports = { createLibraryStore, sniffMime, sanitizeDisplayName, decodeDataBase64, MAX_LIBRARY_FILE_BYTES, KIND_MIMES };
