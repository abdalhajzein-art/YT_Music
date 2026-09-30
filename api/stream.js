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

// 🎯 الحل: استخراج URL من JSON بطريقة ذكية
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

  if (!response.ok) {
    return { url: null, isHls: false };
  }

  const data = await response.json();

  // الحالة 1: data.url مباشر (رابط transcoding)
  if (data && data.url) {
    return { url: data.url, isHls: false };
  }

  // الحالة 2: data.media.transcodings (رابط track)
  if (data && data.media && data.media.transcodings) {
    let selectedTranscoding = data.media.transcodings.find(t =>
      t.format && t.format.protocol === 'progressive'
    );

    if (!selectedTranscoding) {
      selectedTranscoding = data.media.transcodings.find(t =>
        t.format && t.format.protocol === 'hls'
      );
    }

    if (!selectedTranscoding) return { url: null, isHls: false };

    let streamApiUrl = selectedTranscoding.url;
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
    return {
      url: streamData.url || null,
      isHls: selectedTranscoding.format.protocol === 'hls'
    };
  }

  return { url: null, isHls: false };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let streamUrl = req.query.url;
  if (!streamUrl) {
    return res.status(400).json({ error: 'الرجاء إرسال رابط الـ stream' });
  }

  try {
    let clientId = await getFreshClientId();

    // استخراج الرابط المباشر
    let result = await extractDirectUrl(streamUrl, clientId);

    // إذا فشل، جرب client_id جديد
    if (!result.url) {
      const freshId = await getFreshClientId(true);
      result = await extractDirectUrl(streamUrl, freshId);
    }

    if (!result.url) {
      return res.status(404).json({ error: 'عذراً، لا يتوفر مصدر صوت لهذه الأغنية' });
    }

    const directUrl = result.url;
    const isHls = result.isHls;

    // mode info=true
    if (req.query.info === 'true') {
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers.host;
      const proxyUrl = `${proto}://${host}/api/stream?url=${encodeURIComponent(streamUrl)}&proxy=true`;

      res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=300');

      return res.status(200).json({
        success: true,
        direct_url: proxyUrl,
        protocol: isHls ? 'hls' : 'progressive',
        mime_type: isHls ? 'application/vnd.apple.mpegurl' : 'audio/mpeg'
      });
    }

    // mode proxy=true
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
      return res.status(audioResponse.status).json({ error: 'فشل جلب الصوت من المصدر' });
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
    } catch (e) {
      // قطع الاتصال
    }

    return res.end();

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
      }
