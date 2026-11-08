const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');

let mainWindow = null;
const DSH_PORT = 52327;

// 独立的 app 名：让 userData 落到 %APPDATA%/dsh-hud，而不是与其它 Electron 应用共用的 "Electron" 目录
try { app.setName('dsh-hud'); } catch (e) {}

// 配置写入用户数据目录，避免写入只读的包安装目录
function resolveConfigPath() {
  try {
    const dir = app.getPath('userData');
    return path.join(dir, 'dsh-hud-config.json');
  } catch (e) {
    return path.join(__dirname, 'config.json');
  }
}
const CONFIG_PATH = resolveConfigPath();
// 旧版路径（包目录内），用于一次性迁移
const LEGACY_CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  allRight: true,
  persistWorking: true,
  showRunningBubble: true,
  duration: 8500,
  screenPosition: 'right', // 'right' | 'left' | 'custom'
  customX: null,
  customY: null,
  isMovable: false, // 锁定 / 移动 模式
  bubbleTheme: 'light', // 'light' | 'dark'
  bubbleOpacity: 85, // 20 ~ 100 整数百分比
  avatarType: 'preset-purple', // 'preset-purple' | 'color' | 'monet' | 'custom'
  avatarColor: '#8b5cf6',
  avatarGradient: 'linear-gradient(135deg, #a78bfa, #c084fc)',
  customAvatar: '',
  fontFamily: 'system',
  fontSize: 14
};

function loadConfig() {
  try {
    // 一次性迁移旧配置：包内旧路径 → 旧版全局安装目录 → 早期共用 "Electron" userData
    const legacyCandidates = [
      LEGACY_CONFIG_PATH,
      path.join(os.homedir(), '.dsh', 'dsh-hud', 'config.json'),
      path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Electron', 'dsh-hud-config.json')
    ];
    const readLegacy = () => {
      for (const legacy of legacyCandidates) {
        try {
          if (!fs.existsSync(legacy)) continue;
          const parsed = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
          if (parsed && typeof parsed === 'object') return parsed;
        } catch (e) {}
      }
      return null;
    };
    const writeConfig = (cfg) => {
      try {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
      } catch (e) {}
    };

    if (fs.existsSync(CONFIG_PATH)) {
      const current = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
      // 若用户数据目录里还是全默认值，而旧配置带有真实偏好，则优先沿用旧偏好
      const isAllDefault = Object.keys(DEFAULT_CONFIG).every(
        (k) => JSON.stringify(current[k]) === JSON.stringify(DEFAULT_CONFIG[k])
      );
      if (!isAllDefault) return current;
      const legacy = readLegacy();
      if (legacy) {
        const merged = { ...DEFAULT_CONFIG, ...legacy };
        writeConfig(merged);
        return merged;
      }
      return current;
    }

    const legacy = readLegacy();
    if (legacy) {
      const merged = { ...DEFAULT_CONFIG, ...legacy };
      writeConfig(merged);
      return merged;
    }
  } catch (e) {}
  return { ...DEFAULT_CONFIG };
}

let hudConfig = loadConfig();

let cachedSystemFonts = null;
function getSystemFonts() {
  return new Promise((resolve) => {
    if (cachedSystemFonts) return resolve(cachedSystemFonts);
    // 从 Windows 注册表读取真实安装的系统字体列表
    const cmd = `powershell -NoProfile -Command "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name"`;
    exec(cmd, { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) {
        cachedSystemFonts = [
          'Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'FangSong',
          'Arial', 'Segoe UI', 'Consolas', 'Comic Sans MS'
        ];
        return resolve(cachedSystemFonts);
      }
      const rawList = stdout.split(/\r?\n/)
        .map(s => s.replace(/\s*\([^)]*\)\s*;?/g, '').trim())
        .filter(s => s && !s.startsWith('@'));
      const set = new Set();
      // 提取字族主名称
      for (const f of rawList) {
        const clean = f.replace(/( Bold| Italic| Light| Semibold| Black| Regular| Medium)+/gi, '').trim();
        if (clean) set.add(clean);
      }
      cachedSystemFonts = Array.from(set).sort((a, b) => a.localeCompare(b));
      resolve(cachedSystemFonts);
    });
  });
}

function updateWindowPosition(pos) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workArea;

  const winWidth = 380;
  const winHeight = 680;
  let x = pos === 'left' ? 16 : screenWidth - winWidth - 16;
  let y = Math.round((screenHeight - winHeight) / 2);

  if (pos === 'custom' && typeof hudConfig.customX === 'number' && typeof hudConfig.customY === 'number') {
    x = hudConfig.customX;
    y = hudConfig.customY;
  }

  mainWindow.setBounds({ x, y, width: winWidth, height: winHeight });
}

