import { app, BrowserWindow, ipcMain } from 'electron';

const MAP_URL = process.env.MAP_URL || 'http://localhost:8899';

app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('disable-gpu-compositing');

let win;

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    x: 50,
    y: 50,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: new URL('./preload.mjs', import.meta.url).pathname,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Start in click-through mode
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadURL(MAP_URL);

  // Inject overlay CSS/JS after the page finishes loading
  win.webContents.on('did-finish-load', () => {
    win.webContents.insertCSS(`
      html, body {
        background: transparent !important;
        margin: 0 !important; padding: 0 !important;
        width: 100% !important; height: 100% !important;
        overflow: hidden !important;
      }
      body > * { opacity: 0.7 !important; }
      header { display: none !important; }
      #content, #main {
        margin: 0 !important; padding: 0 !important;
        width: 100% !important; height: 100% !important;
        display: block !important;
      }
      #main-map {
        height: 100vh !important; min-height: unset !important;
        width: 100vw !important;
      }
      .maplibregl-map { background: transparent !important; }
      .maplibregl-canvas { background: transparent !important; }
      .maplibregl-ctrl-top-right,
      .maplibregl-ctrl-bottom-left,
      .maplibregl-ctrl-bottom-right { display: none !important; }
    `);

    win.webContents.executeJavaScript(`
      (function() {
        // Resize map once available
        function initMap(map) { map.resize(); }
        if (window.map && typeof window.map.resize === 'function') {
          initMap(window.map);
        } else {
          var t = setInterval(function() {
            if (window.map && typeof window.map.resize === 'function') {
              initMap(window.map);
              clearInterval(t);
            }
          }, 50);
          setTimeout(function() { clearInterval(t); }, 10000);
        }

        // Alt-key click-through toggle
        var interactive = false;
        window.addEventListener('keydown', function(e) {
          if (e.key === 'Alt' && !interactive) {
            interactive = true;
            window.__electron_ipc__.setClickthrough(false);
            document.body.style.cursor = 'move';
          }
        });
        window.addEventListener('keyup', function(e) {
          if (e.key === 'Alt' && interactive) {
            interactive = false;
            window.__electron_ipc__.setClickthrough(true);
            document.body.style.cursor = 'default';
          }
        });
        window.addEventListener('blur', function() {
          if (interactive) {
            interactive = false;
            window.__electron_ipc__.setClickthrough(true);
            document.body.style.cursor = 'default';
          }
        });
      })();
    `);
  });

  // Handle click-through toggle from renderer
  ipcMain.on('set-clickthrough', (_event, ignore) => {
    if (!win) return;
    if (ignore) {
      win.setIgnoreMouseEvents(true, { forward: true });
    } else {
      win.setIgnoreMouseEvents(false);
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
