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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'الرجاء إدخال كلمة البحث q' });
  }

  try {
    let clientId = await getFreshClientId();
    // 👈 زدنا الـ limit لـ 40 لجلب كمية أكبر من الأغاني
    let searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=40`;
    
    let searchResponse = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      }
    });

    // 🔄 إذا ظهر خطأ صلاحية (ID منتهي)، نجبر السيرفر على استخراج ID جديد فوراً ونعيد الطلب
    if (searchResponse.status === 401 || searchResponse.status === 403) {
      clientId = await getFreshClientId(true);
      searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=40`;
      searchResponse = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/javascript, */*; q=0.01'
        }
      });
    }

    if (!searchResponse.ok) {
      return res.status(searchResponse.status).json({ error: `SoundCloud API Error: ${searchResponse.statusText}` });
    }

    const searchData = await searchResponse.json();

    if (!searchData.collection || searchData.collection.length === 0) {
      return res.status(404).json({ error: 'لم يتم العثور على نتائج' });
    }

    let tracks = searchData.collection.map(track => {
      const transcoding = track.media?.transcodings?.find(t => t.format.protocol === 'progressive');
      
      return {
        id: track.id,
        title: track.title,
        artist: track.user?.username || 'مجهول',
        duration: track.duration,
        artwork: track.artwork_url ? track.artwork_url.replace('large', 't500x500') : null,
        stream_endpoint: transcoding ? `${transcoding.url}?client_id=${clientId}` : null
      };
    }).filter(t => t.stream_endpoint !== null);

    // 🎲 خلط الأغاني عشوائياً لمنع التكرار بفس الترتيب
    tracks = shuffleArray(tracks);

    // 👈 إرجاع أول 30 أغنية متنوعة
    return res.status(200).json({ success: true, tracks: tracks.slice(0, 30) });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