function applyIgnoreMouseEvents() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 锁定模式下全窗口鼠标穿透（包括周围透明区域和气泡），完全不挡桌面操作
  // 移动模式下恢复鼠标交互，方便抓取和拖拽气泡
  if (hudConfig.isMovable) {
    mainWindow.setIgnoreMouseEvents(false);
  } else {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

function saveConfig(newCfg) {
  try {
    const oldPos = hudConfig.screenPosition;
    const oldMovable = hudConfig.isMovable;
    hudConfig = { ...hudConfig, ...newCfg };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(hudConfig, null, 2), 'utf-8');

    // 只有在明确传入新的 screenPosition 或者明确修改 customX 时才重新计算窗口坐标
    // 锁定/解锁模式切换绝不重置自定义坐标！
    if (newCfg.screenPosition !== undefined && newCfg.screenPosition !== oldPos || newCfg.customX !== undefined) {
      updateWindowPosition(hudConfig.screenPosition);
    }

    if (hudConfig.isMovable !== oldMovable) {
      applyIgnoreMouseEvents();
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dsh-hud:config-updated', hudConfig);
    }
  } catch (e) {}
}

function startLocalControlServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    if (parsedUrl.pathname === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(hudConfig));
      return;
    }

    if (parsedUrl.pathname === '/api/fonts' && req.method === 'GET') {
      const fonts = await getSystemFonts();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fonts }));
      return;
    }

    if (parsedUrl.pathname === '/api/config' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          saveConfig(parsed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, config: hudConfig }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (parsedUrl.pathname === '/api/quit' && req.method === 'POST') {
      // 桌面宿主改用进程内窗口后，旧实例可能还占着 52399：留一个体面的退出通道
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => { try { app.quit(); } catch (e) {} }, 50);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.on('error', (err) => {
    // 端口被占用（典型情况：已有一个 HUD 实例在跑）→ 静默退出本实例，不干扰 DSH
    if (err && err.code === 'EADDRINUSE') {
      try { app.quit(); } catch (e) {}
      return;
    }
    try { console.error('[dsh-hud] local server error:', err); } catch (e) {}
  });
  server.listen(52399, '127.0.0.1');
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workArea;

  const winWidth = 380;
  const winHeight = 680;
  let x = hudConfig.screenPosition === 'left' ? 16 : screenWidth - winWidth - 16;
  let y = Math.round((screenHeight - winHeight) / 2);

  if (hudConfig.screenPosition === 'custom' && typeof hudConfig.customX === 'number' && typeof hudConfig.customY === 'number') {
    x = hudConfig.customX;
    y = hudConfig.customY;
  }

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: x,
    y: y,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    focusable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: false
    }
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.webContents.setBackgroundThrottling(false);

  mainWindow.once('ready-to-show', () => {
    mainWindow.showInactive();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.showInactive();
      }
    }, 300);
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    applyIgnoreMouseEvents();
    mainWindow.webContents.send('dsh-hud:config-updated', hudConfig);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  ipcMain.on('dsh-hud:window-dragged', (event, { x: newX, y: newY }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setPosition(Math.round(newX), Math.round(newY));
    hudConfig.screenPosition = 'custom';
    hudConfig.customX = Math.round(newX);
    hudConfig.customY = Math.round(newY);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(hudConfig, null, 2), 'utf-8');
  });

  startEventPolling();
}

let lastCounter = 0;
let isPolling = false;

// 宿主插件会把真实 webServer 端口写进环境变量，优先使用它
const ENV_DSH_PORT = parseInt(process.env.DSH_HUD_PORT || '0', 10) || 0;
let currentDshPort = ENV_DSH_PORT || 56150;

/** 跨平台列出本机正在监听的 TCP 端口（仅回环）。 */
function listListeningPorts(cb) {
  const isWin = process.platform === 'win32';
  const cmd = isWin
    ? 'netstat -ano | findstr 127.0.0.1 | findstr LISTENING'
    : "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || ss -ltn 2>/dev/null";

  exec(cmd, { windowsHide: true }, (err, stdout) => {
    const ports = [];
    if (stdout) {
      const regex = isWin ? /127\.0\.0\.1:(\d+)/g : /(?:127\.0\.0\.1|\[::1\]|\*|\d+\.\d+\.\d+\.\d+)[:.](\d+)/g;
      let m;
      while ((m = regex.exec(stdout)) !== null) {
        const p = parseInt(m[1], 10);
        if (!Number.isFinite(p) || p === 52399) continue;
        if (!ports.includes(p)) ports.push(p);
      }
    }
    cb(ports);
  });
}

// 从本机监听端口里探测 DSH 的 /dsh-hud/state
function detectDshPort() {
  return new Promise((resolve) => {
    // 1. 先测当前端口（环境变量给的最优先）
    testPort(currentDshPort, (ok) => {
      if (ok) return resolve(currentDshPort);

      // 2. 列出真实正在监听的本地端口
      listListeningPorts((listed) => {
        const ports = ENV_DSH_PORT ? [ENV_DSH_PORT] : [];
        for (const p of listed) if (!ports.includes(p)) ports.push(p);

        // 加上常见默认端口
        for (const p of [56150, 58974, 52327, 3080]) {
          if (!ports.includes(p)) ports.unshift(p);
        }

        let idx = 0;
        function next() {
          if (idx >= ports.length) return resolve(currentDshPort);
          const port = ports[idx++];
          testPort(port, (isOk) => {
            if (isOk) {
              currentDshPort = port;
              console.log(`[dsh-hud] state endpoint detected: 127.0.0.1:${port}${activeEndpoint}`);
              resolve(port);
            } else {
              next();
            }
          });
        }
        next();
      });
    });
  });
}

