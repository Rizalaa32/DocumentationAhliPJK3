// server.js — Backend Node.js / Express untuk Riksa Uji PJK3
// Tugas: Menerima payload dari PWA, menyimpan gambar, menyusun Base-6 Grid, & generate PDF
'use strict';

const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const path       = require('path');
const fs         = require('fs');
const puppeteer  = require('puppeteer');
const htmlDocx   = require('html-docx-js');
const { Jimp }   = require('jimp');

// Muat konfigurasi dari file .env jika tersedia (tanpa dependency tambahan)
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!(k in process.env)) process.env[k] = v;
    }
  });
}

const app        = express();
const PORT       = process.env.PORT || 3000;
const ACCESS_KEY = (process.env.ACCESS_KEY || '').trim();
const UPLOADS    = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Percayai reverse proxy (Nginx / Cloudflare) agar IP & protokol HTTPS terbaca akurat
app.set('trust proxy', 1);

// ════════════════════════════════════════════════════════════
// ACCESS CONTROL & PROXY HELPERS
// ════════════════════════════════════════════════════════════

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
    }
  });
  return out;
}

function getClientProtocol(req) {
  if (req.headers['cf-visitor']) {
    try {
      const cf = JSON.parse(req.headers['cf-visitor']);
      if (cf && cf.scheme) return cf.scheme;
    } catch (_) {}
  }
  const xfProto = req.headers['x-forwarded-proto'];
  if (xfProto) return String(xfProto).split(',')[0].trim();
  return req.protocol || 'http';
}

function getBaseUrl(req) {
  return `${getClientProtocol(req)}://${req.get('host')}`;
}

function isAuthorized(req) {
  if (!ACCESS_KEY) return true;
  const headerKey = req.headers['x-access-key'];
  const queryKey  = req.query ? req.query.key : undefined;
  const cookies   = parseCookies(req);
  const cookieKey = cookies.riksauji_key;

  return (
    safeCompare(headerKey, ACCESS_KEY) ||
    safeCompare(queryKey, ACCESS_KEY) ||
    safeCompare(cookieKey, ACCESS_KEY)
  );
}

function setAuthCookie(req, res) {
  if (!ACCESS_KEY) return;
  const isHttps = getClientProtocol(req) === 'https';
  const parts = [
    `riksauji_key=${encodeURIComponent(ACCESS_KEY)}`,
    'Path=/',
    'Max-Age=31536000',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function requireAccessKey(req, res, next) {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      code:    'UNAUTHORIZED',
      message: 'Akses ditolak. Gunakan tautan khusus atau masukkan Kode Akses yang benar.'
    });
  }
  setAuthCookie(req, res);
  next();
}

// ════════════════════════════════════════════════════════════
// MIDDLEWARE
// ════════════════════════════════════════════════════════════

app.use(cors({
  origin:         process.env.ALLOWED_ORIGIN || '*',
  methods:        ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Accept', 'X-Access-Key']
}));

// Limit payload 50MB untuk menampung banyak gambar Base64
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Pastikan sw.js tidak di-cache agresif oleh browser / CDN Cloudflare
app.get('/sw.js', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

// Set cookie akses otomatis saat pertama kali dibuka via secret link (?key=...) & izinkan kamera origin sendiri
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self)');
  if (ACCESS_KEY && req.method === 'GET' && req.query && req.query.key && isAuthorized(req)) {
    setAuthCookie(req, res);
  }
  next();
});

// Serve PWA static files dari /public
app.use(express.static(PUBLIC_DIR));

// Expose folder gambar & dokumen yang tersimpan (dilindungi ACCESS_KEY jika aktif)
app.use('/uploads', (req, res, next) => {
  if (!isAuthorized(req)) {
    return res.status(401).send('401 Unauthorized — Buka aplikasi melalui tautan resmi terlebih dahulu.');
  }
  setAuthCookie(req, res);
  next();
}, express.static(UPLOADS));

// ════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ════════════════════════════════════════════════════════════

/**
 * Sanitasi string agar aman digunakan sebagai nama direktori/file.
 * Hapus karakter khusus, ganti spasi dengan underscore, batasi 50 char.
 * @param {string} str
 * @returns {string}
 */
function sanitizePath(str) {
  return String(str || 'unknown')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')       // Hapus diakritik
    .replace(/[^a-zA-Z0-9\-_.]/g, '_')    // Hanya alfanumerik & -_.
    .replace(/__+/g, '_')                  // Tidak ada double underscore
    .replace(/^_+|_+$/g, '')              // Trim underscore di tepi
    .substring(0, 50)
    || 'unknown';
}

/**
 * Escape HTML entity agar aman dirender ke browser/PDF.
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Menyimpan string Base64 gambar ke disk sebagai file JPEG.
 * @param {string} base64Str  - Data URI Base64 ("data:image/...;base64,...")
 * @param {string} dirPath    - Absolute path direktori tujuan
 * @param {string} filename   - Nama file (misal: "foto_1.jpg")
 * @returns {string|null}     - Relative path (untuk URL) atau null jika gagal
 */
