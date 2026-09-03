const axios = require('axios');
const cheerio = require('cheerio');
let puppeteer = null;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  console.warn('[Extractor] Puppeteer tidak tersedia, berjalan dengan Fast Scraper murni.');
}
const { URL } = require('url');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Helper: Unpack JavaScript P.A.C.K.E.D obfuscation
 * Sering digunakan pada video hosting/player (seperti idola.cc, dood, streamtape, filemoon, dll)
 */
function unpackJs(packedCode) {
  try {
    const match = packedCode.match(/eval\(function\(p,a,c,k,e,[rd]/);
    if (!match) return packedCode;

    // Ekstrak argumen p, a, c, k, e, d dari fungsi eval
    const parts = packedCode.match(/}\('(.*)',\s*(\d+),\s*(\d+),\s*'(.*)'\.split\('\|'\)/);
    if (!parts) return packedCode;

    let [, p, a, c, k] = parts;
    a = parseInt(a, 10);
    c = parseInt(c, 10);
    const dict = k.split('|');

    const lookup = (n) => {
      const base36 = (n < a ? '' : lookup(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
      return base36;
    };

    while (c--) {
      if (dict[c]) {
        p = p.replace(new RegExp('\\b' + lookup(c) + '\\b', 'g'), dict[c]);
      }
    }
    return p;
  } catch (e) {
    return packedCode;
  }
}

/**
 * Mengambil metadata Open Graph dan tag HTML dasar menggunakan Cheerio
 */
async function extractMetadata(targetUrl) {
  try {
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      timeout: 10000,
      maxRedirects: 5,
    });

    const $ = cheerio.load(response.data);

    let title =
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('title').text().trim() ||
      '';

    // Bersihkan judul dari embel-embel umum website
    if (title) {
      title = title.replace(/\s*-\s*(Nonton|Streaming|Watch|Video|IDOLA|Player).*$/i, '').trim();
    }
    if (!title) title = 'Video Player';

    let thumbnail =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('link[rel="image_src"]').attr('href') ||
      $('meta[property="og:image:secure_url"]').attr('content') ||
      '';

    if (thumbnail && (thumbnail.toLowerCase() === 'no' || thumbnail.length < 5)) {
      thumbnail = '';
    }

    if (thumbnail && !thumbnail.startsWith('http')) {
      try {
        thumbnail = new URL(thumbnail, targetUrl).href;
      } catch (e) {
        thumbnail = '';
      }
    }

    const description =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      'Tonton video ini tanpa iklan dan gangguan melalui pemutar bersih.';

    // Cari direct video di tag meta / HTML
    let directVideo =
      $('meta[property="og:video"]').attr('content') ||
      $('meta[property="og:video:url"]').attr('content') ||
      $('meta[property="og:video:secure_url"]').attr('content') ||
      $('video source').first().attr('src') ||
      $('video').first().attr('src') ||
      null;

    if (directVideo && !directVideo.startsWith('http')) {
      try {
        directVideo = new URL(directVideo, targetUrl).href;
      } catch (e) {
        directVideo = null;
      }
    }

    const finalThumb = (thumbnail && thumbnail.startsWith('http')) ? thumbnail : '/images/default-thumb.svg';

    return {
      title,
      thumbnail: finalThumb,
      description,
      directVideo,
    };
  } catch (error) {
    return {
      title: 'Video Player',
      thumbnail: '/images/default-thumb.svg',
      description: 'Tonton video bersih tanpa iklan dan pengalihan.',
      directVideo: null,
    };
  }
}

/**
 * Puppeteer Headless Sniffer Cerdas & Fleksibel
 * Mendukung auto-click play button, iframe inspection, XHR/Fetch listener, dan deobfuscation
 */
async function sniffVideoStream(targetUrl) {
  let browser = null;
  let detectedStreamUrl = null;
  let streamType = 'mp4';
  let capturedTitle = '';
  let capturedThumb = '';

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--mute-audio',
        '--window-size=1280,720',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 720 });

    // Lewati dialog alert/confirm yang sering dimunculkan pop-under
    page.on('dialog', async (dialog) => {
      await dialog.dismiss().catch(() => {});
    });

    // Aktifkan request interception
    await page.setRequestInterception(true);

    page.on('request', (req) => {
      const reqUrl = req.url();
      const lowerUrl = reqUrl.toLowerCase();

      // Deteksi URL video stream m3u8 atau mp4
      const isVideoPattern =
        (lowerUrl.includes('.m3u8') || lowerUrl.includes('.mp4') || lowerUrl.includes('/hls/') || lowerUrl.includes('playlist')) &&
        !lowerUrl.includes('google-analytics') &&
        !lowerUrl.includes('doubleclick') &&
        !lowerUrl.includes('/ads/') &&
        !lowerUrl.includes('adservice') &&
        !lowerUrl.includes('popunder');

      if (isVideoPattern) {
        if (!detectedStreamUrl) {
          detectedStreamUrl = reqUrl;
          streamType = lowerUrl.includes('.m3u8') || lowerUrl.includes('hls') ? 'm3u8' : 'mp4';
          console.log(`[Puppeteer Sniffer] Terdeteksi stream via Request: ${reqUrl} (${streamType})`);
        }
      }

      req.continue().catch(() => {});
    });

    // Dengarkan Content-Type dan JSON response dari Fetch/XHR
    page.on('response', async (res) => {
      if (detectedStreamUrl) return;

      const resUrl = res.url();
      const headers = res.headers();
      const contentType = (headers['content-type'] || '').toLowerCase();

      if (
        contentType.includes('application/vnd.apple.mpegurl') ||
        contentType.includes('application/x-mpegurl') ||
        resUrl.includes('.m3u8')
      ) {
        detectedStreamUrl = resUrl;
        streamType = 'm3u8';
        console.log(`[Puppeteer Sniffer] Terdeteksi HLS M3U8 via Header: ${resUrl}`);
      } else if (contentType.includes('video/mp4') || (resUrl.includes('.mp4') && !resUrl.includes('preview'))) {
        detectedStreamUrl = resUrl;
        streamType = 'mp4';
        console.log(`[Puppeteer Sniffer] Terdeteksi MP4 via Header: ${resUrl}`);
      } else if (contentType.includes('application/json')) {
        // Beberapa video hoster mengirim file stream via response JSON
        try {
          const json = await res.json();
          const jsonStr = JSON.stringify(json);
          const m3u8Match = jsonStr.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);
          const mp4Match = jsonStr.match(/https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*/i);

          if (m3u8Match) {
            detectedStreamUrl = m3u8Match[0].replace(/\\/g, '');
            streamType = 'm3u8';
            console.log(`[Puppeteer Sniffer] Terdeteksi stream via JSON API: ${detectedStreamUrl}`);
          } else if (mp4Match) {
            detectedStreamUrl = mp4Match[0].replace(/\\/g, '');
            streamType = 'mp4';
            console.log(`[Puppeteer Sniffer] Terdeteksi stream via JSON API: ${detectedStreamUrl}`);
          }
        } catch (e) {}
      }
    });

    // Buka Halaman Target
    try {
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 18000,
      });
    } catch (e) {
      console.log(`[Puppeteer Load] Partial load selesai, mulai auto-trigger video...`);
    }

    // Scroll sedikit ke bawah untuk memicu lazy-loaded iframe / video player
    try {
      await page.evaluate(() => window.scrollBy(0, 400));
    } catch (e) {}

    // Beri waktu 1.5 detik agar script pemutar video diinisialisasi
    await new Promise((r) => setTimeout(r, 1500));

    // SIMULASI AUTO-CLICK PADA TOMBOL PLAY (PENTING untuk situs seperti idola.cc, dood, vidhide, streamtape)
    if (!detectedStreamUrl) {
      try {
        await page.evaluate(() => {
          const playSelectors = [
            '.vjs-big-play-button',
            'button.play',
            '.play-btn',
            '#play-btn',
            '.jw-display-icon-container',
            '.plyr__control--overlaid',
            'div[class*="play"]',
            'button[class*="play"]',
            'div[id*="player"]',
            'iframe',
            'video',
          ];

          for (const selector of playSelectors) {
            const el = document.querySelector(selector);
            if (el) {
              el.click();
              break;
            }
          }
        });
      } catch (e) {}

      // Tunggu respons network setelah tombol play diklik
      await new Promise((r) => setTimeout(r, 2000));
    }

    // INSPEKSI DOM & UNPACK JS DARI HALAMAN DAN SEMUA IFRAME
    if (!detectedStreamUrl) {
      const frames = page.frames();

      for (const frame of frames) {
        if (detectedStreamUrl) break;

        try {
          const frameResult = await frame.evaluate(() => {
            // 1. Cek tag <video>
            const video = document.querySelector('video');
            if (video) {
              if (video.currentSrc && video.currentSrc.startsWith('http')) return video.currentSrc;
              if (video.src && video.src.startsWith('http')) return video.src;
            }

            // 2. Cek tag <source>
            const source = document.querySelector('video source');
            if (source && source.src && source.src.startsWith('http')) return source.src;

            // 3. Scan script HTML & Packed JS
            const scripts = Array.from(document.querySelectorAll('script')).map((s) => s.innerText);
            return { scripts, title: document.title };
          });

          if (typeof frameResult === 'string' && frameResult.startsWith('http')) {
            detectedStreamUrl = frameResult;
            streamType = detectedStreamUrl.includes('.m3u8') ? 'm3u8' : 'mp4';
            break;
          }

          if (frameResult && frameResult.scripts) {
            for (let scriptContent of frameResult.scripts) {
              if (!scriptContent) continue;

              // Unpack jika diobfuscate
              if (scriptContent.includes('eval(function(p,a,c,k,e,')) {
                scriptContent = unpackJs(scriptContent);
              }

              const m3u8Match = scriptContent.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);
              if (m3u8Match) {
                detectedStreamUrl = m3u8Match[0].replace(/\\/g, '');
                streamType = 'm3u8';
                break;
              }

              const mp4Match = scriptContent.match(/https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*/i);
              if (mp4Match) {
                detectedStreamUrl = mp4Match[0].replace(/\\/g, '');
                streamType = 'mp4';
                break;
              }
            }
          }
        } catch (e) {}
      }
    }
  } catch (error) {
    console.error(`[Puppeteer Extractor Error]: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  return {
    videoUrl: detectedStreamUrl,
    streamType,
  };
}

/**
 * Fast HTTP/Cheerio Extractor (Super Cepat 0.3 Detik, Tanpa Beban RAM/Chrome)
 * Menyadap langsung halaman utama dan iframe player (Turbovid, sptvp, dood, vidhide, streamtape, dll)
 */
async function fastExtract(targetUrl) {
  try {
    const res = await axios.get(targetUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 8000,
    });
    const $ = cheerio.load(res.data);

    // Cek direct video tag di HTML
    let directVideo = $('video source').attr('src') || $('video').attr('src');
    if (directVideo && (directVideo.includes('.m3u8') || directVideo.includes('.mp4'))) {
      return {
        videoUrl: new URL(directVideo, targetUrl).href,
        streamType: directVideo.includes('.m3u8') ? 'm3u8' : 'mp4',
        thumbnail: $('video').attr('poster') || null,
      };
    }

    // Cek iframe embed
    const iframes = $('iframe').map((i, el) => $(el).attr('src')).get();
    for (let iframeSrc of iframes) {
      if (!iframeSrc) continue;
      if (!iframeSrc.startsWith('http')) {
        try {
          iframeSrc = new URL(iframeSrc, targetUrl).href;
        } catch (e) {
          continue;
        }
      }

      // Ambil konten iframe
      try {
        const ifrRes = await axios.get(iframeSrc, {
          headers: {
            'User-Agent': USER_AGENT,
            'Referer': targetUrl,
          },
          timeout: 8000,
        });

        let ifrContent = ifrRes.data;
        if (typeof ifrContent === 'string') {
          if (ifrContent.includes('eval(function(p,a,c,k,e,')) {
            ifrContent = unpackJs(ifrContent);
          }

          const m3u8Match = ifrContent.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);
          const mp4Match = ifrContent.match(/https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*/i);
          const posterMatch = ifrContent.match(/poster\s*[:=]\s*["']([^"']+)["']/i) || ifrContent.match(/https?:\/\/[^"'\s\\]+\/poster\/[^"'\s\\]*/i);

          if (m3u8Match) {
            return {
              videoUrl: m3u8Match[0].replace(/\\/g, ''),
              streamType: 'm3u8',
              thumbnail: posterMatch ? (posterMatch[1] || posterMatch[0]) : null,
            };
          } else if (mp4Match) {
            return {
              videoUrl: mp4Match[0].replace(/\\/g, ''),
              streamType: 'mp4',
              thumbnail: posterMatch ? (posterMatch[1] || posterMatch[0]) : null,
            };
          }
        }
      } catch (ifrErr) {}
    }
  } catch (err) {
    console.warn(`[Fast Extractor Notice]: ${err.message}`);
  }
  return null;
}

/**
 * Ekstraksi Video Utama
 */
async function extractVideo(targetUrl) {
  // 1. Ambil metadata Open Graph
  const meta = await extractMetadata(targetUrl);

  // 2. Coba Fast HTTP/Cheerio Scraper Terlebih Dahulu (Ringan & Cepat 0.3s, Tanpa Browser)
  let videoUrl = null;
  let streamType = 'mp4';

  const fastResult = await fastExtract(targetUrl);
  if (fastResult && fastResult.videoUrl) {
    console.log(`[Fast Extractor] Stream ditemukan seketika: ${fastResult.videoUrl}`);
    videoUrl = fastResult.videoUrl;
    streamType = fastResult.streamType;
    if (fastResult.thumbnail && (!meta.thumbnail || meta.thumbnail === '/images/default-thumb.svg' || !meta.thumbnail.startsWith('http'))) {
      meta.thumbnail = fastResult.thumbnail;
    }
  }

  // 3. Jalankan Sniffer Puppeteer pintar jika Fast Scraper belum menemukan
  if (!videoUrl && puppeteer) {
    const puppeteerResult = await sniffVideoStream(targetUrl);
    if (puppeteerResult && puppeteerResult.videoUrl) {
      videoUrl = puppeteerResult.videoUrl;
      streamType = puppeteerResult.streamType;
    }
  }

  // 4. Fallback jika ada direct video di meta tag
  if (!videoUrl && meta.directVideo) {
    videoUrl = meta.directVideo;
    streamType = videoUrl.includes('.m3u8') ? 'm3u8' : 'mp4';
  }

  // 5. Jika input URL langsung berupa .m3u8 atau .mp4
  if (!videoUrl) {
    const isDirect = targetUrl.includes('.m3u8') || targetUrl.includes('.mp4');
    if (isDirect) {
      videoUrl = targetUrl;
      streamType = targetUrl.includes('.m3u8') ? 'm3u8' : 'mp4';
    } else {
      throw new Error(
        'Tidak dapat menemukan video stream (.m3u8 atau .mp4) pada halaman ini. Pastikan link adalah halaman video/embed yang aktif.'
      );
    }
  }

  let originDomain = '';
  try {
    originDomain = new URL(targetUrl).origin;
  } catch (e) {}

  return {
    title: meta.title,
    thumbnail: meta.thumbnail,
    description: meta.description,
    videoUrl,
    streamType,
    originalUrl: targetUrl,
    originDomain,
  };
}

module.exports = {
  extractVideo,
  extractMetadata,
  sniffVideoStream,
};
