// ═══════════════════════════════════════════════════════════
// 🎯 YT Music API - All-in-One
//    - ?q=...                     → البحث
//    - ?action=stream&url=...     → الصوت (Progressive + HLS)
//    - ?action=image&url=...      → الصور
// ═══════════════════════════════════════════════════════════

let cachedClientId = null;
let lastFetchTime = 0;
const CACHE_DURATION = 2 * 60 * 60 * 1000;

async function getFreshClientId(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedClientId && (now - lastFetchTime < CACHE_DURATION)) {
    return cachedClientId;
  }

  try {
    const htmlRes = await fetch('https://soundcloud.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await htmlRes.text();
    const scriptUrls = [...html.matchAll(/src="(https:\/\/[^"]+\.js)"/g)].map(m => m[1]);

    for (const scriptUrl of scriptUrls.slice(-6)) {
      const scriptRes = await fetch(scriptUrl);
      const scriptText = await scriptRes.text();
      const match = scriptText.match(/client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/);
      if (match) {
        cachedClientId = match[1];
        lastFetchTime = now;
        return cachedClientId;
      }
    }
  } catch (e) {
    console.error('فشل جلب Client ID:', e);
  }

  return cachedClientId || 'iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX';
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const OPUS_PRIORITY = ['opus_0_2', 'opus_0_1', 'opus_0_0'];

function getHighQualityArtwork(artworkUrl) {
  if (!artworkUrl) return null;
  const baseUrl = artworkUrl.replace(/-(t\d+x\d+|large|small|tiny|mini|crop|badge|original)(\.\w+)?$/i, '');
  const extMatch = artworkUrl.match(/\.(jpg|jpeg|png|webp)$/i);
  const ext = extMatch ? extMatch[1] : 'jpg';
  return `${baseUrl}-t500x500.${ext}`;
}

// ═══════════════════════════════════════════════════════════
// 🔍 البحث
// ═══════════════════════════════════════════════════════════
async function handleSearch(req, res) {
  const query = req.query.q;
  const offset = req.query.offset || 0;
  const limit = req.query.limit || 30;

  if (!query) {
    return res.status(400).json({ error: 'الرجاء إدخال كلمة البحث q' });
  }

  let clientId = await getFreshClientId();
  let searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=${limit}&offset=${offset}`;

  let searchResponse = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    }
  });

  if (searchResponse.status === 401 || searchResponse.status === 403) {
    clientId = await getFreshClientId(true);
    searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=${limit}&offset=${offset}`;
    searchResponse = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });
  }

  if (!searchResponse.ok) {
    return res.status(searchResponse.status).json({
      error: `SoundCloud API Error: ${searchResponse.statusText}`
    });
  }

  const searchData = await searchResponse.json();

  if (!searchData.collection || searchData.collection.length === 0) {
    return res.status(404).json({ error: 'لم يتم العثور على نتائج' });
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;

  let tracks = searchData.collection.map(track => {
    const transcodings = track.media?.transcodings || [];

    // 1. Opus بأولوية
    let transcoding = null;
    for (const preset of OPUS_PRIORITY) {
      transcoding = transcodings.find(t => t.preset && t.preset.includes(preset));
      if (transcoding) break;
    }

    // 2. أي Opus
    if (!transcoding) {
      transcoding = transcodings.find(t =>
        (t.preset && t.preset.includes('opus')) ||
        (t.format && t.format.mime_type && t.format.mime_type.includes('opus'))
      );
    }

    // 3. Progressive MP3
    if (!transcoding) {
      transcoding = transcodings.find(t => t.format?.protocol === 'progressive');
    }

    // 4. HLS
    if (!transcoding) {
      transcoding = transcodings.find(t => t.format?.protocol === 'hls');
    }

    // 5. أي شيء
    if (!transcoding && transcodings.length > 0) {
      transcoding = transcodings[0];
    }

    // 🔑 رابط الصوت (proxy)
    let streamEndpoint = null;
    if (transcoding) {
      streamEndpoint = `${proto}://${host}/api/search?action=stream&url=${encodeURIComponent(transcoding.url)}`;
    }

    // 🔑 رابط الصورة (proxy)
    const rawArtwork = getHighQualityArtwork(track.artwork_url);
    const artwork = rawArtwork
      ? `${proto}://${host}/api/search?action=image&url=${encodeURIComponent(rawArtwork)}`
      : null;

    return {
      id: track.id,
      title: track.title,
      artist: track.user?.username || 'مجهول',
      duration: track.duration,
      artwork: artwork,
      stream_endpoint: streamEndpoint
    };
  }).filter(t => t.stream_endpoint !== null);

  tracks = shuffleArray(tracks);

  return res.status(200).json({
    success: true,
    offset: Number(offset),
    count: tracks.length,
    tracks: tracks
  });
}

