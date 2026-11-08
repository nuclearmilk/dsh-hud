// lib/runtime-fetch.js — bootstrap the bubble window's Electron runtime without asking the user
// to install anything else. The desktop host loads plugins in a Node-mode process, so there is no
// Electron in-process to borrow; and a plugin cannot rely on another plugin (dsh-pet) having
// downloaded one either. So: fetch a portable Electron once into ~/.dsh/electron/ and reuse it.
//
// Deliberately dependency-free: node's https + the system's tar/ditto/unzip.
// Mirrors are tried in order (domestic first — that is where the throughput is), with resume:
// an interrupted run leaves <archive>.part behind and the next run continues from there.

import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import { spawn } from 'child_process';

export const DEFAULT_VERSION = process.env.DSH_HUD_ELECTRON_VERSION || '43.3.0';
const VERSION_FILE = 'version';
const LOCK_DIR = '.download.lock';
const MIN_BIN_BYTES = 1024 * 1024;

/** Where the shared runtime lives. `DSH_HUD_ELECTRON_DIR` overrides it (tests, custom installs). */
export function runtimeDir() {
  return process.env.DSH_HUD_ELECTRON_DIR || path.join(os.homedir(), '.dsh', 'electron');
}

function exeRelative() {
  if (process.platform === 'win32') return 'electron.exe';
  if (process.platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron';
  return 'electron';
}

export function binPath(dir = runtimeDir()) {
  return path.join(dir, exeRelative());
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

/**
 * Measure a source's throughput in bytes/s (0 = unusable).
 * Timing starts at the FIRST byte, not at the request: a 3 s TLS/TTFB on GitHub would otherwise
 * score an otherwise-fast source as zero. Whatever arrived before the timeout still counts.
 */
export function probeSpeed(url, { ms = 8000, bytes = 512 * 1024, redirects = 6 } = {}) {
  return new Promise((resolve) => {
    let received = 0;
    let firstByteAt = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const span = firstByteAt ? (Date.now() - firstByteAt) / 1000 : 0;
      resolve(received >= 16384 && span > 0 ? received / Math.max(span, 0.001) : 0);
    };

    const req = https.get(url, { headers: { Range: `bytes=0-${bytes - 1}` }, timeout: ms }, (res) => {
      const status = res.statusCode || 0;
      // both release hosts answer with a redirect to their CDN: follow it, or nothing is measured
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        settled = true;
        probeSpeed(next, { ms, bytes, redirects: redirects - 1 }).then(resolve);
        return;
      }
      if (status !== 200 && status !== 206) { res.resume(); settled = true; return resolve(0); }
      res.on('data', (chunk) => {
        if (!firstByteAt) firstByteAt = Date.now();
        received += chunk.length;
        if (received >= bytes) { req.destroy(); finish(); }
      });
      res.on('end', finish);
      res.on('error', () => { settled = true; resolve(0); });
    });
    req.on('timeout', () => { req.destroy(); finish(); });
    req.on('error', () => { settled = true; resolve(0); });
    req.on('close', finish);
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

function isUsableBinary(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > MIN_BIN_BYTES;
  } catch (e) {
    return false;
  }
}

function download(url, dest, { logger, redirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const part = `${dest}.part`;
    let have = 0;
    try { have = fs.statSync(part).size; } catch (e) { have = 0; }

    const req = https.get(url, {
      headers: have > 0 ? { Range: `bytes=${have}-` } : {},
      timeout: 45000,
    }, (res) => {
      const status = res.statusCode || 0;

      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        download(next, dest, { logger, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (status === 416) {           // nothing left to fetch: the .part is already complete
        res.resume();
        resolve(part);
        return;
      }
      if (status !== 200 && status !== 206) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }

      const resuming = status === 206 && have > 0;
      const total = Number(res.headers['content-length'] || 0) + (resuming ? have : 0);
      let received = resuming ? have : 0;
      let nextMark = 20;

      const out = fs.createWriteStream(part, { flags: resuming ? 'a' : 'w' });
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
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(part)));
      out.on('error', reject);
      res.on('error', reject);
    });

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function extract(archive, dir) {
  const platform = process.platform;
  const attempts = platform === 'win32'
    ? [['tar', ['-xf', archive, '-C', dir]], ['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dir}' -Force`]]]
    : platform === 'darwin'
      ? [['ditto', ['-x', '-k', archive, dir]]]
      : [['unzip', ['-o', archive, '-d', dir]]];

  fs.mkdirSync(dir, { recursive: true });

  return new Promise((resolve, reject) => {
    const tryNext = (i, lastError) => {
      if (i >= attempts.length) return reject(lastError || new Error('no extractor available'));
      const [cmd, args] = attempts[i];
      const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
      child.on('error', (err) => tryNext(i + 1, err));
      child.on('exit', (code) => (code === 0 ? resolve() : tryNext(i + 1, new Error(`${cmd} exited ${code}`))));
    };
    tryNext(0);
  });
}

/**
 * Make sure a usable Electron exists for the bubble window.
 * Returns the binary path, or null when every source failed (the caller then just skips the window).
 */
export async function ensureElectronRuntime({ logger, dir = runtimeDir(), version = DEFAULT_VERSION } = {}) {
  const bin = binPath(dir);
  if (isUsableBinary(bin)) return bin;

  const lock = path.join(dir, LOCK_DIR);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(lock);                        // atomic: fails if another instance is already fetching
  } catch (e) {
    logger?.info?.('[dsh-hud] 另一个进程正在获取 Electron 运行时，本次跳过');
    return isUsableBinary(bin) ? bin : null;
  }

  try {
    const archive = path.join(dir, archiveName(version));
    const sources = await rankSources(mirrorUrls(version), logger);

    for (const url of sources) {
      let host = url;
      try { host = new URL(url).host; } catch (e) {}
      try {
        logger?.info?.(`[dsh-hud] 未找到 Electron 运行时，正在从 ${host} 获取 electron ${version}`);
        const file = await download(url, archive, { logger });
        await extract(file, dir);
        try { fs.unlinkSync(file); } catch (e) {}

        if (!isUsableBinary(bin)) throw new Error('解压后没有可用的 electron 可执行文件');
        try { fs.writeFileSync(path.join(dir, VERSION_FILE), `${version}\n`, 'utf-8'); } catch (e) {}
        if (process.platform !== 'win32') { try { fs.chmodSync(bin, 0o755); } catch (e) {} }
        logger?.info?.(`[dsh-hud] Electron 运行时已就绪：${bin}`);
        return bin;
      } catch (err) {
        logger?.warn?.(`[dsh-hud] ${host} 获取失败：${err?.message ?? err}（会尝试下一个来源）`);
      }
    }
    return null;
  } finally {
    try { fs.rmdirSync(lock); } catch (e) {}
  }
}
