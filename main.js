const { app, BrowserWindow, Menu, nativeImage, ipcMain, shell } = require('electron');
const path = require('path');

// Disable hardware acceleration issues on some machines
app.disableHardwareAcceleration();

function createWindow() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
    : path.join(__dirname, 'icons', process.platform === 'darwin' ? 'icon.icns' : process.platform === 'win32' ? 'icon.ico' : 'icon.png');

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'ZAT POS',
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Allow IndexedDB (Dexie) to persist across sessions
      partition: 'persist:zatpos',
    },
    // Show window once ready to avoid white flash
    show: false,
  });

  // Resolve path to the offline POS index.html
  // In development: ../public/offline-pos/index.html
  // In packaged app: extraResources puts it at process.resourcesPath/offline-pos
  let indexPath;
  if (app.isPackaged) {
    indexPath = path.join(process.resourcesPath, 'offline-pos', 'index.html');
  } else {
    indexPath = path.join(__dirname, 'offline-pos', 'index.html');
  }

  win.loadFile(indexPath);

  win.once('ready-to-show', () => {
    win.show();
  });

  // Remove default menu bar (keeps native close/min/max buttons)
  Menu.setApplicationMenu(null);
}

ipcMain.on('get-app-version', (event) => {
  event.returnValue = app.getVersion();
});

ipcMain.handle('open-external', (event, url) => {
  shell.openExternal(url);
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
