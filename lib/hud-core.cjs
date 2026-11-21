'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { exec, execFile } = require('child_process');

const DEFAULT_CONTROL_PORT = 52399;
const WIN_WIDTH = 380;
const WIN_HEIGHT = 680;
const CONFIG_NAME = 'dsh-hud-config.json';
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_AVATAR_DATA_URL_LENGTH = 1500 * 1024; // ~1.5 MB base64 cap

const CHANNELS = Object.freeze({
  CONFIG_UPDATED: 'dsh-hud:config-updated',
  EVENT: 'dsh-hud:event',
  DRAG_MOVE: 'dsh-hud:window-drag-move',
  DRAG_END: 'dsh-hud:window-drag-end',
  DRAGGED_LEGACY: 'dsh-hud:window-dragged'
});

const DEFAULT_CONFIG = Object.freeze({
  allRight: true,
  persistWorking: true,
  showRunningBubble: true,
  runningIdleTimeoutMin: 45,
  duration: 8500,
  screenPosition: 'right', // 'right' | 'left' | 'custom'
  customX: null,
  customY: null,
  isMovable: false,
  bubbleTheme: 'light', // 'light' | 'dark'
  bubbleOpacity: 85, // 20 ~ 100
  avatarType: 'preset-purple', // 'preset-purple' | 'color' | 'monet' | 'custom'
  avatarColor: '#8b5cf6',
  avatarGradient: 'linear-gradient(135deg, #a78bfa, #c084fc)',
  customAvatar: '',
  fontFamily: 'system',
  fontSize: 14
});

const FALLBACK_FONTS = [
  'Microsoft YaHei',
  'SimSun',
  'SimHei',
  'KaiTi',
  'FangSong',
  'PingFang SC',
  'Arial',
  'Segoe UI',
  'Consolas',
  'Comic Sans MS'
];

function getControlPort() {
  const raw = Number(process.env.DSH_HUD_CONTROL_PORT);
  return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : DEFAULT_CONTROL_PORT;
}

function stateDir() {
  return path.join(os.homedir(), '.dsh', 'dsh-hud');
}

function tokenFilePath() {
  return path.join(stateDir(), 'control.token');
}

function generateControlToken() {
  return crypto.randomBytes(32).toString('hex');
}

function readStoredControlToken() {
  try {
    const file = tokenFilePath();
    if (!fs.existsSync(file)) return '';
    const token = fs.readFileSync(file, 'utf-8').trim();
    return /^[a-f0-9]{32,128}$/i.test(token) ? token : '';
  } catch (e) {
    return '';
  }
}

function writeStoredControlToken(token) {
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = tokenFilePath();
    fs.writeFileSync(file, `${token}\n`, { encoding: 'utf-8', mode: 0o600 });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(file, 0o600); } catch (e) {}
    }
  } catch (e) {}
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

// ── Config Validation & Persistence ──────────────────────────────────────────

