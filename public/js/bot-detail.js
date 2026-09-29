// Halaman ini dulunya inline <script>, jadi fungsi-fungsinya global.
// CSP sekarang nggak ngebolehin script inline, jadi dibungkus fungsi biasa —
// yang perlu dipanggil HTML diekspor ke window di bawah.
(function () {
// ── Session (cookie-based, no localStorage) ──────────────────────
  let botData = null;
  let isRunning = false;
  let ws = null;
  let statusPoller = null;

  const botId = (location.pathname.match(/\/(\d+)\/?$/) || [])[1];
  if (!botId) { location.href = '/dashboard'; }

  async function api(path, opts = {}) {
    try {
      const res = await fetch(path, {
        ...opts,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
      });
      if (res.status === 401) { location.href = '/'; return null; }
      return res.json();
    } catch { return null; }
  }

  const waIcon = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.37 5.07L2 22l5.09-1.34A9.95 9.95 0 0 0 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2z" fill="#25D366"/></svg>`;
  const tgIcon = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#229ED9"/></svg>`;

  // ── Load bot ─────────────────────────────────────────────────────
  async function loadBot() {
    const d = await api('/api/bots/' + botId);
    if (!d?.ok) { alert('Bot tidak ditemukan'); location.href = '/dashboard'; return; }
    botData = d.bot;
    render();
    loadLogs();
    connectWS();
  }

  function render() {
    const b = botData;
    document.title = b.bot_name + ' — yaparbots';
    document.getElementById('hdr-name').textContent = b.bot_name;
    document.getElementById('hdr-icon').innerHTML = b.platform === 'telegram' ? tgIcon(18) : waIcon(18);
    document.getElementById('cfg-panel').classList.toggle('tg', b.platform === 'telegram');

    if (b.platform === 'telegram') {
      ['w-owner','w-ownername','w-botnum','w-channel','w-maingroups'].forEach(id => document.getElementById(id).style.display = 'none');
    }

    // is_running = "user mau bot ini jalan", BUKAN "socket kebuka"
    // (engine/whatsappEngine.js:347). Jadi pas WA drop koneksi dan engine
    // reconnect 5 detik lagi, halaman ini tetap 'connected' — bukan kedip
    // 'Disconnected' tiap kali WA mutusin koneksi.
    updateStatus(b.is_running ? 'connected' : b.status);

    document.getElementById('cfg-name').value    = b.bot_name || '';
    document.getElementById('cfg-botnum').value  = b.bot_number || '';
    document.getElementById('cfg-owner').value   = b.owner_number || '';
    document.getElementById('cfg-ownername').value = b.owner_name || '';
    document.getElementById('cfg-prefix').value  = b.prefix ?? '';
    document.getElementById('cfg-footer').value  = b.footer_text || '';
    document.getElementById('cfg-desc').value    = b.description || '';
    document.getElementById('cfg-token').value   = b.telegram_token || '';
    document.getElementById('cfg-channel').value = b.channel_id || '';
    document.getElementById('cfg-qris').value    = b.qris_url || '';
    document.getElementById('cfg-banner').value  = b.banner_url || '';
    document.getElementById('cfg-maingroups').value = b.main_groups ? b.main_groups.split(',').map(s => s.trim()).join('\n') : '';
    document.getElementById('cfg-daily').value   = b.daily_limit ?? 20;

    isRunning = !!b.is_running;
    syncBtns();
  }

  function updateStatus(st) {
    const dot = document.getElementById('hdr-dot');
    const txt = document.getElementById('hdr-status');
    const map = {
      connected:    { c: 'on',  l: 'Online' },
      connecting:   { c: 'wait',l: 'Connecting' },
      qr_pending:   { c: 'wait',l: 'QR Pending' },
      disconnected: { c: '',    l: 'Offline' }
    };
    const s = map[st] || map.disconnected;
    dot.className = 'dot ' + s.c;
    txt.textContent = s.l;
  }

  function syncBtns() {
    const starting = (botData?.status === 'qr_pending' || botData?.status === 'connecting');
    document.getElementById('btn-start').disabled = isRunning || starting;
    document.getElementById('btn-stop').disabled  = !isRunning;
  }

  // ── Logs & terminal ──────────────────────────────────────────────
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  async function loadLogs() {
    const d = await api('/api/bots/' + botId + '/logs?limit=80');
    if (!d?.ok) return;
    d.logs.forEach(l => appendLog(l.level, l.message, false, l.created_at));
    scrollTerm();
  }

  // Server kirim created_at UTC (kolom MySQL default TIMESTAMP).
  // Tanpa 'Z', JS bacanya sebagai waktu lokal → jam log meleset sebesar offset.
  function logTime(v) {
    if (!v) return new Date().toLocaleTimeString('id-ID', { hour12: false });
    const s = /Z|[+-]\d\d:?\d\d$/.test(v) ? v : String(v).replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return isNaN(d) ? String(v) : d.toLocaleTimeString('id-ID', { hour12: false });
  }

  function appendLog(level, message, scroll = true, when = null) {
    const t = document.getElementById('terminal');
    const el = document.createElement('p');
    const known = ['info','warn','error','debug','cmd','cmderr'];
    const lv = known.includes(level) ? level : 'info';
    el.className = 'log-line log-' + lv;
    const ts = logTime(when);
    if (String(message).startsWith('QR_DATA:')) return;
    el.textContent = '[' + ts + '] ' + message;
    t.appendChild(el);
    while (t.children.length > 300) t.removeChild(t.firstChild);
    if (scroll) scrollTerm();
  }
  function scrollTerm() { const t = document.getElementById('terminal'); t.scrollTop = t.scrollHeight; }
  function clearTerminal() {
    const t = document.getElementById('terminal');
    t.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'log-line term-hint';
    p.textContent = '// Terminal dibersihkan';
    t.appendChild(p);
  }

  // ── WebSocket (auth: cookie httpOnly) ────────────────────────────
  function connectWS() {
    try { if (ws) ws.close(); } catch {}
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe', botId: parseInt(botId, 10) }));
      setWs(true);
    };
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'error') { setWs(false); return; }
        if (d.type === 'log') appendLog(d.payload.level, d.payload.message);
        if (d.type === 'status') {
          const s = d.payload.status;
          if (s === 'connecting') clearTerminal();
          updateStatus(s);
          isRunning = (s === 'connected');
          if (botData) botData.status = s;
          syncBtns();
          if (s === 'connected') { dismissQr(); }
        }
        if (d.type === 'qr') showQr(d.payload.qr);
        if (d.type === 'pairing_code') {
          // Cuma render kalau panelnya masih kebuka — jangan maksa munculin ulang
          // tiap 20s kalau user udah nutup.
          if (document.getElementById('qr-panel').classList.contains('show'))
            showPairing(d.payload.code, d.payload.ttlMs);
        }
      } catch {}
    };
    ws.onclose = () => {
      setWs(false);
      setTimeout(connectWS, 4000);
    };
  }
  function setWs(on) {
    document.getElementById('ws-dot').className = 'state' + (on ? ' live' : '');
    document.getElementById('ws-lbl').textContent = on ? 'Live' : 'Reconnecting...';
  }

  // ── QR / pairing ─────────────────────────────────────────────────
  function showQr(qr) {
    const panel = document.getElementById('qr-panel');
    panel.classList.add('show');
    document.getElementById('mode-qr').classList.add('show');
    document.getElementById('mode-pairing').classList.remove('show');
    document.getElementById('qr-title').textContent = 'Scan QR Code';
    const canvas = document.getElementById('qr-canvas');
    if (typeof QRCode !== 'undefined') {
      QRCode.toCanvas(canvas, qr, { width: 200, margin: 1 }, (err) => {
        if (err) {
          canvas.parentElement.querySelector('p').textContent = qr.slice(0, 120) + (qr.length > 120 ? '...' : '');
        }
      });
    }
  }
  function showPairing(code, ttlMs) {
    const panel = document.getElementById('qr-panel');
    panel.classList.add('show');
    document.getElementById('mode-qr').classList.remove('show');
    document.getElementById('mode-pairing').classList.add('show');
    document.getElementById('qr-title').textContent = 'Pairing Code';
    document.getElementById('pair-wait').style.display = 'none';
    const box = document.getElementById('pair-box');
    box.style.display = 'flex';
    document.getElementById('pair-code').textContent = code;
    startPairCountdown(ttlMs || 20000);
  }
  // Kode ini cuma hidup sebentar di server. Kalau belum dipakai, kode baru bakal
  // di-push otomatis — timer ini ngasih tau user sisa waktunya.
  function startPairCountdown(ttlMs) {
    const el = document.getElementById('pair-timer');
    clearInterval(startPairCountdown._t);
    let left = Math.ceil(ttlMs / 1000);
    const tick = () => {
      if (left <= 0) {
        clearInterval(startPairCountdown._t);
        // Kode lama udah mati — jangan biarin user ngetik kode basi.
        document.getElementById('pair-code').textContent = '——————';
        el.textContent = 'Kode kadaluarsa — meminta kode baru...';
        return;
      }
      el.textContent = 'Kode berlaku ' + left + ' detik lagi';
      left--;
    };
    tick();
    startPairCountdown._t = setInterval(tick, 1000);
  }
  function dismissQr() {
    clearInterval(startPairCountdown._t);
    document.getElementById('qr-panel').classList.remove('show');
    document.getElementById('mode-qr').classList.remove('show');
    document.getElementById('mode-pairing').classList.remove('show');
    document.getElementById('pair-box').style.display = 'none';
    document.getElementById('pair-wait').style.display = '';
  }

  // ── Controls ─────────────────────────────────────────────────────
  function ctrlMsg(msg, type) {
    const el = document.getElementById('ctrl-msg');
    el.textContent = msg;
    el.className = 'ctrl-msg show' + (type === 'error' ? ' err' : '');
    clearTimeout(ctrlMsg._t);
    ctrlMsg._t = setTimeout(() => { el.classList.remove('show'); }, 4000);
  }

  function startBot() {
    if (botData?.platform === 'telegram') { confirmStart(false); return; }
    document.getElementById('start-overlay').classList.add('show');
  }
  async function confirmStart(usePairing) {
    document.getElementById('start-overlay').classList.remove('show');
    if (usePairing && (!botData?.bot_number || !botData.bot_number.trim())) {
      ctrlMsg('Isi Nomor Bot WA dulu di form Konfigurasi sebelum pakai Pairing Code.', 'error');
      return;
    }
    document.getElementById('qr-panel').classList.add('show');
    if (usePairing) {
      document.getElementById('mode-qr').classList.remove('show');
      document.getElementById('mode-pairing').classList.add('show');
      document.getElementById('qr-title').textContent = 'Pairing Code';
      document.getElementById('pair-wait').style.display = '';
      document.getElementById('pair-box').style.display = 'none';
      document.getElementById('pair-timer').textContent = '';
    } else {
      document.getElementById('mode-pairing').classList.remove('show');
      document.getElementById('mode-qr').classList.add('show');
      document.getElementById('qr-title').textContent = 'Scan QR Code';
    }
    ctrlMsg(usePairing ? ('Meminta pairing code untuk ' + botData.bot_number + '...') : 'Memulai bot dengan QR...');
    const d = await api('/api/bots/' + botId + '/start', { method: 'POST', body: JSON.stringify({ use_pairing_code: usePairing }) });
    if (!d) return;
    if (d.ok) { ctrlMsg(d.message); startPolling(); }
    else { ctrlMsg(d.message, 'error'); document.getElementById('qr-panel').classList.remove('show'); }
  }
  async function stopBot() {
    const d = await api('/api/bots/' + botId + '/stop', { method: 'POST' });
    if (!d) return;
    if (d.ok) { isRunning = false; syncBtns(); updateStatus('disconnected'); ctrlMsg('Bot dihentikan'); }
    else ctrlMsg(d.message, 'error');
  }
  async function restartBot() {
    ctrlMsg('Merestart bot...');
    const d = await api('/api/bots/' + botId + '/restart', { method: 'POST' });
    if (!d) return;
    if (d.ok) ctrlMsg('Bot di-restart');
    else ctrlMsg(d.message, 'error');
  }
  async function clearSession() {
    if (!confirm('Hapus sesi? Bot perlu scan QR ulang setelah ini.')) return;
    const d = await api('/api/bots/' + botId + '/clear-session', { method: 'POST' });
    if (!d) return;
    if (d.ok) { dismissQr(); clearTerminal(); updateStatus('disconnected'); isRunning = false; syncBtns(); ctrlMsg(d.message); }
    else ctrlMsg(d.message, 'error');
  }
  function startPolling() {
    if (statusPoller) return;
    statusPoller = setInterval(async () => {
      const d = await api('/api/bots/' + botId);
      if (!d?.ok) return;
      const st = d.bot.status;
      // Hanya anggap connected kalau status beneran 'connected' —
      // jangan dismiss QR pas masih qr_pending/connecting.
      if (st === 'connected') {
        const was = isRunning;
        isRunning = true; updateStatus('connected'); syncBtns();
        if (!was) { dismissQr(); ctrlMsg('Bot berhasil terhubung!'); stopPolling(); }
      } else if (st === 'disconnected') {
        isRunning = false; syncBtns();
      }
    }, 2000);
  }
  function stopPolling() { if (statusPoller) { clearInterval(statusPoller); statusPoller = null; } }

  // ── Save config ──────────────────────────────────────────────────
  document.getElementById('cfg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('cfg-err');
    err.classList.remove('show');
    // Cuma ID grup (JID) yang diterima — link undangan ditolak, bukan di-resolve.
    const mgList = document.getElementById('cfg-maingroups').value
      .split('\n').map(s => s.trim()).filter(Boolean);
    const bad = mgList.find(s => !/^\d+@g\.us$/.test(s));
    if (bad) {
      err.textContent = '"' + bad + '" bukan ID grup. Formatnya 120363xxxxxxxxxx@g.us — atau ketik .gcutama di grupnya biar ID-nya keisi sendiri.';
      err.classList.add('show');
      return;
    }
    const body = {
      bot_name: document.getElementById('cfg-name').value.trim(),
      bot_number: document.getElementById('cfg-botnum').value.trim() || undefined,
      owner_number: document.getElementById('cfg-owner').value.trim() || undefined,
      owner_name: document.getElementById('cfg-ownername').value.trim() || undefined,
      prefix: document.getElementById('cfg-prefix').value.trim(),
      footer_text: document.getElementById('cfg-footer').value.trim(),
      description: document.getElementById('cfg-desc').value.trim(),
      telegram_token: document.getElementById('cfg-token').value.trim() || undefined,
      channel_id: document.getElementById('cfg-channel').value.trim() || null,
      qris_url: document.getElementById('cfg-qris').value.trim() || null,
      banner_url: document.getElementById('cfg-banner').value.trim() || null,
      main_groups: mgList.length ? mgList.join(',') : null,
      daily_limit: parseInt(document.getElementById('cfg-daily').value, 10) || 20
    };
    const d = await api('/api/bots/' + botId, { method: 'PATCH', body: JSON.stringify(body) });
    if (!d) return;
    if (d.ok) {
      document.getElementById('hdr-name').textContent = body.bot_name;
      err.classList.remove('show');
      botData = { ...botData, ...body };
      if (isRunning) { ctrlMsg('Konfigurasi disimpan — merestart bot...'); await api('/api/bots/' + botId + '/restart', { method: 'POST' }); }
      else ctrlMsg('Perubahan disimpan');
    } else { err.textContent = d.message; err.classList.add('show'); }
  });

  function toggleToken() {
    const inp = document.getElementById('cfg-token');
    const btn = document.getElementById('token-toggle');
    const isPw = inp.type === 'password';
    inp.type = isPw ? 'text' : 'password';
    btn.textContent = isPw ? 'Sembunyi' : 'Lihat';
  }

  // ── Delete ───────────────────────────────────────────────────────
  function confirmDelete() { document.getElementById('del-overlay').classList.add('show'); }
  function closeDel() { document.getElementById('del-overlay').classList.remove('show'); }
  async function doDelete() {
    const d = await api('/api/bots/' + botId, { method: 'DELETE' });
    if (!d) return;
    if (d.ok) location.href = '/dashboard';
    else alert(d.message);
  }

  document.getElementById('del-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeDel(); });
  document.getElementById('start-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) document.getElementById('start-overlay').classList.remove('show'); });

  loadBot();
window.startBot = startBot; window.stopBot = stopBot; window.confirmStart = confirmStart;
window.saveConfig = saveConfig; window.clearSession = clearSession; window.restartBot = restartBot;
window.dismissQr = dismissQr; window.clearTerminal = clearTerminal; window.toggleToken = toggleToken;
window.confirmDelete = confirmDelete; window.closeDel = closeDel; window.doDelete = doDelete;

})();
