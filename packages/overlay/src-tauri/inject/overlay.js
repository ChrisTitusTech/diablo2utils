// Injected into the map viewer (http://localhost:8899) when loaded inside the
// Tauri overlay window.  Hides the header chrome and wires up Alt-key
// click-through.
//
// Transparency is handled at the compositor level (picom _NET_WM_WINDOW_OPACITY)
// rather than per-pixel alpha — WebKitGTK's software renderer does not properly
// clear RGBA surfaces between frames, causing smearing artifacts.

(function () {
  'use strict';

  // --- Overlay CSS -----------------------------------------------------------
  var style = document.createElement('style');
  style.textContent = [
    // Solid black background — transparency is handled by the compositor
    'html, body {',
    '  background: #000000 !important;',
    '  margin: 0 !important; padding: 0 !important;',
    '  width: 100% !important; height: 100% !important;',
    '  overflow: hidden !important;',
    '}',
    // Hide all viewer chrome
    'header { display: none !important; }',
    // Reset every container between body and the map canvas
    '#content, #main {',
    '  margin: 0 !important; padding: 0 !important;',
    '  width: 100% !important; height: 100% !important;',
    '  display: block !important;',
    '}',
    '#main-map {',
    '  height: 100vh !important; min-height: unset !important;',
    '  width: 100vw !important;',
    '}',
    // Hide MapLibre controls
    '.maplibregl-ctrl-top-right,',
    '.maplibregl-ctrl-bottom-left,',
    '.maplibregl-ctrl-bottom-right { display: none !important; }',
  ].join('\n');
  document.head.appendChild(style);

  // --- Resize map on load ----------------------------------------------------
  function initMap(map) {
    map.resize();
  }

  if (window.map && typeof window.map.resize === 'function') {
    initMap(window.map);
  } else {
    var pollTimer = setInterval(function () {
      if (window.map && typeof window.map.resize === 'function') {
        initMap(window.map);
        clearInterval(pollTimer);
      }
    }, 50);
    setTimeout(function () { clearInterval(pollTimer); }, 10000);
  }

  // --- Click-through toggle (Alt key) ----------------------------------------
  var interactive = false;

  function setClickthrough(ignore) {
    if (window.__TAURI_INTERNALS__) {
      try {
        window.__TAURI_INTERNALS__.invoke('set_clickthrough', { ignore: ignore });
      } catch (e) {
        console.error('[Overlay] set_clickthrough failed:', e);
      }
    }
  }

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Alt' && !interactive) {
      interactive = true;
      setClickthrough(false);
      document.body.style.cursor = 'move';
    }
  });

  window.addEventListener('keyup', function (e) {
    if (e.key === 'Alt' && interactive) {
      interactive = false;
      setClickthrough(true);
      document.body.style.cursor = 'default';
    }
  });

  window.addEventListener('blur', function () {
    if (interactive) {
      interactive = false;
      setClickthrough(true);
      document.body.style.cursor = 'default';
    }
  });
})();
