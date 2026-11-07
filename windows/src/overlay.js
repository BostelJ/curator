// A floating window that shows over everything without taking focus from the app you're in.
// It only takes the keyboard when asked to (typing a note) and gives it straight back.
// A port of Overlay.swift.
const path = require('path');
const { BrowserWindow, screen } = require('electron');

const QUIET = process.env.CURATOR_QUIET === '1';

class Overlay {
  constructor({ url, anchor }) {
    this.anchor = anchor; // 'topCenter' or 'bottomRight'
    this.size = { w: 10, h: 10 };
    this.hasContent = false;
    this._hiddenByPause = false;
    this._hiddenBehind = false; // hidden while the other overlay has the whole screen
    this.isFull = false;
    this.fullDisplay = null;
    this.allowKey = false;
    this.onMessage = null;

    this.win = new BrowserWindow({
      width: 10, height: 10, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, hasShadow: false, alwaysOnTop: true, thickFrame: false,
      roundedCorners: false, title: 'Curator',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
        backgroundThrottling: false, // keeps clips and animations running while nothing is focused
        autoplayPolicy: 'no-user-gesture-required', // clips play by themselves, muted
        spellcheck: true,
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setMenu(null);
    // Test mode: everything runs and renders, but nothing shows or takes clicks on the real screen.
    if (QUIET) {
      this.win.setOpacity(0);
      this.win.setIgnoreMouseEvents(true);
    }
    // Links in cards never open inside the overlay.
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e, target) => { if (target !== url) e.preventDefault(); });
    this.win.loadURL(url);
  }

  get web() { return this.win.webContents; }

  set hiddenByPause(v) { this._hiddenByPause = v; this.applyVisibility(); }
  set hiddenBehind(v) { this._hiddenBehind = v; this.applyVisibility(); }

  get shouldShow() { return this.hasContent && !this._hiddenByPause && !this._hiddenBehind; }

  /** Messages from the page. Size is handled here; everything else goes up. */
  receive(message) {
    if (message?.type === 'size') {
      const w = Number(message.w) || 0;
      const h = Number(message.h) || 0;
      this.hasContent = w > 0 && h > 0;
      this.size = { w, h };
      this.place();
      this.applyVisibility();
      return;
    }
    this.onMessage?.(message);
  }

  /** The display the pointer is on. */
  display() {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  setFull(on) {
    if (on === this.isFull) return;
    this.isFull = on;
    this.fullDisplay = on
      ? (this.win.isVisible() ? screen.getDisplayMatching(this.win.getBounds()) : this.display())
      : null;
    this.place();
    this.applyVisibility();
  }

  place() {
    if (this.isFull && this.fullDisplay) {
      this.setBounds(this.fullDisplay.bounds);
      return;
    }
    if (!this.hasContent) return;
    const area = this.display().workArea; // the screen less the taskbar
    const w = Math.min(Math.ceil(this.size.w), area.width);
    const h = Math.min(Math.ceil(this.size.h), area.height);
    const x = this.anchor === 'topCenter' ? Math.round(area.x + (area.width - w) / 2) : area.x + area.width - w;
    const y = this.anchor === 'topCenter' ? area.y : area.y + area.height - h;
    this.setBounds({ x, y, width: w, height: h });
  }

  setBounds(bounds) {
    const now = this.win.getBounds();
    if (now.x === bounds.x && now.y === bounds.y && now.width === bounds.width && now.height === bounds.height) return;
    this.win.setBounds(bounds);
  }

  applyVisibility() {
    if (this.shouldShow) {
      if (!this.win.isVisible()) {
        this.place();
        this.win.showInactive();
      }
      // Windows drops windows out of the topmost band now and then; put it back on every show.
      this.win.setAlwaysOnTop(true, 'screen-saver');
      this.win.moveTop();
    } else {
      this.giveBackKeyboard();
      if (this.win.isVisible()) this.win.hide();
    }
  }

  /**
   * Show a leaf falling from a spot on another overlay. This window covers that overlay's whole
   * display for the moment it takes, and clicks pass straight through it.
   */
  dropLeaf(source, { html, x, y, width, direction }) {
    const from = source.win.getBounds();
    const display = screen.getDisplayMatching(from);
    this.win.setIgnoreMouseEvents(true);
    this.setBounds(display.bounds);
    if (!this.win.isVisible()) this.win.showInactive();
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.moveTop();
    const left = x + from.x - display.bounds.x;
    const top = y + from.y - display.bounds.y;
    this.call(`window.drop(${JSON.stringify(html)}, ${left}, ${top}, ${width}, ${direction})`);
  }

  hideLeaves() {
    this.win.hide();
  }

  takeKeyboard() {
    // Test mode must never take typing from whoever is using this computer.
    if (QUIET) return;
    this.allowKey = true;
    this.win.setFocusable(true);
    this.win.focus();
    this.win.webContents.focus();
  }

  /** Hand typing back to the app that was in front. */
  giveBackKeyboard() {
    if (!this.allowKey) return;
    this.allowKey = false;
    const focused = this.win.isFocused();
    this.win.setFocusable(false);
    if (focused) {
      this.win.blur();
      // Hiding lets Windows activate the window that was in front before; then come back without focus.
      this.win.hide();
      if (this.shouldShow) {
        this.win.showInactive();
        this.win.setAlwaysOnTop(true, 'screen-saver');
      }
    }
  }

  call(script) {
    if (this.win.isDestroyed()) return;
    this.win.webContents.executeJavaScript(script).catch(() => {});
  }
}

module.exports = { Overlay };
