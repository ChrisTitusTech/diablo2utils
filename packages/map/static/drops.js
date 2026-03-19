(function () {
  const summaryEl = document.querySelector('.drops-panel__summary');
  const contentEl = document.querySelector('.drops-panel__content');
  const exportButton = document.querySelector('.drops-panel__export');
  const exportStatusEl = document.querySelector('.drops-panel__export-status');
  const state = {
    items: [],
    pollTimer: null,
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function describeItem(item) {
    const details = [];
    if (item.code) details.push(`code=${item.code}`);
    if (item.quality && item.quality.name) details.push(`quality=${item.quality.name}`);
    if (item.x != null && item.y != null) details.push(`pos=${item.x},${item.y}`);
    if (item.sockets != null) details.push(`sockets=${item.sockets}`);
    if (item.isEthereal) details.push('ethereal');
    if (item.isIdentified) details.push('identified');
    if (item.isRuneWord) details.push('runeword');
    return {
      title: item.name || item.code || `Item ${item.id}`,
      details: details.join(', '),
    };
  }

  function sortItems(items) {
    return [...items].sort((a, b) => {
      const aSeen = a.seenAt || a.updatedAt || 0;
      const bSeen = b.seenAt || b.updatedAt || 0;
      if (bSeen !== aSeen) return bSeen - aSeen;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  function buildSummary(items) {
    if (items.length === 0) return 'No nearby dropped items right now.';
    return `${items.length} nearby dropped item${items.length === 1 ? '' : 's'} — newest at the top.`;
  }

  function buildListHtml(items) {
    if (items.length === 0) {
      return '<div class="drops-panel__empty">No nearby dropped items right now.</div>';
    }

    const rows = items
      .map((item) => {
        const desc = describeItem(item);
        return `<li class="drops-panel__item"><strong>${escapeHtml(desc.title)}</strong>${desc.details ? `<span class="drops-panel__meta">${escapeHtml(desc.details)}</span>` : ''}</li>`;
      })
      .join('');

    return `<ol class="drops-panel__list">${rows}</ol>`;
  }

  function buildExportText(items) {
    const lines = [
      'Diablo II Drops Export',
      `Generated: ${new Date().toLocaleString()}`,
      `Items: ${items.length}`,
      '',
    ];

    if (items.length === 0) return lines.concat('No nearby dropped items.').join('\n');
    return lines.concat(items.map((item) => {
      const desc = describeItem(item);
      return `${desc.title}${desc.details ? ` — ${desc.details}` : ''}`;
    })).join('\n');
  }

  function setExportStatus(message, stateName) {
    if (!exportStatusEl) return;
    exportStatusEl.textContent = message;
    exportStatusEl.dataset.state = stateName;
  }

  function render() {
    const items = sortItems(state.items);
    if (summaryEl) summaryEl.textContent = buildSummary(items);
    if (contentEl) contentEl.innerHTML = buildListHtml(items);
    if (exportButton) exportButton.disabled = items.length === 0;
  }

  async function fetchState() {
    try {
      const response = await fetch('/v1/state', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const allItems = Array.isArray(payload.items) ? payload.items : [];
      // Only show actual ground drops (items with valid map coordinates)
      state.items = allItems.filter(function (item) { return item.x != null && item.y != null && (item.x > 0 || item.y > 0); });
      render();
      setExportStatus('', 'ok');
    } catch (error) {
      state.items = [];
      render();
      if (summaryEl) summaryEl.textContent = error instanceof Error ? error.message : String(error);
      setExportStatus('Retrying…', 'error');
    }
  }

  async function exportDropsText() {
    const items = sortItems(state.items);
    if (items.length === 0) {
      setExportStatus('Export unavailable.', 'error');
      return;
    }

    try {
      const blob = new Blob([buildExportText(items)], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `d2-drops-${Date.now()}.txt`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setExportStatus('Downloaded.', 'ok');
    } catch (error) {
      setExportStatus('Export failed.', 'error');
      console.warn('[D2Drops]', 'Failed to export drops text', error);
    }
  }

  if (exportButton) {
    exportButton.addEventListener('click', function () {
      void exportDropsText();
    });
  }

  state.pollTimer = window.setInterval(fetchState, 1000);
  render();
  void fetchState();
})();