// lib/runtime-fetch.js — bootstrap the bubble window's Electron runtime without asking the user
// to install anything else. The desktop host loads plugins in a Node-mode process, so there is no
// Electron in-process to borrow; and a plugin cannot rely on another plugin (dsh-pet) having
// downloaded one either. So: fetch a portable Electron once into ~/.dsh/electron/ and reuse it.
//
// Deliberately dependency-free: node's http/https (with proxy support) + crypto + tar/ditto/unzip.

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { spawn } from 'child_process';
import hudCore from './hud-core.cjs';

const { isPidAlive } = hudCore;

export const DEFAULT_VERSION = process.env.DSH_HUD_ELECTRON_VERSION || '43.3.0';
const VERSION_FILE = 'version';
const LOCK_DIR = '.download.lock';
const LOCK_OWNER_FILE = 'owner.json';
const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes
const LOCK_GRACE_MS = 2000;
const MIN_BIN_BYTES = 1024 * 1024;

/** Where the shared runtime lives. `DSH_HUD_ELECTRON_DIR` overrides it (tests, custom installs). */
export function runtimeDir() {
  return process.env.DSH_HUD_ELECTRON_DIR || path.join(os.homedir(), '.dsh', 'electron');
}

export function exeRelative(platform = process.platform) {
  if (platform === 'win32') return 'electron.exe';
  if (platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron';
  return 'electron';
}

export function binPath(dir = runtimeDir(), platform = process.platform) {
  return path.join(dir, exeRelative(platform));
}

export function archiveName(version = DEFAULT_VERSION, platform = process.platform, arch = process.arch) {
  const a = arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'ia32' : 'x64';
  if (platform === 'win32') return `electron-v${version}-win32-${a}.zip`;
  if (platform === 'darwin') return `electron-v${version}-darwin-${a}.zip`;
  return `electron-v${version}-linux-${a}.zip`;
}

/** Ordered download sources. Set `DSH_HUD_ELECTRON_MIRROR` to a base URL to put your own first. */
export function mirrorUrls(version = DEFAULT_VERSION, name = archiveName(version)) {
  const urls = [];
  const custom = process.env.DSH_HUD_ELECTRON_MIRROR;
  if (custom) urls.push(`${custom.replace(/\/+$/, '')}/${version}/${name}`);
  urls.push(`https://github.com/electron/electron/releases/download/v${version}/${name}`);
  urls.push(`https://registry.npmmirror.com/-/binary/electron/${version}/${name}`);
  urls.push(`https://mirrors.huaweicloud.com/electron/${version}/${name}`);
  return urls;
}

// ── Protocol & Proxy-aware HTTP(S) Transport ─────────────────────────────────

function shouldBypassProxy(hostname, noProxyEnv = process.env.NO_PROXY || process.env.no_proxy || '') {
  if (!noProxyEnv) return false;
  const host = String(hostname || '').toLowerCase();
  for (const raw of noProxyEnv.split(',')) {
    const rule = raw.trim().toLowerCase();
    if (!rule) continue;
    if (rule === '*') return true;
    const ruleHost = rule.replace(/:\d+$/, '');
    if (ruleHost.startsWith('.')) {
      if (host === ruleHost.slice(1) || host.endsWith(ruleHost)) return true;
    } else if (host === ruleHost || host.endsWith(`.${ruleHost}`)) {
      return true;
    }
  }
  return false;
}

export function resolveProxyForUrl(targetUrl, env = process.env) {
  const parsed = new URL(targetUrl);
  if (shouldBypassProxy(parsed.hostname, env.NO_PROXY || env.no_proxy || '')) return null;
  const raw = parsed.protocol === 'https:'
    ? (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '')
    : (env.HTTP_PROXY || env.http_proxy || '');
  if (!raw || !raw.trim()) return null;
  try {
    return new URL(raw.trim());
  } catch (e) {
    return null;
  }
}

function proxyAuthHeader(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) return null;
  const creds = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
  return `Basic ${Buffer.from(creds, 'utf-8').toString('base64')}`;
}

/**
 * Make an HTTP or HTTPS GET request, automatically honoring HTTP_PROXY / HTTPS_PROXY / NO_PROXY.
 * Returns a controller `{ abort(err) }`.
 */
