import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';
import { createInProcessHud } from './inprocess.js';
import { ensureElectronRuntime, runtimeDir, binPath, exeRelative } from './runtime-fetch.js';
import hudCore from './hud-core.cjs';

const {
  getControlPort,
  generateControlToken,
  readStoredControlToken,
  writeStoredControlToken,
  createEventStore
} = hudCore;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let hudProcess = null;
let inProcessHud = null;
let activeControlToken = '';

// ── 启动计时探针 ────────────────────────────────────────────────────────────
const parsedSpawnDelay = process.env.DSH_HUD_SPAWN_DELAY_MS !== undefined
  ? Number(process.env.DSH_HUD_SPAWN_DELAY_MS)
  : NaN;
const SPAWN_DELAY_MS = Number.isFinite(parsedSpawnDelay) && parsedSpawnDelay >= 0
  ? parsedSpawnDelay
  : 3000;

function bootLog(message) {
  try {
    const dir = path.join(os.homedir(), '.dsh', 'dsh-hud');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'boot.log');
    const line = `${new Date().toISOString()} uptime=${process.uptime().toFixed(1)}s pid=${process.pid} ${message}\n`;
    fs.appendFileSync(file, line, 'utf-8');
    try {
      if (fs.statSync(file).size > 32 * 1024) {
        const keep = fs.readFileSync(file, 'utf-8').split('\n').slice(-200).join('\n');
        fs.writeFileSync(file, keep, 'utf-8');
      }
    } catch (e) {}
  } catch (e) {}
}

bootLog('module imported');

/** 在若干候选路径里挑第一个真实存在的 Electron 可执行文件。 */
function firstExisting(candidates) {
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (e) {}
  }
  return null;
}

/**
 * 解析 Electron 运行时。优先级：
 *   1. 环境变量 DSH_HUD_ELECTRON 显式指定
 *   2. ~/.dsh/electron（共享运行时，按平台解析可执行路径）
 *   3. 本 profile 里安装的 electron 包
 *   4. 包自身 node_modules 里的 electron
 *   5. 当前进程本身就是 Electron（开发/standalone 场景）
 */
export function resolveElectron(_ctx) {
  const envOverride = process.env.DSH_HUD_ELECTRON;
  const relExe = exeRelative();

  const candidates = [
    envOverride,
    binPath(runtimeDir()),
    path.join(process.cwd(), 'node_modules', 'electron', 'dist', relExe),
    path.resolve(__dirname, '../node_modules/electron/dist', relExe),
    path.resolve(__dirname, '../../electron/dist', relExe)
  ];

  // 扫描 profile 的 .pnpm 目录，兼容 pnpm 的软链布局
  try {
    for (const base of [
      path.join(process.cwd(), 'node_modules', '.pnpm'),
      path.resolve(__dirname, '../../../node_modules/.pnpm')
    ]) {
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base)) {
        if (!entry.startsWith('electron@')) continue;
        candidates.push(path.join(base, entry, 'node_modules', 'electron', 'dist', relExe));
      }
    }
  } catch (e) {}

  const found = firstExisting(candidates);
  if (found) return found;

  // 当宿主本身就跑在 Electron 里，且 execPath 确实是一个独立的 electron 二进制
  if (process.versions && process.versions.electron && /electron(\.exe)?$/i.test(path.basename(process.execPath))) {
    return process.execPath;
  }

  return null;
}

function controlRequest(method, pathname, { port = getControlPort(), token = '', timeout = 600 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };

    const headers = {};
    if (token) headers['X-DSH-HUD-Token'] = token;

    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout }, (res) => {
      res.resume();
      done(res.statusCode || 0);
    });
    req.on('error', () => done(0));
    req.on('timeout', () => {
      req.destroy();
      done(0);
    });
    req.end();
  });
}

/** 请控制端口上的气泡窗口退出（用于启动前清理，以及插件卸载时释放文件占用） */
function sendQuit({ port = getControlPort(), token = activeControlToken || readStoredControlToken(), timeout = 700 } = {}) {
  return controlRequest('POST', '/api/quit', { port, token, timeout }).then((code) => code > 0);
}

