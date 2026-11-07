// The shared pages talk to the Mac app through window.webkit.messageHandlers.curator.postMessage.
// Give them the same thing here, so the pages run unchanged.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: {
    curator: { postMessage: (message) => ipcRenderer.send('curator', message) },
  },
});
