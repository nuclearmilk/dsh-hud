import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  exeRelative,
  binPath,
  buildExtractAttempts,
  parseShasums,
  verifyFileSha256,
  acquireLock,
  releaseLock,
  download,
  probeSpeed,
  resolveProxyForUrl
} from '../lib/runtime-fetch.js';

function makeTempDir(prefix = 'dsh-hud-fetch-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('exeRelative and binPath resolve platform-specific Electron binaries', () => {
  assert.equal(exeRelative('win32'), 'electron.exe');
  assert.equal(exeRelative('darwin'), 'Electron.app/Contents/MacOS/Electron');
  assert.equal(exeRelative('linux'), 'electron');

  assert.equal(
    binPath('/opt/dsh/electron', 'darwin'),
    path.join('/opt/dsh/electron', 'Electron.app/Contents/MacOS/Electron')
  );
});

test('buildExtractAttempts passes Windows PowerShell paths via env vars (safe with single quotes)', () => {
  const archive = "C:\\Users\\O'Brien\\electron-v43.3.0-win32-x64.zip";
  const dir = "C:\\Users\\O'Brien\\.dsh\\electron";
  const attempts = buildExtractAttempts(archive, dir, 'win32');

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].cmd, 'tar');
  assert.equal(attempts[1].cmd, 'powershell');
  assert.equal(attempts[1].args.join(' ').includes("O'Brien"), false);
  assert.equal(attempts[1].args.join(' ').includes('$env:DSH_HUD_ARCHIVE'), true);
  assert.equal(attempts[1].env.DSH_HUD_ARCHIVE, archive);
  assert.equal(attempts[1].env.DSH_HUD_EXTRACT_DIR, dir);
});

