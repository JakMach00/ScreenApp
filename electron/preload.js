'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listSources: () => ipcRenderer.invoke('sources:list'),
  captureScreen: (sourceId, width, height) =>
    ipcRenderer.invoke('capture:screen', { sourceId, width, height }),
  setPreferredSource: (sourceId) => ipcRenderer.invoke('capture:prefer', sourceId),
  setLoopbackAudio: (enabled) => ipcRenderer.invoke('capture:loopback', enabled),
  hideWindow: (displayId) => ipcRenderer.invoke('window:hide', displayId || null),
  showWindow: (force) => ipcRenderer.invoke('window:show', Boolean(force)),
  applyShortcuts: (bindings) => ipcRenderer.invoke('shortcuts:apply', bindings),
  suspendShortcuts: () => ipcRenderer.invoke('shortcuts:suspend'),
  resumeShortcuts: () => ipcRenderer.invoke('shortcuts:resume'),
  onShortcut: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('shortcut:trigger', listener);
    return () => ipcRenderer.removeListener('shortcut:trigger', listener);
  },
  exportBundle: (pdf, videos, defaultName, targetDir) =>
    ipcRenderer.invoke('export:bundle', { pdf, videos, defaultName, targetDir: targetDir || null }),
  chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder'),
  reveal: (filePath) => ipcRenderer.invoke('shell:reveal', filePath),
});
