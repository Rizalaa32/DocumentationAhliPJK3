// app.js — Logika PWA Riksa Uji PJK3
// Mencakup: IndexedDB, Kompresi Canvas, Dynamic Block Builder, Sync
'use strict';

// ════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════
const DB_NAME        = 'riksauji_db';
const DB_VERSION     = 1;
const STORE_NAME     = 'laporan';
const API_ENDPOINT   = '/api/sync';
const MAX_IMAGE_DIM  = 800;   // px — dimensi max setelah resize
const JPEG_QUALITY   = 0.7;   // 0–1, kualitas kompresi JPEG

const SLOT_LABELS = {
  '1col': ['Foto'],
  '2col': ['Kiri', 'Kanan'],
  '3col': ['Atas', 'Tengah', 'Bawah']
};

const SLOT_COUNTS = { '1col': 1, '2col': 2, '3col': 3 };

// ════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════
let db            = null;   // IndexedDB instance
let blockCounter  = 0;      // Penomoran blok dokumentasi
let isSyncing     = false;  // Guard flag untuk sync
let swRegistration = null;  // Service Worker registration

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
 * Menyimpan satu record laporan baru ke IndexedDB dengan status "pending".
 * @param {Object} data - Data form yang telah dikumpulkan
 * @returns {Promise<number>} ID record yang baru dibuat
 */
function saveLaporan(data) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record = {
      ...data,
      status:    'pending',
      createdAt: new Date().toISOString(),
      syncedAt:  null
    };
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
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
 * Menandai satu record sebagai "synced", mengisi syncedAt, dan menyimpan URL PDF.
 * @param {number} id      - Primary key record
 * @param {string|null} pdfUrl - URL download PDF dari server (opsional)
 * @returns {Promise<void>}
 */
function markAsSynced(id, pdfUrl = null) {
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
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve();
      putReq.onerror   = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
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
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('File bukan gambar yang valid.'));
      return;
    }

    const originalKB = (file.size / 1024).toFixed(1);
    const reader     = new FileReader();

    reader.onload = (readerEvent) => {
      const img = new Image();

      img.onload = () => {
        let { width, height } = img;

        // Hitung dimensi baru dengan mempertahankan rasio aspek
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const ratio = Math.min(MAX_IMAGE_DIM / width, MAX_IMAGE_DIM / height);
          width  = Math.round(width  * ratio);
          height = Math.round(height * ratio);
        }

        // Gambar ulang ke canvas dengan ukuran yang sudah di-resize
        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Export ke Base64 JPEG
        const base64        = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        // Estimasi ukuran: Base64 4/3 lebih besar dari binary; kurangi 33% overhead
        const compressedKB  = Math.round((base64.length * 0.75) / 1024);

        resolve({ base64, originalKB: parseFloat(originalKB), compressedKB, width, height });
      };

      img.onerror = () => reject(new Error('Gagal memuat gambar. Format tidak didukung.'));
      img.src = readerEvent.target.result;
    };

    reader.onerror = () => reject(new Error('Gagal membaca file dari perangkat.'));
    reader.readAsDataURL(file);
  });
}

// ════════════════════════════════════════════════════════════
// NAVIGASI SLIDE
// ════════════════════════════════════════════════════════════

function goToSlide1() {
  document.getElementById('slides-track').style.transform = 'translateX(0)';
  document.getElementById('action-bar').classList.add('hidden');
  _setStep(1);
}

