# Video Link Cleaner & Embedder (StreamClean) ⚡

Aplikasi web modern berbasis **Node.js, Express, dan EJS** untuk membersihkan tautan video dari berbagai situs web, menyadap aliran data video (.m3u8/.mp4) menggunakan Puppeteer headless, dan menghasilkan halaman pemutar bersih bebas iklan/redirect yang dilengkapi Server-Side Rendered (SSR) Open Graph tags.

---

## 🌟 Fitur Utama

1. **Halaman Input Modern (Dark Theme)**
   - Desain responsif, clean, dan futuristik berbasis slate dark mode.
   - Form input URL dengan tombol aksi AJAX/Fetch instan.
   - Kartu pratinjau thumbnail, judul, deskripsi video, dan share link.
   - Pemutar video instan (*in-page preview*) dengan Plyr.js dan Hls.js.

2. **Backend Processing & Puppeteer Network Sniffer**
   - Mengambil Open Graph metadata (`og:title`, `og:image`, `og:description`) menggunakan Cheerio.
   - Menyadap request jaringan via Puppeteer headless untuk menangkap URL stream video asli (`.m3u8` atau `.mp4`).
   - Penyimpanan sementara in-memory (Map) dengan ID acak unik (TTL 24 jam).

3. **Halaman Pemutar Publik (`/watch/:id`)**
   - Server-Side Rendered (SSR) meta tags (`og:title`, `og:image`, `og:video`, dll.) agar kartu video tampil menarik saat dibagikan ke WhatsApp, Telegram, Facebook, Twitter.
   - Pemutar video bersih tanpa popup, banner, ataupun redirect paksa.

4. **Media Stream Proxy (`/proxy-stream`)**
   - Bypass proteksi anti-hotlink dengan memalsukan header `Referer` dan `Origin` domain sumber.
   - Mendukung streaming chunk HLS `.m3u8` (rewrite manifest otomatis) dan format `.mp4` (mendukung header `Range` untuk seeking).

---

## 📂 Struktur Direktori

```text
D:\KAMIL_2026\Template\TES AJA DULU/
├── package.json               # Dependensi & script aplikasi
├── server.js                  # Entry point Express, route API, proxy stream & in-memory store
├── services/
│   └── extractor.js           # Puppeteer network sniffer & Cheerio metadata parser
├── views/
│   ├── index.ejs              # Halaman input landing page + AJAX
│   └── player.ejs             # Halaman publik pemutar video + SSR Open Graph
├── public/
│   ├── css/
│   │   └── style.css          # Desain antarmuka modern dark theme
│   └── images/
│       └── default-thumb.svg  # Placeholder thumbnail default
└── README.md                  # Panduan penggunaan
```

---

## 🚀 Panduan Instalasi & Menjalankan Aplikasi

### 1. Masuk ke Direktori Proyek
Buka terminal (PowerShell / Command Prompt) dan arahkan ke folder ini:
```powershell
cd "D:\KAMIL_2026\Template\TES AJA DULU"
```

### 2. Pasang Dependensi
Jalankan perintah berikut untuk mengunduh semua library yang dibutuhkan (Express, EJS, Puppeteer, Cheerio, Axios, CORS):
```powershell
npm install
```

### 3. Jalankan Server
Untuk mode produksi:
```powershell
npm start
```

Atau jika ingin auto-reload saat pengembangan:
```powershell
npm run dev
```

### 4. Buka di Browser
Akses alamat berikut di browser Anda:
```
http://localhost:3000
```
