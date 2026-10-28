'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
async function runBinary(command, args, { timeoutMs = 30_000, maxOutputBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore','pipe','pipe'], shell: false, windowsHide: true });
    const stdout = []; const stderr = []; let totalOut = 0; let totalErr = 0; let settled = false;
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); if (err) reject(err); else resolve(value); };
    child.stdout.on('data', chunk => { totalOut += chunk.length; if (totalOut > maxOutputBytes) { child.kill('SIGKILL'); finish(Object.assign(new Error('Optimizer output exceeded its limit.'), { code: 'ERR_SYSTEMFABRIC_OPTIMIZER_OUTPUT_LIMIT' })); } else stdout.push(chunk); });
    child.stderr.on('data', chunk => { totalErr += chunk.length; if (totalErr < maxOutputBytes) stderr.push(chunk); });
    child.on('error', error => finish(Object.assign(error, { code: error.code === 'ENOENT' ? 'ERR_SYSTEMFABRIC_OPTIMIZER_UNAVAILABLE' : 'ERR_SYSTEMFABRIC_OPTIMIZER_FAILED' })));
    child.on('close', code => code === 0 ? finish(null, { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') }) : finish(Object.assign(new Error(`Optimizer exited with code ${code}.`), { code: 'ERR_SYSTEMFABRIC_OPTIMIZER_FAILED' })));
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(Object.assign(new Error('Optimizer timed out.'), { code: 'ERR_SYSTEMFABRIC_OPTIMIZER_TIMEOUT' })); }, timeoutMs); timer.unref?.();
  });
}
async function optimizeImage(buffer, { sharp = null, quality = 82, maxWidth = 2560 } = {}) {
  let engine = sharp;
  if (engine === false) engine = null;
  else if (!engine) { try { engine = require('sharp'); } catch {} }
  if (!engine) return { optimized: false, reason: 'optimizer-unavailable', buffer, mimeType: null, bytesSaved: 0 };
  const output = await engine(buffer, { limitInputPixels: 100_000_000, failOn: 'error' }).rotate().resize({ width: maxWidth, height: maxWidth, fit: 'inside', withoutEnlargement: true }).webp({ quality }).toBuffer();
  return { optimized: output.length < buffer.length, reason: output.length < buffer.length ? 'converted-to-webp' : 'not-smaller', buffer: output.length < buffer.length ? output : buffer, mimeType: output.length < buffer.length ? 'image/webp' : null, bytesSaved: Math.max(0, buffer.length - output.length), sha256: sha256(output) };
}
async function optimizeVideoToWebm(buffer, { ffmpegPath = 'ffmpeg', timeoutMs = 120_000, maxBytes = 100 * 1024 * 1024 } = {}) {
  if (buffer.length > maxBytes) { const e = new Error('Video exceeds the optimizer input limit.'); e.code='ERR_SYSTEMFABRIC_OPTIMIZER_SIZE_LIMIT'; throw e; }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'systemfabric-video-'));
  const input = path.join(dir, `${randomUUID()}.mp4`); const output = path.join(dir, `${randomUUID()}.webm`);
  try {
    await fs.promises.writeFile(input, buffer, { mode: 0o600, flag: 'wx' });
    await runBinary(ffmpegPath, ['-nostdin','-hide_banner','-loglevel','error','-i',input,'-map_metadata','-1','-c:v','libvpx-vp9','-deadline','good','-cpu-used','4','-crf','34','-b:v','0','-c:a','libopus','-y',output], { timeoutMs });
    const optimized = await fs.promises.readFile(output);
    return { optimized: optimized.length < buffer.length, reason: optimized.length < buffer.length ? 'transcoded-to-webm' : 'not-smaller', buffer: optimized.length < buffer.length ? optimized : buffer, mimeType: optimized.length < buffer.length ? 'video/webm' : null, bytesSaved: Math.max(0, buffer.length - optimized.length), sha256: sha256(optimized) };
  } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
}
module.exports = { runBinary, optimizeImage, optimizeVideoToWebm, sha256 };
