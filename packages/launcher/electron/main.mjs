import { app, BrowserWindow, ipcMain } from 'electron';
import { readFileSync, writeFileSync, existsSync, symlinkSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import http from 'http';
import { EventEmitter } from 'events';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CONFIG_FILE = join(__dirname, '..', 'launcher-config.json');

// Capture any uncaught errors so they are never silently swallowed
process.on('uncaughtException', (err) => {
  appendFileSync('/tmp/d2launcher-error.log', `[uncaughtException] ${err.stack}\n`);
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  appendFileSync('/tmp/d2launcher-error.log', `[unhandledRejection] ${reason}\n`);
  console.error('[unhandledRejection]', reason);
});

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  port: 8899,
  d2Path: join(REPO_ROOT, 'assets', 'd2'),
  winePrefix: join(process.env.HOME ?? '/root', '.local', 'share', 'd2map', '.prefix'),
  mapServerUrl: 'http://localhost:8899',
};

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  try { writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {}
  return cfg;
}

// ---------------------------------------------------------------------------
// Service definitions
// Each service has:
//   id        – unique string key
//   label     – display name
//   getArgs() – returns { cmd, args, cwd, env } given current config
//   deps      – service ids that must be running before this one starts
// ---------------------------------------------------------------------------

function getServiceDefs(cfg) {
  const mapDist = join(REPO_ROOT, 'packages', 'map', 'dist');
  const mapBin  = join(REPO_ROOT, 'packages', 'map', 'bin');

  return [
    {
      id: 'map',
      label: 'Map Server',
      deps: [],
      /**
       * Ensure the dist/bin symlink exists (mirrors what map/run.sh does).
       * Returns null on success or an error string to surface to the user.
       */
      preCheck() {
        const binLink = join(mapDist, 'bin');
        if (!existsSync(mapDist)) {
          return `dist/ not found at ${mapDist} — run packages/map/install.sh first`;
        }
        if (!existsSync(binLink)) {
          try { symlinkSync(mapBin, binLink); } catch {}
        }
        if (!existsSync(join('/app', 'game'))) {
          return (
            'Missing /app/game symlink. Run once: ' +
            `sudo mkdir -p /app && sudo ln -sfn "${cfg.d2Path}" /app/game`
          );
        }
        return null;
      },
      getSpawnOpts() {
        return {
          cmd: process.execPath,  // node
          args: ['index.cjs'],
          cwd: mapDist,
          env: {
            ...process.env,
            PORT: String(cfg.port),
            D2_PATH: cfg.d2Path,
            WINEPREFIX: cfg.winePrefix,
          },
        };
      },
      healthUrl: `http://localhost:${cfg.port}/health`,
    },
    {
      id: 'memory',
      label: 'Memory Reader',
      deps: ['map'],
      getSpawnOpts() {
        return {
          cmd: process.execPath,  // node
          args: [join('packages', 'memory', 'build', 'cli.js')],
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            MAP_SERVER_URL: cfg.mapServerUrl,
            DIABLO2_PATH: cfg.d2Path,
          },
        };
      },
    },
    {
      id: 'overlay',
      label: 'Overlay',
      deps: ['map'],
      getSpawnOpts() {
        return {
          cmd: process.execPath,  // replaced at spawn time with electron binary
          args: [join(REPO_ROOT, 'packages', 'overlay', 'electron', 'main.mjs')],
          cwd: join(REPO_ROOT, 'packages', 'overlay'),
          env: {
            ...process.env,
            MAP_URL: cfg.mapServerUrl,
          },
          useElectron: true,
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// ProcessManager
// ---------------------------------------------------------------------------

class ProcessManager extends EventEmitter {
  constructor() {
    super();
    this._procs = new Map(); // id → { proc, status }
  }

  _emitStatus(id, status) {
    this._procs.set(id, { ...this._procs.get(id), status });
    this.emit('status', { id, status });
  }

  _emitLog(id, line, stream) {
    this.emit('log', { id, line, stream });
  }

  status(id) {
    return this._procs.get(id)?.status ?? 'stopped';
  }

  allStatuses() {
    const out = {};
    for (const [id, val] of this._procs.entries()) {
      out[id] = val.status;
    }
    return out;
  }

  async spawn(def) {
    if (this.status(def.id) === 'running' || this.status(def.id) === 'starting') return;

    // Run preCheck if defined
    if (def.preCheck) {
      const err = def.preCheck();
      if (err) {
        this._emitLog(def.id, `[launcher] Pre-check failed: ${err}`, 'stderr');
        this._emitStatus(def.id, 'error');
        return;
      }
    }

    this._emitStatus(def.id, 'starting');
    this._emitLog(def.id, `[launcher] Starting ${def.label}...`, 'stdout');

    const opts = def.getSpawnOpts();

    let cmd = opts.cmd;
    if (opts.useElectron) {
      cmd = app.getPath('exe');
    }

    const proc = spawn(cmd, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._procs.set(def.id, { proc, status: 'starting' });

    proc.stdout.setEncoding('utf-8');
    proc.stderr.setEncoding('utf-8');

    const onData = (stream) => (chunk) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this._emitLog(def.id, line, stream);
      }
    };
    proc.stdout.on('data', onData('stdout'));
    proc.stderr.on('data', onData('stderr'));

    proc.on('exit', (code, signal) => {
      const status = (code === 0 || signal === 'SIGTERM') ? 'stopped' : 'error';
      this._emitLog(def.id, `[launcher] Process exited: code=${code} signal=${signal}`, 'stderr');
      this._emitStatus(def.id, status);
    });

    if (def.healthUrl) {
      try {
        await this._waitForHealth(def.healthUrl, 30);
        this._emitStatus(def.id, 'running');
        this._emitLog(def.id, `[launcher] ${def.label} is healthy at ${def.healthUrl}`, 'stdout');
      } catch (err) {
        this._emitLog(def.id, `[launcher] Health check failed: ${err.message}`, 'stderr');
        this._emitStatus(def.id, 'error');
      }
    } else {
      setTimeout(() => {
        if (this.status(def.id) === 'starting') {
          this._emitStatus(def.id, 'running');
        }
      }, 1500);
    }
  }

  _waitForHealth(url, maxAttempts) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const tryOnce = () => {
        attempts++;
        const req = http.get(url, (res) => {
          res.resume();
          if (res.statusCode < 400) return resolve();
          if (attempts >= maxAttempts) return reject(new Error(`HTTP ${res.statusCode} after ${maxAttempts} attempts`));
          setTimeout(tryOnce, 1000);
        });
        req.on('error', () => {
          if (attempts >= maxAttempts) return reject(new Error(`No response after ${maxAttempts}s`));
          setTimeout(tryOnce, 1000);
        });
        req.setTimeout(2000, () => req.destroy());
      };
      tryOnce();
    });
  }

  kill(id) {
    const entry = this._procs.get(id);
    if (!entry?.proc) return;
    const { proc } = entry;
    try { proc.kill('SIGTERM'); } catch {}
    // Force-kill after 5s
    const t = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, 5000);
    proc.once('exit', () => clearTimeout(t));
    this._emitStatus(id, 'stopped');
  }

  killAll() {
    for (const id of this._procs.keys()) {
      this.kill(id);
    }
  }
}

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