test('parseShasums and verifyFileSha256 verify archive integrity', async () => {
  const tmp = makeTempDir();
  try {
    const file = path.join(tmp, 'electron-v43.3.0-win32-x64.zip');
    const data = Buffer.from('mock-electron-zip-payload-1234567890');
    fs.writeFileSync(file, data);
    const expected = crypto.createHash('sha256').update(data).digest('hex');

    const shasumText = [
      `${'0'.repeat(64)} *electron-v43.3.0-linux-x64.zip`,
      `${expected} *electron-v43.3.0-win32-x64.zip`,
      `${'f'.repeat(64)}  electron-v43.3.0-darwin-arm64.zip`
    ].join('\n');

    assert.equal(parseShasums(shasumText, 'electron-v43.3.0-win32-x64.zip'), expected);
    assert.equal(parseShasums(shasumText, 'missing.zip'), null);

    const good = await verifyFileSha256(file, expected);
    assert.equal(good.ok, true);

    const bad = await verifyFileSha256(file, '1'.repeat(64));
    assert.equal(bad.ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('acquireLock blocks live owner and reclaims dead-PID or expired locks', () => {
  const tmp = makeTempDir();
  try {
    const lock1 = acquireLock(tmp, { now: () => 1000, pidAlive: () => true });
    assert.ok(lock1);

    // Live owner within TTL -> cannot acquire
    const blocked = acquireLock(tmp, { now: () => 2000, staleMs: 60000, pidAlive: () => true });
    assert.equal(blocked, null);

    // Dead PID -> automatically reclaimed
    const reclaimedDead = acquireLock(tmp, { now: () => 2000, staleMs: 60000, pidAlive: () => false });
    assert.ok(reclaimedDead);

    // Expired TTL -> automatically reclaimed even if pidAlive returns true
    const reclaimedTtl = acquireLock(tmp, { now: () => 100000, staleMs: 5000, pidAlive: () => true });
    assert.ok(reclaimedTtl);

    releaseLock(reclaimedTtl);
    assert.equal(fs.existsSync(reclaimedTtl), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('download supports http://, renames .part to .zip, resumes 206, and recovers from corrupt 416', async () => {
  const tmp = makeTempDir();
  const payload = Buffer.from('PK\x03\x04' + 'A'.repeat(4096));

  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d+)-$/.exec(range);
      if (m) {
        const start = Number(m[1]);
        if (start >= payload.length) {
          res.writeHead(416, { 'Content-Range': `bytes */${payload.length}` });
          res.end();
          return;
        }
        const slice = payload.subarray(start);
        res.writeHead(206, {
          'Content-Length': String(slice.length),
          'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`
        });
        res.end(slice);
        return;
      }
    }
    res.writeHead(200, { 'Content-Length': String(payload.length) });
    res.end(payload);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/electron.zip`;

  try {
    // 1. Fresh download renames .zip.part -> .zip
    const dest1 = path.join(tmp, 'fresh.zip');
    const out1 = await download(url, dest1);
    assert.equal(out1, dest1);
    assert.equal(fs.existsSync(`${dest1}.part`), false);
    assert.deepEqual(fs.readFileSync(dest1), payload);

    // 2. Partial resume (206)
    const dest2 = path.join(tmp, 'resume.zip');
    fs.writeFileSync(`${dest2}.part`, payload.subarray(0, 1000));
    const out2 = await download(url, dest2);
    assert.equal(out2, dest2);
    assert.deepEqual(fs.readFileSync(dest2), payload);

    // 3. Oversized corrupt .part triggers 416 -> wipes .part and retries fresh instead of looping
    const dest3 = path.join(tmp, 'corrupt416.zip');
    fs.writeFileSync(`${dest3}.part`, Buffer.alloc(payload.length + 500, 0x78));
    const out3 = await download(url, dest3);
    assert.equal(out3, dest3);
    assert.equal(fs.existsSync(`${dest3}.part`), false);
    assert.deepEqual(fs.readFileSync(dest3), payload);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('download rejects truncated response, keeps .part closed and resumable, and completes on next attempt', async () => {
  const tmp = makeTempDir();
  const payload = Buffer.from('PK\x03\x04' + 'B'.repeat(8192));
  let attempt = 0;

  const server = http.createServer((req, res) => {
    attempt += 1;
    if (attempt === 1) {
      // Send Content-Length for full payload, write only 2048 bytes, then close socket cleanly (TCP FIN)
      // to exercise res.complete / received < total truncation detection and .part preservation.
      res.writeHead(200, { 'Content-Length': String(payload.length) });
      res.write(payload.subarray(0, 2048), () => {
        setTimeout(() => res.socket.end(), 20);
      });
      return;
    }

    // Attempt 2: serve Range resume cleanly
    const range = req.headers.range;
    const m = /^bytes=(\d+)-$/.exec(String(range || ''));
    assert.ok(m, `expected Range header on resume attempt, got ${range}`);
    const start = Number(m[1]);
    assert.ok(start > 0 && start < payload.length, `expected partial offset, got ${start}`);
    const slice = payload.subarray(start);
    res.writeHead(206, {
      'Content-Length': String(slice.length),
      'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`
    });
    res.end(slice);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/electron.zip`;
  const dest = path.join(tmp, 'truncated.zip');

  try {
    await assert.rejects(() => download(url, dest), /Incomplete download|aborted|socket|hang up|ECONNRESET/i);
    assert.equal(fs.existsSync(dest), false, 'truncated download must not produce final .zip');
    assert.equal(fs.existsSync(`${dest}.part`), true, 'partial file must be preserved for resume');
    assert.ok(fs.statSync(`${dest}.part`).size > 0);

    // Immediately resume (verifies Windows file handle was closed before rejection!)
    const out = await download(url, dest);
    assert.equal(out, dest);
    assert.equal(fs.existsSync(`${dest}.part`), false);
    assert.deepEqual(fs.readFileSync(dest), payload);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('probeSpeed supports http:// and enforces hard total timeout on trickle servers', async () => {
  const fastPayload = Buffer.alloc(64 * 1024, 0x41);
  const timers = new Set();

  const server = http.createServer((req, res) => {
    if (req.url === '/fast') {
      res.writeHead(200, { 'Content-Length': String(fastPayload.length) });
      res.end(fastPayload);
      return;
    }
    if (req.url === '/trickle') {
      res.writeHead(200);
      const t = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(t);
          timers.delete(t);
          return;
        }
        res.write('x');
      }, 40);
      timers.add(t);
      res.on('close', () => {
        clearInterval(t);
        timers.delete(t);
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const speed = await probeSpeed(`http://127.0.0.1:${port}/fast`, { ms: 2000, bytes: 64 * 1024 });
    assert.ok(speed > 0, `expected positive speed, got ${speed}`);

    const start = Date.now();
    const trickleSpeed = await probeSpeed(`http://127.0.0.1:${port}/trickle`, { ms: 350, bytes: 512 * 1024 });
    const elapsed = Date.now() - start;
    assert.equal(trickleSpeed, 0);
    assert.ok(elapsed < 1200, `probeSpeed hung too long on trickle server: ${elapsed}ms`);
  } finally {
    for (const t of timers) clearInterval(t);
    await new Promise((resolve) => server.close(resolve));
  }
});

test('resolveProxyForUrl respects HTTP_PROXY, HTTPS_PROXY, and NO_PROXY', () => {
  const env = {
    HTTP_PROXY: 'http://127.0.0.1:7890',
    HTTPS_PROXY: 'http://127.0.0.1:7891',
    NO_PROXY: 'localhost,127.0.0.1,.internal.corp'
  };

  assert.equal(resolveProxyForUrl('https://github.com/electron/electron', env)?.href, 'http://127.0.0.1:7891/');
  assert.equal(resolveProxyForUrl('http://mirror.example.com/file.zip', env)?.href, 'http://127.0.0.1:7890/');
  assert.equal(resolveProxyForUrl('http://127.0.0.1:52399/api/config', env), null);
  assert.equal(resolveProxyForUrl('https://mirror.internal.corp/file.zip', env), null);
});
