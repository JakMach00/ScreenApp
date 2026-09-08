'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  globalShortcut,
  net,
  screen,
  session,
  dialog,
  shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const isDev = !app.isPackaged;
const REPO = 'JakMach00/ScreenApp';
const DEV_URL = 'http://localhost:5173';

/** @type {BrowserWindow | null} */
let win = null;

/** Source the renderer wants when it falls back to getDisplayMedia. */
let preferredSourceId = null;

/** Set while the renderer is asking for system audio through getDisplayMedia. */
let loopbackAudio = false;

/** True only when this process hid the window in order to take a screenshot. */
let hiddenByCapture = false;

/** Last set of accelerators sent by the renderer, kept for suspend and resume. */
let currentBindings = {};

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    // Tall enough for the whole sidebar, which is why it never scrolls.
    minHeight: 720,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    // Neutral grey avoids a dark flash before the renderer applies the theme.
    backgroundColor: '#1a1d23',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Without this the renderer timers are throttled while the window is
      // minimized, which would stall screenshots and the recording loop.
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win && win.show());

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  // Without an explicit model id Windows groups the process as generic Node and
  // shows its own icon on the taskbar.
  app.setAppUserModelId('pl.jakub.screenapp');

  // Fallback path: if the legacy getUserMedia constraints ever stop working,
  // the renderer can use getDisplayMedia and this handler picks the screen
  // the user already selected, without showing a second picker.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        .then((sources) => {
          const chosen = sources.find((s) => s.id === preferredSourceId) || sources[0];
          if (!chosen) {
            callback({});
            return;
          }
          // 'loopback' is what captures what the machine is playing. It is only
          // attached while the renderer explicitly asks for system audio.
          callback(loopbackAudio ? { video: chosen, audio: 'loopback' } : { video: chosen });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  // Screen, microphone and system audio requests come from our own renderer.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture');
  });

  const notifyDisplays = () => {
    if (win && !win.isDestroyed()) win.webContents.send('displays:changed');
  };
  // Resolution changes, docking and unplugging a monitor all land here, so the
  // renderer can refresh the screen list without a restart.
  screen.on('display-metrics-changed', notifyDisplays);
  screen.on('display-added', notifyDisplays);
  screen.on('display-removed', notifyDisplays);

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/**
 * List every physical screen together with its native pixel size.
 * Both the desktopCapturer source id (needed by getUserMedia) and the
 * display id are returned, because they are not interchangeable.
 */
ipcMain.handle('sources:list', async () => {
  const displays = screen.getAllDisplays();
  const primaryId = String(screen.getPrimaryDisplay().id);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
  });

  return sources.map((s, index) => {
    // display_id is empty on some Windows configurations, fall back to order.
    let display = displays.find((d) => String(d.id) === String(s.display_id));
    if (!display) display = displays[index] || displays[0];
    const scale = display ? display.scaleFactor : 1;
    return {
      id: s.id,
      // s.name is localized by the operating system, so it is ignored here.
      name: `Screen ${index + 1}`,
      displayId: display ? String(display.id) : '',
      width: display ? Math.round(display.size.width * scale) : 1920,
      height: display ? Math.round(display.size.height * scale) : 1080,
      primary: display ? String(display.id) === primaryId : index === 0,
    };
  });
});

/**
 * Pixel perfect screenshot of a single screen at its native resolution.
 * This goes through desktopCapturer instead of the live MediaStream so the
 * result is not resampled by the WebRTC pipeline.
 */
ipcMain.handle('capture:screen', async (_event, payload) => {
  const { sourceId, width, height } = payload || {};
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(320, Math.round(width || 1920)),
      height: Math.max(200, Math.round(height || 1080)),
    },
  });
  const source = sources.find((s) => s.id === sourceId) || sources[0];
  if (!source) throw new Error('No screen found to capture.');
  const size = source.thumbnail.getSize();
  return {
    data: source.thumbnail.toPNG(),
    width: size.width,
    height: size.height,
  };
});