function goToSlide2() {
  // Validasi form slide 1
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
    showToast('⚠️ Lengkapi semua field yang bertanda bintang (*).', 'warning');
    return;
  }

  // Tampilkan ringkasan identitas di slide 2
  document.getElementById('summary-text').textContent =
    `${jenisObjek} — ${namaPerusahaan}\nNo. Seri: ${noSerie}`;

  // Transisi ke slide 2
  document.getElementById('slides-track').style.transform = 'translateX(-100%)';
  document.getElementById('action-bar').classList.remove('hidden');
  _setStep(2);

  // Tambah blok pertama secara otomatis jika list masih kosong
  const blockList = document.getElementById('block-list');
  if (blockList.children.length === 0) {
    addBlock();
  }

  // Scroll ke atas slide 2
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Helper: perbarui tampilan step indicator */
function _setStep(step) {
  const s1   = document.getElementById('step-1');
  const s2   = document.getElementById('step-2');
  const line = document.getElementById('step-line');

  if (step === 1) {
    s1.className   = 'step-item active';
    s2.className   = 'step-item';
    line.className = 'step-line';
  } else {
    s1.className   = 'step-item done';
    s2.className   = 'step-item active';
    line.className = 'step-line done';
  }
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
  const sId      = `s-${bId}-${slotIdx}`;   // slot wrapper id
  const fileId   = `f-${bId}-${slotIdx}`;   // file input id
  const prevId   = `p-${bId}-${slotIdx}`;   // preview img id
  const holdId   = `h-${bId}-${slotIdx}`;   // placeholder id
  const infoId   = `i-${bId}-${slotIdx}`;   // compression info id
  const clearId  = `c-${bId}-${slotIdx}`;   // clear button id

  return `
  <div class="slot-item" id="${sId}" data-base64="">
    <div class="slot-label">${label}</div>

    <!-- Foto Area -->
    <div class="photo-area">
      <!-- Preview (hidden sampai ada foto) -->
      <img class="photo-preview" id="${prevId}"
           alt="Preview foto ${label}" style="object-fit:contain; height:200px; max-height:200px;">

      <!-- Placeholder (klik untuk buka kamera/file) -->
      <div class="photo-placeholder" id="${holdId}"
           onclick="document.getElementById('${fileId}').click()"
           role="button" tabindex="0"
           onkeydown="if(event.key==='Enter')document.getElementById('${fileId}').click()">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <span>Ketuk untuk foto / pilih gambar</span>
      </div>

      <!-- File input tersembunyi (capture=environment untuk kamera belakang) -->
      <input type="file" id="${fileId}" accept="image/*" capture="environment"
             onchange="handleFile('${bId}',${slotIdx},this)">
    </div>

    <!-- Action Row -->
    <div class="photo-actions" style="margin-top:8px;">
      <button type="button" class="btn-cam" onclick="document.getElementById('${fileId}').click()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="4"/>
        </svg>
        Pilih / Ambil Foto
      </button>
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
  const fileInput = document.getElementById(`f-${bId}-${slotIdx}`);

  slotEl.dataset.base64 = '';
  prevEl.src             = '';
  prevEl.classList.remove('visible');
  holdEl.classList.remove('hidden');
  clearEl.classList.add('hidden');
  infoEl.textContent    = '';
  infoEl.style.color    = '';
  if (fileInput) fileInput.value = '';
}

// ════════════════════════════════════════════════════════════
// COLLECT FORM DATA
// ════════════════════════════════════════════════════════════

/**
 * Membaca semua nilai dari form (slide 1 + semua blok di slide 2)
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
      const foto        = slotEl.dataset.base64 || '';
      const keterangan  = (slotEl.querySelector('.slot-keterangan')?.value || '').trim();
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
 * Mengumpulkan data form dan menyimpannya ke IndexedDB sebagai draf "pending".
 */
async function saveToDevice() {
  const btn = document.getElementById('btn-save');
  const orig = btn.innerHTML;

  try {
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner dark"></div> Menyimpan…';

    const data = collectFormData();

    // Validasi minimal
    if (!data.namaPerusahaan || !data.jenisObjek || !data.noSerie) {
      showToast('⚠️ Data identitas belum lengkap.\nKembali ke Slide 1 dan lengkapi.', 'warning');
      return;
    }

    if (data.blokDokumentasi.length === 0) {
      showToast('⚠️ Tambahkan minimal 1 blok dokumentasi.', 'warning');
      return;
    }

    const id = await saveLaporan(data);
    showToast(`✅ Draf berhasil disimpan!\n(ID: ${id})`, 'success');
    await refreshPendingBadge();

  } catch (err) {
    console.error('[Save] Error:', err);
    showToast('❌ Gagal menyimpan. Coba lagi.', 'error');
  } finally {
    btn.disabled  = false;
    btn.innerHTML = orig;
  }
}

// ════════════════════════════════════════════════════════════
// SINKRONISASI KE SERVER
// ════════════════════════════════════════════════════════════

/**
 * Mengambil semua record "pending" dari IndexedDB dan mengirimkannya
 * ke backend via POST /api/sync. Jika berhasil, status diubah menjadi "synced".
 */
async function syncData() {
  if (isSyncing) return; // Cegah double-tap

  // Cek konektivitas
  if (!navigator.onLine) {
    showToast('📵 Tidak ada koneksi internet.\nData akan dikirim saat online.', 'warning');
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

    showToast(`🔄 Mengirim ${pending.length} laporan ke server…`, '');

    const response = await fetch(API_ENDPOINT, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json'
      },
      body: JSON.stringify({ records: pending })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Server error ${response.status}: ${errText}`);
    }

    const result = await response.json();
    console.log('[Sync] Server response:', result);

    // Tandai setiap record sebagai synced, sertakan pdfUrl jika tersedia
    await Promise.all(pending.map((rec) => {
      // Cari result yang cocok dengan clientId
      const serverResult = (result.results || []).find(r => r.clientId === rec.id);
      const pdfUrl = serverResult?.pdfUrl || null;
      return markAsSynced(rec.id, pdfUrl);
    }));
    await refreshPendingBadge();

    // Tampilkan hasil dengan link PDF
    const pdfLinks = (result.results || [])
      .filter(r => r.pdfUrl)
      .map(r => r.pdfUrl);

    if (pdfLinks.length > 0) {
      showToast(`✅ ${pending.length} laporan tersinkron!\n📄 PDF siap diunduh — buka panel Data`, 'success', 5000);
      // Simpan PDF URLs ke sessionStorage agar drawer dapat menampilkannya
      sessionStorage.setItem('lastSyncPdfUrls', JSON.stringify(pdfLinks));
    } else {
      showToast(`✅ ${pending.length} laporan berhasil disinkronisasi!`, 'success');
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
    bar.className   = 'status-bar online';
    text.textContent = 'Online — Siap melakukan sinkronisasi';
  } else {
    bar.className   = 'status-bar offline';
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
// RECORDS DRAWER
// ════════════════════════════════════════════════════════════

async function openDrawer() {
  document.getElementById('drawer-overlay').classList.add('open');
  document.getElementById('records-drawer').classList.add('open');
  document.body.style.overflow = 'hidden'; // Cegah scroll body
  const records = await getAllLaporan();
  renderRecordsPanel(records);
}

function closeDrawer() {
  document.getElementById('drawer-overlay').classList.remove('open');
  document.getElementById('records-drawer').classList.remove('open');
  document.body.style.overflow = '';
}

function renderRecordsPanel(records) {
  const container = document.getElementById('records-list');

  if (!records || records.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        <p>Belum ada data tersimpan di perangkat ini</p>
      </div>`;
    return;
  }

  // Urutkan: terbaru di atas
  const sorted = [...records].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  container.innerHTML = sorted.map((rec) => {
    const dt = new Date(rec.createdAt).toLocaleDateString('id-ID', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    const blokCount    = rec.blokDokumentasi?.length ?? 0;
    const statusClass  = rec.status === 'synced' ? 'synced' : 'pending';
    const statusLabel  = rec.status === 'synced' ? '✓ Tersinkron' : '⏳ Pending';
    const company      = _esc(rec.namaPerusahaan || '—');
    const jenis        = _esc(rec.jenisObjek  || '—');
    const serie        = _esc(rec.noSerie     || '—');

    // Tombol download PDF (hanya tampil untuk record synced yang punya pdfUrl)
    const pdfBtn = (rec.status === 'synced' && rec.pdfUrl)
      ? `<a href="${_esc(rec.pdfUrl)}" target="_blank" rel="noopener"
            style="display:inline-flex; align-items:center; gap:5px; margin-top:6px;
                   background:var(--primary); color:#fff; border-radius:6px;
                   padding:6px 12px; font-size:11px; font-weight:700;
                   text-decoration:none; transition:background 0.2s;"
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
      ${pdfBtn}
    </div>`;
  }).join('');
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

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[App] Initializing Riksa Uji PJK3 PWA…');

  // 1. Daftarkan Service Worker
  registerServiceWorker();

  // 2. Inisialisasi IndexedDB
  try {
    await initDB();
  } catch (err) {
    console.error('[App] IndexedDB init failed:', err);
    showToast('⚠️ Penyimpanan lokal gagal diinisialisasi.\nPastikan browser mendukung IndexedDB.', 'warning', 6000);
    return;
  }

  // 3. Setup listener online/offline
  window.addEventListener('online', () => {
    updateOnlineStatus();
    showToast('🟢 Koneksi pulih! Siap sinkronisasi.', 'success');
  });

  window.addEventListener('offline', () => {
    updateOnlineStatus();
    showToast('🔴 Koneksi terputus.\nMode offline aktif — data tetap tersimpan.', 'warning');
  });

  // 4. Set status awal
  updateOnlineStatus();

  // 5. Perbarui badge pending
  await refreshPendingBadge();

  console.log('[App] Ready ✓');
});