async function saveBase64Image(base64Str, dirPath, filename) {
  if (!base64Str || !base64Str.startsWith('data:image')) {
    return null;
  }

  try {
    // Hapus prefix data URI dan decode ke Buffer
    const base64Data = base64Str.replace(/^data:image\/\w+;base64,/, '');
    const buffer     = Buffer.from(base64Data, 'base64');

    // Buat direktori secara rekursif jika belum ada
    fs.mkdirSync(dirPath, { recursive: true });
    const filePath = path.join(dirPath, filename);

    // Proses gambar menggunakan Jimp: kecilkan dimensi agar proporsional maksimal 800x800
    // Tanpa background tambahan agar bentuk aslinya tetap terjaga (bebas letterbox)
    const image = await Jimp.read(buffer);
    image.scaleToFit({ w: 800, h: 800 });
    const processedBuffer = await image.getBuffer('image/jpeg');

    fs.writeFileSync(filePath, processedBuffer);

    return {
      filePath,
      width: image.bitmap.width,
      height: image.bitmap.height
    };
  } catch (err) {
    console.error('[SaveImage] Error:', err.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// BASE-6 GRID ALGORITHM
// ════════════════════════════════════════════════════════════

/**
 * Peta layout → colspan.
 * Grid total = 6 kolom.
 *   1col → 1 foto  → colspan 6  (full width)
 *   2col → 2 foto  → colspan 3  (half width each, side by side)
 *   3col → 3 foto  → colspan 2  (third width each, side by side)
 */
const COLSPAN_MAP  = { '1col': 6, '2col': 3, '3col': 2 };
const SLOTLABEL_MAP = {
  '1col': ['Foto'],
  '2col': ['Kiri', 'Kanan'],
  '3col': ['Atas', 'Tengah', 'Bawah']
};

/**
 * Menghasilkan baris-baris HTML (<tr>) untuk satu blok dokumentasi.
 * Tidak membungkus dengan <table> — disatukan ke dalam satu tabel utuh di fullHtmlDoc.
 * Tidak menampilkan label posisi slot (KIRI/KANAN/ATAS/TENGAH/BAWAH).
 *
 * @param {Object} blok        - Data blok { judul, layout, slots[] }
 * @param {Array}  imagePaths  - Array relative URL gambar per slot (atau null)
 * @param {string} baseUrl     - Base URL server (untuk src gambar)
 * @returns {string}           - HTML rows string (<tr>...</tr>)
 */
function generateBase6Grid(blok, imagePaths, baseUrl) {
  const colspan = COLSPAN_MAP[blok.layout] || 6;
  const title   = esc(blok.judul || 'Pemeriksaan');

  // Setiap blok dibungkus <table> terpisah dengan page-break-inside:avoid
  // agar judul dan foto tidak terpisah di page break PDF/Word
  let rows = `
  <table border="1" cellspacing="0" cellpadding="0" 
         style="width:100%; table-layout:fixed; border-collapse:collapse;
                font-family:Arial,Helvetica,sans-serif;
                border:1px solid #CBD5E1; margin-bottom:20px;
                page-break-inside:avoid; break-inside:avoid;">
  <tbody style="break-inside:avoid; page-break-inside:avoid;">
    <tr style="page-break-after:avoid; break-after:avoid; page-break-inside:avoid; break-inside:avoid;">
      <td colspan="6"
          style="padding:10px 14px; background-color:#1E3A5F; color:#FFFFFF;
                 font-weight:bold; font-size:13px; letter-spacing:0.02em;
                 border:1px solid #CBD5E1;
                 page-break-after:avoid; break-after:avoid;">
        <p style="margin:0; page-break-after:avoid; break-after:avoid; page-break-inside:avoid; break-inside:avoid;">
          ${title}
        </p>
      </td>
    </tr>
    <tr style="page-break-before:avoid; break-before:avoid; page-break-inside:avoid; break-inside:avoid;">`;

  (blok.slots || []).forEach((slot, idx) => {
    const rawImg = imagePaths[idx];
    const imgData = typeof rawImg === 'string' ? { relPath: rawImg } : rawImg;
    let imgSrc = null;
    let actualW = 0, actualH = 0;
    if (imgData && imgData.relPath) {
      const absPath = path.join(__dirname, 'uploads', imgData.relPath);
      if (fs.existsSync(absPath)) {
        const ext = path.extname(absPath).substring(1) || 'jpeg';
        const b64 = fs.readFileSync(absPath).toString('base64');
        imgSrc = `data:image/${ext};base64,${b64}`;
        actualW = imgData.width || 0;
        actualH = imgData.height || 0;
      }
    }
    const ket = esc(slot.keterangan || '\u2014');

    let maxW = 280;
    let maxH = 280;
    if (blok.layout === '1col') { maxW = 500; maxH = 400; }
    if (blok.layout === '3col') { maxW = 180; maxH = 180; }

    let finalW = maxW;
    let finalH = maxH;
    
    if (actualW > 0 && actualH > 0) {
      const ratioX = maxW / actualW;
      const ratioY = maxH / actualH;
      const ratio = Math.min(ratioX, ratioY);
      
      finalW = Math.round(actualW * ratio);
      finalH = Math.round(actualH * ratio);
    }

    const tdWidth = (colspan / 6) * 100;

    rows += `
      <td colspan="${colspan}" width="${tdWidth}%"
          style="padding:10px; border:1px solid #CBD5E1; vertical-align:top;
                 text-align:center;">
        ${imgSrc
          ? `<div style="width:${finalW}px; height:${finalH}px; overflow:hidden; margin:0 auto 8px;">
               <img src="${imgSrc}" width="${finalW}" height="${finalH}"
                    style="display:block; object-fit:cover;" alt="Foto">
             </div>`
          : `<div style="width:100px; height:100px; border:2px dashed #CBD5E1; 
                         border-radius:8px; display:flex; align-items:center; 
                         justify-content:center; margin:0 auto 8px; 
                         background-color:#F8FAFC;">
               <span style="color:#94A3B8; font-size:12px;">Kosong</span>
             </div>`
        }
        <p style="font-size:11.5px; color:#1E293B; text-align:left; margin:0;
                  padding:6px 8px; background:#F8FAFC; border-radius:4px;
                  border:1px solid #E2E8F0; line-height:1.55;">
          ${ket}
        </p>
      </td>`;
  });

  rows += `
    </tr>
  </tbody>
  </table>`;

  return rows;
}

// ════════════════════════════════════════════════════════════
// PDF GENERATION VIA PUPPETEER
// ════════════════════════════════════════════════════════════

// Singleton browser instance — dibuka sekali, dipakai berkali-kali
let _browser;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_browser) {
    try { await _browser.close(); } catch (e) {}
  }
  const launchOpts = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  } else {
    try {
      const defaultPath = puppeteer.executablePath();
      if (!defaultPath || !fs.existsSync(defaultPath)) {
        const candidates = [
          '/usr/bin/google-chrome-stable',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium'
        ];
        const found = candidates.find(p => fs.existsSync(p));
        if (found) launchOpts.executablePath = found;
      }
    } catch (_) {}
  }
  _browser = await puppeteer.launch(launchOpts);
  console.log('[PDF] Puppeteer browser launched.');
  return _browser;
}

