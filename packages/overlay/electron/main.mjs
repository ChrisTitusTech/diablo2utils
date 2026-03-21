import { app, BrowserWindow, ipcMain, globalShortcut } from 'electron';

const MAP_URL = process.env.MAP_URL || 'http://localhost:8899';

// Set WM_CLASS so DWM floats this window (matches old Tauri class)
app.setName('Diablo2-overlay');
app.commandLine.appendSwitch('class', 'Diablo2-overlay');

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
    thickFrame: false,
    type: 'toolbar',
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

        // Create move handle (hidden by default, shown on Alt+M toggle)
        var handle = document.createElement('div');
        handle.id = 'overlay-move-handle';
        handle.innerHTML = '&#9995;';
        handle.style.cssText = [
          'display: none',
          'position: fixed',
          'top: 4px',
          'left: 4px',
          'width: 32px',
          'height: 32px',
          'line-height: 32px',
          'text-align: center',
          'font-size: 20px',
          'background: rgba(0,0,0,0.6)',
          'border-radius: 6px',
          'cursor: move',
          'z-index: 999999',
          'user-select: none',
          'opacity: 0.9',
          'color: #fff',
          'pointer-events: auto',
        ].join(';');
        document.body.appendChild(handle);

        var dragging = false;
        var dragStartX = 0, dragStartY = 0;

        // Listen for interactive mode toggle from main process (Alt+M)
        window.__electron_ipc__.onToggleInteractive(function(interactive) {
          if (interactive) {
            handle.style.display = 'block';
          } else {
            dragging = false;
            handle.style.display = 'none';
            document.body.style.cursor = 'default';
          }
        });

        // Drag on handle moves the window
        handle.addEventListener('mousedown', function(e) {
          if (e.button === 0) {
            dragging = true;
            dragStartX = e.screenX;
            dragStartY = e.screenY;
            e.preventDefault();
            e.stopPropagation();
          }
        });
        window.addEventListener('mousemove', function(e) {
          if (dragging) {
            var dx = e.screenX - dragStartX;
            var dy = e.screenY - dragStartY;
            dragStartX = e.screenX;
            dragStartY = e.screenY;
            window.__electron_ipc__.moveWindow(dx, dy);
          }
        });
        window.addEventListener('mouseup', function(e) {
          if (e.button === 0) dragging = false;
        });
      })();
    `);
  });

  // Handle window drag-move from renderer
  ipcMain.on('move-window', (_event, dx, dy) => {
    if (!win) return;
    const [x, y] = win.getPosition();
    win.setPosition(x + dx, y + dy);
  });

  // Global shortcut Alt+M toggles interactive mode
  let interactive = false;
  globalShortcut.register('Alt+M', () => {
    if (!win) return;
    interactive = !interactive;
    if (interactive) {
      win.setIgnoreMouseEvents(false);
    } else {
      win.setIgnoreMouseEvents(true, { forward: true });
    }
    win.webContents.send('toggle-interactive', interactive);
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
