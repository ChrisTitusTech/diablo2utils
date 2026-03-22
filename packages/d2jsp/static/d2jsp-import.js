(function () {
  'use strict';

  var API = 'http://localhost:8900';

  // Prevent double-loading
  if (window.__d2jspImporter) {
    window.__d2jspImporter.show();
    return;
  }

  // --- UI overlay ---
  var overlay = document.createElement('div');
  overlay.id = 'd2jsp-import-overlay';
  overlay.innerHTML =
    '<div style="position:fixed;top:10px;right:10px;z-index:999999;background:#1a1a2e;color:#e0e0e0;' +
    'border:2px solid #c4a032;border-radius:8px;padding:16px;width:340px;font:14px/1.5 sans-serif;' +
    'box-shadow:0 4px 20px rgba(0,0,0,0.6);max-height:80vh;overflow-y:auto">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
    '<strong style="color:#c4a032;font-size:16px">d2jsp Importer</strong>' +
    '<span id="d2jsp-close" style="cursor:pointer;font-size:20px;color:#888">&times;</span></div>' +
    '<div id="d2jsp-status" style="margin-bottom:8px">Initializing...</div>' +
    '<div style="background:#333;border-radius:4px;height:20px;margin-bottom:8px">' +
    '<div id="d2jsp-bar" style="background:#c4a032;height:100%;width:0%;border-radius:4px;' +
    'transition:width 0.3s"></div></div>' +
    '<div id="d2jsp-count" style="font-size:12px;color:#aaa">0 / 0 threads</div>' +
    '<div id="d2jsp-log" style="max-height:200px;overflow-y:auto;font-size:11px;margin-top:8px;' +
    'border-top:1px solid #444;padding-top:6px"></div></div>';

  document.body.appendChild(overlay);

  var statusEl = document.getElementById('d2jsp-status');
  var barEl = document.getElementById('d2jsp-bar');
  var countEl = document.getElementById('d2jsp-count');
  var logEl = document.getElementById('d2jsp-log');

  document.getElementById('d2jsp-close').onclick = function () {
    overlay.style.display = 'none';
  };

  window.__d2jspImporter = {
    show: function () {
      overlay.style.display = '';
    },
  };

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function setProgress(current, total) {
    var pct = total > 0 ? Math.round((current / total) * 100) : 0;
    barEl.style.width = pct + '%';
    countEl.textContent = current + ' / ' + total + ' threads';
  }

  function addLog(msg, isError) {
    var line = document.createElement('div');
    line.textContent = msg;
    if (isError) line.style.color = '#e74c3c';
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  // Send HTML to the import API
  function sendHtml(html) {
    return fetch(API + '/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: html }),
    }).then(function (r) {
      return r.json();
    });
  }

  // Extract thread links from current page DOM (no need to re-parse HTML)
  function getThreadLinks() {
    var links = document.querySelectorAll('a[href*="topic.php?t="]');
    var seen = {};
    var threads = [];

    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      var m = href.match(/topic\.php\?t=(\d+)/);
      if (!m) continue;

      var tid = m[1];
      if (seen[tid]) continue;
      seen[tid] = true;

      var title = links[i].textContent.trim();
      if (!title || title.length < 3) continue;
      // Skip pagination arrows
      if (/^[»«\d]+$/.test(title)) continue;

      // Build absolute URL
      var url = href;
      if (url.indexOf('http') !== 0) {
        url = location.origin + '/' + url.replace(/^\//, '');
      }

      threads.push({ id: tid, title: title, url: url });
    }

    return threads;
  }

  // --- Main flow ---
  async function run() {
    try {
      // Step 1: Collect thread links from the current page
      var threads = getThreadLinks();
      addLog('Found ' + threads.length + ' thread links on this page');

      if (threads.length === 0) {
        setStatus('No threads found on this page');
        return;
      }

      setProgress(0, threads.length);
      setStatus('Crawling threads...');

      var imported = 0;
      var skipped = 0;
      var errors = 0;

      // Step 2: Fetch each thread page and send to import API
      for (var i = 0; i < threads.length; i++) {
        var t = threads[i];
        setProgress(i + 1, threads.length);

        try {
          addLog('Fetching: ' + t.title.substring(0, 50));

          var resp = await fetch(t.url, { credentials: 'include' });
          if (!resp.ok) {
            addLog('HTTP ' + resp.status + ' for thread ' + t.id, true);
            errors++;
            continue;
          }

          var html = await resp.text();

          // Check for Cloudflare challenge
          if (html.indexOf('Just a moment') !== -1 && html.length < 5000) {
            addLog('Cloudflare challenge on thread ' + t.id + ' - skipping', true);
            errors++;
            continue;
          }

          var result = await sendHtml(html);
          if (result.imported > 0) {
            imported++;
            addLog('  \u2713 imported');
          } else {
            skipped++;
            addLog('  \u2013 updated');
          }
        } catch (err) {
          addLog('Error on thread ' + t.id + ': ' + err.message, true);
          errors++;
        }

        // Small delay between requests to be polite
        await sleep(500);
      }

      // Step 3: Clean up entries without FG prices
      setStatus('Cleaning up...');
      try {
        var cleanResp = await fetch(API + '/api/cleanup', { method: 'POST' });
        var cleanData = await cleanResp.json();
        if (cleanData.removed > 0) {
          addLog('Cleaned ' + cleanData.removed + ' entries without FG prices');
        }
      } catch (e) {
        addLog('Cleanup request failed: ' + e.message, true);
      }

      // Done
      setStatus('Done! ' + imported + ' imported, ' + skipped + ' updated, ' + errors + ' errors');
      setProgress(threads.length, threads.length);
      addLog('--- Complete ---');
    } catch (err) {
      setStatus('Error: ' + err.message);
      addLog(err.message, true);
    }
  }
      }

      // Done
      setStatus('Done! ' + imported + ' imported, ' + skipped + ' skipped, ' + errors + ' errors');
      setProgress(threads.length, threads.length);
      addLog('--- Complete ---');
    } catch (err) {
      setStatus('Error: ' + err.message);
      addLog(err.message, true);
    }
  }

  run();
})();
