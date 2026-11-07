// Where Curator keeps its boards. Shared by the app and the MCP bridge, which runs without Electron.
const os = require('os');
const path = require('path');

function homeDirectory() {
  const custom = process.env.CURATOR_HOME;
  if (custom) return path.resolve(custom);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'Curator');
  }
  // Only for running this build on a Mac while developing it. Never point it at the real Mac app's data.
  return path.join(os.homedir(), 'Library', 'Application Support', 'Curator-Electron');
}

module.exports = { homeDirectory };
