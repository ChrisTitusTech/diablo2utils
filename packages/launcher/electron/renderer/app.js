/**
 * D2R Launcher — renderer process
 * Communicates with the main process through window.d2launcher (contextBridge).
 */

const MAX_LOG_LINES = 200;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// { [id]: 'stopped' | 'starting' | 'running' | 'error' }
const statuses = { map: 'stopped', memory: 'stopped', overlay: 'stopped' };

// { [id]: string[] }
const logBuffers = { map: [], memory: [], overlay: [] };

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function setStatus(id, status) {
  statuses[id] = status;

  // Status dot
  document.querySelectorAll(`.status-dot[data-id="${id}"]`).forEach((el) => {
    el.setAttribute('data-status', status);
  });

  // Status label
  document.querySelectorAll(`.status-label[data-id="${id}"]`).forEach((el) => {
    el.textContent = status;
    el.setAttribute('data-status', status);
  });

  // Buttons
  const startBtn = document.querySelector(`.btn-start[data-id="${id}"]`);
  const stopBtn  = document.querySelector(`.btn-stop[data-id="${id}"]`);
  if (startBtn) {
    startBtn.disabled = status === 'running' || status === 'starting';
  }
  if (stopBtn) {
    stopBtn.disabled = status === 'stopped' || status === 'error';
  }

  updateGlobalButtons();
}

function appendLog(id, line, stream) {
  const buf = logBuffers[id];
  buf.push(line);
  if (buf.length > MAX_LOG_LINES) buf.splice(0, buf.length - MAX_LOG_LINES);

  const ta = document.getElementById(`log-${id}`);
  if (!ta) return;

  ta.value = buf.join('\n');
  ta.scrollTop = ta.scrollHeight;
}

function updateGlobalButtons() {
  const anyRunning = Object.values(statuses).some((s) => s === 'running' || s === 'starting');
  const allStopped = Object.values(statuses).every((s) => s === 'stopped' || s === 'error');

  const startAll = document.getElementById('btn-start-all');
  const stopAll  = document.getElementById('btn-stop-all');

  if (startAll) startAll.disabled = anyRunning;
  if (stopAll)  stopAll.disabled  = allStopped;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const api = window.d2launcher;

  // Fetch initial statuses
  const initial = await api.getStatuses();
  for (const [id, status] of Object.entries(initial)) {
    setStatus(id, status);
  }

  // Subscribe to live updates
  api.onStatus(({ id, status }) => setStatus(id, status));
  api.onLog(({ id, line, stream }) => appendLog(id, line, stream));

  // -------------------------------------------------------------------------
  // Per-service Start / Stop buttons
  // -------------------------------------------------------------------------
  document.querySelectorAll('.btn-start').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      appendLog(id, `[ui] Requesting start for ${id}...`, 'stdout');
      api.startService(id).catch((err) => {
        appendLog(id, `[ui] Error: ${err.message}`, 'stderr');
      });
    });
  });

  document.querySelectorAll('.btn-stop').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      appendLog(id, `[ui] Requesting stop for ${id}...`, 'stdout');
      api.stopService(id).catch((err) => {
        appendLog(id, `[ui] Error: ${err.message}`, 'stderr');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Global Start All / Stop All
  // -------------------------------------------------------------------------
  document.getElementById('btn-start-all')?.addEventListener('click', () => {
    ['map', 'memory', 'overlay'].forEach((id) => {
      appendLog(id, '[ui] Starting...', 'stdout');
    });
    api.startAll().catch(console.error);
  });

  document.getElementById('btn-stop-all')?.addEventListener('click', () => {
    ['map', 'memory', 'overlay'].forEach((id) => {
      appendLog(id, '[ui] Stopping...', 'stdout');
    });
    api.stopAll().catch(console.error);
  });

  // -------------------------------------------------------------------------
  // Config form
  // -------------------------------------------------------------------------
  const form = document.getElementById('config-form');
  if (form) {
    // Pre-fill form with current config
    const cfg = await api.getConfig();
    setConfigForm(cfg);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const patch = readConfigForm();
      await api.setConfig(patch);

      const msg = document.getElementById('cfg-saved-msg');
      if (msg) {
        msg.hidden = false;
        setTimeout(() => { msg.hidden = true; }, 2000);
      }
    });
  }
}

function setConfigForm(cfg) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val ?? '';
  };
  set('cfg-port',       cfg.port);
  set('cfg-d2-path',    cfg.d2Path);
  set('cfg-wine-prefix', cfg.winePrefix);
  set('cfg-map-url',    cfg.mapServerUrl);
}

function readConfigForm() {
  const val = (id) => document.getElementById(id)?.value?.trim() ?? '';
  return {
    port:         Number(val('cfg-port')) || 8899,
    d2Path:       val('cfg-d2-path'),
    winePrefix:   val('cfg-wine-prefix'),
    mapServerUrl: val('cfg-map-url'),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot().catch(console.error);
}
