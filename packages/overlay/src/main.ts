import { OverlayApp } from './overlay.js';

/** Entry point — bootstraps the overlay in the browser / Tauri webview. */
const canvas = document.getElementById('minimap') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

if (!canvas) throw new Error('Missing #minimap canvas element');

// Read server URL from query params (?server=host:port) or default to localhost:8899
const params = new URLSearchParams(window.location.search);
const serverHost = params.get('server') ?? 'localhost:8899';
const wsUrl = `ws://${serverHost}/ws`;
const httpBase = `http://${serverHost}`;

const app = new OverlayApp(canvas, {
  wsUrl,
  httpBase,
  onStatus(status: string, state: 'connected' | 'error' | 'waiting') {
    if (statusEl) {
      statusEl.textContent = status;
      statusEl.className = 'status' + (state === 'connected' ? ' connected' : state === 'error' ? ' error' : '');
    }
  },
});

app.start();

// Toggle click-through with Alt key (only works inside Tauri)
if (typeof (window as any).__TAURI_INTERNALS__ !== 'undefined') {
  import('./tauri.bridge.js').then((bridge) => {
    bridge.setupClickthroughToggle();
  });
}