/**
 * Menghasilkan file PDF dari string HTML menggunakan Puppeteer.
 * Format A4, margin standar dokumen, background tercetak.
 *
 * @param {string} htmlContent  - String HTML lengkap yang akan dirender
 * @param {string} outputPath   - Absolute path file PDF tujuan
 * @returns {Promise<string>}   - Path file PDF yang tersimpan
 */
async function generatePDF(htmlContent, outputPath) {
  const browser = await getBrowser();
  const page    = await browser.newPage();

  try {
    // Set viewport A4
    await page.setViewport({ width: 794, height: 1123 });

    // Load HTML — waitUntil networkidle0 agar semua gambar local ter-render
    await page.setContent(htmlContent, { waitUntil: 'networkidle2', timeout: 30000 });

    // Generate PDF — tanpa header/footer Puppeteer
    await page.pdf({
      path:                outputPath,
      format:              'A4',
      printBackground:     true,
      displayHeaderFooter: false,
      margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' }
    });

    console.log('[PDF] Generated:', outputPath);
    return outputPath;
  } finally {
    await page.close();
  }
}

/**
 * Menghasilkan file Word (.docx) dari string HTML menggunakan html-to-docx.
 * 
 * @param {string} htmlContent  - String HTML lengkap yang akan dirender
 * @param {string} outputPath   - Absolute path file Docx tujuan
 * @returns {Promise<string>}   - Path file Docx yang tersimpan
 */
async function generateDocx(htmlContent, outputPath) {
  try {
    const out = htmlDocx.asBlob(htmlContent);
    let buf;
    if (Buffer.isBuffer(out)) {
      buf = out;
    } else if (out && typeof out.arrayBuffer === 'function') {
      const arrayBuffer = await out.arrayBuffer();
      buf = Buffer.from(arrayBuffer);
    } else {
      buf = Buffer.from(out);
    }
    fs.writeFileSync(outputPath, buf);
    console.log('[DOCX] Generated:', outputPath);
    return outputPath;
  } catch (err) {
    console.error('[DOCX] Error generating docx:', err);
    throw err;
  }
}

// ════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════

/**
 * GET /api/health
 * Health check endpoint untuk monitoring
 */
app.get('/api/health', (req, res) => {
  res.json({
    status:       'ok',
    app:          'Riksa Uji PJK3 API',
    version:      '1.0.0',
    authRequired: Boolean(ACCESS_KEY),
    timestamp:    new Date().toISOString(),
    uptime:       process.uptime()
  });
});

/**
 * GET / POST /api/auth
 * Verifikasi tautan rahasia / Kode Akses tim dan pasang HttpOnly cookie untuk akses /uploads
 */
app.all('/api/auth', (req, res) => {
  if (!ACCESS_KEY) {
    return res.json({
      success:       true,
      authRequired:  false,
      authenticated: true
    });
  }

  if (isAuthorized(req)) {
    setAuthCookie(req, res);
    return res.json({
      success:       true,
      authRequired:  true,
      authenticated: true
    });
  }

  return res.status(401).json({
    success:       false,
    authRequired:  true,
    authenticated: false,
    message:       'Kode akses diperlukan atau tidak valid.'
  });
});

/**
 * POST /api/sync
 * Endpoint utama sinkronisasi data dari PWA.
 *
 * Payload (JSON):
 *   {
 *     records: [
 *       {
 *         id:              number,
 *         namaPerusahaan:  string,
 *         jenisObjek:      string,
 *         noSerie:         string,
 *         blokDokumentasi: [
 *           {
 *             judul:  string,
 *             layout: "1col"|"2col"|"3col",
 *             slots:  [
 *               { foto: "data:image/jpeg;base64,...", keterangan: string }
 *             ]
 *           }
 *         ],
 *         status:    "pending",
 *         createdAt: ISO string
 *       }
 *     ]
 *   }
 *
 * Response:
 *   {
 *     success:   boolean,
 *     message:   string,
 *     processed: number,
 *     failed:    number,
 *     results:   [...],
 *     errors:    [...] | undefined
 *   }
 */
