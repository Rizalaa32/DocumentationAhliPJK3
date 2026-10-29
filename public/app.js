// app.js — Logika PWA Riksa Uji PJK3
// Mencakup: IndexedDB, Kompresi Canvas, Dynamic Block Builder, Access Key Gate, Sync
'use strict';

// ════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════
const DB_NAME               = 'riksauji_db';
const DB_VERSION            = 1;
const STORE_NAME            = 'laporan';
const API_ENDPOINT          = '/api/sync';
const AUTH_ENDPOINT         = '/api/auth';
const ACCESS_KEY_STORAGE    = 'riksauji_access_key';
const AUTH_VERIFIED_STORAGE = 'riksauji_auth_ok';
const MAX_IMAGE_DIM         = 1600;  // px — dimensi HD agar teks nameplate/alat ukur tajam di PDF & Word
const JPEG_QUALITY          = 0.88;  // 0–1, kualitas JPEG tinggi namun tetap hemat memori & kuota sync

const SLOT_LABELS = {
  '1col': ['Foto'],
  '2col': ['Kiri', 'Kanan'],
  '3col': ['Atas', 'Tengah', 'Bawah']
};

const SLOT_COUNTS = { '1col': 1, '2col': 2, '3col': 3 };

// ════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════
let db             = null;   // IndexedDB instance
let blockCounter   = 0;      // Penomoran blok dokumentasi
let isSyncing      = false;  // Guard flag untuk sync
let swRegistration = null;   // Service Worker registration
let editingId      = null;   // Menyimpan ID record yang sedang diedit

// ════════════════════════════════════════════════════════════
// ACCESS CONTROL (Secret Link ?key=... & Kode Akses Lokal)
// ════════════════════════════════════════════════════════════

/**
 * Mengekstrak kode akses baik dari input kode langsung maupun URL utuh (?key=...).
 * Memudahkan anggota tim jika menyalin seluruh link WhatsApp ke kolom input.
 * @param {string} rawInput
 * @returns {string}
 */
function extractAccessKey(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return '';
  if (trimmed.includes('?key=') || trimmed.includes('&key=') || /^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed, window.location.origin);
      const fromParam = parsed.searchParams.get('key');
      if (fromParam) return fromParam.trim();
    } catch (_) {}
  }
  return trimmed;
}

function getStoredAccessKey() {
  try {
    return localStorage.getItem(ACCESS_KEY_STORAGE) || '';
  } catch (_) {
    return '';
  }
}

function showAuthOverlay(errorMsg = '') {
  const overlay = document.getElementById('auth-overlay');
  const errEl   = document.getElementById('auth-error');
  if (!overlay) return;

  if (errEl) {
    if (errorMsg) {
      errEl.textContent = errorMsg;
      errEl.classList.remove('hidden');
    } else {
      errEl.textContent = '';
      errEl.classList.add('hidden');
    }
  }
  overlay.classList.remove('hidden');
}

function hideAuthOverlay() {
  const overlay = document.getElementById('auth-overlay');
  const errEl   = document.getElementById('auth-error');
  if (overlay) overlay.classList.add('hidden');
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
}

/**
 * Memeriksa status akses saat aplikasi dibuka:
 * 1. Jika dibuka melalui tautan khusus (?key=...), simpan kunci ke localStorage & bersihkan URL.
 * 2. Jika sedang offline, jangan pernah memblokir pemakaian form lapangan.
 * 3. Jika sedang online, verifikasi ke /api/auth sekaligus memperbarui cookie unduhan /uploads.
 */
