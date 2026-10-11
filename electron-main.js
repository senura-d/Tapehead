'use strict';

// Desktop shell: opens the app in its own window. All app logic stays in index.html + js/.
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

// A second copy would fight over the project database, so focus the running one instead.
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 640,
    title: 'Tapehead', backgroundColor: '#0e1012', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });

  // `TAPEHEAD_SMOKE=1 npm start` loads the app, exercises the engine once and exits with the result.
  if (process.env.TAPEHEAD_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      try {
        const out = await win.webContents.executeJavaScript(`(async () => {
          const p = App.newProject('smoke'); await DB.put(p); await App.open(p.id);
          App.addClips(['kit:kick', 'kit:808'], 0, 0);
          const buf = await Engine.renderSong(App.project, { sampleRate: 44100, from: 0, to: Engine.songEnd(App.project), tail: 0.5 });
          let peak = 0; for (const v of buf.getChannelData(0)) peak = Math.max(peak, Math.abs(v));
          const saved = (await DB.get(p.id)).name; await DB.del(p.id);
          return JSON.stringify({ origin: location.protocol, clips: App.project.clips.length, seconds: +buf.duration.toFixed(2), peak: +peak.toFixed(3), saved });
        })()`);
        console.log('SMOKE OK ' + out);
        app.exit(0);
      } catch (e) {
        console.error('SMOKE FAIL ' + e.message);
        app.exit(1);
      }
    });
  }
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