function httpGet(url, { headers = {}, timeout = 30000 } = {}, onResponse, onError) {
  let target;
  try {
    target = new URL(url);
  } catch (err) {
    queueMicrotask(() => onError(err));
    return { abort() {} };
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    queueMicrotask(() => onError(new Error(`Unsupported protocol: ${target.protocol}`)));
    return { abort() {} };
  }

  const proxy = resolveProxyForUrl(url);
  let activeReq = null;
  let activeTunnelReq = null;
  let aborted = false;

  const failOnce = (() => {
    let called = false;
    return (err) => {
      if (called) return;
      called = true;
      onError(err);
    };
  })();

  const abort = (err) => {
    aborted = true;
    try { activeTunnelReq?.destroy(err); } catch (e) {}
    try { activeReq?.destroy(err); } catch (e) {}
  };

  if (!proxy) {
    const mod = target.protocol === 'https:' ? https : http;
    activeReq = mod.get(target, { headers, timeout }, onResponse);
    activeReq.on('timeout', () => activeReq.destroy(new Error('timeout')));
    activeReq.on('error', failOnce);
    return { abort };
  }

  const proxyMod = proxy.protocol === 'https:' ? https : http;
  const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
  const auth = proxyAuthHeader(proxy);

  if (target.protocol === 'http:') {
    const reqHeaders = { ...headers, Host: target.host };
    if (auth) reqHeaders['Proxy-Authorization'] = auth;
    activeReq = proxyMod.request({
      host: proxy.hostname,
      port: proxyPort,
      method: 'GET',
      path: target.toString(),
      headers: reqHeaders,
      timeout
    }, onResponse);
    activeReq.on('timeout', () => activeReq.destroy(new Error('timeout')));
    activeReq.on('error', failOnce);
    activeReq.end();
    return { abort };
  }

  // HTTPS over HTTP(S) proxy via CONNECT tunnel
  const targetPort = Number(target.port) || 443;
  const connectHeaders = { Host: `${target.hostname}:${targetPort}` };
  if (auth) connectHeaders['Proxy-Authorization'] = auth;

  activeTunnelReq = proxyMod.request({
    host: proxy.hostname,
    port: proxyPort,
    method: 'CONNECT',
    path: `${target.hostname}:${targetPort}`,
    headers: connectHeaders,
    timeout
  });

  activeTunnelReq.on('connect', (proxyRes, socket) => {
    if (aborted) {
      socket.destroy();
      return;
    }
    if (proxyRes.statusCode !== 200) {
      socket.destroy();
      failOnce(new Error(`Proxy CONNECT failed: HTTP ${proxyRes.statusCode}`));
      return;
    }
    activeReq = https.request({
      host: target.hostname,
      port: targetPort,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { ...headers, Host: target.host },
      socket,
      agent: false,
      servername: target.hostname,
      timeout
    }, onResponse);
    activeReq.on('timeout', () => activeReq.destroy(new Error('timeout')));
    activeReq.on('error', failOnce);
    activeReq.end();
  });

  activeTunnelReq.on('timeout', () => activeTunnelReq.destroy(new Error('proxy timeout')));
  activeTunnelReq.on('error', failOnce);
  activeTunnelReq.end();

  return { abort };
}

// ── Speed Probing (with hard total timeout) ──────────────────────────────────

/**
 * Measure a source's throughput in bytes/s (0 = unusable).
 * Timing starts at the FIRST byte; an explicit total deadline prevents trickle-feed stalls.
 */
export function probeSpeed(url, { ms = 8000, bytes = 512 * 1024, redirects = 6, deadline = Date.now() + ms } = {}) {
  return new Promise((resolve) => {
    const remaining = deadline - Date.now();
    if (remaining <= 50) return resolve(0);

    let received = 0;
    let firstByteAt = 0;
    let settled = false;
    let ctrl = null;

    const finish = (forceZero = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (forceZero) return resolve(0);
      if (!firstByteAt || received < 16384) return resolve(0);
      const span = Math.max((performance.now() - firstByteAt) / 1000, 0.001);
      resolve(received / span);
    };

    const hardTimer = setTimeout(() => {
      try { ctrl?.abort(); } catch (e) {}
      finish(false);
    }, remaining);

    ctrl = httpGet(
      url,
      { headers: { Range: `bytes=0-${bytes - 1}` }, timeout: remaining },
      (res) => {
        if (settled) {
          res.resume();
          return;
        }
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          res.resume();
          clearTimeout(hardTimer);
          settled = true;
          const next = new URL(res.headers.location, url).toString();
          probeSpeed(next, { ms, bytes, redirects: redirects - 1, deadline }).then(resolve);
          return;
        }
        if (status !== 200 && status !== 206) {
          res.resume();
          return finish(true);
        }
        res.on('data', (chunk) => {
          if (settled) return;
          if (!firstByteAt) firstByteAt = performance.now();
          received += chunk.length;
          if (received >= bytes) {
            try { ctrl?.abort(); } catch (e) {}
            finish(false);
          }
        });
        res.on('end', () => finish(false));
        res.on('error', () => finish(true));
      },
      () => finish(true)
    );
  });
}

