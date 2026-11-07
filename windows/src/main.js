// Curator for Windows: the tray app. A port of AppDelegate.swift onto Electron, running the same
// web pages (Resources/web) as the Mac app.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, ipcMain, shell, dialog, Notification } = require('electron');
const { homeDirectory } = require('./home');

const QUIET = process.env.CURATOR_QUIET === '1';
const DEBUG = process.env.CURATOR_DEBUG === '1';
const HOME = homeDirectory();

// Chromium's own files (caches, storage) stay out of the boards folder.
app.setPath('userData', path.join(HOME, '.electron'));
app.setAppUserModelId('com.bostelj.curator');

// One copy at a time, except a test copy with its own CURATOR_HOME, which has its own store and server.
if (!process.env.CURATOR_HOME && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(start);
}

const { Store } = require('./store');
const { API } = require('./api');
const { Overlay } = require('./overlay');
const { Hotkeys, KEYS } = require('./hotkeys');
const { drawLogo } = require('./raster');
const { connectClaude, bundledSkill, record } = require('./connect');

const token = crypto.randomBytes(32).toString('hex');
let store, api, quick, stack, leaves, hotkeys, tray, gallery;
let quickKeys = new Set();
let stackKeys = new Set();
let heldKeys = new Set();
let typing = false;
let fullOverlay = null; // the overlay showing its cards full screen: it gets every key, and the other steps aside
let quitting = false;
const serverInfo = path.join(HOME, 'server.json');

function webRoot() {
  const packaged = path.join(process.resourcesPath, 'web');
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return path.resolve(__dirname, '..', '..', 'Resources', 'web');
}

async function start() {
  if (process.platform === 'darwin') app.dock?.hide();
  Menu.setApplicationMenu(process.platform === 'darwin' ? editMenu() : null);

  store = new Store();
  // On Windows the pages get Windows key names and fonts. CURATOR_WINDOWS_LOOK=1 shows them on a Mac, for testing.
  api = new API({ store, token, webRoot: webRoot(), windowsLook: process.platform === 'win32' || process.env.CURATOR_WINDOWS_LOOK === '1' });
  let port;
  try {
    port = await api.start();
  } catch (error) {
    console.error('Curator: could not start server', error);
    app.exit(1);
    return;
  }
  fs.writeFileSync(serverInfo, JSON.stringify({ port, token }), { mode: 0o600 });

  hotkeys = new Hotkeys(pressed);
  quick = new Overlay({ url: pageURL('quick.html'), anchor: 'topCenter' });
  stack = new Overlay({ url: pageURL('stack.html'), anchor: 'bottomRight' });
  leaves = new Overlay({ url: pageURL('leaves.html'), anchor: 'topCenter' });
  leaves.onMessage = (message) => { if (message?.type === 'idle') leaves.hideLeaves(); };
  quick.onMessage = (m) => fromOverlay(quick, m);
  stack.onMessage = (m) => fromOverlay(stack, m);
  ipcMain.on('curator', (event, message) => {
    const overlay = [quick, stack, leaves].find((o) => o.web === event.sender);
    overlay?.receive(message);
  });

  setUpTray();
  if (DEBUG) api.debug = debugCommand;
  store.onChange = stateChanged;
  stateChanged();
  connectOnFirstRun();
}

const pageURL = (page) => `http://127.0.0.1:${api.port}/ui/${page}?token=${token}`;

app.on('second-instance', () => openGallery());
app.on('window-all-closed', () => {}); // a tray app keeps running
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  try { fs.unlinkSync(serverInfo); } catch {}
});

function stateChanged() {
  const paused = store.data.paused;
  quick.hiddenByPause = paused;
  stack.hiddenByPause = paused;
  for (const overlay of [quick, stack]) overlay.call('window.curatorRefresh && window.curatorRefresh()');
  if (gallery && !gallery.isDestroyed()) gallery.webContents.executeJavaScript('window.curatorRefresh && window.curatorRefresh()').catch(() => {});
  updateTray();
  updateHeldKeys();
}

// Keys

