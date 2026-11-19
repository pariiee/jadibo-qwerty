
require('dotenv').config();
const QRCode = require('qrcode');
const { pool } = require('../config/database');

async function main() {
  try {
    const [rows] = await pool.execute(
      "SELECT message, created_at FROM bot_logs WHERE bot_id = 4 AND message LIKE 'QR_DATA:%' ORDER BY id DESC LIMIT 1"
    );
    if (!rows.length) {
      console.log('NO_QR');
      return;
    }
    const qr = rows[0].message.replace('QR_DATA:', '');
    console.log('CREATED_AT:', rows[0].created_at);
    const str = await QRCode.toString(qr, { type: 'terminal', small: true });
    console.log(str);
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
main();