// ═══════════════════════════════════════════════════════════
// 🎵 Streaming (Proxy الصوت - Progressive + HLS)
// ═══════════════════════════════════════════════════════════
async function extractDirectUrl(apiUrl, clientId) {
  let urlWithClient = apiUrl;
  if (!urlWithClient.includes('client_id=')) {
    const sep = urlWithClient.includes('?') ? '&' : '?';
    urlWithClient = `${urlWithClient}${sep}client_id=${clientId}`;
  }

  const response = await fetch(urlWithClient, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    }
  });

  if (!response.ok) return { url: null, isHls: false };

  const data = await response.json();

  // الحالة 1: data.url مباشر
  if (data && data.url) {
    // ⚠️ مهم: نتحقق إذا كان الرابط m3u8
    const isHls = data.url.includes('.m3u8') || data.url.includes('/hls/') || data.url.includes('playlist');
    return { url: data.url, isHls: isHls };
  }

  // الحالة 2: data.media.transcodings
  if (data && data.media && data.media.transcodings) {
    let selected = data.media.transcodings.find(t => t.format?.protocol === 'progressive');
    if (!selected) {
      selected = data.media.transcodings.find(t => t.format?.protocol === 'hls');
    }
    if (!selected) return { url: null, isHls: false };

    let streamApiUrl = selected.url;
    if (!streamApiUrl.includes('client_id=')) {
      const sep = streamApiUrl.includes('?') ? '&' : '?';
      streamApiUrl = `${streamApiUrl}${sep}client_id=${clientId}`;
    }

    const streamRes = await fetch(streamApiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    if (!streamRes.ok) return { url: null, isHls: false };

    const streamData = await streamRes.json();
    const isHls = selected.format.protocol === 'hls';
    return {
      url: streamData.url || null,
      isHls: isHls
    };
  }

  return { url: null, isHls: false };
}

