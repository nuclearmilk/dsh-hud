import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';
import { createInProcessHud } from './inprocess.js';
import { ensureElectronRuntime, runtimeDir } from './runtime-fetch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let hudProcess = null;

const isWin = process.platform === 'win32';
const exeName = isWin ? 'electron.exe' : 'electron';

// ── 启动计时探针 ────────────────────────────────────────────────────────────
// 用 process.uptime() 记录「宿主启动后多久轮到本插件」。宿主自身没有启动计时开关，
// 而排查「DSH 启动慢」时最需要知道的正是这个数：如果 apply 发生在 45 秒，
// 那 45 秒就被它的上游吃掉了，与我们无关。每条一行，最多保留最近 32 KB。
const SPAWN_DELAY_MS = Math.max(0, Number(process.env.DSH_HUD_SPAWN_DELAY_MS ?? 3000) || 0);

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
 *   2. ~/.dsh/electron（dsh-pet 等插件自动下载的共享运行时）
 *   3. 本 profile 里安装的 electron 包
 *   4. 包自身 node_modules 里的 electron
 *   5. 当前进程本身就是 Electron（开发/standalone 场景）
 */
export function resolveElectron(ctx) {
  const envOverride = process.env.DSH_HUD_ELECTRON;

  const candidates = [
    envOverride,
    path.join(runtimeDir(), exeName),          // 共享运行时目录（DSH_HUD_ELECTRON_DIR 可改）
    path.join(process.cwd(), 'node_modules', 'electron', 'dist', exeName),
    path.resolve(__dirname, '../node_modules/electron/dist', exeName),
    path.resolve(__dirname, '../../electron/dist', exeName)
  ];

  // 4. 扫描 profile 的 .pnpm 目录，兼容 pnpm 的软链布局
  try {
    for (const base of [
      path.join(process.cwd(), 'node_modules', '.pnpm'),
      path.resolve(__dirname, '../../../node_modules/.pnpm')
    ]) {
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base)) {
        if (!entry.startsWith('electron@')) continue;
        candidates.push(path.join(base, entry, 'node_modules', 'electron', 'dist', exeName));
      }
    }
  } catch (e) {}

  const found = firstExisting(candidates);
  if (found) return found;

  // 5. 当宿主本身就跑在 Electron 里，且 execPath 确实是一个独立的 electron 二进制
  if (process.versions && process.versions.electron && /electron(\.exe)?$/i.test(path.basename(process.execPath))) {
    return process.execPath;
  }

  return null;
}

/** 请 52399 上的气泡窗口退出（用于启动前清理，以及插件卸载时释放文件占用） */
function sendQuit(timeout = 700) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 52399, path: '/api/quit', method: 'POST', timeout }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** 向 52399 上的旧气泡窗口发一次退出请求；true = 确实请走了 */
function retireOldHud(ctx) {
  const ask = (method, pathname, timeout = 600) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 52399, path: pathname, method, timeout }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });

  return new Promise((resolve) => {
    ask('GET', '/api/config').then(async (alive) => {
      if (!alive) return resolve(false);
      ctx.logger?.info?.('[dsh-hud] 检测到上一轮遗留的气泡窗口，正在让它退出以便加载新版本');
      await ask('POST', '/api/quit');

      for (let i = 0; i < 10; i++) {          // 等端口真正释放，最多 2 秒
        await new Promise((r) => setTimeout(r, 200));
        const still = await ask('GET', '/api/config', 300);
        if (!still) {
          bootLog('old hud retired');
          ctx.logger?.info?.('[dsh-hud] 旧气泡窗口已退出');
          return resolve(true);
        }
      }
      ctx.logger?.warn?.('[dsh-hud] 旧气泡窗口没有响应退出请求，新窗口可能因端口占用而失败（可手动结束 electron.exe 后重启 DSH）');
      resolve(false);
    }).catch(() => resolve(false));
  });
}

async function ensureHudRunning(ctx) {
  if (hudProcess && !hudProcess.killed) return;
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
    // 宿主跑在 Node 模式的 Electron 子进程里，借不到 BrowserWindow；
    // 也不能指望别的插件替我们下运行时，所以自己取一份到共享目录。
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

  // 上一轮 DSH 启动时留下的气泡窗口是 detached 的，重启 DSH 不会带走它；
  // 它会继续占着 52399，让新窗口因端口冲突而自行退出——于是界面永远停在旧版本。
  // 先请旧实例退场，等端口释放，再拉起新窗口。
  await retireOldHud(ctx);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.DSH_HUD_ELECTRON = electronBin;

  // 把宿主真实的 webServer 端口交给桌面窗口，省掉它自己满机器扫端口
  try {
    const port = ctx.webServer?.port;
    if (typeof port === 'number' && port > 0) env.DSH_HUD_PORT = String(port);
  } catch (e) {}

  try {
    hudProcess = spawn(electronBin, [mainScript], {
      detached: true,
      stdio: 'ignore',
      env
    });
    hudProcess.unref();
    bootLog(`hud spawned via ${electronBin}`);
    ctx.logger?.info?.(`[dsh-hud] HUD window launched via ${electronBin}`);
  } catch (err) {
    bootLog(`spawn failed: ${err?.message ?? err}`);
    ctx.logger?.warn?.(`[dsh-hud] Failed to spawn HUD process: ${err.message}`);
  }
}

