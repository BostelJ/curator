// Global keys. A registered key is taken away from the app in front, so overlay keys are only
// held while they're needed. Same key names as Hotkeys.swift; ⌃⌥ on the Mac is Ctrl+Alt here.
const { globalShortcut } = require('electron');

const COMBOS = {
  left: ['Left'],
  right: ['Right'],
  enter: ['Return'],
  escape: ['Escape'],
  undo: ['Control+Alt+Z'],
  keep: ['Control+Alt+K'],
  noteAny: ['Control+Alt+N'],
  noteBare: ['N'],
  deleteAny: ['Control+Alt+Backspace'],
  deleteBare: ['Backspace', 'Delete'], // Windows people reach for Delete
  gallery: ['Control+Alt+G'],
  bringBack: ['Control+Alt+P'],
  fullAny: ['Control+Alt+F'],
  fullBare: ['F'],
};

const KEYS = Object.keys(COMBOS);

class Hotkeys {
  constructor(onPress) {
    this.onPress = onPress;
    this.held = new Set();
  }

  /** Make the held keys exactly this set. */
  hold(wanted) {
    for (const key of [...this.held]) {
      if (wanted.has(key)) continue;
      for (const combo of COMBOS[key]) globalShortcut.unregister(combo);
      this.held.delete(key);
    }
    for (const key of wanted) {
      if (this.held.has(key) || !COMBOS[key]) continue;
      let any = false;
      for (const combo of COMBOS[key]) {
        try {
          if (globalShortcut.register(combo, () => this.onPress(key))) any = true;
          else console.error(`Curator: couldn't hold hot key ${combo} (another app has it)`);
        } catch (error) {
          console.error(`Curator: couldn't hold hot key ${combo}: ${error.message}`);
        }
      }
      if (any) this.held.add(key);
    }
  }
}

module.exports = { Hotkeys, KEYS };
