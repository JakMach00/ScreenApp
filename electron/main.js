'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  globalShortcut,
  screen,
  session,
  dialog,
  shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const isDev = !app.isPackaged;
const DEV_URL = 'http://localhost:5173';

/** @type {BrowserWindow | null} */
let win = null;

/** Source the renderer wants when it falls back to getDisplayMedia. */
let preferredSourceId = null;

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
          callback(chosen ? { video: chosen } : {});
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

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
ipcMain.handle('export:bundle', async (_event, payload) => {
  const { pdf, videos, defaultName } = payload || {};
  if (!win) throw new Error('The application window is not available.');

  const result = await dialog.showSaveDialog(win, {
    title: 'Save documentation',
    defaultPath: defaultName || 'documentation.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return null;

  const pdfPath = result.filePath.toLowerCase().endsWith('.pdf')
    ? result.filePath
    : `${result.filePath}.pdf`;
  const dir = path.dirname(pdfPath);
  const stem = path.basename(pdfPath, '.pdf');

  if (pdf) await fs.writeFile(pdfPath, Buffer.from(pdf));

  const videoPaths = [];
  for (let i = 0; i < (videos || []).length; i += 1) {
    const video = videos[i];
    const ext = video.ext || 'webm';
    const target = path.join(dir, `${stem}_recording_${String(i + 1).padStart(2, '0')}.${ext}`);
    await fs.writeFile(target, Buffer.from(video.data));
    videoPaths.push(target);
  }

  return { dir, pdfPath, videoPaths };
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

ipcMain.handle('shell:reveal', async (_event, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
  return true;
});
