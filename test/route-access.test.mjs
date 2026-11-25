import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import hudCore from '../lib/hud-core.cjs';
import { inject, checkRequestAccess, registerHudRoutes, createHudEventPusher } from '../lib/index.js';

const { createEventStore, createControlServer, DEFAULT_CONFIG } = hudCore;

function createMockRes() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = {};
  res.body = '';
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    Object.assign(res.headers, headers);
    return res;
  };
  res.end = (chunk = '') => {
    if (chunk !== undefined && chunk !== null) {
      res.body += String(chunk);
    }
  };
  return res;
}

function createRouteHarness({ rejection } = {}) {
  const registered = [];
  const logs = [];
  const ctx = {
    webServer: {
      register(entry) {
        registered.push(entry);
        return () => {};
      }
    },
    connection:
      rejection === 'missing'
        ? undefined
        : {
            requestRejection(req) {
              return typeof rejection === 'function' ? rejection(req) : rejection;
            }
          },
    effect(fn) {
      return fn();
    },
    logger: {
      warn(msg) {
        logs.push(msg);
      }
    }
  };

  const store = createEventStore({ maxEvents: 10 });
  const subscribers = new Set();
  const ok = registerHudRoutes(ctx, {
    controlPort: 56199,
    getControlToken: () => 'secret-hud-token',
    eventStore: store,
    subscribers
  });

  return { ok, registered, logs };
}

test('inject declares both webServer and connection', () => {
  assert.equal(Array.isArray(inject), true);
  assert.equal(inject.includes('webServer'), true);
  assert.equal(inject.includes('connection'), true);
});

test('checkRequestAccess and registerHudRoutes fail closed when connection.requestRejection is absent', () => {
  assert.equal(checkRequestAccess({ url: '/dsh-hud/state' }, null), 503);
  assert.equal(checkRequestAccess({ url: '/dsh-hud/state' }, undefined), 503);

  const { ok, registered, logs } = createRouteHarness({ rejection: 'missing' });
  assert.equal(ok, false);
  assert.equal(registered.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /fail-closed/);
});

test('HTTP routes enforce connection.requestRejection status (403/401) and never leak token or state', async () => {
  for (const status of [403, 401]) {
    const { ok, registered } = createRouteHarness({ rejection: status });
    assert.equal(ok, true);
    assert.equal(registered.length, 1);

    for (const pathname of ['/dsh-hud/control-info', '/dsh-hud/state']) {
      const res = createMockRes();
      await registered[0].handler({ url: pathname, method: 'GET', headers: {} }, res);
      assert.equal(res.statusCode, status);
      assert.equal(res.body.includes('secret-hud-token'), false);
      assert.equal(res.body.includes('56199'), false);
      assert.equal(res.body.includes('sections'), false);
    }
  }
});

test('HTTP routes serve control-info, state, and 404 when requestRejection admits the request', async () => {
  const { ok, registered } = createRouteHarness({ rejection: undefined });
  assert.equal(ok, true);
  assert.equal(registered.length, 1);
  const handler = registered[0].handler;

  const infoRes = createMockRes();
  await handler({ url: '/dsh-hud/control-info', method: 'GET', headers: {} }, infoRes);
  assert.equal(infoRes.statusCode, 200);
  assert.deepEqual(JSON.parse(infoRes.body), {
    port: 56199,
    token: 'secret-hud-token'
  });

  const stateRes = createMockRes();
  await handler({ url: '/dsh-hud/state', method: 'GET', headers: {} }, stateRes);
  assert.equal(stateRes.statusCode, 200);
  const stateJson = JSON.parse(stateRes.body);
  assert.equal(typeof stateJson.counter, 'number');
  assert.equal(typeof stateJson.sections, 'object');
  assert.equal(Array.isArray(stateJson.events), true);

  const notFoundRes = createMockRes();
  await handler({ url: '/dsh-hud/unknown', method: 'GET', headers: {} }, notFoundRes);
  assert.equal(notFoundRes.statusCode, 404);
});

test('createHudEventPusher buffers events while control server is offline and flushes in order once ready', async () => {
  const probeServer = net.createServer();
  await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
  const { port } = probeServer.address();
  await new Promise((resolve) => probeServer.close(resolve));

  const received = [];
  const pusher = createHudEventPusher({
    port,
    getToken: () => 'live-hud-token'
  });

  // Enqueue while no server is listening yet
  pusher.enqueue({ kind: 'workStatus', seq: 10, payload: { state: 'working', task: 'step 1' } });
  pusher.enqueue({ kind: 'waitingStatus', seq: 11, payload: { count: 1, items: [{ id: 'w1' }] } });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(pusher.pendingCount, 2);

  const server = createControlServer({
    token: 'live-hud-token',
    getConfig: () => ({ ...DEFAULT_CONFIG }),
    onConfigPatch: async () => ({ ...DEFAULT_CONFIG }),
    onEvent: (item) => {
      received.push(item);
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    pusher.notifyReady();
    for (let i = 0; i < 30 && received.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 30));
    }

    assert.equal(pusher.pendingCount, 0);
    assert.deepEqual(
      received.map((item) => item.seq),
      [10, 11]
    );

    pusher.dispose();
    pusher.enqueue({ kind: 'workStatus', seq: 12, payload: { state: 'idle' } });
    assert.equal(pusher.pendingCount, 0);
  } finally {
    pusher.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});