const SAFE_HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SAFE_DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const SAFE_GRADIENT_RE = /^linear-gradient\(\s*\d{1,3}deg(?:\s*,\s*#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})(?:\s+\d{1,3}%)?){2,5}\s*\)$/;
const DANGEROUS_FONT_CHARS_RE = /["';{}\\\r\n()<>]/g;

function clampInt(val, min, max) {
  const num = Number(val);
  if (!Number.isFinite(num)) return null;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function sanitizeFontFamily(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(DANGEROUS_FONT_CHARS_RE, '').trim().slice(0, 120);
  return cleaned || 'system';
}

function sanitizeCustomAvatar(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed.length > MAX_AVATAR_DATA_URL_LENGTH) return null;
  if (!SAFE_DATA_IMAGE_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Whitelist + type/range validation for config patches.
 * Unknown fields are silently dropped; invalid values are rejected or clamped.
 */
function sanitizeConfigPatch(patch, { strict = false } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Config payload must be a JSON object');
  }

  const out = {};

  if (patch.allRight !== undefined) {
    if (typeof patch.allRight === 'boolean') out.allRight = patch.allRight;
    else if (strict) throw new Error('Invalid allRight');
  }
  if (patch.persistWorking !== undefined) {
    if (typeof patch.persistWorking === 'boolean') out.persistWorking = patch.persistWorking;
    else if (strict) throw new Error('Invalid persistWorking');
  }
  if (patch.showRunningBubble !== undefined) {
    if (typeof patch.showRunningBubble === 'boolean') out.showRunningBubble = patch.showRunningBubble;
    else if (strict) throw new Error('Invalid showRunningBubble');
  }
  if (patch.isMovable !== undefined) {
    if (typeof patch.isMovable === 'boolean') out.isMovable = patch.isMovable;
    else if (strict) throw new Error('Invalid isMovable');
  }

  if (patch.runningIdleTimeoutMin !== undefined) {
    const v = clampInt(patch.runningIdleTimeoutMin, 1, 1440);
    if (v !== null) out.runningIdleTimeoutMin = v;
    else if (strict) throw new Error('Invalid runningIdleTimeoutMin');
  }

  if (patch.duration !== undefined) {
    const v = clampInt(patch.duration, 1000, 60000);
    if (v !== null) out.duration = v;
    else if (strict) throw new Error('Invalid duration');
  }

  if (patch.screenPosition !== undefined) {
    if (patch.screenPosition === 'right' || patch.screenPosition === 'left' || patch.screenPosition === 'custom') {
      out.screenPosition = patch.screenPosition;
    } else if (strict) {
      throw new Error('Invalid screenPosition');
    }
  }

  if (patch.customX !== undefined) {
    if (patch.customX === null) {
      out.customX = null;
    } else {
      const v = clampInt(patch.customX, -32768, 32768);
      if (v !== null) out.customX = v;
      else if (strict) throw new Error('Invalid customX');
    }
  }

  if (patch.customY !== undefined) {
    if (patch.customY === null) {
      out.customY = null;
    } else {
      const v = clampInt(patch.customY, -32768, 32768);
      if (v !== null) out.customY = v;
      else if (strict) throw new Error('Invalid customY');
    }
  }

  if (patch.bubbleTheme !== undefined) {
    if (patch.bubbleTheme === 'light' || patch.bubbleTheme === 'dark') {
      out.bubbleTheme = patch.bubbleTheme;
    } else if (strict) {
      throw new Error('Invalid bubbleTheme');
    }
  }

  if (patch.bubbleOpacity !== undefined) {
    const v = clampInt(patch.bubbleOpacity, 20, 100);
    if (v !== null) out.bubbleOpacity = v;
    else if (strict) throw new Error('Invalid bubbleOpacity');
  }

  if (patch.avatarType !== undefined) {
    if (
      patch.avatarType === 'preset-purple' ||
      patch.avatarType === 'color' ||
      patch.avatarType === 'monet' ||
      patch.avatarType === 'custom'
    ) {
      out.avatarType = patch.avatarType;
    } else if (strict) {
      throw new Error('Invalid avatarType');
    }
  }

  if (patch.avatarColor !== undefined) {
    if (typeof patch.avatarColor === 'string' && SAFE_HEX_COLOR_RE.test(patch.avatarColor.trim())) {
      out.avatarColor = patch.avatarColor.trim();
    } else if (strict) {
      throw new Error('Invalid avatarColor');
    }
  }

  if (patch.avatarGradient !== undefined) {
    if (typeof patch.avatarGradient === 'string' && SAFE_GRADIENT_RE.test(patch.avatarGradient.trim())) {
      out.avatarGradient = patch.avatarGradient.trim();
    } else if (strict) {
      throw new Error('Invalid avatarGradient');
    }
  }

  if (patch.customAvatar !== undefined) {
    const safeAvatar = sanitizeCustomAvatar(patch.customAvatar);
    if (safeAvatar !== null) out.customAvatar = safeAvatar;
    else if (strict) throw new Error('Invalid customAvatar (only data:image/png|jpeg|webp|gif;base64 allowed)');
  }

  if (patch.fontFamily !== undefined) {
    const safeFont = sanitizeFontFamily(patch.fontFamily);
    if (safeFont !== null) out.fontFamily = safeFont;
    else if (strict) throw new Error('Invalid fontFamily');
  }

  if (patch.fontSize !== undefined) {
    const v = clampInt(patch.fontSize, 12, 22);
    if (v !== null) out.fontSize = v;
    else if (strict) throw new Error('Invalid fontSize');
  }

  if (patch.runningText !== undefined) {
    if (typeof patch.runningText === 'string') {
      out.runningText = patch.runningText.trim().slice(0, 60);
    } else if (strict) {
      throw new Error('Invalid runningText');
    }
  }

  return out;
}

/**
 * Unified config path across standalone runtime and in-process mode:
 * <appData>/dsh-hud/dsh-hud-config.json (falls back to ~/.dsh/dsh-hud/dsh-hud-config.json).
 */
function resolveConfigPath(app) {
  try {
    if (app && typeof app.getPath === 'function') {
      const appData = app.getPath('appData');
      if (appData) return path.join(appData, 'dsh-hud', CONFIG_NAME);
    }
  } catch (e) {}
  return path.join(stateDir(), CONFIG_NAME);
}

function readJsonFile(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function writeConfigFile(filePath, cfg) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2), 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
}

function loadConfig({ app, runtimeDir, configPath: explicitPath, legacyPaths } = {}) {
  const targetPath = explicitPath || resolveConfigPath(app);
  const candidates = legacyPaths || [];
  if (!legacyPaths) {
    try {
      const userDataPath = app && typeof app.getPath === 'function'
        ? path.join(app.getPath('userData'), CONFIG_NAME)
        : null;
      if (userDataPath && path.resolve(userDataPath) !== path.resolve(targetPath)) {
        candidates.push(userDataPath);
      }
    } catch (e) {}
    if (runtimeDir) candidates.push(path.join(runtimeDir, 'config.json'));
    candidates.push(path.join(stateDir(), 'config.json'));
    candidates.push(
      path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Electron', CONFIG_NAME)
    );
  }

  const readLegacy = () => {
    for (const file of candidates) {
      if (!file || path.resolve(file) === path.resolve(targetPath)) continue;
      const found = readJsonFile(file);
      if (found) return found;
    }
    return null;
  };

  const currentRaw = readJsonFile(targetPath);
  if (currentRaw) {
    const current = { ...DEFAULT_CONFIG, ...sanitizeConfigPatch(currentRaw) };
    const isAllDefault = Object.keys(DEFAULT_CONFIG).every(
      (k) => JSON.stringify(current[k]) === JSON.stringify(DEFAULT_CONFIG[k])
    );
    if (!isAllDefault) return { config: current, configPath: targetPath };

    const legacy = readLegacy();
    if (legacy) {
      const merged = { ...DEFAULT_CONFIG, ...sanitizeConfigPatch(legacy) };
      writeConfigFile(targetPath, merged);
      return { config: merged, configPath: targetPath };
    }
    return { config: current, configPath: targetPath };
  }

  const legacy = readLegacy();
  if (legacy) {
    const merged = { ...DEFAULT_CONFIG, ...sanitizeConfigPatch(legacy) };
    writeConfigFile(targetPath, merged);
    return { config: merged, configPath: targetPath };
  }

  return { config: { ...DEFAULT_CONFIG }, configPath: targetPath };
}

// ── Multi-display Window Positioning ─────────────────────────────────────────

function clamp(val, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(max, val));
}

/**
 * Clamp a window rect (x, y, width, height) to the best-matching available display's workArea.
 */
function clampToDisplays(x, y, width, height, screen) {
  const displays = (typeof screen.getAllDisplays === 'function' ? screen.getAllDisplays() : []) || [];
  const primary = typeof screen.getPrimaryDisplay === 'function' ? screen.getPrimaryDisplay() : displays[0];
  if (!displays.length && !primary) {
    return { x: Math.round(x), y: Math.round(y), width, height };
  }
  const pool = displays.length ? displays : [primary];

  const cx = x + width / 2;
  const cy = y + height / 2;

  // Pick display with largest overlap area, or nearest display center if completely off-screen
  let best = pool[0];
  let bestOverlap = -1;
  let bestDistSq = Infinity;

  for (const d of pool) {
    const wa = d.workArea || d.bounds;
    if (!wa) continue;
    const overlapX = Math.max(0, Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x));
    const overlapY = Math.max(0, Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y));
    const overlap = overlapX * overlapY;
    const dcx = wa.x + wa.width / 2;
    const dcy = wa.y + wa.height / 2;
    const distSq = (cx - dcx) ** 2 + (cy - dcy) ** 2;

    if (overlap > bestOverlap || (overlap === bestOverlap && distSq < bestDistSq)) {
      bestOverlap = overlap;
      bestDistSq = distSq;
      best = d;
    }
  }

  const wa = best.workArea || best.bounds || { x: 0, y: 0, width: 1920, height: 1080 };
  const clampedX = Math.round(clamp(x, wa.x, wa.x + wa.width - width));
  const clampedY = Math.round(clamp(y, wa.y, wa.y + wa.height - height));
  return { x: clampedX, y: clampedY, width, height };
}

