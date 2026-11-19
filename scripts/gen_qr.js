
require('dotenv').config();
const QRCode = require('qrcode');
const { pool } = require('../config/database');

async function main() {
  try {
    const [rows] = await pool.execute(
      "SELECT message, created_at FROM bot_logs WHERE bot_id = 4 AND message LIKE 'QR_DATA:%' ORDER BY id DESC LIMIT 1"
    );
    if (!rows.length) { console.log('NO_ROWS'); return; }
    console.log('TIME:', rows[0].created_at);
    const qr = rows[0].message.replace('QR_DATA:', '');
    await QRCode.toFile('/tmp/qr_bot_4.png', qr, { width: 400, margin: 2 });
    console.log('PNG_GENERATED');
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
main();
