import { app, BrowserWindow, ipcMain, globalShortcut } from 'electron';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const MAP_URL = process.env.MAP_URL || 'http://localhost:8899';

// Persist only map zoom + center to a JSON file
const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '..', 'overlay-state.json');

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch { return {}; }
}

let saveTimer;
function saveState(patch) {
  const state = { ...loadState(), ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
  }, 300);
}

/** Find the D2R.exe window geometry via xdotool. Returns {x, y, width, height} or null. */
/**
 * Find the D2R window geometry via xdotool.
 * Handles: gamescope, plain Wine/Proton, or direct window.
 * Returns {x, y, width, height} or null.
 */
function findD2RWindow() {
  try {
    // Strategy 1: exact window name (works for gamescope + wine)
    let wid = execSync(
      'xdotool search --name "Diablo II: Resurrected" 2>/dev/null | head -1',
      { encoding: 'utf-8' },
    ).trim();

    // Strategy 2: gamescope class (gamescope renames its window to the game title)
    if (!wid) {
      const gids = execSync(
        'xdotool search --class gamescope 2>/dev/null',
        { encoding: 'utf-8' },
      ).trim().split('\n').filter(Boolean);
      for (const gid of gids) {
        const name = execSync(`xdotool getwindowname ${gid} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        if (/diablo/i.test(name)) { wid = gid; break; }
      }
    }

    // Strategy 3: wine window class
    if (!wid) {
      const wineIds = execSync(
        'xdotool search --class wine 2>/dev/null',
        { encoding: 'utf-8' },
      ).trim().split('\n').filter(Boolean);
      for (const gid of wineIds) {
        const name = execSync(`xdotool getwindowname ${gid} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        if (/diablo/i.test(name)) { wid = gid; break; }
      }
    }

    // Strategy 4: find gamescope process PID, search by PID
    if (!wid) {
      const pid = execSync('pgrep -f "^gamescope " 2>/dev/null | head -1', { encoding: 'utf-8' }).trim();
      if (pid) {
        wid = execSync(`xdotool search --pid ${pid} 2>/dev/null | head -1`, { encoding: 'utf-8' }).trim();
      }
    }

    if (!wid) return null;

    const geo = execSync(`xdotool getwindowgeometry --shell ${wid} 2>/dev/null`, { encoding: 'utf-8' });
    const x = geo.match(/^X=(\d+)/m);
    const y = geo.match(/^Y=(\d+)/m);
    const w = geo.match(/^WIDTH=(\d+)/m);
    const h = geo.match(/^HEIGHT=(\d+)/m);
    if (x && y && w && h) {
      return {
        x: parseInt(x[1], 10),
        y: parseInt(y[1], 10),
        width: parseInt(w[1], 10),
        height: parseInt(h[1], 10),
      };
    }
  } catch {}
  return null;
}

// Set WM_CLASS so DWM floats this window
app.setName('Diablo2-overlay');
app.commandLine.appendSwitch('class', 'Diablo2-overlay');

app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('disable-gpu-compositing');

let win;

app.whenReady().then(() => {
  const saved = loadState();

  // Match the D2R window exactly — overlay covers the full game window
  const d2r = findD2RWindow();
  const startX = d2r ? d2r.x : 0;
  const startY = d2r ? d2r.y : 0;
  const startW = d2r ? d2r.width : 2560;
  const startH = d2r ? d2r.height : 1440;

  win = new BrowserWindow({
    width: startW,
    height: startH,
    x: startX,
    y: startY,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    thickFrame: false,
    type: 'toolbar',
    resizable: false,
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

  // DWM ignores BrowserWindow x/y and manages window placement itself.
  // Set override_redirect so DWM completely ignores this window, then
  // position it with xdotool.
  function forcePosition() {
    try {
      execSync(
        'xdotool search --classname diablo2-overlay' +
        ' set_window --overrideredirect 1 %@' +
        ' windowunmap %@',
        { stdio: 'ignore', timeout: 2000 },
      );
    } catch { return; }
    setTimeout(() => {
      try {
        execSync(
          'xdotool search --classname diablo2-overlay' +
          ' windowmap %@' +
          ` windowmove %@ ${startX} ${startY}` +
          ` windowsize %@ ${startW} ${startH}`,
          { stdio: 'ignore', timeout: 2000 },
        );
      } catch {}
    }, 200);
  }

  win.loadURL(MAP_URL);

  // Inject overlay CSS/JS after the page finishes loading
  win.webContents.on('did-finish-load', () => {
    // Force position once the page is loaded (window is fully mapped by now)
    forcePosition();

    // Map viewport: 30% of window width, square aspect, top-left
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
        position: absolute !important;
        top: 0 !important; left: 0 !important;
      }
      #main-map {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        width: 30vw !important;
        height: 30vw !important;
        min-height: unset !important;
      }
      .maplibregl-map { background: transparent !important; }
      .maplibregl-canvas { background: transparent !important; }
      .maplibregl-ctrl-top-right,
      .maplibregl-ctrl-bottom-left,
      .maplibregl-ctrl-bottom-right { display: none !important; }
    `);

    win.webContents.executeJavaScript(`
      (function() {
        function initMap(map) {
          map.resize();
          var savedZoom = window.__electron_ipc__.getSavedZoom();
          var savedCenter = window.__electron_ipc__.getSavedCenter();
          if (savedZoom != null) map.setZoom(savedZoom);
          if (savedCenter) map.setCenter(savedCenter);
          map.on('zoomend', function() {
            window.__electron_ipc__.saveZoom(map.getZoom());
          });
          map.on('moveend', function() {
            var c = map.getCenter();
            window.__electron_ipc__.saveCenter([c.lng, c.lat]);
          });
        }
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
      })();
    `).catch(() => {});
  });

  // Provide saved zoom + center to renderer on startup
  ipcMain.on('get-saved-zoom', (event) => {
    event.returnValue = saved.zoom ?? null;
  });
  ipcMain.on('get-saved-center', (event) => {
    event.returnValue = saved.center ?? null;
  });

  // Handle zoom/center save from renderer
  ipcMain.on('save-zoom', (_event, zoom) => {
    saveState({ zoom });
  });
  ipcMain.on('save-center', (_event, center) => {
    saveState({ center });
  });

  // Global shortcut Alt+M toggles interactive mode (interact with map)
  let interactive = false;
  globalShortcut.register('Alt+M', () => {
    if (!win) return;
    interactive = !interactive;
    if (interactive) {
      win.setIgnoreMouseEvents(false);
    } else {
      win.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  // Global zoom shortcuts: +/- on keyboard and numpad
  function zoomMap(delta) {
    if (!win) return;
    win.webContents.executeJavaScript(`
      (function() {
        if (window.map && typeof window.map.getZoom === 'function') {
          window.map.zoomTo(window.map.getZoom() + (${delta}));
        }
      })();
    `).catch(() => {});
  }

  for (const key of ['=', 'numadd']) {
    globalShortcut.register(key, () => zoomMap(1));
  }
  for (const key of ['-', 'numsub']) {
    globalShortcut.register(key, () => zoomMap(-1));
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
