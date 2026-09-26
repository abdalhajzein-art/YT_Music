// 🧠 ذاكرة مؤقتة لـ Client ID
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
    console.error('فشل جلب Client ID جديد:', e);
  }

  return cachedClientId || 'iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let streamUrl = req.query.url;
  if (!streamUrl) {
    return res.status(400).json({ error: 'الرجاء إرسال رابط الـ stream' });
  }

  try {
    // 1. جلب client_id طازج
    let clientId = await getFreshClientId();
    
    // 2. طلب direct_url من SoundCloud
    let soundcloudUrl = streamUrl;
    if (!soundcloudUrl.includes('client_id=')) {
      const sep = soundcloudUrl.includes('?') ? '&' : '?';
      soundcloudUrl = `${soundcloudUrl}${sep}client_id=${clientId}`;
    }
    
    let response = await fetch(soundcloudUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      }
    });

    // تجديد client_id
    if (response.status === 401 || response.status === 403) {
      const freshClientId = await getFreshClientId(true);
      const sep = streamUrl.includes('?') ? '&' : '?';
      soundcloudUrl = `${streamUrl}${sep}client_id=${freshClientId}`;
      
      response = await fetch(soundcloudUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/javascript, */*; q=0.01'
        }
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: `SoundCloud Error: ${response.statusText}` });
    }

    const data = await response.json();

    if (!data || !data.url) {
      return res.status(404).json({ error: 'لم يتم العثور على الرابط المباشر' });
    }

    // 🆕 الوضع 1: معلومات فقط (JSON)
    if (req.query.info === 'true') {
      // نرجّع رابط Proxy بدل SoundCloud CDN
      const proxyUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/stream?url=${encodeURIComponent(streamUrl)}&proxy=true`;
      
      res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=300');
      
      return res.status(200).json({ 
        success: true, 
        direct_url: proxyUrl
      });
    }

    // 🆕 الوضع 2: Proxy للصوت (default)
    const range = req.headers.range || 'bytes=0-';
    
    const audioResponse = await fetch(data.url, {
      headers: {
        'Range': range,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!audioResponse.ok && audioResponse.status !== 206) {
      return res.status(audioResponse.status).json({ error: 'فشل جلب الصوت' });
    }
    
    res.status(audioResponse.status);
    
    // نسخ الـ headers المهمة
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
      const v = audioResponse.headers.get(h);
      if (v) res.setHeader(h, v);
    });
    
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
    // بث الصوت
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
      // connection closed
    }
    
    return res.end();

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
        }