/** Order the sources by measured throughput; unusable ones sink to the end. */
async function rankSources(sources, logger) {
  if (sources.length < 2) return sources;
  const speeds = await Promise.all(sources.map((url) => probeSpeed(url).catch(() => 0)));
  const ranked = sources.map((url, i) => ({ url, speed: speeds[i] })).sort((a, b) => b.speed - a.speed);

  const usable = ranked.filter((x) => x.speed > 0);
  if (!usable.length) {
    logger?.info?.('[dsh-hud] 选源测速全部未通过，按默认顺序尝试');
    return sources;
  }
  logger?.info?.('[dsh-hud] 选源测速：'
    + usable.map((x) => `${new URL(x.url).host} ${(x.speed / 1048576).toFixed(2)} MB/s`).join(' · '));
  return ranked.map((x) => x.url);
}

// ── SHA-256 Checksum Verification ────────────────────────────────────────────

export function parseShasums(text, filename) {
  if (typeof text !== 'string' || !filename) return null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line);
    if (!match) continue;
    const [, hash, name] = match;
    if (name.trim() === filename) return hash.toLowerCase();
  }
  return null;
}

export function verifyFileSha256(filePath, expectedHex) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => {
      const actual = hash.digest('hex').toLowerCase();
      resolve({ ok: actual === String(expectedHex).toLowerCase(), actual, expected: String(expectedHex).toLowerCase() });
    });
  });
}

function fetchText(url, { timeout = 10000, redirects = 6, maxBytes = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (err) reject(err);
      else resolve(val);
    };

    let ctrl = null;
    const hardTimer = setTimeout(() => {
      try { ctrl?.abort(new Error('timeout')); } catch (e) {}
      done(new Error('timeout'));
    }, timeout);

    ctrl = httpGet(
      url,
      { timeout },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          res.resume();
          clearTimeout(hardTimer);
          settled = true;
          const next = new URL(res.headers.location, url).toString();
          fetchText(next, { timeout, redirects: redirects - 1, maxBytes }).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          return done(new Error(`HTTP ${status}`));
        }
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            try { ctrl?.abort(new Error('response too large')); } catch (e) {}
            return done(new Error('response too large'));
          }
          chunks.push(chunk);
        });
        res.on('end', () => done(null, Buffer.concat(chunks).toString('utf-8')));
        res.on('error', (err) => done(err));
      },
      (err) => done(err)
    );
  });
}

export async function fetchExpectedSha256(archiveUrl, filename) {
  try {
    const shasumUrl = new URL('SHASUMS256.txt', archiveUrl).toString();
    const text = await fetchText(shasumUrl, { timeout: 10000 });
    return parseShasums(text, filename);
  } catch (e) {
    return null;
  }
}

// ── Stale-safe Download Lock ─────────────────────────────────────────────────

export function acquireLock(dir, { staleMs = DEFAULT_LOCK_STALE_MS, now = Date.now, pidAlive = isPidAlive } = {}) {
  const lock = path.join(dir, LOCK_DIR);
  const ownerFile = path.join(lock, LOCK_OWNER_FILE);
  fs.mkdirSync(dir, { recursive: true });

  const tryCreate = () => {
    fs.mkdirSync(lock);
    try {
      fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, createdAt: now() }), 'utf-8');
    } catch (e) {}
    return lock;
  };

  try {
    return tryCreate();
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
  }

  // Existing lock found: check whether owner process is dead or lock is stale
  let stale = false;
  try {
    if (fs.existsSync(ownerFile)) {
      const parsed = JSON.parse(fs.readFileSync(ownerFile, 'utf-8'));
      const age = now() - Number(parsed?.createdAt || 0);
      const alive = parsed?.pid ? pidAlive(parsed.pid) : false;
      if (!alive || age > staleMs) stale = true;
    } else {
      const st = fs.statSync(lock);
      const age = now() - st.mtimeMs;
      if (age > LOCK_GRACE_MS) stale = true;
    }
  } catch (e) {
    stale = true;
  }

  if (!stale) return null;

  try {
    fs.rmSync(lock, { recursive: true, force: true });
  } catch (e) {}

  try {
    return tryCreate();
  } catch (e) {
    return null;
  }
}