function computeWindowBounds(config, screen, { width = WIN_WIDTH, height = WIN_HEIGHT } = {}) {
  const primary = screen.getPrimaryDisplay();
  const wa = primary.workArea || primary.bounds || { x: 0, y: 0, width: 1920, height: 1080 };

  if (
    config.screenPosition === 'custom' &&
    typeof config.customX === 'number' &&
    Number.isFinite(config.customX) &&
    typeof config.customY === 'number' &&
    Number.isFinite(config.customY)
  ) {
    return clampToDisplays(config.customX, config.customY, width, height, screen);
  }

  const x = config.screenPosition === 'left'
    ? wa.x + 16
    : wa.x + wa.width - width - 16;
  const y = Math.round(wa.y + (wa.height - height) / 2);

  return {
    x: Math.round(clamp(x, wa.x, wa.x + wa.width - width)),
    y: Math.round(clamp(y, wa.y, wa.y + wa.height - height)),
    width,
    height
  };
}

// ── Cross-platform Cached System Fonts ───────────────────────────────────────

let cachedSystemFonts = null;
let systemFontsInflight = null;

function cleanFontName(raw) {
  if (!raw) return '';
  let name = String(raw).trim();
  if (!name || name.startsWith('@')) return '';
  // Skip PowerShell NoteProperty metadata names
  if (/^PS(Path|ParentPath|ChildName|Drive|Provider)$/i.test(name)) return '';
  name = name.replace(/\s*\([^)]*\)\s*;?/g, '').trim();
  name = name.replace(/( Bold| Italic| Light| Semibold| SemiBold| ExtraLight| ExtraBold| Black| Regular| Medium| Thin| Heavy| Oblique)+/gi, '').trim();
  return name;
}