/** 向旧气泡窗口发一次退出请求；true = 确实请走了 */
async function retireOldHud(ctx, { port = getControlPort(), oldToken = '' } = {}) {
  const probeTokens = [oldToken, ''].filter((v, i, arr) => arr.indexOf(v) === i);
  let matchedToken = '';
  let alive = false;

  for (const tok of probeTokens) {
    const status = await controlRequest('GET', '/api/config', { port, token: tok, timeout: 600 });
    if (status === 200) {
      alive = true;
      matchedToken = tok;
      break;
    }
    if (status === 401) {
      alive = true;
    }
  }

  if (!alive) return false;

  ctx.logger?.info?.('[dsh-hud] 检测到上一轮遗留的气泡窗口，正在让它退出以便加载新版本');
  await controlRequest('POST', '/api/quit', { port, token: matchedToken || oldToken, timeout: 600 });

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const still = await controlRequest('GET', '/api/config', { port, token: matchedToken || oldToken, timeout: 300 });
    if (!still) {
      bootLog('old hud retired');
      ctx.logger?.info?.('[dsh-hud] 旧气泡窗口已退出');
      return true;
    }
  }

  ctx.logger?.warn?.('[dsh-hud] 旧气泡窗口没有响应退出请求，新窗口可能因端口占用而失败（可手动结束 electron.exe 后重启 DSH）');
  return false;
}

function isHudProcessRunning() {
  return Boolean(hudProcess && hudProcess.exitCode === null && !hudProcess.killed);
}

async function ensureHudRunning(ctx, { controlPort = getControlPort(), controlToken = '', oldToken = '' } = {}) {
  if (isHudProcessRunning()) return;
  bootLog('spawn path enter');

  const runtimeDirPath = path.resolve(__dirname, '../runtime');
  const mainScript = path.join(runtimeDirPath, 'main.js');
  if (!fs.existsSync(mainScript)) {
    bootLog('skipped: runtime/main.js missing');
    ctx.logger?.warn?.('[dsh-hud] runtime/main.js missing — HUD window skipped');
    return;
  }

  let electronBin = resolveElectron(ctx);
  if (!electronBin) {
    bootLog('no electron found locally, provisioning runtime');
    try {
      electronBin = await ensureElectronRuntime({ logger: ctx.logger });
    } catch (err) {
      ctx.logger?.warn?.(`[dsh-hud] 自动获取 Electron 运行时失败：${err?.message ?? err}`);
      electronBin = null;
    }
  }

  if (!electronBin) {
    bootLog('skipped: no electron runtime');
    ctx.logger?.warn?.(
      '[dsh-hud] 未找到可用的 Electron 运行时，桌面气泡窗口无法启动。' +
      '可把 electron 放到 ~/.dsh/electron/，或用环境变量 DSH_HUD_ELECTRON 指定路径；' +
      '设置 DSH_HUD_ELECTRON_MIRROR 可换下载镜像。'
    );
    return;
  }

  await retireOldHud(ctx, { port: controlPort, oldToken });

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.DSH_HUD_ELECTRON = electronBin;
  env.DSH_HUD_CONTROL_PORT = String(controlPort);
  if (controlToken) env.DSH_HUD_CONTROL_TOKEN = controlToken;
  env.DSH_HUD_PARENT_PID = String(process.pid);

  // 把宿主真实的 webServer 端口交给桌面窗口，省掉它自己满机器扫端口
  try {
    const port = ctx.webServer?.port;
    if (typeof port === 'number' && port > 0) env.DSH_HUD_PORT = String(port);
  } catch (e) {}

  try {
    const child = spawn(electronBin, [mainScript], {
      detached: true,
      stdio: 'ignore',
      env
    });
    hudProcess = child;

    child.on('error', (err) => {
      if (hudProcess === child) hudProcess = null;
      bootLog(`hud process error: ${err?.message ?? err}`);
      ctx.logger?.warn?.(`[dsh-hud] HUD process error: ${err?.message ?? err}`);
    });

    child.on('exit', (code, signal) => {
      if (hudProcess === child) hudProcess = null;
      bootLog(`hud process exited code=${code} signal=${signal}`);
      if (code && code !== 0) {
        ctx.logger?.warn?.(`[dsh-hud] HUD process exited abnormally (code=${code}, signal=${signal})`);
      }
    });

    child.unref();
    bootLog(`hud spawned via ${electronBin}`);
    ctx.logger?.info?.(`[dsh-hud] HUD window launched via ${electronBin}`);
  } catch (err) {
    hudProcess = null;
    bootLog(`spawn failed: ${err?.message ?? err}`);
    ctx.logger?.warn?.(`[dsh-hud] Failed to spawn HUD process: ${err?.message ?? err}`);
  }
}

// ── 全局多会话事件队列与长轮询订阅 ──────────────────────────────────────────

const subscribers = new Set(); // Set<{ res, since, timer }>

function flushSubscribers() {
  for (const sub of subscribers) {
    clearTimeout(sub.timer);
    try {
      sub.res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      sub.res.end(JSON.stringify(eventStore.getState(sub.since)));
    } catch (e) {}
  }
  subscribers.clear();
}

