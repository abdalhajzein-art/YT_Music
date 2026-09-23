// وظيفة ذكية لاستخراج أحدث Client ID من موقع ساوند كلاود تلقائياً
async function getFreshClientId() {
  try {
    const htmlRes = await fetch('https://soundcloud.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await htmlRes.text();
    const scriptUrls = [...html.matchAll(/src="(https:\/\/[^"]+\.js)"/g)].map(m => m[1]);
    
    // البحث في ملفات الجافاسكريفت الأخيرة عن الـ client_id
    for (const scriptUrl of scriptUrls.slice(-6)) {
      const scriptRes = await fetch(scriptUrl);
      const scriptText = await scriptRes.text();
      const match = scriptText.match(/client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/);
      if (match) return match[1];
    }
  } catch (e) {
    // في حال حدث أي عارض، نعود لمعرف احتياطي
  }
  return 'iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'الرجاء إدخال كلمة البحث q' });
  }

  try {
    // جلب معرف طازج حصرياً لهذه الطلبية
    const clientId = await getFreshClientId();
    const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=15`;
    
    const searchResponse = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      }
    });

    if (!searchResponse.ok) {
      return res.status(searchResponse.status).json({ error: `SoundCloud API Error: ${searchResponse.statusText}` });
    }

    const searchData = await searchResponse.json();

    if (!searchData.collection) {
      return res.status(404).json({ error: 'لم يتم العثور على نتائج' });
    }

    const tracks = searchData.collection.map(track => {
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

    return res.status(200).json({ success: true, tracks });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