async function initAccessControl() {
  let cameFromLink = false;

  try {
    const params = new URLSearchParams(window.location.search);
    const urlKey = params.get('key');
    if (urlKey && urlKey.trim()) {
      localStorage.setItem(ACCESS_KEY_STORAGE, urlKey.trim());
      cameFromLink = true;
      // Bersihkan ?key=... dari address bar agar aman dan rapi saat di-install sebagai PWA
      params.delete('key');
      const restQuery = params.toString();
      const cleanUrl  = window.location.pathname + (restQuery ? `?${restQuery}` : '') + window.location.hash;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  } catch (e) {
    console.warn('[Auth] URL param check failed:', e);
  }

  // Saat offline di lapangan, biarkan aplikasi langsung berjalan penuh
  if (!navigator.onLine) {
    hideAuthOverlay();
    return;
  }

  const savedKey = getStoredAccessKey();
  try {
    const headers = { 'Accept': 'application/json' };
    if (savedKey) headers['X-Access-Key'] = savedKey;

    const res = await fetch(AUTH_ENDPOINT, {
      method:      'POST',
      credentials: 'same-origin',
      headers
    });

    if (res.ok) {
      try { localStorage.setItem(AUTH_VERIFIED_STORAGE, '1'); } catch (_) {}
      hideAuthOverlay();
      if (cameFromLink) {
        showToast('🔓 Akses tim berhasil diaktifkan di perangkat ini!', 'success');
      }
      return;
    }

    if (res.status === 401) {
      showAuthOverlay(savedKey ? 'Kode Akses berubah atau tidak valid. Silakan masukkan kode terbaru.' : '');
    }
  } catch (err) {
    // Jika sinyal tidak stabil (gagal hubungi server), jangan kunci user di lapangan
    console.warn('[Auth] Offline/unreachable during check, continuing in local mode:', err.message);
    hideAuthOverlay();
  }
}

/**
 * Handler tombol "Buka Aplikasi" pada layar kunci Kode Akses.
 */
async function submitAccessKey() {
  const inputEl = document.getElementById('auth-key-input');
  const btnEl   = document.getElementById('btn-auth-submit');
  if (!inputEl || !btnEl) return;

  const key = extractAccessKey(inputEl.value);
  if (!key) {
    showAuthOverlay('Masukkan Kode Akses atau tempel tautan khusus terlebih dahulu.');
    inputEl.focus();
    return;
  }

  if (!navigator.onLine) {
    // Jika kebetulan sedang offline saat mengisi, simpan dulu untuk dipakai saat online
    try { localStorage.setItem(ACCESS_KEY_STORAGE, key); } catch (_) {}
    hideAuthOverlay();
    showToast('🔑 Kode disimpan secara lokal. Akan diverifikasi saat online.', 'warning');
    return;
  }

  const origHtml = btnEl.innerHTML;
  try {
    btnEl.disabled  = true;
    btnEl.innerHTML = '<div class="spinner"></div> Memeriksa…';

    const res = await fetch(AUTH_ENDPOINT, {
      method:      'POST',
      credentials: 'same-origin',
      headers: {
        'Accept':       'application/json',
        'X-Access-Key': key
      }
    });

    if (res.ok) {
      try {
        localStorage.setItem(ACCESS_KEY_STORAGE, key);
        localStorage.setItem(AUTH_VERIFIED_STORAGE, '1');
      } catch (_) {}
      inputEl.value = '';
      hideAuthOverlay();
      showToast('✅ Akses diterima! Perangkat ini telah terhubung.', 'success');
    } else {
      showAuthOverlay('❌ Kode Akses salah. Periksa kembali tautan dari Admin.');
    }
  } catch (err) {
    showAuthOverlay('Gagal menghubungi server. Periksa koneksi internet Anda.');
  } finally {
    btnEl.disabled  = false;
    btnEl.innerHTML = origHtml;
  }
}

// ════════════════════════════════════════════════════════════
// IndexedDB MANAGER
// ════════════════════════════════════════════════════════════

/**
 * Membuka (dan jika perlu, membuat) database IndexedDB.
 * @returns {Promise<IDBDatabase>}
 */
function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true
        });
        // Index untuk query by status & tanggal
        store.createIndex('status',    'status',    { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        console.log('[DB] Object store "laporan" created.');
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      console.log('[DB] Database opened successfully.');
      resolve(db);
    };

    request.onerror = (event) => {
      console.error('[DB] Open error:', event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Menyimpan satu record laporan baru ke IndexedDB dengan status "pending", atau update jika `existingId` diberikan.
 * @param {Object} data - Data form yang telah dikumpulkan
 * @param {number|null} existingId - ID record jika sedang diedit
 * @returns {Promise<number>} ID record yang baru dibuat/diupdate
 */
function saveLaporan(data, existingId = null) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    if (existingId) {
      const getReq = store.get(existingId);
      getReq.onsuccess = () => {
        const oldRecord = getReq.result || {};
        const record = {
          ...oldRecord,
          ...data,
          status: 'pending', // Set ulang jadi pending agar disinkronkan kembali
          updatedAt: new Date().toISOString()
        };
        const putReq = store.put(record);
        putReq.onsuccess = () => resolve(existingId);
        putReq.onerror   = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    } else {
      const record = {
        ...data,
        status:    'pending',
        createdAt: new Date().toISOString(),
        syncedAt:  null
      };
      const req = store.add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    }
  });
}

/**
 * Mengambil semua record dari IndexedDB.
 * @returns {Promise<Array>}
 */
function getAllLaporan() {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Mengambil semua record dengan status "pending" (belum tersinkronisasi).
 * @returns {Promise<Array>}
 */
function getPendingLaporan() {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('status');
    const req   = index.getAll('pending');
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Menandai satu record sebagai "synced", mengisi syncedAt, dan menyimpan URL PDF & Word.
 * @param {number} id      - Primary key record
 * @param {string|null} pdfUrl - URL download PDF dari server (opsional)
 * @param {string|null} docxUrl - URL download Word dari server (opsional)
 * @returns {Promise<void>}
 */
function markAsSynced(id, pdfUrl = null, docxUrl = null) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);

    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) { resolve(); return; }
      record.status   = 'synced';
      record.syncedAt = new Date().toISOString();
      if (pdfUrl) record.pdfUrl = pdfUrl; // Simpan URL PDF dari server
      if (docxUrl) record.docxUrl = docxUrl; // Simpan URL Word dari server
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve();
      putReq.onerror   = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Menghapus record dari IndexedDB.
 * @param {number} id - Primary key record
 * @returns {Promise<void>}
 */
function deleteLaporan(id) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ════════════════════════════════════════════════════════════
// KOMPRESI GAMBAR VIA CANVAS
// ════════════════════════════════════════════════════════════

/**
 * Mengompresi file gambar menggunakan HTML5 Canvas.
 * - Resize ke maks MAX_IMAGE_DIM px (mempertahankan aspect ratio)
 * - Konversi ke JPEG dengan kualitas JPEG_QUALITY
 * - Return Base64 string dan info ukuran
 *
 * @param {File} file - File gambar dari input[type=file]
 * @returns {Promise<{base64: string, originalKB: number, compressedKB: number, width: number, height: number}>}
 */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('File tidak ditemukan.'));
      return;
    }

    const isKnownExt = /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(file.name || '');
    if (file.type && !file.type.startsWith('image/') && !isKnownExt) {
      reject(new Error('File bukan gambar yang valid.'));
      return;
    }

    const originalKB = (file.size / 1024).toFixed(1);

    const processLoadedImage = (img, cleanupFn) => {
      try {
        let { width, height } = img;

        // Hitung dimensi baru dengan mempertahankan rasio aspek
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const ratio = Math.min(MAX_IMAGE_DIM / width, MAX_IMAGE_DIM / height);
          width  = Math.round(width  * ratio);
          height = Math.round(height * ratio);
        }

        // Gambar ulang ke canvas dengan ukuran yang sudah di-resize (interpolasi tajam)
        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

        // Export ke Base64 JPEG
        const base64       = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        // Estimasi ukuran: Base64 4/3 lebih besar dari binary; kurangi 33% overhead
        const compressedKB = Math.round((base64.length * 0.75) / 1024);

        if (cleanupFn) cleanupFn();
        resolve({ base64, originalKB: parseFloat(originalKB), compressedKB, width, height });
      } catch (err) {
        if (cleanupFn) cleanupFn();
        reject(new Error('Gagal memproses gambar di perangkat.'));
      }
    };

    // Gunakan Object URL terlebih dahulu (jauh lebih hemat RAM di HP dibanding FileReader pada foto 50MP+)
    if (typeof URL !== 'undefined' && URL.createObjectURL) {
      const objectUrl = URL.createObjectURL(file);
      const img       = new Image();
      const cleanup   = () => { try { URL.revokeObjectURL(objectUrl); } catch (_) {} };

      img.onload  = () => processLoadedImage(img, cleanup);
      img.onerror = () => {
        cleanup();
        // Fallback ke FileReader jika Object URL gagal
        const reader = new FileReader();
        reader.onload = (e) => {
          const fallbackImg = new Image();
          fallbackImg.onload  = () => processLoadedImage(fallbackImg, null);
          fallbackImg.onerror = () => reject(new Error('Format foto tidak didukung browser ini (gunakan JPG/PNG).'));
          fallbackImg.src     = e.target.result;
        };
        reader.onerror = () => reject(new Error('Gagal membaca file dari perangkat.'));
        reader.readAsDataURL(file);
      };
      img.src = objectUrl;
      return;
    }

    const reader = new FileReader();
    reader.onload = (readerEvent) => {
      const img = new Image();
      img.onload  = () => processLoadedImage(img, null);
      img.onerror = () => reject(new Error('Gagal memuat gambar. Format tidak didukung.'));
      img.src     = readerEvent.target.result;
    };
    reader.onerror = () => reject(new Error('Gagal membaca file dari perangkat.'));
    reader.readAsDataURL(file);
  });
}

