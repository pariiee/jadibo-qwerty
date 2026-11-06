(function () {
  const sapaan = document.getElementById('greeting');
  if (sapaan) sapaan.textContent = 'Panduan';
  window.openAddBot = () => { location.href = '/dashboard'; };

  const cari = document.getElementById('panduan-cari');
  const cards = document.querySelectorAll('.faq-card');
  if (cari && cards.length) {
    cari.addEventListener('input', () => {
      const q = cari.value.toLowerCase().trim();
      cards.forEach((card) => {
        const text = card.textContent.toLowerCase();
        card.style.display = !q || text.includes(q) ? '' : 'none';
      });
    });
  }
})();