export function releaseLock(lock) {
  if (!lock) return;
  try {
    fs.rmSync(lock, { recursive: true, force: true });
  } catch (e) {}
}

// ── Download & Extract ───────────────────────────────────────────────────────

function isUsableBinary(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > MIN_BIN_BYTES;
  } catch (e) {
    return false;
  }
}

function safeUnlink(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {}
}

export function download(url, dest, { logger, redirects = 6, retried416 = false } = {}) {
  return new Promise((resolve, reject) => {
    const part = `${dest}.part`;
    let have = 0;
    try { have = fs.statSync(part).size; } catch (e) { have = 0; }

    let settled = false;
    let out = null;
    let activeRes = null;

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val);
    };

    const failWithClose = (err, { destroyStream = false } = {}) => {
      if (settled) return;
      const stream = out;
      out = null;
      try { activeRes?.unpipe?.(stream); } catch (e) {}
      if (!stream || stream.closed) {
        return done(err);
      }
      let closed = false;
      const onClosed = () => {
        if (closed) return;
        closed = true;
        clearTimeout(guard);
        done(err);
      };
      const guard = setTimeout(() => {
        try { stream.destroy(); } catch (e) {}
        onClosed();
      }, 300);
      stream.once('close', onClosed);
      try {
        if (destroyStream) stream.destroy();
        else stream.end();
      } catch (e) {
        onClosed();
      }
    };

    const finishToArchive = () => {
      try {
        safeUnlink(dest);
        fs.renameSync(part, dest);
        done(null, dest);
      } catch (err) {
        done(err);
      }
    };

    httpGet(
      url,
      {
        headers: have > 0 ? { Range: `bytes=${have}-` } : {},
        timeout: 45000
      },
      (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          res.resume();
          settled = true;
          const next = new URL(res.headers.location, url).toString();
          download(next, dest, { logger, redirects: redirects - 1, retried416 }).then(resolve, reject);
          return;
        }

        if (status === 416) {
          res.resume();
          const contentRange = String(res.headers['content-range'] || '');
          const match = /bytes\s+\*\/(\d+)/i.exec(contentRange);
          const remoteTotal = match ? Number(match[1]) : 0;
          if (remoteTotal > 0 && have === remoteTotal) {
            return finishToArchive();
          }
          // .part size does not match remote file (corrupt or mismatched mirror): wipe and retry fresh once
          safeUnlink(part);
          if (!retried416) {
            settled = true;
            download(url, dest, { logger, redirects, retried416: true }).then(resolve, reject);
            return;
          }
          return done(new Error('HTTP 416 (invalid partial file)'));
        }

        if (status !== 200 && status !== 206) {
          res.resume();
          return done(new Error(`HTTP ${status}`));
        }

        const resuming = status === 206 && have > 0;
        const contentLength = Number(res.headers['content-length'] || 0);
        const total = contentLength > 0 ? contentLength + (resuming ? have : 0) : 0;
        let received = resuming ? have : 0;
        let nextMark = 20;

        activeRes = res;
        out = fs.createWriteStream(part, { flags: resuming ? 'a' : 'w' });
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0) {
            const pct = Math.floor((received / total) * 100);
            if (pct >= nextMark) {
              nextMark = pct - (pct % 20) + 20;
              logger?.info?.(`[dsh-hud] Electron 运行时下载 ${Math.min(100, pct)}% `
                + `(${(received / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`);
            }
          }
        });
        res.on('aborted', () => failWithClose(new Error('Incomplete download (response aborted)')));
        res.on('close', () => {
          if (!res.complete) {
            failWithClose(new Error('Incomplete download (connection closed early)'));
          }
        });
        res.on('error', (err) => failWithClose(err));

        out.on('error', (err) => failWithClose(err, { destroyStream: true }));
        out.on('finish', () => {
          // If failWithClose already took ownership of `out`, do not rename or double-settle
          if (!out || settled) return;
          const stream = out;
          out = null;
          const incomplete = !res.complete || (total > 0 && received < total);
          if (incomplete) {
            const err = new Error(`Incomplete download (${received}/${total || '?'} bytes)`);
            if (stream.closed) return done(err);
            stream.close(() => done(err));
            return;
          }
          if (stream.closed) return finishToArchive();
          stream.close(() => finishToArchive());
        });

        res.pipe(out);
      },
      (err) => failWithClose(err)
    );
  });
}

