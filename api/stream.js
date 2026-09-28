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

// 🆕 اختيار طريقة البث (تفضيل Progressive أولاً، وإذا لم يتوفر نأخذ HLS لتحويله)
async function getBestStreamUrl(transcodings, clientId) {
  if (!transcodings || !Array.isArray(transcodings) || transcodings.length === 0) {
    return null;
  }

  let selectedTranscoding = transcodings.find(t => 
    t.format && t.format.protocol === 'progressive'
  );

  if (!selectedTranscoding) {
    selectedTranscoding = transcodings.find(t => 
      t.format && t.format.protocol === 'hls'
    );
  }

  if (!selectedTranscoding) return null;

  let streamApiUrl = selectedTranscoding.url;
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

    if (!streamRes.ok) return null;

    const streamData = await streamRes.json();
    return {
      url: streamData.url || null,
      isHls: selectedTranscoding.format.protocol === 'hls'
    };
  } catch (e) {
    console.error('خطأ في جلب رابط الصوت:', e);
    return null;
  }
}

// 🔗 دالة تحويل بث الـ HLS إلى ملف MP3 متصل فورياً مشغل الأندرويد يفهمه
async function streamHlsAsMp3(playlistUrl, res) {
  try {
    const manifestRes = await fetch(playlistUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    
    if (!manifestRes.ok) {
      return res.status(500).json({ error: 'فشل قراءة قائمة HLS' });
    }

    const manifestText = await manifestRes.text();
    
    // استخراج روابط المقاطع الصوتية (.ts / .mp3 / .aac) من ملف m3u8
    const lines = manifestText.split('\n');
    const segmentUrls = lines
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));

    if (segmentUrls.length === 0) {
      return res.status(404).json({ error: 'لم يتم العثور على مقاطع صوتية في القائمة' });
    }

    // إيهام المشغل بأنه بث MP3 مباشر عادي
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200);

    // جلب المقاطع بالترتيب وضخ بياناتها مباشرة للتطبيق
    for (const segmentUrl of segmentUrls) {
      if (res.writableEnded || res.destroyed) break;

      try {
        const segRes = await fetch(segmentUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        
        if (segRes.ok) {
          const arrayBuffer = await segRes.arrayBuffer();
          res.write(Buffer.from(arrayBuffer));
        }
      } catch (err) {
        console.error('خطأ في جلب المقطع:', err);
      }
    }

    return res.end();
  } catch (e) {
    console.error('خطأ أثناء تحويل HLS:', e);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'خطأ في معالجة الصوت' });
    }
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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

    let directUrl = null;
    let isHls = false;

    if (data.media && data.media.transcodings) {
      const streamInfo = await getBestStreamUrl(data.media.transcodings, clientId);
      if (streamInfo && streamInfo.url) {
        directUrl = streamInfo.url;
        isHls = streamInfo.isHls;
      }
    }

    if (!directUrl) {
      return res.status(404).json({ error: 'عذراً، لا يتوفر مصدر صوت لهذه الأغنية' });
    }

    // 🎯 معلومات الرابط للتطبيق (يُنظر إليها دائماً على أنها MP3)
    if (req.query.info === 'true') {
      res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=300');
      return res.status(200).json({ 
        success: true, 
        direct_url: req.headers.host ? `https://${req.headers.host}/api/stream?url=${encodeURIComponent(streamUrl)}` : directUrl,
        mime_type: 'audio/mpeg'
      });
    }

    // ⚡ إذا كان المصدر HLS، السيرفر يقوم بدمج أجزائه وإرسالها كـ MP3 حي للمشغل
    if (isHls) {
      return await streamHlsAsMp3(directUrl, res);
    }

    // 🔄 إذا كان المصدر MP3 مباشر من الأصل
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
      // قطع الاتصال
    }
    
    return res.end();

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
