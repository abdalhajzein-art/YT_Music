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

// 🆕 دالة ذكية للبحث عن أفضل صيغة صوت مباشرة مدعومة (MP3, AAC وغيرها) وتجنب HLS
async function getBestProgressiveStreamUrl(transcodings, clientId) {
  if (!transcodings || !Array.isArray(transcodings) || transcodings.length === 0) {
    return null;
  }

  // تصفية جميع الـ transcodings التي تعتمد على الـ progressive فقط (مستبعدين HLS تماماً)
  const progressiveOptions = transcodings.filter(t => 
    t.format && t.format.protocol === 'progressive'
  );

  if (progressiveOptions.length === 0) {
    return null;
  }

  // نرتب الأولوية للصيغ التي يفهمهاMediaPlayer بكفاءة عالية (MP3 أولاً، ثم AAC/M4A، ثم أي صيغة progressive أخرى)
  progressiveOptions.sort((a, b) => {
    const mimeA = (a.format.mime_type || '').toLowerCase();
    const mimeB = (b.format.mime_type || '').toLowerCase();
    
    if (mimeA.includes('mpeg') || mimeA.includes('mp3')) return -1;
    if (mimeB.includes('mpeg') || mimeB.includes('mp3')) return 1;
    if (mimeA.includes('aac') || mimeA.includes('mp4')) return -1;
    if (mimeB.includes('aac') || mimeB.includes('mp4')) return 1;
    return 0;
  });

  const bestTranscoding = progressiveOptions[0];
  let streamApiUrl = bestTranscoding.url;
  
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
      return null;
    }

    const streamData = await streamRes.json();
    return {
      url: streamData.url || null,
      mimeType: bestTranscoding.format.mime_type || 'audio/mpeg'
    };
  } catch (e) {
    console.error('خطأ في جلب الرابط المباشر:', e);
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
    // 🎯 جلب أفضل صيغة مباشرة (تفضيل MP3/AAC واستبعاد HLS)
    // =====================================================
    let directUrl = null;
    let mimeType = 'audio/mpeg';

    if (data.media && data.media.transcodings) {
      const streamInfo = await getBestProgressiveStreamUrl(data.media.transcodings, clientId);
      if (streamInfo && streamInfo.url) {
        directUrl = streamInfo.url;
        mimeType = streamInfo.mimeType;
      }
    }

    // إذا لم تتوفر صيغة مباشرة، نمنع إرسال HLS نهائياً لتفادي الانهيار
    if (!directUrl) {
      return res.status(404).json({ error: 'عذراً، هذه الأغنية لا توفر صيغة صوت مباشرة متوافقة' });
    }

    // =====================================================
    // ✅ وضع المعلمات (معلومات الرابط فقط)
    // =====================================================
    if (req.query.info === 'true') {
      res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=300');
      return res.status(200).json({ 
        success: true, 
        direct_url: directUrl,
        mime_type: mimeType
      });
    }

    // =====================================================
    // 🔄 وضع الـ Proxy للصوت
    // =====================================================
    const range = req.headers.range || 'bytes=0-';
    
    const audioResponse = await fetch(directUrl, {
      headers: {
        'Range': range,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!audioResponse.ok && audioResponse.status !== 206) {
      return res.status(audioResponse.status).json({ error: 'فشل جلب الصوت من المصدر' });
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
      // تم قطع الاتصال من قبل العميل
    }
    
    return res.end();

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