// Set WM_CLASS to 'Diablo2-launcher' so DWM does NOT apply the float rule
// that targets 'Diablo2-overlay'. Must be called before app is ready.
app.setName('Diablo2-Launcher');
// On Linux, Electron derives WM_CLASS instance from process.title / argv[0].
// Override it explicitly so it never inherits the electron binary name.
process.title = 'Diablo2-Launcher';

// Always print a startup line so the terminal shows activity
console.log(`[launcher] Starting — Electron ${process.versions.electron}, Node ${process.versions.node}, DISPLAY=${process.env.DISPLAY ?? '(unset)'}`);

let win;
let manager;

app.whenReady().then(() => {
  console.log('[launcher] app ready, creating window...');
  manager = new ProcessManager();

  win = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 720,
    minHeight: 500,
    title: 'D2R Launcher',
    backgroundColor: '#1a1a1a',
    show: false,
    type: 'normal',        // explicit normal window — not toolbar/splash/dock
    skipTaskbar: false,    // appear in taskbar / WM task list
    webPreferences: {
      preload: join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // required for ES module (.mjs) preload scripts in Electron v28+
    },
  });

  win.once('ready-to-show', () => {
    console.log('[launcher] ready-to-show — raising window');
    win.maximize();
    win.focus();
  });

  win.loadFile(join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => console.log('[launcher] renderer loaded'));
  win.webContents.on('render-process-gone', (_e, details) =>
    console.error('[launcher] renderer crashed:', details));
  win.on('closed', () => console.log('[launcher] window closed'));

  // Open DevTools in dev mode (remove for production)
  if (process.env.D2_LAUNCHER_DEV) win.webContents.openDevTools({ mode: 'detach' });

  // -------------------------------------------------------------------------
  // Forward manager events to renderer
  // -------------------------------------------------------------------------
  manager.on('status', ({ id, status }) => {
    if (!win?.isDestroyed()) {
      win.webContents.send('svc:status', { id, status });
    }
  });

  manager.on('log', ({ id, line, stream }) => {
    if (!win?.isDestroyed()) {
      win.webContents.send('svc:log', { id, line, stream });
    }
  });

  // -------------------------------------------------------------------------
  // IPC handlers
  // -------------------------------------------------------------------------

  // Renderer requests all current statuses on page load
  ipcMain.handle('svc:statuses', () => {
    return manager.allStatuses();
  });

  // Start a service (and its deps in order)
  ipcMain.handle('svc:start', async (_e, id) => {
    const cfg = loadConfig();
    const defs = getServiceDefs(cfg);
    const def = defs.find((d) => d.id === id);
    if (!def) return { error: `Unknown service: ${id}` };

    // Start deps first (sequentially)
    for (const depId of def.deps) {
      if (manager.status(depId) !== 'running') {
        const depDef = defs.find((d) => d.id === depId);
        if (depDef) await manager.spawn(depDef);
      }
    }

    await manager.spawn(def);
    return { ok: true };
  });

  // Stop a service
  ipcMain.handle('svc:stop', (_e, id) => {
    manager.kill(id);
    return { ok: true };
  });

  // Start all: map → memory → overlay
  ipcMain.handle('svc:startAll', async () => {
    const cfg = loadConfig();
    const defs = getServiceDefs(cfg);
    for (const def of defs) {
      await manager.spawn(def);
    }
    return { ok: true };
  });

  // Stop all
  ipcMain.handle('svc:stopAll', () => {
    manager.killAll();
    return { ok: true };
  });

  // Config get/set
  ipcMain.handle('config:get', () => loadConfig());
  ipcMain.handle('config:set', (_e, patch) => saveConfig(patch));
});

// ---------------------------------------------------------------------------
// Cleanup on quit
// ---------------------------------------------------------------------------

app.on('window-all-closed', () => {
  if (manager) manager.killAll();
  app.quit();
});

app.on('will-quit', () => {
  if (manager) manager.killAll();
});