const eventStore = createEventStore({
  maxEvents: 50,
  onEmit(item) {
    if (item.kind === 'workStatus') {
      inProcessHud?.pushWorkStatus(item.payload.state, item.payload.task);
    } else if (item.kind === 'notify') {
      inProcessHud?.pushNotify(item.payload.event);
    }
    flushSubscribers();
  }
});

export const name = 'dsh-hud';

// 宿主侧依赖：webServer 用于注册 /dsh-hud/state 与 /dsh-hud/control-info 路由
export const inject = ['webServer'];

export function apply(ctx) {
  const controlPort = getControlPort();
  const previousStoredToken = readStoredControlToken();
  activeControlToken = process.env.DSH_HUD_CONTROL_TOKEN || generateControlToken();
  writeStoredControlToken(activeControlToken);

  // 1. 注册 HUD 自主 HTTP 路由：/dsh-hud/state 和 /dsh-hud/control-info
  try {
    if (ctx.webServer && typeof ctx.webServer.register === 'function') {
      ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-hud',
        handler: async (req, res) => {
          let url;
          try {
            url = new URL(req.url ?? '/', 'http://127.0.0.1');
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Bad URL' }));
            return;
          }

          if (url.pathname === '/dsh-hud/control-info' && req.method === 'GET') {
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store'
            });
            res.end(JSON.stringify({ port: controlPort, token: activeControlToken }));
            return;
          }

          if (url.pathname === '/dsh-hud/state' && req.method === 'GET') {
            const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
            const timeout = parseInt(url.searchParams.get('timeout') || '0', 10) || 0;

            if (since > 0 && since >= eventStore.counter && timeout > 0) {
              const sub = { res, since, timer: null };
              sub.timer = setTimeout(() => {
                if (subscribers.has(sub)) {
                  subscribers.delete(sub);
                  try {
                    res.writeHead(200, {
                      'Content-Type': 'application/json; charset=utf-8',
                      'Cache-Control': 'no-cache'
                    });
                    res.end(JSON.stringify(eventStore.getState(since)));
                  } catch (e) {}
                }
              }, Math.min(timeout, 15000));

              subscribers.add(sub);
              res.on('close', () => {
                clearTimeout(sub.timer);
                subscribers.delete(sub);
              });
              return;
            }

            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-cache'
            });
            res.end(JSON.stringify(eventStore.getState(since)));
            return;
          }

          res.writeHead(404).end();
        }
      }), 'dsh-hud: internal state route');
    }
  } catch (error) {
    try { ctx.logger?.warn?.(`[dsh-hud] state route register failed: ${error?.message ?? error}`); } catch (_e) {}
  }

  // 2. 独立监听全局 session/event（多会话隔离 + 环形队列）
  try {
    ctx.effect(() => {
      const dispose = ctx.on('session/event', (session, event) => {
        eventStore.handleSessionEvent(session, event);
      });
      return () => {
        dispose?.();
      };
    }, 'dsh-hud: standalone session watcher');
  } catch (error) {
    try { ctx.logger?.warn?.(`[dsh-hud] session watcher register failed: ${error?.message ?? error}`); } catch (_e) {}
  }

  // 3. 桌面气泡窗口：优先在本进程内开（桌面版零依赖），否则退回 spawn 独立 Electron
  bootLog('apply enter');
  try {
    ctx.effect(() => {
      try {
        inProcessHud = createInProcessHud({
          logger: ctx.logger,
          controlPort,
          controlToken: activeControlToken,
          oldToken: previousStoredToken
        });
      } catch (error) {
        inProcessHud = null;
        try { ctx.logger?.warn?.(`[dsh-hud] in-process HUD failed, falling back to spawn: ${error?.message ?? error}`); } catch (_e) {}
      }

      if (inProcessHud) {
        try { ctx.logger?.info?.('[dsh-hud] HUD window running in-process (no external Electron needed)'); } catch (_e) {}
        return () => {
          try { inProcessHud?.dispose(); } catch (_e) {}
          inProcessHud = null;
        };
      }

      const timer = setTimeout(() => {
        void ensureHudRunning(ctx, {
          controlPort,
          controlToken: activeControlToken,
          oldToken: previousStoredToken
        }).catch((error) => {
          try { ctx.logger?.warn?.(`[dsh-hud] HUD launch failed: ${error?.message ?? error}`); } catch (_e) {}
        });
      }, SPAWN_DELAY_MS);
      bootLog(`apply done, hud spawn scheduled in ${SPAWN_DELAY_MS}ms`);

      return () => {
        clearTimeout(timer);
        void sendQuit({ port: controlPort, token: activeControlToken });
      };
    }, 'dsh-hud: bubble window');
  } catch (error) {
    try { ctx.logger?.warn?.(`[dsh-hud] HUD effect register failed: ${error?.message ?? error}`); } catch (_e) {}
  }
}