let activeEndpoint = '/dsh-hud/state';

function testPort(port, cb) {
  // 优先测试专属独立的 /dsh-hud/state 路由
  const req1 = http.get(`http://127.0.0.1:${port}/dsh-hud/state`, { timeout: 800 }, (res) => {
    if (res.statusCode === 200) {
      activeEndpoint = '/dsh-hud/state';
      return cb(true);
    }
    // 兼容退回 /dsh-pet-7340/state
    const req2 = http.get(`http://127.0.0.1:${port}/dsh-pet-7340/state`, { timeout: 800 }, (res2) => {
      if (res2.statusCode === 200) {
        activeEndpoint = '/dsh-pet-7340/state';
        return cb(true);
      }
      cb(false);
    });
    req2.on('error', () => cb(false));
    req2.on('timeout', () => { req2.destroy(); cb(false); });
  });
  req1.on('error', () => {
    const req2 = http.get(`http://127.0.0.1:${port}/dsh-pet-7340/state`, { timeout: 800 }, (res2) => {
      if (res2.statusCode === 200) {
        activeEndpoint = '/dsh-pet-7340/state';
        return cb(true);
      }
      cb(false);
    });
    req2.on('error', () => cb(false));
    req2.on('timeout', () => { req2.destroy(); cb(false); });
  });
  req1.on('timeout', () => { req1.destroy(); cb(false); });
}

function fetchState(since = 0) {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${currentDshPort}${activeEndpoint}${since ? `?since=${since}&timeout=5000` : ''}`;
    const req = http.get(url, { timeout: 8000 }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', (err) => {
      // 连接失败时尝试重新自动探查新端口
      detectDshPort();
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function startEventPolling() {
  if (isPolling) return;
  isPolling = true;

  // 首轮不渲染任何既有帧：只把当前 counter 当作基准，避免把上一轮的旧总结重播出来
  let baselined = false;

  while (isPolling) {
    try {
      const data = await fetchState(baselined ? lastCounter : 0);

      if (!baselined) {
        // 基准同步：无论成败，只要拿到一帧就立刻对齐，之后才允许渲染
        if (data) {
          if (data.counter) lastCounter = data.counter;
          if (data.sections?.workStatus?.counter) lastWorkCounter = data.sections.workStatus.counter;
          if (data.sections?.notify?.counter) lastNotifyCounter = data.sections.notify.counter;
          baselined = true;
        }
        continue;
      }

      if (data && data.counter) {
        lastCounter = data.counter;
        handleStateUpdate(data);
      }
    } catch (e) {
      // 端口漂移后重新探测：重连时再次做基准同步，旧帧一律丢弃
      baselined = false;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

let lastWorkCounter = 0;
let lastNotifyCounter = 0;

function handleStateUpdate(data) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const sections = data.sections || {};
  const workLeaf = sections.workStatus;
  const notifyLeaf = sections.notify;

  // 1:1 对标 dsh-pet 的 counter 递增触发机制
  if (workLeaf && typeof workLeaf.counter === 'number') {
    if (workLeaf.counter > lastWorkCounter) {
      lastWorkCounter = workLeaf.counter;
      const workData = workLeaf.data;
      if (workData && workData.state) {
        mainWindow.webContents.send('dsh-hud:event', {
          type: 'workStatus',
          state: workData.state,
          task: workData.task || null,
          timestamp: Date.now()
        });
      }
    }
  }

  if (notifyLeaf && typeof notifyLeaf.counter === 'number') {
    if (notifyLeaf.counter > lastNotifyCounter) {
      lastNotifyCounter = notifyLeaf.counter;
      const event = notifyLeaf.data?.event;

      // 陈旧帧兜底：宿主保留的上一轮完成帧超过 60 秒就不再上屏，
      // 避免重连/端口漂移后把旧对话内容当成新事件播出来
      const frameTs = Number(notifyLeaf.data?.ts || 0);
      const isStale = frameTs > 0 && Date.now() - frameTs > 60 * 1000;

      if (event && !isStale) {
        mainWindow.webContents.send('dsh-hud:event', {
          type: 'notify',
          event: event,
          timestamp: Date.now()
        });
      }
    }
  }
}

// 单实例锁：避免 DSH 重启或重复加载时拉起多个 HUD 进程抢占端口
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
      }
    } catch (e) {}
  });

  app.whenReady().then(() => {
    startLocalControlServer();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  isPolling = false;
  if (process.platform !== 'darwin') app.quit();
});