// ════════════════════════════════════════════════════════════
// VALIDASI IDENTITAS
// ════════════════════════════════════════════════════════════
function validateIdentitas() {
  const namaPerusahaan = document.getElementById('nama-perusahaan').value.trim();
  const jenisObjek     = document.getElementById('jenis-objek').value;
  const noSerie        = document.getElementById('no-serie').value.trim();

  const fields = [
    { el: document.getElementById('nama-perusahaan'), val: namaPerusahaan },
    { el: document.getElementById('jenis-objek'),     val: jenisObjek     },
    { el: document.getElementById('no-serie'),        val: noSerie        }
  ];

  let valid = true;
  fields.forEach(({ el, val }) => {
    if (!val) {
      el.classList.add('error');
      el.addEventListener('input',  () => el.classList.remove('error'), { once: true });
      el.addEventListener('change', () => el.classList.remove('error'), { once: true });
      valid = false;
    }
  });

  if (!valid) {
    showToast('⚠️ Lengkapi semua field identitas yang bertanda bintang (*).', 'warning');
    // Scroll ke atas agar user melihat field yang error
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  return valid;
}

// ════════════════════════════════════════════════════════════
// DYNAMIC BLOCK BUILDER
// ════════════════════════════════════════════════════════════

/**
 * Membuat dan menambahkan blok dokumentasi baru ke dalam block-list.
 * Setiap blok memiliki: Judul, Pilihan Layout, dan Slot-slot foto.
 */
function addBlock() {
  blockCounter++;
  const bId  = `blk-${blockCounter}`;
  const wrap = document.createElement('div');
  wrap.className = 'doc-block';
  wrap.id        = bId;
  wrap.setAttribute('data-block-id', blockCounter);

  wrap.innerHTML = `
    <div class="block-header">
      <span class="block-num">Blok ${blockCounter}</span>
      <button class="block-del-btn" onclick="removeBlock('${bId}')"
              aria-label="Hapus blok ${blockCounter}" title="Hapus blok ini">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <div class="block-body">
      <!-- Judul Blok -->
      <div class="form-group">
        <label class="req">Judul Objek Pemeriksaan</label>
        <input type="text" class="block-judul"
               placeholder="Misal: Kondisi Struktur Rangka, Tali Baja, Panel Kontrol…"
               inputmode="text">
      </div>

      <!-- Layout Selector -->
      <div class="form-group">
        <label>Format Layout Kolom Foto</label>
        <div class="layout-selector">

          <div class="layout-opt">
            <input type="radio" name="layout-${bId}" id="l1-${bId}" value="1col" checked
                   onchange="renderSlots('${bId}','1col')">
            <label for="l1-${bId}">
              <div class="layout-icon"><span></span></div>
              1 Kolom<br><span style="font-weight:400;opacity:.7;">(Full)</span>
            </label>
          </div>

          <div class="layout-opt">
            <input type="radio" name="layout-${bId}" id="l2-${bId}" value="2col"
                   onchange="renderSlots('${bId}','2col')">
            <label for="l2-${bId}">
              <div class="layout-icon"><span></span><span></span></div>
              2 Kolom<br><span style="font-weight:400;opacity:.7;">(Kiri-Kanan)</span>
            </label>
          </div>

          <div class="layout-opt">
            <input type="radio" name="layout-${bId}" id="l3-${bId}" value="3col"
                   onchange="renderSlots('${bId}','3col')">
            <label for="l3-${bId}">
              <div class="layout-icon"><span></span><span></span><span></span></div>
              3 Kolom<br><span style="font-weight:400;opacity:.7;">(Atas-Tengah-Bawah)</span>
            </label>
          </div>

        </div>
      </div>

      <!-- Slot Container (default: 1 kolom) -->
      <div class="slots-container layout-1col" id="slots-${bId}">
        ${_buildSlotHTML(bId, 0, 'Foto')}
      </div>
    </div>
  `;

  document.getElementById('block-list').appendChild(wrap);

  // Smooth scroll agar blok baru terlihat
  setTimeout(() => wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
}

/**
 * Mengganti slot-slot dalam blok sesuai layout yang dipilih.
 * @param {string} bId   - ID blok (misalnya "blk-1")
 * @param {string} layout - "1col" | "2col" | "3col"
 */
function renderSlots(bId, layout) {
  const container = document.getElementById(`slots-${bId}`);
  const labels    = SLOT_LABELS[layout] || ['Foto'];
  const count     = SLOT_COUNTS[layout] || 1;

  // Ganti class layout
  container.className = `slots-container layout-${layout}`;

  // Render ulang slot
  let html = '';
  for (let i = 0; i < count; i++) {
    html += _buildSlotHTML(bId, i, labels[i]);
  }
  container.innerHTML = html;
}

/**
 * Menghasilkan HTML string untuk satu slot foto+keterangan.
 * @param {string} bId       - ID blok
 * @param {number} slotIdx   - Indeks slot (0-based)
 * @param {string} label     - Label slot ("Foto", "Kiri", "Atas", dll.)
 * @returns {string} HTML string
 */
function _buildSlotHTML(bId, slotIdx, label) {
  const sId     = `s-${bId}-${slotIdx}`;     // slot wrapper id
  const camId   = `cam-${bId}-${slotIdx}`;   // input khusus kamera belakang
  const galId   = `gal-${bId}-${slotIdx}`;   // input khusus galeri / file picker
  const prevId  = `p-${bId}-${slotIdx}`;     // preview img id
  const holdId  = `h-${bId}-${slotIdx}`;     // placeholder id
  const infoId  = `i-${bId}-${slotIdx}`;     // compression info id
  const clearId = `c-${bId}-${slotIdx}`;     // clear button id

  return `
  <div class="slot-item" id="${sId}" data-base64="">
    <div class="slot-label">${label}</div>

    <!-- Foto Area -->
    <div class="photo-area">
      <!-- Preview (hidden sampai ada foto) -->
      <img class="photo-preview" id="${prevId}"
           alt="Preview foto ${label}" style="object-fit:contain; height:200px; max-height:200px;">

      <!-- Placeholder menggunakan native <label> agar tidak diblokir browser HP -->
      <label class="photo-placeholder" id="${holdId}" for="${galId}">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <span>Ketuk untuk pilih gambar / foto</span>
      </label>

      <!-- Input 1: Khusus Kamera Belakang -->
      <input type="file" class="sr-file-input" id="${camId}" accept="image/*" capture="environment"
             onchange="handleFile('${bId}',${slotIdx},this)">

      <!-- Input 2: Khusus Galeri / File (tanpa atribut capture agar galeri tidak terkunci) -->
      <input type="file" class="sr-file-input" id="${galId}" accept="image/*"
             onchange="handleFile('${bId}',${slotIdx},this)">
    </div>

    <!-- Action Row: Tombol Kamera Live (getUserMedia) & Galeri -->
    <div class="photo-actions" style="margin-top:8px;">
      <button type="button" class="btn-cam" style="min-width:112px;" onclick="openCameraModal('${bId}',${slotIdx})">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="4"/>
        </svg>
        Kamera
      </button>
      <label class="btn-galeri" for="${galId}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        Galeri
      </label>
      <button type="button" class="btn-clear-photo hidden" id="${clearId}"
              onclick="clearPhoto('${bId}',${slotIdx})" title="Hapus foto ini" aria-label="Hapus foto">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <!-- Compression Info -->
    <div class="compress-info" id="${infoId}" aria-live="polite"></div>

    <!-- Keterangan / Hasil Ukur -->
    <div class="form-group" style="margin-top:10px; margin-bottom:0;">
      <textarea class="slot-keterangan"
                placeholder="Keterangan / Hasil Ukur / Temuan / Kondisi…"
                rows="3"></textarea>
    </div>
  </div>`;
}

/**
 * Menghapus blok dokumentasi dengan animasi fade-out.
 * @param {string} bId - ID elemen blok
 */
function removeBlock(bId) {
  const el = document.getElementById(bId);
  if (!el) return;
  el.style.transition = 'opacity 0.2s, transform 0.2s';
  el.style.opacity    = '0';
  el.style.transform  = 'scale(0.96)';
  setTimeout(() => el.remove(), 200);
}

// ════════════════════════════════════════════════════════════
// IN-APP LIVE CAMERA (WebRTC getUserMedia — jalan online & offline)
// ════════════════════════════════════════════════════════════

let _camStream     = null;
let _camTargetBId  = null;
let _camTargetSlot = null;
let _camFacingMode = 'environment'; // 'environment' (belakang) | 'user' (depan)

function _stopCameraStream() {
  if (_camStream) {
    _camStream.getTracks().forEach((t) => {
      try { t.stop(); } catch (_) {}
    });
    _camStream = null;
  }
  const videoEl = document.getElementById('camera-video');
  if (videoEl) videoEl.srcObject = null;
}

async function openCameraModal(bId, slotIdx) {
  _camTargetBId  = bId;
  _camTargetSlot = slotIdx;

  const camInputId = `cam-${bId}-${slotIdx}`;

  // Jika browser sangat lama & tidak mendukung getUserMedia, fallback ke input file capture
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const fallbackInput = document.getElementById(camInputId);
    if (fallbackInput) fallbackInput.click();
    else showToast('Browser ini tidak mendukung akses kamera langsung.', 'warning');
    return;
  }

  const modalEl    = document.getElementById('camera-modal');
  const fallbackLb = document.getElementById('camera-fallback-label');
  if (fallbackLb) {
    fallbackLb.setAttribute('for', camInputId);
    fallbackLb.onclick = () => setTimeout(() => closeCameraModal(), 150);
  }

  modalEl.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  await startCameraStream();
}

async function startCameraStream() {
  _stopCameraStream();

  const videoEl   = document.getElementById('camera-video');
  const msgBox    = document.getElementById('camera-msg');
  const msgText   = document.getElementById('camera-msg-text');
  const shutterEl = document.getElementById('camera-shutter-btn');

  msgBox.classList.remove('hidden');
  msgText.innerHTML = '⏳ Membuka kamera… Jika muncul pop-up izin, ketuk <strong>Izinkan / Allow</strong>.';
  shutterEl.disabled = true;

  const attempts = [
    { audio: false, video: { facingMode: { ideal: _camFacingMode }, width: { ideal: 1920 }, height: { ideal: 1440 } } },
    { audio: false, video: { facingMode: _camFacingMode } },
    { audio: false, video: true }
  ];

  let lastErr = null;
  for (const constraints of attempts) {
    try {
      _camStream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (err) {
      lastErr = err;
      // Jika ditolak izin oleh user/OS, tidak perlu mencoba constraint lain
      if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
        break;
      }
    }
  }

  if (!_camStream) {
    console.warn('[Camera] getUserMedia error:', lastErr);
    if (lastErr && (lastErr.name === 'NotAllowedError' || lastErr.name === 'PermissionDeniedError')) {
      msgText.innerHTML =
        '🔒 <strong>Izin Kamera Diblokir di Browser / HP Anda</strong><br><br>' +
        '1. Ketuk ikon <strong>Pengaturan / Gembok</strong> di sebelah kiri alamat <code>ahlirakana.my.id</code> di atas ➔ <strong>Izin (Permissions)</strong> ➔ aktifkan <strong>Kamera</strong>.<br>' +
        '2. Pastikan aplikasi <strong>Chrome / Safari</strong> sudah diberi izin Kamera di Pengaturan HP Anda.';
    } else if (lastErr && lastErr.name === 'NotFoundError') {
      msgText.innerHTML = '❌ Kamera tidak ditemukan pada perangkat ini.';
    } else {
      msgText.innerHTML = `❌ Gagal mengakses kamera (${lastErr ? lastErr.name : 'Unknown'}). Pastikan kamera tidak sedang dipakai aplikasi lain.`;
    }
    return;
  }

  try {
    videoEl.srcObject = _camStream;
    await videoEl.play();
    msgBox.classList.add('hidden');
    shutterEl.disabled = false;
  } catch (playErr) {
    console.error('[Camera] Video play error:', playErr);
    msgText.textContent = 'Gagal menampilkan pratinjau kamera.';
  }
}

async function retryCameraStream() {
  await startCameraStream();
}

async function switchCameraFacing() {
  _camFacingMode = _camFacingMode === 'environment' ? 'user' : 'environment';
  await startCameraStream();
}

function captureFromCamera() {
  const videoEl = document.getElementById('camera-video');
  if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) {
    showToast('⚠️ Kamera belum siap, tunggu sebentar.', 'warning');
    return;
  }

  const bId     = _camTargetBId;
  const slotIdx = _camTargetSlot;
  if (!bId || slotIdx === null) return;

  let width  = videoEl.videoWidth;
  let height = videoEl.videoHeight;

  if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
    const ratio = Math.min(MAX_IMAGE_DIM / width, MAX_IMAGE_DIM / height);
    width  = Math.round(width  * ratio);
    height = Math.round(height * ratio);
  }

  const canvas = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(videoEl, 0, 0, width, height);

  const base64       = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  const compressedKB = Math.round((base64.length * 0.75) / 1024);

  const slotEl  = document.getElementById(`s-${bId}-${slotIdx}`);
  const prevEl  = document.getElementById(`p-${bId}-${slotIdx}`);
  const holdEl  = document.getElementById(`h-${bId}-${slotIdx}`);
  const infoEl  = document.getElementById(`i-${bId}-${slotIdx}`);
  const clearEl = document.getElementById(`c-${bId}-${slotIdx}`);

  if (slotEl)  slotEl.dataset.base64 = base64;
  if (prevEl)  { prevEl.src = base64; prevEl.classList.add('visible'); }
  if (holdEl)  holdEl.classList.add('hidden');
  if (clearEl) clearEl.classList.remove('hidden');
  if (infoEl) {
    infoEl.style.color = 'var(--success)';
    infoEl.textContent = `✅ Foto kamera tersimpan (${compressedKB} KB | ${width}×${height}px)`;
  }

  closeCameraModal();
}