function buildFullHtmlDoc(record, allRows) {
  return `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lampiran Riksa Uji — ${esc(record.jenisObjek)} — ${esc(record.namaPerusahaan)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: Arial, Helvetica, sans-serif;
      margin: 0; padding: 20px;
      color: #0F172A; background: #fff;
      font-size: 12px;
    }
    table { border-collapse: collapse; }
    img   { max-width: 100%; height: auto; }
  </style>
</head>
<body>

  <!-- JUDUL LAMPIRAN -->
  <p style="text-align:center; font-weight:bold; font-size:14px;
            letter-spacing:0.06em; margin:0 0 24px;">
    LAMPIRAN
  </p>

  <!-- IDENTITAS (justify kiri dengan lebar kolom seragam) -->
  <table style="margin-bottom:20px; border:none; line-height:1.2;">
    <tr>
      <td style="width:155px; padding:0; vertical-align:top; height:18px;">Nama Perusahaan</td>
      <td style="padding:0 10px; vertical-align:top; height:18px;">:</td>
      <td style="padding:0; vertical-align:top; height:18px;">${esc(record.namaPerusahaan)}</td>
    </tr>
    <tr>
      <td style="padding:0; vertical-align:top; height:18px;">Jenis Objek K3</td>
      <td style="padding:0 10px; vertical-align:top; height:18px;">:</td>
      <td style="padding:0; vertical-align:top; height:18px;">${esc(record.jenisObjek)}</td>
    </tr>
    <tr>
      <td style="padding:0; vertical-align:top; height:18px;">No. Serie</td>
      <td style="padding:0 10px; vertical-align:top; height:18px;">:</td>
      <td style="padding:0; vertical-align:top; height:18px;">${esc(record.noSerie)}</td>
    </tr>
  </table>

  <!-- TABEL DOKUMENTASI (MASING-MASING BLOK PUNYA TABEL SENDIRI) -->
  <div style="width:100%;">
    ${allRows}
  </div>

</body>
</html>`;
}

function resolveSafeSessionDir(rawSerie, rawSessionTs) {
  const safeSerie = sanitizePath(rawSerie);
  const sessionTs = String(rawSessionTs || '').trim();
  if (!safeSerie || safeSerie !== rawSerie || !/^\d+$/.test(sessionTs)) {
    return null;
  }
  const uploadsRoot = path.resolve(UPLOADS);
  const sessionDir  = path.resolve(UPLOADS, safeSerie, sessionTs);
  if (!sessionDir.startsWith(uploadsRoot + path.sep)) {
    return null;
  }
  return { safeSerie, sessionTs, sessionDir };
}

function readServerSessionSummary(safeSerie, sessionTs, baseUrl) {
  const sessionDir = path.join(UPLOADS, safeSerie, sessionTs);
  if (!fs.existsSync(sessionDir) || !fs.statSync(sessionDir).isDirectory()) return null;

  const entries  = fs.readdirSync(sessionDir);
  const pdfFile  = entries.find(f => /\.pdf$/i.test(f)) || null;
  const docxFile = entries.find(f => /\.docx$/i.test(f)) || null;
  const blokDirs = entries
    .filter(f => /^blok_\d+$/i.test(f) && fs.statSync(path.join(sessionDir, f)).isDirectory())
    .sort((a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10));

  const metaPath = path.join(sessionDir, 'meta.json');
  let meta = null;
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (_) {}
  }

  let fallbackCompany = `Laporan (SN: ${safeSerie})`;
  let fallbackJenis   = 'Dokumentasi Riksa Uji';
  if (!meta && docxFile) {
    try {
      const raw = fs.readFileSync(path.join(sessionDir, docxFile)).toString('utf8');
      const m = raw.match(/<title>Lampiran Riksa Uji\s*(?:—|&mdash;)\s*([^<]+?)\s*(?:—|&mdash;)\s*([^<]+?)<\/title>/);
      if (m) {
        fallbackJenis   = m[1].trim();
        fallbackCompany = m[2].trim();
      }
    } catch (_) {}
  }

  const pdfRel  = pdfFile  ? `${safeSerie}/${sessionTs}/${pdfFile}`  : null;
  const docxRel = docxFile ? `${safeSerie}/${sessionTs}/${docxFile}` : null;
  const tsNum   = parseInt(sessionTs, 10);
  const savedAt = (meta && meta.savedAt)
    || (!isNaN(tsNum) ? new Date(tsNum).toISOString() : fs.statSync(sessionDir).mtime.toISOString());

  return {
    serverKey:      `${safeSerie}/${sessionTs}`,
    safeSerie,
    sessionTs:      String(sessionTs),
    namaPerusahaan: (meta && meta.namaPerusahaan) || fallbackCompany,
    jenisObjek:     (meta && meta.jenisObjek)     || fallbackJenis,
    noSerie:        (meta && meta.noSerie)        || safeSerie,
    bloksCount:     (meta && typeof meta.bloksCount === 'number') ? meta.bloksCount : blokDirs.length,
    savedAt,
    pdfUrl:         pdfRel  ? `${baseUrl}/uploads/${pdfRel}`  : null,
    docxUrl:        docxRel ? `${baseUrl}/uploads/${docxRel}` : null,
    hasMeta:        Boolean(meta)
  };
}

