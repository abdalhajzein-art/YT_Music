// 🧠 ذاكرة مؤقتة لـ Client ID لتجنب الفحص وإبطاء السيرفر مع كل طلب
let cachedClientId = null;
let lastFetchTime = 0;
const CACHE_DURATION = 2 * 60 * 60 * 1000; // ساعتان

// دالة جلب Client ID طازج (مع تخزين مؤقت)
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

// 🎲 دالة خلط النتائج عشوائياً
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// 🎯 أولويات Opus presets (128 kbps = الأفضل توازناً)
const OPUS_PRIORITY = [
  'opus_0_2',   // 128 kbps
  'opus_0_1',   // 96 kbps
  'opus_0_0',   // 64 kbps
];

// 🖼️ دالة تحويل رابط الصورة إلى أعلى جودة متوفرة
function getHighQualityArtwork(artworkUrl) {
  if (!artworkUrl) return null;
  
  // 1) إزالة أي حجم موجود في الرابط (-large, -t500x500, -small, -tiny, -original, إلخ)
  const baseUrl = artworkUrl.replace(/-(t\d+x\d+|large|small|tiny|mini|crop|badge|original)(\.\w+)?$/i, '');
  
  // 2) استخراج الامتداد (jpg, png, webp)
  const extMatch = artworkUrl.match(/\.(jpg|jpeg|png|webp)$/i);
  const ext = extMatch ? extMatch[1] : 'jpg';
  
  // 3) إضافة -t500x500 (500×500) — الأفضل توازناً بين الجودة والحجم
  return `${baseUrl}-t500x500.${ext}`;
}

export default async function handler(req, res) {
  // 🌐 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  // 🆕 Cache للبحث على Vercel Edge: 5 دقائق
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const query = req.query.q;
  const offset = req.query.offset || 0;
  const limit = req.query.limit || 30;

  if (!query) {
    return res.status(400).json({ error: 'الرجاء إدخال كلمة البحث q' });
  }

  try {
    let clientId = await getFreshClientId();
    let searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=${limit}&offset=${offset}`;
    
    let searchResponse = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      }
    });

    // 🔄 تجديد Client ID تلقائياً إذا كان منتهياً
    if (searchResponse.status === 401 || searchResponse.status === 403) {
      clientId = await getFreshClientId(true);
      searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=${limit}&offset=${offset}`;
      searchResponse = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/javascript, */*; q=0.01'
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
      return res.status(404).json({ error: 'لم يتم العثور على نتائج إضافية' });
    }

    let tracks = searchData.collection.map(track => {
      const transcodings = track.media?.transcodings || [];

      // 🎯 1. البحث عن Opus بالأولوية (128 kbps أولاً)
      let transcoding = null;
      for (const preset of OPUS_PRIORITY) {
        transcoding = transcodings.find(t => t.preset && t.preset.includes(preset));
        if (transcoding) break;
      }

      // 🎯 2. أي Opus متوفر
      if (!transcoding) {
        transcoding = transcodings.find(t => 
          (t.preset && t.preset.includes('opus')) || 
          (t.format && t.format.mime_type && t.format.mime_type.includes('opus'))
        );
      }

      // 🔄 3. احتياطي: Progressive MP3
      if (!transcoding) {
        transcoding = transcodings.find(t => t.format?.protocol === 'progressive');
      }

      // 🔄 4. احتياطي أخير
      if (!transcoding && transcodings.length > 0) {
        transcoding = transcodings[0];
      }

      // 🖼️ تحويل الصورة إلى -t500x500 (500×500) لجودة عالية
      const artwork = getHighQualityArtwork(track.artwork_url);

      return {
        id: track.id,
        title: track.title,
        artist: track.user?.username || 'مجهول',
        duration: track.duration,
        artwork: artwork,
        // 🆕 بدون client_id — stream.js سيضيفه طازجاً
        stream_endpoint: transcoding ? transcoding.url : null
      };
    }).filter(t => t.stream_endpoint !== null);

    // 🎲 خلط النتائج
    tracks = shuffleArray(tracks);

    return res.status(200).json({ 
      success: true, 
      offset: Number(offset),
      count: tracks.length,
      tracks: tracks 
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
     }
