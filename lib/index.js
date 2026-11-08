import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createInProcessHud } from './inprocess.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let hudProcess = null;

const isWin = process.platform === 'win32';
const exeName = isWin ? 'electron.exe' : 'electron';

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
  const dirs = [__dirname];

  const candidates = [
    envOverride,
    path.join(os.homedir(), '.dsh', 'electron', exeName),
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

function ensureHudRunning(ctx) {
  if (hudProcess && !hudProcess.killed) return;

  const runtimeDir = path.resolve(__dirname, '../runtime');
  const mainScript = path.join(runtimeDir, 'main.js');
  if (!fs.existsSync(mainScript)) {
    ctx.logger?.warn?.('[dsh-hud] runtime/main.js missing — HUD window skipped');
    return;
  }

  const electronBin = resolveElectron(ctx);
  if (!electronBin) {
    ctx.logger?.warn?.(
      '[dsh-hud] 未找到 Electron 运行时，桌面气泡窗口无法启动。' +
      '可安装 electron（如 dsh-pet 提供的 ~/.dsh/electron），或用环境变量 DSH_HUD_ELECTRON 指定路径。'
    );
    return;
  }

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
    ctx.logger?.info?.(`[dsh-hud] HUD window launched via ${electronBin}`);
  } catch (err) {
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
        updateWorkStatus('thinking', '正在梳理思路与执行方案...');
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
        updateWorkStatus('success');
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

      try {
        ensureHudRunning(ctx);
      } catch (error) {
        try { ctx.logger?.warn?.(`[dsh-hud] HUD launch failed: ${error?.message ?? error}`); } catch (_e) {}
      }
      return () => { /* spawned child is detached and outlives this effect by design */ };
    }, 'dsh-hud: bubble window');
  } catch (error) {
    try { ctx.logger?.warn?.(`[dsh-hud] HUD effect register failed: ${error?.message ?? error}`); } catch (_e) {}
  }
}
