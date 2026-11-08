(function () {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function api(path) {
    try {
      const res = await fetch(path, { credentials: 'include' });
      if (res.status === 401) { location.href = '/'; return null; }
      return res.json();
    } catch { return null; }
  }

  // Timestamp MySQL datang tanpa zona — sisipkan 'Z' supaya dibaca UTC, sama
  // seperti billing.js/bot-stats.js. Tanpa itu jamnya geser sebesar offset WIB.
  const jam = (v) => {
    if (!v) return '—';
    const s = /Z|[+-]\d\d:?$/.test(String(v)) ? v : String(v).replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return isNaN(d) ? String(v) : d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  };

  function logTime(v) {
    if (!v) return new Date().toLocaleTimeString('id-ID', { hour12: false });
    const s = /Z|[+-]\d\d:?\d\d$/.test(v) ? v : String(v).replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return isNaN(d) ? String(v) : d.toLocaleTimeString('id-ID', { hour12: false });
  }

  let botId = null;
  let ws = null;
  const botMap = new Map();

  function scrollTerm() {
    const t = document.getElementById('terminal');
    if (t) t.scrollTop = t.scrollHeight;
  }

  function appendLog(level, message, scroll = true, when = null) {
    const t = document.getElementById('terminal');
    if (!t) return;
    if (String(message).startsWith('QR_DATA:')) return;
    const el = document.createElement('p');
    const known = ['info', 'warn', 'error', 'debug', 'cmd', 'cmderr'];
    const lv = known.includes(level) ? level : 'info';
    el.className = 'log-line log-' + lv;
    const ts = logTime(when);
    el.textContent = '[' + ts + '] ' + message;
    t.appendChild(el);
    while (t.children.length > 300) t.removeChild(t.firstChild);
    if (scroll) scrollTerm();
  }

  async function clearTerminal(notify = true) {
    const t = document.getElementById('terminal');
    if (!t) return;
    t.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'log-line term-hint';
    p.textContent = '// Terminal dibersihkan';
    t.appendChild(p);

    if (notify && botId) {
      try { await api('/api/bots/' + botId + '/logs', { method: 'DELETE' }); } catch {}
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'clear_terminal', botId })); } catch {}
      }
    }
  }

  async function loadLogs() {
    if (!botId) return;
    const t = document.getElementById('terminal');
    t.innerHTML = '<p class="log-line term-hint">// Memuat log aktivitas...</p>';

    const d = await api('/api/bots/' + botId + '/logs?limit=80');
    if (!d?.ok) {
      t.innerHTML = '<p class="log-line term-hint">// Gagal memuat riwayat log</p>';
      return;
    }

    t.innerHTML = '';
    const lv = document.getElementById('log-level')?.value;
    const list = (d.logs || []).filter(l => !lv || l.level === lv);
    if (!list.length) {
      t.innerHTML = '<p class="log-line term-hint">// Belum ada log aktivitas</p>';
      return;
    }
    list.forEach(l => appendLog(l.level, l.message, false, l.created_at));
    scrollTerm();
  }

  function setWs(on) {
    const dot = document.getElementById('ws-dot');
    const lbl = document.getElementById('ws-lbl');
    const heroStat = document.getElementById('log-stat-val');
    if (dot) dot.className = 'state' + (on ? ' live' : '');
    if (lbl) lbl.textContent = on ? 'Live' : 'Reconnecting...';
    if (heroStat) heroStat.textContent = on ? 'Live Streaming' : 'Offline';
  }

  function connectWS() {
    try { if (ws) ws.close(); } catch {}
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host);
    ws.onopen = () => {
      if (botId) ws.send(JSON.stringify({ type: 'subscribe', botId }));
      setWs(true);
    };
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'error') { setWs(false); return; }
        if (d.type === 'clear_terminal') { clearTerminal(false); return; }
        if (d.type === 'log') {
          const lv = document.getElementById('log-level')?.value;
          if (!lv || d.payload.level === lv) {
            appendLog(d.payload.level, d.payload.message);
          }
        }
      } catch {}
    };
    ws.onclose = () => {
      setWs(false);
      setTimeout(connectWS, 4000);
    };
  }

  function switchBot() {
    const pilih = document.getElementById('pilih-bot');
    if (!pilih || !pilih.value) return;
    botId = Number(pilih.value);

    const b = botMap.get(botId);
    const namaBot = (b?.bot_name || pilih.options[pilih.selectedIndex]?.text || 'Bot');
    const ttl = document.getElementById('log-term-title');
    if (ttl) ttl.textContent = 'Live Terminal — ' + namaBot;

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', botId }));
    }
    loadLogs();
  }

  async function isiPilihanBot() {
    const d = await api('/api/bots');
    const bots = d?.bots || [];
    const sel = document.getElementById('pilih-bot');
    const kosong = document.getElementById('log-kosong');
    if (!bots.length) {
      if (kosong) kosong.style.display = '';
      const bar = document.querySelector('.adm-bar');
      if (bar) bar.style.display = 'none';
      if (sel) sel.innerHTML = '';
      return false;
    }
    if (kosong) kosong.style.display = 'none';
    bots.forEach(b => botMap.set(b.id, b));
    if (sel) {
      sel.innerHTML = bots.map(b => '<option value="' + b.id + '">' + esc(b.bot_name) + '</option>').join('');
    }
    botId = bots[0].id;
    return true;
  }

  (async () => {
    if (!(await isiPilihanBot())) return;
    switchBot();
    connectWS();
  })();

  const selBot = document.getElementById('pilih-bot');
  if (selBot) selBot.onchange = switchBot;

  const selLv = document.getElementById('log-level');
  if (selLv) selLv.onchange = loadLogs;

  const btnClear = document.getElementById('btn-clear-terminal');
  if (btnClear) btnClear.onclick = () => clearTerminal(true);

  const sapaan = document.getElementById('greeting');
  if (sapaan) sapaan.textContent = 'Log Aktivitas';
  window.openAddBot = () => { location.href = '/dashboard'; };
  window.muatLogHalaman = loadLogs;
})();