function scanMacFontDirs() {
  const dirs = [
    '/System/Library/Fonts',
    '/System/Library/Fonts/Supplemental',
    '/Library/Fonts',
    path.join(os.homedir(), 'Library', 'Fonts')
  ];
  const set = new Set();
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (!/\.(ttf|otf|ttc|dfont)$/i.test(entry)) continue;
        const base = entry.replace(/\.(ttf|otf|ttc|dfont)$/i, '').replace(/[-_]/g, ' ');
        const clean = cleanFontName(base);
        if (clean) set.add(clean);
      }
    } catch (e) {}
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function getSystemFonts({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedSystemFonts) {
    return Promise.resolve(cachedSystemFonts);
  }
  if (!forceRefresh && systemFontsInflight) {
    return systemFontsInflight;
  }

  systemFontsInflight = new Promise((resolve) => {
    const finish = (list) => {
      const finalList = Array.isArray(list) && list.length > 0 ? list : [...FALLBACK_FONTS];
      cachedSystemFonts = finalList;
      systemFontsInflight = null;
      resolve(finalList);
    };

    if (process.platform === 'win32') {
      const psScript = [
        "$paths = @('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts')",
        "foreach ($p in $paths) {",
        "  if (Test-Path $p) {",
        "    (Get-ItemProperty -Path $p -ErrorAction SilentlyContinue).PSObject.Properties |",
        "      Where-Object { $_.Name -notmatch '^PS(Path|ParentPath|ChildName|Drive|Provider)$' } |",
        "      ForEach-Object { $_.Name }",
        "  }",
        "}"
      ].join('\n');
      execFile('powershell', ['-NoProfile', '-Command', psScript], { windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
        if (err || !stdout) return finish(FALLBACK_FONTS);
        const set = new Set();
        for (const line of String(stdout).split(/\r?\n/)) {
          const clean = cleanFontName(line);
          if (clean) set.add(clean);
        }
        finish(Array.from(set).sort((a, b) => a.localeCompare(b)));
      });
      return;
    }

    if (process.platform === 'darwin') {
      exec('atsutil fonts -list 2>/dev/null', { timeout: 10000 }, (err, stdout) => {
        if (!err && stdout) {
          const set = new Set();
          let inFamilies = false;
          for (const rawLine of String(stdout).split(/\r?\n/)) {
            const line = rawLine.trim();
            if (/^System Families:/i.test(line)) { inFamilies = true; continue; }
            if (/^System Fonts:/i.test(line)) { inFamilies = false; continue; }
            if (!inFamilies || !line || line.startsWith('.')) continue;
            const clean = cleanFontName(line);
            if (clean) set.add(clean);
          }
          if (set.size > 0) {
            return finish(Array.from(set).sort((a, b) => a.localeCompare(b)));
          }
        }
        const scanned = scanMacFontDirs();
        finish(scanned.length > 0 ? scanned : FALLBACK_FONTS);
      });
      return;
    }

    // Linux / BSD: fontconfig
    exec('fc-list : family 2>/dev/null', { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout) return finish(FALLBACK_FONTS);
      const set = new Set();
      for (const line of String(stdout).split(/\r?\n/)) {
        for (const part of line.split(',')) {
          const clean = cleanFontName(part);
          if (clean) set.add(clean);
        }
      }
      finish(Array.from(set).sort((a, b) => a.localeCompare(b)));
    });
  });

  return systemFontsInflight;
}

