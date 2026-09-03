require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');
const { URL } = require('url');
const { extractVideo } = require('./services/extractor');

const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// PERSISTENT DATABASE STORAGE (data/videos.json)
// ==========================================
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'videos.json');

// Pastikan folder data/ ada
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-Memory Cache yang tersinkronisasi ke File JSON
const videoStore = new Map();

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const rawData = fs.readFileSync(DB_FILE, 'utf8');
      const items = JSON.parse(rawData);
      for (const [id, item] of Object.entries(items)) {
        videoStore.set(id, item);
      }
      console.log(`[Database] Berhasil memuat ${videoStore.size} video dari data/videos.json`);
    } else {
      fs.writeFileSync(DB_FILE, JSON.stringify({}, null, 2), 'utf8');
      console.log(`[Database] File baru dibuat di data/videos.json`);
    }
  } catch (err) {
    console.error(`[Database Load Error]: ${err.message}`);
  }
}

function saveDatabase() {
  try {
    const obj = Object.fromEntries(videoStore);
    fs.writeFileSync(DB_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Database Save Error]: ${err.message}`);
  }
}

// Muat database saat server startup
loadDatabase();

// Buat ID Permanen yang konsisten berdasarkan URL
function generatePermanentId(sourceUrl) {
  const clean = sourceUrl.trim().toLowerCase().replace(/\/+$/, '');
  return crypto.createHash('md5').update(clean).digest('hex').substring(0, 10);
}

// Cari video yang sudah pernah dibersihkan sebelumnya
function findVideoByOriginalUrl(sourceUrl) {
  const clean = sourceUrl.trim().toLowerCase().replace(/\/+$/, '');
  for (const item of videoStore.values()) {
    if (item.originalUrl && item.originalUrl.trim().toLowerCase().replace(/\/+$/, '') === clean) {
      return item;
    }
  }
  return null;
}

// Enable trust proxy untuk cPanel / Reverse Proxy / Cloudflare
app.set('trust proxy', true);

// Helper URL Generator yang akurat di cPanel (HTTPS & Reverse Proxy aware)
function buildShareUrl(req, id) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}/watch/${id}`;
}

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Set View Engine ke EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// User-Agent standar untuk request proxy
const SPOOF_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ==========================================
// 1. ROUTE LANDING PAGE (GET /)
// ==========================================
app.get('/', (req, res) => {
  res.render('index');
});

// ==========================================
// 2. ROUTE BACKEND PROCESSING (POST /api/clean)
// ==========================================
app.post('/api/clean', async (req, res) => {
  let { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Parameter URL video wajib disertakan.',
    });
  }

  url = url.trim();
  // Otomatis tambahkan https:// jika pengguna hanya mengetik domain/path seperti video.idola.cc/...
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  // Validasi format URL
  try {
    new URL(url);
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: 'Format URL tidak valid.',
    });
  }

  try {
    console.log(`[API Clean] Memproses URL: ${url}`);

    // Cek apakah URL ini sudah pernah diproses dan tersimpan permanen di database
    const existing = findVideoByOriginalUrl(url);
    if (existing) {
      console.log(`[Database] Mengambil data permanen yang sudah ada (ID: ${existing.id})`);
      const shareUrl = buildShareUrl(req, existing.id);
      const proxyStreamUrl = `/proxy-stream?id=${existing.id}`;

      return res.json({
        success: true,
        id: existing.id,
        title: existing.title,
        thumbnail: existing.thumbnail,
        description: existing.description,
        streamType: existing.streamType,
        shareUrl,
        proxyStreamUrl,
      });
    }

    // Jika belum ada, ekstrak metadata dan video stream
    const videoData = await extractVideo(url);

    // Buat ID permanen konsisten berdasarkan URL sumber (tidak berubah-ubah lagi!)
    const id = generatePermanentId(url);

    // Simpan ke database permanen (Nama Default: VIDEO RANDOM)
    const record = {
      id,
      title: (req.body.title && req.body.title.trim()) ? req.body.title.trim() : 'VIDEO RANDOM',
      thumbnail: videoData.thumbnail,
      description: videoData.description,
      videoUrl: videoData.videoUrl,
      streamType: videoData.streamType,
      originalUrl: url,
      originDomain: videoData.originDomain,
      createdAt: Date.now(),
    };

    videoStore.set(id, record);
    saveDatabase(); // Tulis langsung ke data/videos.json!

    const shareUrl = buildShareUrl(req, id);
    const proxyStreamUrl = `/proxy-stream?id=${id}`;

    return res.json({
      success: true,
      id,
      title: record.title,
      thumbnail: record.thumbnail,
      description: record.description,
      streamType: record.streamType,
      shareUrl,
      proxyStreamUrl,
    });
  } catch (error) {
    console.error(`[API Clean Error]: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: error.message || 'Gagal mengekstrak video dari URL sumber.',
    });
  }
});

// ==========================================
// 3. ROUTE PUBLIC PLAYER (GET /watch/:id)
// ==========================================
app.get('/watch/:id', (req, res) => {
  const { id } = req.params;
  const video = videoStore.get(id);

  if (!video) {
    return res.status(404).render('player', {
      notFound: true,
      id,
      video: null,
      shareUrl: '',
      proxyStreamUrl: '',
    });
  }

  const shareUrl = buildShareUrl(req, id);
  const proxyStreamUrl = `/proxy-stream?id=${id}`;

  // Render Server-Side Rendered (SSR) dengan Open Graph tags
  res.render('player', {
    notFound: false,
    video,
    shareUrl,
    proxyStreamUrl,
  });
});

// ==========================================
// 4. ROUTE MEDIA STREAM PROXY (GET /proxy-stream)
// Anti-Hotlink Bypass (Memalsukan Referer & Origin)
// ==========================================
app.get('/proxy-stream', async (req, res) => {
  try {
    let targetUrl = '';
    let referer = '';
    let origin = '';

    // Model 1: Berdasarkan ID video yang tersimpan di memori
    if (req.query.id) {
      const video = videoStore.get(req.query.id);
      if (!video) {
        return res.status(404).send('Stream video tidak ditemukan atau telah kedaluwarsa.');
      }
      targetUrl = video.videoUrl;
      referer = video.originalUrl;
      origin = video.originDomain || (referer ? new URL(referer).origin : '');
    } 
    // Model 2: Berdasarkan direct URL query (digunakan oleh child segment m3u8)
    else if (req.query.url) {
      targetUrl = req.query.url;
      referer = req.query.ref || targetUrl;
      try {
        origin = new URL(referer).origin;
      } catch (e) {
        origin = '';
      }
    } else {
      return res.status(400).send('Parameter id atau url diperlukan.');
    }

    if (!targetUrl) {
      return res.status(400).send('Target URL stream kosong.');
    }

    // Persiapkan header spoofing yang optimal
    let streamOrigin = '';
    try {
      streamOrigin = new URL(targetUrl).origin;
    } catch (e) {}

    const headers = {
      'User-Agent': SPOOF_USER_AGENT,
      'Accept': '*/*',
      'Accept-Language': 'id,en-US;q=0.9,en;q=0.8',
      'Referer': referer || streamOrigin + '/',
      'Origin': origin || streamOrigin,
      'Sec-Fetch-Dest': targetUrl.includes('.m3u8') ? 'empty' : 'video',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
    };

    // Khusus Google Usercontent: jangan kirim Referer/Origin pihak ketiga karena Google akan melempar error 429!
    if (
      targetUrl.includes('googleusercontent.com') ||
      targetUrl.includes('googleapis.com') ||
      targetUrl.includes('googlevideo.com')
    ) {
      delete headers['Referer'];
      delete headers['Origin'];
    } else if (targetUrl.includes('turbosplayer.com') || targetUrl.includes('turboviplay.com')) {
      headers['Referer'] = 'https://turbovidhls.com/';
      headers['Origin'] = 'https://turbovidhls.com';
    }

    // Teruskan Range header dari browser pengguna (berguna untuk video scrubbing/seeking MP4)
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const isM3U8 = targetUrl.toLowerCase().includes('.m3u8') || targetUrl.toLowerCase().includes('/hls/');

    console.log(`[Proxy Stream] Mengalirkan: ${isM3U8 ? 'M3U8 Playlist' : 'Video/TS Chunk'} -> ${targetUrl.substring(0, 80)}...`);

    // JIKA FORMAT HLS (.m3u8): Ubah manifest dan arahkan chunk segmen ke proxy
    if (isM3U8) {
      const response = await axios.get(targetUrl, {
        headers: {
          ...headers,
          'Accept-Encoding': 'identity',
        },
        responseType: 'text',
        timeout: 12000,
      });

      const manifestContent = response.data;
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

      // Tulis ulang URI setiap segmen atau sub-playlist agar dialirkan lewat proxy kami
      const rewrittenManifest = manifestContent
        .split('\n')
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) {
            // Handle URI di dalam tag misalnya: #EXT-X-KEY:METHOD=AES-128,URI="..."
            if (trimmed.includes('URI=')) {
              return line.replace(/URI=["']?([^"']+)["']?/i, (match, uri) => {
                let absoluteUri = uri;
                if (!uri.startsWith('http')) {
                  absoluteUri = new URL(uri, baseUrl).href;
                }
                const proxiedKey = `/proxy-stream?url=${encodeURIComponent(absoluteUri)}&ref=${encodeURIComponent(referer)}`;
                return `URI="${proxiedKey}"`;
              });
            }
            return line;
          }

          // Segmen file (.ts atau nested .m3u8)
          let segmentUrl = trimmed;
          if (!trimmed.startsWith('http')) {
            segmentUrl = new URL(trimmed, baseUrl).href;
          }

          // Cek apakah sub-line ini adalah sub-playlist m3u8 atau chunk video
          const isNestedM3u8 = segmentUrl.toLowerCase().includes('.m3u8');
          const chunkFlag = isNestedM3u8 ? '' : '&is_chunk=1';

          // Salurkan ke proxy kita dengan parameter encoded
          return `/proxy-stream?url=${encodeURIComponent(segmentUrl)}&ref=${encodeURIComponent(referer)}${chunkFlag}`;
        })
        .join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(rewrittenManifest);
    }

    // JIKA FORMAT CHUNK SEGMEN VIDEO (TS / Google Usercontent)
    const isChunk = req.query.is_chunk === '1' || targetUrl.toLowerCase().includes('.ts') || targetUrl.includes('googleusercontent.com');

    if (isChunk) {
      const chunkResponse = await axios({
        method: 'get',
        url: targetUrl,
        headers: {
          ...headers,
          'Accept-Encoding': 'identity',
        },
        responseType: 'arraybuffer',
        timeout: 20000,
        validateStatus: (status) => status >= 200 && status < 400,
      });

      let buf = Buffer.from(chunkResponse.data);

      // DEKODIFIKASI / STRIP DUMMY HEADER:
      // Banyak hoster video (seperti turbosplayer / video.idola) menyelipkan header palsu (dummy PNG 941 bytes)
      // agar video tidak terdeteksi oleh Google. Kita bersihkan byte tersebut agar kembali menjadi stream MPEG-TS murni!
      if (buf.length > 0 && buf[0] !== 0x47) {
        for (let i = 0; i < Math.min(buf.length - 376, 4096); i++) {
          if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) {
            buf = buf.subarray(i);
            break;
          }
        }
      }

      res.status(200);
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Content-Length', buf.length);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.end(buf);
    }

    // JIKA FORMAT MP4 ATAU SEGMEN BINARY LAINNYA (.ts / chunks)
    const streamResponse = await axios({
      method: 'get',
      url: targetUrl,
      headers: {
        ...headers,
        'Accept-Encoding': 'identity', // Jangan kirim kompresi ganda pada chunk video
      },
      responseType: 'stream',
      decompress: false, // Jaga keaslian bitstream video
      timeout: 20000,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    res.status(streamResponse.status);

    // Tetapkan Content-Type yang tepat
    if (targetUrl.toLowerCase().includes('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
    } else if (streamResponse.headers['content-type']) {
      res.setHeader('Content-Type', streamResponse.headers['content-type']);
    }

    if (streamResponse.headers['content-length']) {
      res.setHeader('Content-Length', streamResponse.headers['content-length']);
    }
    if (streamResponse.headers['content-range']) {
      res.setHeader('Content-Range', streamResponse.headers['content-range']);
    }
    if (streamResponse.headers['accept-ranges']) {
      res.setHeader('Accept-Ranges', streamResponse.headers['accept-ranges']);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

    // Pipe stream video langsung ke client
    streamResponse.data.pipe(res);

    // Putuskan stream jika user menutup browser / cancel request
    req.on('close', () => {
      if (streamResponse.data && typeof streamResponse.data.destroy === 'function') {
        streamResponse.data.destroy();
      }
    });
  } catch (error) {
    console.error(`[Proxy Error]: ${error.message} - URL: ${req.query.url || req.query.id}`);
    if (!res.headersSent) {
      res.status(502).send(`Stream Proxy Error: ${error.message}`);
    }
  }
});

// ==========================================
// 5. ROUTE KIRIM KE TELEGRAM VIA BOT API (POST /api/send-telegram)
// ==========================================
app.post('/api/send-telegram', async (req, res) => {
  try {
    const { id } = req.body;
    let targetChatId = req.body.chatId || process.env.TELEGRAM_DEFAULT_CHAT_ID;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) {
      return res.status(400).json({
        success: false,
        message: 'TELEGRAM_BOT_TOKEN belum disetting di file .env server.',
      });
    }

    // Jika targetChatId belum disetting, otomatis deteksi dari interaksi terakhir bot (getUpdates)!
    if (!targetChatId) {
      try {
        const updatesRes = await axios.get(`https://api.telegram.org/bot${botToken}/getUpdates`, { timeout: 8000 });
        if (updatesRes.data && updatesRes.data.result && updatesRes.data.result.length > 0) {
          const updates = updatesRes.data.result;
          const lastUpdate = updates[updates.length - 1];
          if (lastUpdate.message && lastUpdate.message.chat) {
            targetChatId = lastUpdate.message.chat.id;
          } else if (lastUpdate.channel_post && lastUpdate.channel_post.chat) {
            targetChatId = lastUpdate.channel_post.chat.id;
          }
          if (targetChatId) {
            process.env.TELEGRAM_DEFAULT_CHAT_ID = String(targetChatId);
            console.log(`[Telegram Auto-Detect]: Ditemukan Chat ID aktif -> ${targetChatId}`);
          }
        }
      } catch (getUpErr) {
        console.warn(`[Telegram getUpdates Error]: ${getUpErr.message}`);
      }
    }

    if (!targetChatId) {
      return res.status(400).json({
        success: false,
        needStart: true,
        message: 'Bot belum terhubung ke akun Anda! Buka bot @Rumahkecilvideo_bot di Telegram Anda lalu klik START sekali saja, setelah itu klik tombol ini lagi.',
      });
    }

    const video = videoStore.get(id);
    if (!video) {
      return res.status(404).json({
        success: false,
        message: 'Video tidak ditemukan atau telah kedaluwarsa.',
      });
    }

    const shareUrl = buildShareUrl(req, id);
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';

    const displayTitle = (video && video.title && video.title !== 'Video Tanpa Judul') ? video.title : 'VIDEO RANDOM';
    const caption = `🎬 <b>${displayTitle}</b>\n\n` +
      `📝 <i>${video.description || 'Tonton video bersih tanpa iklan dan gangguan.'}</i>\n\n` +
      `⚡ <b>Link Tontonan Bersih:</b>\n` +
      `🔗 <a href="${shareUrl}">${shareUrl}</a>\n\n` +
      `🛡️ <i>Bebas popup, iklan, & malware</i>`;

    const isLocal = shareUrl.includes('localhost') || shareUrl.includes('127.0.0.1');

    const photoPayload = {
      chat_id: targetChatId,
      photo: video.thumbnail,
      caption: caption,
      parse_mode: 'HTML',
    };

    const textPayload = {
      chat_id: targetChatId,
      text: caption,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    };

    if (!isLocal) {
      // Jika sudah HTTPS (saat online di hosting), gunakan fitur resmi Telegram Web App
      // sehingga pemutar video terbuka langsung di dalam Telegram tanpa membuka Chrome luar!
      const isHttps = protocol === 'https';
      const buttonObj = isHttps
        ? {
            text: '▶️ Tonton di Telegram (In-App)',
            web_app: { url: shareUrl },
          }
        : {
            text: '▶️ Tonton Video Sekarang',
            url: shareUrl,
          };

      const markup = {
        inline_keyboard: [[buttonObj]],
      };
      photoPayload.reply_markup = markup;
      textPayload.reply_markup = markup;
    }

    // Coba kirim dengan foto thumbnail dulu jika thumbnail berupa URL absolut
    let telegramResponse;
    const isAbsoluteThumb = video.thumbnail && video.thumbnail.startsWith('http');

    if (isAbsoluteThumb) {
      try {
        telegramResponse = await axios.post(
          `https://api.telegram.org/bot${botToken}/sendPhoto`,
          photoPayload,
          { timeout: 15000 }
        );
      } catch (photoErr) {
        console.warn(`[Telegram Photo Fallback]: ${photoErr.message}, mencoba kirim pesan teks...`);
      }
    }

    // Fallback kirim text message jika tidak ada foto atau sendPhoto gagal
    if (!telegramResponse) {
      telegramResponse = await axios.post(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        textPayload,
        { timeout: 15000 }
      );
    }

    return res.json({
      success: true,
      message: `Berhasil dikirim ke Telegram (${targetChatId})!`,
      telegramMessageId: telegramResponse.data.result.message_id,
    });
  } catch (err) {
    console.error('[Telegram Send Error]:', err.response ? err.response.data : err.message);
    const errMsg =
      err.response && err.response.data && err.response.data.description
        ? err.response.data.description
        : err.message;
    return res.status(500).json({
      success: false,
      message: `Gagal mengirim ke Telegram: ${errMsg}`,
    });
  }
});

// Jalankan Server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Video Link Cleaner & Embedder Berjalan!`);
  console.log(`🌐 Server Local : http://localhost:${PORT}`);
  console.log(`📂 Direktori    : ${__dirname}`);
  console.log(`====================================================`);
});
