
require('dotenv').config();
const QRCode = require('qrcode');
const { pool } = require('./config/database');

async function run() {
  const [rows] = await pool.execute(
    "SELECT message, created_at FROM bot_logs WHERE bot_id = 4 AND message LIKE 'QR_DATA:%' ORDER BY id DESC LIMIT 1"
  );
  if (!rows.length) {
    console.log('NO_QR');
    process.exit(1);
  }
  const qr = rows[0].message.replace('QR_DATA:', '');
  console.log('TIME:', rows[0].created_at);
  await QRCode.toFile('/var/www/jadibot/public/qr_scan.png', qr, { width: 450, margin: 2 });
  console.log('QR_SAVED');
  process.exit(0);
}
run();
