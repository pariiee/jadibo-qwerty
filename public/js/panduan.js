(function () {
  const sapaan = document.getElementById('greeting');
  if (sapaan) sapaan.textContent = 'Panduan';
  window.openAddBot = () => { location.href = '/dashboard'; };

  const cari = document.getElementById('panduan-cari');
  const cards = document.querySelectorAll('.faq-card');
  const statVal = document.querySelector('.panduan-stat-val');

  // Pastikan semua accordion tertutup saat pertama dibuka
  cards.forEach(c => c.removeAttribute('open'));

  // Jika ada target hash di URL (misal: #panduan-discord), buka accordion terkait
  if (location.hash) {
    const target = document.querySelector(location.hash);
    if (target && target.tagName === 'DETAILS') target.setAttribute('open', '');
  }

  function updateStat(count) {
    if (statVal) statVal.textContent = count + ' Panduan';
  }
  updateStat(cards.length);

  if (cari && cards.length) {
    cari.addEventListener('input', () => {
      const q = cari.value.toLowerCase().trim();
      let visible = 0;
      cards.forEach((card) => {
        const text = card.textContent.toLowerCase();
        const match = !q || text.includes(q);
        card.style.display = match ? '' : 'none';
        if (match) visible++;
      });
      updateStat(visible);
    });
  }
})();
