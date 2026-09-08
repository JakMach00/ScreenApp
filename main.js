'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
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

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 660,
    backgroundColor: '#101318',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
      name: s.name || `Ekran ${index + 1}`,
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
  if (!source) throw new Error('Nie znaleziono ekranu do przechwycenia.');
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

ipcMain.handle('window:hide', async () => {
  if (win) win.hide();
  // Give the compositor time to actually remove the window before grabbing.
  await new Promise((resolve) => setTimeout(resolve, 220));
  return true;
});

ipcMain.handle('window:show', async () => {
  if (win) {
    win.show();
    win.focus();
  }
  return true;
});

/**
 * Writes the PDF and every recording into one folder chosen by the user.
 * Returns the folder path, or null when the dialog was cancelled.
 */
ipcMain.handle('export:bundle', async (_event, payload) => {
  const { pdf, videos, defaultName } = payload || {};
  if (!win) throw new Error('Brak okna aplikacji.');

  const result = await dialog.showSaveDialog(win, {
    title: 'Zapisz dokumentacje',
    defaultPath: defaultName || 'dokumentacja.pdf',
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
    const target = path.join(dir, `${stem}_nagranie_${String(i + 1).padStart(2, '0')}.${ext}`);
    await fs.writeFile(target, Buffer.from(video.data));
    videoPaths.push(target);
  }

  return { dir, pdfPath, videoPaths };
});

ipcMain.handle('shell:reveal', async (_event, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
  return true;
});