// ── Local Control HTTP Server (CORS + Token + Body Limit + Validation) ───────

const ALLOWED_ORIGIN_RE = /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?|(?:app|dsh):\/\/[^\s]+)$/i;

function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser / direct Node HTTP client
  return ALLOWED_ORIGIN_RE.test(origin);
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        const err = new Error(`Payload exceeds ${maxBytes} bytes limit`);
        err.statusCode = 413;
        reject(err);
        try { req.pause(); } catch (e) {}
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        const err = new Error('Invalid JSON body');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

function createControlServer({
  token = '',
  getConfig,
  onConfigPatch,
  onTestBubble,
  onQuit,
  getFonts = getSystemFonts,
  maxBodyBytes = MAX_BODY_BYTES
}) {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin) {
      if (!isAllowedOrigin(origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Forbidden origin' }));
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DSH-HUD-Token');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (token) {
      const provided = String(req.headers['x-dsh-hud-token'] || '');
      if (!timingSafeEqualStr(provided, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Bad URL' }));
      return;
    }

    if (pathname === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(getConfig()));
      return;
    }

    if (pathname === '/api/fonts' && req.method === 'GET') {
      try {
        const fonts = await getFonts();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ fonts }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ fonts: [...FALLBACK_FONTS] }));
      }
      return;
    }

    const sendBodyError = (e) => {
      const code = e && e.statusCode ? e.statusCode : 400;
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (code === 413) headers.Connection = 'close';
      res.writeHead(code, headers);
      res.end(JSON.stringify({ error: e?.message ?? String(e) }), () => {
        if (code === 413) {
          try { req.socket?.destroy(); } catch (_err) {}
        }
      });
    };

    if (pathname === '/api/config' && req.method === 'POST') {
      try {
        const rawPatch = await readJsonBody(req, maxBodyBytes);
        const patch = sanitizeConfigPatch(rawPatch, { strict: false });
        const next = await onConfigPatch(patch);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, config: next }));
      } catch (e) {
        sendBodyError(e);
      }
      return;
    }

    if (pathname === '/api/test-bubble' && req.method === 'POST') {
      try {
        const payload = await readJsonBody(req, 16 * 1024);
        const text = typeof payload?.text === 'string' && payload.text.trim()
          ? payload.text.trim().slice(0, 140)
          : '这是一条测试气泡，用于预览当前位置、主题与字体效果 ✨';
        if (typeof onTestBubble === 'function') onTestBubble({ text });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        sendBodyError(e);
      }
      return;
    }

    if (pathname === '/api/quit' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      if (typeof onQuit === 'function') onQuit();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });
}