export function buildExtractAttempts(archive, dir, platform = process.platform) {
  if (platform === 'win32') {
    return [
      { cmd: 'tar', args: ['-xf', archive, '-C', dir], env: null },
      {
        cmd: 'powershell',
        args: [
          '-NoProfile',
          '-Command',
          'Expand-Archive -LiteralPath $env:DSH_HUD_ARCHIVE -DestinationPath $env:DSH_HUD_EXTRACT_DIR -Force'
        ],
        env: { DSH_HUD_ARCHIVE: archive, DSH_HUD_EXTRACT_DIR: dir }
      }
    ];
  }
  if (platform === 'darwin') {
    return [{ cmd: 'ditto', args: ['-x', '-k', archive, dir], env: null }];
  }
  return [{ cmd: 'unzip', args: ['-o', archive, '-d', dir], env: null }];
}

function extract(archive, dir) {
  const attempts = buildExtractAttempts(archive, dir);
  fs.mkdirSync(dir, { recursive: true });

  return new Promise((resolve, reject) => {
    const tryNext = (i, lastError) => {
      if (i >= attempts.length) return reject(lastError || new Error('no extractor available'));
      const { cmd, args, env } = attempts[i];
      const spawnOpts = {
        stdio: 'ignore',
        windowsHide: true,
        ...(env ? { env: { ...process.env, ...env } } : {})
      };
      const child = spawn(cmd, args, spawnOpts);
      let handled = false;
      const fail = (err) => {
        if (handled) return;
        handled = true;
        tryNext(i + 1, err);
      };
      child.on('error', fail);
      child.on('exit', (code) => {
        if (handled) return;
        handled = true;
        if (code === 0) resolve();
        else tryNext(i + 1, new Error(`${cmd} exited ${code}`));
      });
    };
    tryNext(0);
  });
}

/**
 * Make sure a usable Electron exists for the bubble window.
 * Returns the binary path, or null when every source failed (the caller then just skips the window).
 */
export async function ensureElectronRuntime({
  logger,
  dir = runtimeDir(),
  version = DEFAULT_VERSION,
  sources: customSources,
  lockStaleMs = DEFAULT_LOCK_STALE_MS
} = {}) {
  const bin = binPath(dir);
  if (isUsableBinary(bin)) return bin;

  const lock = acquireLock(dir, { staleMs: lockStaleMs });
  if (!lock) {
    logger?.info?.('[dsh-hud] 另一个进程正在获取 Electron 运行时，本次跳过');
    return isUsableBinary(bin) ? bin : null;
  }

  try {
    const filename = archiveName(version);
    const archive = path.join(dir, filename);
    const part = `${archive}.part`;
    const sources = customSources || await rankSources(mirrorUrls(version, filename), logger);

    for (const url of sources) {
      let host = url;
      try { host = new URL(url).host; } catch (e) {}
      let downloadedFile = null;
      try {
        logger?.info?.(`[dsh-hud] 未找到 Electron 运行时，正在从 ${host} 获取 electron ${version}`);
        const expectedSha = await fetchExpectedSha256(url, filename);
        downloadedFile = await download(url, archive, { logger });

        if (expectedSha) {
          const check = await verifyFileSha256(downloadedFile, expectedSha);
          if (!check.ok) {
            throw new Error(`SHA256 校验失败 (expected ${check.expected.slice(0, 12)}..., got ${check.actual.slice(0, 12)}...)`);
          }
        }

        await extract(downloadedFile, dir);
        safeUnlink(downloadedFile);
        safeUnlink(part);

        if (!isUsableBinary(bin)) throw new Error('解压后没有可用的 electron 可执行文件');
        try { fs.writeFileSync(path.join(dir, VERSION_FILE), `${version}\n`, 'utf-8'); } catch (e) {}
        if (process.platform !== 'win32') { try { fs.chmodSync(bin, 0o755); } catch (e) {} }
        logger?.info?.(`[dsh-hud] Electron 运行时已就绪：${bin}`);
        return bin;
      } catch (err) {
        // 仅在下载完成后校验/解压/产物失败时清理损坏归档；普通网络抖动/断连保留 .part 供下一个源断点续传
        if (downloadedFile) {
          safeUnlink(downloadedFile);
          safeUnlink(archive);
          safeUnlink(part);
        }
        logger?.warn?.(`[dsh-hud] ${host} 获取失败：${err?.message ?? err}（会尝试下一个来源）`);
      }
    }
    return null;
  } finally {
    releaseLock(lock);
  }
}
