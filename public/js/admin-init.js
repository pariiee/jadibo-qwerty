(function () {
          var seg = location.pathname.split('/').filter(Boolean)[1] || (location.hash || '').replace('#', '') || 'users';
          var k = (seg === 'bots' || seg === 'bot') ? 'bot' : (seg === 'orders' || seg === 'order') ? 'order' : (seg === 'saldo') ? 'saldo' : (seg === 'harga') ? 'harga' : (seg === 'sistem') ? 'sistem' : (seg === 'logs') ? 'logs' : 'user';
          var titles = {
            'user': ['Manajemen User', 'Kelola akun pengguna, hak akses, dan paket langganan bot.'],
            'bot': ['Manajemen Bot', 'Pantau seluruh instans bot pengguna, status koneksi, dan kuota pesan.'],
            'order': ['Pesanan & Pembayaran', 'Daftar invoice, riwayat transaksi QRIS, dan rekap pendapatan sistem.'],
            'saldo': ['Saldo & Dompet User', 'Kelola saldo member, mutasi dompet, dan rekonsiliasi buku besar.'],
            'harga': ['Harga & Benefit Paket', 'Atur harga sewa slot bot, durasi paket, dan batasan kuota pesan.'],
            'sistem': ['Sistem & Server', 'Pemantauan kesehatan server, resource CPU/RAM, dan broadcast pengumuman.'],
            'logs': ['Log Aktivitas Sistem', 'Rekam jejak seluruh operasi sistem: autentikasi, aksi admin, cron otomatis, dan bot.']
          };
          var t = titles[k] || titles['user'];
          var elT = document.getElementById('admin-page-title');
          var elD = document.getElementById('admin-page-desc');
          if (elT) elT.textContent = t[0];
          if (elD) elD.textContent = t[1];
          document.write('<style>#pane-' + k + '{display:block !important;}</style>');
        })();
