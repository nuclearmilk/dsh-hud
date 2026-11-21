'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
  CONFIG_UPDATED: 'dsh-hud:config-updated',
  EVENT: 'dsh-hud:event',
  DRAG_MOVE: 'dsh-hud:window-drag-move',
  DRAG_END: 'dsh-hud:window-drag-end'
};

contextBridge.exposeInMainWorld('dshHud', {
  onConfigUpdated(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, cfg) => callback(cfg);
    ipcRenderer.on(CHANNELS.CONFIG_UPDATED, listener);
    return () => ipcRenderer.removeListener(CHANNELS.CONFIG_UPDATED, listener);
  },

  onEvent(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(CHANNELS.EVENT, listener);
    return () => ipcRenderer.removeListener(CHANNELS.EVENT, listener);
  },

  dragMove(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    ipcRenderer.send(CHANNELS.DRAG_MOVE, { x: Math.round(x), y: Math.round(y) });
  },

  dragEnd(x, y) {
    const payload = (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y))
      ? { x: Math.round(x), y: Math.round(y) }
      : {};
    ipcRenderer.send(CHANNELS.DRAG_END, payload);
  }
});