async function handleStream(req, res) {
  const streamUrl = req.query.url;
  if (!streamUrl) {
    return res.status(400).json({ error: 'missing url' });
  }

  // ═══════════════════════════════════════════════════════════
  // 🎯 proxy_ts Mode: تمرير أقسام .ts + init.mp4 مباشرة
  // ═══════════════════════════════════════════════════════════
  if (req.query.proxy_ts === 'true') {
    const range = req.headers.range || 'bytes=0-';

    try {
      const tsResponse = await fetch(streamUrl, {
        method: 'GET',
        headers: {
          'Range': range,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Accept-Encoding': 'identity'
        }
      });

      if (!tsResponse.ok && tsResponse.status !== 206) {
        return res.status(tsResponse.status).end();
      }

      res.status(tsResponse.status);

      ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
        const v = tsResponse.headers.get(h);
        if (v) res.setHeader(h, v);
      });

      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');

      const reader = tsResponse.body.getReader();
      let closed = false;
      res.on('close', () => {
        closed = true;
        reader.cancel().catch(() => {});
      });

      try {
        while (!closed) {
          const { done, value } = await reader.read();
          if (done || res.writableEnded) break;
          res.write(value);
        }
      } catch (e) {}

      return res.end();
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  let clientId = await getFreshClientId();
  let result = await extractDirectUrl(streamUrl, clientId);

  if (!result.url) {
    const freshId = await getFreshClientId(true);
    result = await extractDirectUrl(streamUrl, freshId);
  }

  if (!result.url) {
    return res.status(404).json({ error: 'لا يتوفر مصدر صوت' });
  }

  const directUrl = result.url;
  const isHls = result.isHls;

  // ═══════════════════════════════════════════════════════════
  // 🎯 HLS Mode: أعد كتابة m3u8 ليمر كل قسم عبر proxy
  // ═══════════════════════════════════════════════════════════
  if (isHls) {
    try {
      const m3u8Res = await fetch(directUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*'
        }
      });

      if (!m3u8Res.ok) {
        return res.status(m3u8Res.status).json({ error: 'فشل جلب m3u8' });
      }

      const m3u8Content = await m3u8Res.text();

      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers.host;
      const baseProxyUrl = `${proto}://${host}/api/search?action=stream&proxy_ts=true&url=`;

      // استخراج base للروابط النسبية
      const baseDir = directUrl.substring(0, directUrl.lastIndexOf('/'));

      // ═══ إعادة كتابة m3u8 ═══
      let rewritten = m3u8Content.split('\n').map(line => {
        const trimmed = line.trim();

        // #EXT-X-MAP:URI="..."
        if (trimmed.startsWith('#EXT-X-MAP:URI="')) {
          const match = trimmed.match(/#EXT-X-MAP:URI="([^"]+)"/);
          if (match) {
            const absoluteUrl = match[1];
            const proxyUrl = `${baseProxyUrl}${encodeURIComponent(absoluteUrl)}`;
            return `#EXT-X-MAP:URI="${proxyUrl}"`;
          }
        }

        // #EXT-X-KEY:URI="..." (اختياري)
        if (trimmed.startsWith('#EXT-X-KEY:') && trimmed.includes('URI="')) {
          const match = trimmed.match(/URI="([^"]+)"/);
          if (match) {
            const absoluteUrl = match[1];
            const proxyUrl = `${baseProxyUrl}${encodeURIComponent(absoluteUrl)}`;
            return trimmed.replace(match[1], proxyUrl);
          }
        }

        // سطر فارغ أو تعليق آخر
        if (!trimmed || trimmed.startsWith('#')) {
          return line;
        }

        // رابط قسم (.ts, .m4s, init.mp4)
        let absoluteUrl = trimmed;
        if (!absoluteUrl.startsWith('http')) {
          absoluteUrl = `${baseDir}/${absoluteUrl}`;
        }

        return `${baseProxyUrl}${encodeURIComponent(absoluteUrl)}`;
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Access-Control-Allow-Origin', '*');

      return res.status(200).send(rewritten);

    } catch (e) {
      return res.status(500).json({ error: 'HLS proxy error: ' + e.message });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 🎵 Progressive Mode
  // ═══════════════════════════════════════════════════════════

  // info mode
  if (req.query.info === 'true') {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const proxyUrl = `${proto}://${host}/api/search?action=stream&url=${encodeURIComponent(streamUrl)}`;

    res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=300');
    return res.status(200).json({
      success: true,
      direct_url: proxyUrl,
      protocol: 'progressive',
      mime_type: 'audio/mpeg'
    });
  }

  // proxy mode
  const range = req.headers.range || 'bytes=0-';

  const audioResponse = await fetch(directUrl, {
    method: 'GET',
    headers: {
      'Range': range,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity'
    }
  });

  if (!audioResponse.ok && audioResponse.status !== 206) {
    return res.status(audioResponse.status).json({ error: 'فشل جلب الصوت' });
  }

  res.status(audioResponse.status);

  ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach(h => {
    const v = audioResponse.headers.get(h);
    if (v) res.setHeader(h, v);
  });

  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const reader = audioResponse.body.getReader();
  let closed = false;
  res.on('close', () => {
    closed = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done || res.writableEnded) break;
      res.write(value);
    }
  } catch (e) {}

  return res.end();
}

// ═══════════════════════════════════════════════════════════
// 🖼️ Proxy الصور
// ═══════════════════════════════════════════════════════════
async function handleImage(req, res) {
  const imageUrl = req.query.url;
  if (!imageUrl) {
    return res.status(400).json({ error: 'missing url' });
  }

  const response = await fetch(imageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (!response.ok) {
    return res.status(response.status).end();
  }

  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  res.setHeader('Content-Type', contentType);

  const arrayBuffer = await response.arrayBuffer();
  return res.status(200).send(Buffer.from(arrayBuffer));
}

// ═══════════════════════════════════════════════════════════
// 🚀 MAIN HANDLER
// ═══════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const action = req.query.action;

  try {
    // 🖼️ Proxy الصور
    if (action === 'image') {
      return await handleImage(req, res);
    }

    // 🎵 Proxy الصوت
    if (action === 'stream') {
      return await handleStream(req, res);
    }

    // 🔍 البحث (افتراضي)
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return await handleSearch(req, res);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
        }