// 维护全局实时状态队列
let stateSeq = 1;
let inProcessHud = null;
const stateData = {
  counter: Date.now(),
  sections: {
    workStatus: { counter: 0, data: null },
    notify: { counter: 0, data: null }
  }
};

const subscribers = new Set();

// 单调递增序号：同一毫秒内多次更新也必须递增，否则 HUD 轮询会漏掉事件
let seq = Date.now();
function nextSeq() {
  seq += 1;
  return seq;
}

function notifySubscribers(bumpCounter = true) {
  if (bumpCounter) stateData.counter = nextSeq();
  for (const res of subscribers) {
    try {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(JSON.stringify(stateData));
    } catch (e) {}
  }
  subscribers.clear();
}

function updateWorkStatus(state, task = null) {
  stateData.sections.workStatus = {
    counter: nextSeq(),
    data: { state, task, ts: Date.now() }
  };
  // in-process window: push straight to the renderer, no HTTP round trip
  inProcessHud?.pushWorkStatus(state, task);
  notifySubscribers();
}

function updateNotify(event) {
  stateData.sections.notify = {
    counter: nextSeq(),
    // ts 让桌面端能判断这一帧是不是上一轮遗留的旧总结
    data: { type: 'session/event', event, ts: Date.now() }
  };
  inProcessHud?.pushNotify(event);
  notifySubscribers();
}

export const name = 'dsh-hud';

// 宿主侧依赖：webServer 用于注册 /dsh-hud/state 事件路由
export const inject = ['webServer'];

export function apply(ctx) {
  // 1. 注册 HUD 自主 HTTP 路由 /dsh-hud/state
  try {
    if (ctx.webServer && typeof ctx.webServer.register === 'function') {
      ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-hud',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/dsh-hud/state') {
          const since = parseInt(url.searchParams.get('since') || '0', 10);
          const timeout = parseInt(url.searchParams.get('timeout') || '0', 10);

          if (since && since >= stateData.counter && timeout > 0) {
            // 长轮询挂起
            subscribers.add(res);
            const timer = setTimeout(() => {
              if (subscribers.has(res)) {
                subscribers.delete(res);
                try {
                  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                  res.end(JSON.stringify(stateData));
                } catch (e) {}
              }
            }, Math.min(timeout, 15000));

            res.on('close', () => {
              clearTimeout(timer);
              subscribers.delete(res);
            });
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(stateData));
          return;
        }

        res.writeHead(404).end();
      }
    }), 'dsh-hud: internal state route');
    }
  } catch (error) {
    try { ctx.logger?.warn?.(`[dsh-hud] state route register failed: ${error?.message ?? error}`); } catch (_e) {}
  }

  // 2. 独立监听全局 session/event
  try {
    ctx.effect(() => {
      let lastTurnText = '';

      const dispose = ctx.on('session/event', (session, event) => {
      const type = event?.type;
      if (!type) return;

      if (type === 'turn/start') {
        lastTurnText = '';
        stateData.sections.notify = { counter: nextSeq(), data: null };
        // 本轮开始：常驻气泡亮起，直到 turn/end 才熄灭
        updateWorkStatus('busy', '正在梳理思路与执行方案...');
        return;
      }

      if (type === 'tool/call') {
        const toolName = event.data?.name || '底层工具';
        updateWorkStatus('working', `正在调用 ${toolName} 执行任务...`);
        return;
      }

      if (type === 'tool/result') {
        updateWorkStatus('result', '这一步处理好啦');
        return;
      }

      if (type === 'assistant/message') {
        const content = event.data?.message?.content;
        if (Array.isArray(content)) {
          for (let i = content.length - 1; i >= 0; i--) {
            const block = content[i];
            if (block?.type === 'text' && typeof block.text === 'string') {
              const clean = block.text.trim();
              if (clean) {
                lastTurnText = clean;
                break;
              }
            }
          }
        }
        return;
      }

      if (type === 'turn/end') {
        updateWorkStatus('idle');
        updateNotify({
          type: 'turn/end',
          data: {
            reason: event.data?.reason,
            text: lastTurnText || '任务执行完毕！'
          }
        });
      }
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
        inProcessHud = createInProcessHud({ logger: ctx.logger });
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

      // 延后拉窗口：Electron 冷启动要吃磁盘和 CPU，和 DSH 自己的启动抢资源。
      // 默认推迟 3 秒（可用 DSH_HUD_SPAWN_DELAY_MS 调整，0 = 立即）。
      const timer = setTimeout(() => {
        void ensureHudRunning(ctx).catch((error) => {
          try { ctx.logger?.warn?.(`[dsh-hud] HUD launch failed: ${error?.message ?? error}`); } catch (_e) {}
        });
      }, SPAWN_DELAY_MS);
      bootLog(`apply done, hud spawn scheduled in ${SPAWN_DELAY_MS}ms`);

      return () => {
        clearTimeout(timer);
        // spawn 出的子进程是 detached 的，插件卸载时主动请它退出，避免锁住包目录导致升级 EPERM
        void sendQuit();
      };
    }, 'dsh-hud: bubble window');
  } catch (error) {
    try { ctx.logger?.warn?.(`[dsh-hud] HUD effect register failed: ${error?.message ?? error}`); } catch (_e) {}
  }
}