// ── Multi-Session Event Store & Ring Buffer ──────────────────────────────────

function resolveSessionId(session, event) {
  const id =
    (typeof session === 'string' && session) ||
    session?.id ||
    session?.sessionId ||
    event?.sessionId ||
    event?.data?.sessionId ||
    'default';
  return String(id);
}

const DEFAULT_SESSION_STALE_MS = 45 * 60 * 1000;

function createEventStore({
  maxEvents = 50,
  onEmit,
  initialSeq = Date.now(),
  sessionStaleMs = DEFAULT_SESSION_STALE_MS,
  now = Date.now
} = {}) {
  let seq = Number(initialSeq) || Date.now();
  const nextSeq = () => {
    seq += 1;
    return seq;
  };

  const sessions = new Map(); // sessionId -> { active: boolean, lastTurnText: string, updatedAt: number }
  const events = []; // ring buffer of { seq, ts, kind: 'workStatus' | 'notify', sessionId, payload }
  const sections = {
    workStatus: { counter: 0, data: null },
    notify: { counter: 0, data: null }
  };
  let counter = seq;

  const expireStaleSessions = () => {
    if (!Number.isFinite(sessionStaleMs) || sessionStaleMs <= 0) return;
    const ts = now();
    for (const s of sessions.values()) {
      if (s.active && ts - s.updatedAt >= sessionStaleMs) {
        s.active = false;
      }
    }
  };

  const pruneSessions = () => {
    expireStaleSessions();
    if (sessions.size <= 100) return;
    const entries = Array.from(sessions.entries())
      .filter(([, s]) => !s.active)
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [k] of entries.slice(0, Math.max(0, sessions.size - 60))) {
      sessions.delete(k);
    }
  };

  const getOrCreateSession = (sessionId) => {
    let entry = sessions.get(sessionId);
    if (!entry) {
      entry = { active: false, lastTurnText: '', updatedAt: now() };
      sessions.set(sessionId, entry);
      pruneSessions();
    }
    entry.updatedAt = now();
    return entry;
  };

  const activeSessionCount = () => {
    expireStaleSessions();
    let count = 0;
    for (const s of sessions.values()) {
      if (s.active) count += 1;
    }
    return count;
  };

  const pushEvent = (kind, sessionId, payload) => {
    const eventSeq = nextSeq();
    const ts = Date.now();
    const item = { seq: eventSeq, ts, kind, sessionId, payload };
    events.push(item);
    if (events.length > maxEvents) {
      events.splice(0, events.length - maxEvents);
    }

    if (kind === 'workStatus') {
      sections.workStatus = {
        counter: eventSeq,
        data: { state: payload.state, task: payload.task ?? null, sessionId, ts }
      };
    } else if (kind === 'notify') {
      sections.notify = {
        counter: eventSeq,
        data: { type: 'session/event', event: payload.event, sessionId, ts }
      };
    }

    counter = eventSeq;
    if (typeof onEmit === 'function') onEmit(item);
    return item;
  };

  const handleSessionEvent = (session, event) => {
    const type = event?.type;
    if (!type) return [];

    const sessionId = resolveSessionId(session, event);
    const entry = getOrCreateSession(sessionId);
    const emitted = [];

    if (type === 'turn/start') {
      entry.active = true;
      entry.lastTurnText = '';
      emitted.push(pushEvent('workStatus', sessionId, {
        state: 'busy',
        task: '正在梳理思路与执行方案...'
      }));
      return emitted;
    }

    if (type === 'tool/call') {
      entry.active = true;
      const toolName = event.data?.name || '底层工具';
      emitted.push(pushEvent('workStatus', sessionId, {
        state: 'working',
        task: `正在调用 ${toolName} 执行任务...`
      }));
      return emitted;
    }

    if (type === 'tool/result') {
      emitted.push(pushEvent('workStatus', sessionId, {
        state: 'result',
        task: '这一步处理好啦'
      }));
      return emitted;
    }

    if (type === 'assistant/message') {
      const content = event.data?.message?.content;
      if (Array.isArray(content)) {
        for (let i = content.length - 1; i >= 0; i--) {
          const block = content[i];
          if (block?.type === 'text' && typeof block.text === 'string') {
            const clean = block.text.trim();
            if (clean) {
              entry.lastTurnText = clean;
              break;
            }
          }
        }
      }
      return emitted;
    }

    if (type === 'turn/end') {
      entry.active = false;
      const text = entry.lastTurnText || '任务执行完毕！';
      entry.lastTurnText = '';

      if (activeSessionCount() === 0) {
        emitted.push(pushEvent('workStatus', sessionId, {
          state: 'idle',
          task: null
        }));
      }

      emitted.push(pushEvent('notify', sessionId, {
        event: {
          type: 'turn/end',
          data: {
            reason: event.data?.reason,
            text,
            sessionId
          }
        }
      }));
      return emitted;
    }

    return emitted;
  };

  const getState = (since = 0) => {
    const sinceNum = Number(since) || 0;
    const delta = sinceNum > 0
      ? events.filter((e) => e.seq > sinceNum)
      : [];
    return {
      counter,
      sections: {
        workStatus: sections.workStatus,
        notify: sections.notify
      },
      events: delta
    };
  };

  return {
    get counter() { return counter; },
    get activeCount() { return activeSessionCount(); },
    get sessionCount() { return sessions.size; },
    handleSessionEvent,
    pushWorkStatus(state, task = null, sessionId = 'default') {
      return pushEvent('workStatus', sessionId, { state, task });
    },
    pushNotify(event, sessionId = 'default') {
      return pushEvent('notify', sessionId, { event });
    },
    getState
  };
}

module.exports = {
  DEFAULT_CONTROL_PORT,
  WIN_WIDTH,
  WIN_HEIGHT,
  CONFIG_NAME,
  MAX_BODY_BYTES,
  MAX_AVATAR_DATA_URL_LENGTH,
  CHANNELS,
  DEFAULT_CONFIG,
  FALLBACK_FONTS,
  getControlPort,
  stateDir,
  tokenFilePath,
  generateControlToken,
  readStoredControlToken,
  writeStoredControlToken,
  timingSafeEqualStr,
  isPidAlive,
  sanitizeFontFamily,
  sanitizeCustomAvatar,
  sanitizeConfigPatch,
  resolveConfigPath,
  writeConfigFile,
  loadConfig,
  clampToDisplays,
  computeWindowBounds,
  cleanFontName,
  getSystemFonts,
  isAllowedOrigin,
  readJsonBody,
  createControlServer,
  resolveSessionId,
  createEventStore
};