ipcMain.handle('capture:loopback', (_event, enabled) => {
  loopbackAudio = Boolean(enabled);
  return loopbackAudio;
});

ipcMain.handle('capture:prefer', (_event, sourceId) => {
  preferredSourceId = sourceId || null;
  return true;
});

ipcMain.handle('window:hide', async (_event, displayId) => {
  hiddenByCapture = false;
  if (!win) return false;
  // A minimized window is already off screen, hiding it would only force an
  // unwanted restore afterwards.
  if (win.isMinimized() || !win.isVisible()) return false;
  // If the window sits on a different monitor than the one being captured it
  // cannot show up in the screenshot, so leave it alone.
  if (displayId) {
    const own = screen.getDisplayMatching(win.getBounds());
    if (String(own.id) !== String(displayId)) return false;
  }
  win.hide();
  hiddenByCapture = true;
  // Give the compositor time to actually remove the window before grabbing.
  await new Promise((resolve) => setTimeout(resolve, 220));
  return true;
});

ipcMain.handle('window:show', async (_event, force) => {
  if (!win) return false;
  if (!force && !hiddenByCapture) return false;
  const wasCaptureHide = hiddenByCapture;
  hiddenByCapture = false;
  if (force) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  }
  // Restoring after a capture must not steal focus from whatever the user was
  // actually working in. showInactive brings the window back unfocused.
  if (wasCaptureHide) win.showInactive();
  return true;
});

/**
 * Writes the PDF and every recording into one folder chosen by the user.
 * Returns the folder path, or null when the dialog was cancelled.
 */
/** Adds a counter to the file name rather than overwriting an existing export. */
async function uniquePath(candidate) {
  const dir = path.dirname(candidate);
  const ext = path.extname(candidate);
  const stem = path.basename(candidate, ext);
  let attempt = candidate;
  let counter = 2;
  for (;;) {
    try {
      await fs.access(attempt);
    } catch {
      return attempt;
    }
    attempt = path.join(dir, `${stem} (${counter}).${ext.replace(/^\./, '')}`);
    counter += 1;
  }
}