function updateHeldKeys() {
  const keys = new Set(['gallery']);
  if (!store.data.paused && !typing) {
    const wanted = fullOverlay === quick ? quickKeys : fullOverlay === stack ? stackKeys : new Set([...quickKeys, ...stackKeys]);
    for (const k of wanted) keys.add(k);
  }
  heldKeys = keys;
  // Test mode never takes real keys from whoever is using this computer.
  if (!QUIET) hotkeys.hold(keys);
}

/** The pick at the top of the screen gets first say, then the corner stack. */
function pressed(key) {
  if (key === 'gallery') return openGallery();
  const target = fullOverlay ?? (quickKeys.has(key) ? quick : stack);
  target.call(`window.curatorKey && window.curatorKey(${JSON.stringify(key)})`);
}

function fromOverlay(overlay, message) {
  switch (message?.type) {
    case 'keys': {
      const names = Array.isArray(message.keys) ? message.keys : [];
      const wanted = new Set(KEYS.filter((k) => names.includes(k)));
      if (overlay === quick) quickKeys = wanted; else stackKeys = wanted;
      updateHeldKeys();
      break;
    }
    case 'full': {
      const on = !!message.on;
      const other = overlay === quick ? stack : quick;
      if (on) {
        if (fullOverlay && fullOverlay !== overlay) {
          fullOverlay.setFull(false);
          fullOverlay.call('window.curatorExitFull && window.curatorExitFull()');
        }
        fullOverlay = overlay;
        overlay.setFull(true);
        other.hiddenBehind = true;
      } else if (overlay.isFull) {
        overlay.setFull(false);
        if (fullOverlay === overlay) {
          fullOverlay = null;
          other.hiddenBehind = false;
        }
      }
      updateHeldKeys();
      break;
    }
    case 'typing':
      typing = !!message.on;
      if (typing) overlay.takeKeyboard(); else overlay.giveBackKeyboard();
      updateHeldKeys();
      break;
    case 'leaf':
      leaves.dropLeaf(overlay, {
        html: String(message.html ?? ''), x: Number(message.x) || 0, y: Number(message.y) || 0,
        width: Number(message.w) || 300, direction: Number(message.direction) || 1,
      });
      break;
    default:
      break;
  }
}

// Tray

function trayImage() {
  const dark = process.platform === 'win32' ? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI : nativeTheme.shouldUseDarkColors;
  const opts = {
    ink: process.platform === 'darwin' ? '#000000' : dark ? '#ffffff' : '#111010',
    dot: store.waitingCount > 0,
    alpha: store.data.paused ? 0.45 : 1,
  };
  const image = nativeImage.createEmpty();
  for (const scale of [1, 1.25, 1.5, 2]) {
    const size = Math.round(16 * scale);
    const rgba = drawLogo(size, opts);
    // nativeImage wants BGRA.
    for (let i = 0; i < rgba.length; i += 4) { const r = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = r; }
    image.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: rgba });
  }
  if (process.platform === 'darwin' && !opts.dot) image.setTemplateImage(true);
  return image;
}

function setUpTray() {
  tray = new Tray(trayImage());
  tray.on('click', () => tray.popUpContextMenu());
  tray.on('double-click', () => openGallery());
  nativeTheme.on('updated', updateTray);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const waiting = store.waitingCount;
  tray.setImage(trayImage());
  tray.setToolTip(store.data.paused ? 'Curator, paused' : waiting ? `Curator: ${waiting} waiting for you` : 'Curator');
  const login = process.platform === 'win32' && app.isPackaged ? app.getLoginItemSettings().openAtLogin : null;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: waiting === 0 ? 'Nothing waiting' : `${waiting} waiting for you`, enabled: false },
    { type: 'separator' },
    { label: 'Open Art Gallery', accelerator: 'Control+Alt+G', registerAccelerator: false, click: openGallery },
    { label: store.data.paused ? 'Resume Cards' : 'Pause Cards', click: () => store.setPaused(!store.data.paused) },
    { type: 'separator' },
    ...(login === null ? [] : [{
      label: 'Start with Windows', type: 'checkbox', checked: login,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked }); updateTray(); },
    }]),
    { label: 'Connect to Claude Code', click: () => connectNow(true) },
    { label: 'Open Boards Folder', click: () => shell.openPath(HOME) },
    { type: 'separator' },
    { label: 'Quit Curator', click: () => app.quit() },
  ]));
}

