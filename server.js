// server.js — Backend Node.js / Express untuk Riksa Uji PJK3
// Tugas: Menerima payload dari PWA, menyimpan gambar, menyusun Base-6 Grid, & generate PDF
'use strict';

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const puppeteer  = require('puppeteer');

const app        = express();
const PORT       = process.env.PORT || 3000;
const UPLOADS    = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ════════════════════════════════════════════════════════════
// MIDDLEWARE
// ════════════════════════════════════════════════════════════

app.use(cors({
  origin:         process.env.ALLOWED_ORIGIN || '*',
  methods:        ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Accept']
}));

// Limit payload 50MB untuk menampung banyak gambar Base64
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve PWA static files dari /public
app.use(express.static(PUBLIC_DIR));

// Expose folder gambar yang tersimpan
app.use('/uploads', express.static(UPLOADS));

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
function saveBase64Image(base64Str, dirPath, filename) {
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
    fs.writeFileSync(filePath, buffer);

    return filePath;
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

  // Setiap blok dibungkus <tbody> dengan break-inside:avoid
  // agar judul dan foto tidak terpisah di page break PDF
  let rows = `
  <tbody style="break-inside:avoid; page-break-inside:avoid;">
    <tr>
      <td colspan="6"
          style="padding:10px 14px; background-color:#1E3A5F; color:#FFFFFF;
                 font-weight:bold; font-size:13px; letter-spacing:0.02em;
                 border:1px solid #CBD5E1;">
        ${title}
      </td>
    </tr>
    <tr>`;

  (blok.slots || []).forEach((slot, idx) => {
    const relPath = imagePaths[idx];
    const imgSrc  = relPath ? `${baseUrl}/uploads/${relPath}` : null;
    const ket     = esc(slot.keterangan || '\u2014');

    rows += `
      <td colspan="${colspan}"
          style="padding:10px; border:1px solid #CBD5E1; vertical-align:top;
                 text-align:center; width:${Math.round(100 / (6 / colspan))}%;">
        ${imgSrc
          ? `<img src="${imgSrc}"
                 style="max-width:100%; height:auto; display:block; margin:0 auto 8px;
                        border:1px solid #E2E8F0; border-radius:4px;" alt="Foto">`
          : `<div style="width:100%; height:80px; background:#F0F4F8;
                         border:2px dashed #CBD5E1; border-radius:4px;
                         display:flex; align-items:center; justify-content:center;
                         margin-bottom:8px; color:#94A3B8; font-size:11px;">
               Tidak ada foto
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
  </tbody>`;

  return rows;
}

// ════════════════════════════════════════════════════════════
// PDF GENERATION VIA PUPPETEER
// ════════════════════════════════════════════════════════════

// Singleton browser instance — dibuka sekali, dipakai berkali-kali
let _browser = null;

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: true,   // v24+ gunakan boolean true (bukan 'new')
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
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

// ════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════

/**
 * GET /api/health
 * Health check endpoint untuk monitoring
 */
app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    app:       'Riksa Uji PJK3 API',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
    uptime:    process.uptime()
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
app.post('/api/sync', async (req, res) => {
  const { records } = req.body;

  // Validasi payload
  if (!records || !Array.isArray(records) || records.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Payload tidak valid. Field "records" (array) wajib diisi dan tidak boleh kosong.'
    });
  }

  const results   = [];
  const errors    = [];
  const baseUrl   = `${req.protocol}://${req.get('host')}`;
  const sessionTs = Date.now(); // Timestamp sesi sinkronisasi ini

  for (let rIdx = 0; rIdx < records.length; rIdx++) {
    const record = records[rIdx];
    try {
      // Validasi field wajib per record
      if (!record.noSerie || !record.namaPerusahaan) {
        throw new Error('Field noSerie dan namaPerusahaan wajib diisi.');
      }

      const safeSerie  = sanitizePath(record.noSerie);
      const recordDir  = path.join(UPLOADS, safeSerie, String(sessionTs));

      const processedBlocks = [];

      // Proses setiap blok dokumentasi
      (record.blokDokumentasi || []).forEach((blok, bIdx) => {
        const blokDir         = path.join(recordDir, `blok_${bIdx + 1}`);
        const savedImagePaths = []; // Relative URL paths

        // Simpan setiap foto dalam blok
        (blok.slots || []).forEach((slot, sIdx) => {
          if (slot.foto && slot.foto.startsWith('data:image')) {
            const filename = `foto_${sIdx + 1}.jpg`;
            const absPath  = saveBase64Image(slot.foto, blokDir, filename);

            if (absPath) {
              // Buat relative path dari folder uploads/
              const relPath = path
                .join(safeSerie, String(sessionTs), `blok_${bIdx + 1}`, filename)
                .replace(/\\/g, '/'); // Normalisasi separator untuk URL
              savedImagePaths.push(relPath);
            } else {
              savedImagePaths.push(null);
            }
          } else {
            savedImagePaths.push(null); // Slot tanpa foto
          }
        });

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
      });

      // Susun dokumen HTML lengkap untuk seluruh record ini
      const createdDate = record.createdAt
        ? new Date(record.createdAt).toLocaleDateString('id-ID', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
          })
        : 'Tanggal tidak diketahui';

      // Gabungkan semua blok menjadi baris-baris dalam SATU tabel utuh
      const allRows = processedBlocks.map(b => b.htmlGrid).join('\n');

      const fullHtmlDoc = `
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
  <table style="width:auto; margin-bottom:20px; border:none;">
    <tr>
      <td style="width:155px; padding:2px 0; vertical-align:top;">Nama Perusahaan</td>
      <td style="padding:2px 10px; vertical-align:top;">:</td>
      <td style="padding:2px 0; vertical-align:top;">${esc(record.namaPerusahaan)}</td>
    </tr>
    <tr>
      <td style="padding:2px 0; vertical-align:top;">Jenis Objek K3</td>
      <td style="padding:2px 10px; vertical-align:top;">:</td>
      <td style="padding:2px 0; vertical-align:top;">${esc(record.jenisObjek)}</td>
    </tr>
    <tr>
      <td style="padding:2px 0; vertical-align:top;">No. Serie</td>
      <td style="padding:2px 10px; vertical-align:top;">:</td>
      <td style="padding:2px 0; vertical-align:top;">${esc(record.noSerie)}</td>
    </tr>
  </table>

  <!-- TABEL DOKUMENTASI (SATU TABEL UTUH) -->
  <table border="1" cellspacing="0" cellpadding="0"
         style="width:100%; border-collapse:collapse;
                font-family:Arial,Helvetica,sans-serif;
                border:1px solid #CBD5E1;">
    ${allRows}
  </table>

</body>
</html>`;

      // ── Generate PDF menggunakan Puppeteer ──
      let pdfUrl  = null;
      let pdfPath = null;
      try {
        const pdfFilename = `laporan_${safeSerie}_${sessionTs}.pdf`;
        const pdfAbsPath  = path.join(recordDir, pdfFilename);
        fs.mkdirSync(recordDir, { recursive: true });
        await generatePDF(fullHtmlDoc, pdfAbsPath);
        const pdfRel = path.join(safeSerie, String(sessionTs), pdfFilename).replace(/\\/g, '/');
        pdfUrl  = `${baseUrl}/uploads/${pdfRel}`;
        pdfPath = pdfRel;
        console.log(`[PDF] ✓ ${pdfFilename}`);
      } catch (pdfErr) {
        console.warn(`[PDF] ✗ Generation failed for record ${rIdx + 1}:`, pdfErr.message);
      }

      results.push({
        clientId:       record.id,
        noSerie:        record.noSerie,
        namaPerusahaan: record.namaPerusahaan,
        jenisObjek:     record.jenisObjek,
        bloksProcessed: processedBlocks.length,
        processedBlocks,
        fullHtmlDoc,
        pdfUrl,    // URL download PDF (null jika generasi gagal)
        pdfPath,
        savedAt: new Date().toISOString()
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
 * GET /api/records/:noSerie
 * Daftar semua sesi sinkronisasi untuk No. Seri tertentu.
 * Berguna untuk debugging dan review.
 */
app.get('/api/records/:noSerie', (req, res) => {
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
app.get('/api/html/:noSerie/:sessionTs/:blokNum', (req, res) => {
  const { noSerie, sessionTs, blokNum } = req.params;
  const safeSerie = sanitizePath(noSerie);
  const blokDir   = path.join(UPLOADS, safeSerie, sessionTs, `blok_${blokNum}`);

  if (!fs.existsSync(blokDir)) {
    return res.status(404).json({ success: false, message: 'Blok tidak ditemukan.' });
  }

  const files  = fs.readdirSync(blokDir);
  const imgs   = files.filter(f => /\.(jpg|jpeg|png)$/i.test(f));
  const baseUrl = `${req.protocol}://${req.get('host')}`;

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

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║     Riksa Uji PJK3 — Backend API Server             ║
╠══════════════════════════════════════════════════════╣
║  🚀  Buka di browser : http://localhost:${PORT}          ║
║  📡  API Sync        : POST /api/sync                ║
║  📁  Folder uploads  : ./uploads/                    ║
║  🌐  Mode            : ${(process.env.NODE_ENV || 'development').padEnd(12)}                  ║
╚══════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
