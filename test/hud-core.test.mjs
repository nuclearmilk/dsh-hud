import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import hudCore from '../lib/hud-core.cjs';

const {
  DEFAULT_CONFIG,
  sanitizeConfigPatch,
  loadConfig,
  computeWindowBounds,
  clampToDisplays,
  createControlServer,
  createEventStore,
  cleanFontName
} = hudCore;

function makeTempDir(prefix = 'dsh-hud-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function httpReq({ port, method = 'GET', pathname = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

test('sanitizeConfigPatch validates whitelist, clamps numbers, and blocks CSS/XSS injection', () => {
  const clean = sanitizeConfigPatch({
    unknownField: 'should-be-dropped',
    __proto__: { polluted: true },
    allRight: false,
    bubbleOpacity: 999,
    fontSize: 4,
    duration: 500,
    runningIdleTimeoutMin: 0,
    screenPosition: 'left',
    bubbleTheme: 'dark',
    avatarColor: '#aBc123',
    avatarGradient: 'linear-gradient(135deg, #a78bfa, #c084fc)',
    customAvatar: 'data:image/png;base64,iVBORw0KGgo=',
    fontFamily: 'Microsoft YaHei"; background:url(javascript:alert(1))'
  });

  assert.equal('unknownField' in clean, false);
  assert.equal(clean.allRight, false);
  assert.equal(clean.bubbleOpacity, 100);
  assert.equal(clean.fontSize, 12);
  assert.equal(clean.duration, 1000);
  assert.equal(clean.runningIdleTimeoutMin, 1);
  assert.equal(clean.screenPosition, 'left');
  assert.equal(clean.bubbleTheme, 'dark');
  assert.equal(clean.avatarColor, '#aBc123');
  assert.equal(clean.customAvatar, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(clean.fontFamily.includes('"'), false);
  assert.equal(clean.fontFamily.includes(';'), false);
  assert.equal(clean.fontFamily.includes('('), false);

  // Reject unsafe avatar schemes (SVG, javascript, http, CSS breakouts)
  const unsafe = sanitizeConfigPatch({
    customAvatar: 'data:image/svg+xml;base64,PHN2Zz4=',
    avatarColor: 'red; background:url(x)',
    avatarGradient: 'url(https://evil.example/x.png)',
    screenPosition: 'invalid-pos'
  });
  assert.equal('customAvatar' in unsafe, false);
  assert.equal('avatarColor' in unsafe, false);
  assert.equal('avatarGradient' in unsafe, false);
  assert.equal('screenPosition' in unsafe, false);
});

test('loadConfig migrates legacy config and persists it to target path', () => {
  const tmp = makeTempDir();
  try {
    const target = path.join(tmp, 'target', 'dsh-hud-config.json');
    const legacy = path.join(tmp, 'legacy', 'config.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ bubbleTheme: 'dark', bubbleOpacity: 60 }), 'utf-8');

    const { config, configPath } = loadConfig({ configPath: target, legacyPaths: [legacy] });
    assert.equal(configPath, target);
    assert.equal(config.bubbleTheme, 'dark');
    assert.equal(config.bubbleOpacity, 60);
    assert.equal(config.fontSize, DEFAULT_CONFIG.fontSize);

    // Must have persisted the migrated file
    assert.equal(fs.existsSync(target), true);
    const saved = JSON.parse(fs.readFileSync(target, 'utf-8'));
    assert.equal(saved.bubbleTheme, 'dark');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('computeWindowBounds respects workArea x/y offsets and clamps unplugged monitor coords', () => {
  // Primary display with a left taskbar of width 80 and top bar of height 40
  const mockScreen = {
    getPrimaryDisplay: () => ({
      workArea: { x: 80, y: 40, width: 1840, height: 1000 }
    }),
    getAllDisplays: () => [
      { workArea: { x: 80, y: 40, width: 1840, height: 1000 } }
    ]
  };

  const leftBounds = computeWindowBounds({ screenPosition: 'left' }, mockScreen);
  assert.equal(leftBounds.x, 80 + 16);
  assert.equal(leftBounds.y, Math.round(40 + (1000 - 680) / 2));

  const rightBounds = computeWindowBounds({ screenPosition: 'right' }, mockScreen);
  assert.equal(rightBounds.x, 80 + 1840 - 380 - 16);

  // Saved coordinate on an unplugged second monitor at x=3200, y=500 -> clamped onto active display
  const clamped = computeWindowBounds(
    { screenPosition: 'custom', customX: 3200, customY: 500 },
    mockScreen
  );
  assert.equal(clamped.x, 80 + 1840 - 380);
  assert.equal(clamped.y, 40 + 1000 - 680);

  // Two monitors: coordinate on second monitor stays on second monitor
  const dualScreen = {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getAllDisplays: () => [
      { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
      { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }
    ]
  };
  const onSecond = clampToDisplays(2400, 200, 380, 680, dualScreen);
  assert.equal(onSecond.x, 2400);
  assert.equal(onSecond.y, 200);
});

test('createControlServer enforces Origin allowlist, token auth, body limit, and test-bubble', async () => {
  let cfg = { ...DEFAULT_CONFIG };
  let testBubbleCalls = [];
  let quitCalls = 0;
  const token = 'a'.repeat(64);

  const server = createControlServer({
    token,
    getConfig: () => cfg,
    onConfigPatch: (patch) => {
      cfg = { ...cfg, ...patch };
      return cfg;
    },
    onTestBubble: (payload) => testBubbleCalls.push(payload),
    onQuit: () => { quitCalls += 1; },
    getFonts: async () => ['Arial', 'Consolas'],
    maxBodyBytes: 1024
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    // Disallowed web origin -> 403
    const evil = await httpReq({
      port,
      method: 'POST',
      pathname: '/api/quit',
      headers: { Origin: 'https://evil.example', 'X-DSH-HUD-Token': token }
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers['access-control-allow-origin'], undefined);
    assert.equal(quitCalls, 0);

    // Missing token -> 401
    const noTok = await httpReq({
      port,
      method: 'GET',
      pathname: '/api/config',
      headers: { Origin: 'http://127.0.0.1:56150' }
    });
    assert.equal(noTok.status, 401);
    assert.equal(noTok.headers['access-control-allow-origin'], 'http://127.0.0.1:56150');

    // Valid token + loopback origin -> 200
    const patchRes = await httpReq({
      port,
      method: 'POST',
      pathname: '/api/config',
      headers: {
        Origin: 'http://localhost:3000',
        'Content-Type': 'application/json',
        'X-DSH-HUD-Token': token
      },
      body: JSON.stringify({ bubbleTheme: 'dark', bubbleOpacity: 75, unknownKey: 123 })
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.headers['access-control-allow-origin'], 'http://localhost:3000');
    assert.equal(patchRes.json.config.bubbleTheme, 'dark');
    assert.equal(patchRes.json.config.bubbleOpacity, 75);
    assert.equal('unknownKey' in patchRes.json.config, false);

    // Oversized body -> 413 with Connection: close
    const tooBig = await httpReq({
      port,
      method: 'POST',
      pathname: '/api/config',
      headers: {
        'Content-Type': 'application/json',
        'X-DSH-HUD-Token': token
      },
      body: JSON.stringify({ runningText: 'x'.repeat(2000) })
    });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.headers.connection, 'close');

    // Test bubble endpoint
    const tb = await httpReq({
      port,
      method: 'POST',
      pathname: '/api/test-bubble',
      headers: {
        'Content-Type': 'application/json',
        'X-DSH-HUD-Token': token
      },
      body: JSON.stringify({ text: 'Hello preview ✨' })
    });
    assert.equal(tb.status, 200);
    assert.equal(testBubbleCalls.length, 1);
    assert.equal(testBubbleCalls[0].text, 'Hello preview ✨');

    // Authorized quit
    const q = await httpReq({
      port,
      method: 'POST',
      pathname: '/api/quit',
      headers: { 'X-DSH-HUD-Token': token }
    });
    assert.equal(q.status, 200);
    assert.equal(quitCalls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('createEventStore isolates concurrent sessions and preserves rapid bursts in ring buffer', () => {
  const store = createEventStore({ maxEvents: 10, initialSeq: 100 });

  // Session A starts
  store.handleSessionEvent({ id: 'sess-a' }, { type: 'turn/start' });
  const afterStart = store.counter;
  assert.equal(store.activeCount, 1);

  // Session B (sub-agent) starts concurrently
  store.handleSessionEvent({ id: 'sess-b' }, { type: 'turn/start' });
  assert.equal(store.activeCount, 2);

  // Rapid burst on A and B
  store.handleSessionEvent({ id: 'sess-a' }, { type: 'tool/call', data: { name: 'read_file' } });
  store.handleSessionEvent({ id: 'sess-a' }, { type: 'tool/result' });
  store.handleSessionEvent({ id: 'sess-a' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'Result from A' }] } }
  });
  store.handleSessionEvent({ id: 'sess-b' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'Result from B' }] } }
  });

  // Session B finishes FIRST: must NOT emit idle because Session A is still active!
  const bEnd = store.handleSessionEvent({ id: 'sess-b' }, { type: 'turn/end', data: { reason: 'done' } });
  assert.equal(store.activeCount, 1);
  assert.equal(bEnd.some((e) => e.kind === 'workStatus' && e.payload.state === 'idle'), false);
  assert.equal(bEnd.length, 1);
  assert.equal(bEnd[0].payload.event.data.text, 'Result from B');

  // Session A finishes: NOW idle is emitted AND A's text was not clobbered by B
  const aEnd = store.handleSessionEvent({ id: 'sess-a' }, { type: 'turn/end', data: { reason: 'done' } });
  assert.equal(store.activeCount, 0);
  assert.equal(aEnd.some((e) => e.kind === 'workStatus' && e.payload.state === 'idle'), true);
  const aNotify = aEnd.find((e) => e.kind === 'notify');
  assert.equal(aNotify.payload.event.data.text, 'Result from A');

  // Incremental delta since `afterStart` returns every single intermediate event in order
  const state = store.getState(afterStart);
  assert.equal(state.events.length, 6);
  assert.deepEqual(
    state.events.map((e) => (e.kind === 'workStatus' ? e.payload.state : 'notify')),
    ['busy', 'working', 'result', 'notify', 'idle', 'notify']
  );

  // Ring buffer caps at maxEvents (10)
  for (let i = 0; i < 20; i++) {
    store.pushWorkStatus('working', `step-${i}`);
  }
  const capped = store.getState(1);
  assert.equal(capped.events.length, 10);
  assert.equal(capped.events[9].payload.task, 'step-19');
});

test('createEventStore auto-expires stale abandoned sessions so idle is not permanently blocked', () => {
  let fakeNow = 10_000;
  const store = createEventStore({
    maxEvents: 20,
    initialSeq: 200,
    sessionStaleMs: 60_000,
    now: () => fakeNow
  });

  // Orphaned session starts and crashes without turn/end
  store.handleSessionEvent({ id: 'crashed-sess' }, { type: 'turn/start' });
  assert.equal(store.activeCount, 1);

  // Advance clock past sessionStaleMs
  fakeNow += 61_000;
  assert.equal(store.activeCount, 0);

  // Subsequent healthy session runs and finishes -> MUST emit idle
  store.handleSessionEvent({ id: 'healthy-sess' }, { type: 'turn/start' });
  assert.equal(store.activeCount, 1);
  const endEvents = store.handleSessionEvent({ id: 'healthy-sess' }, { type: 'turn/end', data: { reason: 'done' } });
  assert.equal(store.activeCount, 0);
  assert.equal(endEvents.some((e) => e.kind === 'workStatus' && e.payload.state === 'idle'), true);
});

test('cleanFontName filters PowerShell metadata properties and style suffixes', () => {
  assert.equal(cleanFontName('PSPath'), '');
  assert.equal(cleanFontName('PSChildName'), '');
  assert.equal(cleanFontName('@SimSun (TrueType)'), '');
  assert.equal(cleanFontName('Microsoft YaHei Bold (TrueType)'), 'Microsoft YaHei');
});