// Claude Code

async function connectNow(verbose) {
  const result = await connectClaude({ exe: process.execPath, skillSource: bundledSkill() });
  record(result, app.getVersion());
  if (QUIET) return result;
  if (verbose) {
    dialog.showMessageBox({ type: result.ok ? 'info' : 'warning', title: 'Curator', message: result.ok ? 'Connected to Claude Code' : "Couldn't connect to Claude Code", detail: result.message });
  } else if (result.ok && Notification.isSupported()) {
    new Notification({ title: 'Curator is connected to Claude Code', body: 'Restart any open Claude Code sessions to use it. Ctrl+Alt+G opens the art gallery.' }).show();
  }
  return result;
}

/** Installed copies connect themselves the first time each version runs (or after moving). */
function connectOnFirstRun() {
  if (!app.isPackaged || process.platform !== 'win32' || QUIET) return;
  let last = null;
  try { last = JSON.parse(fs.readFileSync(path.join(HOME, 'connected.json'), 'utf8')); } catch {}
  if (last && last.ok && last.exe === process.execPath && last.version === app.getVersion()) return;
  connectNow(false);
}

// Gallery

function openGallery() {
  if (!gallery || gallery.isDestroyed()) {
    gallery = new BrowserWindow({
      width: 1280, height: 820, minWidth: 760, minHeight: 520, show: false, title: 'Art Gallery',
      backgroundColor: '#f6f4ee', autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true, sandbox: true, nodeIntegration: false,
        backgroundThrottling: !QUIET, autoplayPolicy: 'no-user-gesture-required',
      },
    });
    gallery.setMenu(null);
    gallery.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    gallery.on('page-title-updated', (e) => e.preventDefault());
    // Closing only hides it, like the Mac app, so it opens again where it was.
    gallery.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      gallery.hide();
    });
    gallery.loadURL(pageURL('gallery.html'));
    if (QUIET) {
      gallery.setOpacity(0);
      gallery.setIgnoreMouseEvents(true);
      gallery.showInactive();
      return;
    }
    gallery.once('ready-to-show', () => { gallery.show(); gallery.focus(); });
    return;
  }
  if (QUIET) return gallery.showInactive();
  if (gallery.isMinimized()) gallery.restore();
  gallery.show();
  gallery.focus();
}

function editMenu() {
  // Only for running on a Mac while developing: the Mac needs a menu for copy and paste.
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]);
}

// Test hook: press a key, run script in a page, snapshot a window, or report where the windows are.
async function debugCommand(body) {
  const overlays = { quick, stack, leaves };
  const target = overlays[body.panel];
  const web = target ? target.web : gallery && !gallery.isDestroyed() ? gallery.webContents : null;
  const out = {};
  switch (body.do) {
    case 'press':
      if (KEYS.includes(body.key)) pressed(body.key);
      break;
    case 'eval':
      try { out.result = await web?.executeJavaScript(String(body.script ?? '')); } catch (error) { out.error = String(error.message || error); }
      break;
    case 'gallery':
      openGallery();
      if (Array.isArray(body.size)) gallery.setContentSize(body.size[0], body.size[1]);
      break;
    case 'snapshot':
      if (web) {
        const image = await web.capturePage();
        fs.writeFileSync(String(body.out), image.toPNG());
        out.snapshot = image.getSize();
      }
      break;
    case 'trayIcon':
      fs.writeFileSync(String(body.out), trayImage().toPNG({ scaleFactor: Number(body.scale) || 2 }));
      break;
    case 'connect':
      out.connect = await connectNow(false);
      break;
    default:
      break;
  }
  const describe = (o) => ({ visible: o.win.isVisible(), key: o.win.isFocused(), focusable: o.win.isFocusable(),
    onTop: o.win.isAlwaysOnTop(), frame: Object.values(o.win.getBounds()) });
  const { screen } = require('electron');
  const area = screen.getPrimaryDisplay().workArea;
  return { ...out, quick: describe(quick), stack: describe(stack), leaves: describe(leaves),
    screen: [area.x, area.y, area.width, area.height], keysHeld: [...heldKeys].sort(),
    galleryVisible: !!(gallery && !gallery.isDestroyed() && gallery.isVisible()) };
}