function closeCameraModal() {
  _stopCameraStream();
  const modalEl = document.getElementById('camera-modal');
  if (modalEl) modalEl.classList.add('hidden');
  if (!document.getElementById('records-drawer')?.classList.contains('open')) {
    document.body.style.overflow = '';
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && _camStream) {
    closeCameraModal();
  }
});

// ════════════════════════════════════════════════════════════
// HANDLE FILE INPUT & KOMPRESI
// ════════════════════════════════════════════════════════════

/**
 * Dipanggil saat user memilih/mengambil foto pada slot tertentu.
 * Melakukan kompresi via Canvas dan memperbarui UI preview.
 *
 * @param {string} bId      - Block ID
 * @param {number} slotIdx  - Slot index
 * @param {HTMLInputElement} input - File input element
 */
async function handleFile(bId, slotIdx, input) {
  const file = input.files[0];
  if (!file) return;

  const slotEl  = document.getElementById(`s-${bId}-${slotIdx}`);
  const prevEl  = document.getElementById(`p-${bId}-${slotIdx}`);
  const holdEl  = document.getElementById(`h-${bId}-${slotIdx}`);
  const infoEl  = document.getElementById(`i-${bId}-${slotIdx}`);
  const clearEl = document.getElementById(`c-${bId}-${slotIdx}`);

  // Loading state
  infoEl.style.color = 'var(--text-muted)';
  infoEl.innerHTML   = '<span style="display:inline-flex;align-items:center;gap:6px;"><span class="spinner dark" style="width:12px;height:12px;border-width:1.5px;"></span> Mengompresi gambar…</span>';

  try {
    const result = await compressImage(file);

    // Simpan base64 ke data attribute slot
    slotEl.dataset.base64 = result.base64;

    // Tampilkan preview, sembunyikan placeholder
    prevEl.src = result.base64;
    prevEl.classList.add('visible');
    holdEl.classList.add('hidden');
    clearEl.classList.remove('hidden');

    // Info kompresi
    const savedPct = Math.max(0, Math.round((1 - result.compressedKB / result.originalKB) * 100));
    infoEl.style.color = 'var(--success)';
    infoEl.textContent =
      `✅ ${result.originalKB} KB → ${result.compressedKB} KB (hemat ${savedPct}%) | ${result.width}×${result.height}px`;

  } catch (err) {
    console.error('[Compress] Error:', err);
    infoEl.style.color  = 'var(--danger)';
    infoEl.textContent  = `❌ Gagal: ${err.message}`;
  } finally {
    // Reset value agar memilih foto yang sama kembali tetap memicu event onchange
    if (input) input.value = '';
  }
}

/**
 * Menghapus foto dari slot dan mereset ke state awal.
 * @param {string} bId
 * @param {number} slotIdx
 */
function clearPhoto(bId, slotIdx) {
  const slotEl   = document.getElementById(`s-${bId}-${slotIdx}`);
  const prevEl   = document.getElementById(`p-${bId}-${slotIdx}`);
  const holdEl   = document.getElementById(`h-${bId}-${slotIdx}`);
  const infoEl   = document.getElementById(`i-${bId}-${slotIdx}`);
  const clearEl  = document.getElementById(`c-${bId}-${slotIdx}`);
  const camInput = document.getElementById(`cam-${bId}-${slotIdx}`);
  const galInput = document.getElementById(`gal-${bId}-${slotIdx}`);

  slotEl.dataset.base64 = '';
  prevEl.src            = '';
  prevEl.classList.remove('visible');
  holdEl.classList.remove('hidden');
  clearEl.classList.add('hidden');
  infoEl.textContent    = '';
  infoEl.style.color    = '';
  if (camInput) camInput.value = '';
  if (galInput) galInput.value = '';
}

// ════════════════════════════════════════════════════════════
// COLLECT FORM DATA
// ════════════════════════════════════════════════════════════

/**
 * Membaca semua nilai dari form (identitas + semua blok dokumentasi)
 * dan mengembalikannya sebagai satu objek data.
 * @returns {Object}
 */
function collectFormData() {
  const namaPerusahaan = document.getElementById('nama-perusahaan').value.trim();
  const jenisObjek     = document.getElementById('jenis-objek').value;
  const noSerie        = document.getElementById('no-serie').value.trim();

  const blockEls = document.querySelectorAll('#block-list .doc-block');
  const blokDokumentasi = [];

  blockEls.forEach((blockEl) => {
    const bId    = blockEl.id;
    const judul  = (blockEl.querySelector('.block-judul')?.value || '').trim();
    const checkedLayout = blockEl.querySelector(`input[name="layout-${bId}"]:checked`);
    const layout = checkedLayout ? checkedLayout.value : '1col';
    const slotEls = blockEl.querySelectorAll('.slot-item');

    const slots = [];
    slotEls.forEach((slotEl) => {
      const foto       = slotEl.dataset.base64 || '';
      const keterangan = (slotEl.querySelector('.slot-keterangan')?.value || '').trim();
      slots.push({ foto, keterangan });
    });

    blokDokumentasi.push({ judul, layout, slots });
  });

  return { namaPerusahaan, jenisObjek, noSerie, blokDokumentasi };
}

// ════════════════════════════════════════════════════════════
// SIMPAN KE IndexedDB
// ════════════════════════════════════════════════════════════

/**
 * Mengosongkan form ke state awal untuk memulai laporan baru.
 */