ipcMain.handle('export:bundle', async (_event, payload) => {
  const { pdf, videos, defaultName, targetDir, mode } = payload || {};
  if (!win) throw new Error('The application window is not available.');

  let usableDir = null;
  if (targetDir) {
    try {
      const stat = await fs.stat(targetDir);
      if (stat.isDirectory()) usableDir = targetDir;
    } catch {
      usableDir = null;
    }
  }

  // Recordings only: no PDF is produced, so the user picks a folder rather
  // than a document name.
  if (mode === 'videos') {
    let dir = usableDir;
    if (!dir) {
      const picked = await dialog.showOpenDialog(win, {
        title: 'Choose a folder for the recordings',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (picked.canceled || picked.filePaths.length === 0) return null;
      dir = picked.filePaths[0];
    }
    const paths = [];
    for (let i = 0; i < (videos || []).length; i += 1) {
      const video = videos[i];
      const name = video.name || `recording_${String(i + 1).padStart(2, '0')}.${video.ext || 'webm'}`;
      const target = await uniquePath(path.join(dir, name));
      await fs.writeFile(target, Buffer.from(video.data));
      paths.push(target);
    }
    return { dir, pdfPath: '', videoPaths: paths, usedDefaultFolder: Boolean(usableDir) };
  }

  let pdfPath = null;

  // A configured folder skips the dialog, but only while it is still usable.
  if (usableDir) {
    pdfPath = await uniquePath(path.join(usableDir, defaultName || 'documentation.pdf'));
  }

  if (!pdfPath) {
    const result = await dialog.showSaveDialog(win, {
      title: 'Save documentation',
      defaultPath: defaultName || 'documentation.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return null;
    pdfPath = result.filePath.toLowerCase().endsWith('.pdf')
      ? result.filePath
      : `${result.filePath}.pdf`;
  }
  const dir = path.dirname(pdfPath);
  const stem = path.basename(pdfPath, '.pdf');

  if (pdf) await fs.writeFile(pdfPath, Buffer.from(pdf));

  const videoPaths = [];
  for (let i = 0; i < (videos || []).length; i += 1) {
    const video = videos[i];
    const ext = video.ext || 'webm';
    const target = await uniquePath(
      path.join(dir, `${stem}_recording_${String(i + 1).padStart(2, '0')}.${ext}`),
    );
    await fs.writeFile(target, Buffer.from(video.data));
    videoPaths.push(target);
  }

  return { dir, pdfPath, videoPaths, usedDefaultFolder: Boolean(usableDir) };
});

function registerBindings(bindings) {
  globalShortcut.unregisterAll();
  const failed = [];
  for (const [action, accelerator] of Object.entries(bindings || {})) {
    if (!accelerator) continue;
    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (win && !win.isDestroyed()) win.webContents.send('shortcut:trigger', action);
      });
      if (!ok) failed.push(accelerator);
    } catch {
      failed.push(accelerator);
    }
  }
  return { failed };
}

ipcMain.handle('shortcuts:apply', (_event, bindings) => {
  currentBindings = bindings || {};
  return registerBindings(currentBindings);
});

/** Used while the user is recording a new key combination in the settings. */
ipcMain.handle('shortcuts:suspend', () => {
  globalShortcut.unregisterAll();
  return true;
});

ipcMain.handle('shortcuts:resume', () => registerBindings(currentBindings));

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

/**
 * Opens the folder holding the exported files. shell.showItemInFolder returns
 * nothing and fails silently on Windows, so openPath is used instead: it hands
 * back an error string that can be shown to the user.
 */
/** Numeric comparison, so 1.10.0 is correctly newer than 1.9.0. */
function compareVersions(a, b) {
  const left = String(a).split('.').map((part) => parseInt(part, 10) || 0);
  const right = String(b).split('.').map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Asks GitHub for the latest published release. This runs in the main process
 * because the renderer content policy blocks outside requests, and because
 * net.fetch follows the system proxy settings, which matters on a corporate
 * network.
 */
ipcMain.handle('update:check', async () => {
  const current = app.getVersion();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `ScreenApp/${current}`,
      },
      signal: controller.signal,
    });
    if (response.status === 404) {
      return { current, error: 'No published release was found.' };
    }
    if (!response.ok) {
      return { current, error: `GitHub answered with status ${response.status}.` };
    }
    const data = await response.json();
    const latest = String(data.tag_name || '').replace(/^v/i, '');
    if (!latest) return { current, error: 'The latest release carries no version tag.' };
    return {
      current,
      latest,
      url: typeof data.html_url === 'string' ? data.html_url : '',
      newer: compareVersions(latest, current) > 0,
    };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return { current, error: aborted ? 'The check timed out.' : String(err) };
  } finally {
    clearTimeout(timeout);
  }
});

/** Opens a release page, and only ever a page belonging to this project. */
ipcMain.handle('update:open', async (_event, url) => {
  const fallback = `https://github.com/${REPO}/releases/latest`;
  const safe =
    typeof url === 'string' && url.startsWith(`https://github.com/${REPO}`) ? url : fallback;
  await shell.openExternal(safe);
  return true;
});

ipcMain.handle('shell:reveal', async (_event, target) => {
  if (!target) return { ok: false, error: 'No path to open.' };
  const full = path.normalize(String(target));
  let dir = full;
  try {
    const stat = await fs.stat(full);
    if (!stat.isDirectory()) dir = path.dirname(full);
  } catch {
    dir = path.dirname(full);
  }
  try {
    const error = await shell.openPath(dir);
    return error ? { ok: false, error } : { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/** Folder picker for the optional default export location. */
ipcMain.handle('dialog:choose-folder', async () => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose the default save folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
