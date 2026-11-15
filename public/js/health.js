async function checkAuthSession() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const d = await res.json();
        if (d && d.ok && d.user) {
          document.body.classList.remove('not-logged-in');
          document.body.classList.add('is-auth');
          return;
        }
      }
    } catch {}
    document.body.classList.add('not-logged-in');
    document.body.classList.remove('is-auth');
  }

  function tickClock() {
    const d = new Date();
    document.getElementById('health-clock').textContent = d.toTimeString().split(' ')[0];
  }
  setInterval(tickClock, 1000);
  tickClock();

  let pts = [45, 40, 42, 35, 30, 38, 25, 32, 20, 28, 22];
  function shiftWave() {
    pts.shift();
    pts.push(Math.floor(Math.random() * 25) + 15);
    const step = 400 / (pts.length - 1);
    const dLine = pts.map((y, i) => `${i === 0 ? 'M' : 'L'}${Math.round(i * step)},${y}`).join(' ');
    const dFill = `${dLine} L400,60 L0,60 Z`;
    document.getElementById('svg-line').setAttribute('d', dLine);
    document.getElementById('svg-fill').setAttribute('d', dFill);
    document.getElementById('spark-num').textContent = (0.8 + Math.random() * 0.4).toFixed(1);
  }

  async function pollHealth() {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) return;
      const data = await res.json();
      render(data);
    } catch (e) {}
  }

  function render(data) {
    const m = data.metrics || {};
    const s = data.services || {};

    document.getElementById('val-bots').textContent = `${m.bots?.online || 0} / ${m.bots?.max || 50}`;
    document.getElementById('val-bots-sub').textContent = `${m.bots?.totalRegistered || 0} bot terdaftar`;

    document.getElementById('val-ram').textContent = `${m.ram?.percent || 0}%`;
    document.getElementById('val-ram-sub').textContent = `${m.ram?.usedMb || 0} MB / ${m.ram?.totalMb || 0} MB`;

    document.getElementById('val-disk').textContent = `${m.disk?.percent || 0}%`;
    document.getElementById('val-disk-sub').textContent = `${m.disk?.usedGb || 0} GB / ${m.disk?.totalGb || 0} GB`;

    document.getElementById('val-uptime').textContent = m.uptime || '0j 0m';

    document.getElementById('s-wa').textContent = s.whatsapp?.online_bots || 0;
    document.getElementById('s-tg').textContent = s.telegram?.online_bots || 0;
    document.getElementById('s-dc').textContent = s.discord?.online_bots || 0;

    const logs = data.logs || [];
    const box = document.getElementById('feed-box');
    if (logs.length) {
      const itemsHtml = logs.map(l => {
        let badgeCls = 'sys';
        const a = String(l.act || '').toUpperCase();
        if (a === 'BOT') badgeCls = 'bot';
        else if (a === 'MSG') badgeCls = 'msg';

        const t = formatRel(l.time);
        return `
          <div class="feed-row">
            <div class="feed-row-left">
              <span class="act-badge ${badgeCls}">[ ${escape(a)} ]</span>
              <span class="feed-msg">${escape(l.msg)}</span>
            </div>
            <span class="feed-time">${t}</span>
          </div>
        `;
      }).join('');
      box.innerHTML = itemsHtml;
      box.scrollTop = box.scrollHeight;
    } else {
      box.innerHTML = '<div style="font-size:11px;color:#64748B;padding:12px 0;">Menunggu aktivitas pesan live...</div>';
    }
  }

  function formatRel(iso) {
    if (!iso) return 'baru saja';
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 5) return 'baru saja';
    if (sec < 60) return sec + 's lalu';
    if (sec < 3600) return Math.floor(sec / 60) + 'm lalu';
    return Math.floor(sec / 3600) + 'j lalu';
  }

  function escape(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  checkAuthSession();
  pollHealth();
  setInterval(pollHealth, 3000);
  setInterval(shiftWave, 2000);