function resetForm() {
  document.getElementById('nama-perusahaan').value = '';
  document.getElementById('jenis-objek').value = '';
  document.getElementById('no-serie').value = '';
  
  const blockList = document.getElementById('block-list');
  if (blockList) blockList.innerHTML = '';
  blockCounter = 0;
  editingId = null;

  // Kembalikan tombol ke teks awal
  const btnSave = document.getElementById('btn-save');
  if (btnSave) {
    btnSave.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
        <polyline points="17 21 17 13 7 13 7 21"/>
        <polyline points="7 3 7 8 15 8"/>
      </svg>
      Simpan Draf
    `;
  }
}

/**
 * Mengumpulkan data form dan menyimpannya ke IndexedDB sebagai draf "pending".
 */
async function saveToDevice() {
  const btn = document.getElementById('btn-save');
  const orig = btn.innerHTML;

  try {
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner dark"></div> Menyimpan…';

    if (!validateIdentitas()) {
      btn.disabled = false;
      btn.innerHTML = orig;
      return;
    }

    const data = collectFormData();

    if (data.blokDokumentasi.length === 0) {
      showToast('⚠️ Tambahkan minimal 1 blok dokumentasi.', 'warning');
      return;
    }

    await saveLaporan(data, editingId);
    
    if (editingId) {
      showToast('✅ Draf berhasil diperbarui!', 'success');
    } else {
      showToast('✅ Draf berhasil disimpan!', 'success');
    }
    
    // Kosongkan form setelah berhasil disimpan agar tidak ada duplikasi
    resetForm();
    
    await refreshPendingBadge();

  } catch (err) {
    console.error('[Save] Error:', err);
    showToast('❌ Gagal menyimpan. Coba lagi.', 'error');
  } finally {
    // Jika resetForm() terpanggil, kita tidak perlu memulihkan teks awal karena resetForm menangani tombol
    btn.disabled = false;
  }
}

// ════════════════════════════════════════════════════════════
// SINKRONISASI KE SERVER
// ════════════════════════════════════════════════════════════

/**
 * Mengambil semua record "pending" dari IndexedDB dan mengirimkannya
 * ke backend via POST /api/sync secara bertahap (1 laporan per request)
 * agar aman dari timeout Cloudflare (100s) & jaringan seluler tidak stabil.
 */
async function syncData() {
  if (isSyncing) return; // Cegah double-tap
  
  // Auto-save form jika sedang diisi atau diedit, agar tidak perlu klik Simpan Draf manual
  const data = collectFormData();
  if (editingId || (data.namaPerusahaan && data.noSerie && data.blokDokumentasi.length > 0)) {
    if (!data.namaPerusahaan || !data.noSerie) {
      showToast('⚠️ Nama Perusahaan & No Seri wajib diisi sebelum Sinkronisasi!', 'error');
      return;
    }
    try {
      await saveLaporan(data, editingId);
      // Jangan langsung panggil resetForm() di sini agar user bisa melihat form yang dia edit jika terjadi error sync,
      // Tapi update editingId agar sinkron
      editingId = null;
    } catch (e) {
      console.warn('Auto-save gagal:', e);
    }
  }

  // Cek konektivitas
  if (!navigator.onLine) {
    showToast('📵 Tidak ada koneksi internet.\nData tetap aman di perangkat & siap dikirim saat online.', 'warning');
    return;
  }

  const btn  = document.getElementById('btn-sync');
  const orig = btn.innerHTML;

  try {
    isSyncing    = true;
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> Menyinkronkan…';

    const pending = await getPendingLaporan();

    if (pending.length === 0) {
      showToast('ℹ️ Tidak ada data baru yang perlu disinkronisasi.', '');
      return;
    }

    const total      = pending.length;
    let syncedCount  = 0;
    let failedCount  = 0;
    const pdfLinks   = [];
    let lastErrorMsg = '';

    for (let idx = 0; idx < total; idx++) {
      const rec = pending[idx];
      const progressText = total > 1 ? `(${idx + 1}/${total})` : '';
      btn.innerHTML = `<div class="spinner"></div> Sync ${progressText}…`;
      showToast(`🔄 Mengirim laporan ${idx + 1} dari ${total} ke server…`, '');

      const headers = {
        'Content-Type': 'application/json',
        'Accept':       'application/json'
      };
      const accessKey = getStoredAccessKey();
      if (accessKey) headers['X-Access-Key'] = accessKey;

      const response = await fetch(API_ENDPOINT, {
        method:      'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({ records: [rec] })
      });

      if (response.status === 401) {
        await refreshPendingBadge();
        showToast('🔒 Kode Akses diperlukan sebelum sinkronisasi.', 'warning', 4500);
        showAuthOverlay('Masukkan Kode Akses atau tautan resmi dari Admin untuk menyinkronkan data.');
        return;
      }

      if (!response.ok) {
        const errText = await response.text();
        failedCount++;
        lastErrorMsg = `HTTP ${response.status}: ${errText.slice(0, 120)}`;
        console.error(`[Sync] Gagal record ${rec.id}:`, lastErrorMsg);
        continue;
      }

      const result = await response.json();
      const serverResult = (result.results || []).find(r => r.clientId === rec.id) || (result.results || [])[0];

      if (!serverResult) {
        failedCount++;
        lastErrorMsg = (result.errors && result.errors[0]?.error) || 'Gagal diproses server.';
        console.warn(`Record ${rec.id} gagal diproses oleh server, tetap di status pending.`);
        continue;
      }

      const pdfUrl  = serverResult.pdfUrl || null;
      const docxUrl = serverResult.docxUrl || null;
      await markAsSynced(rec.id, pdfUrl, docxUrl);
      syncedCount++;
      if (pdfUrl) pdfLinks.push(pdfUrl);
      await refreshPendingBadge();
    }

    if (syncedCount > 0 && failedCount === 0) {
      if (pdfLinks.length > 0) {
        showToast(`✅ ${syncedCount} laporan tersinkron!\n📄 PDF & Word siap diunduh — buka panel Data`, 'success', 5000);
        sessionStorage.setItem('lastSyncPdfUrls', JSON.stringify(pdfLinks));
      } else {
        showToast(`✅ ${syncedCount} laporan berhasil disinkronisasi!\nBuka panel Data untuk mengunduh dokumen.`, 'success', 5000);
      }
      // Reset form setelah sinkronisasi berhasil untuk menghindari duplikasi record
      resetForm();
      if (navigator.onLine) loadServerRecords(false);
    } else if (syncedCount > 0 && failedCount > 0) {
      showToast(`⚠️ ${syncedCount} berhasil, ${failedCount} gagal (${lastErrorMsg}).\nData yang gagal tetap aman di antrean.`, 'warning', 5500);
    } else {
      throw new Error(lastErrorMsg || 'Seluruh laporan gagal disinkronisasi.');
    }

  } catch (err) {
    console.error('[Sync] Error:', err);
    showToast(`❌ Sinkronisasi gagal:\n${err.message}`, 'error');
  } finally {
    isSyncing    = false;
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

// ════════════════════════════════════════════════════════════
// STATUS ONLINE / OFFLINE
// ════════════════════════════════════════════════════════════

function updateOnlineStatus() {
  const bar  = document.getElementById('status-bar');
  const text = document.getElementById('status-text');

  if (navigator.onLine) {
    bar.className    = 'status-bar online';
    text.textContent = 'Online — Siap melakukan sinkronisasi';
  } else {
    bar.className    = 'status-bar offline';
    text.textContent = 'Offline — Data disimpan di perangkat';
  }
}

// ════════════════════════════════════════════════════════════
// PENDING BADGE (header)
// ════════════════════════════════════════════════════════════

async function refreshPendingBadge() {
  try {
    const pending = await getPendingLaporan();
    const badge   = document.getElementById('pending-badge');
    if (pending.length > 0) {
      badge.textContent = pending.length > 99 ? '99+' : pending.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (e) {
    console.warn('[Badge] Error:', e);
  }
}

// ════════════════════════════════════════════════════════════
// TOAST NOTIFICATION
// ════════════════════════════════════════════════════════════

let _toastTimer = null;

/**
 * Menampilkan notifikasi singkat (toast) di bawah layar.
 * @param {string} message - Pesan yang ditampilkan
 * @param {string} type    - '' | 'success' | 'warning' | 'error'
 * @param {number} duration - Durasi tampil dalam ms (default: 3500)
 */
function showToast(message, type = '', duration = 3500) {
  const toast = document.getElementById('toast');
  clearTimeout(_toastTimer);

  toast.textContent = message;
  toast.className   = `toast${type ? ' ' + type : ''} show`;

  _toastTimer = setTimeout(() => {
    toast.className = `toast${type ? ' ' + type : ''}`;
  }, duration);
}

// ════════════════════════════════════════════════════════════
// RECORDS DRAWER (PERANGKAT LOKAL & ARSIP SERVER LINTAS PERANGKAT)
// ════════════════════════════════════════════════════════════

let activeDrawerTab     = 'local'; // 'local' | 'server'
let cachedServerRecords = [];
let drawerAutoSelected  = false;

function buildAuthHeaders(extra = {}) {
  const headers = { ...extra };
  const accessKey = getStoredAccessKey();
  if (accessKey) headers['X-Access-Key'] = accessKey;
  return headers;
}

function updateDrawerTabUI() {
  const tabLocal  = document.getElementById('tab-local');
  const tabServer = document.getElementById('tab-server');
  if (tabLocal) {
    tabLocal.classList.toggle('active', activeDrawerTab === 'local');
    tabLocal.setAttribute('aria-selected', activeDrawerTab === 'local' ? 'true' : 'false');
  }
  if (tabServer) {
    tabServer.classList.toggle('active', activeDrawerTab === 'server');
    tabServer.setAttribute('aria-selected', activeDrawerTab === 'server' ? 'true' : 'false');
  }
}

function setTabCount(id, count) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(count);
}

async function openDrawer() {
  document.getElementById('drawer-overlay').classList.add('open');
  document.getElementById('records-drawer').classList.add('open');
  document.body.style.overflow = 'hidden'; // Cegah scroll body

  const localRecords = await getAllLaporan();
  setTabCount('count-local', localRecords.length);

  // Di PC / perangkat kantor yang belum punya data lokal & sedang online, otomatis buka tab Arsip Server
  if (!drawerAutoSelected) {
    drawerAutoSelected = true;
    if (localRecords.length === 0 && navigator.onLine) {
      activeDrawerTab = 'server';
    } else {
      activeDrawerTab = 'local';
    }
  } else if (!navigator.onLine && activeDrawerTab === 'server') {
    activeDrawerTab = 'local';
  }

  updateDrawerTabUI();

  if (activeDrawerTab === 'local') {
    renderRecordsPanel(localRecords);
    if (navigator.onLine) {
      loadServerRecords(false);
    }
  } else {
    await loadServerRecords(true);
  }
}

async function switchDrawerTab(tab) {
  activeDrawerTab = tab === 'server' ? 'server' : 'local';
  updateDrawerTabUI();

  if (activeDrawerTab === 'local') {
    const records = await getAllLaporan();
    renderRecordsPanel(records);
  } else {
    await loadServerRecords(true);
  }
}

function closeDrawer() {
  document.getElementById('drawer-overlay').classList.remove('open');
  document.getElementById('records-drawer').classList.remove('open');
  document.body.style.overflow = '';
}

function clearDrawerHeaderBtn() {
  const oldSyncBtn = document.getElementById('drawer-sync-btn');
  if (oldSyncBtn) oldSyncBtn.remove();
}

function renderRecordsPanel(records) {
  const container = document.getElementById('records-list');
  const headerDiv = document.querySelector('.drawer-header');
  setTabCount('count-local', records ? records.length : 0);

  // Periksa apakah ada record pending
  const pendingCount = records ? records.filter(r => r.status === 'pending').length : 0;

  clearDrawerHeaderBtn();

  if (pendingCount > 0 && activeDrawerTab === 'local') {
    const syncBtn = document.createElement('button');
    syncBtn.id = 'drawer-sync-btn';
    syncBtn.onclick = async () => {
      await syncData();
      const updatedRecords = await getAllLaporan();
      renderRecordsPanel(updatedRecords);
      if (navigator.onLine) loadServerRecords(false);
    };
    syncBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
      </svg>
      Sync (${pendingCount})
    `;
    syncBtn.type = 'button';
    syncBtn.style.cssText = `
      display: inline-flex; align-items: center; gap: 5px;
      background: var(--primary); color: #fff; border: none; border-radius: 6px;
      padding: 6px 12px; font-size: 11px; font-weight: 700; cursor: pointer;
      margin-right: 10px; margin-left: auto;
    `;
    headerDiv.insertBefore(syncBtn, document.querySelector('.drawer-close'));
  }

  if (!records || records.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        <p>Belum ada data lokal di perangkat ini.<br><span style="font-size:12px;">Cek tab <strong>☁️ Arsip Server</strong> untuk melihat hasil sinkronisasi dari HP/perangkat lain.</span></p>
      </div>`;
    return;
  }

  // Urutkan: terbaru di atas (gunakan updatedAt jika ada)
  const sorted = [...records].sort(
    (a, b) => {
      const timeA = new Date(a.updatedAt || a.createdAt).getTime();
      const timeB = new Date(b.updatedAt || b.createdAt).getTime();
      return timeB - timeA;
    }
  );

  container.innerHTML = sorted.map((rec) => {
    const timestamp = rec.updatedAt || rec.createdAt;
    const dt = new Date(timestamp).toLocaleDateString('id-ID', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    const blokCount   = rec.blokDokumentasi?.length ?? 0;
    const statusClass = rec.status === 'synced' ? 'synced' : 'pending';
    const statusLabel = rec.status === 'synced' ? '✓ Tersinkron' : '⏳ Pending';
    const company     = _esc(rec.namaPerusahaan || '—');
    const jenis       = _esc(rec.jenisObjek  || '—');
    const serie       = _esc(rec.noSerie     || '—');

    // Tombol download PDF (hanya tampil untuk record synced yang punya pdfUrl)
    const pdfBtn = (rec.status === 'synced' && rec.pdfUrl)
      ? `<a href="${_esc(rec.pdfUrl)}" target="_blank" rel="noopener"
            style="display:inline-flex; align-items:center; gap:5px;
                   background:var(--primary); color:#fff; border-radius:6px;
                   padding:6px 12px; font-size:11px; font-weight:700;
                   text-decoration:none; transition:background 0.2s; white-space:nowrap;"
            onmouseover="this.style.background='#1D4ED8'"
            onmouseout="this.style.background='var(--primary)'">
           <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
             <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
             <polyline points="7 10 12 15 17 10"/>
             <line x1="12" y1="15" x2="12" y2="3"/>
           </svg>
           Unduh PDF
         </a>`
      : '';

    // Tombol download Word (hanya tampil untuk record synced yang punya docxUrl)
    const docxBtn = (rec.status === 'synced' && rec.docxUrl)
      ? `<a href="${_esc(rec.docxUrl)}" target="_blank" rel="noopener"
            style="display:inline-flex; align-items:center; gap:5px;
                   background:#2563EB; color:#fff; border-radius:6px;
                   padding:6px 12px; font-size:11px; font-weight:700;
                   text-decoration:none; transition:background 0.2s; white-space:nowrap;"
            onmouseover="this.style.background='#1E40AF'"
            onmouseout="this.style.background='#2563EB'">
           <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
             <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
             <polyline points="7 10 12 15 17 10"/>
             <line x1="12" y1="15" x2="12" y2="3"/>
           </svg>
           Unduh Word
         </a>`
      : '';

    // Tombol Sunting (Edit)
    const editBtn = `
      <button onclick="handleEditRecord(${rec.id})"
              style="display:inline-flex; align-items:center; gap:5px;
                     background:var(--primary-light); color:var(--primary); border:1px solid var(--primary-border); border-radius:6px;
                     padding:5px 10px; font-size:11px; font-weight:700; cursor:pointer;
                     transition:background 0.2s; white-space:nowrap;"
              onmouseover="this.style.background='var(--primary)'; this.style.color='#fff';"
              onmouseout="this.style.background='var(--primary-light)'; this.style.color='var(--primary)';">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M12 20h9"></path>
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
        </svg>
        Sunting
      </button>`;

    // Tombol Hapus (selalu ada)
    const deleteBtn = `
      <button onclick="handleDeleteRecord(${rec.id})"
              style="display:inline-flex; align-items:center; gap:5px;
                     background:var(--danger-bg); color:var(--danger); border:1px solid var(--danger-border); border-radius:6px;
                     padding:5px 10px; font-size:11px; font-weight:700; cursor:pointer;
                     transition:background 0.2s; white-space:nowrap;"
              onmouseover="this.style.background='var(--danger)'; this.style.color='#fff';"
              onmouseout="this.style.background='var(--danger-bg)'; this.style.color='var(--danger)';">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
        Hapus
      </button>`;

    // Tombol Sync Ulang (tampil jika record sudah synced tapi PDF/Word belum terbentuk di server)
    const resyncBtn = (rec.status === 'synced' && (!rec.pdfUrl || !rec.docxUrl))
      ? `<button onclick="handleResyncRecord(${rec.id})"
                 style="display:inline-flex; align-items:center; gap:5px;
                        background:var(--success); color:#fff; border:none; border-radius:6px;
                        padding:6px 11px; font-size:11px; font-weight:700; cursor:pointer;
                        white-space:nowrap;">
           🔄 Buat PDF/Word
         </button>`
      : '';

    return `
    <div class="record-item" style="flex-direction:column; gap:6px;">
      <div style="display:flex; align-items:flex-start; gap:10px; width:100%;">
        <div class="record-info">
          <div class="record-company">${company}</div>
          <div class="record-meta">${jenis} | SN: ${serie}</div>
          <div class="record-meta">${blokCount} blok &bull; ${dt}</div>
        </div>
        <span class="record-badge ${statusClass}">${statusLabel}</span>
      </div>
      <!-- Fitur Scroll Horizontal untuk Tombol -->
      <div style="display:flex; gap:8px; margin-top:6px; overflow-x:auto; padding-bottom:4px;">
        ${pdfBtn}
        ${docxBtn}
        ${resyncBtn}
        ${editBtn}
        ${deleteBtn}
      </div>
    </div>`;
  }).join('');
}

async function loadServerRecords(shouldRender = true) {
  const container = document.getElementById('records-list');
  if (shouldRender) {
    clearDrawerHeaderBtn();
    const headerDiv = document.querySelector('.drawer-header');
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.id = 'drawer-sync-btn';
    refreshBtn.onclick = () => loadServerRecords(true);
    refreshBtn.innerHTML = '↻ Segarkan';
    refreshBtn.style.cssText = `
      display: inline-flex; align-items: center; gap: 5px;
      background: var(--primary-light); color: var(--primary);
      border: 1px solid var(--primary-border); border-radius: 6px;
      padding: 6px 10px; font-size: 11px; font-weight: 700; cursor: pointer;
      margin-right: 10px; margin-left: auto;
    `;
    headerDiv.insertBefore(refreshBtn, document.querySelector('.drawer-close'));
  }

  if (!navigator.onLine) {
    if (shouldRender && container) {
      container.innerHTML = `
        <div class="empty-state">
          <p>📵 Perangkat sedang offline.<br><span style="font-size:12px;">Arsip server memerlukan koneksi internet. Data lokal tetap aman di tab <strong>📱 Perangkat Ini</strong>.</span></p>
        </div>`;
    }
    return;
  }

  if (shouldRender && cachedServerRecords.length === 0 && container) {
    container.innerHTML = `
      <div class="empty-state">
        <p>⏳ Mengambil daftar arsip dari server…</p>
      </div>`;
  } else if (shouldRender) {
    renderServerRecordsPanel(cachedServerRecords);
  }

  try {
    const res = await fetch('/api/server-records', {
      method:      'GET',
      credentials: 'same-origin',
      headers:     buildAuthHeaders({ Accept: 'application/json' })
    });

    if (res.status === 401) {
      if (shouldRender) {
        closeDrawer();
        showAuthOverlay('Masukkan Kode Akses untuk membuka Arsip Server.');
      }
      return;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    cachedServerRecords = Array.isArray(data.records) ? data.records : [];
    setTabCount('count-server', cachedServerRecords.length);

    if (shouldRender && activeDrawerTab === 'server') {
      renderServerRecordsPanel(cachedServerRecords);
    }
  } catch (err) {
    console.warn('[ServerRecords] Gagal memuat arsip server:', err);
    if (shouldRender && activeDrawerTab === 'server' && container) {
      container.innerHTML = `
        <div class="empty-state">
          <p>⚠️ Gagal mengambil data dari server.<br><span style="font-size:12px;">Periksa koneksi internet lalu ketuk <strong>↻ Segarkan</strong>.</span></p>
        </div>`;
    }
  }
}

function renderServerRecordsPanel(records) {
  const container = document.getElementById('records-list');
  if (!container) return;

  if (!records || records.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <p>Belum ada arsip laporan yang disinkronkan ke server.</p>
      </div>`;
    return;
  }

  container.innerHTML = records.map((rec) => {
    const dt = new Date(rec.savedAt).toLocaleDateString('id-ID', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    const company   = _esc(rec.namaPerusahaan || '—');
    const jenis     = _esc(rec.jenisObjek || '—');
    const serie     = _esc(rec.noSerie || '—');
    const safeSerie = _esc(rec.safeSerie);
    const sessionTs = _esc(rec.sessionTs);
    const blokCount = rec.bloksCount ?? 0;

    const pdfBtn = rec.pdfUrl
      ? `<a href="${_esc(rec.pdfUrl)}" target="_blank" rel="noopener"
            style="display:inline-flex; align-items:center; gap:5px;
                   background:var(--primary); color:#fff; border-radius:6px;
                   padding:6px 12px; font-size:11px; font-weight:700;
                   text-decoration:none; white-space:nowrap;">
           <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
             <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
             <polyline points="7 10 12 15 17 10"/>
             <line x1="12" y1="15" x2="12" y2="3"/>
           </svg>
           Unduh PDF
         </a>`
      : '';

    const docxBtn = rec.docxUrl
      ? `<a href="${_esc(rec.docxUrl)}" target="_blank" rel="noopener"
            style="display:inline-flex; align-items:center; gap:5px;
                   background:#2563EB; color:#fff; border-radius:6px;
                   padding:6px 12px; font-size:11px; font-weight:700;
                   text-decoration:none; white-space:nowrap;">
           <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
             <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
             <polyline points="7 10 12 15 17 10"/>
             <line x1="12" y1="15" x2="12" y2="3"/>
           </svg>
           Unduh Word
         </a>`
      : '';

    const regenBtn = (!rec.pdfUrl || !rec.docxUrl)
      ? `<button onclick="handleRegenerateServerRecord('${safeSerie}', '${sessionTs}')"
                 style="display:inline-flex; align-items:center; gap:5px;
                        background:var(--success); color:#fff; border:none; border-radius:6px;
                        padding:6px 11px; font-size:11px; font-weight:700; cursor:pointer;
                        white-space:nowrap;">
           🔄 Buat PDF/Word
         </button>`
      : '';

    const editBtn = `
      <button onclick="handleEditServerRecord('${safeSerie}', '${sessionTs}')"
              style="display:inline-flex; align-items:center; gap:5px;
                     background:var(--primary-light); color:var(--primary); border:1px solid var(--primary-border); border-radius:6px;
                     padding:5px 10px; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M12 20h9"></path>
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
        </svg>
        Sunting
      </button>`;

    const deleteBtn = `
      <button onclick="handleDeleteServerRecord('${safeSerie}', '${sessionTs}')"
              style="display:inline-flex; align-items:center; gap:5px;
                     background:var(--danger-bg); color:var(--danger); border:1px solid var(--danger-border); border-radius:6px;
                     padding:5px 10px; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
        Hapus
      </button>`;

    return `
    <div class="record-item" style="flex-direction:column; gap:6px;">
      <div style="display:flex; align-items:flex-start; gap:10px; width:100%;">
        <div class="record-info">
          <div class="record-company">${company}</div>
          <div class="record-meta">${jenis} | SN: ${serie}</div>
          <div class="record-meta">${blokCount} blok &bull; ${dt}</div>
        </div>
        <span class="record-badge synced">☁️ Server</span>
      </div>
      <div style="display:flex; gap:8px; margin-top:6px; overflow-x:auto; padding-bottom:4px;">
        ${pdfBtn}
        ${docxBtn}
        ${regenBtn}
        ${editBtn}
        ${deleteBtn}
      </div>
    </div>`;
  }).join('');
}

async function handleRegenerateServerRecord(safeSerie, sessionTs) {
  showToast('🔄 Sedang membuat PDF & Word di server…', '', 6000);
  try {
    const res = await fetch(`/api/server-records/${encodeURIComponent(safeSerie)}/${encodeURIComponent(sessionTs)}/regenerate`, {
      method:      'POST',
      credentials: 'same-origin',
      headers:     buildAuthHeaders({ Accept: 'application/json' })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.pdfError || data.docxError || data.message || `HTTP ${res.status}`);
    }
    if (data.pdfError) {
      showToast(`⚠️ Word siap, tetapi PDF gagal: ${data.pdfError.slice(0, 90)}`, 'warning', 5500);
    } else {
      showToast('✅ File PDF & Word berhasil dibuat!', 'success');
    }
    await loadServerRecords(true);
  } catch (err) {
    console.error('[ServerRegen] Error:', err);
    showToast(`❌ Gagal membuat dokumen: ${err.message.slice(0, 100)}`, 'error', 5000);
  }
}

async function handleEditServerRecord(safeSerie, sessionTs) {
  showToast('⏳ Memuat foto & data laporan dari server…', '');
  try {
    const res = await fetch(`/api/server-records/${encodeURIComponent(safeSerie)}/${encodeURIComponent(sessionTs)}/detail`, {
      method:      'GET',
      credentials: 'same-origin',
      headers:     buildAuthHeaders({ Accept: 'application/json' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.record) throw new Error('Data kosong');

    populateFormFromRecord(data.record, null);
    closeDrawer();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast('✏️ Laporan dari server berhasil dimuat ke editor!', 'success');
  } catch (err) {
    console.error('[ServerEdit] Error:', err);
    showToast('Gagal memuat detail laporan dari server.', 'error');
  }
}

async function handleDeleteServerRecord(safeSerie, sessionTs) {
  if (!confirm('Hapus permanen arsip laporan ini beserta file PDF & Word-nya dari Server?')) return;
  try {
    const res = await fetch(`/api/server-records/${encodeURIComponent(safeSerie)}/${encodeURIComponent(sessionTs)}/delete`, {
      method:      'POST',
      credentials: 'same-origin',
      headers:     buildAuthHeaders({ Accept: 'application/json' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('🗑️ Arsip berhasil dihapus dari server.', 'success');
    await loadServerRecords(true);
  } catch (err) {
    console.error('[ServerDelete] Error:', err);
    showToast('Gagal menghapus arsip dari server.', 'error');
  }
}

async function handleResyncRecord(id) {
  try {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    await new Promise((resolve, reject) => {
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if (!rec) { resolve(); return; }
        rec.status = 'pending';
        const putReq = store.put(rec);
        putReq.onsuccess = () => resolve();
        putReq.onerror   = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
    await refreshPendingBadge();
    await syncData();
    const updatedRecords = await getAllLaporan();
    renderRecordsPanel(updatedRecords);
    if (navigator.onLine) loadServerRecords(false);
  } catch (err) {
    console.error('[Resync] Error:', err);
    showToast('Gagal membuat ulang dokumen.', 'error');
  }
}

function populateFormFromRecord(record, localEditId) {
  // 1. Populate Identitas
  document.getElementById('nama-perusahaan').value = record.namaPerusahaan || '';
  document.getElementById('jenis-objek').value     = record.jenisObjek || 'Pesawat Angkat & Angkut';
  document.getElementById('no-serie').value        = record.noSerie || '';

  // 2. Clear current blocks
  const blockList = document.getElementById('block-list');
  blockList.innerHTML = '';
  blockCounter = 0;

  // 3. Populate Blocks
  if (record.blokDokumentasi && Array.isArray(record.blokDokumentasi)) {
    record.blokDokumentasi.forEach(blok => {
      addBlock();
      const bId = `blk-${blockCounter}`;
      const blockEl = document.getElementById(bId);
      if (!blockEl) return;

      const judulInput = blockEl.querySelector('.block-judul');
      if (judulInput) judulInput.value = blok.judul || '';

      const layout = blok.layout || '1col';
      const radio = blockEl.querySelector(`input[name="layout-${bId}"][value="${layout}"]`);
      if (radio) {
        radio.checked = true;
        renderSlots(bId, layout);
      }

      if (blok.slots && Array.isArray(blok.slots)) {
        blok.slots.forEach((slotData, idx) => {
          const slotEl  = document.getElementById(`s-${bId}-${idx}`);
          const prevEl  = document.getElementById(`p-${bId}-${idx}`);
          const holdEl  = document.getElementById(`h-${bId}-${idx}`);
          const clearEl = document.getElementById(`c-${bId}-${idx}`);
          const ketEl   = document.querySelector(`#s-${bId}-${idx} .slot-keterangan`);

          if (slotEl && slotData.foto) {
            slotEl.dataset.base64 = slotData.foto;
            if (prevEl) {
              prevEl.src = slotData.foto;
              prevEl.classList.add('visible');
            }
            if (holdEl) holdEl.classList.add('hidden');
            if (clearEl) clearEl.classList.remove('hidden');
          }

          if (ketEl && slotData.keterangan) {
            ketEl.value = slotData.keterangan;
          }
        });
      }
    });
  }

  // 4. Set State & UI
  const btnSave = document.getElementById('btn-save');
  if (record.status === 'synced' || localEditId === null) {
    editingId = null;
    if (btnSave) {
      btnSave.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
          <polyline points="17 21 17 13 7 13 7 21"/>
          <polyline points="7 3 7 8 15 8"/>
        </svg>
        Simpan sbg Draf Baru
      `;
    }
  } else {
    editingId = localEditId;
    if (btnSave) {
      btnSave.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
        </svg>
        Perbarui Draf
      `;
    }
  }
}

async function handleEditRecord(id) {
  try {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);

    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) {
        showToast('Data tidak ditemukan.', 'error');
        return;
      }

      populateFormFromRecord(record, record.status === 'synced' ? null : id);
      if (record.status === 'synced') {
        showToast('✏️ Mode Salin Aktif. Data akan disimpan sebagai laporan baru.', 'success');
      } else {
        showToast('✏️ Mode Penyuntingan Aktif. Silakan ubah data.', 'success');
      }

      closeDrawer();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  } catch (err) {
    console.error('Error in Edit:', err);
    showToast('Gagal memuat data untuk disunting.', 'error');
  }
}

async function handleDeleteRecord(id) {
  if (!confirm('Hapus data ini dari memori perangkat ini? (Arsip yang sudah disinkronkan di Server tetap aman)')) return;
  try {
    await deleteLaporan(id);
    showToast('Data berhasil dihapus dari perangkat.', 'success');
    await refreshPendingBadge();
    const records = await getAllLaporan();
    renderRecordsPanel(records);
  } catch (err) {
    console.error('Delete error:', err);
    showToast('Gagal menghapus data.', 'error');
  }
}

/** HTML escape sederhana */
function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ════════════════════════════════════════════════════════════
// SERVICE WORKER REGISTRATION & UPDATE
// ════════════════════════════════════════════════════════════

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('[SW] Service Workers not supported in this browser.');
    return;
  }

  navigator.serviceWorker.register('/sw.js')
    .then((reg) => {
      swRegistration = reg;
      console.log('[SW] Registered, scope:', reg.scope);

      // Deteksi update tersedia
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // Ada versi baru yang terinstall, tampilkan banner
            document.getElementById('update-banner').classList.remove('hidden');
          }
        });
      });
    })
    .catch((err) => {
      console.warn('[SW] Registration failed:', err);
    });

  // Reload setelah SW baru mengambil alih
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_reloading) return;
    _reloading = true;
    window.location.reload();
  });
}

