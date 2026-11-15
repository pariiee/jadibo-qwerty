(() => {
  fetch('/api/auth/me')
    .then(r => r.json())
    .then(data => {
      if (data && data.user) {
        document.getElementById('succ-username').textContent = data.user.username || 'Pengguna';
        if (data.user.email) {
          document.getElementById('succ-email').textContent = data.user.email;
        }
      }
    })
    .catch(() => {});
})();