app.post('/api/sync', requireAccessKey, async (req, res) => {
  const { records } = req.body;

  // Validasi payload
  if (!records || !Array.isArray(records) || records.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Payload tidak valid. Field "records" (array) wajib diisi dan tidak boleh kosong.'
    });
  }

  const results = [];
  const errors  = [];
  const baseUrl = getBaseUrl(req);
  const batchTs = Date.now(); // Timestamp dasar sesi sinkronisasi ini

  for (let rIdx = 0; rIdx < records.length; rIdx++) {
    const record    = records[rIdx];
    const sessionTs = batchTs + rIdx;
    try {
      // Validasi field wajib per record
      if (!record.noSerie || !record.namaPerusahaan) {
        throw new Error('Field noSerie dan namaPerusahaan wajib diisi.');
      }

      const safeSerie  = sanitizePath(record.noSerie);
      const recordDir  = path.join(UPLOADS, safeSerie, String(sessionTs));

      const processedBlocks = [];

      // Proses setiap blok dokumentasi
      for (let bIdx = 0; bIdx < (record.blokDokumentasi || []).length; bIdx++) {
        const blok = record.blokDokumentasi[bIdx];
        const blokDir         = path.join(recordDir, `blok_${bIdx + 1}`);
        const savedImagePaths = []; // Relative URL paths

        // Simpan setiap foto dalam blok
        for (let sIdx = 0; sIdx < (blok.slots || []).length; sIdx++) {
          const slot = blok.slots[sIdx];
          if (slot.foto && slot.foto.startsWith('data:image')) {
            const filename = `foto_${sIdx + 1}.jpg`;
            const savedImg = await saveBase64Image(slot.foto, blokDir, filename);

            if (savedImg && savedImg.filePath) {
              // Buat relative path dari folder uploads/
              const relPath = path
                .join(safeSerie, String(sessionTs), `blok_${bIdx + 1}`, filename)
                .replace(/\\/g, '/'); // Normalisasi separator untuk URL
              savedImagePaths.push({
                relPath,
                width: savedImg.width,
                height: savedImg.height
              });
            } else {
              savedImagePaths.push(null);
            }
          } else {
            savedImagePaths.push(null); // Slot tanpa foto
          }
        }

        // Generate Base-6 Grid HTML untuk blok ini
        const htmlGrid = generateBase6Grid(blok, savedImagePaths, baseUrl);

        processedBlocks.push({
          blokNumber:  bIdx + 1,
          judul:       blok.judul,
          layout:      blok.layout,
          colspan:     COLSPAN_MAP[blok.layout] || 6,
          imagePaths:  savedImagePaths,
          htmlGrid
        });
      }

      // Gabungkan semua blok menjadi baris-baris dalam SATU tabel utuh
      const allRows     = processedBlocks.map(b => b.htmlGrid).join('\n');
      const fullHtmlDoc = buildFullHtmlDoc(record, allRows);

      fs.mkdirSync(recordDir, { recursive: true });
      fs.writeFileSync(path.join(recordDir, 'laporan_source.html'), fullHtmlDoc, 'utf8');

      // ── Generate PDF ──
      let pdfUrl   = null;
      let pdfPath  = null;
      const pdfFilename  = `laporan_${safeSerie}_${sessionTs}.pdf`;
      const pdfAbsPath   = path.join(recordDir, pdfFilename);
      
      try {
        await generatePDF(fullHtmlDoc, pdfAbsPath);
        const pdfRel = path.join(safeSerie, String(sessionTs), pdfFilename).replace(/\\/g, '/');
        pdfUrl  = `${baseUrl}/uploads/${pdfRel}`;
        pdfPath = pdfRel;
        console.log(`[PDF] ✓ ${pdfFilename}`);
      } catch (genErr) {
        console.warn(`[PDF] ✗ Generation failed for record ${rIdx + 1}:`, genErr.message);
      }

      // ── Generate Word (Docx) ──
      let docxUrl  = null;
      let docxPath = null;
      const docxFilename = `laporan_${safeSerie}_${sessionTs}.docx`;
      const docxAbsPath  = path.join(recordDir, docxFilename);
      
      try {
        await generateDocx(fullHtmlDoc, docxAbsPath);
        const docxRel = path.join(safeSerie, String(sessionTs), docxFilename).replace(/\\/g, '/');
        docxUrl  = `${baseUrl}/uploads/${docxRel}`;
        docxPath = docxRel;
        console.log(`[DOCX] ✓ ${docxFilename}`);
      } catch (genErr) {
        console.warn(`[DOCX] ✗ Generation failed for record ${rIdx + 1}:`, genErr.message);
      }

      const savedAtIso = new Date().toISOString();

      // Simpan metadata ringan untuk Arsip Server lintas perangkat (PC / HP lain)
      const metaObj = {
        safeSerie,
        sessionTs:      String(sessionTs),
        clientId:       record.id,
        namaPerusahaan: record.namaPerusahaan || '',
        jenisObjek:     record.jenisObjek || '',
        noSerie:        record.noSerie || safeSerie,
        createdAt:      record.createdAt || savedAtIso,
        savedAt:        savedAtIso,
        bloksCount:     processedBlocks.length,
        pdfRel:         pdfPath,
        docxRel:        docxPath,
        bloks:          (record.blokDokumentasi || []).map((b, bIdx) => ({
          blokNumber: bIdx + 1,
          judul:      b.judul || '',
          layout:     b.layout || '1col',
          slots:      (b.slots || []).map((s, sIdx) => {
            const imgInfo = processedBlocks[bIdx] && processedBlocks[bIdx].imagePaths
              ? processedBlocks[bIdx].imagePaths[sIdx]
              : null;
            return {
              keterangan:   s.keterangan || '',
              imageRelPath: imgInfo ? imgInfo.relPath : null,
              width:        imgInfo ? imgInfo.width : 0,
              height:       imgInfo ? imgInfo.height : 0
            };
          })
        }))
      };
      fs.writeFileSync(path.join(recordDir, 'meta.json'), JSON.stringify(metaObj, null, 2), 'utf8');

      results.push({
        clientId:       record.id,
        serverKey:      `${safeSerie}/${sessionTs}`,
        safeSerie,
        sessionTs:      String(sessionTs),
        noSerie:        record.noSerie,
        namaPerusahaan: record.namaPerusahaan,
        jenisObjek:     record.jenisObjek,
        bloksProcessed: processedBlocks.length,
        processedBlocks,
        fullHtmlDoc,
        pdfUrl,    // URL download PDF (null jika generasi gagal)
        pdfPath,
        docxUrl,
        docxPath,
        savedAt: savedAtIso
      });

      console.log(`[Sync] ✓ Record ${rIdx + 1}: ${record.noSerie} — ${processedBlocks.length} blok, PDF: ${pdfUrl ? 'OK' : 'SKIP'}.`);

    } catch (err) {
      console.error(`[Sync] ✗ Record ${rIdx + 1}:`, err.message);
      errors.push({
        index: rIdx,
        id:    record.id,
        error: err.message
      });
    }
  } // end for

  res.json({
    success:   true,
    message:   `Berhasil memproses ${results.length} laporan${errors.length ? `, ${errors.length} gagal` : ''}.`,
    processed: results.length,
    failed:    errors.length,
    results,
    errors:    errors.length > 0 ? errors : undefined,
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /api/server-records
 * Mengambil seluruh daftar arsip laporan yang sudah tersinkron di server
 * agar bisa dilihat & diunduh dari perangkat lain (mis. PC Kantor / Admin).
 */
app.get('/api/server-records', requireAccessKey, (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    if (!fs.existsSync(UPLOADS)) {
      return res.json({ success: true, count: 0, records: [] });
    }

    const list = [];
    const serieDirs = fs.readdirSync(UPLOADS).filter((d) => {
      const full = path.join(UPLOADS, d);
      return fs.existsSync(full) && fs.statSync(full).isDirectory();
    });

    for (const safeSerie of serieDirs) {
      const seriePath = path.join(UPLOADS, safeSerie);
      const sessionDirs = fs.readdirSync(seriePath).filter((s) => {
        const full = path.join(seriePath, s);
        return /^\d+$/.test(s) && fs.existsSync(full) && fs.statSync(full).isDirectory();
      });

      for (const sessionTs of sessionDirs) {
        const summary = readServerSessionSummary(safeSerie, sessionTs, baseUrl);
        if (summary) list.push(summary);
      }
    }

    list.sort((a, b) => Number(b.sessionTs) - Number(a.sessionTs));
    res.json({ success: true, count: list.length, records: list });
  } catch (err) {
    console.error('[ServerRecords] List error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/server-records/:safeSerie/:sessionTs/detail
 * Memuat isi lengkap laporan dari server (termasuk foto & keterangan)
 * agar bisa dibuka / disunting ulang dari PC maupun perangkat lain.
 */
app.get('/api/server-records/:safeSerie/:sessionTs/detail', requireAccessKey, (req, res) => {
  const resolved = resolveSafeSessionDir(req.params.safeSerie, req.params.sessionTs);
  if (!resolved || !fs.existsSync(resolved.sessionDir)) {
    return res.status(404).json({ success: false, message: 'Arsip laporan tidak ditemukan di server.' });
  }

  try {
    const { safeSerie, sessionTs, sessionDir } = resolved;
    const baseUrl  = getBaseUrl(req);
    const summary  = readServerSessionSummary(safeSerie, sessionTs, baseUrl);
    const metaPath = path.join(sessionDir, 'meta.json');

    let blokDokumentasi = [];
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      blokDokumentasi = (meta.bloks || []).map((b) => ({
        judul:  b.judul || '',
        layout: b.layout || '1col',
        slots:  (b.slots || []).map((s) => {
          let foto = null;
          if (s.imageRelPath) {
            const imgAbs = path.join(UPLOADS, s.imageRelPath);
            if (fs.existsSync(imgAbs)) {
              foto = `data:image/jpeg;base64,${fs.readFileSync(imgAbs).toString('base64')}`;
            }
          }
          return { foto, keterangan: s.keterangan || '' };
        })
      }));
    } else {
      // Fallback untuk arsip lama sebelum ada meta.json
      const blokDirs = fs.readdirSync(sessionDir)
        .filter(f => /^blok_\d+$/i.test(f) && fs.statSync(path.join(sessionDir, f)).isDirectory())
        .sort((a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10));

      blokDokumentasi = blokDirs.map((bDir, idx) => {
        const bPath = path.join(sessionDir, bDir);
        const imgs  = fs.readdirSync(bPath).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
        const layout = imgs.length >= 3 ? '3col' : imgs.length === 2 ? '2col' : '1col';
        const slotTotal = layout === '3col' ? 3 : layout === '2col' ? 2 : 1;
        const slots = [];
        for (let i = 0; i < slotTotal; i++) {
          let foto = null;
          if (imgs[i]) {
            const imgAbs = path.join(bPath, imgs[i]);
            foto = `data:image/jpeg;base64,${fs.readFileSync(imgAbs).toString('base64')}`;
          }
          slots.push({ foto, keterangan: '' });
        }
        return { judul: `Pemeriksaan ${idx + 1}`, layout, slots };
      });
    }

    res.json({
      success: true,
      record: {
        serverKey:       `${safeSerie}/${sessionTs}`,
        namaPerusahaan:  summary ? summary.namaPerusahaan : '',
        jenisObjek:      summary ? summary.jenisObjek : 'Pesawat Angkat & Angkut',
        noSerie:         summary ? summary.noSerie : safeSerie,
        status:          'synced',
        createdAt:       summary ? summary.savedAt : new Date().toISOString(),
        blokDokumentasi
      }
    });
  } catch (err) {
    console.error('[ServerRecords] Detail error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/server-records/:safeSerie/:sessionTs/regenerate
 * Membuat ulang file PDF & Word langsung di server tanpa perlu upload ulang dari HP.
 */
app.post('/api/server-records/:safeSerie/:sessionTs/regenerate', requireAccessKey, async (req, res) => {
  const resolved = resolveSafeSessionDir(req.params.safeSerie, req.params.sessionTs);
  if (!resolved || !fs.existsSync(resolved.sessionDir)) {
    return res.status(404).json({ success: false, message: 'Arsip laporan tidak ditemukan di server.' });
  }

  try {
    const { safeSerie, sessionTs, sessionDir } = resolved;
    const baseUrl    = getBaseUrl(req);
    const sourcePath = path.join(sessionDir, 'laporan_source.html');
    const metaPath   = path.join(sessionDir, 'meta.json');

    let fullHtmlDoc = null;
    let meta        = null;

    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
    }

    if (fs.existsSync(sourcePath)) {
      fullHtmlDoc = fs.readFileSync(sourcePath, 'utf8');
    } else if (meta && Array.isArray(meta.bloks)) {
      const rows = meta.bloks.map((b) => {
        const imagePaths = (b.slots || []).map(s =>
          s.imageRelPath ? { relPath: s.imageRelPath, width: s.width || 0, height: s.height || 0 } : null
        );
        return generateBase6Grid(b, imagePaths, baseUrl);
      }).join('\n');
      fullHtmlDoc = buildFullHtmlDoc(meta, rows);
      fs.writeFileSync(sourcePath, fullHtmlDoc, 'utf8');
    } else {
      const summary = readServerSessionSummary(safeSerie, sessionTs, baseUrl) || {
        namaPerusahaan: `Laporan (SN: ${safeSerie})`,
        jenisObjek:     'Dokumentasi Riksa Uji',
        noSerie:        safeSerie
      };
      const blokDirs = fs.readdirSync(sessionDir)
        .filter(f => /^blok_\d+$/i.test(f) && fs.statSync(path.join(sessionDir, f)).isDirectory())
        .sort((a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10));

      const rows = blokDirs.map((bDir, idx) => {
        const bPath = path.join(sessionDir, bDir);
        const imgs  = fs.readdirSync(bPath).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
        const layout = imgs.length >= 3 ? '3col' : imgs.length === 2 ? '2col' : '1col';
        const rels   = imgs.map(f => `${safeSerie}/${sessionTs}/${bDir}/${f}`);
        const blok   = {
          judul:  `Pemeriksaan ${idx + 1}`,
          layout,
          slots:  rels.map(() => ({ keterangan: '' }))
        };
        return generateBase6Grid(blok, rels, baseUrl);
      }).join('\n');
      fullHtmlDoc = buildFullHtmlDoc(summary, rows);
    }

    const pdfFilename  = `laporan_${safeSerie}_${sessionTs}.pdf`;
    const pdfAbsPath   = path.join(sessionDir, pdfFilename);
    const docxFilename = `laporan_${safeSerie}_${sessionTs}.docx`;
    const docxAbsPath  = path.join(sessionDir, docxFilename);

    let pdfError  = null;
    let docxError = null;

    try {
      await generatePDF(fullHtmlDoc, pdfAbsPath);
    } catch (e) {
      pdfError = e.message;
      console.warn('[Regenerate PDF] Failed:', e.message);
    }

    try {
      await generateDocx(fullHtmlDoc, docxAbsPath);
    } catch (e) {
      docxError = e.message;
      console.warn('[Regenerate DOCX] Failed:', e.message);
    }

    if (meta) {
      if (!pdfError)  meta.pdfRel  = `${safeSerie}/${sessionTs}/${pdfFilename}`;
      if (!docxError) meta.docxRel = `${safeSerie}/${sessionTs}/${docxFilename}`;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    }

    const updated = readServerSessionSummary(safeSerie, sessionTs, baseUrl);
    res.json({
      success:   !pdfError || !docxError,
      record:    updated,
      pdfError,
      docxError
    });
  } catch (err) {
    console.error('[ServerRecords] Regenerate error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/server-records/:safeSerie/:sessionTs/delete
 * Menghapus satu arsip laporan beserta foto, PDF, dan Word dari server.
 */
app.post('/api/server-records/:safeSerie/:sessionTs/delete', requireAccessKey, (req, res) => {
  const resolved = resolveSafeSessionDir(req.params.safeSerie, req.params.sessionTs);
  if (!resolved || !fs.existsSync(resolved.sessionDir)) {
    return res.status(404).json({ success: false, message: 'Arsip laporan tidak ditemukan di server.' });
  }

  try {
    fs.rmSync(resolved.sessionDir, { recursive: true, force: true });
    const serieDir = path.join(UPLOADS, resolved.safeSerie);
    if (fs.existsSync(serieDir) && fs.readdirSync(serieDir).length === 0) {
      fs.rmdirSync(serieDir);
    }
    res.json({ success: true, message: 'Arsip berhasil dihapus dari server.' });
  } catch (err) {
    console.error('[ServerRecords] Delete error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/records/:noSerie
 * Daftar semua sesi sinkronisasi untuk No. Seri tertentu.
 * Berguna untuk debugging dan review.
 */
app.get('/api/records/:noSerie', requireAccessKey, (req, res) => {
  const safeSerie  = sanitizePath(req.params.noSerie);
  const recordPath = path.join(UPLOADS, safeSerie);

  if (!fs.existsSync(recordPath)) {
    return res.status(404).json({
      success: false,
      message: `Tidak ada data untuk No. Seri: ${safeSerie}`
    });
  }

  try {
    const sessions = fs.readdirSync(recordPath)
      .filter(name => fs.statSync(path.join(recordPath, name)).isDirectory())
      .map(sessionDir => {
        const sessionPath = path.join(recordPath, sessionDir);
        const bloks = fs.readdirSync(sessionPath)
          .filter(name => fs.statSync(path.join(sessionPath, name)).isDirectory())
          .map(blokDir => {
            const blokPath = path.join(sessionPath, blokDir);
            const files    = fs.readdirSync(blokPath);
            return { blok: blokDir, files };
          });
        return {
          sessionTimestamp: sessionDir,
          sessionDate: new Date(parseInt(sessionDir)).toLocaleString('id-ID'),
          bloks
        };
      })
      .sort((a, b) => parseInt(b.sessionTimestamp) - parseInt(a.sessionTimestamp));

    res.json({ success: true, noSerie: safeSerie, sessions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/html/:noSerie/:sessionTs/:blokNum
 * (Opsional) Ambil HTML grid untuk satu blok spesifik.
 * Berguna jika ingin regenerate HTML tanpa re-upload.
 */
app.get('/api/html/:noSerie/:sessionTs/:blokNum', requireAccessKey, (req, res) => {
  const { noSerie, sessionTs, blokNum } = req.params;
  const safeSerie = sanitizePath(noSerie);
  const blokDir   = path.join(UPLOADS, safeSerie, sessionTs, `blok_${blokNum}`);

  if (!fs.existsSync(blokDir)) {
    return res.status(404).json({ success: false, message: 'Blok tidak ditemukan.' });
  }

  const files  = fs.readdirSync(blokDir);
  const imgs   = files.filter(f => /\.(jpg|jpeg|png)$/i.test(f));
  const baseUrl = getBaseUrl(req);

  const relativePaths = imgs.map(f =>
    path.join(safeSerie, sessionTs, `blok_${blokNum}`, f).replace(/\\/g, '/')
  );

  // Rekonstruksi blok dengan data minimal (layout harus diinfer dari jumlah foto)
  const slotCount = relativePaths.length;
  const layout = slotCount === 1 ? '1col' : slotCount === 2 ? '2col' : '3col';
  const blok = {
    judul: `Blok ${blokNum}`,
    layout,
    slots: relativePaths.map((_, i) => ({ foto: null, keterangan: '' }))
  };

  const html = generateBase6Grid(blok, relativePaths, baseUrl);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// SPA Fallback: semua route non-API dan non-file dikembalikan ke index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ════════════════════════════════════════════════════════════
// STARTUP
// ════════════════════════════════════════════════════════════

// Pastikan folder uploads ada saat server start
fs.mkdirSync(UPLOADS, { recursive: true });
console.log(`[Server] Uploads dir: ${UPLOADS}`);

const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  const authLabel = ACCESS_KEY ? 'AKTIF (Secret Link/Key)' : 'TERBUKA (Dev Mode)';
  console.log(`
╔══════════════════════════════════════════════════════╗
║     Riksa Uji PJK3 — Backend API Server             ║
╠══════════════════════════════════════════════════════╣
║  🚀  Buka di browser : http://localhost:${PORT}          ║
║  📡  API Sync        : POST /api/sync                ║
║  🔒  Proteksi Akses  : ${authLabel.padEnd(28)}  ║
║  📁  Folder uploads  : ./uploads/                    ║
║  🌐  Mode            : ${(process.env.NODE_ENV || 'development').padEnd(12)}                  ║
╚══════════════════════════════════════════════════════╝
  `);
});

async function gracefulShutdown(signal) {
  console.log(`\n[Server] Menerima ${signal}, menutup Puppeteer & HTTP server...`);
  if (_browser) {
    try { await _browser.close(); } catch (_) {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = app;
