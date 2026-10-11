'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['state', 'coach', 'alert', 'matches', 'settings', 'hud', 'calibration', 'notes', 'team', 'flash']);

contextBridge.exposeInMainWorld('kocu', {
  on(channel, cb) {
    if (!EVENTS.has(channel)) throw new Error(`bilinmeyen kanal: ${channel}`);
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  getState: () => ipcRenderer.invoke('state:get'),
  getNotes: () => ipcRenderer.invoke('notes:get'),
  listMatches: () => ipcRenderer.invoke('matches:list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  listCivs: () => ipcRenderer.invoke('civs:list'),
  listBuilds: (guideCode, refresh = false) => ipcRenderer.invoke('builds:list', guideCode, refresh),
  selectBuild: (civSlug, buildId) => ipcRenderer.invoke('builds:select', civSlug, buildId),
  searchPlayers: (q) => ipcRenderer.invoke('players:search', q),
  scoutPlayer: (profileId, name) => ipcRenderer.invoke('players:scout', profileId, name),
  getAnalysis: (matchId) => ipcRenderer.invoke('analysis:get', matchId),
  importReplay: () => ipcRenderer.invoke('analysis:import'),
  getCalibration: () => ipcRenderer.invoke('calib:get'),
  captureCalibration: (delaySec) => ipcRenderer.invoke('calib:capture', delaySec),
  testCalibration: (fields) => ipcRenderer.invoke('calib:test', fields),
  saveCalibration: (cal) => ipcRenderer.invoke('calib:save', cal),
  setAiKey: (provider, key) => ipcRenderer.invoke('ai:setKey', provider, key),
  testAi: () => ipcRenderer.invoke('ai:test'),
  askCoach: () => ipcRenderer.invoke('ai:ask'),
  aiReport: (matchId) => ipcRenderer.invoke('ai:report', matchId),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getDiagnostics: () => ipcRenderer.invoke('diag:get'),
  openLogs: () => ipcRenderer.invoke('diag:openLogs'),
  startSimulation: () => ipcRenderer.invoke('sim:start'),
  stopSimulation: () => ipcRenderer.invoke('sim:stop'),
  shiftStep: (delta) => ipcRenderer.invoke('coach:shift', delta),
  adjustClock: (sec) => ipcRenderer.invoke('coach:clock', sec),
});
