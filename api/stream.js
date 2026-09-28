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

// 🆕 دالة للحصول على رابط Progressive (MP3) بدلاً من HLS
async function getProgressiveStreamUrl(transcodings, clientId) {
  if (!transcodings || !Array.isArray(transcodings) || transcodings.length === 0) {
    return null;
  }

  // 🎯 الأولوية 1: ابحث عن transcoding من نوع "progressive"
  let progressiveTranscoding = transcodings.find(t => 
    t.format && t.format.protocol === 'progressive'
  );

  // 🎯 الأولوية 2: إذا لم يوجد، جرب "hls"
  if (!progressiveTranscoding) {
    progressiveTranscoding = transcodings.find(t => 
      t.format && t.format.protocol === 'hls'
    );
  }

  if (!progressiveTranscoding) {
    return null;
  }

  // احصل على رابط الـ stream الفعلي
  let streamApiUrl = progressiveTranscoding.url;
  if (!streamApiUrl.includes('client_id=')) {
    const sep = streamApiUrl.includes('?') ? '&' : '?';
    streamApiUrl = `${streamApiUrl}${sep}client_id=${clientId}`;
  }

  try {
    const streamRes = await fetch(streamApiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    if (!streamRes.ok) {
      console.error('فشل جلب stream URL:', streamRes.status);
      return null;
    }

    const streamData = await streamRes.json();
    return streamData.url || null;
  } catch (e) {
    console.error('خطأ في getProgressiveStreamUrl:', e);
    return null;
  }
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

    if (!data) {
      return res.status(404).json({ error: 'لم يتم العثور على بيانات الأغنية' });
    }

    // =====================================================
    // 🆕 احصل على رابط Progressive إن أمكن
    // =====================================================
    let directUrl = data.url; // افتراضي
    let protocol = 'hls';

    if (data.media && data.media.transcodings) {
      const progressiveUrl = await getProgressiveStreamUrl(data.media.transcodings, clientId);
      if (progressiveUrl) {
        directUrl = progressiveUrl;
        protocol = 'progressive';
      }
    }

    if (!directUrl) {
      return res.status(404).json({ error: 'لم يتم العثور على الرابط المباشر' });
    }

    // =====================================================
    // ✅ الوضع 1: معلومات فقط (JSON) — نُعيد الرابط المباشر
    // =====================================================
    if (req.query.info === 'true') {
      res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=300');
      
      // ✅ أعِد الرابط المباشر من SoundCloud (وليس proxy)
      return res.status(200).json({ 
        success: true, 
        direct_url: directUrl,  // ← ✅ الرابط المباشر الفعلي!
        protocol: protocol       // progressive أو hls (للتشخيص)
      });
    }

    // =====================================================
    // 🆕 الوضع 2: Proxy للصوت (يبقى للتوافق)
    // =====================================================
    const range = req.headers.range || 'bytes=0-';
    
    const audioResponse = await fetch(directUrl, {
      headers: {
        'Range': range,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!audioResponse.ok && audioResponse.status !== 206) {
      return res.status(audioResponse.status).json({ error: 'فشل جلب الصوت' });
    }
    
    res.status(audioResponse.status);
    
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
      const v = audioResponse.headers.get(h);
      if (v) res.setHeader(h, v);
    });
    
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
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
      // connection closed by client
    }
    
    return res.end();

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
                                 }