let _reloading = false;

/** Terapkan update SW dan reload halaman */
function applyUpdate() {
  if (swRegistration && swRegistration.waiting) {
    swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }
  document.getElementById('update-banner').classList.add('hidden');
}

// ════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════

function detectInAppWebView() {
  const ua = navigator.userAgent || '';
  const isInApp = /WhatsApp|Instagram|FBAN|FBAV|Line\/|Telegram/i.test(ua) ||
                  (/wv\)/.test(ua) && /Version\/\d/.test(ua));
  if (isInApp) {
    const banner = document.getElementById('webview-banner');
    if (banner) banner.classList.remove('hidden');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[App] Initializing Riksa Uji PJK3 PWA…');

  // 0. Deteksi jika dibuka di browser internal aplikasi chat (WhatsApp/IG)
  detectInAppWebView();

  // 1. Daftarkan Service Worker
  registerServiceWorker();

  // 2. Periksa Secret Link (?key=...) / Kode Akses Tim
  initAccessControl();

  // 3. Inisialisasi IndexedDB
  try {
    await initDB();
  } catch (err) {
    console.error('[App] IndexedDB init failed:', err);
    showToast('⚠️ Penyimpanan lokal gagal diinisialisasi.\nPastikan browser mendukung IndexedDB.', 'warning', 6000);
    return;
  }

  // 4. Setup listener online/offline
  window.addEventListener('online', () => {
    updateOnlineStatus();
    initAccessControl(); // Segarkan cookie sesi akses di background saat sinyal kembali
    showToast('🟢 Koneksi pulih! Siap sinkronisasi.', 'success');
  });

  window.addEventListener('offline', () => {
    updateOnlineStatus();
    showToast('🔴 Koneksi terputus.\nMode offline aktif — data tetap tersimpan.', 'warning');
  });

  // 5. Set status awal
  updateOnlineStatus();

  // 6. Perbarui badge pending
  await refreshPendingBadge();

  console.log('[App] Ready ✓');
});
