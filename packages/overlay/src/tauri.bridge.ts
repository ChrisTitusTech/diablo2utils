/**
 * Bridge to Tauri commands — only imported when running inside the Tauri webview.
 * Provides Alt-key toggle for click-through mode so users can reposition the overlay.
 */

interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

function getTauri(): TauriInternals | null {
  return (window as any).__TAURI_INTERNALS__ ?? null;
}

async function setClickthrough(ignore: boolean): Promise<void> {
  const tauri = getTauri();
  if (!tauri) return;
  try {
    await tauri.invoke('set_clickthrough', { ignore });
  } catch (err) {
    console.error('[Tauri] Failed to set clickthrough:', err);
  }
}

/**
 * Hold Alt to temporarily make the overlay interactive (disable click-through).
 * Release Alt to re-enable click-through so clicks pass to the game.
 */
export function setupClickthroughToggle(): void {
  let interactive = false;

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Alt' && !interactive) {
      interactive = true;
      setClickthrough(false);
      document.body.style.cursor = 'move';
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt' && interactive) {
      interactive = false;
      setClickthrough(true);
      document.body.style.cursor = 'default';
    }
  });

  // Also handle blur — if the window loses focus while Alt is held, re-enable click-through
  window.addEventListener('blur', () => {
    if (interactive) {
      interactive = false;
      setClickthrough(true);
      document.body.style.cursor = 'default';
    }
  });
}
