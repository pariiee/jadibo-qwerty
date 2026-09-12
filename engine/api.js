'use strict';

/**
 * engine/api.js
 * Pusat panggilan REST YaPari: upload media, GET/POST endpoint ber-api-key.
 *
 * Sebelumnya `X-API-Key` + `${BASE_API}` ditulis ulang di ~150 tempat, dan
 * `FormData` + `require('axios')` di-import inline di dalam case. Sekarang
 * cukup `require('../engine/api')`.
 *
 *   const { upload, apiGet, apiPost } = require('../engine/api');
 *   const url = await upload(buffer, 'foto.jpg', 'image/jpeg');   // -> file_url
 *   const res = await apiGet('api/maker/brat', { params: { text } });
 */

const axios    = require('axios');
const FormData = require('form-data');

/** `${BASE_API}` tanpa '/' di ujung. Pakai `url()` untuk menyambung path, jangan `base()` langsung. */
const base = () => String(process.env.BASE_API || '').replace(/\/+$/, '');
const auth = () => ({ 'X-API-Key': process.env.KEY_API });

/** Sambung base + path, aman untuk BASE_API ber-'/' ataupun tidak, path ber-'/' ataupun tidak. */
const url = (path) => `${base()}/${String(path || '').replace(/^\/+/, '')}`;

/**
 * Upload buffer media -> URL publik YaPari.
 *
 * DUA endpoint, beda umur URL (dan beda bentuk response!):
 *   v1  `api/tools/upload`     → cepat, `expires`: "24 jam"      → untuk yang URL-nya dipakai SEKARANG
 *                                (stiker, topng/tomp4, decode-qr, ocr, upscale, hasil maker)
 *   v2  `api/tools/upload-v2`  → lambat dikit, `expires`: "Permanen" → untuk URL yang DISIMPAN
 *                                (setqris, banner, apa pun yang ditulis ke DB/web)
 *
 * Bentuk response beda dan itu sumber bug: v1 = `results.file_url`, v2 = `result.url`.
 * Helper ini yang menyeragamkan; jangan baca `results.file_url` mentah-mentah untuk v2.
 *
 * @param  {Buffer} buffer
 * @param  {string} filename   'foto.jpg'
 * @param  {string} mimetype   'image/jpeg'
 * @param  {{ v2?: boolean, timeout?: number }} [opts] v2 = endpoint permanen
 * @return {Promise<string>}   URL-nya saja
 */
async function upload(buffer, filename, mimetype, opts = {}) {
  const { url: fileUrl } = await uploadInfo(buffer, filename, mimetype, opts);
  return fileUrl;
}

/**
 * Sama seperti `upload()`, tapi balikin info lengkap.
 * @return {Promise<{url:string, expires:string|null, size:number|null, provider:string|null}>}
 */
async function uploadInfo(buffer, filename, mimetype, opts = {}) {
  const endpoint = opts.v2 ? 'api/tools/upload-v2' : 'api/tools/upload';
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mimetype });

  const res = await axios.post(url(endpoint), form, {
    headers: { ...form.getHeaders(), ...auth() },
    timeout: opts.timeout ?? (opts.v2 ? 30000 : 20000),
    maxBodyLength: Infinity,
  });

  // v2: result.* | v1: results.*  — plus fallback bentuk lama
  const r = res.data?.result || res.data?.results || res.data || {};
  const fileUrl = r.file_url || r.url;
  if (!fileUrl) throw new Error('Upload gagal: URL tidak ditemukan di response');

  return {
    url:      fileUrl,
    expires:  r.expires ?? null,
    size:     r.size ?? null,
    provider: r.provider ?? null,
  };
}

/** GET endpoint API. Balikin axios response (panggil `.data` / `.data.results` sendiri). */
function apiGet(path, opts = {}) {
  return axios.get(url(path), { headers: auth(), timeout: 30000, ...opts });
}

/** POST endpoint API. `body` di-JSON-kan, bukan multipart — pakai `upload()` untuk file. */
function apiPost(path, body, opts = {}) {
  return axios.post(url(path), body, { headers: auth(), timeout: 30000, ...opts });
}

module.exports = { base, url, auth, upload, uploadInfo, apiGet, apiPost };
